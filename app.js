// Delhi Peak Demand: live forecast, planner, what-if and analysis app (hash routes + ECharts)
"use strict";

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const DAY = 864e5;
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d }));
const parse = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (s) => { const d = parse(s); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`; };
const longLabel = (s) => `${dayLabel(s)} ${parse(s).getUTCFullYear()}`;
const addDays = (s, n) => iso(new Date(parse(s).getTime() + n * DAY));
const css = (k) => getComputedStyle(document.documentElement).getPropertyValue("--" + k).trim();
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const hh = (h) => String((h + 24) % 24).padStart(2, "0") + ":00";
function quantile(arr, p) { // linear interpolation, same as pandas' default
  const a = [...arr].sort((x, y) => x - y), pos = (a.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
const SEASON = (m) => ([12, 1, 2].includes(m) ? "Winter" : m <= 6 && m >= 3 ? "Summer" : m >= 7 && m <= 9 ? "Monsoon" : "Post-monsoon");
const ICON = {
  dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
};

const MODELS = [ // explorer models: key, name, colour var
  ["xgb", "XGBoost", "amber"], ["ens", "LSTM + GRU (deployed)", "blue"], ["sarimax_wx", "SARIMAX + weather", "teal"],
  ["prophet", "Prophet", "purple"], ["lstm", "LSTM", "pink"], ["gru", "GRU", "olive"], ["naive", "Naive (yesterday)", "grey"],
];
const NAME = {
  "Naive (yesterday)": "Naive (yesterday)", "Seasonal naive (last week)": "Seasonal naive (last week)", "Seasonal naive (last year)": "Seasonal naive (last year)",
  "Holt-Winters (weekly)": "Holt-Winters", SARIMA: "SARIMA", "SARIMAX + calendar": "SARIMAX + calendar", "SARIMAX + calendar + weather": "SARIMAX + weather",
  "Prophet + holidays + weather": "Prophet", "XGBoost (direct)": "XGBoost", "LSTM (direct 7-day)": "LSTM", "GRU (direct 7-day)": "GRU", "Ensemble (LSTM + GRU)": "LSTM + GRU ensemble",
};
const NO_WX = new Set(["Naive (yesterday)", "Seasonal naive (last week)", "Seasonal naive (last year)", "Holt-Winters (weekly)", "SARIMA", "SARIMAX + calendar"]);
const DEPLOYED = "Ensemble (LSTM + GRU)", XGB = "XGBoost (direct)";

const D = { site: null, latest: null, log: null, planner: null, web: null };

// ---------- charts ----------
let charts = [];
function mk(el) {
  const c = echarts.init(el, null, { renderer: "canvas" }), set = c.setOption.bind(c);
  c.setOption = (o, ...r) => { // keep band helper series out of the legend
    if (o.series && o.legend && o.legend.show !== false) o.legend.data = o.series.map((s) => s.name).filter((n) => n && !n.endsWith("_lo"));
    return set(o, ...r);
  };
  charts.push(c);
  return c;
}
function clearCharts() { charts.forEach((c) => c.dispose()); charts = []; }
let rz;
addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => charts.forEach((c) => c.resize()), 120); });
const narrow = () => innerWidth < 600;
function base(extra = {}) {
  const t = css("text"), m = css("muted"), b = css("border");
  return {
    textStyle: { fontFamily: "Inter, system-ui, sans-serif", color: m }, animationDuration: 350,
    grid: { left: 8, right: 14, top: 48, bottom: 30, containLabel: true },
    tooltip: { trigger: "axis", backgroundColor: css("surface"), borderColor: b, textStyle: { color: t, fontSize: 12 }, confine: true,
      axisPointer: { lineStyle: { color: m, type: "dashed" } } },
    legend: { top: 0, left: 0, type: "scroll", textStyle: { color: m, fontSize: 12 }, itemWidth: 16, itemHeight: 8, icon: "roundRect",
      pageTextStyle: { color: m }, inactiveColor: css("faint") },
    ...extra,
  };
}
const xTime = (o = {}) => ({ type: "time", axisLine: { lineStyle: { color: css("border") } }, axisTick: { show: false },
  axisLabel: { color: css("muted"), hideOverlap: true }, splitLine: { show: false }, ...o });
const xCat = (data, o = {}) => ({ type: "category", data, axisLine: { lineStyle: { color: css("border") } }, axisTick: { show: false },
  axisLabel: { color: css("muted"), hideOverlap: true }, ...o });
const yVal = (o = {}) => ({ type: "value", scale: true, axisLabel: { color: css("muted"), formatter: (v) => fmt(v) },
  splitLine: { lineStyle: { color: css("grid") } }, nameTextStyle: { color: css("muted"), align: "left" }, ...o });
const thrLine = (thr, label = "alert line") => ({ silent: true, symbol: "none", lineStyle: { color: css("red"), type: "dashed", width: 1.6 },
  label: { formatter: `${label} ${fmt(thr)} MW`, color: css("red"), position: "insideStartTop", fontSize: 11, fontWeight: 600 }, data: [{ yAxis: thr }] });
function bandSeries(name, lo, hi, color) { // stacked area band between lo and hi
  return [
    { name: name + "_lo", type: "line", data: lo, stack: name, symbol: "none", lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
    { name, type: "line", data: hi.map(([d, v], i) => [d, v - lo[i][1]]), stack: name, symbol: "none", lineStyle: { opacity: 0 },
      areaStyle: { color }, itemStyle: { color }, silent: true, tooltip: { show: false } },
  ];
}
function axisTip(params, extra = {}) { // shared tooltip that skips helper series
  if (!params.length) return "";
  const d = params[0].axisValueLabel || params[0].name;
  let h = `<b>${typeof params[0].value?.[0] === "string" ? longLabel(params[0].value[0]) : d}</b>`;
  params.forEach((p) => {
    if (p.seriesName.endsWith("_lo") || p.seriesName in extra || p.value == null) return;
    const v = Array.isArray(p.value) ? p.value[1] : p.value;
    if (v == null) return;
    h += `<br>${p.marker}${p.seriesName}: <b>${fmt(v)}</b>`;
  });
  return h;
}

// ---------- shell: theme, menu, router ----------
const root = document.documentElement;
const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
$("#themeBtn").addEventListener("click", () => {
  root.dataset.theme = isDark() ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch (e) { /* storage blocked */ }
  render(true);
});
const side = $("#side"), scrim = $("#scrim"), menuBtn = $("#menuBtn");
const setMenu = (open) => { side.classList.toggle("open", open); scrim.classList.toggle("open", open); menuBtn.setAttribute("aria-expanded", open); };
menuBtn.addEventListener("click", () => setMenu(!side.classList.contains("open")));
scrim.addEventListener("click", () => setMenu(false));

const ROUTES = {};
const TITLES = { "": "Overview", live: "Next 7 days", track: "Track record", planner: "Power planner", whatif: "Heatwave what-if",
  forecast: "Forecast explorer", models: "Models", data: "Data explorer", method: "Methodology", about: "About" };
function render(keepScroll) {
  const r = location.hash.replace(/^#\/?/, "");
  const key = r in TITLES ? r : "";
  clearCharts();
  const v = $("#view");
  v.innerHTML = "";
  (ROUTES[key] || ROUTES[""])(v);
  $$(".menu a").forEach((a) => a.classList.toggle("on", a.dataset.r === key));
  document.title = (key ? TITLES[key] + " · " : "") + "Delhi Peak Demand";
  setMenu(false);
  if (!keepScroll) scrollTo(0, 0);
}
addEventListener("hashchange", () => render());

function seg(el, cb) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", el).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
    cb(b.dataset.v);
  });
}
const header = (eyebrow, title, lead) => `<div class="ph"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}</div>`;
const explain = (summary, body, open = false) => `<details class="explain"${open ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
const kpi = (l, v, s, cls = "", vcls = "") => `<div class="card kpi ${cls}"><div class="l">${l}</div><div class="v ${vcls}">${v}</div><div class="s">${s}</div></div>`;

// ---------- recommended actions for a heat-spike alert ----------
function actionsPanel(alertDays, thr, peakHour, season) {
  const on = alertDays.length > 0;
  const days = on ? alertDays.map((d) => dayLabel(d.date)).join(", ") : "an alert day";
  const worst = on ? alertDays.reduce((a, b) => (b.plan95 > a.plan95 ? b : a)) : null;
  const win = `${hh(peakHour - 1)}–${hh(peakHour + 2)}`;
  return `<div class="card"><div class="card-h"><h3>${on ? "Recommended actions" : "No action needed"}</h3>
    <span class="muted">${season} peaks usually come around ${hh(peakHour)}</span></div>
    <div class="actions ${on ? "" : "idle"}">
      <div class="action"><span class="n">1</span><h4>Book extra power</h4><p>${on
        ? `Line up to <b>${fmt(worst.plan95)} MW</b> for ${dayLabel(worst.date)} (the 95% plan, ${fmt(worst.plan95 - worst.mw)} MW above the forecast) in the day-ahead market, so a hotter afternoon is covered.`
        : "On an alert day, schedule the 95% plan in the day-ahead market instead of the usual level."}</p></div>
      <div class="action"><span class="n">2</span><h4>Demand-response request</h4><p>${on
        ? `Ask large users (offices, malls, industry) to cut or shift load between <b>${win}</b> on ${days}.`
        : `Ask large users to shift load away from ${win} on ${days}.`}</p></div>
      <div class="action"><span class="n">3</span><h4>Consumer advisory</h4><p>${on
        ? `The evening before ${days}, ask households to pre-cool rooms, keep ACs at 24–26 °C and avoid heavy appliances between ${win}.`
        : "Send an advisory the evening before, asking homes to use less power at the peak hour."}</p></div>
    </div>
    <p class="note">Alert line: ${fmt(thr)} MW, the 95th percentile of ${season.toLowerCase()} peaks over the last two years.</p></div>`;
}

// ---------- live status pill ----------
function setPill() {
  const L = D.latest;
  [$("#livePill"), $("#livePillSm")].forEach((p) => {
    if (!p) return;
    if (!L) { p.className = "live-pill" + (p.id.endsWith("Sm") ? " sm" : ""); p.lastElementChild.textContent = "Live data unavailable"; return; }
    p.className = "live-pill " + L.status + (p.id.endsWith("Sm") ? " sm" : "");
    const d = L.issued_at.slice(0, 10);
    p.lastElementChild.textContent = L.status === "ok" ? `Live · updated ${dayLabel(d)}` : "Data delayed";
  });
}

// ================= Overview =================
ROUTES[""] = (v) => {
  const L = D.latest, S = D.site;
  const alerts = L ? L.days.filter((d) => d.alert) : [];
  const first = L ? L.days[0] : null;
  const tr = D.log ? D.log.summary : null;
  v.innerHTML = `
  <section class="hero">
    <p class="eyebrow">CSET369 Time Series Analysis · Bennett University</p>
    <h1>Forecasting Delhi's <em>daily peak electricity demand</em></h1>
    <p>Every morning this app downloads yesterday's real grid data and today's weather forecast, runs a tested machine-learning model and publishes Delhi's peak demand for the next 7 days. It then turns that forecast into decisions: how much power to buy, and what to do before a heat spike.</p>
    <div class="row"><a class="btn primary" href="#/live">See the next 7 days</a><a class="btn" href="#/planner">Plan power purchase</a><a class="btn" href="#/whatif">Try a heatwave</a></div>
  </section>
  <div class="grid g4">
    ${first ? kpi(dayLabel(first.date), fmt(first.mw) + " MW", `forecast peak · 90% range ${fmt(first.lo)}–${fmt(first.hi)}`, "hl") : kpi("Live forecast", "–", "not available")}
    ${kpi("Heat-spike alert", alerts.length ? plural(alerts.length, "day") : "None", alerts.length ? alerts.map((d) => dayLabel(d.date)).join(", ") : "no day above the alert line this week", "", alerts.length ? "red" : "green")}
    ${kpi("Live track record", tr && tr.mape != null ? tr.mape.toFixed(2) + "%" : "Started", tr && tr.mape != null ? `average error over ${plural(tr.scored_days, "scored day")}` : `first live forecast ${L ? dayLabel(L.issued_at.slice(0, 10)) : ""}; scores start next day`)}
    ${kpi("Tested error, 2026", "5.68%", "XGBoost with real weather forecasts, 278 days")}
  </div>
  <div class="grid g-2-1">
    <div class="card"><div class="card-h"><h3>Next 7 days</h3><a class="small" href="#/live">Details →</a></div><div class="chart" id="ovChart"></div></div>
    <div class="card"><h3>Today's run</h3>${L ? `
      <ul class="list" style="margin-top:10px">
        <li><b>Issued:</b> ${L.issued_at}</li>
        <li><b>Grid data up to:</b> ${longLabel(L.origin)} (Delhi SLDC)</li>
        <li><b>Weather:</b> GFS forecast, corrected for its recent bias</li>
        <li><b>Model:</b> XGBoost, 7 boosters (one per day ahead)</li>
        <li><b>Status:</b> ${L.status === "ok" ? '<span class="pill g">on time</span>' : '<span class="pill a">data delayed</span>'}</li>
        <li><b>Next update:</b> every day at about 07:00 IST</li>
      </ul>` : '<p class="muted">The live forecast file could not be loaded.</p>'}
    </div>
  </div>
  <div class="grid g3">
    ${[["live", "Next 7 days", "The live forecast with its 90% range, the heat-spike alert and what to do about it.", '<path d="M3 17l5-6 4 4 5-7 4 5"/>'],
      ["planner", "Power planner", "How many MW to line up for a day, at the safety level you choose, with the cost of getting it wrong.", '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 15v-3M12 15V9M16 15v-5"/>'],
      ["whatif", "Heatwave what-if", "Make the week hotter and watch the real model re-forecast in your browser.", '<path d="M12 3v11.5"/><path d="M8.5 17.5a3.5 3.5 0 1 0 7 0c0-1.3-.7-2.4-1.7-3V5a1.8 1.8 0 0 0-3.6 0v9.5c-1 .6-1.7 1.7-1.7 3z"/>'],
      ["track", "Track record", "Every live forecast is saved and scored against the real peak the next morning.", '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>'],
      ["forecast", "Forecast explorer", "Replay any week of 2026 and compare what 12 models predicted with what happened.", '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 15l3-4 3 2 4-6"/>'],
      ["models", "Models & data", "Interactive model comparison, error by horizon and month, and the 2,123-day data set.", '<path d="M5 20V10M12 20V4M19 20v-7"/>']]
      .map(([r, t, p, ic]) => `<a class="card feature" href="#/${r}"><span class="ico"><svg viewBox="0 0 24 24">${ic}</svg></span><h3>${t}</h3><p>${p}</p><span class="go">Open →</span></a>`).join("")}
  </div>`;
  if (L) liveChart($("#ovChart"), L, false);
};

function liveChart(el, L, full) {
  const recent = L.recent.slice(full ? 0 : -14).map((r) => [r.date, r.mw]);
  const last = L.recent[L.recent.length - 1];
  const fc = [[last.date, last.mw], ...L.days.map((d) => [d.date, d.mw])];
  const lo = L.days.map((d) => [d.date, d.lo]), hi = L.days.map((d) => [d.date, d.hi]);
  const c = mk(el);
  c.setOption(base({
    tooltip: { ...base().tooltip, formatter: (ps) => {
      const p = ps[0], day = L.days.find((d) => d.date === p.value[0]);
      let h = axisTip(ps);
      if (day) h += `<br>90% range: ${fmt(day.lo)}–${fmt(day.hi)}<br>Max temp (forecast): ${day.tmax} °C`;
      return h;
    } },
    xAxis: xTime(), yAxis: yVal({ name: "MW" }),
    series: [
      ...bandSeries("90% range", lo, hi, css("band")),
      { name: "Actual", type: "line", data: recent, symbol: "circle", symbolSize: 5, lineStyle: { width: 2.4, color: css("actual") }, itemStyle: { color: css("actual") } },
      { name: "Forecast", type: "line", data: fc, symbol: "circle", symbolSize: 7, lineStyle: { width: 2.6, color: css("amber") }, itemStyle: { color: css("amber") },
        markLine: thrLine(L.threshold), markArea: { silent: true, itemStyle: { color: css("surface-2"), opacity: 0.6 }, data: [[{ xAxis: L.days[0].date }, { xAxis: L.days[6].date }]] } },
    ],
  }));
}

// ================= Next 7 days =================
ROUTES.live = (v) => {
  const L = D.latest;
  if (!L) { v.innerHTML = header("Live forecast", "Next 7 days for Delhi") + '<div class="card empty">The live forecast file could not be loaded.</div>'; return; }
  const alerts = L.days.filter((d) => d.alert);
  const status = L.status === "ok"
    ? `<div class="banner info"><span class="ic">i</span><div>Issued <b>${L.issued_at}</b>, using grid data up to <b>${longLabel(L.origin)}</b>. The next update runs automatically tomorrow at about 07:00 IST.</div></div>`
    : `<div class="banner warn"><span class="ic">!</span><div><b class="t">Data delayed:</b> no new grid data could be downloaded from Delhi SLDC (last day: ${longLabel(L.origin)}). The forecast below is the last one made; it will refresh as soon as data arrives.</div></div>`;
  const alertBanner = alerts.length
    ? `<div class="banner alert"><span class="ic">!</span><div><b class="t">Heat-spike alert:</b> ${plural(alerts.length, "day")} above the alert line of ${fmt(L.threshold)} MW: ${alerts.map((d) => dayLabel(d.date)).join(", ")}.</div></div>`
    : `<div class="banner ok"><span class="ic">✓</span><div><b class="t">No heat-spike alert:</b> all 7 days are forecast below the ${L.season.toLowerCase()} alert line of ${fmt(L.threshold)} MW.</div></div>`;
  v.innerHTML = header("Live forecast", "Next 7 days for Delhi",
    "Updated every morning by an automatic job: it downloads yesterday's grid data, today's weather forecast, and runs the XGBoost model that scored best on 2026 data.") +
    status + alertBanner + `
    <div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Peak demand: last 4 weeks and next 7 days</h3><span class="muted">MW · shaded band = 90% range</span></div><div class="chart lg" id="liveChart"></div></div>
    <div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Day by day</h3><a class="btn" href="data/forecast_latest.json" download>${ICON.dl}JSON</a></div>
      <div class="tw"><table class="t"><thead><tr><th>Day</th><th class="n">Forecast<small>MW</small></th><th class="n">90% range<small>MW</small></th><th class="n">Plan 90%<small>MW to line up</small></th>
      <th class="n">Max °C<small>corrected</small></th><th class="n">Max °C<small>raw GFS</small></th><th class="n">Humidity<small>%</small></th><th>Note</th></tr></thead><tbody>
      ${L.days.map((d) => `<tr><td>${dayLabel(d.date)}</td><td class="n ${d.alert ? "hot" : ""}"><b>${fmt(d.mw)}</b></td><td class="n">${fmt(d.lo)}–${fmt(d.hi)}</td><td class="n">${fmt(d.plan["90"])}</td>
        <td class="n">${d.tmax}</td><td class="n muted">${d.tmax_raw ?? "–"}</td><td class="n">${fmt(d.humidity)}</td><td>${d.alert ? '<span class="pill r">alert</span>' : ""}${d.holiday ? '<span class="pill b">holiday</span>' : ""}</td></tr>`).join("")}
      </tbody></table></div></div>` +
    actionsPanel(alerts.map((d) => ({ date: d.date, mw: d.mw, plan95: d.plan["95"] })), L.threshold, L.peak_hour, L.season) +
    `<div style="height:16px"></div>` +
    explain("How is this forecast made?", `<ul>
      <li><b>Grid data:</b> the job reads Delhi SLDC's 5-minute load table for every new day, removes glitches and keeps the day's peak.</li>
      <li><b>Weather:</b> it takes today's GFS weather forecast for New Delhi. GFS runs a few degrees too warm here, so each day is corrected by how wrong that forecast lead was over the last 30 days (compare the two Max °C columns).</li>
      <li><b>Model:</b> seven XGBoost models, one for each day ahead, trained on 2021–2025 and tested on all of 2026 (5.68% average error). They predict the ratio to last week's average peak, so they can go above old records.</li>
      <li><b>Range and plan:</b> the 90% range and the planning levels come from the model's errors on 2025.</li>
      <li><b>Alert:</b> a day is flagged when its forecast is above the 95th percentile of the season's peaks in the last two years.</li></ul>`);
  liveChart($("#liveChart"), L, true);
};

// ================= Track record =================
ROUTES.track = (v) => {
  const G = D.log;
  if (!G) { v.innerHTML = header("Live", "Track record") + '<div class="card empty">The forecast log could not be loaded.</div>'; return; }
  const S = G.summary, E = G.entries;
  const firstIssue = E.length ? E[0].issued_at.slice(0, 10) : null;
  const rows = E.flatMap((e) => e.days.map((d) => ({ ...d, issued: e.issued_at.slice(0, 10), origin: e.origin })));
  const scored = rows.filter((r) => r.actual != null);
  const bt = D.site.horizon["XGBoost (direct) | forecast"];
  v.innerHTML = header("Live", "Track record",
    "Every forecast the live job makes is saved. Each morning it fills in yesterday's real peak, so you can see how the model does on days it has never seen, not just in a backtest.") +
    (S.scored_days ? "" : `<div class="banner info"><span class="ic">i</span><div>The live log started on <b>${firstIssue ? longLabel(firstIssue) : "–"}</b>. The first real peak arrives with the next morning's run, and the scores below fill in day by day.</div></div>`) + `
    <div class="grid g4">
      ${kpi("Forecasts issued", E.length, "one 7-day forecast per day")}
      ${kpi("Days scored", S.scored_days, "forecast days with a real peak")}
      ${kpi("Live average error", S.mape != null ? S.mape.toFixed(2) + "%" : "–", "MAPE over all scored days", "hl")}
      ${kpi("Inside 90% range", S.in_range_pct != null ? S.in_range_pct + "%" : "–", "share of real peaks inside the range")}
    </div>
    <div class="grid g-2-1">
      <div class="card"><div class="card-h"><h3>Live forecasts vs real peak</h3><span class="muted">MW</span></div><div class="chart" id="trChart"></div></div>
      <div class="card"><div class="card-h"><h3>Error by days ahead</h3><span class="muted">MAPE %</span></div><div class="chart" id="trH"></div></div>
    </div>
    <div class="card"><div class="card-h"><h3>Forecast log</h3><a class="btn" href="data/forecast_log.json" download>${ICON.dl}Full log (JSON)</a></div>
      <div class="tw"><table class="t"><thead><tr><th>Issued</th><th>For day</th><th class="n">Days ahead</th><th class="n">Forecast</th><th class="n">90% range</th><th class="n">Real peak</th><th class="n">Error</th></tr></thead><tbody>
      ${rows.slice().reverse().slice(0, 70).map((r) => `<tr><td>${dayLabel(r.issued)}</td><td>${dayLabel(r.date)}</td><td class="n">${r.h}</td><td class="n">${fmt(r.mw)}</td><td class="n">${fmt(r.lo)}–${fmt(r.hi)}</td>
        <td class="n">${r.actual != null ? fmt(r.actual) : '<span class="muted">waiting</span>'}</td><td class="n ${r.error_pct == null ? "" : Math.abs(r.error_pct) <= 5 ? "good" : Math.abs(r.error_pct) > 10 ? "bad" : ""}">${r.error_pct != null ? (r.error_pct > 0 ? "+" : "") + r.error_pct.toFixed(1) + "%" : "–"}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  const actual = {}; scored.forEach((r) => (actual[r.date] = r.actual));
  const byH = (h) => rows.filter((r) => r.h === h).map((r) => [r.date, r.mw]).sort();
  const c = mk($("#trChart"));
  c.setOption(base({
    tooltip: { ...base().tooltip, formatter: (ps) => axisTip(ps) },
    xAxis: xTime(), yAxis: yVal({ name: "MW" }),
    series: [
      { name: "Real peak", type: "line", data: Object.entries(actual).sort(), lineStyle: { width: 2.6, color: css("actual") }, itemStyle: { color: css("actual") }, symbolSize: 6 },
      { name: "1 day ahead", type: "line", data: byH(1), lineStyle: { color: css("amber"), width: 2 }, itemStyle: { color: css("amber") }, symbolSize: 6 },
      { name: "3 days ahead", type: "line", data: byH(3), lineStyle: { color: css("teal"), width: 1.6 }, itemStyle: { color: css("teal") }, symbolSize: 5 },
      { name: "7 days ahead", type: "line", data: byH(7), lineStyle: { color: css("purple"), width: 1.6, type: "dashed" }, itemStyle: { color: css("purple") }, symbolSize: 5 },
    ],
  }));
  const h = mk($("#trH"));
  h.setOption(base({
    tooltip: { ...base().tooltip, valueFormatter: (x) => (x == null ? "no data yet" : x.toFixed(2) + "%") },
    xAxis: xCat([1, 2, 3, 4, 5, 6, 7].map((i) => i + "d")), yAxis: yVal({ axisLabel: { color: css("muted"), formatter: "{value}%" }, scale: false }),
    series: [
      { name: "Live", type: "bar", data: [1, 2, 3, 4, 5, 6, 7].map((i) => S.mape_by_h[i]), itemStyle: { color: css("amber"), borderRadius: [4, 4, 0, 0] } },
      { name: "2026 backtest", type: "bar", data: bt, itemStyle: { color: css("grey"), borderRadius: [4, 4, 0, 0] } },
    ],
  }));
};

// ================= Power planner =================
const PL = { key: null, level: "90", costs: null };
function planDays() { // options: live days + 2026 backtest days
  const out = [];
  if (D.latest) D.latest.days.forEach((d) => out.push({ id: "L" + d.date, group: "live", date: d.date, h: d.h, f: d.mw, actual: null,
    label: `${longLabel(d.date)} · live forecast` }));
  D.planner.rows.forEach(([o, d, h, a, fx, fn]) => out.push({ id: o + d, group: "bt", date: d, h, f: fx, fn, actual: a, origin: o,
    label: `${longLabel(d)} · made ${dayLabel(o)} (${h}d ahead)` }));
  return out;
}
function planScore(costs, level) { // 2026 policy backtest, same rules as the Python script
  const P = D.planner, q = (m) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((h) => [h, quantile(P.val_errors[m][h], level / 100)]));
  const qx = q("xgb"), qn = q("naive");
  const acc = () => ({ shortage_days: 0, short: 0, surplus: 0, margin: 0, n: 0 });
  const r = { xgb: acc(), naive_same: acc(), naive_own: acc() };
  P.rows.forEach(([, , h, a, fx, fn]) => {
    const px = fx * Math.exp(qx[h]);
    const plans = { xgb: px, naive_same: fn + (px - fx), naive_own: fn * Math.exp(qn[h]) };
    for (const k in plans) {
      const gap = a - plans[k], s = r[k];
      if (gap > 0) { s.shortage_days++; s.short += gap; } else s.surplus -= gap;
      s.margin += plans[k] - (k === "xgb" ? fx : fn); s.n++;
    }
  });
  for (const k in r) {
    const s = r[k];
    s.shortfall_mwh = s.short * costs.peak_hours; s.surplus_mwh = s.surplus * costs.peak_hours;
    s.cost_cr = (s.shortfall_mwh * costs.shortfall_rs_mwh + s.surplus_mwh * costs.surplus_rs_mwh) / 1e7;
    s.avg_margin = s.margin / s.n;
  }
  return r;
}
ROUTES.planner = (v) => {
  const P = D.planner;
  if (!PL.costs) PL.costs = { ...P.costs };
  const opts = planDays();
  if (!PL.key || !opts.find((o) => o.id === PL.key)) PL.key = opts[0].id;
  v.innerHTML = header("Decide", "Power purchase planner",
    "Delhi's power companies must line up power a day ahead. Line up too little and they pay high real-time prices or cut supply; too much and they pay for power nobody uses. Pick a day and how safe you want to be: the planner adds a safety margin learned from the model's own past errors.") + `
    <div class="card" style="margin-bottom:16px">
      <div class="controls">
        <div class="ctl grow"><label for="plDay">Day to plan</label><select id="plDay">
          ${D.latest ? `<optgroup label="Live forecast (next 7 days)">${opts.filter((o) => o.group === "live").map((o) => `<option value="${o.id}">${o.label}</option>`).join("")}</optgroup>` : ""}
          <optgroup label="2026 backtest (real peak known)">${opts.filter((o) => o.group === "bt").map((o) => `<option value="${o.id}">${o.label}</option>`).join("")}</optgroup>
        </select></div>
        <div class="ctl"><span class="lbl">Safety level</span><div class="seg" id="plLevel">${P.levels.map((l) => `<button data-v="${l}" class="${l === PL.level ? "on" : ""}">${l}%</button>`).join("")}</div></div>
      </div>
      <div class="controls" style="margin-bottom:0">
        <div class="ctl"><label for="cS">Shortfall cost (₹/MWh)</label><input type="number" id="cS" min="0" step="500" value="${PL.costs.shortfall_rs_mwh}"></div>
        <div class="ctl"><label for="cX">Surplus cost (₹/MWh)</label><input type="number" id="cX" min="0" step="500" value="${PL.costs.surplus_rs_mwh}"></div>
        <div class="ctl"><label for="cH">Peak hours per day</label><input type="number" id="cH" min="1" max="24" step="1" value="${PL.costs.peak_hours}"></div>
        <div class="ctl"><button class="link-btn" id="cReset">Reset assumptions</button></div>
      </div>
      <p class="note">Assumptions (edit them): a shortfall is bought in the real-time market at the shortfall price for the peak hours; unused power costs the surplus price. Defaults: ₹${fmt(P.costs.shortfall_rs_mwh)} and ₹${fmt(P.costs.surplus_rs_mwh)} per MWh, ${P.costs.peak_hours} peak hours.</p>
    </div>
    <div class="grid g4" id="plKpis"></div>
    <div class="grid g-2-1">
      <div class="card"><div class="card-h"><h3>What the peak could be</h3><span class="muted">from the model's 2025 errors at this many days ahead</span></div><div class="chart" id="plDist"></div></div>
      <div class="card" id="plOutcome"></div>
    </div>
    <div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Does the plan work? Backtest over 2026</h3><a class="btn" href="data/results/planner_backtest_2026.csv" download>${ICON.dl}CSV</a></div>
      <p class="muted small" style="margin-top:-4px">Each plan was made on the forecast day for the next 7 days (278 days). The model plan is compared with a simple rule: <b>last week's peak + the same margin</b>, and with last week's peak + its own error margin at the same safety level.</p>
      <div id="plSummary"></div>
      <div class="grid g2" style="margin:0"><div class="chart sm" id="plCost"></div><div class="chart sm" id="plDaysC"></div></div>
      <div class="tw" id="plTable"></div>
    </div>` +
    explain("How the planner works", `<ul>
      <li><b>Safety level:</b> at 90% the planned amount should cover the real peak on about 9 days in 10. It is the forecast times the 90th percentile of (real ÷ forecast) seen on 2025 for the same number of days ahead.</li>
      <li><b>Expected shortfall and surplus:</b> each 2025 error is applied to today's forecast to get a possible real peak; the planner averages how short or long the plan would be.</li>
      <li><b>Backtest:</b> the same rule run over every 2026 day, using only margins learned on 2025. The default costs reproduce the Python backtest exactly.</li></ul>`);
  const upd = () => drawPlanner();
  $("#plDay").value = PL.key;
  $("#plDay").addEventListener("change", (e) => { PL.key = e.target.value; upd(); });
  seg($("#plLevel"), (l) => { PL.level = l; upd(); });
  [["cS", "shortfall_rs_mwh"], ["cX", "surplus_rs_mwh"], ["cH", "peak_hours"]].forEach(([id, k]) =>
    $("#" + id).addEventListener("input", (e) => { const x = parseFloat(e.target.value); if (x >= 0) { PL.costs[k] = x; upd(); } }));
  $("#cReset").addEventListener("click", () => { PL.costs = { ...P.costs }; $("#cS").value = P.costs.shortfall_rs_mwh; $("#cX").value = P.costs.surplus_rs_mwh; $("#cH").value = P.costs.peak_hours; upd(); });
  upd();
};
function drawPlanner() {
  const P = D.planner, o = planDays().find((x) => x.id === PL.key), lvl = +PL.level, c = PL.costs;
  const errs = P.val_errors.xgb[o.h], plan = o.f * Math.exp(quantile(errs, lvl / 100));
  const outcomes = errs.map((e) => o.f * Math.exp(e));
  const expShort = mean(outcomes.map((a) => Math.max(0, a - plan))), expSur = mean(outcomes.map((a) => Math.max(0, plan - a)));
  const pShort = outcomes.filter((a) => a > plan).length / outcomes.length;
  const rs = (mw, price) => (mw * c.peak_hours * price) / 1e5; // ₹ lakh
  $("#plKpis").innerHTML =
    kpi("Forecast peak", fmt(o.f) + " MW", `${dayLabel(o.date)} · ${o.h} day${o.h > 1 ? "s" : ""} ahead`) +
    kpi(`Line up (${lvl}% plan)`, fmt(plan) + " MW", `safety margin ${fmt(plan - o.f)} MW`, "hl") +
    kpi("Expected shortfall", fmt(expShort) + " MW", `≈ ₹${fmt(rs(expShort, c.shortfall_rs_mwh), 1)} lakh · short on ${Math.round(pShort * 100)}% of past cases`) +
    kpi("Expected surplus", fmt(expSur) + " MW", `≈ ₹${fmt(rs(expSur, c.surplus_rs_mwh), 1)} lakh of unused power`);
  // distribution of possible peaks
  const lo = Math.floor(Math.min(...outcomes, plan) / 100) * 100, hi = Math.ceil(Math.max(...outcomes, plan, o.actual || 0) / 100) * 100;
  const bins = []; for (let x = lo; x < hi; x += 100) bins.push(x);
  const counts = bins.map((b) => outcomes.filter((a) => a >= b && a < b + 100).length);
  const ch = mk($("#plDist"));
  const mlData = [{ xAxis: String(Math.floor(plan / 100) * 100), name: "plan", lineStyle: { color: css("amber"), width: 2.5 }, label: { formatter: `plan ${fmt(plan)}`, color: css("amber-text"), position: "end" } }];
  if (o.actual != null) mlData.push({ xAxis: String(Math.floor(o.actual / 100) * 100), lineStyle: { color: css("actual"), width: 2, type: "solid" }, label: { formatter: `real ${fmt(o.actual)}`, color: css("text"), position: "end", distance: 16 } });
  ch.setOption(base({
    legend: { show: false },
    tooltip: { ...base().tooltip, trigger: "axis", formatter: (ps) => `${fmt(+ps[0].name)}–${fmt(+ps[0].name + 100)} MW<br>${ps[0].value} of ${outcomes.length} past cases` },
    xAxis: xCat(bins.map(String), { axisLabel: { color: css("muted"), formatter: (x) => fmt(+x), hideOverlap: true }, name: "possible peak (MW)", nameLocation: "middle", nameGap: 28 }),
    yAxis: yVal({ scale: false, minInterval: 1 }),
    grid: { left: 8, right: 14, top: 44, bottom: 34, containLabel: true },
    series: [{ type: "bar", barCategoryGap: "8%", data: counts.map((n, i) => ({ value: n, itemStyle: { color: bins[i] + 50 > plan ? css("red") : css("grey"), borderRadius: [3, 3, 0, 0] } })),
      markLine: { silent: true, symbol: "none", label: { fontSize: 11, fontWeight: 600 }, data: mlData } }],
  }));
  // outcome card
  $("#plOutcome").innerHTML = o.actual == null
    ? `<h3>What happens next</h3><p class="muted" style="margin-top:8px">This is a live forecast; the real peak for ${dayLabel(o.date)} will appear on the <a href="#/track">Track record</a> page the morning after.</p>
       <p class="muted">Red bars are outcomes where the plan would fall short. Raising the safety level moves the plan right: fewer shortfalls, more unused power.</p>`
    : (() => {
      const gap = o.actual - plan, short = gap > 0;
      const cost = short ? rs(gap, c.shortfall_rs_mwh) : rs(-gap, c.surplus_rs_mwh);
      return `<h3>What really happened</h3><div class="stat-big" style="margin:10px 0 4px;font:700 2rem 'Space Grotesk'">${fmt(o.actual)} MW</div>
        <p class="muted">real peak on ${longLabel(o.date)}</p>
        <div class="banner ${short ? "alert" : "ok"}" style="margin:8px 0 0"><span class="ic">${short ? "!" : "✓"}</span><div>${short
          ? `<b class="t">Short by ${fmt(gap)} MW.</b> Buying it at peak time costs about ₹${fmt(cost, 1)} lakh.`
          : `<b class="t">Covered</b> with ${fmt(-gap)} MW to spare (≈ ₹${fmt(cost, 1)} lakh of unused power).`}</div></div>`;
    })();
  // backtest summary
  const r = planScore(c, lvl);
  const x = r.xgb, s = r.naive_same, n = r.naive_own;
  const fewer = s.shortage_days - x.shortage_days, saved = s.cost_cr - x.cost_cr;
  $("#plSummary").innerHTML = `<div class="banner ${saved >= 0 ? "ok" : "warn"}"><span class="ic">${saved >= 0 ? "✓" : "!"}</span><div>At the <b>${lvl}%</b> level, the model plan was short on <b>${x.shortage_days}</b> of ${x.n} days, against <b>${s.shortage_days}</b> for "last week + the same margin" (${fewer >= 0 ? fewer + " shortage days avoided" : -fewer + " more shortage days"}), and cost <b>₹${fmt(Math.abs(saved), 1)} crore ${saved >= 0 ? "less" : "more"}</b> over 2026 with these assumptions.</div></div>`;
  const names = { xgb: "Model plan (XGBoost)", naive_same: "Last week + same margin", naive_own: "Last week + own margin" };
  const cols = { xgb: css("amber"), naive_same: css("grey"), naive_own: css("faint") };
  const all = Object.fromEntries(P.levels.map((l) => [l, planScore(c, +l)]));
  const barOpt = (title, f, unit) => base({
    title: { text: title, left: 0, top: 0, textStyle: { fontSize: 13, color: css("text"), fontWeight: 600 } },
    legend: { top: 22, left: 0, textStyle: { color: css("muted"), fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    grid: { left: 8, right: 10, top: 62, bottom: 6, containLabel: true },
    tooltip: { ...base().tooltip, valueFormatter: (v) => fmt(v, unit === "cr" ? 1 : 0) + (unit === "cr" ? " crore" : " days") },
    xAxis: xCat(P.levels.map((l) => l + "%")), yAxis: yVal({ scale: false, axisLabel: { color: css("muted"), formatter: (v) => (unit === "cr" ? "₹" + v : v) } }),
    series: Object.keys(names).map((k) => ({ name: names[k], type: "bar", data: P.levels.map((l) => +f(all[l][k]).toFixed(2)), itemStyle: { color: cols[k], borderRadius: [3, 3, 0, 0] } })),
  });
  mkOrGet("plCost").setOption(barOpt("Total cost over 2026 (₹ crore)", (q) => q.cost_cr, "cr"), true);
  mkOrGet("plDaysC").setOption(barOpt("Shortage days in 2026", (q) => q.shortage_days, "d"), true);
  $("#plTable").innerHTML = `<table class="t" style="margin-top:12px"><thead><tr><th>Plan</th><th class="n">Shortage days</th><th class="n">Shortfall<small>MWh</small></th><th class="n">Unused<small>MWh</small></th><th class="n">Avg margin<small>MW</small></th><th class="n">Cost<small>₹ crore</small></th></tr></thead><tbody>
    ${Object.keys(names).map((k) => `<tr class="${k === "xgb" ? "hl" : ""}"><td>${names[k]}</td><td class="n">${r[k].shortage_days}</td><td class="n">${fmt(r[k].shortfall_mwh)}</td><td class="n">${fmt(r[k].surplus_mwh)}</td><td class="n">${fmt(r[k].avg_margin)}</td><td class="n"><b>${fmt(r[k].cost_cr, 2)}</b></td></tr>`).join("")}
  </tbody></table>`;
}
const chartById = {};
function mkOrGet(id) {
  const el = $("#" + id), have = charts.find((c) => c.getDom() === el);
  return have || mk(el);
}

// ================= Heatwave what-if (XGBoost trees in the browser) =================
const WI = { base: "live", dT: 0, dH: 0, day: [0, 0, 0, 0, 0, 0, 0] };
async function loadTrees() {
  if (!D.web) {
    const W = await fetch("models/xgb_web.json").then((r) => r.json());
    // split thresholds are float32 in XGBoost: compare float32 against float32
    for (const h in W.horizons) W.horizons[h].trees.forEach(([f, thr]) => f.forEach((k, i) => { if (k !== -1) thr[i] = Math.fround(thr[i]); }));
    D.web = W;
  }
  return D.web;
}
function treeValue(t, x) {
  const [f, thr, L, R, DL] = t;
  let i = 0;
  while (f[i] !== -1) {
    const v = x[f[i]];
    i = v == null || Number.isNaN(v) ? (DL[i] ? L[i] : R[i]) : Math.fround(v) < thr[i] ? L[i] : R[i];
  }
  return thr[i];
}
function xgbWeek(rows, m7) { // 7 direct models -> MW
  const W = D.web;
  return rows.map((x, i) => {
    const m = W.horizons[i + 1];
    let s = m.base;
    for (const t of m.trees) s += treeValue(t, x);
    return m7 * Math.exp(s);
  });
}
function scenarioRows(rows, dT, dH) { // recompute weather-driven features exactly as in training
  const W = D.web, c = (n) => W.columns.indexOf(n);
  const I = { tmax: c("x_tmax"), tmean: c("x_tmean"), hum: c("x_humidity"), cdd: c("x_cdd"), lag: c("x_cdd_lag1"), hdd: c("x_hdd"),
    hc: c("x_humid_cdd"), dcdd: c("dcdd"), dtmax: c("dtmax") };
  const oCdd = rows[0][I.cdd] - rows[0][I.dcdd], oTmax = rows[0][I.tmax] - rows[0][I.dtmax];
  let prev = rows[0][I.lag];
  return rows.map((r, h) => {
    const x = r.slice(), tmax = r[I.tmax] + dT[h], tmean = r[I.tmean] + dT[h], hum = Math.min(100, Math.max(0, r[I.hum] + dH));
    const cdd = Math.max(0, tmean - W.cdd_base);
    Object.assign(x, { [I.tmax]: tmax, [I.tmean]: tmean, [I.hum]: hum, [I.cdd]: cdd, [I.lag]: prev, [I.hdd]: Math.max(0, W.hdd_base - tmean),
      [I.hc]: (cdd * hum) / 100, [I.dcdd]: cdd - oCdd, [I.dtmax]: tmax - oTmax });
    prev = cdd;
    return x;
  });
}
function wiBase() {
  if (WI.base === "live" && D.latest) {
    const L = D.latest;
    return { label: "Live week", origin: L.origin, dates: L.days.map((d) => d.date), rows: L.whatif.rows, m7: L.whatif.m7, thr: L.threshold,
      peakHour: L.peak_hour, season: L.season, actual: null, q95: L.days.map((d) => d.plan["95"] / d.mw) };
  }
  const o = D.site.origins[WI.base], q = D.planner.val_errors.xgb;
  return { label: longLabel(WI.base), origin: WI.base, dates: o.dates, rows: o.whatif.rows, m7: o.whatif.m7, thr: o.thr, peakHour: o.peak_hour,
    season: o.season, actual: o.actual, q95: [1, 2, 3, 4, 5, 6, 7].map((h) => Math.exp(quantile(q[h], 0.95))) };
}
ROUTES.whatif = (v) => {
  const origins = Object.keys(D.site.origins);
  if (!D.latest && WI.base === "live") WI.base = "2026-05-20";
  v.innerHTML = header("Decide", "Heatwave what-if",
    "What if the coming week turns out hotter than the forecast? Move the sliders and the real XGBoost model, all 4,200 of its decision trees, re-forecasts the peak right here in your browser. No server is involved.") + `
    <div class="card" style="margin-bottom:16px">
      <div class="controls">
        <div class="ctl"><label for="wiBase">Starting week</label><select id="wiBase">
          ${D.latest ? `<option value="live">Live week (from ${dayLabel(D.latest.origin)})</option>` : ""}
          <optgroup label="2026 weeks">${origins.map((o) => `<option value="${o}">Week after ${longLabel(o)}</option>`).join("")}</optgroup></select></div>
        <div class="ctl grow"><span class="lbl">Quick scenarios</span><div class="row" id="wiPresets">
          <button class="link-btn" data-t="0" data-h="0">As forecast</button><button class="link-btn" data-t="2" data-h="0">Warm spell +2 °C</button>
          <button class="link-btn" data-t="4" data-h="-10">Heatwave +4 °C, drier</button><button class="link-btn" data-t="6" data-h="-15">Severe heatwave +6 °C</button>
          <button class="link-btn" data-t="-3" data-h="15">Rain, cooler −3 °C</button></div></div>
      </div>
      <div class="grid g2" style="margin:0">
        <div class="ctl"><label for="wiT">Temperature change, whole week</label><div class="slider"><input type="range" id="wiT" min="-5" max="8" step="0.5" value="${WI.dT}"><output id="wiTo"></output></div></div>
        <div class="ctl"><label for="wiH">Humidity change, whole week</label><div class="slider"><input type="range" id="wiH" min="-30" max="30" step="5" value="${WI.dH}"><output id="wiHo"></output></div></div>
      </div>
      <details class="explain" style="margin:14px 0 0"><summary>Change single days</summary>
        <div class="days-sliders" id="wiDays"></div><p class="note">Added on top of the whole-week change.</p></details>
    </div>
    <div id="wiOut"><div class="card empty"><span class="spin"></span>Loading the model (4,200 trees, about 1 MB compressed)…</div></div>` +
    explain("What happens when you move a slider?", `<ul>
      <li>The forecast temperatures (maximum and mean) and humidity of the chosen days change by your amounts.</li>
      <li>The model's weather inputs are rebuilt from them, exactly as in training: cooling and heating degree-days, yesterday's heat, and how much hotter each day is than today.</li>
      <li>All seven XGBoost models (one per day ahead, 600 trees each) are evaluated again in JavaScript. With no change, the result equals the Python forecast.</li>
      <li>Tree models cannot go beyond what they saw in training: the hottest training day was <span id="wiMax">–</span> °C, so above that the forecast stops rising. This is a known limit, not a bug.</li></ul>`);
  $("#wiBase").value = WI.base;
  const go = () => drawWhatIf();
  $("#wiBase").addEventListener("change", (e) => { WI.base = e.target.value; go(); });
  $("#wiT").addEventListener("input", (e) => { WI.dT = +e.target.value; go(); });
  $("#wiH").addEventListener("input", (e) => { WI.dH = +e.target.value; go(); });
  $("#wiPresets").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    WI.dT = +b.dataset.t; WI.dH = +b.dataset.h; WI.day = [0, 0, 0, 0, 0, 0, 0];
    $("#wiT").value = WI.dT; $("#wiH").value = WI.dH; $$("#wiDays input").forEach((i) => (i.value = 0)); go();
  });
  loadTrees().then(() => { if ($("#wiOut")) go(); }).catch(() => { $("#wiOut").innerHTML = '<div class="card empty">The model file could not be loaded.</div>'; });
};
function drawWhatIf() {
  if (!D.web || !$("#wiOut")) return;
  const B = wiBase();
  $("#wiTo").textContent = (WI.dT > 0 ? "+" : "") + WI.dT + " °C";
  $("#wiHo").textContent = (WI.dH > 0 ? "+" : "") + WI.dH + " %";
  $("#wiMax").textContent = D.web.train_tmax_max.toFixed(1);
  const daysEl = $("#wiDays");
  if (!daysEl.dataset.for || daysEl.dataset.for !== B.origin) {
    daysEl.dataset.for = B.origin;
    daysEl.innerHTML = B.dates.map((d, i) => `<div class="d"><output>${WI.day[i] > 0 ? "+" : ""}${WI.day[i]}</output><input type="range" min="-5" max="8" step="0.5" value="${WI.day[i]}" data-i="${i}" aria-label="Temperature change on ${dayLabel(d)}"><span>${dayLabel(d).slice(0, 6)}</span></div>`).join("");
    daysEl.addEventListener("input", (e) => { const i = +e.target.dataset.i; WI.day[i] = +e.target.value; e.target.previousElementSibling.textContent = (WI.day[i] > 0 ? "+" : "") + WI.day[i]; drawWhatIf(); });
  }
  const dT = WI.day.map((x) => x + WI.dT);
  const base0 = xgbWeek(B.rows, B.m7), scen = xgbWeek(scenarioRows(B.rows, dT, WI.dH), B.m7);
  const c = (n) => D.web.columns.indexOf(n);
  const tBase = B.rows.map((r) => r[c("x_tmax")]);
  const alerts = scen.map((v, i) => ({ date: B.dates[i], mw: v, plan95: v * B.q95[i], alert: v > B.thr })).filter((d) => d.alert);
  const changed = WI.dT !== 0 || WI.dH !== 0 || WI.day.some((x) => x !== 0);
  const out = $("#wiOut");
  out.innerHTML = `
    <div class="grid g4">
      ${kpi("Week's highest peak", fmt(Math.max(...scen)) + " MW", `as forecast: ${fmt(Math.max(...base0))} MW`, "hl")}
      ${kpi("Change in the peak", (Math.max(...scen) - Math.max(...base0) >= 0 ? "+" : "") + fmt(Math.max(...scen) - Math.max(...base0)) + " MW", `${((Math.max(...scen) / Math.max(...base0) - 1) * 100).toFixed(1)}% vs the forecast week`)}
      ${kpi("Alert days", alerts.length, `above ${fmt(B.thr)} MW`, "", alerts.length ? "red" : "green")}
      ${kpi("Extra energy at peak", fmt(scen.reduce((s, v, i) => s + Math.max(0, v - base0[i]), 0)) + " MW", "summed over the 7 days")}
    </div>
    ${alerts.length ? `<div class="banner alert"><span class="ic">!</span><div><b class="t">Heat-spike alert in this scenario:</b> ${alerts.map((d) => dayLabel(d.date)).join(", ")}.</div></div>`
      : `<div class="banner ok"><span class="ic">✓</span><div><b class="t">No alert:</b> every day stays below ${fmt(B.thr)} MW in this scenario${changed ? "" : " (try a heatwave)"}.</div></div>`}
    <div class="card" style="margin-bottom:16px"><div class="card-h"><h3>${B.label}: forecast vs scenario</h3><span class="muted">MW</span></div><div class="chart lg" id="wiChart"></div></div>
    <div class="card" style="margin-bottom:16px"><div class="tw"><table class="t"><thead><tr><th>Day</th><th class="n">Max °C<small>forecast → scenario</small></th><th class="n">Forecast<small>MW</small></th><th class="n">Scenario<small>MW</small></th><th class="n">Change<small>MW</small></th>${B.actual ? '<th class="n">Real peak<small>MW</small></th>' : ""}</tr></thead><tbody>
      ${B.dates.map((d, i) => `<tr><td>${dayLabel(d)}</td><td class="n">${tBase[i].toFixed(1)} → <b>${(tBase[i] + dT[i]).toFixed(1)}</b></td><td class="n">${fmt(base0[i])}</td><td class="n ${scen[i] > B.thr ? "hot" : ""}"><b>${fmt(scen[i])}</b></td><td class="n">${scen[i] - base0[i] >= 0 ? "+" : ""}${fmt(scen[i] - base0[i])}</td>${B.actual ? `<td class="n">${fmt(B.actual[i])}</td>` : ""}</tr>`).join("")}
    </tbody></table></div></div>` + actionsPanel(alerts, B.thr, B.peakHour, B.season);
  const ch = mk($("#wiChart"));
  const series = [
    { name: "As forecast", type: "line", data: B.dates.map((d, i) => [d, Math.round(base0[i])]), lineStyle: { color: css("grey"), width: 2, type: "dashed" }, itemStyle: { color: css("grey") }, symbolSize: 6 },
    { name: "Scenario", type: "line", data: B.dates.map((d, i) => [d, Math.round(scen[i])]), lineStyle: { color: css("red"), width: 3 }, itemStyle: { color: css("red") }, symbolSize: 8,
      areaStyle: { color: css("red-soft") }, markLine: thrLine(B.thr) },
  ];
  if (B.actual) series.push({ name: "Real peak", type: "line", data: B.dates.map((d, i) => [d, B.actual[i]]), lineStyle: { color: css("actual"), width: 2 }, itemStyle: { color: css("actual") }, symbolSize: 6 });
  ch.setOption(base({ tooltip: { ...base().tooltip, formatter: (ps) => axisTip(ps) }, xAxis: xTime(), yAxis: yVal({ name: "MW" }), series }));
}

// ================= Forecast explorer (2026 backtest) =================
const EX = { origin: "2026-05-20", wx: "f", on: new Set(["xgb", "ens", "sarimax_wx"]) };
ROUTES.forecast = (v) => {
  const keys = Object.keys(D.site.origins);
  v.innerHTML = header("Analyse", "Forecast explorer: replay 2026",
    "Every line is a real forecast from the 2026 backtest, made with only the data available on that day. Pick a forecast date and models; switch between the weather forecast that was really available and the weather that actually happened.") + `
    <div class="card" style="margin-bottom:16px">
      <div class="controls">
        <div class="ctl"><label for="exO">Forecast made on</label><div class="row"><button class="btn-sq" id="exP" aria-label="Previous week">‹</button>
          <select id="exO">${keys.map((k) => `<option value="${k}">${longLabel(k)}</option>`).join("")}</select><button class="btn-sq" id="exN" aria-label="Next week">›</button></div></div>
        <div class="ctl"><span class="lbl">Jump to</span><div class="row" id="exJ"><button class="link-btn" data-o="2026-05-20">Heat alert week</button><button class="link-btn" data-o="2026-06-24">Record week</button><button class="link-btn" data-o="2026-08-05">Monsoon</button><button class="link-btn" data-o="2026-01-07">Winter</button></div></div>
        <div class="ctl"><span class="lbl">Weather used</span><div class="seg" id="exW"><button data-v="f" class="on">Forecast</button><button data-v="o">Observed</button></div></div>
      </div>
      <div class="ctl"><span class="lbl">Models (the first one selected gets the shaded 90% range)</span><div class="chips" id="exC">
        ${MODELS.map(([k, n, c]) => `<button class="chip ${EX.on.has(k) ? "on" : ""}" data-k="${k}" style="--c:var(--${c})" aria-pressed="${EX.on.has(k)}"><i></i>${n}</button>`).join("")}</div></div>
    </div>
    <div id="exBanner"></div>
    <div class="card" style="margin-bottom:16px"><div class="chart lg" id="exChart"></div></div>
    <div class="card"><div class="card-h"><h3>Day by day</h3><span class="muted">error = (forecast − real) ÷ real</span></div><div class="tw" id="exTable"></div></div>`;
  const sel = $("#exO");
  sel.value = EX.origin;
  const go = () => { sel.value = EX.origin; const i = keys.indexOf(EX.origin); $("#exP").disabled = i === 0; $("#exN").disabled = i === keys.length - 1; drawExplorer(); };
  sel.addEventListener("change", () => { EX.origin = sel.value; go(); });
  $("#exP").addEventListener("click", () => { EX.origin = keys[Math.max(0, keys.indexOf(EX.origin) - 1)]; go(); });
  $("#exN").addEventListener("click", () => { EX.origin = keys[Math.min(keys.length - 1, keys.indexOf(EX.origin) + 1)]; go(); });
  $("#exJ").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { EX.origin = b.dataset.o; go(); } });
  seg($("#exW"), (w) => { EX.wx = w; go(); });
  $("#exC").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const k = b.dataset.k; EX.on.has(k) ? EX.on.delete(k) : EX.on.add(k);
    b.classList.toggle("on", EX.on.has(k)); b.setAttribute("aria-pressed", EX.on.has(k)); go();
  });
  $$("#exW button").forEach((b) => b.classList.toggle("on", b.dataset.v === EX.wx));
  go();
};
function drawExplorer() {
  const S = D.site, O = S.origins[EX.origin], sel = MODELS.filter(([k]) => EX.on.has(k));
  const fc = (k) => O.f[`${k}|${EX.wx}`];
  const start = parse(EX.origin), hist = [];
  const i0 = Math.round((start - parse(S.history.start)) / DAY);
  for (let i = i0 - 13; i <= i0; i++) hist.push([addDays(S.history.start, i), S.history.peak[i]]);
  const thr = O.thr, dep = fc("ens");
  const flagged = O.dates.filter((_, i) => dep[i] > thr), hot = O.dates.filter((_, i) => O.actual[i] != null && O.actual[i] > thr);
  $("#exBanner").innerHTML = flagged.length
    ? `<div class="banner alert"><span class="ic">!</span><div><b class="t">Heat-spike alert</b> from the deployed model: ${flagged.map(dayLabel).join(", ")} above ${fmt(thr)} MW. Real peaks above it: ${hot.length ? hot.map(dayLabel).join(", ") : "none"}.</div></div>`
    : hot.length ? `<div class="banner warn"><span class="ic">!</span><div><b class="t">Missed spike:</b> the deployed model kept all days below ${fmt(thr)} MW, but ${hot.map(dayLabel).join(", ")} went above it.</div></div>`
    : `<div class="banner ok"><span class="ic">✓</span><div><b class="t">No alert</b> from the deployed model, and no real peak above ${fmt(thr)} MW this week.</div></div>`;
  const series = [];
  if (sel.length) {
    const [k, , col] = sel[0], b = S.bands[`${k}|${EX.wx}`], f = fc(k);
    series.push(...bandSeries("90% range", O.dates.map((d, i) => [d, f[i] * Math.exp(b[i][0])]), O.dates.map((d, i) => [d, f[i] * Math.exp(b[i][1])]), css("band")));
  }
  series.push({ name: "Real peak", type: "line", data: [...hist, ...O.dates.map((d, i) => [d, O.actual[i]])], lineStyle: { width: 2.6, color: css("actual") }, itemStyle: { color: css("actual") }, symbolSize: 5,
    markLine: thrLine(thr), markArea: { silent: true, itemStyle: { color: css("surface-2"), opacity: 0.6 }, data: [[{ xAxis: O.dates[0] }, { xAxis: O.dates[6] }]] } });
  const last = hist[hist.length - 1];
  sel.forEach(([k, n, c]) => series.push({ name: n, type: "line", data: [last, ...O.dates.map((d, i) => [d, fc(k)[i]])], lineStyle: { width: k === "ens" || k === "xgb" ? 2.6 : 1.8, color: css(c), type: k === "naive" ? "dashed" : "solid" }, itemStyle: { color: css(c) }, symbolSize: 6 }));
  const ch = mk($("#exChart"));
  ch.setOption(base({ tooltip: { ...base().tooltip, formatter: (ps) => axisTip(ps) }, xAxis: xTime(), yAxis: yVal({ name: "MW" }), series }));
  const err = (f, a) => (a == null ? null : (100 * (f - a)) / a);
  const wk = (k) => { const e = O.actual.map((a, i) => err(fc(k)[i], a)).filter((x) => x != null).map(Math.abs); return e.length ? mean(e) : null; };
  $("#exTable").innerHTML = `<table class="t"><thead><tr><th>Day</th><th class="n">Real peak</th><th class="n">Max °C</th>${sel.map(([, n]) => `<th class="n">${n}<small>MW · error</small></th>`).join("")}</tr></thead><tbody>
    ${O.dates.map((d, i) => `<tr><td>${dayLabel(d)}</td><td class="n ${O.actual[i] > thr ? "hot" : ""}"><b>${O.actual[i] == null ? "n/a" : fmt(O.actual[i])}</b></td><td class="n">${O.tmax[i] ?? "–"}</td>
      ${sel.map(([k]) => { const f = fc(k)[i], e = err(f, O.actual[i]); return `<td class="n ${f > thr ? "hot" : ""}">${fmt(f)} <span class="${e == null ? "muted" : Math.abs(e) <= 5 ? "good" : Math.abs(e) > 10 ? "bad" : "muted"}">${e == null ? "" : (e > 0 ? "+" : "") + e.toFixed(1) + "%"}</span></td>`; }).join("")}</tr>`).join("")}
    <tr><td><b>Week error</b></td><td></td><td></td>${sel.map(([k]) => `<td class="n"><b>${wk(k) == null ? "–" : wk(k).toFixed(2) + "%"}</b></td>`).join("")}</tr></tbody></table>`;
}

// ================= Models =================
const MD = { wx: "forecast" };
ROUTES.models = (v) => {
  v.innerHTML = header("Analyse", "Model comparison",
    "Twelve models, from simple baselines to deep learning, all scored on the same 278 days of 2026 with a rolling-origin backtest. Switch between the realistic setting (the weather forecast that was available) and the ideal one (the weather that happened).") + `
    <div class="controls"><div class="seg" id="mdW"><button data-v="forecast" class="${MD.wx === "forecast" ? "on" : ""}">Realistic: forecast weather</button><button data-v="observed" class="${MD.wx === "observed" ? "on" : ""}">Ideal: observed weather</button></div></div>
    <div class="grid g4" id="mdK"></div>
    <div class="grid g2">
      <div class="card"><div class="card-h"><h3>Average error on 2026 (MAPE)</h3><span class="muted">lower is better</span></div><div class="chart lg" id="mdBar"></div></div>
      <div class="card"><div class="card-h"><h3>Error by days ahead</h3><span class="muted">click the legend to show or hide models</span></div><div class="chart lg" id="mdH"></div></div>
    </div>
    <div class="grid g2">
      <div class="card"><div class="card-h"><h3>Error by month of 2026</h3><span class="muted">forecast weather</span></div><div class="chart" id="mdM"></div></div>
      <div class="card"><div class="card-h"><h3>What XGBoost relies on</h3><span class="muted">share of total gain, top 12</span></div><div class="chart" id="mdF"></div></div>
    </div>
    <div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Full results</h3><span class="muted">RMSE, MAE in MW · summer = Apr–Jun</span></div><div class="tw" id="mdT"></div></div>
    <div class="grid g2">
      <div class="card"><h3>Heat-spike alert skill, 2026</h3><p class="muted small">38 days in 2026 had a peak above their season's alert line.</p><div class="tw" id="mdA"></div></div>
      <div class="card"><h3>Download results</h3><p class="muted small">The same CSV files the project produced.</p><div class="dl">${downloads()}</div></div>
    </div>`;
  seg($("#mdW"), (w) => { MD.wx = w; drawModels(); });
  drawModels();
};
function downloads() {
  return [["phase3_metrics.csv", "All models, both weather settings"], ["phase3_backtest.csv", "Every forecast vs actual (15k rows)"],
    ["phase3_mape_by_horizon.csv", "Error by days ahead"], ["phase3_monthly_mape.csv", "Error by month"], ["phase3_feature_importance.csv", "XGBoost feature importance"],
    ["planner_backtest_2026.csv", "Power planner backtest"], ["phase2_metrics.csv", "Phase 2 classical models"], ["stationarity.csv", "ADF / KPSS tests"]]
    .map(([f, d]) => `<a href="data/results/${f}" download>${ICON.dl}<span>${f}<small>${d}</small></span></a>`).join("");
}
function drawModels() {
  clearCharts();
  const S = D.site, rows = S.metrics.filter((m) => m.weather === MD.wx).sort((a, b) => a.MAPE - b.MAPE), best = rows[0];
  const naive = rows.find((r) => r.model === "Naive (yesterday)"), dep = rows.find((r) => r.model === DEPLOYED);
  $("#mdK").innerHTML = kpi("Best model", NAME[best.model], `${best.MAPE.toFixed(2)}% average error`, "hl") +
    kpi("Deployed by rule", dep.MAPE.toFixed(2) + "%", "LSTM + GRU ensemble, chosen on 2025") +
    kpi("Simple baseline", naive.MAPE.toFixed(2) + "%", "tomorrow = today") +
    kpi("Improvement", Math.round((1 - best.MAPE / naive.MAPE) * 100) + "%", "less error than the baseline");
  const bar = mk($("#mdBar"));
  const rr = rows.slice().reverse();
  bar.setOption(base({
    legend: { show: false }, grid: { left: 8, right: 46, top: 6, bottom: 6, containLabel: true },
    tooltip: { ...base().tooltip, trigger: "item", formatter: (p) => `<b>${p.name}</b><br>MAPE ${p.value.toFixed(2)}%` },
    xAxis: { type: "value", show: false, max: 12 }, yAxis: xCat(rr.map((r) => NAME[r.model]), { axisLabel: { color: css("text"), fontSize: narrow() ? 11 : 12 } }),
    series: [{ type: "bar", barWidth: "62%", data: rr.map((r) => ({ value: r.MAPE, itemStyle: { borderRadius: 4,
      color: r === best ? css("amber") : r.model === DEPLOYED ? css("blue") : NO_WX.has(r.model) ? css("grey") : css("teal") } })),
      label: { show: true, position: "right", formatter: (p) => p.value.toFixed(2) + "%", color: css("text"), fontSize: 11 } }],
  }));
  const hz = mk($("#mdH")), keys = S.metrics.filter((m) => m.weather === MD.wx).map((m) => m.model);
  const col = { [XGB]: "amber", [DEPLOYED]: "blue", "SARIMAX + calendar + weather": "teal", "Prophet + holidays + weather": "purple", "Naive (yesterday)": "grey",
    "LSTM (direct 7-day)": "pink", "GRU (direct 7-day)": "olive" };
  const shown = new Set([XGB, DEPLOYED, "SARIMAX + calendar + weather", "Prophet + holidays + weather", "Naive (yesterday)"]);
  hz.setOption(base({
    legend: { ...base().legend, selected: Object.fromEntries(keys.map((k) => [NAME[k], shown.has(k)])) },
    grid: { left: 8, right: 14, top: narrow() ? 64 : 40, bottom: 26, containLabel: true },
    tooltip: { ...base().tooltip, valueFormatter: (x) => x.toFixed(2) + "%" },
    xAxis: xCat([1, 2, 3, 4, 5, 6, 7].map((h) => h + (h === 1 ? " day" : "")), { boundaryGap: false }), yAxis: yVal({ scale: false, axisLabel: { color: css("muted"), formatter: "{value}%" } }),
    series: keys.map((k) => ({ name: NAME[k], type: "line", data: S.horizon[`${k} | ${MD.wx}`], symbolSize: 6,
      lineStyle: { width: k === XGB || k === DEPLOYED ? 2.6 : 1.6, ...(col[k] ? { color: css(col[k]) } : {}) }, ...(col[k] ? { itemStyle: { color: css(col[k]) } } : {}) })),
  }));
  const M = S.monthly, mm = mk($("#mdM"));
  const mcols = [["XGBoost", "amber"], ["Ensemble (LSTM + GRU)", "blue"], ["SARIMAX-wx", "teal"], ["Prophet", "purple"], ["Naive (yesterday)", "grey"]];
  mm.setOption(base({
    tooltip: { ...base().tooltip, valueFormatter: (x) => x.toFixed(2) + "%" },
    xAxis: xCat(M.months), yAxis: yVal({ scale: false, axisLabel: { color: css("muted"), formatter: "{value}%" } }),
    series: mcols.map(([k, c]) => ({ name: k === "Ensemble (LSTM + GRU)" ? "LSTM + GRU" : k === "SARIMAX-wx" ? "SARIMAX + weather" : k, type: "line", data: M[k], symbolSize: 5,
      lineStyle: { color: css(c), width: k === "XGBoost" ? 2.6 : 1.6 }, itemStyle: { color: css(c) } })),
  }));
  const FI = { dcdd: "Heat change vs. today", x_tmax: "Max temperature", x_is_weekend: "Weekend", l0: "Today vs. last week", x_is_holiday: "Holiday",
    x_cdd_lag1: "Previous day's heat", ly: "Same day last year", x_cdd: "Cooling degree-days", x_cos1: "Yearly cycle (cos)", x_tmean: "Mean temperature",
    x_sin1: "Yearly cycle (sin)", m30: "30-day level", x_dow_sin: "Day of week", x_hdd: "Heating degree-days", x_humid_cdd: "Humid heat", trend7: "Recent trend",
    x_humidity: "Humidity", lw: "Same day last week", x_dow_cos: "Day of week (cos)" };
  const fi = Object.entries(S.features).slice(0, 12).reverse(), ff = mk($("#mdF"));
  const heat = (k) => /tmax|tmean|cdd|hdd|humid/.test(k);
  ff.setOption(base({
    legend: { show: false }, grid: { left: 8, right: 44, top: 6, bottom: 6, containLabel: true },
    tooltip: { ...base().tooltip, trigger: "item", formatter: (p) => `<b>${p.name}</b><br>${p.value.toFixed(1)}% of gain` },
    xAxis: { type: "value", show: false }, yAxis: xCat(fi.map(([k]) => FI[k] || k), { axisLabel: { color: css("text"), fontSize: 11 } }),
    series: [{ type: "bar", barWidth: "60%", data: fi.map(([k, x]) => ({ value: x * 100, itemStyle: { color: heat(k) ? css("red") : css("amber"), borderRadius: 4 } })),
      label: { show: true, position: "right", formatter: (p) => p.value.toFixed(1) + "%", color: css("text"), fontSize: 11 } }],
  }));
  const by = {}; S.metrics.forEach((m) => ((by[m.model] = by[m.model] || {})[m.weather] = m));
  const tr = Object.entries(by).sort((a, b) => a[1][MD.wx].MAPE - b[1][MD.wx].MAPE);
  $("#mdT").innerHTML = `<table class="t"><thead><tr><th>Model</th><th>Type</th><th class="n">MAPE<small>forecast wx</small></th><th class="n">MAPE<small>observed wx</small></th><th class="n">RMSE</th><th class="n">MAE</th><th class="n">Summer<small>MAPE</small></th><th class="n">Val 2025<small>MAPE</small></th></tr></thead><tbody>
    ${tr.map(([n, r]) => { const m = r[MD.wx]; return `<tr class="${n === best.model ? "hl" : ""}"><td>${NAME[n]}${n === best.model ? '<span class="pill a">best</span>' : ""}${n === DEPLOYED ? '<span class="pill b">deployed</span>' : ""}</td><td class="muted">${m.family}</td>
      <td class="n"><b>${r.forecast.MAPE.toFixed(2)}</b></td><td class="n">${r.observed.MAPE.toFixed(2)}</td><td class="n">${fmt(m.RMSE)}</td><td class="n">${fmt(m.MAE)}</td><td class="n">${m.MAPE_summer.toFixed(2)}</td><td class="n">${m.MAPE_val_2025.toFixed(2)}</td></tr>`; }).join("")}</tbody></table>`;
  $("#mdA").innerHTML = `<table class="t"><thead><tr><th>Model</th><th class="n">Alerts</th><th class="n">Caught</th><th class="n">False alarms</th><th class="n">Missed</th></tr></thead><tbody>
    ${Object.entries(S.alerts).map(([k, a]) => `<tr><td>${k === "Ensemble (LSTM + GRU)" ? "LSTM + GRU" : k === "SARIMAX-wx" ? "SARIMAX + weather" : k}</td><td class="n">${a.alerts}</td><td class="n good">${a.hits}</td><td class="n">${a.false_alarms}</td><td class="n">${a.missed}</td></tr>`).join("")}</tbody></table>`;
}

// ================= Data explorer =================
const DX = { years: new Set([2021, 2022, 2023, 2024, 2025, 2026]), seasons: new Set(["Winter", "Summer", "Monsoon", "Post-monsoon"]), temp: true };
ROUTES.data = (v) => {
  const E = D.site.eda;
  v.innerHTML = header("Analyse", "Data explorer",
    `${fmt(E.days)} days of Delhi's daily peak demand (${fmt(E.raw_readings)} five-minute readings from Delhi SLDC) joined with daily weather. Drag the slider under the chart to zoom; filter by year and season.`) + `
    <div class="card" style="margin-bottom:16px">
      <div class="controls" style="margin-bottom:6px">
        <div class="ctl"><span class="lbl">Years</span><div class="chips" id="dxY">${[2021, 2022, 2023, 2024, 2025, 2026].map((y) => `<button class="chip on" data-y="${y}" style="--c:var(--amber)"><i></i>${y}</button>`).join("")}</div></div>
        <div class="ctl"><span class="lbl">Seasons</span><div class="chips" id="dxS">${[["Winter", "blue"], ["Summer", "red"], ["Monsoon", "teal"], ["Post-monsoon", "amber"]].map(([s, c]) => `<button class="chip on" data-s="${s}" style="--c:var(--${c})"><i></i>${s}</button>`).join("")}</div></div>
        <div class="ctl"><span class="lbl">Overlay</span><div class="chips"><button class="chip on" id="dxT" style="--c:var(--red)"><i></i>Max temperature</button></div></div>
      </div>
    </div>
    <div class="grid g4" id="dxK"></div>
    <div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Daily peak demand</h3><span class="muted">MW · drag or pinch to zoom</span></div><div class="chart xl" id="dxTs"></div></div>
    <div class="grid g2">
      <div class="card"><div class="card-h"><h3>Temperature vs. peak</h3><span class="muted">one dot per day</span></div><div class="chart lg" id="dxSc"></div></div>
      <div class="card"><div class="card-h"><h3>Average peak by month</h3><span class="muted">selected years</span></div><div class="chart lg" id="dxMo"></div></div>
    </div>
    <div class="card"><div class="card-h"><h3>Decomposition (STL, yearly period)</h3><span class="muted">trend + yearly season + remainder = the series</span></div><div class="chart xl" id="dxStl"></div>
      <p class="note">Trend strength ${E.stl.trend_strength}, seasonal strength ${E.stl.seasonal_strength}: the yearly cycle explains most of the movement, on top of a rising trend (${fmt(E.stl.trend_start_mw)} → ${fmt(E.stl.trend_end_mw)} MW).</p></div>`;
  $("#dxY").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; const y = +b.dataset.y; DX.years.has(y) ? DX.years.delete(y) : DX.years.add(y); b.classList.toggle("on"); drawData(); });
  $("#dxS").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; const s = b.dataset.s; DX.seasons.has(s) ? DX.seasons.delete(s) : DX.seasons.add(s); b.classList.toggle("on"); drawData(); });
  $("#dxT").addEventListener("click", (e) => { DX.temp = !DX.temp; e.currentTarget.classList.toggle("on", DX.temp); drawData(); });
  $$("#dxY .chip").forEach((b) => b.classList.toggle("on", DX.years.has(+b.dataset.y)));
  $$("#dxS .chip").forEach((b) => b.classList.toggle("on", DX.seasons.has(b.dataset.s)));
  $("#dxT").classList.toggle("on", DX.temp);
  drawData();
};
function drawData() {
  clearCharts();
  const H = D.site.history, n = H.peak.length;
  const dates = Array.from({ length: n }, (_, i) => addDays(H.start, i));
  const keep = dates.map((d) => { const t = parse(d); return DX.years.has(t.getUTCFullYear()) && DX.seasons.has(SEASON(t.getUTCMonth() + 1)); });
  const peak = dates.map((d, i) => [d, keep[i] ? H.peak[i] : null]);
  const vals = H.peak.filter((v, i) => keep[i] && v != null);
  const pairs = H.peak.map((v, i) => [H.tmax[i], v]).filter((p, i) => keep[i] && p[0] != null && p[1] != null);
  const corr = (() => { if (pairs.length < 3) return null; const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
    let a = 0, b = 0, c = 0; pairs.forEach(([x, y]) => { a += (x - mx) * (y - my); b += (x - mx) ** 2; c += (y - my) ** 2; }); return a / Math.sqrt(b * c); })();
  const mi = vals.length ? H.peak.findIndex((v, i) => keep[i] && v === Math.max(...vals)) : -1;
  $("#dxK").innerHTML = kpi("Days selected", fmt(vals.length), "complete days only") + kpi("Average peak", vals.length ? fmt(mean(vals)) + " MW" : "–", "in the selection") +
    kpi("Highest peak", mi >= 0 ? fmt(H.peak[mi]) + " MW" : "–", mi >= 0 ? longLabel(dates[mi]) : "", "hl") + kpi("Temp–peak correlation", corr == null ? "–" : corr.toFixed(2), "Pearson r, max temperature vs. peak");
  const ts = mk($("#dxTs"));
  const series = [{ name: "Peak demand", type: "line", data: peak, symbol: "none", lineStyle: { width: 1.2, color: css("amber") }, itemStyle: { color: css("amber") }, connectNulls: false, sampling: "lttb" },
    { name: "30-day average", type: "line", data: dates.map((d, i) => { if (!keep[i]) return [d, null]; const w = H.peak.slice(Math.max(0, i - 15), i + 15).filter((x) => x != null); return [d, w.length ? Math.round(mean(w)) : null]; }),
      symbol: "none", lineStyle: { width: 2.4, color: css("actual") }, itemStyle: { color: css("actual") } }];
  if (DX.temp) series.push({ name: "Max temperature", type: "line", yAxisIndex: 1, data: dates.map((d, i) => [d, keep[i] ? H.tmax[i] : null]), symbol: "none", lineStyle: { width: 1, color: css("red"), opacity: 0.55 }, itemStyle: { color: css("red") } });
  ts.setOption(base({
    tooltip: { ...base().tooltip, formatter: (ps) => { let h = `<b>${longLabel(ps[0].value[0])}</b>`; ps.forEach((p) => { if (p.value[1] != null) h += `<br>${p.marker}${p.seriesName}: <b>${fmt(p.value[1], p.seriesName.startsWith("Max") ? 1 : 0)}</b>${p.seriesName.startsWith("Max") ? " °C" : " MW"}`; }); return h; } },
    grid: { left: 8, right: 8, top: 58, bottom: 70, containLabel: true },
    xAxis: xTime(), yAxis: [yVal({ name: "MW" }), yVal({ name: "°C", show: DX.temp, splitLine: { show: false }, axisLabel: { color: css("muted") }, nameTextStyle: { color: css("muted"), align: "right" } })],
    dataZoom: [{ type: "inside", start: 70, end: 100 }, { type: "slider", start: 70, end: 100, height: 26, bottom: 10, borderColor: css("border"), fillerColor: css("amber-soft"),
      dataBackground: { lineStyle: { color: css("faint") }, areaStyle: { color: css("surface-2") } }, textStyle: { color: css("muted") }, handleStyle: { color: css("amber") } }],
    series,
  }));
  const sc = mk($("#dxSc")), sCol = { Winter: "blue", Summer: "red", Monsoon: "teal", "Post-monsoon": "amber" };
  sc.setOption(base({
    tooltip: { ...base().tooltip, trigger: "item", formatter: (p) => `<b>${longLabel(p.value[2])}</b><br>${p.value[0]} °C · ${fmt(p.value[1])} MW` },
    xAxis: { type: "value", scale: true, name: "max temperature °C", nameLocation: "middle", nameGap: 26, axisLabel: { color: css("muted") }, splitLine: { lineStyle: { color: css("grid") } } },
    yAxis: yVal({ name: "MW" }), grid: { left: 8, right: 14, top: 40, bottom: 34, containLabel: true },
    series: Object.keys(sCol).filter((s) => DX.seasons.has(s)).map((s) => ({ name: s, type: "scatter", symbolSize: 4, itemStyle: { color: css(sCol[s]), opacity: 0.6 },
      data: dates.map((d, i) => [H.tmax[i], H.peak[i], d]).filter((p, i) => keep[i] && p[0] != null && p[1] != null && SEASON(parse(p[2]).getUTCMonth() + 1) === s) })),
  }));
  const yrs = [...DX.years].sort(), mo = mk($("#dxMo"));
  mo.setOption(base({
    tooltip: { ...base().tooltip, valueFormatter: (x) => (x == null ? "–" : fmt(x) + " MW") },
    xAxis: xCat(MO), yAxis: yVal({ name: "MW" }),
    series: yrs.map((y, j) => ({ name: String(y), type: "line", symbolSize: 5, smooth: 0.2, lineStyle: { width: y === 2026 ? 3 : 1.6 },
      data: MO.map((_, m) => { const xs = H.peak.filter((v, i) => v != null && keep[i] && parse(dates[i]).getUTCFullYear() === y && parse(dates[i]).getUTCMonth() === m); return xs.length ? Math.round(mean(xs)) : null; }) })),
    color: [css("faint"), css("purple"), css("teal"), css("blue"), css("amber"), css("red")],
  }));
  const st = mk($("#dxStl")), g = (i) => ({ left: 8, right: 10, top: `${6 + i * 32}%`, height: "24%", containLabel: true });
  const part = (k) => dates.map((d, i) => [d, H[k][i]]);
  st.setOption(base({
    legend: { show: false }, axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: { ...base().tooltip, formatter: (ps) => `<b>${longLabel(ps[0].value[0])}</b>` + ps.map((p) => `<br>${p.marker}${p.seriesName}: <b>${fmt(p.value[1])}</b> MW`).join("") },
    grid: [g(0), g(1), g(2)],
    title: ["Trend", "Yearly season", "Remainder"].map((t, i) => ({ text: t, left: 4, top: `${1 + i * 32}%`, textStyle: { fontSize: 12, color: css("text"), fontWeight: 600 } })),
    xAxis: [0, 1, 2].map((i) => xTime({ gridIndex: i, axisLabel: { show: i === 2, color: css("muted") } })),
    yAxis: [0, 1, 2].map((i) => yVal({ gridIndex: i, splitNumber: 3 })),
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1, 2] }],
    series: [
      { name: "Trend", type: "line", data: part("trend"), xAxisIndex: 0, yAxisIndex: 0, symbol: "none", lineStyle: { color: css("amber"), width: 2 }, itemStyle: { color: css("amber") } },
      { name: "Season", type: "line", data: part("seasonal"), xAxisIndex: 1, yAxisIndex: 1, symbol: "none", lineStyle: { color: css("red"), width: 1.4 }, itemStyle: { color: css("red") } },
      { name: "Remainder", type: "scatter", data: part("resid"), xAxisIndex: 2, yAxisIndex: 2, symbolSize: 2, itemStyle: { color: css("grey") } },
    ],
  }));
}

// ================= Methodology =================
ROUTES.method = (v) => {
  const st = D.site.stationarity;
  v.innerHTML = header("Project", "Methodology",
    "How the data was collected, how the models were built and tested, and how the live system turns forecasts into decisions.") + `
    <div class="grid g2">
      <div class="card"><h3>The problem</h3><p class="muted" style="margin-top:8px">Delhi's power demand peaks on summer afternoons, when air conditioners run across the city. The yearly record rose from 7,292 MW in 2021 to 8,705 MW on 29 June 2026. Power companies buy most of that power in advance, so they need the peak a few days ahead: too low means expensive last-minute power or cuts; too high wastes money.</p>
        <p class="muted"><b style="color:var(--text)">Goal:</b> forecast the daily peak (MW) for each of the next 7 days, with a range, and warn before heat-driven spikes.</p></div>
      <div class="card"><h3>The data</h3><ul class="list" style="margin-top:8px">
        <li><b>Load:</b> Delhi SLDC publishes Delhi's load every 5 minutes. 585,739 readings, 1 Jan 2021 – 24 Oct 2026 (2,123 days), then updated daily.</li>
        <li><b>Weather:</b> Open-Meteo: ERA5 daily weather for New Delhi, and the archived GFS forecasts made 1–7 days before each day.</li>
        <li><b>Cleaning:</b> readings more than 800 MW from their 25-minute median are glitches; below 500 MW are dropouts. Days with under 80% of readings (108) are filled for training and never scored.</li></ul></div>
    </div>
    <div class="card" style="margin-bottom:16px"><h3>Models and testing</h3><ol class="steps" style="margin-top:12px">
      <li><span>1</span><div><h4>Stationarity</h4><p>ADF and KPSS disagree on the raw series; after a first and a weekly difference both say stationary, so classical models use d = 1, D = 1, s = 7.</p>
        <div class="tw" style="margin-top:8px"><table class="t"><thead><tr><th>Series</th><th class="n">ADF p</th><th class="n">KPSS p</th><th>Verdict</th></tr></thead><tbody>
        ${st.map((r) => `<tr><td>${r.series}</td><td class="n">${r["ADF p"] < 0.001 ? "&lt; 0.001" : r["ADF p"].toFixed(3)}</td><td class="n">${r["KPSS p"].toFixed(3)}${r["KPSS p"] >= 0.1 ? "+" : ""}</td><td>${r.verdict}</td></tr>`).join("")}</tbody></table></div></div></li>
      <li><span>2</span><div><h4>Baselines and classical models</h4><p>Naive, seasonal naive, Holt-Winters, SARIMA and SARIMAX with yearly Fourier terms, holidays and degree-days. SARIMA orders chosen by AIC from 36 options, rejecting fits with unit roots.</p></div></li>
      <li><span>3</span><div><h4>Prophet</h4><p>Additive regression with yearly and weekly seasonality, Indian holidays and temperature regressors, refitted at every forecast date.</p></div></li>
      <li><span>4</span><div><h4>XGBoost</h4><p>Seven separate tree models, one per day ahead, predicting the ratio to last week's average peak so they can go above old records. Inputs: recent load, same day last week and last year, weather, degree-days, calendar.</p></div></li>
      <li><span>5</span><div><h4>LSTM and GRU</h4><p>Recurrent networks reading the last 28 days plus the forecast week's weather and calendar, three seeds each; the deployed ensemble averages them.</p></div></li>
      <li><span>6</span><div><h4>Rolling-origin backtest</h4><p>Tune on 2021–2024, validate on 2025, test once on 2026: forecast 7 days, move 7 days, repeat (41 forecasts, 278 scored days). Every model is scored twice: with the weather that happened, and with the GFS forecast available on the day, bias-corrected over the previous 30 days.</p></div></li>
    </ol></div>
    <div class="card" style="margin-bottom:16px"><h3>The live system</h3><p class="muted small" style="margin:6px 0 12px">A GitHub Actions job runs every day at 07:00 IST and publishes this site.</p>
      <div class="flow">
        <div><b>Fetch load</b>Yesterday's 5-minute table from Delhi SLDC, cleaned to a daily peak.</div>
        <div><b>Fetch weather</b>Today's GFS 7-day forecast plus recent forecasts and observations from Open-Meteo.</div>
        <div><b>Correct bias</b>Shift each forecast day by that lead's average error over the last 30 days.</div>
        <div><b>Run the model</b>The 7 tested XGBoost boosters, the 90% range and planning margins from 2025 errors.</div>
        <div><b>Publish & score</b>Write the forecast, add it to the log, fill in yesterday's real peak, redeploy.</div>
      </div>
      <p class="note">Why XGBoost for the live service: it had the lowest error on 2026 with real weather forecasts (5.68%) and runs in seconds on a free server. The LSTM + GRU ensemble remains the model chosen by the pre-set rule for the 2026 test (6.29%); both numbers are reported.</p></div>
    <div class="grid g2">
      <div class="card"><h3>Decision support</h3><ul class="list" style="margin-top:8px">
        <li><b>Planner:</b> plan = forecast × the p-th percentile of (real ÷ forecast) on 2025 for the same lead. Expected shortfall and surplus average all 2025 errors applied to the forecast.</li>
        <li><b>Alert:</b> a day is flagged when its forecast is above the 95th percentile of measured peaks in the same season over the last two years. The usual peak hour of that season sets the action window.</li>
        <li><b>What-if:</b> the XGBoost trees are exported to JSON and evaluated in JavaScript with the same feature rules; with no change they reproduce the Python forecast.</li></ul></div>
      <div class="card"><h3>Limitations and future scope</h3><ul class="list" style="margin-top:8px">
        <li><b>Weather:</b> ERA5 stands in for station data; only GFS is archived back to 2021. Blending in ECMWF would help.</li>
        <li><b>Records:</b> the 2026 record day was forecast about 10% low; tree models cannot exceed the hottest weather seen in training.</li>
        <li><b>Range:</b> the 90% range covered 84.5% of 2026 days; a rolling (conformal) recalibration would fix this.</li>
        <li><b>Scope:</b> daily peak for all of Delhi; next steps are the hourly curve and each power company.</li></ul></div>
    </div>
    <div class="card"><h3>References</h3><ol class="refs" style="margin-top:10px">
      <li>Hyndman, R. J., &amp; Athanasopoulos, G. (2021). <em>Forecasting: Principles and Practice</em> (3rd ed.). OTexts.</li>
      <li>Box, G. E. P., Jenkins, G. M., Reinsel, G. C., &amp; Ljung, G. M. (2015). <em>Time Series Analysis: Forecasting and Control</em> (5th ed.). Wiley.</li>
      <li>Hong, T., &amp; Fan, S. (2016). Probabilistic electric load forecasting: A tutorial review. <em>International Journal of Forecasting</em>, 32(3), 914–938.</li>
      <li>Taylor, S. J., &amp; Letham, B. (2018). Forecasting at scale. <em>The American Statistician</em>, 72(1), 37–45.</li>
      <li>Chen, T., &amp; Guestrin, C. (2016). XGBoost: A scalable tree boosting system. <em>Proc. 22nd ACM SIGKDD</em>, 785–794.</li>
      <li>Hochreiter, S., &amp; Schmidhuber, J. (1997). Long short-term memory. <em>Neural Computation</em>, 9(8), 1735–1780.</li>
      <li>Cho, K., et al. (2014). Learning phrase representations using RNN encoder–decoder for statistical machine translation. <em>Proc. EMNLP</em>, 1724–1734.</li>
      <li>Ben Taieb, S., Bontempi, G., Atiya, A. F., &amp; Sorjamaa, A. (2012). A review and comparison of strategies for multi-step ahead time series forecasting. <em>Expert Systems with Applications</em>, 39(8), 7067–7083.</li>
      <li>Kong, W., et al. (2019). Short-term residential load forecasting based on LSTM recurrent neural network. <em>IEEE Transactions on Smart Grid</em>, 10(1), 841–851.</li>
      <li>Makridakis, S., Spiliotis, E., &amp; Assimakopoulos, V. (2018). Statistical and machine learning forecasting methods: Concerns and ways forward. <em>PLoS ONE</em>, 13(3), e0194889.</li>
      <li>Vovk, V., Gammerman, A., &amp; Shafer, G. (2005). <em>Algorithmic Learning in a Random World</em>. Springer.</li>
      <li>Hersbach, H., et al. (2020). The ERA5 global reanalysis. <em>Quarterly Journal of the Royal Meteorological Society</em>, 146(730), 1999–2049.</li>
      <li>Data: State Load Despatch Centre, Delhi (<a href="https://www.delhisldc.org/" rel="noopener">delhisldc.org</a>); Open-Meteo Historical Weather, Historical Forecast and Forecast APIs (<a href="https://open-meteo.com/" rel="noopener">open-meteo.com</a>, CC BY 4.0).</li>
    </ol></div>`;
};

// ================= About =================
ROUTES.about = (v) => {
  v.innerHTML = header("Project", "About") + `
    <div class="card" style="margin-bottom:16px"><div class="author"><div class="avatar" aria-hidden="true">SK</div><div>
      <h2 style="font-size:1.4rem">Md Shadab Iqbal Khan</h2><p style="margin:4px 0">B.Tech Computer Science and Engineering, Bennett University</p>
      <p class="muted" style="margin:0 0 10px">Solo project for CSET369 Time Series Analysis, 2026: data collection, cleaning, modelling, the live pipeline, the dashboard and this app.</p>
      <a class="btn" href="https://github.com/Shadab5706/delhi-peak-demand" rel="noopener">Source on GitHub</a></div></div></div>
    <div class="grid g2">
      <div class="card"><h3>Tools</h3><div class="tools" style="margin-top:10px">${["Python 3.13", "pandas", "NumPy", "statsmodels", "Prophet", "XGBoost", "PyTorch", "scikit-learn", "Streamlit", "Jupyter", "pytest", "GitHub Actions", "GitHub Pages", "Apache ECharts", "Open-Meteo API"].map((t) => `<span>${t}</span>`).join("")}</div>
        <p class="note">Offline, the full project (download, clean, EDA, 12 models, figures, tests, notebooks) runs from one command-line tool. Online, a small copy of the pipeline runs the daily forecast.</p></div>
      <div class="card"><h3>Offline dashboard</h3><p class="muted small" style="margin-top:6px">The project also has a Streamlit dashboard for the 2026 backtest (forecast, 90% range, alert).</p><img class="shot" src="img/p3_dashboard.jpg" alt="Screenshot of the Streamlit dashboard" loading="lazy" width="1400" height="1101"></div>
    </div>
    <div class="card"><h3>Downloads</h3><p class="muted small" style="margin:6px 0 12px">Results produced by the project, plus the live forecast files.</p><div class="dl">${downloads()}
      <a href="data/forecast_latest.json" download>${ICON.dl}<span>forecast_latest.json<small>Today's live forecast</small></span></a>
      <a href="data/forecast_log.json" download>${ICON.dl}<span>forecast_log.json<small>Every live forecast + actuals</small></span></a></div>
      <p class="note">Data: Delhi SLDC load data (public); weather from Open-Meteo (CC BY 4.0).</p></div>`;
};

// ---------- boot ----------
const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
Promise.all([get("data/site.json"), get("data/forecast_latest.json"), get("data/forecast_log.json"), get("data/planner.json")]).then(([site, latest, log, planner]) => {
  if (!site || !planner) { $("#view").innerHTML = '<div class="card empty">The app data could not be loaded. Please reload the page.</div>'; return; }
  Object.assign(D, { site, latest, log, planner });
  setPill();
  render();
});
