"""
api/main.py — FastAPI backend for Retail Returns Intelligence.

Endpoints:
  GET  /                           — landing page
  GET  /health                     — health check (model load status)
  POST /score                      — score a single transaction (return probability + segment + SHAP)
  GET  /customer/{customer_id}/profile — full customer behavioral profile
  GET  /substitutes/{invoice_no}   — top-3 substitute product recommendations

Deployment: Render (free tier) via render.yaml Blueprint.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from api import predictor
from api.schemas import (
    HealthResponse,
    TransactionScoreRequest,
    TransactionScoreResponse,
    CustomerProfileResponse,
    SubstitutesResponse,
)


# ---------------------------------------------------------------------------
# Lifespan — load models once at startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        predictor.load_all_models()
    except FileNotFoundError as e:
        # Allow API to start in "no models" mode — useful during scaffolding
        # before training notebooks have been run. /score will return 503.
        print(f"WARNING: Model artifacts not found — API running in degraded mode.\n{e}")
    yield


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Retail Returns Intelligence API",
    description=(
        "Return-likelihood scoring, excessive-returner detection, customer segmentation, "
        "and substitute product recommendations — built on UCI Online Retail II data."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",     # VS Code Live Server
        "http://localhost:3000",
        "http://127.0.0.1:5500",
        "https://your-project.vercel.app",  # Replace after Vercel deploy
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", tags=["meta"])
async def root():
    return {
        "project": "Retail Returns Intelligence",
        "endpoints": ["/health", "/score", "/customer/{id}/profile", "/substitutes/{invoice_no}"],
        "docs": "/docs",
    }


@app.get("/health", response_model=HealthResponse, tags=["meta"])
async def health():
    return HealthResponse(
        status="ok",
        models_loaded=predictor.models_loaded(),
    )


@app.post("/score", response_model=TransactionScoreResponse, tags=["scoring"])
async def score_transaction(request: TransactionScoreRequest):
    """Score a single transaction.

    Returns return probability, risk tier, customer segment, anomaly flag,
    and the top 5 SHAP factors driving the prediction.
    """
    if not predictor.models_loaded():
        raise HTTPException(
            status_code=503,
            detail="Model artifacts not loaded. Run training notebooks first.",
        )

    from datetime import datetime
    is_weekend = int(datetime.now().weekday() >= 5)

    result = predictor.predict_transaction(
        customer_id=request.customer_id,
        invoice_no=request.invoice_no,
        stock_code=request.stock_code,
        quantity=request.quantity,
        unit_price=request.unit_price,
        country=request.country,
        is_weekend=is_weekend,
    )
    return TransactionScoreResponse(**result)


@app.get(
    "/customer/{customer_id}/profile",
    response_model=CustomerProfileResponse,
    tags=["customer"],
)
async def customer_profile(customer_id: str):
    """Return the full behavioral profile for a customer.

    Includes segment, anomaly flag, RFM scores, return-rate metrics,
    and SHAP-driven explanation of the top risk drivers.
    """
    if not predictor.models_loaded():
        raise HTTPException(status_code=503, detail="Models not loaded.")

    profile = predictor.get_customer_profile(customer_id)
    if profile is None:
        raise HTTPException(
            status_code=404,
            detail=f"Customer {customer_id!r} not found in precomputed feature table.",
        )
    return CustomerProfileResponse(**profile)


@app.get(
    "/substitutes/{invoice_no}",
    response_model=SubstitutesResponse,
    tags=["recommender"],
)
async def substitute_recommendations(invoice_no: str):
    """Return top-3 substitute product recommendations for a given invoice.

    Used when a return is predicted or initiated — recommend alternatives
    to convert refunds into retained revenue.
    """
    if not predictor.models_loaded():
        raise HTTPException(status_code=503, detail="Models not loaded.")

    result = predictor.get_substitutes(invoice_no)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Invoice {invoice_no!r} not found or recommender not yet trained.",
        )
    return SubstitutesResponse(**result)
