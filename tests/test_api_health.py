"""Smoke tests for the /health endpoint and model bundle loading."""

from __future__ import annotations


def test_health_endpoint_returns_ok(client):
    response = client.get("/health")
    assert response.status_code == 200

    body = response.json()
    assert body["status"] == "ok"
    assert body["models_loaded"] is True
    assert "version" in body


def test_root_endpoint_lists_routes(client):
    response = client.get("/")
    assert response.status_code == 200

    body = response.json()
    assert body["project"] == "Retail Returns Intelligence"
    for path in ("/health", "/score", "/customer/{id}/profile", "/substitutes/{invoice_no}"):
        assert path in body["endpoints"]


def test_load_all_models_populates_required_artifacts(models_available):
    """`load_all_models()` registers every artifact the inference path needs."""
    if not models_available:
        import pytest
        pytest.skip("Model artifacts missing.")

    from api import predictor

    predictor.load_all_models()
    assert predictor.models_loaded()

    required = {
        "classifier",
        "anomaly_detector",
        "anomaly_scaler",
        "segmentation_kmeans",
        "segmentation_scaler",
        "customer_features",
    }
    assert required.issubset(predictor._models.keys())
