# Delhi Peak Demand: live forecast and planning app

**Live app:** https://shadab5706.github.io/delhi-peak-demand/

A CSET369 Time Series Analysis project (Bennett University) by Md Shadab Iqbal Khan.

Every morning a GitHub Actions job downloads yesterday's Delhi SLDC grid data and today's GFS weather
forecast, corrects the forecast's recent bias, runs the tested XGBoost model (seven boosters, one per
day ahead) and publishes the next 7 days of Delhi's peak electricity demand. Each forecast is logged
and scored against the real peak the next morning.

What the app does:

- **Next 7 days:** live forecast with a 90% range, heat-spike alert and recommended actions.
- **Track record:** every live forecast against the real peak, with the running error.
- **Power planner:** MW to line up at a chosen safety level, expected shortfall and surplus cost,
  and a 2026 backtest of the rule against a simple baseline.
- **Heatwave what-if:** the XGBoost trees run in the browser; temperature and humidity sliders
  re-forecast the week.
- **Forecast explorer, models, data explorer:** the 2026 rolling-origin backtest of 12 models, error by
  horizon and month, feature importance, and the 2,123-day data set with its decomposition.

Repository layout:

```
index.html, app.js, style.css   the app (static, Apache ECharts)
data/                           app data, live forecast, forecast log, result CSVs
models/                         XGBoost boosters (JSON), error quantiles, browser copy of the trees
pipeline/live.py                daily pipeline: ingest, features, inference, outputs
pipeline/data/                  daily series needed for the features
.github/workflows/daily.yml     07:00 IST schedule, commit, deploy to Pages
```

Run the pipeline locally: `pip install -r pipeline/requirements.txt && python pipeline/live.py`
(`--asof 2026-05-20` replays a past week with the archived weather forecasts).

Data: State Load Despatch Centre, Delhi (delhisldc.org); weather from Open-Meteo (open-meteo.com, CC BY 4.0).
