const API_BASE = "https://retail-returns-api.onrender.com";
const WARMUP_LIMIT_SECONDS = 60;
const WARMUP_GRACE_MS = 2500;
const WARMUP_RETIRE_MS = 4000;
const WARMUP_STRINGS = {
  wake: "> server was asleep · sent the wake call",
  estimate: "> warm-up estimate counting · this is an estimate, not progress",
  estimateLabel: "estimated seconds to warm",
  ready: "ready",
  measured: (seconds) => `> awake · measured wake time ${seconds} s`,
  overrunLabel: "seconds elapsed · still starting",
  overrun: "> past the usual window · still waiting, counting up honestly",
};
const LOCAL_WARMUP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const SAMPLE_CUSTOMERS = {
  note: "Copied from retail frontend app.js SAMPLE_CUSTOMERS, one per real KMeans segment. No transaction-level ground truth exists; the cross-check is GET /customer/{id}/profile.",
  customers: {
    premium: {
      id: "16684.0",
      invoice: "536365",
      stock: "85123A",
      qty: 6,
      price: 2.55,
      segment_label: "Premium loyal",
    },
    healthy: {
      id: "16333.0",
      invoice: "536378",
      stock: "22423",
      qty: 4,
      price: 12.95,
      segment_label: "Healthy browser",
    },
    risk: {
      id: "15749.0",
      invoice: "536846",
      stock: "84879",
      qty: 8,
      price: 1.69,
      segment_label: "At risk",
    },
    returner: {
      id: "18102.0",
      invoice: "537434",
      stock: "22086",
      qty: 12,
      price: 2.95,
      segment_label: "Returner",
    },
  },
};

const sampleOrder = ["premium", "healthy", "risk", "returner"];
let nextSampleIndex = 0;
let riskTiers = null;
let healthWarmMeter = null;
let scoreWarmMeter = null;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  || (
    LOCAL_WARMUP_HOSTS.has(window.location.hostname)
    && new URLSearchParams(window.location.search).get("motion") === "reduce"
  );
const $ = (id) => document.getElementById(id);

function show(id) {
  $(id)?.classList.remove("hidden");
}

function hide(id) {
  $(id)?.classList.add("hidden");
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(2);
}

function formatWakeSeconds(ms) {
  const seconds = ms / 1000;
  if (seconds < 10) return seconds.toFixed(2);
  if (seconds < 60) return seconds.toFixed(1).replace(/\.0$/, "");
  return String(Math.round(seconds));
}

function isLocalWarmupStub() {
  return LOCAL_WARMUP_HOSTS.has(window.location.hostname);
}

function detailText(detail) {
  if (Array.isArray(detail)) return JSON.stringify(detail);
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return String(detail || "HTTP error");
}

function ensureWarmScale(element) {
  const scale = element.querySelector("[data-warm-scale]");
  if (!scale || scale.querySelector("svg")) return;

  const width = 360;
  const x0 = 12;
  const x1 = 348;
  const y = 34;
  const toX = (seconds) => x0 + (x1 - x0) * (seconds / WARMUP_LIMIT_SECONDS);
  const minor = Array.from({ length: 13 }, (_, index) => index * 5);
  const major = [0, 15, 30, 45, 60];

  const ticks = minor.map((seconds) => {
    const isMajor = major.includes(seconds);
    const tickY = isMajor ? y + 12 : y + 7;
    return `<line class="warm-scale-tick" x1="${toX(seconds)}" y1="${y}" x2="${toX(seconds)}" y2="${tickY}"></line>`;
  }).join("");

  const labels = major.map((seconds) => (
    `<text class="warm-scale-number" x="${toX(seconds)}" y="${y + 29}" text-anchor="middle">${seconds}</text>`
  )).join("");

  scale.innerHTML = `
    <svg class="warm-scale" viewBox="0 0 ${width} 76" role="img" aria-label="Warm-up estimate from 0 to 60 seconds">
      <line class="warm-scale-base" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"></line>
      ${ticks}
      ${labels}
      <path class="warm-scale-marker" data-warm-marker d="M ${x0} ${y - 3} l -6 -11 h 12 z"></path>
    </svg>
  `;
}

function renderWarmMeter(element, displaySeconds, label, markerSeconds = displaySeconds, overrun = false) {
  ensureWarmScale(element);
  const number = element.querySelector("[data-warm-number]");
  const labelNode = element.querySelector("[data-warm-label]");
  const marker = element.querySelector("[data-warm-marker]");
  const svg = element.querySelector(".warm-scale");
  const x0 = 12;
  const x1 = 348;
  const clampedMarker = Math.max(0, Math.min(WARMUP_LIMIT_SECONDS, markerSeconds));
  const markerX = x0 + (x1 - x0) * (clampedMarker / WARMUP_LIMIT_SECONDS);

  if (number) number.textContent = String(Math.max(0, Math.round(displaySeconds)));
  if (labelNode) labelNode.textContent = label;
  if (marker) {
    marker.style.transform = `translateX(${markerX - x0}px)`;
    marker.classList.toggle("is-overrun", overrun);
  }
  if (svg) {
    svg.setAttribute("aria-label", `${label}, ${Math.max(0, Math.round(displaySeconds))} seconds`);
  }
}

function createWarmMeter(element) {
  let startedAt = 0;
  let visible = false;
  let complete = false;
  let overrunLogged = false;
  let tickTimer = null;
  let graceTimer = null;
  let retireTimer = null;
  let retireDelayTimer = null;
  let emitLine = () => {};
  let interactionHandler = null;

  function writeMeterLog(lines) {
    const log = element.querySelector("[data-warm-log]");
    if (log) log.textContent = Array.isArray(lines) ? lines.join("\n") : lines;
  }

  function clearRetireHooks() {
    clearTimeout(retireTimer);
    clearTimeout(retireDelayTimer);
    retireTimer = null;
    retireDelayTimer = null;
    if (interactionHandler) {
      window.removeEventListener("pointerdown", interactionHandler);
      window.removeEventListener("keydown", interactionHandler);
      interactionHandler = null;
    }
  }

  function hideMeter() {
    clearRetireHooks();
    element.classList.add("hidden");
    element.classList.remove("is-retiring", "is-overrun");
    visible = false;
  }

  function reset() {
    clearTimeout(graceTimer);
    clearInterval(tickTimer);
    graceTimer = null;
    tickTimer = null;
    complete = false;
    overrunLogged = false;
    hideMeter();
  }

  function emit(text) {
    if (typeof emitLine === "function") emitLine(text);
  }

  function renderTick() {
    const elapsedSeconds = Math.floor((performance.now() - startedAt) / 1000);
    if (elapsedSeconds >= WARMUP_LIMIT_SECONDS) {
      element.classList.add("is-overrun");
      renderWarmMeter(element, elapsedSeconds, WARMUP_STRINGS.overrunLabel, 0, true);
      writeMeterLog(WARMUP_STRINGS.overrun);
      if (!overrunLogged) {
        overrunLogged = true;
      }
      return;
    }

    const remaining = WARMUP_LIMIT_SECONDS - elapsedSeconds;
    element.classList.remove("is-overrun");
    renderWarmMeter(element, remaining, WARMUP_STRINGS.estimateLabel, remaining, false);
    writeMeterLog([WARMUP_STRINGS.wake, WARMUP_STRINGS.estimate]);
  }

  function reveal() {
    if (complete || visible) return;
    visible = true;
    element.classList.remove("hidden", "is-retiring", "is-overrun");
    renderTick();
    tickTimer = setInterval(renderTick, 1000);
  }

  function retire() {
    clearRetireHooks();
    if (reducedMotion) {
      hideMeter();
      return;
    }
    element.classList.add("is-retiring");
    retireDelayTimer = setTimeout(hideMeter, 360);
  }

  function scheduleRetire() {
    clearRetireHooks();
    if (reducedMotion) {
      hideMeter();
      return;
    }
    interactionHandler = retire;
    window.addEventListener("pointerdown", interactionHandler, { once: true });
    window.addEventListener("keydown", interactionHandler, { once: true });
    retireTimer = setTimeout(retire, WARMUP_RETIRE_MS);
  }

  function start(options = {}) {
    reset();
    startedAt = options.startedAt || performance.now();
    emitLine = typeof options.emitLine === "function" ? options.emitLine : () => {};
    const elapsedBeforeStart = Math.max(0, performance.now() - startedAt);
    graceTimer = setTimeout(reveal, Math.max(0, WARMUP_GRACE_MS - elapsedBeforeStart));
  }

  function markReady(responseAt = performance.now()) {
    complete = true;
    clearTimeout(graceTimer);
    clearInterval(tickTimer);
    graceTimer = null;
    tickTimer = null;
    if (!visible) {
      hideMeter();
      return;
    }

    const measuredLine = WARMUP_STRINGS.measured(formatWakeSeconds(responseAt - startedAt));
    element.classList.remove("is-overrun");
    renderWarmMeter(element, 0, WARMUP_STRINGS.ready, 0, false);
    writeMeterLog(measuredLine);
    emit(measuredLine);
    scheduleRetire();
  }

  function snapshot({ displaySeconds, label, markerSeconds, overrun, lines }, options = {}) {
    reset();
    emitLine = typeof options.emitLine === "function" ? options.emitLine : () => {};
    visible = true;
    element.classList.remove("hidden", "is-retiring");
    element.classList.toggle("is-overrun", Boolean(overrun));
    renderWarmMeter(element, displaySeconds, label, markerSeconds, Boolean(overrun));
    writeMeterLog(lines);
    if (options.emit) {
      const logLines = Array.isArray(lines) ? lines : [lines];
      logLines.forEach((line) => emit(line));
    }
  }

  return {
    start,
    markReady,
    cancel: reset,
    snapshot,
  };
}

function setTheme(theme) {
  const next = theme === "night" ? "night" : "day";
  const mode = next === "night" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  document.cookie = `mode=${encodeURIComponent(mode)}; Domain=.alvinalias.com; Path=/; Max-Age=31536000; SameSite=Lax`;
  try { localStorage.setItem("mode", mode); } catch (error) {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "night" ? "#201f1c" : "#f5f4ef");
  const toggle = $("mode-toggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", next === "night" ? "true" : "false");
    toggle.setAttribute("aria-label", next === "night" ? "Switch to light mode" : "Switch to dark mode");
  }
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "night" ? "night" : "day";
}

$("mode-toggle")?.addEventListener("click", () => {
  setTheme(currentTheme() === "night" ? "day" : "night");
});
setTheme(currentTheme());

function renderScale(value = null) {
  const width = 720;
  const x0 = 42;
  const x1 = 678;
  const y = 62;
  const toX = (v) => x0 + (x1 - x0) * v;
  const major = [0, 0.25, 0.5, 0.75, 1];
  const minor = Array.from({ length: 21 }, (_, i) => i / 20);
  const markerX = value === null ? toX(0) : toX(Math.max(0, Math.min(1, value)));
  const high = riskTiers && typeof riskTiers.high === "number" ? riskTiers.high : null;

  const ticks = minor.map((v) => {
    const isMajor = major.includes(v);
    const tickY = isMajor ? y + 13 : y + 8;
    return `<line class="scale-tick" x1="${toX(v)}" y1="${y}" x2="${toX(v)}" y2="${tickY}"></line>`;
  }).join("");

  const labels = major.map((v) => (
    `<text class="scale-number" x="${toX(v)}" y="${y + 31}" text-anchor="middle">${v.toFixed(v === 0 || v === 1 ? 0 : 2)}</text>`
  )).join("");

  const limit = high === null ? "" : `
    <line class="scale-limit" x1="${toX(high)}" y1="${y - 28}" x2="${toX(high)}" y2="${y + 16}"></line>
    <text class="scale-label" x="${toX(high)}" y="${y - 34}" text-anchor="middle">high tier</text>
  `;

  const marker = value === null ? "" : `
    <path class="scale-marker" d="M ${markerX} ${y - 18} l -8 -12 h 16 z"></path>
  `;

  $("scale-wrap").innerHTML = `
    <svg class="risk-scale" viewBox="0 0 ${width} 132" role="img" aria-label="Return probability from 0 to 1">
      <line class="scale-base" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"></line>
      ${ticks}
      ${labels}
      ${limit}
      ${marker}
    </svg>
  `;
}

renderScale();

healthWarmMeter = createWarmMeter($("health-warm-meter"));
scoreWarmMeter = createWarmMeter($("score-warm-meter"));

async function pingHealth() {
  const status = $("status-line");
  const startedAt = performance.now();
  status.textContent = "server waking, first score can take a minute";
  healthWarmMeter.start({ startedAt });
  try {
    const response = await fetch(`${API_BASE}/health`);
    const responseAt = performance.now();
    if (response.ok) healthWarmMeter.markReady(responseAt);
    const data = await response.json().catch(() => ({}));
    if (data && data.risk_tiers) {
      riskTiers = data.risk_tiers;
      renderScale();
    }
    if (response.ok && data.models_loaded) {
      status.textContent = "models loaded";
    } else {
      status.textContent = "server waking, first score can take a minute";
    }
  } catch (error) {
    healthWarmMeter.cancel();
    status.textContent = "server unreachable right now";
  }
}

function runWarmupStub() {
  if (!isLocalWarmupStub()) return false;

  const mode = new URLSearchParams(window.location.search).get("warmup");
  if (!mode) return false;

  const useScoreMeter = mode.startsWith("score-");
  const meter = useScoreMeter ? scoreWarmMeter : healthWarmMeter;
  const emitLine = useScoreMeter ? logLine : () => {};

  $("status-line").textContent = useScoreMeter ? "models loaded" : "server waking, first score can take a minute";

  if (mode.endsWith("-warm")) {
    meter.start({ startedAt: performance.now(), emitLine });
    setTimeout(() => meter.markReady(performance.now()), 50);
    return true;
  }

  if (mode.endsWith("-reduced-ready")) {
    meter.start({ startedAt: performance.now() - 3000, emitLine });
    setTimeout(() => meter.markReady(performance.now()), 50);
    return true;
  }

  if (mode.endsWith("-counting")) {
    meter.snapshot({
      displaySeconds: 38,
      label: WARMUP_STRINGS.estimateLabel,
      markerSeconds: 38,
      overrun: false,
      lines: [WARMUP_STRINGS.wake, WARMUP_STRINGS.estimate],
    }, { emitLine });
    return true;
  }

  if (mode.endsWith("-ready")) {
    meter.snapshot({
      displaySeconds: 0,
      label: WARMUP_STRINGS.ready,
      markerSeconds: 0,
      overrun: false,
      lines: WARMUP_STRINGS.measured("14"),
    }, { emitLine, emit: useScoreMeter });
    return true;
  }

  if (mode.endsWith("-overrun")) {
    meter.snapshot({
      displaySeconds: 73,
      label: WARMUP_STRINGS.overrunLabel,
      markerSeconds: 0,
      overrun: true,
      lines: WARMUP_STRINGS.overrun,
    }, { emitLine });
    return true;
  }

  return false;
}

if (!runWarmupStub()) {
  pingHealth();
}

function setLedger(sampleKey) {
  const sample = SAMPLE_CUSTOMERS.customers[sampleKey];
  if (!sample) return null;
  $("customer-id").value = sample.id;
  $("invoice-no").value = sample.invoice;
  $("stock-code").value = sample.stock;
  $("quantity").value = sample.qty;
  $("unit-price").value = sample.price;
  $("country").value = "United Kingdom";

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", chip.dataset.sample === sampleKey ? "true" : "false");
  });
  return sample;
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.setAttribute("aria-pressed", "false");
  chip.addEventListener("click", () => setLedger(chip.dataset.sample));
});
setLedger("premium");

function logLine(text) {
  const item = document.createElement("li");
  item.textContent = text;
  $("run-log").appendChild(item);
}

function clearRunState(options = {}) {
  if (!options.keepLog) {
    $("run-log").innerHTML = "";
  }
  scoreWarmMeter.cancel();
  hide("error-box");
  hide("deflection-section");
  hide("substitutes-section");
  hide("anomaly-line");
  $("error-message").textContent = "";
  $("error-detail").textContent = "";
}

function payloadFromLedger() {
  return {
    customer_id: $("customer-id").value.trim(),
    invoice_no: $("invoice-no").value.trim(),
    stock_code: $("stock-code").value.trim(),
    quantity: Number.parseFloat($("quantity").value),
    unit_price: Number.parseFloat($("unit-price").value),
    country: $("country").value.trim() || "United Kingdom",
  };
}

function showScoreError(message, rawDetail = "") {
  $("error-message").textContent = message;
  $("error-detail").textContent = rawDetail;
  show("error-box");
}

async function scorePayload(payload, onResponse) {
  const started = performance.now();
  const response = await fetch(`${API_BASE}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const responseAt = performance.now();
  if (typeof onResponse === "function") onResponse(responseAt);
  const elapsed = responseAt - started;
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const detail = detailText(errorBody.detail || `HTTP ${response.status}`);
    const error = new Error(detail);
    error.rawDetail = detail;
    throw error;
  }
  const data = await response.json();
  data._elapsed = elapsed;
  return data;
}

async function runScore(options = {}) {
  const payload = payloadFromLedger();
  clearRunState({ keepLog: options.keepLog });
  const startedAt = performance.now();
  scoreWarmMeter.start({ startedAt, emitLine: logLine });
  $("known-run").disabled = true;
  $("manual-run").disabled = true;

  try {
    const score = await scorePayload(payload, (responseAt) => scoreWarmMeter.markReady(responseAt));
    logLine(`> scored in ${formatSeconds(score._elapsed)} s`);
    renderScore(score);
    logLine("> pulling this customer's history");
    await fetchAndRenderProfile(payload.customer_id, true);
    if (score.risk_tier === "High") {
      await fetchSubstitutes(payload.invoice_no);
    }
  } catch (error) {
    scoreWarmMeter.cancel();
    const network = error instanceof TypeError || /fetch|network|aborted/i.test(error.message);
    if (network) {
      showScoreError(
        "This runs on a free tier that sleeps between visitors. First start takes 30 to 60 seconds; runs after that are quick.",
        "Try again in a moment.",
      );
    } else {
      showScoreError(`Could not score this transaction. ${error.message}`, error.rawDetail || error.message);
    }
  } finally {
    $("known-run").disabled = false;
    $("manual-run").disabled = false;
  }
}

$("known-run").addEventListener("click", async () => {
  const key = sampleOrder[nextSampleIndex];
  nextSampleIndex = (nextSampleIndex + 1) % sampleOrder.length;
  const sample = setLedger(key);
  clearRunState();
  logLine(`> customer ${sample.id} · ${sample.segment_label} sample loaded`);
  await runScore({ keepLog: true });
});

$("score-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runScore();
});

function renderScore(data) {
  const probability = Number(data.return_probability || 0);
  $("return-probability").textContent = `${(probability * 100).toFixed(1)}%`;
  $("tier-line").textContent = `${data.risk_tier} risk · ${data.segment} segment`;
  if (data.anomaly_flag === 1) {
    show("anomaly-line");
  } else {
    hide("anomaly-line");
  }
  renderScale(probability);
  renderDeflection(data.top_shap_factors || []);
}

const featureGloss = {
  quantity_z: "quantity vs this customer's norm",
  category_return_rate: "how often this category comes back",
  monetary_score: "lifetime value",
  lifetime_return_rate: "lifetime return rate",
};

function featureLabel(feature) {
  return featureGloss[feature] || feature.replaceAll("_", " ");
}

function renderDeflection(factors) {
  const table = $("deflection-table");
  table.innerHTML = "";
  if (!factors.length) return;
  const maxAbs = Math.max(...factors.map((factor) => Math.abs(Number(factor.value))), 0.001);

  factors.forEach((factor) => {
    const value = Number(factor.value);
    const row = document.createElement("div");
    row.className = "deflection-row";

    const name = document.createElement("span");
    name.className = "deflection-name";
    name.textContent = featureLabel(factor.feature);
    name.title = `API field: top_shap_factors.${factor.feature}`;

    const track = document.createElement("span");
    track.className = "deflection-track";
    const bar = document.createElement("span");
    bar.className = `deflection-bar ${value >= 0 ? "positive" : "negative"}`;
    bar.style.width = reducedMotion ? `${Math.min(Math.abs(value) / maxAbs * 50, 50)}%` : "0%";
    track.appendChild(bar);

    const val = document.createElement("span");
    val.className = "deflection-value";
    val.textContent = `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;

    row.append(name, track, val);
    table.appendChild(row);
    if (!reducedMotion) {
      requestAnimationFrame(() => {
        bar.style.width = `${Math.min(Math.abs(value) / maxAbs * 50, 50)}%`;
      });
    }
  });
  show("deflection-section");
}

function renderHistory(profile) {
  hide("history-error");
  $("anomaly-score-line").textContent = `anomaly score ${Number(profile.anomaly_score || 0).toFixed(4)}`;
  const fields = [
    ["Lifetime return rate", `${(Number(profile.lifetime_return_rate || 0) * 100).toFixed(1)}%`],
    ["Orders", Number(profile.frequency_score || 0).toLocaleString()],
    ["Tenure", `${Number(profile.tenure_days || 0).toLocaleString()} days`],
    ["Returns in the last 30 days", Number(profile.return_velocity || 0).toLocaleString()],
    ["Lifetime value", `£${Number(profile.monetary_score || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`],
  ];
  $("history-grid").innerHTML = fields.map(([label, value]) => `
    <div class="history-cell">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");
}

async function fetchProfile(customerId) {
  const response = await fetch(`${API_BASE}/customer/${encodeURIComponent(customerId)}/profile`);
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(detailText(errorBody.detail || `HTTP ${response.status}`));
  }
  return response.json();
}

async function fetchAndRenderProfile(customerId) {
  try {
    const profile = await fetchProfile(customerId);
    renderHistory(profile);
  } catch (error) {
    $("history-grid").innerHTML = "";
    $("anomaly-score-line").textContent = "";
    $("history-error").textContent = `Could not find this customer. ${error.message}`;
    show("history-error");
  }
}

$("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const customerId = $("profile-customer-id").value.trim();
  if (!customerId) return;
  await fetchAndRenderProfile(customerId);
});

async function fetchSubstitutes(invoiceNo) {
  try {
    const response = await fetch(`${API_BASE}/substitutes/${encodeURIComponent(invoiceNo)}`);
    if (!response.ok) return;
    renderSubstitutes(await response.json());
  } catch (error) {
    return;
  }
}

function renderSubstitutes(data) {
  const list = $("substitute-list");
  list.innerHTML = "";
  if (data.original_stock_code || data.original_description) {
    $("original-line").textContent = `Original item ${data.original_stock_code} · ${data.original_description}`;
    show("original-line");
  } else {
    hide("original-line");
  }

  if (!data.substitutes || data.substitutes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-note";
    empty.textContent = "No substitutes available for this invoice.";
    list.appendChild(empty);
    show("substitutes-section");
    return;
  }

  data.substitutes.forEach((item) => {
    const row = document.createElement("div");
    row.className = "substitute-row";

    const code = document.createElement("p");
    code.className = "substitute-code";
    code.textContent = item.stock_code;

    const description = document.createElement("p");
    description.textContent = item.description || "";
    if (item.in_customer_return_history) {
      const warning = document.createElement("span");
      warning.className = "prior-warning";
      warning.textContent = "this customer has returned this item before";
      description.appendChild(warning);
    }

    const rationale = document.createElement("p");
    rationale.textContent = item.rationale || "";

    const similarity = document.createElement("p");
    similarity.className = "substitute-sim";
    similarity.textContent = `${(Number(item.content_similarity || 0) * 100).toFixed(0)}% similar`;

    row.append(code, description, rationale, similarity);
    list.appendChild(row);
  });
  show("substitutes-section");
}
