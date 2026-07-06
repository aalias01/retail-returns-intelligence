"""
scripts/build_api_artifacts.py - Build API runtime artifacts.

Why this exists
---------------
The FastAPI service (api/predictor.py) loads a per-customer table at
startup containing behavioral features + the scored segment label + the
Isolation Forest anomaly flag/score + a default category_return_rate. That
table is the union of three notebook outputs:

    data/processed/customer_features.parquet     (5,881 x 18, behavioral + RFM)
    data/processed/customer_segments.parquet     (5,881 x 4, customer_id, cluster, pca_x, pca_y)
    data/processed/flagged_customers.parquet     (294 x 2, customer_id, anomaly_score)

This script merges them, maps cluster IDs to human-readable segment labels
by inspecting KMeans centroids (rule-based, so it's reproducible across
re-runs even if cluster IDs permute), and saves the result as
``models/customer_features.joblib``.

It also prepares ``models/invoice_substitutes.joblib`` for the API. The lookup
is intentionally precomputed so the Render runtime does not need recommender
training libraries. It uses the committed product embeddings for content
similarity and the local transaction workbook, when present, for invoice and
customer return history.

Finally, it builds ``models/demo_cases.joblib``: a small curated pool of real
purchase invoice lines for the live demo. The pool is deliberately varied by
risk tier, customer segment, and anomaly flag so the "score a sample invoice"
button shows the model's range without letting visitors invent impossible
invoice/price combinations.

Run this once after notebooks 01–06 finish. It is also safe to re-run.

Usage
-----
    python scripts/build_api_artifacts.py

Outputs
-------
    models/customer_features.joblib    (joblib-pickled pandas.DataFrame)
    models/invoice_substitutes.joblib  (joblib-pickled lookup dict)
    models/demo_cases.joblib           (joblib-pickled list[dict])

Notes on the cluster -> segment mapping
---------------------------------------
KMeans cluster IDs are arbitrary across runs. To make label assignment
deterministic, we use a rule on the inverse-scaled centroids:

    Returner        = cluster with the highest return_value_ratio
    Premium Loyal   = of the remaining, the one with the highest monetary_score
    At-Risk         = of the remaining, the one with the highest recency_score
    Healthy Browser = the cluster that's left

Caveat worth knowing: on the current UCI II training, the "Returner" cluster
holds only ~18 customers. They are very-high-volume (wholesale-like) accounts
where return value concentrates, not classic abusive returners. The Isolation
Forest (294 flagged) is the broader operational fraud signal; the segments
are policy buckets, not a fraud predictor on their own.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DATA = ROOT / "data" / "processed"
RAW = ROOT / "data" / "raw" / "online_retail_II.xlsx"
MODELS = ROOT / "models"

# Feature order the segmentation scaler / KMeans were trained on (see MLflow
# run "kmeans-segmentation" params/features). Must match exactly to invert
# the scaler.
SEG_TRAIN_FEATURES = [
    "total_orders", "total_revenue", "unique_categories_purchased",
    "total_return_orders", "total_return_value", "unique_categories_returned",
    "n_weekend_returns", "lifetime_return_rate", "return_value_ratio",
    "weekend_return_share", "tenure_days", "recency_score", "frequency_score",
    "monetary_score", "return_velocity",
]

# Default category return rate at inference for customers whose stock_code
# we cannot look up. Equals the dataset baseline.
DEFAULT_CATEGORY_RETURN_RATE = 0.05

SAMPLE_INVOICES = [
    {
        "customer_id": "16684.0",
        "invoice_no": "536365",
        "stock_code": "85123A",
        "quantity": 6,
        "unit_price": 2.55,
    },
    {
        "customer_id": "16333.0",
        "invoice_no": "536378",
        "stock_code": "22423",
        "quantity": 4,
        "unit_price": 12.95,
    },
    {
        "customer_id": "15749.0",
        "invoice_no": "536846",
        "stock_code": "84879",
        "quantity": 8,
        "unit_price": 1.69,
    },
    {
        "customer_id": "18102.0",
        "invoice_no": "537434",
        "stock_code": "22086",
        "quantity": 12,
        "unit_price": 2.95,
    },
]
MAX_FLAGGED_INVOICES = 2_000
TARGET_SUBSTITUTE_ARTIFACT_BYTES = 2 * 1024 * 1024
TARGET_DEMO_CASES = 96
DEMO_CASE_RANDOM_STATE = 2026
EXCLUDED_DEMO_STOCK_CODES = {
    "M",
    "D",
    "DOT",
    "POST",
    "BANK CHARGES",
    "AMAZONFEE",
    "CRUK",
    "C2",
    "ADJUST",
}
CLASSIFIER_FEATURES = [
    "unit_price_z",
    "quantity_z",
    "is_weekend",
    "month_end_proximity",
    "lifetime_return_rate",
    "return_value_ratio",
    "return_velocity",
    "tenure_days",
    "recency_score",
    "frequency_score",
    "monetary_score",
    "unique_categories_returned",
    "weekend_return_share",
    "category_return_rate",
]


def assign_segment_labels(km, scaler) -> dict[int, str]:
    """Map KMeans cluster IDs to semantic labels by inspecting centroids."""
    centers = pd.DataFrame(
        scaler.inverse_transform(km.cluster_centers_),
        columns=SEG_TRAIN_FEATURES,
    )

    remaining = list(range(km.n_clusters))
    returner = int(centers["return_value_ratio"].idxmax())
    remaining.remove(returner)
    loyal = int(centers.loc[remaining, "monetary_score"].idxmax())
    remaining.remove(loyal)
    at_risk = int(centers.loc[remaining, "recency_score"].idxmax())
    remaining.remove(at_risk)
    healthy  = remaining[0]

    return {
        returner: "Returner",
        loyal:    "Premium Loyal",
        at_risk:  "At-Risk",
        healthy:  "Healthy Browser",
    }


def _normalize_customer_id(value: object) -> str:
    if pd.isna(value):
        return ""
    try:
        return f"{float(value):.1f}"
    except (TypeError, ValueError):
        return str(value).strip()


def _normalize_stock_code(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def _load_transactions() -> pd.DataFrame | None:
    if not RAW.exists():
        print(f"\nSkipped invoice_substitutes.joblib: missing {RAW}")
        return None

    from src.features import load_raw

    raw = load_raw(str(RAW))
    raw["invoice_no"] = raw["invoice_no"].astype(str).str.strip()
    raw["stock_code"] = raw["stock_code"].map(_normalize_stock_code)
    raw["customer_id"] = raw["customer_id"].map(_normalize_customer_id)
    raw["description"] = raw["description"].fillna("").astype(str).str.strip()
    raw["country"] = raw.get("country", "United Kingdom")
    raw["country"] = raw["country"].fillna("United Kingdom").astype(str).str.strip()
    raw["invoice_date"] = pd.to_datetime(raw["invoice_date"])
    return raw


def _round_robin_flagged_invoices(
    purchases: pd.DataFrame,
    flagged_customer_ids: set[str],
    limit: int = MAX_FLAGGED_INVOICES,
) -> pd.DataFrame:
    flagged = purchases[purchases["customer_id"].isin(flagged_customer_ids)].copy()
    if flagged.empty:
        return flagged

    invoice_rows = flagged.drop_duplicates("invoice_no")
    groups = [
        group.reset_index(drop=True)
        for _, group in invoice_rows.groupby("customer_id", sort=True)
    ]
    rows = []
    depth = 0
    while len(rows) < limit:
        added = False
        for group in groups:
            if depth < len(group):
                rows.append(group.iloc[depth])
                added = True
                if len(rows) >= limit:
                    break
        if not added:
            break
        depth += 1
    return pd.DataFrame(rows)


def _product_lookup(product_catalogue: pd.DataFrame) -> dict[str, dict[str, object]]:
    p = product_catalogue.copy()
    p["stock_code"] = p["stock_code"].map(_normalize_stock_code)
    return p.set_index("stock_code")[["description", "category_return_rate"]].to_dict("index")


def _returned_products_by_customer(transactions: pd.DataFrame | None) -> dict[str, set[str]]:
    if transactions is None:
        return {}
    returned = transactions[
        transactions["invoice_no"].str.startswith("C", na=False)
        | (transactions["quantity"] < 0)
    ]
    return {
        customer_id: set(group["stock_code"])
        for customer_id, group in returned.groupby("customer_id")
    }


def _candidate_rows(
    transactions: pd.DataFrame | None,
    product_catalogue: pd.DataFrame,
    flagged_customer_ids: set[str],
) -> pd.DataFrame:
    sample = pd.DataFrame(SAMPLE_INVOICES)
    products = _product_lookup(product_catalogue)
    sample["description"] = sample["stock_code"].map(
        lambda code: str(products.get(code, {}).get("description", ""))
    )

    if transactions is None:
        return sample

    purchases = transactions[
        ~transactions["invoice_no"].str.startswith("C", na=False)
        & (transactions["quantity"] > 0)
        & (transactions["stock_code"] != "")
        & (transactions["customer_id"] != "")
    ].copy()
    purchase_lines = purchases.drop_duplicates("invoice_no")
    flagged = _round_robin_flagged_invoices(purchase_lines, flagged_customer_ids)
    combined = pd.concat([sample, flagged], ignore_index=True, sort=False)
    return combined.drop_duplicates("invoice_no", keep="first")


def _stock_index(stock_codes: Iterable[object]) -> dict[str, int]:
    index: dict[str, int] = {}
    for idx, code in enumerate(stock_codes):
        normalized = _normalize_stock_code(code)
        if normalized and normalized not in index:
            index[normalized] = idx
    return index


def _content_matches(
    stock_code: str,
    embeddings: np.ndarray,
    stock_codes: pd.Series,
    stock_to_idx: dict[str, int],
    products: dict[str, dict[str, object]],
    top_pool: int = 25,
) -> list[tuple[str, float]]:
    idx = stock_to_idx.get(stock_code)
    if idx is None:
        return []

    matrix = embeddings.astype(np.float32, copy=False)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    matrix = matrix / np.maximum(norms, 1e-12)
    scores = matrix @ matrix[idx]
    ordered = np.argsort(scores)[::-1]

    matches: list[tuple[str, float]] = []
    seen = {stock_code}
    normalized_codes = stock_codes.astype(str).tolist()
    for match_idx in ordered:
        candidate = _normalize_stock_code(normalized_codes[match_idx])
        if not candidate or candidate in seen or candidate not in products:
            continue
        seen.add(candidate)
        matches.append((candidate, float(np.clip(scores[match_idx], 0.0, 1.0))))
        if len(matches) >= top_pool:
            break
    return matches


def _rationale(category_return_rate: float, in_return_history: bool) -> str:
    history = (
        "in this customer's return history"
        if in_return_history
        else "not in this customer's return history"
    )
    return f"content match, {category_return_rate:.1%} catalogue return rate, {history}"


def build_invoice_substitutes() -> Path | None:
    required = [
        MODELS / "product_embeddings.npy",
        MODELS / "embedding_stock_codes.joblib",
        DATA / "product_catalogue.parquet",
        DATA / "flagged_customers.parquet",
    ]
    missing = [path for path in required if not path.exists()]
    if missing:
        print("\nSkipped invoice_substitutes.joblib: missing required inputs")
        for path in missing:
            print(f"  {path}")
        return None

    product_catalogue = pd.read_parquet(DATA / "product_catalogue.parquet")
    flagged = pd.read_parquet(DATA / "flagged_customers.parquet")
    flagged_ids = set(flagged["customer_id"].map(_normalize_customer_id))
    transactions = _load_transactions()

    products = _product_lookup(product_catalogue)
    rows = _candidate_rows(transactions, product_catalogue, flagged_ids)
    returned_by_customer = _returned_products_by_customer(transactions)

    embeddings = np.load(MODELS / "product_embeddings.npy")
    stock_codes = joblib.load(MODELS / "embedding_stock_codes.joblib").astype(str)
    stock_to_idx = _stock_index(stock_codes)
    match_cache: dict[str, list[tuple[str, float]]] = {}

    lookup: dict[str, dict[str, object]] = {}
    for _, row in rows.iterrows():
        invoice_no = str(row["invoice_no"])
        customer_id = _normalize_customer_id(row.get("customer_id", ""))
        original_stock_code = _normalize_stock_code(row.get("stock_code", ""))
        original_product = products.get(original_stock_code, {})
        original_description = str(
            original_product.get("description") or row.get("description") or ""
        )

        if original_stock_code not in match_cache:
            match_cache[original_stock_code] = _content_matches(
                original_stock_code,
                embeddings,
                stock_codes,
                stock_to_idx,
                products,
            )

        returned_codes = returned_by_customer.get(customer_id, set())
        substitutes = []
        for code, similarity in match_cache[original_stock_code]:
            product = products[code]
            in_history = code in returned_codes
            category_return_rate = float(product.get("category_return_rate", 0.0))
            substitutes.append(
                {
                    "stock_code": code,
                    "description": str(product.get("description", "")),
                    "content_similarity": round(similarity, 4),
                    "in_customer_return_history": bool(in_history),
                    "rationale": _rationale(category_return_rate, in_history),
                }
            )
            if len(substitutes) == 3:
                break

        lookup[invoice_no] = {
            "invoice_no": invoice_no,
            "original_stock_code": original_stock_code,
            "original_description": original_description,
            "substitutes": substitutes,
        }

    out = MODELS / "invoice_substitutes.joblib"
    out.parent.mkdir(exist_ok=True)
    joblib.dump(lookup, out, compress=3)

    size = out.stat().st_size
    if size > TARGET_SUBSTITUTE_ARTIFACT_BYTES:
        print(
            f"WARNING: {out} is {size / 1024 / 1024:.2f} MB, "
            "above the target ~2 MB cap."
        )
    print(f"\nWrote {out} ({size / 1024:.1f} KB)")
    print(f"  invoices: {len(lookup)}")
    print("  content-only lookup; ALS artifacts remain available for offline training")
    return out


def _risk_tier(probability: float) -> str:
    if probability >= 0.6:
        return "High"
    if probability >= 0.3:
        return "Medium"
    return "Low"


def _slug(value: object) -> str:
    return (
        str(value)
        .strip()
        .lower()
        .replace(" ", "-")
        .replace("_", "-")
    )


def _evenly_spaced_rows(frame: pd.DataFrame, n: int) -> pd.DataFrame:
    if frame.empty or n <= 0:
        return frame.head(0)
    ordered = frame.sort_values("return_probability", ascending=True).reset_index(drop=True)
    if len(ordered) <= n:
        return ordered
    positions = np.linspace(0, len(ordered) - 1, n).round().astype(int)
    return ordered.iloc[np.unique(positions)]


def _demo_candidates(
    transactions: pd.DataFrame,
    customer_features: pd.DataFrame,
    product_catalogue: pd.DataFrame,
) -> pd.DataFrame:
    from src.features import add_transaction_features

    featured = add_transaction_features(transactions.copy())
    purchases = featured[
        ~featured["invoice_no"].str.startswith("C", na=False)
        & (featured["quantity"] > 0)
        & (featured["unit_price"] > 0)
        & (featured["customer_id"] != "")
        & (featured["stock_code"] != "")
        & ~featured["stock_code"].isin(EXCLUDED_DEMO_STOCK_CODES)
    ].copy()
    purchases["line_value"] = purchases["quantity"] * purchases["unit_price"]
    purchase_lines = (
        purchases
        .sort_values(["invoice_no", "line_value"], ascending=[True, False])
        .drop_duplicates("invoice_no", keep="first")
    )

    products = product_catalogue.copy()
    products["stock_code"] = products["stock_code"].map(_normalize_stock_code)
    products = products.rename(
        columns={
            "description": "product_description",
            "category_return_rate": "product_category_return_rate",
        }
    )

    customer_cols = [
        col
        for col in customer_features.columns
        if col != "category_return_rate"
    ]
    rows = (
        purchase_lines
        .merge(customer_features[customer_cols], on="customer_id", how="inner")
        .merge(
            products[[
                "stock_code",
                "product_description",
                "product_category_return_rate",
            ]],
            on="stock_code",
            how="left",
        )
    )
    rows["description"] = (
        rows["product_description"]
        .fillna(rows["description"])
        .fillna("")
        .astype(str)
        .str.strip()
    )
    rows = rows[rows["description"] != ""].copy()
    rows["category_return_rate"] = (
        rows["product_category_return_rate"]
        .fillna(DEFAULT_CATEGORY_RETURN_RATE)
        .astype(float)
    )

    classifier = joblib.load(MODELS / "classifier.joblib")
    X = rows[CLASSIFIER_FEATURES].fillna(0)
    rows["return_probability"] = classifier.predict_proba(X)[:, 1]
    rows["risk_tier"] = rows["return_probability"].map(_risk_tier)

    substitute_path = MODELS / "invoice_substitutes.joblib"
    if substitute_path.exists():
        substitute_lookup = joblib.load(substitute_path)
        rows["has_substitutes"] = rows["invoice_no"].astype(str).isin(substitute_lookup)
    else:
        rows["has_substitutes"] = False

    return rows


def _select_demo_cases(candidates: pd.DataFrame) -> pd.DataFrame:
    picks = []
    for tier, count in [("Low", 28), ("Medium", 28), ("High", 36)]:
        tier_frame = candidates[candidates["risk_tier"] == tier]
        if tier == "High":
            tier_frame = tier_frame.sort_values(
                ["has_substitutes", "return_probability"],
                ascending=[False, False],
            )
        picks.append(_evenly_spaced_rows(tier_frame, count))

    for segment in ["Premium Loyal", "Healthy Browser", "At-Risk", "Returner"]:
        picks.append(_evenly_spaced_rows(candidates[candidates["segment"] == segment], 10))

    anomaly_cases = candidates[candidates["anomaly_flag"] == 1].sort_values(
        ["has_substitutes", "return_probability"],
        ascending=[False, False],
    )
    picks.append(_evenly_spaced_rows(anomaly_cases, 24))

    selected = pd.concat(picks, ignore_index=True, sort=False)
    selected["case_id"] = (
        selected["invoice_no"].astype(str) + ":" + selected["stock_code"].astype(str)
    )
    selected = selected.drop_duplicates("case_id", keep="first")
    if len(selected) > TARGET_DEMO_CASES:
        selected = _evenly_spaced_rows(selected, TARGET_DEMO_CASES)
    return selected.sort_values(
        ["risk_tier", "segment", "return_probability", "invoice_no"],
        ascending=[True, True, False, True],
    )


def _demo_record(row: pd.Series) -> dict[str, object]:
    tags = [
        _slug(row["risk_tier"]),
        _slug(row["segment"]),
    ]
    if int(row.get("anomaly_flag", 0)) == 1:
        tags.append("behavior-anomaly")
    if bool(row.get("has_substitutes", False)):
        tags.append("substitutes")

    return {
        "case_id": str(row["case_id"]),
        "invoice_no": str(row["invoice_no"]),
        "customer_id": _normalize_customer_id(row["customer_id"]),
        "stock_code": _normalize_stock_code(row["stock_code"]),
        "description": str(row.get("description", "")),
        "quantity": float(row["quantity"]),
        "unit_price": float(row["unit_price"]),
        "country": str(row.get("country") or "United Kingdom"),
        "invoice_date": pd.Timestamp(row["invoice_date"]).date().isoformat(),
        "segment": str(row["segment"]),
        "risk_tier": str(row["risk_tier"]),
        "return_probability": round(float(row["return_probability"]), 4),
        "anomaly_flag": int(row.get("anomaly_flag", 0)),
        "anomaly_score": round(float(row.get("anomaly_score", 0.0)), 4),
        "lifetime_return_rate": round(float(row.get("lifetime_return_rate", 0.0)), 4),
        "frequency_score": int(row.get("frequency_score", 0)),
        "monetary_score": round(float(row.get("monetary_score", 0.0)), 2),
        "has_substitutes": bool(row.get("has_substitutes", False)),
        "unit_price_z": round(float(row.get("unit_price_z", 0.0)), 4),
        "quantity_z": round(float(row.get("quantity_z", 0.0)), 4),
        "is_weekend": int(row.get("is_weekend", 0)),
        "month_end_proximity": int(row.get("month_end_proximity", 15)),
        "category_return_rate": round(float(row.get("category_return_rate", 0.0)), 4),
        "tags": tags,
    }


def build_demo_cases() -> Path | None:
    required = [
        MODELS / "classifier.joblib",
        MODELS / "customer_features.joblib",
        DATA / "product_catalogue.parquet",
    ]
    missing = [path for path in required if not path.exists()]
    transactions = _load_transactions()
    if missing or transactions is None:
        print("\nSkipped demo_cases.joblib: missing required inputs")
        for path in missing:
            print(f"  {path}")
        return None

    customer_features = joblib.load(MODELS / "customer_features.joblib")
    product_catalogue = pd.read_parquet(DATA / "product_catalogue.parquet")
    candidates = _demo_candidates(transactions, customer_features, product_catalogue)
    selected = _select_demo_cases(candidates)
    records = [_demo_record(row) for _, row in selected.iterrows()]

    out = MODELS / "demo_cases.joblib"
    out.parent.mkdir(exist_ok=True)
    joblib.dump(records, out, compress=3)

    risk_counts = selected["risk_tier"].value_counts().to_dict()
    segment_counts = selected["segment"].value_counts().to_dict()
    print(f"\nWrote {out} ({out.stat().st_size/1024:.1f} KB)")
    print(f"  cases: {len(records)}")
    print(f"  risk tiers: {json.dumps(risk_counts, indent=2)}")
    print(f"  segments: {json.dumps(segment_counts, indent=2)}")
    print(f"  anomaly cases: {int(selected['anomaly_flag'].sum())}")
    return out


def build_customer_features() -> Path:
    cf  = pd.read_parquet(DATA / "customer_features.parquet")
    seg = pd.read_parquet(DATA / "customer_segments.parquet")
    flg = pd.read_parquet(DATA / "flagged_customers.parquet")

    km     = joblib.load(MODELS / "segmentation_kmeans.joblib")
    scaler = joblib.load(MODELS / "segmentation_scaler.joblib")
    mapping = assign_segment_labels(km, scaler)

    print("Cluster -> segment mapping (rule-based):")
    for cid in sorted(mapping):
        print(f"  cluster {cid} -> {mapping[cid]}")

    t = (
        cf
        .merge(seg[["customer_id", "cluster"]], on="customer_id", how="left")
        .merge(flg.rename(columns={"anomaly_score": "anomaly_score_if"}),
               on="customer_id", how="left")
    )
    t["segment"]       = t["cluster"].map(mapping).fillna("Unknown")
    t["anomaly_flag"]  = t["customer_id"].isin(flg["customer_id"]).astype(int)
    t["anomaly_score"] = t["anomaly_score_if"].fillna(0.0)
    t["category_return_rate"] = DEFAULT_CATEGORY_RETURN_RATE

    # API uses customer_id as a string in URL paths; normalize here.
    t["customer_id"] = t["customer_id"].astype(str)

    # Drop helper col
    t = t.drop(columns=["anomaly_score_if"])

    out = MODELS / "customer_features.joblib"
    out.parent.mkdir(exist_ok=True)
    joblib.dump(t, out)

    seg_counts = t["segment"].value_counts().to_dict()
    print(f"\nWrote {out} ({out.stat().st_size/1024:.1f} KB)")
    print(f"  shape: {t.shape}")
    print(f"  segment counts: {json.dumps(seg_counts, indent=2)}")
    print(f"  anomaly_flag positives: {int(t['anomaly_flag'].sum())} / {len(t)}")
    return out


def build() -> tuple[Path, Path | None, Path | None]:
    customer_features = build_customer_features()
    invoice_substitutes = build_invoice_substitutes()
    demo_cases = build_demo_cases()
    return customer_features, invoice_substitutes, demo_cases


if __name__ == "__main__":
    build()
