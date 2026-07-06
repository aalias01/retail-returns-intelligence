"""Shared pytest fixtures for the Retail Returns Intelligence test suite."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure repo root is on sys.path so `api`, `src`, etc. import cleanly when
# running `pytest` from the repo root.
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture(scope="session")
def models_dir() -> Path:
    return REPO_ROOT / "models"


@pytest.fixture(scope="session")
def models_available(models_dir: Path) -> bool:
    """True when the API-runtime bundle of artifacts is on disk."""
    required = [
        "classifier.joblib",
        "anomaly_detector.joblib",
        "anomaly_scaler.joblib",
        "segmentation_kmeans.joblib",
        "segmentation_scaler.joblib",
        "customer_features.joblib",
    ]
    return all((models_dir / name).exists() for name in required)


@pytest.fixture(scope="session")
def substitute_artifact_available(models_dir: Path) -> bool:
    return (models_dir / "invoice_substitutes.joblib").exists()


@pytest.fixture(scope="session")
def demo_cases_artifact_available(models_dir: Path) -> bool:
    return (models_dir / "demo_cases.joblib").exists()


@pytest.fixture(scope="session")
def client(models_available: bool):
    """FastAPI TestClient with models loaded once for the whole session."""
    from fastapi.testclient import TestClient

    if not models_available:
        pytest.skip("Model artifacts missing. Run notebooks then build_api_artifacts.py")

    from api.main import app
    from api import predictor

    predictor.load_all_models()
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def known_customer_id() -> str:
    """A high-revenue Premium Loyal customer from the precomputed feature table."""
    return "16684.0"
