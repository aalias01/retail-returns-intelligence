const API_BASE = "https://alvinalias-retail-returns-intelligence.hf.space";
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
  overrun: "> still waiting · the Space is waking from extended inactivity",
};
const LOCAL_WARMUP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const FALLBACK_FILTERS = [
  { key: "any", label: "Any" },
  { key: "low", label: "Low risk" },
  { key: "medium", label: "Medium risk" },
  { key: "high", label: "High risk" },
  { key: "behavior-anomaly", label: "Behavior anomaly" },
  { key: "premium-loyal", label: "Premium Loyal" },
  { key: "healthy-browser", label: "Healthy Browser" },
  { key: "at-risk", label: "At-Risk" },
  { key: "returner", label: "Returner" },
];

const FALLBACK_DEMO_CASES = [
  {
    case_id: "536365:85123A",
    customer_id: "16684.0",
    invoice_no: "536365",
    stock_code: "85123A",
    description: "White hanging heart t-light holder",
    quantity: 6,
    unit_price: 2.55,
    country: "United Kingdom",
    invoice_date: "2010-12-01",
    segment: "Premium Loyal",
    risk_tier: "Low",
    return_probability: 0,
    anomaly_flag: 1,
    anomaly_score: -0.1662,
    lifetime_return_rate: 0.182,
    frequency_score: 55,
    monetary_score: 147143,
    has_substitutes: true,
    unit_price_z: 0,
    quantity_z: 0,
    is_weekend: 0,
    month_end_proximity: 30,
    category_return_rate: 0.05,
    tags: ["low", "premium-loyal", "behavior-anomaly", "substitutes"],
  },
  {
    case_id: "536378:22423",
    customer_id: "16333.0",
    invoice_no: "536378",
    stock_code: "22423",
    description: "Regency cakestand 3 tier",
    quantity: 4,
    unit_price: 12.95,
    country: "United Kingdom",
    invoice_date: "2010-12-01",
    segment: "Healthy Browser",
    risk_tier: "Low",
    return_probability: 0.08,
    anomaly_flag: 0,
    anomaly_score: 0,
    lifetime_return_rate: 0,
    frequency_score: 1,
    monetary_score: 52,
    has_substitutes: true,
    unit_price_z: 0,
    quantity_z: 0,
    is_weekend: 0,
    month_end_proximity: 30,
    category_return_rate: 0.05,
    tags: ["low", "healthy-browser", "substitutes"],
  },
  {
    case_id: "536846:84879",
    customer_id: "15749.0",
    invoice_no: "536846",
    stock_code: "84879",
    description: "Assorted colour bird ornament",
    quantity: 8,
    unit_price: 1.69,
    country: "United Kingdom",
    invoice_date: "2010-12-02",
    segment: "At-Risk",
    risk_tier: "Medium",
    return_probability: 0.42,
    anomaly_flag: 0,
    anomaly_score: 0,
    lifetime_return_rate: 0.04,
    frequency_score: 3,
    monetary_score: 415,
    has_substitutes: true,
    unit_price_z: 0,
    quantity_z: 0,
    is_weekend: 0,
    month_end_proximity: 29,
    category_return_rate: 0.05,
    tags: ["medium", "at-risk", "substitutes"],
  },
  {
    case_id: "537434:22086",
    customer_id: "18102.0",
    invoice_no: "537434",
    stock_code: "22086",
    description: "Paper chain kit 50's christmas",
    quantity: 12,
    unit_price: 2.95,
    country: "United Kingdom",
    invoice_date: "2010-12-06",
    segment: "Returner",
    risk_tier: "High",
    return_probability: 0.72,
    anomaly_flag: 1,
    anomaly_score: -0.2103,
    lifetime_return_rate: 0.055,
    frequency_score: 145,
    monetary_score: 608822,
    has_substitutes: true,
    unit_price_z: 0,
    quantity_z: 0,
    is_weekend: 0,
    month_end_proximity: 25,
    category_return_rate: 0.05,
    tags: ["high", "returner", "behavior-anomaly", "substitutes"],
  },
];

const MAX_SUGGESTIONS = 6;

let demoFilters = FALLBACK_FILTERS;
let demoCases = FALLBACK_DEMO_CASES;
let activeFilter = "any";
let selectedCase = null;
let lastCaseId = "";
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
  if (!element) {
    return {
      start() {},
      markReady() {},
      cancel() {},
      snapshot() {},
    };
  }

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

function slug(value) {
  return String(value || "").trim().toLowerCase().replaceAll(" ", "-").replaceAll("_", "-");
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeCase(raw) {
  const riskTier = normalizeText(raw.risk_tier, "Low");
  const segment = normalizeText(raw.segment, "Unknown");
  const invoiceNo = normalizeText(raw.invoice_no);
  const stockCode = normalizeText(raw.stock_code);
  const tags = Array.isArray(raw.tags) ? raw.tags.map(slug) : [];
  tags.push(slug(riskTier), slug(segment));
  if (Number(raw.anomaly_flag || 0) === 1) tags.push("behavior-anomaly");
  if (raw.has_substitutes) tags.push("substitutes");

  return {
    case_id: normalizeText(raw.case_id, `${invoiceNo}:${stockCode}`),
    invoice_no: invoiceNo,
    customer_id: normalizeText(raw.customer_id),
    stock_code: stockCode,
    description: normalizeText(raw.description, "Retail invoice line"),
    quantity: normalizeNumber(raw.quantity, 1),
    unit_price: normalizeNumber(raw.unit_price, 0),
    country: normalizeText(raw.country, "United Kingdom"),
    invoice_date: normalizeText(raw.invoice_date),
    segment,
    risk_tier: riskTier,
    return_probability: normalizeNumber(raw.return_probability, 0),
    anomaly_flag: Number(raw.anomaly_flag || 0),
    anomaly_score: normalizeNumber(raw.anomaly_score, 0),
    lifetime_return_rate: normalizeNumber(raw.lifetime_return_rate, 0),
    frequency_score: normalizeNumber(raw.frequency_score, 0),
    monetary_score: normalizeNumber(raw.monetary_score, 0),
    has_substitutes: Boolean(raw.has_substitutes),
    unit_price_z: normalizeNumber(raw.unit_price_z, 0),
    quantity_z: normalizeNumber(raw.quantity_z, 0),
    is_weekend: Number(raw.is_weekend || 0),
    month_end_proximity: normalizeNumber(raw.month_end_proximity, 15),
    category_return_rate: normalizeNumber(raw.category_return_rate, 0.05),
    tags: [...new Set(tags.filter(Boolean))],
  };
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function formatQuantity(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function caseMatchesFilter(demoCase, filterKey = activeFilter) {
  const normalized = slug(filterKey || "any");
  if (!normalized || normalized === "any") return true;
  if (["low", "medium", "high"].includes(normalized)) {
    return slug(demoCase.risk_tier) === normalized;
  }
  if (normalized === "behavior-anomaly") {
    return demoCase.anomaly_flag === 1;
  }
  return demoCase.tags.includes(normalized);
}

function caseSearchText(demoCase) {
  return [
    demoCase.invoice_no,
    demoCase.customer_id,
    demoCase.stock_code,
    demoCase.description,
    demoCase.risk_tier,
    demoCase.segment,
    demoCase.country,
    demoCase.tags.join(" "),
  ].join(" ").toLowerCase();
}

function casePrimaryLine(demoCase) {
  return `Invoice ${demoCase.invoice_no} · customer ${demoCase.customer_id} · ${demoCase.risk_tier} risk`;
}

function caseMetaLine(demoCase) {
  return `${demoCase.segment} · ${demoCase.stock_code} · qty ${formatQuantity(demoCase.quantity)} · ${formatMoney(demoCase.unit_price)}`;
}

function filteredCases(filterKey = activeFilter) {
  const pool = demoCases.filter((demoCase) => caseMatchesFilter(demoCase, filterKey));
  return pool.length ? pool : demoCases;
}

function pickRandomCase(pool) {
  const choices = pool.length > 1
    ? pool.filter((demoCase) => demoCase.case_id !== lastCaseId)
    : pool;
  const source = choices.length ? choices : pool;
  const picked = source[Math.floor(Math.random() * source.length)];
  if (picked) lastCaseId = picked.case_id;
  return picked || null;
}

function setLedgerFromCase(demoCase) {
  if (!demoCase) return;
  selectedCase = demoCase;
  $("customer-id").value = demoCase.customer_id;
  $("invoice-no").value = demoCase.invoice_no;
  $("stock-code").value = demoCase.stock_code;
  $("quantity").value = formatQuantity(demoCase.quantity);
  $("unit-price").value = demoCase.unit_price.toFixed(2).replace(/\.00$/, "");
  $("country").value = demoCase.country;
  $("case-strip").textContent = `${casePrimaryLine(demoCase)} · ${demoCase.description}`;
}

function renderFilterChips() {
  const chips = $("sample-chips");
  if (!chips) return;
  chips.innerHTML = "";
  demoFilters.forEach((filter) => {
    const key = slug(filter.key || filter.label);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.filter = key;
    button.textContent = filter.label || filter.key;
    button.setAttribute("aria-pressed", key === activeFilter ? "true" : "false");
    button.addEventListener("click", () => setActiveFilter(key));
    chips.appendChild(button);
  });
}

function setActiveFilter(filterKey, options = {}) {
  const normalized = slug(filterKey || "any");
  activeFilter = demoFilters.some((filter) => slug(filter.key || filter.label) === normalized)
    ? normalized
    : "any";
  document.querySelectorAll("#sample-chips .chip").forEach((chip) => {
    chip.setAttribute("aria-pressed", chip.dataset.filter === activeFilter ? "true" : "false");
  });
  if (!options.keepCase) {
    const next = pickRandomCase(filteredCases(activeFilter));
    if (next) setLedgerFromCase(next);
  }
  renderSuggestions();
}

function matchingCases(query) {
  const needle = query.trim().toLowerCase();
  const source = needle ? demoCases : filteredCases(activeFilter);
  return source
    .filter((demoCase) => !needle || caseSearchText(demoCase).includes(needle))
    .slice(0, MAX_SUGGESTIONS);
}

function renderSuggestions() {
  const box = $("case-suggestions");
  const input = $("case-search-input");
  if (!box || !input) return;
  const matches = matchingCases(input.value);
  box.innerHTML = "";

  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "case-suggestion-empty mono";
    empty.textContent = "No sample invoices matched. Try invoice number, customer ID, product code, segment, or risk tier.";
    box.appendChild(empty);
    box.classList.remove("hidden");
    return;
  }

  matches.forEach((demoCase) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "case-suggestion";
    button.setAttribute("role", "option");

    const primary = document.createElement("strong");
    primary.textContent = casePrimaryLine(demoCase);
    const meta = document.createElement("span");
    meta.textContent = caseMetaLine(demoCase);
    button.append(primary, meta);
    button.addEventListener("click", () => selectAndScoreCase(demoCase));
    box.appendChild(button);
  });
  box.classList.remove("hidden");
}

async function loadDemoCases() {
  try {
    const response = await fetch(`${API_BASE}/demo-cases?limit=160`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const cases = Array.isArray(data.cases)
      ? data.cases.map(normalizeCase).filter((demoCase) => demoCase.invoice_no && demoCase.customer_id)
      : [];
    if (cases.length) demoCases = cases;
    if (Array.isArray(data.filters) && data.filters.length) {
      demoFilters = data.filters
        .map((filter) => ({
          key: slug(filter.key || filter.label),
          label: normalizeText(filter.label, filter.key),
        }))
        .filter((filter) => filter.key && filter.label);
    }
  } catch (error) {
    demoCases = FALLBACK_DEMO_CASES.map(normalizeCase);
    demoFilters = FALLBACK_FILTERS;
  }
  renderFilterChips();
  setActiveFilter(activeFilter);
}

demoCases = demoCases.map(normalizeCase);
renderFilterChips();
setLedgerFromCase(demoCases[0]);
renderSuggestions();

if (!runWarmupStub()) {
  pingHealth().finally(loadDemoCases);
} else {
  loadDemoCases();
}

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

function casePayload(demoCase) {
  return {
    customer_id: demoCase.customer_id,
    invoice_no: demoCase.invoice_no,
    stock_code: demoCase.stock_code,
    quantity: demoCase.quantity,
    unit_price: demoCase.unit_price,
    country: demoCase.country,
    unit_price_z: demoCase.unit_price_z,
    quantity_z: demoCase.quantity_z,
    is_weekend: demoCase.is_weekend,
    month_end_proximity: demoCase.month_end_proximity,
    category_return_rate: demoCase.category_return_rate,
  };
}

function setScoringBusy(isBusy) {
  $("known-run").disabled = isBusy;
  $("case-search-submit").disabled = isBusy;
  $("case-search-input").disabled = isBusy;
  document.querySelectorAll(".case-suggestion").forEach((button) => {
    button.disabled = isBusy;
  });
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
  const demoCase = options.case || selectedCase;
  const payload = demoCase ? casePayload(demoCase) : payloadFromLedger();
  clearRunState({ keepLog: options.keepLog });
  const startedAt = performance.now();
  scoreWarmMeter.start({ startedAt, emitLine: logLine });
  setScoringBusy(true);

  try {
    const score = await scorePayload(payload, (responseAt) => scoreWarmMeter.markReady(responseAt));
    logLine(`> scored in ${formatSeconds(score._elapsed)} s`);
    renderScore(score);
    logLine("> pulling this customer's history");
    await fetchAndRenderProfile(payload.customer_id, true);
    if (score.risk_tier === "High" || demoCase?.has_substitutes) {
      await fetchSubstitutes(payload.invoice_no);
    }
  } catch (error) {
    scoreWarmMeter.cancel();
    const network = error instanceof TypeError || /fetch|network|aborted/i.test(error.message);
    if (network) {
      showScoreError(
        "This ML demo sleeps after extended inactivity. First wake can take a moment; runs after that are quick.",
        "Try again in a moment.",
      );
    } else {
      showScoreError(`Could not score this transaction. ${error.message}`, error.rawDetail || error.message);
    }
  } finally {
    setScoringBusy(false);
    renderSuggestions();
  }
}

$("known-run")?.addEventListener("click", async () => {
  const demoCase = pickRandomCase(filteredCases(activeFilter));
  if (!demoCase) return;
  await selectAndScoreCase(demoCase);
});

async function selectAndScoreCase(demoCase) {
  if (!demoCase) return;
  setLedgerFromCase(demoCase);
  clearRunState();
  logLine(`> ${casePrimaryLine(demoCase)} · sample loaded`);
  await runScore({ keepLog: true, case: demoCase });
}

$("score-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  runScore({ case: selectedCase });
});

$("case-search-input")?.addEventListener("input", renderSuggestions);
$("case-search-input")?.addEventListener("focus", renderSuggestions);
$("case-search-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const firstMatch = matchingCases($("case-search-input").value)[0];
  if (firstMatch) {
    await selectAndScoreCase(firstMatch);
    return;
  }
  showScoreError(
    "No sample invoice matched that search.",
    "Try invoice number, customer ID, product code, segment, or risk tier.",
  );
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

$("profile-form")?.addEventListener("submit", async (event) => {
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
