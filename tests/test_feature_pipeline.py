"""Schema test for `build_feature_matrix` from src/features.py."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest


EXPECTED_COLUMNS = [
    "unit_price_z",
    "quantity_z",
    "is_weekend",
    "month_end_proximity",
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
]


@pytest.fixture
def minimal_transactions() -> pd.DataFrame:
    """Two-row toy transaction frame with all columns build_feature_matrix expects."""
    return pd.DataFrame(
        {
            "invoice_no": ["A1", "C2"],
            "stock_code": ["85123A", "85123A"],
            "customer_id": ["12345", "12345"],
            "quantity": [6, 1],
            "unit_price": [2.55, 2.55],
            "unit_price_z": [0.1, 0.1],
            "quantity_z": [0.2, 0.2],
            "is_weekend": [0, 1],
            "month_end_proximity": [10, 20],
            "is_return": [0, 1],
        }
    )


@pytest.fixture
def minimal_customer_features() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "customer_id": ["12345"],
            "lifetime_return_rate": [0.1],
            "return_value_ratio": [0.05],
            "return_velocity": [0.0],
            "tenure_days": [120],
            "recency_score": [5],
            "frequency_score": [10],
            "monetary_score": [250.0],
            "unique_categories_returned": [1],
            "weekend_return_share": [0.0],
        }
    )


@pytest.fixture
def minimal_category_rates() -> pd.DataFrame:
    return pd.DataFrame({"stock_code": ["85123A"], "category_return_rate": [0.05]})


def test_build_feature_matrix_produces_expected_columns(
    minimal_transactions, minimal_customer_features, minimal_category_rates
):
    from src.features import build_feature_matrix

    X, y = build_feature_matrix(
        minimal_transactions, minimal_customer_features, minimal_category_rates
    )
    assert list(X.columns) == EXPECTED_COLUMNS
    assert len(X) == len(minimal_transactions)
    assert y.tolist() == [0, 1]
    # NaN policy: missing customer/category joins are filled with 0
    assert not X.isna().any().any()
    # Numeric dtypes only
    assert all(np.issubdtype(dt, np.number) for dt in X.dtypes)
