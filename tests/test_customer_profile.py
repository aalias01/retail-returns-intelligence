"""Schema tests for /customer/{id}/profile."""

from __future__ import annotations


def test_profile_returns_expected_schema(client, known_customer_id):
    response = client.get(f"/customer/{known_customer_id}/profile")
    assert response.status_code == 200

    body = response.json()
    for key in (
        "customer_id",
        "segment",
        "anomaly_flag",
        "anomaly_score",
        "lifetime_return_rate",
        "return_value_ratio",
        "return_velocity",
        "tenure_days",
        "recency_score",
        "frequency_score",
        "monetary_score",
        "top_shap_factors",
    ):
        assert key in body, f"missing key: {key}"

    assert 0.0 <= body["lifetime_return_rate"] <= 1.0
    assert body["frequency_score"] >= 1
    assert body["tenure_days"] >= 0


def test_profile_unknown_customer_returns_404(client):
    response = client.get("/customer/__definitely_not_a_customer__/profile")
    assert response.status_code == 404
