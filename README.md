# Retail Returns Intelligence — Detecting Excessive Returners and Quantifying Return Risk

[![Python 3.11](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![LightGBM](https://img.shields.io/badge/LightGBM-4.0%2B-2EA44F)](https://lightgbm.readthedocs.io/)
[![PySpark](https://img.shields.io/badge/PySpark-Databricks-E25A1C?logo=apache-spark&logoColor=white)](https://spark.apache.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110%2B-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![MLflow](https://img.shields.io/badge/MLflow-2.10%2B-0194E2)](https://mlflow.org/)
[![Prefect](https://img.shields.io/badge/Prefect-2.x-3B2FC9)](https://www.prefect.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e)](LICENSE)
[![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)]()

> **Given 1M+ real UK online retail transactions, identify excessive returners, predict return risk at transaction time, segment customers for differentiated policy, and recommend substitute products to convert returns into retained revenue.**

🔗 **[Live Demo](https://your-project.vercel.app)** &nbsp;|&nbsp; 📡 **[API Docs](https://your-api.onrender.com/docs)** &nbsp;|&nbsp; 📊 **[PowerBI Dashboard](dashboards/retail_returns_dashboard.pdf)**

---

## Key Results

| Model | Metric | Result |
|-------|--------|--------|
| LightGBM Return Classifier | Precision @ top decile | *TBD after training* |
| LightGBM Return Classifier | PR-AUC | *TBD after training* |
| Isolation Forest | Overlap with top-decile heuristic | *TBD after fitting* |
| KMeans Segmentation | Silhouette score | *TBD after fitting* |
| Hybrid Recommender | NDCG@10 | *TBD after fitting* |
| A/B Test (14-day policy on Returner segment) | Return value ratio lift | *TBD after simulation* |

**Dataset snapshot:** 1,067,371 transactions · Dec 2009 – Dec 2011 · UCI Online Retail II · cancellations labeled via `C`-prefixed InvoiceNo · real messy data with ~25% missing CustomerIDs

---

## What Makes This Interesting

**Three sub-questions, four models.** Return intelligence isn't one problem — it's three: is *this transaction* risky right now? Is *this customer* a systematic returner? How should we differentiate policy across the customer base? A classifier alone misses the behavioral fingerprint; an anomaly detector alone misses per-transaction context. The fourth model turns a predicted return into a retention opportunity: recommend substitutes before issuing the refund.

**Temporal leakage is easy to miss here.** Customer history features (lifetime return rate, return velocity, avg days to return) must be computed using only transactions *before* the current one. All features are point-in-time safe. Train/test split is strictly temporal — train on 2009–H1 2011, test on H2 2011.

**The PySpark variant is not contrived.** The same feature pipeline runs in both Pandas and PySpark. Pandas for fast iteration; PySpark on Databricks with a medallion architecture (Bronze raw → Silver cleaned → Gold features) because Costco's actual transaction volume isn't 1M — it's 100M+. The notebook link in the README proves the PySpark variant ran end-to-end.

**The A/B test framework closes the JD gap.** Most ML portfolio projects skip experimentation. This one includes a full policy simulation: tighten return window from 30 → 14 days for the Returner segment only, with a two-proportion z-test, power analysis at α=0.05, β=0.80, and a guardrail on total spend. The result is defensible in an interview and relevant to a hiring manager who's read the Costco JD.

**Production MLOps, not notebook MLOps.** Prefect orchestrates the weekly ingest → feature → train → score pipeline with retry logic. MLflow tracks all four model runs — params, metrics, SHAP artifacts — so the README screenshots show a real experiment comparison, not a one-off notebook run.

---

## Problem Statement

US retail return fraud cost ~$101B in 2023 (NRF). A small fraction of customers — "excessive returners" — drive a disproportionate share through wardrobing, serial returns, fraudulent claims, and policy abuse. Most retailers detect this reactively, after losses accumulate.

Given a 2-year stream of UK online retail transactions with explicit cancellation labels:

1. **Predict return likelihood** at transaction time — flag high-risk orders before processing
2. **Detect excessive-returner behavior** — unsupervised anomaly detection on customer behavioral features, no labels required
3. **Segment customers** by return profile (Premium Loyal / Healthy Browser / At-Risk / Returner) for differentiated policy
4. **Quantify dollar impact** of policy changes through A/B test simulation and rolling-window backtesting
5. **Recommend substitute products** at the return moment — convert refunds into retained revenue

---

## Architecture

```
frontend/          →  Vercel (static site, no build step)
api/               →  Render (FastAPI Python backend)
src/               →  Shared feature engineering + model logic
pipelines/         →  Prefect 2.x orchestration
mlflow/            →  Local experiment tracking store
dashboards/        →  PowerBI .pbix + static PDF export
```

```
User input (CustomerID or InvoiceNo)
      ↓
frontend/app.js  →  POST /score          →  api/predictor.py
                 →  GET  /substitutes/   →       ↓
                 →  GET  /customer/      →  Feature lookup
                                         →  Model inference (LightGBM + IF + KMeans + Recommender)
                                         →  SHAP explanation
                                               ↓
                                     JSON response → rendered in browser
                                               ↓
                              Prefect (scheduled weekly)  →  MLflow (all runs tracked)
```

---

## Dataset

### Primary — UCI Online Retail II
- **Source:** [UCI Machine Learning Repository](https://archive.ics.uci.edu/dataset/502/online+retail+ii)
- **Size:** ~1,067,371 transactions · Dec 2009 – Dec 2011
- **Schema:** `InvoiceNo` · `StockCode` · `Description` · `Quantity` · `InvoiceDate` · `UnitPrice` · `CustomerID` · `Country`
- **Returns labeled:** `InvoiceNo` starting with `C` = cancellation/return — real, explicit labels
- **Volume:** Runs on laptop in Pandas; PySpark variant on Databricks proves the pipeline scales

### Optional supplement — Brazilian Olist eCommerce
- **Source:** [Kaggle](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce)
- **Why:** Richer behavioral features (delivery time, review scores, payment type) for the segmentation model

---

## Tech Stack

| Layer | Tool |
|-------|------|
| Notebook environment | Jupyter (conda) |
| Data wrangling (small) | Pandas, NumPy |
| Data wrangling (scale) | **PySpark on Databricks Free Edition** (medallion architecture) |
| EDA visualization | Matplotlib, Seaborn, Plotly |
| SQL practice | **DuckDB** (CTEs, window functions, RFM aggregations) |
| Classification | **LightGBM** (primary), XGBoost (comparison) |
| Anomaly detection | **Isolation Forest**, Local Outlier Factor |
| Segmentation | **KMeans** with RFM + behavioral features |
| Recommender | **sentence-transformers** (content embeddings) + **implicit ALS** (collaborative filtering) |
| Interpretability | **SHAP TreeExplainer** |
| A/B testing | scipy.stats, statsmodels |
| Experiment tracking | **MLflow** (local file-based store) |
| Orchestration | **Prefect 2.x** |
| Model serving | **FastAPI** on Render |
| Frontend | Vanilla HTML/CSS/JS on Vercel |
| Dashboard | **PowerBI Desktop** → PDF export |
| Environment | conda (`environment.yml`) + pip (`requirements.txt`) |

---

## Approach

| Step | What | Why |
|------|------|-----|
| Label engineering | `C`-prefix InvoiceNo → `is_return` flag | Returns are explicitly labeled in UCI II |
| Feature engineering | Point-in-time customer behavioral features (return rate, velocity, RFM) | Captures behavioral fingerprint; avoids lookahead leakage |
| Train/test split | Temporal — train 2009–H1 2011, test H2 2011 | No data leakage across time boundary |
| Model 1: Classifier | LightGBM + SHAP + temporal split | Per-transaction return risk at checkout time |
| Model 2: Anomaly | Isolation Forest on customer-level features | Flags systematic returners without labels |
| Model 3: Segmentation | KMeans k=4 on RFM + return features | Premium Loyal / Healthy Browser / At-Risk / Returner |
| Model 4: Recommender | Content embeddings + ALS + hybrid blend | Substitute SKUs at return moment → retained revenue |
| A/B simulation | 14-day vs. 30-day return window on Returner segment | Policy-change impact with statistical rigor |
| Backtesting | Rolling 12-month training, predict next 30 days | Model behavior across time — not a single test-set snapshot |
| PySpark variant | Medallion architecture: Bronze→Silver→Gold | Demonstrates pipeline scales to warehouse-club transaction volume |
| Orchestration | Prefect 2.x weekly flow: ingest→features→train→score | Production MLOps habit — scheduled, retry-able, observable |
| Tracking | MLflow: params/metrics/artifacts across all 4 models | Reproducible experiment comparison |

---

## Setup and How to Run

### 1. Create the environment

```bash
conda env create -f environment.yml
conda activate retail-returns
```

### 2. Get the data

Download UCI Online Retail II from [https://archive.ics.uci.edu/dataset/502/online+retail+ii](https://archive.ics.uci.edu/dataset/502/online+retail+ii) and place the `.xlsx` file in `data/raw/`. The `data/raw/` directory is gitignored.

```
data/raw/online_retail_II.xlsx
```

### 3. Run the notebooks in order

```bash
jupyter notebook
```

| Notebook | Purpose |
|----------|---------|
| `01_eda.ipynb` | Cancellation patterns, customer distributions, return-by-day, missing-value analysis |
| `02_sql_features.ipynb` | DuckDB SQL: CTEs, window functions, RFM aggregations, partial-return detection |
| `03_feature_engineering.ipynb` | Transaction-level + customer-level behavioral features; point-in-time safety |
| `04_classification_model.ipynb` | LightGBM + XGBoost; temporal split; threshold selection; SHAP |
| `05_anomaly_detection.ipynb` | Isolation Forest + LOF; contamination tuning; heuristic validation |
| `06_segmentation.ipynb` | KMeans k=4; elbow + silhouette; segment profiling |
| `07_ab_test_simulation.ipynb` | Power analysis; 14-day policy simulation; two-proportion z-test |
| `08_backtesting.ipynb` | Rolling-window backtest; Brier score; plan vs. actual chart |
| `09_pyspark_pipeline.ipynb` | PySpark medallion pipeline on Databricks Free Edition |
| `10_substitute_recommender.ipynb` | Content embeddings + ALS; hybrid blend; Recall@K, MRR, NDCG@10 |

### 4. Start the API locally

```bash
uvicorn api.main:app --reload
# API: http://localhost:8000
# Interactive docs: http://localhost:8000/docs
```

### 5. Open the frontend

Open `frontend/index.html` in a browser (or VS Code Live Server). Set `API_BASE` in `frontend/app.js` to `http://localhost:8000` for local testing.

### 6. Run the Prefect pipeline locally

```bash
python pipelines/prefect_flow.py
```

### 7. View MLflow runs

```bash
mlflow ui --backend-store-uri mlflow/mlruns
# UI: http://localhost:5000
```

---

## Deployment

### Backend — Render

1. Push the repo to GitHub.
2. On Render: **New + → Blueprint** → connect this repo. Render reads `render.yaml` automatically.
3. Manual fallback: Build `pip install -r requirements.txt`, Start `uvicorn api.main:app --host 0.0.0.0 --port $PORT`, Health check `/health`.

### Frontend — Vercel

1. Import the GitHub repo on Vercel.
2. Set root directory to `frontend/`.
3. No build step — static files only.
4. Update `API_BASE` in `app.js` to your Render URL before pushing.
5. After deploying, update `allow_origins` in `api/main.py` with your Vercel URL and redeploy backend.

### Databricks (PySpark notebook)

Run `notebooks/09_pyspark_pipeline.ipynb` on Databricks Free Edition. The notebook is self-contained — upload the UCI II data to DBFS, run cells in order. Published notebook link: *[add after run]*

---

## Project Structure

```
.
├── environment.yml          ← Local dev (conda, Python 3.11)
├── requirements.txt         ← Deployment deps (pip, Render)
├── runtime.txt              ← Python version pin (Render)
├── render.yaml              ← Render Blueprint manifest
├── .gitignore
│
├── data/
│   └── raw/                 ← gitignored — download from UCI
│       └── online_retail_II.xlsx
│
├── notebooks/               ← Run in order
│   ├── 01_eda.ipynb
│   ├── 02_sql_features.ipynb
│   ├── 03_feature_engineering.ipynb
│   ├── 04_classification_model.ipynb
│   ├── 05_anomaly_detection.ipynb
│   ├── 06_segmentation.ipynb
│   ├── 07_ab_test_simulation.ipynb
│   ├── 08_backtesting.ipynb
│   ├── 09_pyspark_pipeline.ipynb
│   └── 10_substitute_recommender.ipynb
│
├── src/                     ← Shared Python modules
│   ├── features.py          ← Transaction + customer behavioral feature pipeline
│   ├── models.py            ← Train, save, load all four models
│   ├── evaluation.py        ← Backtesting + A/B test utilities
│   └── recommender.py       ← Embedding matrix, ALS, hybrid rank blend
│
├── api/                     ← FastAPI backend → Render
│   ├── main.py              ← Routes: /score, /customer/{id}/profile, /substitutes/{invoice_id}
│   ├── schemas.py           ← Pydantic request/response models
│   └── predictor.py         ← Model loading, inference, SHAP explanations
│
├── frontend/                ← Static site → Vercel
│   ├── index.html
│   ├── style.css
│   └── app.js               ← Customer lookup, risk gauge, segment chip, substitute card
│
├── pipelines/
│   └── prefect_flow.py      ← Prefect 2.x: ingest→features→train→score; weekly schedule
│
├── mlflow/                  ← Local experiment tracking store
│   └── mlruns/              ← Auto-created by MLflow on first run
│
├── dashboards/
│   ├── retail_returns.pbix  ← PowerBI source (committed)
│   └── retail_returns_dashboard.pdf  ← Static export for non-PBI viewers
│
└── models/                  ← gitignored — trained artifacts
    └── .gitkeep
```

---

## References

- Dua, D., & Graff, C. (2019). *UCI Machine Learning Repository — Online Retail II.* UC Irvine. [[link]](https://archive.ics.uci.edu/dataset/502/online+retail+ii)
- Chen, T., & Guestrin, C. (2016). *XGBoost: A Scalable Tree Boosting System.* KDD 2016. [[arXiv]](https://arxiv.org/abs/1603.02754)
- Ke, G., et al. (2017). *LightGBM: A Highly Efficient Gradient Boosting Decision Tree.* NeurIPS 2017.
- Liu, F. T., Ting, K. M., & Zhou, Z.-H. (2008). *Isolation Forest.* ICDM 2008.
- Lundberg, S. M., & Lee, S.-I. (2017). *A Unified Approach to Interpreting Model Predictions.* NeurIPS 2017. [[arXiv]](https://arxiv.org/abs/1705.07874)
- Hu, Y., Koren, Y., & Volinsky, C. (2008). *Collaborative Filtering for Implicit Feedback Datasets.* ICDM 2008.
- National Retail Federation. (2024). *2023 Retail Return Rate Data.*

---

*Built by Alvin Alias · MS Data Science, University of Washington · 2026*
