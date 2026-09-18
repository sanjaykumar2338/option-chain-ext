# Upstox Option Chain Signals

Chrome MV3 extension for the Upstox Pro option-chain page. It provides heuristic **BUY CALL**, **BUY PUT**, or **WAIT** signals, with a nearby contract candidate and the reasons behind the decision. Scores are rule strength, not probabilities or a validated prediction of profit.

## Load or update

1. Open `chrome://extensions`, enable Developer mode, and load this project folder (or click **Reload** for an existing installation).
2. Refresh Upstox and select an option chain and expiry.
3. Wait for an actual spot, premium, OI, or volume change. Open the extension popup and use **Test notification** to check desktop alerts.

## Data read by content.js

- All strike rows currently loaded in the DOM, plus matching recently captured network rows. The former nearest-10-row limit is removed.
- Selected underlying, spot, expiry, max pain and India VIX.
- Calls and puts: LTP, daily price change, total OI, OI change and percentage, volume, IV, delta, gamma, theta and vega.
- Bid/ask prices, quantities, previous close and previous OI when provided by captured responses.

Headers determine the column mapping; OI labelled in lakhs is converted into units. Missing values remain missing, and valid zero values are preserved. Responses from another underlying or expiry are rejected. Network supplements expire after 15 seconds. History is isolated by underlying and expiry.

Coverage means **loaded/captured rows**, not a guarantee of every exchange strike. Virtualized off-screen rows and unsupported binary WebSocket messages are unavailable unless a matching JSON response supplies them. The extension does not scroll the page, place orders, or request broker credentials.

## Calculation and speed

DOM changes schedule a check within 250 ms, with a one-second backup while the tab is running. Browsers may throttle background tabs. Network responses are processed as they arrive; an early-response replay connects capture to the content script.

Directional evidence combines ATM-weighted price/OI buildup, actual total-OI PCR, volume PCR, spot confirmation, OI velocity, and observed price/OI/volume changes over roughly 30–60 seconds. Longer trends and the existing 10–20 minute bias estimate need local history. Thresholds remain +50 for calls and -50 for puts.

Greeks describe exposure and contract suitability rather than guaranteed direction. Candidate selection checks proximity, traded volume, OI, delta, IV, theta, and available bid/ask spread/depth. Gamma/vega sensitivity, max pain, VIX and OI concentration levels remain available as context. Unavailable Greeks or bid/ask data are identified; known extreme or unusable candidate values are rejected. Arbitrary fixed stop-loss/target prices have been removed; displayed LTP is not an executable entry quote.

The overlay shows loaded rows, core-data coverage, score, candidate, OI PCR, OI concentration support/resistance, reasons and the last observed data-change time. WAIT explains insufficient core data, missing expiry, no eligible candidate, unchanged data for over 30 seconds, or being outside the regular weekday equity derivatives session. The regular session guard uses 09:15–15:40 IST from August 2026 (15:30 before); it is not a holiday or special-session calendar. An observed live change is required before alerts.

Active eligible signals repeat after two minutes. There is no separate sell/exit signal. Local five-minute outcome tracking measures underlying direction, not option profitability, slippage, costs or fill quality.

## Verification

Run `node --test tests/*.test.cjs`. Tests cover extraction/units, official nested payloads, capture/replay, bullish/bearish/neutral conditions, data quality, fast momentum, expiry isolation, update scheduling, stale-data suppression and notification responses. These tests do not establish trading performance; live Upstox behavior still depends on its current DOM/feed and browser permissions.

Data schema reference: [Upstox option-chain response](https://upstox.com/developer/api-documentation/get-pc-option-chain/). Greek interpretation: [OIC volatility and Greeks](https://prd-web.optionseducation.org/advancedconcepts/volatility-the-greeks). Session reference: [NSE market timings](https://www.nseindia.com/static/market-data/market-timings).
