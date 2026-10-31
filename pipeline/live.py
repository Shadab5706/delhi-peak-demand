"""Daily live forecast for Delhi's peak electricity demand (runs on GitHub Actions every morning).

Steps
  1. Load: add any new days of Delhi SLDC 5-minute load (daily peak after cleaning).
  2. Weather: observed daily weather (Open-Meteo ERA5 archive) and the archived GFS forecasts of the last
     45 days (to measure the forecast's recent bias), then today's GFS 7-day forecast, bias-corrected.
  3. Model: the XGBoost direct model (7 boosters, one per day ahead) trained on 2021-2025 and tested on
     2026; 90% range and planning margins from its 2025 validation errors.
  4. Output: data/forecast_latest.json (the next 7 days, alert, what-if inputs) and data/forecast_log.json
     (every live forecast, with actuals filled in as they arrive).

If the SLDC site cannot be reached the last data is kept and the status says "delayed".

    python pipeline/live.py                      # live run
    python pipeline/live.py --asof 2026-05-20    # replay a past origin with the archived forecasts (check)
"""
import argparse
import csv
import html
import io
import json
import re
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import holidays
import numpy as np
import pandas as pd
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[1]
PIPE, MODELS, OUT = ROOT / "pipeline" / "data", ROOT / "models", ROOT / "data"
DAILY, GFS = PIPE / "daily.csv", PIPE / "gfs_leads.csv"
CFG = json.loads((MODELS / "feature_config.json").read_text())
QUANT = json.loads((MODELS / "quantiles.json").read_text())
LAT, LON = 28.61, 77.21
WX = ["tmax", "tmean", "humidity"]
UA = {"User-Agent": "delhi-peak-demand/1.0 (student project)"}
IST = timezone(timedelta(hours=5, minutes=30))
SEASON = {12: "Winter", 1: "Winter", 2: "Winter", 3: "Summer", 4: "Summer", 5: "Summer", 6: "Summer",
          7: "Monsoon", 8: "Monsoon", 9: "Monsoon", 10: "Post-monsoon", 11: "Post-monsoon"}


def get(url, tries=4, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    for k in range(tries):
        try:
            return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(5 * (k + 1))


# ---------------- 1. load ----------------
def sldc_day(d):
    """One day of 5-minute DELHI load -> (peak MW, time of peak, completeness), cleaned as in training."""
    page = get(f"https://www.delhisldc.org/Loaddata.aspx?mode={d:%d/%m/%Y}", tries=3, timeout=40)
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        cells = [html.unescape(re.sub("<[^>]+>", "", td)).strip() for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if len(cells) >= 2 and re.fullmatch(r"\d{2}:\d{2}", cells[0]):
            try:
                rows.append((cells[0], float(cells[1])))
            except ValueError:
                pass
    if not rows:
        return None
    s = pd.DataFrame(rows, columns=["time", "mw"]).drop_duplicates("time").sort_values("time")
    med = s["mw"].rolling(5, center=True, min_periods=1).median()
    v = s[(s["mw"] >= 500) & ((s["mw"] - med).abs() <= 800)]   # dropouts and isolated spikes
    if v.empty:
        return None
    i = v["mw"].idxmax()
    return float(v.loc[i, "mw"]), v.loc[i, "time"], min(1.0, len(v) / 288)


def update_load(daily, today, log):
    """Fetch every day after the last stored one up to yesterday. Returns the number of new days."""
    new, d = 0, daily.index.max() + pd.Timedelta(days=1)
    while d < today:
        try:
            r = sldc_day(d)
        except Exception as e:  # site down or blocked: keep what we have
            log.append(f"SLDC {d.date()}: {type(e).__name__}")
            break
        if r is None:
            log.append(f"SLDC {d.date()}: no table")
            if (today - d).days <= 2:
                break  # probably not published yet
            r = (np.nan, "", 0.0)
        daily.loc[d, ["peak_mw", "peak_time", "completeness"]] = r
        new += 1
        d += pd.Timedelta(days=1)
        time.sleep(0.5)
    daily["is_imputed"] = (daily["completeness"].fillna(0) < 0.8).astype(int)
    return new


# ---------------- 2. weather ----------------
def era5(start, end):
    url = ("https://archive-api.open-meteo.com/v1/archive?latitude={}&longitude={}&start_date={}&end_date={}"
           "&timezone=Asia/Kolkata&format=csv&daily=temperature_2m_max,temperature_2m_mean,relative_humidity_2m_mean")
    df = pd.read_csv(io.StringIO(get(url.format(LAT, LON, start.date(), end.date()))), skiprows=3)
    df.columns = ["date", "tmax", "tmean", "humidity"]
    return df.assign(date=pd.to_datetime(df["date"])).set_index("date").dropna(how="all")


def hourly_to_daily(h, t_col, rh_col):
    h = h.assign(date=pd.to_datetime(h["time"]).dt.normalize())
    g = h.groupby("date")
    day = pd.DataFrame({"tmean": g[t_col].mean(), "tmax": g[t_col].max(), "humidity": g[rh_col].mean()})
    day.loc[g[t_col].count() < 20, ["tmean", "tmax"]] = np.nan
    day.loc[g[rh_col].count() < 20, "humidity"] = np.nan
    return day


def gfs_archive(start, end):
    """Archived GFS: for each day, the forecast issued 1..7 days before it (same source as training)."""
    vars_ = ",".join(f"{v}_previous_day{n}" for v in ("temperature_2m", "relative_humidity_2m") for n in range(1, 8))
    url = ("https://historical-forecast-api.open-meteo.com/v1/forecast?latitude={}&longitude={}&start_date={}"
           "&end_date={}&timezone=Asia/Kolkata&format=csv&models=gfs_seamless&hourly={}")
    h = pd.read_csv(io.StringIO(get(url.format(LAT, LON, start.date(), end.date(), vars_), timeout=90)), skiprows=3)
    parts = []
    for n in range(1, 8):
        day = hourly_to_daily(h, f"temperature_2m_previous_day{n} (°C)", f"relative_humidity_2m_previous_day{n} (%)")
        parts.append(day.assign(lead=n))
    return pd.concat(parts).reset_index().set_index(["date", "lead"]).sort_index()


def gfs_now():
    """Today's GFS run, daily values for the coming days (IST)."""
    url = ("https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&timezone=Asia/Kolkata&format=csv"
           "&models=gfs_seamless&hourly=temperature_2m,relative_humidity_2m&forecast_days=9")
    h = pd.read_csv(io.StringIO(get(url.format(LAT, LON))), skiprows=3)
    return hourly_to_daily(h, "temperature_2m (°C)", "relative_humidity_2m (%)")


def bias(gfs, obs, origin, lead, window):
    """Mean (observed - forecast) of this lead over target days (origin - window, origin]: errors known at the origin."""
    f = gfs.xs(lead, level="lead")[WX].reindex(pd.date_range(origin - pd.Timedelta(days=window - 1), origin))
    e = (obs[WX].reindex(f.index) - f)
    return e.mean().where(e.count() >= window // 3, 0.0).fillna(0.0)


def archive_week(gfs, origin, dates):
    """Replay mode: day o+h gets the archived run issued h days before it (longer lead if missing)."""
    rows = []
    for t in dates:
        row = None
        for lead in range((t - origin).days, 8):
            if (t, lead) in gfs.index and not gfs.loc[(t, lead), WX].isna().any():
                row = gfs.loc[(t, lead), WX] + bias(gfs, OBS, origin, lead, CFG["bias_window_days"])
                break
        rows.append(row if row is not None else pd.Series(np.nan, index=WX))
    return pd.DataFrame(rows, index=dates)


# ---------------- 3. features + model ----------------
def covariates(d):
    """Same daily drivers as in training: weather, degree-days, yearly Fourier, calendar."""
    cdd = (d["tmean"] - CFG["cdd_base"]).clip(lower=0)
    t = np.asarray((d.index - pd.Timestamp("2021-01-01")).days, dtype=float)
    dow = d.index.day_of_week
    X = pd.DataFrame({
        "tmax": d["tmax"], "tmean": d["tmean"], "humidity": d["humidity"],
        "cdd": cdd, "cdd_lag1": cdd.shift(1).bfill(), "hdd": (CFG["hdd_base"] - d["tmean"]).clip(lower=0),
        "humid_cdd": cdd * d["humidity"] / 100,
        "sin1": np.sin(2 * np.pi * t / 365.25), "cos1": np.cos(2 * np.pi * t / 365.25),
        "sin2": np.sin(4 * np.pi * t / 365.25), "cos2": np.cos(4 * np.pi * t / 365.25),
        "is_holiday": d["is_holiday"].astype(float), "is_weekend": (dow >= 5).astype(float),
        "dow_sin": np.sin(2 * np.pi * dow / 7), "dow_cos": np.cos(2 * np.pi * dow / 7),
    }, index=d.index)
    return X


def design(y, X, h):
    m7 = y.rolling(7).mean()
    F = pd.DataFrame({
        "l0": np.log(y / m7), "l1": np.log(y.shift(1) / m7), "l6": np.log(y.shift(6) / m7),
        "m30": np.log(y.rolling(30).mean() / m7), "s7": y.rolling(7).std(ddof=0) / m7,
        "trend7": np.log(y.rolling(3).mean() / y.shift(4).rolling(3).mean()),
        "lw": np.log(y.shift(7 - h) / m7), "ly": np.log(y.shift(364 - h) / m7),
    }, index=y.index)
    Xt = X.shift(-h).reindex(y.index)
    F = F.join(Xt.add_prefix("x_"))
    F["dcdd"] = Xt["cdd"] - X["cdd"].reindex(y.index)
    F["dtmax"] = Xt["tmax"] - X["tmax"].reindex(y.index)
    return F, m7


def forecast(daily, origin, week, y=None):
    """7-day forecast from `origin` with the forecast week's weather `week` (index = target dates).
    `y` overrides the load history (used only to check against the offline backtest)."""
    d = daily.loc[:origin, WX + ["is_holiday"]].astype(float)
    d = pd.concat([d, week.assign(is_holiday=holiday_flags(week.index))])
    X = covariates(d)
    if y is None:
        y = daily.loc[:origin, "peak_mw"].where(daily.loc[:origin, "is_imputed"] == 0).interpolate("time").bfill().ffill()
    y = y.loc[:origin].iloc[-400:]
    rows, out = [], []
    for h in range(1, 8):
        F, m7 = design(y, X.loc[y.index[0]:], h)
        row = F.loc[[origin], CFG["columns"]]
        booster = xgb.Booster(model_file=str(MODELS / f"xgb_h{h}.json"))
        out.append(float(m7.loc[origin] * np.exp(booster.predict(xgb.DMatrix(row.values))[0])))
        rows.append([None if pd.isna(v) else round(float(v), 10) for v in row.values[0]])
    return np.array(out), rows, float(m7.loc[origin])


def holiday_flags(idx):
    hol = holidays.India(years=range(idx.min().year, idx.max().year + 1))
    return [int(t.date() in hol) for t in idx]


def season_stats(daily, origin):
    """Alert line (95th percentile of the season's peaks, last 2 years) and the season's usual peak hour."""
    hist = daily.loc[origin - pd.Timedelta(days=CFG["alert_lookback_days"]):origin]
    hist = hist[(hist["is_imputed"] == 0) & (hist.index.month.map(SEASON) == SEASON[origin.month])]
    hours = pd.to_numeric(hist["peak_time"].astype(str).str[:2], errors="coerce").dropna()
    mode_hour = int(hours.mode().iloc[0]) if len(hours) else 15
    share = float((hours == mode_hour).mean()) if len(hours) else 0.0
    return float(hist["peak_mw"].quantile(CFG["alert_quantile"])), mode_hour, share


# ---------------- 4. outputs ----------------
def fill_log(log, daily):
    for e in log:
        for r in e["days"]:
            t = pd.Timestamp(r["date"])
            if t in daily.index and daily.loc[t, "is_imputed"] == 0 and not pd.isna(daily.loc[t, "peak_mw"]):
                r["actual"] = round(float(daily.loc[t, "peak_mw"]))
                r["error_pct"] = round(100 * (r["mw"] - r["actual"]) / r["actual"], 2)
    errs = [abs(r["error_pct"]) for e in log for r in e["days"] if "error_pct" in r]
    by_h = {h: [abs(r["error_pct"]) for e in log for r in e["days"] if "error_pct" in r and r["h"] == h] for h in range(1, 8)}
    inside = [r["lo"] <= r["actual"] <= r["hi"] for e in log for r in e["days"] if "actual" in r]
    return {"scored_days": len(errs), "mape": round(float(np.mean(errs)), 2) if errs else None,
            "mape_by_h": {h: round(float(np.mean(v)), 2) if v else None for h, v in by_h.items()},
            "in_range_pct": round(100 * float(np.mean(inside)), 1) if inside else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--asof", help="replay this origin (YYYY-MM-DD) with archived forecasts; writes nothing")
    args = ap.parse_args()
    global OBS
    notes = []
    daily = pd.read_csv(DAILY, parse_dates=["date"], index_col="date", dtype={"peak_time": str})
    gfs = pd.read_csv(GFS, parse_dates=["date"]).set_index(["date", "lead"]).sort_index()

    if args.asof:
        origin = pd.Timestamp(args.asof)
        OBS = daily[WX]
        dates = pd.date_range(origin + pd.Timedelta(days=1), periods=7)
        f, _, _ = forecast(daily, origin, archive_week(gfs, origin, dates))
        print(json.dumps({"origin": args.asof, "forecast": [round(v, 2) for v in f]}))
        return

    now = datetime.now(IST)
    today = pd.Timestamp(now.date())
    new_days = update_load(daily, today, notes)

    # observed weather for recent days; the archive lags a few days behind
    try:
        obs = era5(daily.index.max() - pd.Timedelta(days=45), today - pd.Timedelta(days=1))
        idx = obs.index.intersection(daily.index)
        daily.loc[idx, WX] = obs.loc[idx, WX].values
    except Exception as e:
        notes.append(f"ERA5: {type(e).__name__}")
    try:
        recent = gfs_archive(today - pd.Timedelta(days=45), today - pd.Timedelta(days=1))
        gfs = pd.concat([gfs[gfs.index.get_level_values("date") < recent.index.get_level_values("date").min()], recent])
        gfs = gfs[gfs.index.get_level_values("date") >= today - pd.Timedelta(days=400)]
    except Exception as e:
        notes.append(f"GFS archive: {type(e).__name__}")
    OBS = daily[WX]

    origin = daily["peak_mw"].dropna().index.max()
    # origin-day weather not yet in ERA5: use the bias-corrected 1-day-ahead forecast of that day
    for t in daily.loc[:origin].index[-10:]:
        if daily.loc[t, WX].isna().any() and (t, 1) in gfs.index:
            daily.loc[t, WX] = (gfs.loc[(t, 1), WX] + bias(gfs, OBS, t - pd.Timedelta(days=1), 1, CFG["bias_window_days"])).values
    daily["is_holiday"] = holiday_flags(daily.index)
    daily.loc[:origin, WX] = daily.loc[:origin, WX].ffill()

    dates = pd.date_range(origin + pd.Timedelta(days=1), periods=7)
    try:
        run = gfs_now()
    except Exception as e:
        notes.append(f"GFS now: {type(e).__name__}")
        run = pd.DataFrame(columns=WX, dtype=float)
    week = run.reindex(dates)
    for i, t in enumerate(dates):
        week.loc[t] = week.loc[t] + bias(gfs, OBS, origin, min(i + 1, 7), CFG["bias_window_days"])
    raw_week = run.reindex(dates)
    week = week.fillna(daily.loc[origin, WX].astype(float))  # no forecast at all: persistence

    f, feat_rows, m7 = forecast(daily, origin, week)
    thr, peak_hour, peak_share = season_stats(daily, origin)
    q90 = QUANT["interval90"]
    days = []
    for i, t in enumerate(dates):
        h = str(i + 1)
        days.append({"date": t.strftime("%Y-%m-%d"), "h": i + 1, "mw": round(f[i]),
                     "lo": round(f[i] * np.exp(q90[h][0])), "hi": round(f[i] * np.exp(q90[h][1])),
                     "plan": {p: round(f[i] * np.exp(v[h])) for p, v in QUANT["upper"].items()},
                     "tmax": round(float(week.loc[t, "tmax"]), 1), "tmean": round(float(week.loc[t, "tmean"]), 1),
                     "humidity": round(float(week.loc[t, "humidity"]), 1),
                     "tmax_raw": None if pd.isna(raw_week.loc[t, "tmax"]) else round(float(raw_week.loc[t, "tmax"]), 1),
                     "holiday": bool(holiday_flags(pd.DatetimeIndex([t]))[0]), "alert": bool(f[i] > thr)})

    stale = (today - origin).days > 2
    hist = daily.loc[origin - pd.Timedelta(days=27):origin]
    latest = {
        "issued_at": now.strftime("%Y-%m-%d %H:%M IST"), "origin": origin.strftime("%Y-%m-%d"),
        "status": "delayed" if stale else "ok", "new_days": new_days, "notes": notes,
        "model": "XGBoost direct (7 boosters), trained 2021-2025, tested on 2026",
        "threshold": round(thr), "season": SEASON[origin.month], "peak_hour": peak_hour, "peak_hour_share": round(peak_share, 2),
        "days": days,
        "recent": [{"date": t.strftime("%Y-%m-%d"), "mw": None if r.is_imputed or pd.isna(r.peak_mw) else round(r.peak_mw),
                    "tmax": None if pd.isna(r.tmax) else round(float(r.tmax), 1)} for t, r in hist.iterrows()],
        "whatif": {"columns": CFG["columns"], "rows": feat_rows, "m7": round(m7, 3),
                   "origin_cdd": round(max(0.0, float(daily.loc[origin, "tmean"]) - CFG["cdd_base"]), 4),
                   "origin_tmax": round(float(daily.loc[origin, "tmax"]), 2)},
    }
    OUT.mkdir(exist_ok=True)
    log_path = OUT / "forecast_log.json"
    log = json.loads(log_path.read_text())["entries"] if log_path.exists() else []
    if not stale and not any(e["origin"] == latest["origin"] for e in log):
        log.append({"issued_at": latest["issued_at"], "origin": latest["origin"], "threshold": latest["threshold"],
                    "days": [{k: r[k] for k in ("date", "h", "mw", "lo", "hi", "alert")} for r in days]})
    summary = fill_log(log, daily)
    latest["track"] = summary
    (OUT / "forecast_latest.json").write_text(json.dumps(latest, separators=(",", ":")))
    log_path.write_text(json.dumps({"updated": latest["issued_at"], "summary": summary, "entries": log}, separators=(",", ":")))

    daily["peak_time"] = daily["peak_time"].fillna("")
    daily.round(3).to_csv(DAILY)
    gfs.round(3).to_csv(GFS)
    print(f"origin {latest['origin']} status {latest['status']} new days {new_days} notes {notes}")
    print("forecast", [r["mw"] for r in days], "alert line", latest["threshold"])


if __name__ == "__main__":
    main()
