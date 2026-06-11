// app.js — Retail Returns Intelligence frontend
// Update API_BASE to your Render URL after deployment.

const API_BASE = "https://retail-returns-api.onrender.com";

// Sample customers — one from each segment in the precomputed feature table.
// Used by the "Try a real customer" buttons; keeps the demo usable without
// requiring the visitor to know UCI II CustomerIDs.
const SAMPLE_CUSTOMERS = {
  premium:  { id: "16684.0", invoice: "536365", stock: "85123A", qty: 6,  price: 2.55 },
  healthy:  { id: "16333.0", invoice: "536378", stock: "22423", qty: 4,  price: 12.95 },
  risk:     { id: "15749.0", invoice: "536846", stock: "84879", qty: 8,  price: 1.69 },
  returner: { id: "18102.0", invoice: "537434", stock: "22086", qty: 12, price: 2.95 },
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function show(id)  { document.getElementById(id)?.classList.remove("hidden"); }
function hide(id)  { document.getElementById(id)?.classList.add("hidden"); }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function segmentClass(segment) {
  const map = {
    "Premium Loyal":   "seg-premium-loyal",
    "Healthy Browser": "seg-healthy-browser",
    "At-Risk":         "seg-at-risk",
    "Returner":        "seg-returner",
  };
  return map[segment] || "";
}

function riskClass(tier) {
  return tier.toLowerCase(); // "high" | "medium" | "low"
}

// ---------------------------------------------------------------------------
// Sample customer buttons
// ---------------------------------------------------------------------------

document.querySelectorAll(".btn-sample").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sample = SAMPLE_CUSTOMERS[btn.dataset.sample];
    if (!sample) return;
    document.getElementById("customer-id").value = sample.id;
    document.getElementById("invoice-no").value  = sample.invoice;
    document.getElementById("stock-code").value  = sample.stock;
    document.getElementById("quantity").value    = sample.qty;
    document.getElementById("unit-price").value  = sample.price;
  });
});

// ---------------------------------------------------------------------------
// Score a transaction
// ---------------------------------------------------------------------------

function clearError(rootId) {
  const root = document.getElementById(rootId);
  if (!root) return;
  root.querySelectorAll(".error-msg").forEach((n) => n.remove());
}

async function fetchWithBackendWakeWarning(url, init) {
  // Render free tier sleeps after 15 min — show a friendly banner only when
  // the first request actually stalls (not on every submit).
  const banner = document.getElementById("connection-banner");
  const slowTimer = setTimeout(() => banner?.classList.remove("hidden"), 4000);
  try {
    const resp = await fetch(url, init);
    return resp;
  } finally {
    clearTimeout(slowTimer);
    banner?.classList.add("hidden");
  }
}

document.getElementById("score-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError("score-results");

  const payload = {
    customer_id: document.getElementById("customer-id").value.trim(),
    invoice_no:  document.getElementById("invoice-no").value.trim(),
    stock_code:  document.getElementById("stock-code").value.trim(),
    quantity:    parseFloat(document.getElementById("quantity").value),
    unit_price:  parseFloat(document.getElementById("unit-price").value),
    country:     document.getElementById("country").value.trim() || "United Kingdom",
  };

  const btn = e.target.querySelector("button[type=submit]");
  btn.textContent = "Scoring…";
  btn.disabled = true;
  hide("score-results");
  hide("substitutes-section");

  try {
    const resp = await fetchWithBackendWakeWarning(`${API_BASE}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    renderScoreResults(data);

    // If high risk, also fetch substitute recommendations
    if (data.risk_tier === "High") {
      fetchSubstitutes(payload.invoice_no);
    }
  } catch (err) {
    const friendly = (err.message && /Failed to fetch|NetworkError/i.test(err.message))
      ? "Couldn't reach the API. If this is the first request in a while, the Render backend may be waking up — give it ~30 s and retry."
      : err.message;
    show("score-results");
    clearError("score-results");
    document.getElementById("score-results").querySelector("h2").insertAdjacentHTML(
      "afterend",
      `<p class="error-msg">${friendly}</p>`
    );
  } finally {
    btn.textContent = "Score Transaction";
    btn.disabled = false;
  }
});

function renderScoreResults(data) {
  const probPct = (data.return_probability * 100).toFixed(1) + "%";
  const probEl = document.getElementById("return-prob-value");
  probEl.textContent = probPct;
  probEl.style.color = data.risk_tier === "High" ? "var(--high)"
    : data.risk_tier === "Medium" ? "var(--medium)"
    : "var(--low)";

  const badge = document.getElementById("risk-badge");
  badge.textContent = data.risk_tier + " Risk";
  badge.className = `risk-badge ${riskClass(data.risk_tier)}`;

  const segEl = document.getElementById("segment-value");
  segEl.textContent = data.segment;
  segEl.className = `tile-value segment-chip ${segmentClass(data.segment)}`;

  const anomalyEl = document.getElementById("anomaly-status");
  if (data.anomaly_flag === 1) {
    anomalyEl.textContent = "⚠ Flagged as excessive returner";
    anomalyEl.style.color = "var(--medium)";
  } else {
    anomalyEl.textContent = "No anomaly detected";
    anomalyEl.style.color = "var(--text-muted)";
  }

  renderShapBars(data.top_shap_factors);
  show("score-results");
}

function renderShapBars(factors) {
  const container = document.getElementById("shap-bars");
  container.innerHTML = "";
  if (!factors || factors.length === 0) {
    container.innerHTML = `<p class="loading-msg">SHAP explanations unavailable.</p>`;
    return;
  }
  const maxAbs = Math.max(...factors.map(f => Math.abs(f.value)), 0.001);
  factors.forEach(f => {
    const pct = (Math.abs(f.value) / maxAbs * 100).toFixed(1);
    const cls = f.direction === "increases" ? "positive" : "negative";
    const sign = f.direction === "increases" ? "+" : "−";
    container.insertAdjacentHTML("beforeend", `
      <div class="shap-row">
        <span class="shap-label" title="${f.feature}">${f.feature}</span>
        <div class="shap-bar-track">
          <div class="shap-bar-fill ${cls}" style="width:${pct}%"></div>
        </div>
        <span class="shap-val">${sign}${Math.abs(f.value).toFixed(3)}</span>
      </div>
    `);
  });
}

// ---------------------------------------------------------------------------
// Substitute recommendations
// ---------------------------------------------------------------------------

async function fetchSubstitutes(invoiceNo) {
  try {
    const resp = await fetch(`${API_BASE}/substitutes/${encodeURIComponent(invoiceNo)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    renderSubstitutes(data);
  } catch (_) {
    // Recommender may not be trained yet — silent fail
  }
}

function renderSubstitutes(data) {
  const container = document.getElementById("substitutes-grid");
  container.innerHTML = "";

  if (!data.substitutes || data.substitutes.length === 0) {
    container.innerHTML = `<p class="loading-msg">No substitutes available yet — recommender model pending training.</p>`;
    show("substitutes-section");
    return;
  }

  data.substitutes.forEach((sub, i) => {
    const returnWarn = sub.in_customer_return_history
      ? `<p class="sub-return-warning">⚠ Customer has returned this item before</p>`
      : "";
    container.insertAdjacentHTML("beforeend", `
      <div class="substitute-card">
        <div class="sub-rank">#${i + 1}</div>
        <div class="sub-info">
          <div class="sub-code">${sub.stock_code}</div>
          <div class="sub-desc">${sub.description}</div>
          <div class="sub-rationale">${sub.rationale}</div>
          ${returnWarn}
        </div>
        <div class="sub-sim">Similarity: ${(sub.content_similarity * 100).toFixed(0)}%</div>
      </div>
    `);
  });

  show("substitutes-section");
}

// ---------------------------------------------------------------------------
// Customer profile lookup
// ---------------------------------------------------------------------------

document.getElementById("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cid = document.getElementById("profile-customer-id").value.trim();
  if (!cid) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.textContent = "Loading…";
  btn.disabled = true;
  hide("profile-results");

  try {
    const resp = await fetch(`${API_BASE}/customer/${encodeURIComponent(cid)}/profile`);
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    renderProfile(data);
  } catch (err) {
    show("profile-results");
    document.getElementById("profile-grid").innerHTML =
      `<p class="error-msg">Error: ${err.message}</p>`;
  } finally {
    btn.textContent = "Look Up";
    btn.disabled = false;
  }
});

function renderProfile(data) {
  const grid = document.getElementById("profile-grid");
  const stats = [
    { label: "Segment",          value: data.segment },
    { label: "Anomaly Flag",     value: data.anomaly_flag === 1 ? "⚠ Flagged" : "Clean" },
    { label: "Return Rate",      value: (data.lifetime_return_rate * 100).toFixed(1) + "%" },
    { label: "Return Value Ratio", value: (data.return_value_ratio * 100).toFixed(1) + "%" },
    { label: "Return Velocity",  value: data.return_velocity + " (30d)" },
    { label: "Tenure",           value: data.tenure_days + " days" },
    { label: "Recency",          value: data.recency_score + " days ago" },
    { label: "Orders",           value: data.frequency_score },
    { label: "Lifetime Value",   value: "£" + data.monetary_score.toFixed(2) },
  ];

  grid.innerHTML = stats.map(s => `
    <div class="profile-stat">
      <div class="profile-stat-label">${s.label}</div>
      <div class="profile-stat-value">${s.value}</div>
    </div>
  `).join("");

  show("profile-results");
}
