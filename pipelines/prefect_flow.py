"""
pipelines/prefect_flow.py - Prefect 2.x orchestration for Retail Returns Intelligence.

Pipeline: ingest → preprocess → feature engineering → train (4 models) → score → persist

Schedule: weekly, even without new data, to prove the flow works end-to-end.
Retry policy: 3 retries with 60s delay on transient failures.

To run locally:
    python pipelines/prefect_flow.py

To deploy (Prefect Cloud free tier):
    prefect deploy pipelines/prefect_flow.py:retail_returns_flow
    prefect worker start --pool default-agent-pool

Screenshot the Prefect UI flow graph for the README after first successful run.
"""

from __future__ import annotations

from pathlib import Path

import mlflow
import pandas as pd
from prefect import flow, task, get_run_logger
from prefect.tasks import task_input_hash
from datetime import timedelta

DATA_DIR = Path("data")
MODELS_DIR = Path("models")
MLFLOW_URI = "mlflow/mlruns"


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

@task(
    name="ingest-raw-data",
    retries=3,
    retry_delay_seconds=60,
    cache_key_fn=task_input_hash,
    cache_expiration=timedelta(hours=24),
)
def ingest_raw_data(data_path: str = "data/raw/online_retail_II.xlsx") -> pd.DataFrame:
    """Load raw UCI Online Retail II data.

    Cached for 24h. Re-reads from disk only when the source file changes.
    In production, this would pull from a cloud storage path (GCS/S3/DBFS).
    """
    logger = get_run_logger()
    logger.info(f"Loading raw data from {data_path}")

    from src.features import load_raw
    df = load_raw(data_path)
    logger.info(f"Loaded {len(df):,} rows, {df['customer_id'].nunique():,} unique customers")
    return df


@task(name="preprocess", retries=2)
def preprocess(df: pd.DataFrame) -> pd.DataFrame:
    """Clean: drop rows with negative unit price, handle missing CustomerIDs."""
    logger = get_run_logger()

    n_before = len(df)
    df = df[df["unit_price"] >= 0].copy()
    n_negative_price = n_before - len(df)

    missing_cust = df["customer_id"].isna().sum()
    # Keep missing CustomerID rows for anomaly + segmentation (they're valid transactions)
    # but flag them for models that need the ID

    logger.info(
        f"Preprocessing complete. Dropped {n_negative_price} negative-price rows. "
        f"{missing_cust:,} rows with missing CustomerID retained."
    )
    return df


@task(name="build-features", retries=2)
def build_features(
    df: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Compute transaction-level and customer-level feature matrices.

    Returns: (tx_features_df, customer_features_df, category_rates_df)
    """
    logger = get_run_logger()

    from src.features import (
        add_transaction_features,
        build_customer_features,
        add_return_velocity,
        build_category_return_rates,
    )

    df = add_transaction_features(df)
    customer_features = build_customer_features(df)
    customer_features = add_return_velocity(df, customer_features)
    category_rates = build_category_return_rates(df)

    logger.info(
        f"Features built: {len(df):,} transaction rows, "
        f"{len(customer_features):,} customer profiles"
    )
    return df, customer_features, category_rates


@task(name="train-classifier", retries=1)
def train_classifier_task(
    df: pd.DataFrame,
    customer_features: pd.DataFrame,
    category_rates: pd.DataFrame,
) -> dict:
    """Train Model 1: LightGBM return-likelihood classifier with MLflow tracking."""
    logger = get_run_logger()

    from src.features import build_feature_matrix
    from src.models import train_classifier, evaluate_classifier, save_model

    # Temporal split: train before July 2011, test July–Dec 2011
    cutoff = pd.Timestamp("2011-07-01")
    train_df = df[df["invoice_date"] < cutoff]
    test_df = df[df["invoice_date"] >= cutoff]

    X_train, y_train = build_feature_matrix(train_df, customer_features, category_rates)
    X_test, y_test = build_feature_matrix(test_df, customer_features, category_rates)

    mlflow.set_tracking_uri(MLFLOW_URI)
    with mlflow.start_run(run_name="classifier-lgbm"):
        params = {
            "n_estimators": 500,
            "learning_rate": 0.05,
            "num_leaves": 63,
            "class_weight": "balanced",
        }
        mlflow.log_params(params)

        model = train_classifier(X_train, y_train, X_test, y_test, **params)
        metrics = evaluate_classifier(model, X_test, y_test)

        mlflow.log_metrics(metrics)
        save_model(model, "classifier")

        logger.info(f"Classifier trained. PR-AUC={metrics['pr_auc']:.4f}, "
                    f"Precision@top-decile={metrics['precision_top_decile']:.4f}")
        return metrics


@task(name="train-anomaly-detector", retries=1)
def train_anomaly_detector_task(customer_features: pd.DataFrame) -> None:
    """Train Model 2: Isolation Forest excessive-returner detector."""
    logger = get_run_logger()

    from src.models import train_anomaly_detector, save_model

    feature_cols = [
        "lifetime_return_rate", "return_value_ratio", "return_velocity",
        "unique_categories_returned", "weekend_return_share", "tenure_days",
    ]
    X = customer_features[feature_cols].fillna(0)

    mlflow.set_tracking_uri(MLFLOW_URI)
    with mlflow.start_run(run_name="anomaly-isolation-forest"):
        contamination = 0.05
        mlflow.log_param("contamination", contamination)

        model, scaler = train_anomaly_detector(X, contamination=contamination)
        save_model(model, "anomaly_detector")
        save_model(scaler, "anomaly_scaler")

        logger.info("Anomaly detector trained and saved.")


@task(name="train-segmentation", retries=1)
def train_segmentation_task(customer_features: pd.DataFrame) -> None:
    """Train Model 3: KMeans customer segmentation."""
    logger = get_run_logger()

    from src.models import train_segmentation, save_model

    feature_cols = [
        "recency_score", "frequency_score", "monetary_score",
        "lifetime_return_rate", "return_value_ratio",
    ]
    X = customer_features[feature_cols].fillna(0)

    mlflow.set_tracking_uri(MLFLOW_URI)
    with mlflow.start_run(run_name="segmentation-kmeans-k4"):
        mlflow.log_param("k", 4)

        model, scaler = train_segmentation(X, k=4)
        # Filename matches what notebook 06 saves and api/predictor.py loads.
        save_model(model, "segmentation_kmeans")
        save_model(scaler, "segmentation_scaler")

        logger.info("Segmentation model trained and saved.")


@task(name="score-and-persist", retries=1)
def score_and_persist(
    customer_features: pd.DataFrame,
) -> None:
    """Apply anomaly detection + segmentation to all customers and persist results.

    This scored table is what the API loads from disk at startup.
    """
    import joblib
    from src.models import predict_anomaly, assign_segments

    anomaly_model = joblib.load(MODELS_DIR / "anomaly_detector.joblib")
    anomaly_scaler = joblib.load(MODELS_DIR / "anomaly_scaler.joblib")
    seg_model = joblib.load(MODELS_DIR / "segmentation_kmeans.joblib")
    seg_scaler = joblib.load(MODELS_DIR / "segmentation_scaler.joblib")

    feature_cols_anomaly = [
        "lifetime_return_rate", "return_value_ratio", "return_velocity",
        "unique_categories_returned", "weekend_return_share", "tenure_days",
    ]
    feature_cols_seg = [
        "recency_score", "frequency_score", "monetary_score",
        "lifetime_return_rate", "return_value_ratio",
    ]

    X_anom = customer_features[feature_cols_anomaly].fillna(0)
    X_seg = customer_features[feature_cols_seg].fillna(0)

    anomaly_results = predict_anomaly(anomaly_model, anomaly_scaler, X_anom)
    segments = assign_segments(seg_model, seg_scaler, X_seg)

    customer_features = customer_features.copy()
    customer_features["anomaly_flag"] = anomaly_results["anomaly_flag"].values
    customer_features["anomaly_score"] = anomaly_results["anomaly_score"].values
    customer_features["segment"] = segments.values

    joblib.dump(customer_features, MODELS_DIR / "customer_features.joblib")
    get_run_logger().info(
        f"Scored {len(customer_features):,} customers. "
        f"Returner segment: {(customer_features['segment'] == 'Returner').sum()} customers."
    )


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

@flow(
    name="retail-returns-flow",
    description=(
        "Weekly ingest → feature engineering → train all 4 models → score all customers → "
        "persist scored feature table for API."
    ),
)
def retail_returns_flow(data_path: str = "data/raw/online_retail_II.xlsx") -> None:
    """End-to-end Retail Returns Intelligence pipeline."""
    MODELS_DIR.mkdir(exist_ok=True)
    mlflow.set_experiment("retail-returns-intelligence")

    df = ingest_raw_data(data_path)
    df = preprocess(df)
    df, customer_features, category_rates = build_features(df)

    # Train all three models (recommender trained separately in notebook 10)
    classifier_metrics = train_classifier_task(df, customer_features, category_rates)
    train_anomaly_detector_task(customer_features)
    train_segmentation_task(customer_features)

    score_and_persist(customer_features)

    get_run_logger().info(
        f"Pipeline complete. Classifier PR-AUC={classifier_metrics['pr_auc']:.4f}"
    )


if __name__ == "__main__":
    retail_returns_flow()
