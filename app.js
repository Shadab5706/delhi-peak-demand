// Delhi Peak Demand: charts and forecast explorer (plain SVG, no libraries)
"use strict";

const NS = "http://www.w3.org/2000/svg";
const DAY = 864e5;
const fmt = (v) => (v == null ? "–" : Math.round(v).toLocaleString("en-IN"));
const parse = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (s) => { const d = parse(s); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`; };
const longLabel = (s) => `${dayLabel(s)} ${parse(s).getUTCFullYear()}`;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function svgFor(container, w, h) {
  container.innerHTML = "";
  return el("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img" }, container);
}
function niceTicks(lo, hi, n = 5) {
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

// ---------- theme + nav ----------
const root = document.documentElement;
const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
document.getElementById("themeBtn").addEventListener("click", () => {
  root.dataset.theme = isDark() ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch (e) { /* storage blocked */ }
});
const menuBtn = document.getElementById("menuBtn"), links = document.getElementById("links");
menuBtn.addEventListener("click", () => {
  const open = links.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", open);
});
links.addEventListener("click", (e) => { if (e.target.tagName === "A") { links.classList.remove("open"); menuBtn.setAttribute("aria-expanded", false); } });
const navLinks = [...links.querySelectorAll("a")];
const spy = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (en.isIntersecting) navLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id));
  });
}, { rootMargin: "-45% 0px -50% 0px" });
navLinks.forEach((a) => { const s = document.querySelector(a.getAttribute("href")); if (s) spy.observe(s); });

// ---------- tooltip ----------
const tip = document.getElementById("tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.classList.add("show");
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (left < 8) left = 8;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
const hideTip = () => tip.classList.remove("show");

// ---------- model names and colours ----------
const NAME = {
  "Naive (yesterday)": "Naive (yesterday)", "Seasonal naive (last week)": "Seasonal naive (last week)",
  "Seasonal naive (last year)": "Seasonal naive (last year)", "Holt-Winters (weekly)": "Holt-Winters (weekly)",
  "SARIMA": "SARIMA", "SARIMAX + calendar": "SARIMAX + calendar", "SARIMAX + calendar + weather": "SARIMAX + calendar + weather",
  "Prophet + holidays + weather": "Prophet + holidays + weather", "XGBoost (direct)": "XGBoost",
  "LSTM (direct 7-day)": "LSTM", "GRU (direct 7-day)": "GRU", "Ensemble (LSTM + GRU)": "LSTM + GRU ensemble",
};
const NO_WX = new Set(["Naive (yesterday)", "Seasonal naive (last week)", "Seasonal naive (last year)", "Holt-Winters (weekly)", "SARIMA", "SARIMAX + calendar"]);
const DEPLOYED = "Ensemble (LSTM + GRU)";
const EX_MODELS = [
  ["ens", "LSTM + GRU (deployed)", "var(--blue)"],
  ["xgb", "XGBoost", "var(--amber)"],
  ["sarimax_wx", "SARIMAX + weather", "var(--teal)"],
  ["prophet", "Prophet", "var(--purple)"],
  ["lstm", "LSTM", "var(--pink)"],
  ["gru", "GRU", "var(--green)"],
  ["naive", "Naive (yesterday)", "var(--grey)"],
];

let S; // site data

// ---------- hero sparkline ----------
function heroSpark() {
  const svg = document.getElementById("heroSpark"), raw = S.history.peak, n = raw.length;
  const k = Math.max(3, Math.round((n / innerWidth) * 3));
  const p = raw.map((_, i) => { const w = raw.slice(Math.max(0, i - k), i + k + 1).filter((v) => v != null); return w.length ? w.reduce((a, b) => a + b) / w.length : null; });
  const lo = 2000, hi = 9200;
  svg.setAttribute("viewBox", `0 0 ${n} 100`);
  let d = "", last = null;
  p.forEach((v, i) => {
    if (v == null) return;
    const y = 100 - ((v - lo) / (hi - lo)) * 100;
    d += (last == null ? "M" : "L") + i + " " + y.toFixed(2);
    last = i;
  });
  const defs = el("defs", {}, svg), g = el("linearGradient", { id: "hg", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el("stop", { offset: 0, "stop-color": "#E8871E", "stop-opacity": 0.35 }, g);
  el("stop", { offset: 1, "stop-color": "#E8871E", "stop-opacity": 0 }, g);
  el("path", { d: d + `L${last} 100L0 100Z`, fill: "url(#hg)" }, svg);
  el("path", { d, fill: "none", stroke: "#E8871E", "stroke-width": 1.2, "vector-effect": "non-scaling-stroke", "stroke-opacity": 0.8 }, svg);
}

// ---------- EDA facts + yearly peak ----------
function edaFacts() {
  const e = S.eda;
  const facts = [
    [fmt(e.mean_peak) + " MW", "average daily peak, 2021–2026"],
    [e.summer_vs_winter_ratio.toFixed(2) + "×", "summer peaks vs. winter peaks"],
    [e.corr_cdd_peak.toFixed(2), "correlation of peak with cooling degree-days (heat above 24 °C)"],
    [`${fmt(e.stl.trend_start_mw)} → ${fmt(e.stl.trend_end_mw)}`, "MW, STL trend from start to end"],
  ];
  document.getElementById("edaFacts").innerHTML = facts.map(([b, s]) => `<div class="fact"><b>${b}</b><span>${s}</span></div>`).join("");
}

function yearChart() {
  const box = document.getElementById("yearChart"), data = Object.entries(S.eda.yearly_peak);
  const W = Math.max(300, box.clientWidth), H = 230, m = { l: 8, r: 8, t: 26, b: 26 };
  const svg = svgFor(box, W, H), lo = 6000, hi = 9000;
  const bw = (W - m.l - m.r) / data.length, y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  data.forEach(([yr, v], i) => {
    const x = m.l + i * bw + bw * 0.18, w = bw * 0.64, rec = v === S.eda.max_peak;
    el("rect", { x, y: y(v), width: w, height: H - m.b - y(v), rx: 5, style: `fill:${rec ? "var(--red)" : "var(--amber)"};opacity:${rec ? 1 : 0.8}` }, svg);
    el("text", { x: x + w / 2, y: y(v) - 8, "text-anchor": "middle", class: "lbl-strong" }, svg).textContent = fmt(v);
    el("text", { x: x + w / 2, y: H - 6, "text-anchor": "middle" }, svg).textContent = yr;
  });
  el("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "gl" }, svg);
  svg.setAttribute("aria-label", "Bar chart of yearly record peak demand: " + data.map(([y, v]) => `${y} ${v} MW`).join(", "));
}

// ---------- horizontal bars ----------
function hbar(box, rows, { fmtV = (v) => v.toFixed(2), max } = {}) {
  const W = Math.max(280, box.clientWidth), narrow = W < 560;
  const labelW = narrow ? 0 : Math.min(230, W * 0.34), rowH = narrow ? 44 : 32, valW = 64;
  const H = rows.length * rowH + 6, svg = svgFor(box, W, H);
  max = max || Math.max(...rows.map((r) => r.value)) * 1.02;
  const x0 = labelW, span = W - x0 - valW;
  rows.forEach((r, i) => {
    const top = i * rowH, barY = narrow ? top + 20 : top + 6, bh = narrow ? 16 : 18;
    const t = el("text", { x: narrow ? 0 : labelW - 12, y: narrow ? top + 14 : top + 19, "text-anchor": narrow ? "start" : "end",
      class: r.strong ? "lbl-strong" : "" }, svg);
    t.textContent = r.label;
    if (r.tag) { const ts = el("tspan", { dx: 6, style: `fill:${r.color};font-weight:700;font-size:11px` }, t); ts.textContent = r.tag; }
    el("rect", { x: x0, y: barY, width: span, height: bh, rx: 4, style: "fill:var(--surface-2)" }, svg);
    const bar = el("rect", { x: x0, y: barY, width: Math.max(2, (r.value / max) * span), height: bh, rx: 4, style: `fill:${r.color};opacity:${r.opacity ?? 1}` }, svg);
    bar.style.transition = "width .4s ease";
    el("text", { x: x0 + Math.max(2, (r.value / max) * span) + 8, y: barY + bh / 2 + 4, class: "lbl-strong" }, svg).textContent = fmtV(r.value);
  });
  svg.setAttribute("aria-label", rows.map((r) => `${r.label}: ${fmtV(r.value)}`).join("; "));
}

let barMode = "forecast";
function barChart() {
  const rows = S.metrics.filter((m) => m.weather === barMode).sort((a, b) => a.MAPE - b.MAPE);
  const best = rows[0].model;
  hbar(document.getElementById("barChart"), rows.map((m) => {
    const isBest = m.model === best, dep = m.model === DEPLOYED, nowx = NO_WX.has(m.model);
    return {
      label: NAME[m.model], value: m.MAPE, strong: isBest || dep,
      color: isBest ? "var(--amber)" : dep ? "var(--blue)" : nowx ? "var(--grey)" : "var(--amber)",
      opacity: isBest || dep ? 1 : nowx ? 0.7 : 0.45, tag: isBest ? "BEST" : dep ? "DEPLOYED" : "",
    };
  }), { fmtV: (v) => v.toFixed(2) + "%", max: 12 });
}

function metricsTable() {
  const by = {};
  S.metrics.forEach((m) => { (by[m.model] = by[m.model] || {})[m.weather] = m; });
  const rows = Object.entries(by).sort((a, b) => a[1].forecast.MAPE - b[1].forecast.MAPE);
  const best = rows[0][0];
  document.querySelector("#metricsTable tbody").innerHTML = rows.map(([name, r]) => {
    const f = r.forecast, o = r.observed;
    const pill = name === best ? '<span class="pill top">best</span>' : name === DEPLOYED ? '<span class="pill dep">deployed</span>' : "";
    return `<tr class="${name === best ? "best" : ""}"><td>${NAME[name]}${pill}</td><td class="muted">${f.family}</td>
      <td class="n"><b>${f.MAPE.toFixed(2)}</b></td><td class="n">${o.MAPE.toFixed(2)}</td><td class="n">${fmt(f.RMSE)}</td>
      <td class="n">${fmt(f.MAE)}</td><td class="n">${f.MAPE_summer.toFixed(2)}</td><td class="n">${f.MAPE_val_2025.toFixed(2)}</td></tr>`;
  }).join("");
}

// ---------- error by horizon ----------
const HZ = [["XGBoost (direct)", "XGBoost", "var(--amber)"], ["Ensemble (LSTM + GRU)", "LSTM + GRU", "var(--blue)"],
  ["SARIMAX + calendar + weather", "SARIMAX + weather", "var(--teal)"], ["Prophet + holidays + weather", "Prophet", "var(--purple)"],
  ["Naive (yesterday)", "Naive", "var(--grey)"]];
function hzChart() {
  const box = document.getElementById("hzChart"), W = Math.max(280, box.clientWidth), H = 240, m = { l: 34, r: 12, t: 10, b: 28 };
  const svg = svgFor(box, W, H), hi = 14;
  const x = (h) => m.l + ((h - 1) / 6) * (W - m.l - m.r), y = (v) => m.t + (1 - v / hi) * (H - m.t - m.b);
  [0, 2, 4, 6, 8, 10, 12, 14].forEach((v) => {
    el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "gl" }, svg);
    el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = v;
  });
  for (let h = 1; h <= 7; h++) el("text", { x: x(h), y: H - 8, "text-anchor": "middle" }, svg).textContent = h === 1 ? "1 day" : h;
  HZ.forEach(([k, , c]) => {
    const v = S.horizon[k + " | forecast"];
    el("path", { d: v.map((q, i) => (i ? "L" : "M") + x(i + 1) + " " + y(q)).join(""), fill: "none", style: `stroke:${c}`, "stroke-width": 2.4, "stroke-linejoin": "round" }, svg);
    v.forEach((q, i) => {
      const dot = el("circle", { cx: x(i + 1), cy: y(q), r: 3.5, style: `fill:${c};stroke:var(--surface)`, "stroke-width": 1.5 }, svg);
      dot.addEventListener("pointerenter", (e) => showTip(`<b>${k.replace(/ \(.*\)/, "")}</b><br>${i + 1} day${i ? "s" : ""} ahead: ${q.toFixed(2)}%`, e.clientX, e.clientY));
      dot.addEventListener("pointerleave", hideTip);
    });
  });
  document.getElementById("hzLegend").innerHTML = HZ.map(([, n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join("");
  svg.setAttribute("aria-label", "Line chart of MAPE by days ahead for five models");
}

const FI_NAME = {
  dcdd: "Heat change vs. today", x_tmax: "Forecast max temperature", x_is_weekend: "Weekend", l0: "Today's peak vs. last week",
  x_is_holiday: "Holiday", x_cdd_lag1: "Previous day's heat", ly: "Same weekday last year", x_cdd: "Cooling degree-days",
  x_cos1: "Yearly cycle (cos)", x_tmean: "Forecast mean temperature",
};
function fiChart() {
  const rows = Object.entries(S.features).slice(0, 10).map(([k, v], i) => ({
    label: FI_NAME[k] || k, value: v * 100, color: k === "dcdd" || k.startsWith("x_t") || k.includes("cdd") ? "var(--red)" : "var(--amber)", opacity: i < 2 ? 1 : 0.75,
  }));
  hbar(document.getElementById("fiChart"), rows, { fmtV: (v) => v.toFixed(1) + "%", max: 12 });
}

// ---------- forecast explorer ----------
const ex = { origin: "2026-05-20", wx: "f", on: new Set(["ens", "xgb", "sarimax_wx"]) };
const histAt = (dateStr) => S.history.peak[Math.round((parse(dateStr) - parse(S.history.start)) / DAY)];

function setupExplorer() {
  const sel = document.getElementById("originSel"), keys = Object.keys(S.origins);
  sel.innerHTML = keys.map((k) => `<option value="${k}">${longLabel(k)}</option>`).join("");
  sel.value = ex.origin;
  sel.addEventListener("change", () => { ex.origin = sel.value; renderExplorer(); });
  const step = (d) => { const i = keys.indexOf(ex.origin) + d; if (i >= 0 && i < keys.length) { ex.origin = sel.value = keys[i]; renderExplorer(); } };
  document.getElementById("prevO").addEventListener("click", () => step(-1));
  document.getElementById("nextO").addEventListener("click", () => step(1));

  const chips = document.getElementById("chips");
  chips.innerHTML = EX_MODELS.map(([k, n, c]) =>
    `<button class="chip ${ex.on.has(k) ? "on" : ""}" data-k="${k}" style="--c:${c}" aria-pressed="${ex.on.has(k)}"><span class="dot"></span>${n}</button>`).join("");
  chips.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const k = b.dataset.k;
    if (ex.on.has(k)) ex.on.delete(k); else ex.on.add(k);
    b.classList.toggle("on", ex.on.has(k)); b.setAttribute("aria-pressed", ex.on.has(k));
    renderExplorer();
  });
  document.getElementById("jumps").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (b) { ex.origin = sel.value = b.dataset.o; renderExplorer(); }
  });
  segGroup(document.getElementById("exWx"), (w) => { ex.wx = w; renderExplorer(); });
}

function segGroup(group, cb) {
  group.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    group.querySelectorAll("button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
    cb(b.dataset.w);
  });
}

function renderExplorer() {
  const O = S.origins[ex.origin], keys = Object.keys(S.origins), idx = keys.indexOf(ex.origin);
  document.getElementById("prevO").disabled = idx === 0;
  document.getElementById("nextO").disabled = idx === keys.length - 1;
  const models = EX_MODELS.filter(([k]) => ex.on.has(k));
  const fc = (k) => O.f[`${k}|${ex.wx}`];
  const thr = O.thr;

  // alert banner: the deployed model, as on the dashboard
  const dep = fc("ens");
  const flagged = O.dates.filter((_, i) => dep[i] > thr), actualHot = O.dates.filter((_, i) => O.actual[i] != null && O.actual[i] > thr);
  const box = document.getElementById("alertBox");
  const actualTxt = actualHot.length ? `Actually above it: ${actualHot.length} day${actualHot.length > 1 ? "s" : ""} (${actualHot.map(dayLabel).join(", ")}).` : "Actually above it: none.";
  box.className = "alert-box " + (flagged.length ? "on" : actualHot.length ? "miss" : "off");
  box.innerHTML = !flagged.length && actualHot.length
    ? `<span>!</span><div><b class="t">Missed spike:</b> the deployed model kept all 7 days below the ${O.season.toLowerCase()} alert line of <b>${fmt(thr)} MW</b>, but ${actualHot.length} day${actualHot.length > 1 ? "s" : ""} went above it (${actualHot.map(dayLabel).join(", ")}).</div>`
    : flagged.length
    ? `<span>⚠</span><div><b class="t">Heat-spike alert:</b> the deployed model expects ${flagged.length} day${flagged.length > 1 ? "s" : ""} above the ${O.season.toLowerCase()} alert line of <b>${fmt(thr)} MW</b>: ${flagged.map(dayLabel).join(", ")}. ${actualTxt}</div>`
    : `<span>✓</span><div><b class="t">No alert:</b> the deployed model keeps all 7 days below the ${O.season.toLowerCase()} alert line of <b>${fmt(thr)} MW</b>. ${actualTxt}</div>`;

  // series: a week of history, then the forecast week
  const P = 8, o = parse(ex.origin), past = [];
  for (let i = P - 1; i >= 0; i--) { const d = iso(new Date(o - i * DAY)); past.push({ d, v: histAt(d) }); }
  const all = [...past.map((p) => p.d), ...O.dates], N = all.length;
  const band = ex.on.has("ens") && ex.wx === "f"
    ? dep.map((v, i) => [v * Math.exp(S.interval[i + 1][0]), v * Math.exp(S.interval[i + 1][1])]) : null;
  const vals = [thr, ...past.map((p) => p.v), ...O.actual, ...models.flatMap(([k]) => fc(k)), ...(band ? band.flat() : [])].filter((v) => v != null);
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.08 || 200; lo -= pad; hi += pad;

  const cont = document.getElementById("exChart"), W = Math.max(300, cont.clientWidth), narrow = W < 560;
  const H = narrow ? 300 : 380, m = { l: narrow ? 42 : 52, r: narrow ? 8 : 16, t: 16, b: 34 };
  const svg = svgFor(cont, W, H);
  const x = (i) => m.l + (i / (N - 1)) * (W - m.l - m.r), y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  // forecast window shading
  el("rect", { x: x(P - 1), y: m.t, width: x(N - 1) - x(P - 1), height: H - m.t - m.b, style: "fill:var(--surface-2)", opacity: 0.7 }, svg);
  niceTicks(lo, hi, narrow ? 4 : 6).forEach((v) => {
    el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "gl" }, svg);
    el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = narrow ? (v / 1000).toFixed(1) + "k" : fmt(v);
  });
  all.forEach((d, i) => {
    const every = narrow ? 3 : 1;
    if ((N - 1 - i) % every === 0) {
      const dt = parse(d);
      el("text", { x: x(i), y: H - 12, "text-anchor": "middle" }, svg).textContent = `${dt.getUTCDate()} ${MO[dt.getUTCMonth()]}`;
    }
  });
  el("line", { x1: x(P - 1), x2: x(P - 1), y1: m.t, y2: H - m.b, style: "stroke:var(--muted)", "stroke-dasharray": "3 4" }, svg);
  el("text", { x: x(P - 1) - 6, y: m.t + 12, "text-anchor": "end", style: "font-size:11px" }, svg).textContent = "past";
  el("text", { x: x(P - 1) + 6, y: m.t + 12, style: "font-size:11px" }, svg).textContent = "forecast →";

  if (band) {
    const top = band.map(([, h], i) => `${x(P + i)} ${y(h)}`), bot = band.map(([l], i) => `${x(P + i)} ${y(l)}`).reverse();
    el("path", { d: "M" + top.join("L") + "L" + bot.join("L") + "Z", style: "fill:var(--band)" }, svg);
  }
  // alert line across the forecast week
  el("line", { x1: m.l, x2: W - m.r, y1: y(thr), y2: y(thr), style: "stroke:var(--red);opacity:.35", "stroke-dasharray": "2 5" }, svg);
  el("line", { x1: x(P - 1), x2: W - m.r, y1: y(thr), y2: y(thr), style: "stroke:var(--red)", "stroke-width": 1.6, "stroke-dasharray": "6 5" }, svg);
  el("text", { x: m.l + 6, y: y(thr) + 4, style: "fill:var(--red);font-size:11px;font-weight:600;paint-order:stroke;stroke:var(--surface);stroke-width:4px" }, svg).textContent = `alert ${fmt(thr)} MW`;

  // actual: history + realised week
  const act = [...past.map((p) => p.v), ...O.actual];
  const linePath = (arr, off = 0) => { let d = "", pen = false; arr.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + x(i + off) + " " + y(v); pen = true; }); return d; };
  el("path", { d: linePath(act), fill: "none", style: "stroke:var(--actual)", "stroke-width": 2.6, "stroke-linejoin": "round" }, svg);
  act.forEach((v, i) => { if (v != null && i >= P) el("circle", { cx: x(i), cy: y(v), r: 3.6, style: `fill:var(--actual);stroke:${v > thr ? "var(--red)" : "var(--surface)"}`, "stroke-width": v > thr ? 2.5 : 1.5 }, svg); });
  // forecasts start from the origin day's actual so the eye can follow them
  models.forEach(([k, , c]) => {
    const f = fc(k), start = past[P - 1].v;
    const d = (start != null ? `M${x(P - 1)} ${y(start)}` : "") + f.map((v, i) => `${start != null || i ? "L" : "M"}${x(P + i)} ${y(v)}`).join("");
    el("path", { d, fill: "none", style: `stroke:${c}`, "stroke-width": k === "ens" ? 2.6 : 2, "stroke-linejoin": "round", "stroke-dasharray": k === "naive" ? "4 4" : "none" }, svg);
    f.forEach((v, i) => el("circle", { cx: x(P + i), cy: y(v), r: 3.2, style: `fill:${c};stroke:var(--surface)`, "stroke-width": 1.4 }, svg));
  });

  // hover
  const guide = el("line", { y1: m.t, y2: H - m.b, style: "stroke:var(--muted);opacity:0", "stroke-width": 1 }, svg);
  const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
  const onMove = (e) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(N - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (N - 1))));
    guide.setAttribute("x1", x(i)); guide.setAttribute("x2", x(i)); guide.style.opacity = 0.6;
    let html = `<b>${longLabel(all[i])}</b><div class="row"><span><i style="background:var(--actual)"></i>Actual</span><b>${act[i] == null ? "n/a" : fmt(act[i]) + " MW"}</b></div>`;
    if (i >= P) {
      models.forEach(([k, n, c]) => { const v = fc(k)[i - P]; html += `<div class="row"><span><i style="background:${c}"></i>${n}</span><span>${fmt(v)}${v > thr ? " ⚠" : ""}</span></div>`; });
      if (band) html += `<div class="row"><span>90% range</span><span>${fmt(band[i - P][0])}–${fmt(band[i - P][1])}</span></div>`;
      html += `<div class="row"><span>Alert line</span><span>${fmt(thr)}</span></div>`;
    }
    showTip(html, e.clientX, e.clientY);
  };
  hit.addEventListener("pointermove", onMove);
  hit.addEventListener("pointerdown", onMove);
  hit.addEventListener("pointerleave", () => { guide.style.opacity = 0; hideTip(); });
  svg.setAttribute("aria-label", `Actual peak demand for the week before ${longLabel(ex.origin)} and the 7-day forecasts of the selected models`);

  // legend with week MAPE
  const mape = (f) => { const e = O.actual.map((a, i) => (a == null ? null : Math.abs(f[i] - a) / a)).filter((v) => v != null); return e.length ? (100 * e.reduce((s, v) => s + v, 0)) / e.length : null; };
  document.getElementById("exLegend").innerHTML = `<span><i style="background:var(--actual);height:3px"></i>Actual</span>` +
    models.map(([k, n, c]) => { const v = mape(fc(k)); return `<span><i style="background:${c}"></i>${n} <span class="mape">${v == null ? "" : v.toFixed(1) + "%"}</span></span>`; }).join("") +
    (band ? `<span><i style="background:var(--band);height:10px;width:14px"></i>90% range</span>` : "") +
    `<span class="muted">· % = error this week</span>`;

  // table
  const t = document.getElementById("exTable");
  t.innerHTML = `<thead><tr><th>Day</th><th class="n">Actual MW</th><th class="n">Max °C<br><small>observed</small></th>${models.map(([, n]) => `<th class="n">${n}</th>`).join("")}</tr></thead><tbody>` +
    O.dates.map((d, i) => `<tr><td>${dayLabel(d)}</td><td class="n ${O.actual[i] == null ? "na" : O.actual[i] > thr ? "hot" : ""}"><b>${O.actual[i] == null ? "n/a" : fmt(O.actual[i])}</b></td>
      <td class="n">${O.tmax[i] == null ? "–" : O.tmax[i].toFixed(1)}</td>${models.map(([k]) => { const v = fc(k)[i]; return `<td class="n ${v > thr ? "hot" : ""}">${fmt(v)}</td>`; }).join("")}</tr>`).join("") + "</tbody>";
}

// ---------- boot ----------
function renderCharts() { yearChart(); barChart(); hzChart(); fiChart(); renderExplorer(); }

fetch("data/site.json").then((r) => r.json()).then((data) => {
  S = data;
  heroSpark(); edaFacts(); metricsTable(); setupExplorer();
  segGroup(document.querySelector("#results .seg"), (w) => { barMode = w; barChart(); });
  renderCharts();
  let lastW = innerWidth, tmr;
  addEventListener("resize", () => { if (innerWidth === lastW) return; lastW = innerWidth; clearTimeout(tmr); tmr = setTimeout(renderCharts, 150); });
}).catch(() => {
  document.getElementById("exChart").innerHTML = '<p class="note">The chart data could not be loaded. Please reload the page.</p>';
});
addEventListener("scroll", hideTip, { passive: true });
