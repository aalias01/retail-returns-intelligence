"""Behavior tests for /substitutes/{invoice_no}."""

from __future__ import annotations

import pytest


def _require_substitute_artifact(substitute_artifact_available: bool) -> None:
    if not substitute_artifact_available:
        pytest.skip(
            "models/invoice_substitutes.joblib missing; run scripts/build_api_artifacts.py"
        )


def test_known_invoice_returns_real_substitutes(client, substitute_artifact_available):
    _require_substitute_artifact(substitute_artifact_available)

    response = client.get("/substitutes/536365")
    assert response.status_code == 200

    body = response.json()
    assert {"invoice_no", "original_stock_code", "original_description", "substitutes"} <= body.keys()
    assert isinstance(body["substitutes"], list)
    assert 1 <= len(body["substitutes"]) <= 3
    assert body["original_stock_code"] != "UNKNOWN"

    for item in body["substitutes"]:
        assert {"stock_code", "description", "content_similarity", "in_customer_return_history", "rationale"} <= item.keys()
        assert 0.0 <= item["content_similarity"] <= 1.0
        assert isinstance(item["in_customer_return_history"], bool)


def test_unknown_invoice_returns_404(client, substitute_artifact_available):
    _require_substitute_artifact(substitute_artifact_available)

    response = client.get("/substitutes/__not_an_invoice__")
    assert response.status_code == 404
