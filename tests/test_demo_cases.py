"""Behavior tests for curated invoice demo cases."""

from __future__ import annotations

import pytest


def _require_demo_artifact(demo_cases_artifact_available: bool) -> None:
    if not demo_cases_artifact_available:
        pytest.skip("models/demo_cases.joblib missing; run scripts/build_api_artifacts.py")


def test_demo_cases_endpoint_returns_curated_invoice_cases(
    client,
    demo_cases_artifact_available,
):
    _require_demo_artifact(demo_cases_artifact_available)

    response = client.get("/demo-cases")
    assert response.status_code == 200

    body = response.json()
    filter_keys = {item["key"] for item in body["filters"]}
    assert {"any", "low", "medium", "high", "behavior-anomaly"} <= filter_keys
    assert body["cases"], "expected at least one curated demo case"

    first = body["cases"][0]
    required = {
        "case_id",
        "invoice_no",
        "customer_id",
        "stock_code",
        "description",
        "quantity",
        "unit_price",
        "country",
        "risk_tier",
        "segment",
        "return_probability",
        "anomaly_flag",
        "unit_price_z",
        "quantity_z",
        "is_weekend",
        "month_end_proximity",
        "category_return_rate",
    }
    assert required <= first.keys()
    assert first["risk_tier"] in {"Low", "Medium", "High"}
    assert 0.0 <= first["return_probability"] <= 1.0


def test_demo_cases_can_filter_and_search(client, demo_cases_artifact_available):
    _require_demo_artifact(demo_cases_artifact_available)

    high_response = client.get("/demo-cases", params={"filter": "high", "limit": 20})
    assert high_response.status_code == 200
    high_cases = high_response.json()["cases"]
    assert high_cases, "expected curated high-risk cases"
    assert all(case["risk_tier"] == "High" for case in high_cases)

    first = client.get("/demo-cases", params={"limit": 1}).json()["cases"][0]
    search_response = client.get("/demo-cases", params={"q": first["invoice_no"], "limit": 10})
    assert search_response.status_code == 200
    assert any(case["case_id"] == first["case_id"] for case in search_response.json()["cases"])


def test_demo_case_scores_with_its_real_invoice_context(
    client,
    demo_cases_artifact_available,
):
    _require_demo_artifact(demo_cases_artifact_available)

    demo_case = client.get("/demo-cases", params={"limit": 1}).json()["cases"][0]
    payload = {
        key: demo_case[key]
        for key in [
            "customer_id",
            "invoice_no",
            "stock_code",
            "quantity",
            "unit_price",
            "country",
            "unit_price_z",
            "quantity_z",
            "is_weekend",
            "month_end_proximity",
            "category_return_rate",
        ]
    }

    response = client.post("/score", json=payload)
    assert response.status_code == 200

    body = response.json()
    assert body["invoice_no"] == demo_case["invoice_no"]
    assert abs(body["return_probability"] - demo_case["return_probability"]) <= 0.0001
    assert body["risk_tier"] == demo_case["risk_tier"]
