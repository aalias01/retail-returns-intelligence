// ============================================================
// app.js — Retail Returns Intelligence frontend
// API wiring (endpoints, payload, response shape) is unchanged from v1.
// Everything else is presentation polish.
// ============================================================

const API_BASE = "https://retail-returns-api.onrender.com";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Sample customers — one per segment in the precomputed feature table.
const SAMPLE_CUSTOMERS = {
  premium:  { id: "16684.0", invoice: "536365", stock: "85123A", qty: 6,  price: 2.55 },
  healthy:  { id: "16333.0", invoice: "536378", stock: "22423",  qty: 4,  price: 12.95 },
  risk:     { id: "15749.0", invoice: "536846", stock: "84879",  qty: 8,  price: 1.69 },
  returner: { id: "18102.0", invoice: "537434", stock: "22086",  qty: 12, price: 2.95 },
};

// ── Utilities ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
function show(el) { (typeof el === "string" ? $(el) : el)?.classList.remove("hidden"); }
function hide(el) { (typeof el === "string" ? $(el) : el)?.classList.add("hidden"); }
function reveal(el) { const n = typeof el === "string" ? $(el) : el; if (n) { n.classList.remove("hidden"); n.classList.add("is-visible"); } }

function segmentClass(segment) {
  return {
    "Premium Loyal":   "seg-premium-loyal",
    "Healthy Browser": "seg-healthy-browser",
    "At-Risk":         "seg-at-risk",
    "Returner":        "seg-returner",
  }[segment] || "";
}
function riskClass(tier) { return (tier || "").toLowerCase(); }
function riskVar(tier) {
  return tier === "High" ? "var(--high)" : tier === "Medium" ? "var(--medium)" : "var(--low)";
}

// ── Sticky nav state ──────────────────────────────────────
const topnav = $("topnav");
const onScroll = () => topnav.classList.toggle("scrolled", window.scrollY > 12);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// ── Scroll-reveal ─────────────────────────────────────────
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
  });
}, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

// ── Hero metric count-up ──────────────────────────────────
function countUp(el) {
  const target = parseFloat(el.dataset.count);
  const decimals = parseInt(el.dataset.decimals || "0", 10);
  const suffix = el.dataset.suffix || "";
  if (REDUCED_MOTION) { el.textContent = target.toFixed(decimals) + suffix; return; }
  const dur = 1200, t0 = performance.now();
  const tick = (now) => {
    const p = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * eased).toFixed(decimals) + suffix;
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = target.toFixed(decimals) + suffix;
  };
  requestAnimationFrame(tick);
}
document.querySelectorAll(".meta-num").forEach((el, i) => setTimeout(() => countUp(el), 250 + i * 120));

// ── API health warm-up ping (also wakes the Render dyno) ──
async function pingHealth() {
  const wrap = $("api-status"), txt = $("api-status-text");
  if (!wrap) return;
  wrap.classList.add("waking");
  txt.textContent = "Waking the API…";
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 35000);
  try {
    const r = await fetch(`${API_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(to);
    const data = await r.json().catch(() => ({}));
    wrap.classList.remove("waking");
    if (r.ok && data.models_loaded) {
      wrap.classList.add("online");
      txt.textContent = "API online · models loaded";
    } else if (r.ok) {
      wrap.classList.add("online");
      txt.textContent = "API online";
    } else {
      wrap.classList.add("offline");
      txt.textContent = "API reachable · degraded";
    }
  } catch (_) {
    clearTimeout(to);
    wrap.classList.remove("waking");
    wrap.classList.add("offline");
    txt.textContent = "API asleep — your first score will wake it (~30 s)";
  }
}
pingHealth();

// ── Sample customer buttons ───────────────────────────────
document.querySelectorAll(".btn-sample").forEach((btn) => {
  btn.addEventListener("click", () => {
    const s = SAMPLE_CUSTOMERS[btn.dataset.sample];
    if (!s) return;
    $("customer-id").value = s.id;
    $("invoice-no").value  = s.invoice;
    $("stock-code").value  = s.stock;
    $("quantity").value    = s.qty;
    $("unit-price").value  = s.price;
    document.querySelectorAll(".btn-sample").forEach((b) => b.style.borderColor = "");
    btn.style.borderColor = "var(--brand)";
  });
});

// ── Backend wake banner helper ────────────────────────────
async function fetchWithBackendWakeWarning(url, init) {
  const banner = $("connection-banner");
  const slowTimer = setTimeout(() => banner?.classList.remove("hidden"), 4000);
  try {
    return await fetch(url, init);
  } finally {
    clearTimeout(slowTimer);
    banner?.classList.add("hidden");
  }
}

function showResultsError(msg) {
  hide("results-body");
  const empty = $("results-empty");
  show(empty);
  empty.innerHTML =
    `<div class="empty-ring" style="border-color:rgba(239,68,68,0.5)"></div>` +
    `<p style="color:var(--high);max-width:30ch">${msg}</p>`;
}

// ── Score a transaction ───────────────────────────────────
$("score-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    customer_id: $("customer-id").value.trim(),
    invoice_no:  $("invoice-no").value.trim(),
    stock_code:  $("stock-code").value.trim(),
    quantity:    parseFloat($("quantity").value),
    unit_price:  parseFloat($("unit-price").value),
    country:     $("country").value.trim() || "United Kingdom",
  };

  const btn = e.target.querySelector("button[type=submit]");
  btn.textContent = "Scoring…";
  btn.disabled = true;
  hide("substitutes-section");

  try {
    const resp = await fetchWithBackendWakeWarning(`${API_BASE}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    renderScoreResults(data);
    if (data.risk_tier === "High") fetchSubstitutes(payload.invoice_no);
  } catch (err) {
    const friendly = (err.message && /Failed to fetch|NetworkError|aborted/i.test(err.message))
      ? "Couldn't reach the API. The Render backend may be waking up — give it ~30 s and retry."
      : err.message;
    showResultsError(friendly);
  } finally {
    btn.textContent = "Score Transaction";
    btn.disabled = false;
  }
});

function renderScoreResults(data) {
  hide("results-empty");
  show("results-body");
  const errEl = $("results-body").querySelector(".error-msg");
  if (errEl) errEl.remove();

  // Probability + gauge
  const p = data.return_probability;
  const probEl = $("return-prob-value");
  probEl.textContent = (p * 100).toFixed(1) + "%";
  probEl.style.color = riskVar(data.risk_tier);

  const arc = $("gauge-arc");
  const len = arc.getTotalLength ? arc.getTotalLength() : 251.3;
  arc.style.strokeDasharray = len;
  arc.style.stroke = riskVar(data.risk_tier);
  // start empty, then animate to fill = p
  arc.style.strokeDashoffset = len;
  requestAnimationFrame(() => {
    arc.style.strokeDashoffset = REDUCED_MOTION ? len * (1 - p) : len * (1 - p);
  });

  const badge = $("risk-badge");
  badge.textContent = data.risk_tier + " Risk";
  badge.className = `risk-badge ${riskClass(data.risk_tier)}`;

  // Segment + anomaly
  const segEl = $("segment-value");
  segEl.textContent = data.segment;
  segEl.className = `segment-chip ${segmentClass(data.segment)}`;

  const anomalyEl = $("anomaly-status");
  if (data.anomaly_flag === 1) {
    anomalyEl.innerHTML = "⚠ Flagged as excessive returner";
    anomalyEl.style.color = "var(--medium)";
  } else {
    anomalyEl.textContent = "No anomaly detected";
    anomalyEl.style.color = "var(--text-mut)";
  }

  renderShapBars(data.top_shap_factors);
}

function renderShapBars(factors) {
  const container = $("shap-bars");
  container.innerHTML = "";
  if (!factors || factors.length === 0) {
    container.innerHTML = `<p class="loading-msg" style="color:var(--text-dim);font-size:0.85rem;">SHAP explanations unavailable.</p>`;
    return;
  }
  const maxAbs = Math.max(...factors.map((f) => Math.abs(f.value)), 0.001);
  factors.forEach((f, i) => {
    const pct = (Math.abs(f.value) / maxAbs * 100).toFixed(1);
    const cls = f.direction === "increases" ? "positive" : "negative";
    const sign = f.direction === "increases" ? "+" : "−";
    container.insertAdjacentHTML("beforeend", `
      <div class="shap-row">
        <span class="shap-label" title="${f.feature}">${f.feature}</span>
        <div class="shap-bar-track"><div class="shap-bar-fill ${cls}" data-w="${pct}"></div></div>
        <span class="shap-val">${sign}${Math.abs(f.value).toFixed(3)}</span>
      </div>`);
  });
  // animate widths after paint
  requestAnimationFrame(() => {
    container.querySelectorAll(".shap-bar-fill").forEach((el) => {
      el.style.width = (REDUCED_MOTION ? el.dataset.w : el.dataset.w) + "%";
    });
  });
}

// ── Substitute recommendations ────────────────────────────
async function fetchSubstitutes(invoiceNo) {
  try {
    const resp = await fetch(`${API_BASE}/substitutes/${encodeURIComponent(invoiceNo)}`);
    if (!resp.ok) return;
    renderSubstitutes(await resp.json());
  } catch (_) { /* recommender may be offline-only in v1 — silent */ }
}

function renderSubstitutes(data) {
  const container = $("substitutes-grid");
  container.innerHTML = "";
  if (!data.substitutes || data.substitutes.length === 0) {
    container.innerHTML = `<p class="loading-msg" style="color:var(--text-dim);font-size:0.88rem;">No substitutes available yet — recommender is offline-only in v1.</p>`;
    reveal("substitutes-section");
    return;
  }
  data.substitutes.forEach((sub, i) => {
    const warn = sub.in_customer_return_history
      ? `<p class="sub-return-warning">⚠ Customer has returned this item before</p>` : "";
    container.insertAdjacentHTML("beforeend", `
      <div class="substitute-card">
        <div class="sub-rank">#${i + 1}</div>
        <div class="sub-info">
          <div class="sub-code">${sub.stock_code}</div>
          <div class="sub-desc">${sub.description}</div>
          <div class="sub-rationale">${sub.rationale}</div>
          ${warn}
        </div>
        <div class="sub-sim">sim ${(sub.content_similarity * 100).toFixed(0)}%</div>
      </div>`);
  });
  reveal("substitutes-section");
}

// ── Customer profile lookup ───────────────────────────────
$("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cid = $("profile-customer-id").value.trim();
  if (!cid) return;

  const btn = e.target.querySelector("button[type=submit]");
  btn.textContent = "Loading…";
  btn.disabled = true;

  try {
    const resp = await fetchWithBackendWakeWarning(`${API_BASE}/customer/${encodeURIComponent(cid)}/profile`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    renderProfile(await resp.json());
  } catch (err) {
    const grid = $("profile-grid");
    reveal(grid);
    grid.style.gridTemplateColumns = "1fr";
    grid.innerHTML = `<p class="error-msg" style="color:var(--high);font-size:0.9rem;">Error: ${err.message}</p>`;
  } finally {
    btn.textContent = "Look up";
    btn.disabled = false;
  }
});

function renderProfile(data) {
  const grid = $("profile-grid");
  grid.style.gridTemplateColumns = "";
  const stats = [
    { label: "Segment",            value: data.segment },
    { label: "Anomaly Flag",       value: data.anomaly_flag === 1 ? "⚠ Flagged" : "Clean" },
    { label: "Return Rate",        value: (data.lifetime_return_rate * 100).toFixed(1) + "%" },
    { label: "Return Value Ratio", value: (data.return_value_ratio * 100).toFixed(1) + "%" },
    { label: "Return Velocity",    value: data.return_velocity + " (30d)" },
    { label: "Tenure",             value: data.tenure_days + " days" },
    { label: "Recency",            value: data.recency_score + " days ago" },
    { label: "Orders",             value: data.frequency_score },
    { label: "Lifetime Value",     value: "£" + data.monetary_score.toFixed(2) },
  ];
  grid.innerHTML = stats.map((s) => `
    <div class="profile-stat">
      <div class="profile-stat-label">${s.label}</div>
      <div class="profile-stat-value">${s.value}</div>
    </div>`).join("");
  reveal(grid);
}
