# Optional Wake Strategies (HF Spaces)

> **Default for this portfolio:** no scheduled wake pings. The frontend warm-up meter handles cold starts honestly after ~48h HF idle sleep.

HF free CPU Basic Spaces sleep after **extended inactivity (~48 hours)**, not after brief idle like Render. Any HTTP request wakes the Space: `/health`, `/docs`, or a visitor opening the demo.

---

## When cold start matters

| Project | Approx. cold wake | Notes |
|---------|-------------------|-------|
| industrial_failure_classification | 30–60 s | Smallest model |
| cmapss_rul | 30–60 s | Single XGBoost artifact |
| retail_returns_intelligence | 45–90 s | LightGBM + SHAP |
| hvac_equipment_health | 45–90 s | LOF + SHAP |
| maintenance_nlp | 60–120+ s | Dual ONNX models; best candidate for selective pre-wake |

---

## Option 1: Do nothing (recommended default)

- Space sleeps after 48h without traffic.
- First visitor (or the frontend `/health` ping on page load) pays wake cost.
- Warm-up meter in the frontend covers the wait.
- **Pros:** zero maintenance, no GitHub Actions minutes, does not consume HF concurrent run slots.
- **Cons:** first hit after long idle is slow.

---

## Option 2: Manual wake before outreach

Before emailing a recruiter or posting a link:

```bash
curl -s https://alvinalias-retail-returns-intelligence.hf.space/health
```

Wait for JSON (`"status":"ok"`). Then send the demo link.

**Pros:** free, precise control, no always-on slot usage between outreach windows.  
**Cons:** you must remember to do it.

---

## Option 3: GitHub Actions `workflow_dispatch` only

Add a workflow with **no cron schedule**, only manual trigger from the Actions tab.

Example (not enabled by default; copy if needed):

```yaml
name: Wake Retail HF Space

on:
  workflow_dispatch:

jobs:
  wake:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS https://alvinalias-retail-returns-intelligence.hf.space/health
```

**Pros:** one-click wake from GitHub before interview week.  
**Cons:** still manual, just from the browser.

---

## Option 4: Scheduled ping (~36–40 hours)

One ping before the 48h sleep window closes. Keeps warm without 12h always-on behavior.

Example cron (once daily at 09:00 UTC):

```yaml
on:
  schedule:
    - cron: "0 9 * * *"
  workflow_dispatch:
```

**Pros:** demo stays warm during active job search with minimal slot pressure.  
**Cons:** uses GitHub Actions minutes; Space stays awake most of the time if daily ping resets the 48h timer.

---

## Option 5: Aggressive ping (every 12 hours)

Resets inactivity timer frequently; Space stays awake continuously.

**Pros:** demo almost always hot.  
**Cons:** uses one of ~8 free concurrent HF CPU slots continuously; unnecessary for portfolio traffic patterns.

Not recommended unless you are in heavy active outreach and accept slot usage.

---

## HF concurrent slot limit (~8)

Free accounts can run roughly **8 CPU-basic Spaces at the same time** while awake. HF does **not** auto-pause another Space to make room. If the limit is hit, a waking Space may fail until you manually pause an unused Space in HF Settings.

**Implication:** avoid scheduled wake pings on all six portfolio Spaces at once. Prefer Option 1 or 2 for most projects; Option 4 only for heavy demos like maintenance_nlp during interview season.

---

## Per-project wake URL pattern

Replace slug for each migrated Space:

```text
https://alvinalias-<space-slug>.hf.space/health
```

| Project | Health URL |
|---------|------------|
| retail_returns_intelligence | `https://alvinalias-retail-returns-intelligence.hf.space/health` |
| cmapss_rul | `https://alvinalias-cmapss-rul-prediction.hf.space/health` |
| hvac_equipment_health | `https://alvinalias-hvac-equipment-health.hf.space/health` |
| industrial_failure_classification | `https://alvinalias-industrial-failure-classification.hf.space/health` |
| maintenance_nlp | `https://alvinalias-maintenance-work-order-nlp.hf.space/health` |
