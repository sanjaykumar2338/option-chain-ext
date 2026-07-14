# Upstox Option Chain Signal Engine

Chrome Extension MV3 for `https://pro.upstox.com/option-chain/*`.

## Files

- `manifest.json` registers the content scripts.
- `OptionSignalEngine.js` contains the trend-aware score engine.
- `content.js` scrapes the Upstox DOM every 10 seconds, keeps 30 minutes of local history, updates one fixed overlay, saves the latest score for the popup, and records 5-minute signal outcomes.
- `background.js` sends Chrome notifications when the signal changes to `BUY CALL` or `BUY PUT`.
- `popup.html`, `popup.css`, and `popup.js` provide the extension popup notification setting.
- `icon-128.png` is used for the extension and notification icon.
- `option-chain-sample.html` is the local DOM reference used to map Upstox row cells.

## Scraped Metrics

For each of the 10 nearest strike rows, the extension captures `strike`, plus call and put `ltp`, `oiChg`, `oiChgPct`, `volume`, `iv`, `delta`, `gamma`, and `vega`.

The signal engine scores directional buildup, PCR context, 5-minute spot trend, spot confirmation, max pain, IV skew, gamma wall support/resistance, and vega/IV skew.

It also creates a separate 10-20 minute bias forecast using current signal strength, option-chain buildup, and 5/10/15-minute spot trends:

- `10-20m Bullish Bias`: upside continuation is favored.
- `10-20m Bearish Bias`: downside continuation is favored.
- `10-20m Sideways / Wait`: no clean continuation edge.
- `10-20m Forecast Warming Up`: the extension needs more local history.

The score and forecast confidence are signal-strength readings, not probabilities. `Strength 100/100` or `Confidence 100/100` means the available rules are fully aligned, not that the trade is guaranteed.

## Local Outcome Tracking

When a new `BUY CALL` or `BUY PUT` signal appears, the extension stores it locally and checks it after 5 minutes:

- `hit`: spot moved in the signal direction by at least 0.05% or 5 points.
- `miss`: spot moved against the signal by at least 0.05% or 5 points.
- `flat`: spot did not move enough either way.

The popup shows the latest signal score, strength, forecast confidence, hit rate, checked signals, pending signals, and the latest checked result. This data stays in local Chrome storage and can be cleared from the popup.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder.
5. Open an Upstox option-chain page.

The overlay refreshes every 10 seconds and shows the option-chain stock/index name, derived index label, `BUY CALL`, `BUY PUT`, or `NEUTRAL / WAIT`, signal strength, 10-20 minute forecast, 5/10/15-minute spot trend, update time, and refresh interval.

Chrome also sends a desktop notification when the signal enters or changes to `BUY CALL` or `BUY PUT`. It does not repeat the same buy notification on every refresh, but it will alert again if the signal returns after a neutral/wait period.

Use the extension toolbar popup to turn buy signal notifications on or off.
