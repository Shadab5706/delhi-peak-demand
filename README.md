# Forecasting Delhi's Daily Peak Electricity Demand

Project website for a CSET369 Time Series Analysis project at Bennett University.

**Live site:** https://shadab5706.github.io/delhi-peak-demand/

Daily peak demand of Delhi forecast 1–7 days ahead from the State Load Despatch Centre's 5-minute grid
data and Open-Meteo weather (2,123 days, 2021 to Oct 2026). Twelve models, from seasonal naive and SARIMAX
to Prophet, XGBoost and LSTM/GRU, are compared on a rolling-origin backtest over 2026, using the weather
forecast that was actually available on each forecast day.

The site is static (HTML, CSS and plain JavaScript). The forecast explorer reads precomputed backtest
results from `data/site.json`.

Author: Md Shadab Iqbal Khan, B.Tech CSE, Bennett University.

Data: Delhi SLDC (delhisldc.org); weather from Open-Meteo (open-meteo.com, CC BY 4.0).
