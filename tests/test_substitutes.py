"""Behavior tests for /substitutes/{invoice_no}.

The v1 recommender ships as an explicit stub — the API contract is fixed so the
frontend degrades gracefully. These tests pin that contract so a future
implementation can replace the stub without breaking callers.
"""

from __future__ import annotations


def test_substitutes_returns_documented_stub_schema(client):
    response = client.get("/substitutes/536365")
    assert response.status_code == 200

    body = response.json()
    assert {"invoice_no", "original_stock_code", "original_description", "substitutes"} <= body.keys()
    assert isinstance(body["substitutes"], list)
    # Stub returns an empty list; once the recommender is wired up,
    # change this to `0 < len(...) <= 3` and add semantic checks.
    assert len(body["substitutes"]) <= 3
