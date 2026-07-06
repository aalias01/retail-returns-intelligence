"""
api/predictor.py - Model loading, inference, and SHAP explanation for Retail Returns API.

Loads all four model artifacts at startup (via FastAPI lifespan).
Provides synchronous inference functions called from api/main.py.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import shap
from pathlib import Path
from typing import Any

from api.schemas import ShapEntry


MODELS_DIR = Path("models")
RISK_TIERS = {"high": 0.6, "medium": 0.3}

# Global model store, populated by load_all_models() at startup.
_models: dict[str, Any] = {}


def load_all_models() -> None:
    """Load all trained artifacts from models/.

    Called once at API startup via FastAPI lifespan. Raises FileNotFoundError
    if any artifact is missing. Run the training notebooks first.
    """
    import joblib

    # LightGBM (classifier) is tree-based and requires no scaler at inference.
    # `customer_features` is the scored per-customer table built by
    # scripts/build_api_artifacts.py has the merge logic.
    required = [
        "classifier",
        "anomaly_detector",
        "anomaly_scaler",
        "segmentation_kmeans",
        "segmentation_scaler",
        "customer_features",
    ]
    for name in required:
        path = MODELS_DIR / f"{name}.joblib"
        if not path.exists():
            raise FileNotFoundError(
                f"Missing model artifact: {path}\n"
                "Run training notebooks before starting the API."
            )
        _models[name] = joblib.load(path)

    _models["shap_explainer"] = shap.TreeExplainer(_models["classifier"])

    # Live substitutes come from a compact lookup so deployment does not need
    # the heavier optional ALS runtime dependency.
    substitutes_path = MODELS_DIR / "invoice_substitutes.joblib"
    if substitutes_path.exists():
        _models["invoice_substitutes"] = joblib.load(substitutes_path)

    # Legacy recommender artifacts are optional. Older deployments may still
    # contain them, but `als_model.joblib` needs the `implicit` package when
    # unpickled. Do not let that optional bundle block API startup.
    emb_path = MODELS_DIR / "product_embeddings.npy"
    legacy_paths = [
        emb_path,
        MODELS_DIR / "embedding_stock_codes.joblib",
        MODELS_DIR / "als_model.joblib",
        MODELS_DIR / "als_product_index.joblib",
    ]
    if all(path.exists() for path in legacy_paths):
        try:
            _models["product_embeddings"] = np.load(emb_path)
            _models["embedding_stock_codes"] = joblib.load(
                MODELS_DIR / "embedding_stock_codes.joblib"
            )
            _models["als_model"] = joblib.load(MODELS_DIR / "als_model.joblib")
            _models["als_product_index"] = joblib.load(
                MODELS_DIR / "als_product_index.joblib"
            )
        except ModuleNotFoundError as exc:
            for key in [
                "product_embeddings",
                "embedding_stock_codes",
                "als_model",
                "als_product_index",
            ]:
                _models.pop(key, None)
            print(f"WARNING: Skipping optional ALS recommender artifacts: {exc}")


def models_loaded() -> bool:
    return len(_models) > 0


# ---------------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------------

def _build_transaction_features(
    customer_id: str,
    stock_code: str,
    quantity: float,
    unit_price: float,
    is_weekend: int,
) -> pd.DataFrame:
    """Assemble a single-row feature DataFrame for the classifier."""
    cust_df: pd.DataFrame = _models["customer_features"]
    row = cust_df[cust_df["customer_id"] == customer_id]

    if len(row) == 0:
        # Unknown customer: use neutral defaults.
        cust_feats = {
            "lifetime_return_rate": 0.0,
            "return_value_ratio": 0.0,
            "return_velocity": 0.0,
            "tenure_days": 0,
            "recency_score": 365,
            "frequency_score": 1,
            "monetary_score": float(unit_price * quantity),
            "unique_categories_returned": 0,
            "weekend_return_share": 0.0,
            "category_return_rate": 0.05,  # dataset baseline
        }
    else:
        cust_feats = row.iloc[0].to_dict()

    return pd.DataFrame(
        [
            {
                "unit_price_z": 0.0,  # requires product stats, set to mean at inference
                "quantity_z": 0.0,
                "is_weekend": is_weekend,
                "month_end_proximity": 15,  # midpoint default
                **{k: cust_feats.get(k, 0.0) for k in [
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
                ]},
            }
        ]
    )


def predict_transaction(
    customer_id: str,
    invoice_no: str,
    stock_code: str,
    quantity: float,
    unit_price: float,
    country: str,
    is_weekend: int,
) -> dict:
    """Run all models for a single transaction and return scored response."""
    classifier = _models["classifier"]
    cust_df: pd.DataFrame = _models["customer_features"]

    X = _build_transaction_features(
        customer_id, stock_code, quantity, unit_price, is_weekend
    )

    # Model 1: return probability
    return_prob = float(classifier.predict_proba(X)[0, 1])
    # Three numbers govern different jobs. The 0.6 and 0.3 tier cuts are
    # display buckets for the live demo. classifier_meta.json keeps the
    # balanced-precision operating point selected in notebook 04. The README's
    # top-decile lift is a ranking claim, not a single operating threshold.
    risk_tier = (
        "High" if return_prob >= RISK_TIERS["high"]
        else "Medium" if return_prob >= RISK_TIERS["medium"]
        else "Low"
    )

    # SHAP
    explainer = _models["shap_explainer"]
    sv = explainer.shap_values(X)
    if isinstance(sv, list):
        sv = sv[1]
    feature_names = X.columns.tolist()
    shap_pairs = sorted(
        zip(feature_names, sv[0].tolist()),
        key=lambda p: abs(p[1]),
        reverse=True,
    )[:5]
    shap_entries = [
        ShapEntry(
            feature=name,
            value=round(val, 4),
            direction="increases" if val > 0 else "decreases",
        )
        for name, val in shap_pairs
    ]

    # Models 2 + 3: customer-level, looked up rather than recomputed per request.
    cust_row = cust_df[cust_df["customer_id"] == customer_id]
    if len(cust_row) > 0:
        anomaly_flag = int(cust_row.iloc[0].get("anomaly_flag", 0))
        anomaly_score = float(cust_row.iloc[0].get("anomaly_score", 0.0))
        segment = str(cust_row.iloc[0].get("segment", "Unknown"))
    else:
        anomaly_flag = 0
        anomaly_score = 0.0
        segment = "Unknown"

    return {
        "customer_id": customer_id,
        "invoice_no": invoice_no,
        "return_probability": round(return_prob, 4),
        "risk_tier": risk_tier,
        "segment": segment,
        "anomaly_flag": anomaly_flag,
        "anomaly_score": round(anomaly_score, 4),
        "top_shap_factors": shap_entries,
    }


def get_customer_profile(customer_id: str) -> dict | None:
    """Return full behavioral profile for a customer."""
    cust_df: pd.DataFrame = _models["customer_features"]
    row = cust_df[cust_df["customer_id"] == customer_id]
    if len(row) == 0:
        return None
    r = row.iloc[0]

    return {
        "customer_id": customer_id,
        "segment": str(r.get("segment", "Unknown")),
        "anomaly_flag": int(r.get("anomaly_flag", 0)),
        "anomaly_score": float(r.get("anomaly_score", 0.0)),
        "lifetime_return_rate": float(r.get("lifetime_return_rate", 0.0)),
        "return_value_ratio": float(r.get("return_value_ratio", 0.0)),
        "return_velocity": float(r.get("return_velocity", 0.0)),
        "tenure_days": int(r.get("tenure_days", 0)),
        "recency_score": int(r.get("recency_score", 0)),
        "frequency_score": int(r.get("frequency_score", 0)),
        "monetary_score": float(r.get("monetary_score", 0.0)),
        # A profile is not a prediction. SHAP belongs to scored transactions,
        # where the transaction context exists, so this stays empty by design.
        "top_shap_factors": [],
    }


def get_substitutes(invoice_no: str, top_k: int = 3) -> dict | None:
    """Return top-3 substitute product recommendations for an invoice."""
    lookup: dict[str, Any] | None = _models.get("invoice_substitutes")
    if lookup is not None:
        result = lookup.get(str(invoice_no))
        if result is None:
            return None
        result = dict(result)
        result["substitutes"] = result.get("substitutes", [])[:top_k]
        return result

    if "product_embeddings" not in _models:
        return None

    # Backward-compatible empty response while Alvin has not built the new
    # invoice_substitutes.joblib artifact yet.
    return {
        "invoice_no": invoice_no,
        "original_stock_code": "UNKNOWN",
        "original_description": "Item lookup pending",
        "substitutes": [],
    }
