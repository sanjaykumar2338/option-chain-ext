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

DOM changes schedule a check within 250 ms, with a one-second backup while the tab is running. Network responses are processed as they arrive even when the option-chain tab is inactive; an early-response replay connects capture to the content script. Chrome may throttle timers or freeze/discard a background tab, and the extension cannot read new page data while the tab is frozen, discarded, closed, the computer is asleep, or Upstox has stopped its feed.

Directional evidence combines ATM-weighted price/OI buildup, delta-weighted new option flow, adaptive total-OI/volume PCR, IV-skew change, spot confirmation, OI velocity, and observed price/OI/volume changes over roughly 30–60 seconds. The adaptive PCR uses the selected instrument's rolling median once at least five observations exist; fixed thresholds are only the warm-up fallback. Each 5/10/15-minute trend requires a sample within 15 seconds of that actual horizon. Longer trends and the existing 10–20 minute bias estimate need local history. Thresholds remain +50 for calls and -50 for puts.

Directional bias and entry timing are separate. Live BUY alerts wait for 30–60 seconds of timing history and are suppressed when the one-minute/five-minute spot move or selected option premium is already extended, or while a directional pullback is still active. In those cases the overlay reports `BULLISH — WAIT FOR ENTRY` or `BEARISH — WAIT FOR ENTRY` instead of recommending a chased entry.

Live precision entries now require a setup, confirmation, and a price trigger:

- After timing history is available, keep the same eligible contract while confirming at least three distinct spot or option-midpoint updates over at least 10 seconds. Polling unchanged prices and quote timestamps alone do not count. Losing directional bias, data quality, or the candidate restarts confirmation.
- Require spot to break the recent 60-second high (CALL) / low (PUT), with a 0.01% buffer, or recover the setup's observed pre-pullback level. The selected option midpoint must also exceed its value at setup creation.
- Require two-sided bid/ask quotes no older than 10 seconds with a spread no greater than 3% of midpoint. Network quote age uses response receipt time, not an exchange timestamp. DOM quotes age from the last observed bid/ask change; rereading unchanged quotes cannot refresh them. Missing quotes mean WAIT.
- Pending setups expire after 90 seconds. Confirmed entries last at most 15 seconds and cancel if spot loses the trigger level, premium confirmation fails, or an existing timing guard fails. The opposite recent range boundary, buffered by 0.01%, is the spot invalidation level; it is not an option stop-loss price. Expired/invalidated setups have a 30-second rearm delay while their context remains eligible.
- The overlay explains the trigger and invalidation. Diagnostics shows levels, update count, spread and expiry; the popup independently suppresses expired entries and stale candidate quotes. Evaluation exports include `entryPolicy: "precision-v1"` and setup details for later comparison.

Thresholds are conservative starting heuristics, not calibrated performance claims. They can be configured through the `OptionSignalEngine` constructor (`maxSpreadPct`, `quoteMaxAgeMs`, `confirmationMs`, `confirmationUpdates`, `setupLifetimeMs`, `entryLifetimeMs`, `rearmMs`, `triggerBufferPct`); the extension uses the defaults above. Offline engine callers without `sessionOpen` retain the legacy scoring path; every live content-script analysis supplies that marker and uses precision gates. Validate on later unseen sessions with spread, fees and missed opportunities before judging improvement.

Greeks describe exposure and contract suitability rather than guaranteed direction. Candidate selection checks proximity, traded volume, OI, delta, IV, theta, and available bid/ask spread/depth. Gamma/vega sensitivity, max pain, VIX and OI concentration levels remain available as context. Unavailable Greeks or bid/ask data are identified; known extreme or unusable candidate values are rejected. Arbitrary fixed stop-loss/target prices have been removed; displayed LTP is not an executable entry quote.

The overlay shows loaded rows, core-data coverage, score, candidate, OI PCR, OI concentration support/resistance, reasons and the last observed data-change time. WAIT explains insufficient core data, missing expiry, no eligible candidate, unchanged data for over 30 seconds, or being outside the regular weekday equity derivatives session. The regular session guard uses 09:15–15:40 IST from August 2026 (15:30 before); it is not a holiday or special-session calendar. An observed live change is required before alerts.

The overlay's **Scan bid/ask** control walks the loaded option rows nearest spot first. It opens each CALL and PUT Symbol Info panel, verifies the displayed symbol, strike, side and expiry, reads Upstox's two-column market-depth book (quantity/bid and ask/quantity), and then advances automatically. Unreadable, empty and zero-depth contracts are skipped rather than stopping the scan; zero depth is expected when no usable quote is available, including many closed-market contracts. Changing the chain, hiding the tab or clicking **Stop depth scan** stops the pass. Captured depth quotes expire after 10 seconds; reopening an unchanged quote does not refresh its age. The console data snapshot includes scan totals and skipped-contract details.

The popup independently changes an old BUY reading to WAIT after 30 seconds without fresh data, even when the page stops updating. Known zero or negative bid/ask prices disqualify a candidate even when the other quote side is missing.

Confirmed entries expire after 15 seconds; a continuing directional bias alone does not repeat an old entry. There is no separate sell/exit signal. Local five-minute outcome tracking measures underlying direction and, when the matching quote remains available, records a conservative option result from entry ask to exit bid/LTP. It does not include brokerage, taxes or guaranteed fills.

The popup links to a local signal-history page. New BUY CALL and BUY PUT transitions are stored in Chrome local storage with the instrument, expiry, signal time, score, spot price, selected contract and factor details. Repeated BUY transitions for the same market, expiry, direction and strike are stored at most once per two minutes, checked against persisted history so a page reload does not bypass the interval. The first saved observation is preserved; existing history is not rewritten. Live signal calculations and notification behavior are unchanged by this history-only filter. The most recent 2,000 records are retained and can be filtered or exported as a JSON file.

The diagnostics link shows the current factor contributions, data coverage, freshness, PCR and blockers. It also keeps up to 3,000 compact evaluation samples for CALL, PUT and WAIT decisions, sampled at most once per decision per instrument per minute. Each sample is updated with 5/10/15/20-minute spot outcomes and an option return estimate when a matching candidate quote is available. Evaluation data can be exported as JSON for walk-forward analysis.

## Verification

Run `node --test tests/*.test.cjs`. Tests cover extraction/units, official nested payloads, capture/replay, bullish/bearish/neutral conditions, data quality, fast momentum, expiry isolation, update scheduling, stale-data suppression and notification responses. These tests do not establish trading performance; live Upstox behavior still depends on its current DOM/feed and browser permissions.

Data schema reference: [Upstox option-chain response](https://upstox.com/developer/api-documentation/get-pc-option-chain/). Greek interpretation: [OIC volatility and Greeks](https://prd-web.optionseducation.org/advancedconcepts/volatility-the-greeks). Session reference: [NSE market timings](https://www.nseindia.com/static/market-data/market-timings).

## Experimental formula comparison

`recent-rr25-v1` runs in **shadow mode**: existing live scores, entry gates and notifications remain in control. Diagnostics and evaluation JSON include the experimental bias and score alongside the existing directional bias. An experimental CALL/PUT is not an executable entry or a notification.

- **Recent buildup:** compare matched strikes at the same expiry against the closest snapshot to 60 seconds ago, accepting only 45–75 seconds on the same IST date. Require at least three nearby strike pairs with valid price/OI/volume observations. Apply the existing price/OI sign heuristic to interval LTP and OI changes; weight each side by ATM proximity and `log(1 + new volume)`. No new volume contributes no pressure. Volume resets and incomplete pairs are excluded. Scale to ±36, replacing daily buildup in the experimental score.
- **Matched-delta skew:** calculate `RR25 = IV(call, +0.25 delta) − IV(put, −0.25 delta)` for the same expiry. Use exact 25-delta observations or linear interpolation between bracketing deltas within 0.15–0.35; never extrapolate. Duplicate delta observations use median IV. Require valid OTM call and put wings at both timestamps. For scoring, divide RR25 by their mean IV, then scale the interval change by 0.10 and cap at ±10. This relative measure handles consistent decimal or percentage IV units; mixed units within a chain are not supported. It replaces the broader skew score in the experiment.
- Recalculate dependent spot confirmation rather than double-counting both old and new formulas. Missing research inputs produce an unavailable comparison, not a fabricated neutral signal. These weights remain heuristics pending validation.
- Exports contain both biases and their 5/10/15/20-minute underlying-direction outcomes when fresh observations arrive within 15 seconds of the horizon. These comparisons are not option-profit results or simulations of entry gates. Existing candidate return estimates are separate and exclude fees. Use later unseen sessions and executable quote/cost data before promoting the experiment to live alerts.

Research context: [CME matched-delta risk reversals](https://www.cmegroup.com/education/courses/introduction-to-cvol/introduction-to-cvol-skew), [OIC limitations of open interest](https://www.optionseducation.org/referencelibrary/faq/general-information). Recent buildup is our proposed heuristic, not a published guarantee of predictive performance. Bid/ask quantity imbalance is deferred until captured quantity quality can be established.
