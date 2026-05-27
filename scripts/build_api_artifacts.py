"""
scripts/build_api_artifacts.py — Build models/customer_features.joblib.

Why this exists
---------------
The FastAPI service (api/predictor.py) loads a single per-customer table at
startup containing behavioral features + the scored segment label + the
Isolation Forest anomaly flag/score + a default category_return_rate. That
table is the union of three notebook outputs:

    data/processed/customer_features.parquet     (5,881 × 18 — behavioral + RFM)
    data/processed/customer_segments.parquet     (5,881 × 4  — customer_id, cluster, pca_x, pca_y)
    data/processed/flagged_customers.parquet     (    294 × 2 — customer_id, anomaly_score)

This script merges them, maps cluster IDs to human-readable segment labels
by inspecting KMeans centroids (rule-based, so it's reproducible across
re-runs even if cluster IDs permute), and saves the result as
``models/customer_features.joblib``.

Run this once after notebooks 01–06 finish. It is also safe to re-run.

Usage
-----
    python scripts/build_api_artifacts.py

Outputs
-------
    models/customer_features.joblib    (joblib-pickled pandas.DataFrame)

Notes on the cluster → segment mapping
--------------------------------------
KMeans cluster IDs are arbitrary across runs. To make label assignment
deterministic, we use a rule on the inverse-scaled centroids:

    Returner        = cluster with the highest return_value_ratio
    Premium Loyal   = of the remaining, the one with the highest monetary_score
    At-Risk         = of the remaining, the one with the highest recency_score
    Healthy Browser = the cluster that's left

Caveat worth knowing: on the current UCI II training, the "Returner" cluster
holds only ~18 customers — they are very-high-volume (wholesale-like) accounts
where return value concentrates, not classic abusive returners. The Isolation
Forest (294 flagged) is the broader operational fraud signal; the segments
are policy buckets, not a fraud predictor on their own.
"""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "processed"
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


def assign_segment_labels(km, scaler) -> dict[int, str]:
    """Map KMeans cluster IDs to semantic labels by inspecting centroids."""
    centers = pd.DataFrame(
        scaler.inverse_transform(km.cluster_centers_),
        columns=SEG_TRAIN_FEATURES,
    )

    remaining = list(range(km.n_clusters))
    returner = int(centers["return_value_ratio"].idxmax()); remaining.remove(returner)
    loyal    = int(centers.loc[remaining, "monetary_score"].idxmax()); remaining.remove(loyal)
    at_risk  = int(centers.loc[remaining, "recency_score"].idxmax()); remaining.remove(at_risk)
    healthy  = remaining[0]

    return {
        returner: "Returner",
        loyal:    "Premium Loyal",
        at_risk:  "At-Risk",
        healthy:  "Healthy Browser",
    }


def build() -> Path:
    cf  = pd.read_parquet(DATA / "customer_features.parquet")
    seg = pd.read_parquet(DATA / "customer_segments.parquet")
    flg = pd.read_parquet(DATA / "flagged_customers.parquet")

    km     = joblib.load(MODELS / "segmentation_kmeans.joblib")
    scaler = joblib.load(MODELS / "segmentation_scaler.joblib")
    mapping = assign_segment_labels(km, scaler)

    print("Cluster → segment mapping (rule-based):")
    for cid in sorted(mapping):
        print(f"  cluster {cid} → {mapping[cid]}")

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


if __name__ == "__main__":
    build()
