# Retail Returns Intelligence

Predicts return risk at transaction time and flags excessive returners, trained on 1,067,371 real UK online retail transactions. The classifier hits 0.992 ROC-AUC on a strictly temporal split, and top-decile risk scores catch returns at 8.7x the base rate.

[![Python 3.11](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![LightGBM](https://img.shields.io/badge/LightGBM-4.0%2B-2EA44F)](https://lightgbm.readthedocs.io/)
[![PySpark](https://img.shields.io/badge/PySpark-Databricks-E25A1C?logo=apache-spark&logoColor=white)](https://spark.apache.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110%2B-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![MLflow](https://img.shields.io/badge/MLflow-2.10%2B-0194E2)](https://mlflow.org/)
[![CI](https://github.com/aalias01/retail-returns-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/aalias01/retail-returns-intelligence/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e)](LICENSE)

**[Live demo](https://returns.alvinalias.com)** | **[API docs](https://alvinalias-portfolio-ml-api.hf.space/retail/docs)**

## Why

US retail return fraud cost about $101B in 2023 (NRF). A small share of customers drives a disproportionate share of it through wardrobing, serial returns, and policy abuse, and most retailers only catch this after the losses land. This project answers three questions on real transaction data: is this transaction likely to come back, is this customer a systematic returner, and how should return policy differ across the customer base? A fourth model recommends substitute products at the return moment, so a predicted return can become an exchange instead of a refund.

## Results

| Model | Metric | Result |
|-------|--------|--------|
| LightGBM return classifier | ROC-AUC | 0.992 |
| LightGBM return classifier | PR-AUC | 0.852 |
| LightGBM return classifier | Recall (balanced threshold) | 0.897 |
| LightGBM return classifier | Precision @ top decile | 15.9% vs 1.83% baseline (8.7x lift) |
| XGBoost (comparison) | PR-AUC | 0.849 |
| Isolation Forest | Excessive returners flagged | 294 customers (5.0% contamination) |
| KMeans segmentation (k=4) | Silhouette score | 0.238 |
| Hybrid recommender | Recall@10 / NDCG@10 | 0.093 / 0.046 |
| Backtest | Precision @ decile, mean across 18 rolling windows | 0.181 |
| A/B simulation (14-day window, Returner segment) | Return-value-ratio reduction | ~6.5%, spend guardrail intact (effect size, not p-value; see notebook 07) |

Dataset: UCI Online Retail II, Dec 2009 to Dec 2011. Returns are explicitly labeled (`C`-prefixed InvoiceNo). About 22.8% of rows are missing CustomerID, which the pipeline handles rather than drops.

Model details and limitations are in [models/MODEL_CARD.md](models/MODEL_CARD.md).

## Design decisions

**Point-in-time features.** Customer history features (lifetime return rate, return velocity, average days to return) are computed using only transactions before the current one. The train/test split is temporal: train on 2009 through H1 2011, test on H2 2011. Random splits on this data leak future behavior into training and inflate every metric.

**Four models because it's three problems.** A classifier scores individual transactions but misses the behavioral fingerprint of a serial returner. Isolation Forest catches the fingerprint without needing labels. KMeans (k=4) splits the customer base into Premium Loyal, Healthy Browser, At-Risk, and Returner segments so a policy change can target one group. The recommender (sentence-transformer content embeddings blended with implicit ALS) suggests substitute SKUs when a return is predicted.

**The same feature pipeline runs in Pandas and PySpark.** Pandas for iteration speed at 1M rows. The PySpark variant (notebook 09) runs the pipeline on Databricks with a Bronze/Silver/Gold medallion layout, because real warehouse-retail volume is 100M+ rows and I wanted proof the logic survives the translation.

**Policy changes are tested, not asserted.** Notebook 07 simulates tightening the return window from 30 to 14 days for the Returner segment only: two-proportion z-test, power analysis (alpha 0.05, beta 0.80), and a guardrail on total spend so the policy can't quietly kill revenue. Notebook 08 backtests the classifier over 18 rolling monthly windows instead of trusting a single test-set snapshot.

**Tracked and scheduled.** MLflow records params, metrics, and SHAP artifacts for all four models. A Prefect 2.x flow runs ingest, features, train, and score on a weekly schedule with retries.

## Architecture

```
Visitor selects or searches a real invoice case
      |
frontend/app.js  ->  GET  /demo-cases     ->  curated invoice case lookup
                 ->  POST /score          ->  api/predictor.py
                 ->  GET  /customer/      ->  model inference (LightGBM + IF + KMeans + recommender)
                 ->  GET  /substitutes/   ->  precomputed substitute lookup
                                          ->  SHAP explanation
                                               |
                                     JSON response rendered in browser

Prefect (weekly)  ->  ingest -> features -> train -> score  ->  MLflow (all runs tracked)
```

Frontend is a static ledger-desk page on Vercel. It pulls curated real invoice lines from `/demo-cases`, lets visitors filter by risk tier, segment, or behavior anomaly, then sends the selected invoice through the same `/score` path the API exposes. The ledger fields are locked on purpose because each sample carries real transaction context such as `unit_price_z`, `quantity_z`, `is_weekend`, and category return rate. `/customer/{id}/profile` prints the history check beside the probability scale, and high-risk or substitute-ready invoices call `/substitutes/{invoice_no}`. The FastAPI backend is mounted at `/retail` in the shared Hugging Face Docker Space. Shared feature and model logic lives in `src/`.

## Tech stack

Python 3.11, Pandas, NumPy, LightGBM 4.0+ (primary classifier), XGBoost 2.0+ (comparison), scikit-learn (Isolation Forest, LOF, KMeans), sentence-transformers + implicit ALS (recommender), SHAP TreeExplainer, scipy/statsmodels (A/B testing), DuckDB (SQL feature work), PySpark on Databricks Free Edition, MLflow 2.10+, Prefect 2.x, FastAPI on a shared Hugging Face Docker Space, vanilla JS frontend on Vercel. Full pins are in `environment.yml` for local conda work and `requirements.txt` for pip serving.

## Run it locally

```bash
conda env create -f environment.yml
conda activate retail-returns
```

Download [UCI Online Retail II](https://archive.ics.uci.edu/dataset/502/online+retail+ii) and place the file at `data/raw/online_retail_II.xlsx` (the directory is gitignored).

Run the notebooks in order:

| Notebook | What it does |
|----------|--------------|
| `01_eda.ipynb` | Cancellation patterns, customer distributions, missing-value analysis |
| `02_sql_features.ipynb` | DuckDB SQL: CTEs, window functions, RFM aggregations |
| `03_feature_engineering.ipynb` | Point-in-time transaction and customer features |
| `04_classification_model.ipynb` | LightGBM vs XGBoost, temporal split, threshold selection, SHAP |
| `05_anomaly_detection.ipynb` | Isolation Forest + LOF, contamination tuning |
| `06_segmentation.ipynb` | KMeans, elbow + silhouette, segment profiling |
| `07_ab_test_simulation.ipynb` | Power analysis, 14-day policy simulation, z-test |
| `08_backtesting.ipynb` | Rolling-window backtest, Brier score |
| `09_pyspark_pipeline.ipynb` | PySpark medallion pipeline (Databricks) |
| `10_substitute_recommender.ipynb` | Embeddings + ALS hybrid, Recall@K, NDCG@10 |

Start the API and frontend:

```bash
python scripts/build_api_artifacts.py
ls -lh models/customer_features.joblib models/invoice_substitutes.joblib models/demo_cases.joblib
uvicorn api.main:app --reload
# docs at http://localhost:8000/docs
```

Open `frontend/index.html` in a browser and point `API_BASE` in `frontend/app.js` at `http://localhost:8000`.

Pipeline and tracking:

```bash
python pipelines/prefect_flow.py
mlflow ui --backend-store-uri mlflow/mlruns
```

Smoke test and test suite:

```bash
curl -s http://localhost:8000/health
# {"status":"ok","models_loaded":true,"risk_tiers":{"high":0.6,"medium":0.3},"version":"1.0.0"}
pytest -q
```

Tests that need missing artifacts skip instead of failing. The suite covers `/health`, `/demo-cases`, `/score` schema, `/customer/{id}/profile`, the `/substitutes` contract, and feature-matrix shape.

## Limitations

- Return labels are UCI cancellations (`C`-prefixed invoices). The dataset doesn't distinguish refunds from store credit or partial-line cancellations.
- The live API serves precomputed customer features from `models/customer_features.joblib` and curated demo invoices from `models/demo_cases.joblib`. Production would join against a feature store and a transaction store.
- Manual API calls can omit `unit_price_z`, `quantity_z`, and `month_end_proximity`; the API then uses neutral defaults. The frontend demo uses curated invoice cases because those fields are already known for real historical rows.
- The A/B test is a simulation against held-out historical behavior, not a live randomized experiment.
- The shared Hugging Face CPU Space sleeps after extended inactivity; the first request to this route can take a moment while the service wakes and loads its models.

## Deployment

From the portfolio workspace, run `bash portfolio_ml_api/scripts/sync_from_portfolio.sh`, commit the changes in `portfolio_ml_api`, and push its `main` branch. GitHub Actions deploys the shared Hugging Face Docker Space. This service is mounted at `/retail`. Vercel serves `frontend/` at the live demo URL.

## Project structure

```
├── notebooks/        # 01-10, run in order
├── src/              # features.py, models.py, evaluation.py, recommender.py
├── api/              # FastAPI: main.py, schemas.py, predictor.py
├── frontend/         # static site (Vercel)
├── pipelines/        # prefect_flow.py
├── mlflow/           # local tracking store
├── data/raw/         # gitignored; download from UCI
└── models/           # gitignored; trained artifacts
```

## Dataset and credits

- Dua, D., & Graff, C. (2019). *UCI Machine Learning Repository: Online Retail II.* UC Irvine. Used under the repository's citation terms. [link](https://archive.ics.uci.edu/dataset/502/online+retail+ii)
- Ke, G., et al. (2017). *LightGBM: A Highly Efficient Gradient Boosting Decision Tree.* NeurIPS 2017.
- Chen, T., & Guestrin, C. (2016). *XGBoost: A Scalable Tree Boosting System.* KDD 2016. [arXiv](https://arxiv.org/abs/1603.02754)
- Liu, F. T., Ting, K. M., & Zhou, Z.-H. (2008). *Isolation Forest.* ICDM 2008.
- Lundberg, S. M., & Lee, S.-I. (2017). *A Unified Approach to Interpreting Model Predictions.* NeurIPS 2017. [arXiv](https://arxiv.org/abs/1705.07874)
- Hu, Y., Koren, Y., & Volinsky, C. (2008). *Collaborative Filtering for Implicit Feedback Datasets.* ICDM 2008.
- National Retail Federation (2024). *2023 Retail Return Rate Data.*

MIT licensed (code only; the dataset keeps its own terms). Built by Alvin Alias, MS Data Science, University of Washington.
