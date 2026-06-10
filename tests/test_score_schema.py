"""Schema tests for /score on a known customer."""

from __future__ import annotations


def _sample_payload(customer_id: str) -> dict:
    return {
        "customer_id": customer_id,
        "invoice_no": "536365",
        "stock_code": "85123A",
        "quantity": 6,
        "unit_price": 2.55,
        "country": "United Kingdom",
    }


def test_score_returns_expected_schema_for_known_customer(client, known_customer_id):
    response = client.post("/score", json=_sample_payload(known_customer_id))
    assert response.status_code == 200

    body = response.json()
    for key in (
        "customer_id",
        "invoice_no",
        "return_probability",
        "risk_tier",
        "segment",
        "anomaly_flag",
        "anomaly_score",
        "top_shap_factors",
    ):
        assert key in body, f"missing key: {key}"

    assert 0.0 <= body["return_probability"] <= 1.0
    assert body["risk_tier"] in {"High", "Medium", "Low"}
    assert body["segment"] in {
        "Premium Loyal",
        "Healthy Browser",
        "At-Risk",
        "Returner",
        "Unknown",
    }
    assert body["anomaly_flag"] in {0, 1}
    assert isinstance(body["top_shap_factors"], list)
    assert len(body["top_shap_factors"]) <= 5
    if body["top_shap_factors"]:
        first = body["top_shap_factors"][0]
        assert {"feature", "value", "direction"} <= first.keys()
        assert first["direction"] in {"increases", "decreases"}


def test_score_unknown_customer_falls_back_to_neutral_defaults(client):
    response = client.post("/score", json=_sample_payload("__not_a_real_customer__"))
    assert response.status_code == 200

    body = response.json()
    assert body["segment"] == "Unknown"
    assert body["anomaly_flag"] == 0
