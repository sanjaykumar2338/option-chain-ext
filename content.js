(function runUpstoxOptionChainSignal() {
  "use strict";

  const POLL_INTERVAL_MS = 10000;
  const MARKET_HISTORY_WINDOW_MS = 30 * 60 * 1000;
  const SIGNAL_EVALUATION_HORIZON_MS = 5 * 60 * 1000;
  const BACKTEST_STORAGE_KEY = "signalBacktests";
  const LATEST_SIGNAL_STORAGE_KEY = "latestSignalSnapshot";
  const OVERLAY_POSITION_STORAGE_KEY = "signalOverlayPosition";
  const BACKTEST_MAX_RECORDS = 100;
  const OVERLAY_ID = "upstox-quant-signal-overlay";
  const SIGNAL_NOTIFICATION_TYPE = "UPSTOX_OPTION_SIGNAL";
  const engine = new OptionSignalEngine();
  let marketHistory = [];
  let lastSignalKey = null;

  function parseNumber(value) {
    if (value == null) return NaN;

    const text = String(value)
      .replace(/\u2212/g, "-")
      .replace(/,/g, "")
      .replace(/%/g, "")
      .trim();

    if (!text || text === "--" || text === "-") return NaN;

    const multiplier = /\bCr\b/i.test(text)
      ? 10000000
      : /\bL\b/i.test(text)
        ? 100000
        : /\bK\b/i.test(text)
          ? 1000
          : 1;

    const numeric = Number.parseFloat(text.replace(/\b(Cr|L|K)\b/gi, "").trim());
    return Number.isFinite(numeric) ? numeric * multiplier : NaN;
  }

  function safeNumber(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
  }

  function getCellTexts(row) {
    return Array.from(row.querySelectorAll("td")).map((cell) => {
      return cell.innerText.replace(/\s+/g, " ").trim();
    });
  }

  function parseCallRow(row) {
    const cells = getCellTexts(row);
    const ltpText = cells[8] || "";
    const oiText = cells[7] || "";

    return {
      ltp: safeNumber(parseNumber(ltpText.split(" ")[0])),
      ltpChangePct: safeNumber(parseNumber(ltpText.match(/[+-]?\d+(?:\.\d+)?\s*%/)?.[0])),
      oiChg: safeNumber(parseNumber(cells[6])),
      oiChgPct: safeNumber(parseNumber(oiText.match(/[+-]?\d+(?:\.\d+)?\s*%/)?.[0])),
      volume: safeNumber(parseNumber(cells[0])),
      iv: safeNumber(parseNumber(cells[1])),
      delta: safeNumber(parseNumber(cells[5])),
      gamma: safeNumber(parseNumber(cells[3])),
      vega: safeNumber(parseNumber(cells[2]))
    };
  }

  function parsePutRow(row) {
    const cells = getCellTexts(row);
    const ltpText = cells[1] || "";
    const oiText = cells[2] || "";

    return {
      ltp: safeNumber(parseNumber(ltpText.split(" ")[0])),
      ltpChangePct: safeNumber(parseNumber(ltpText.match(/[+-]?\d+(?:\.\d+)?\s*%/)?.[0])),
      oiChg: safeNumber(parseNumber(cells[3])),
      oiChgPct: safeNumber(parseNumber(oiText.match(/[+-]?\d+(?:\.\d+)?\s*%/)?.[0])),
      volume: safeNumber(parseNumber(cells[9])),
      iv: safeNumber(parseNumber(cells[8])),
      delta: safeNumber(parseNumber(cells[4])),
      gamma: safeNumber(parseNumber(cells[6])),
      vega: safeNumber(parseNumber(cells[7]))
    };
  }

  function getStrikeFromRow(row, side) {
    const value = row.getAttribute("data-id")?.replace(`${side}TableOCRow`, "");
    const strike = Number.parseInt(value || "", 10);
    return Number.isSafeInteger(strike) && strike < Number.MAX_SAFE_INTEGER ? strike : NaN;
  }

  function scrapeOptionRows() {
    const leftRows = Array.from(document.querySelectorAll('tr[data-id^="leftTableOCRow"]'));
    const rightRowsByStrike = new Map(
      Array.from(document.querySelectorAll('tr[data-id^="rightTableOCRow"]'))
        .map((row) => [getStrikeFromRow(row, "right"), row])
        .filter(([strike]) => Number.isFinite(strike))
    );

    return leftRows
      .map((leftRow) => {
        const strike = getStrikeFromRow(leftRow, "left");
        const rightRow = rightRowsByStrike.get(strike);
        if (!Number.isFinite(strike) || !rightRow) return null;

        return {
          strike,
          call: parseCallRow(leftRow),
          put: parsePutRow(rightRow)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.strike - b.strike);
  }

  function scrapeTickerValue(label) {
    const nodes = Array.from(document.querySelectorAll('[data-id="headerIndicesScripDropdown"]'));
    const match = nodes.find((node) => node.innerText.toLowerCase().includes(label.toLowerCase()));
    if (!match) return NaN;

    const numericText = match.innerText.match(/\d[\d,]*(?:\.\d+)?/)?.[0];
    return parseNumber(numericText);
  }

  function scrapeIndiaVix() {
    const inlineVix = document.querySelector('[data-id="india-vix"]');
    const inlineValue = inlineVix?.parentElement?.innerText.match(/\d[\d,]*(?:\.\d+)?/)?.[0];
    if (inlineValue) return parseNumber(inlineValue);

    return scrapeTickerValue("India VIX");
  }

  function cleanStockName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s+\d[\d,]*(?:\.\d+)?.*$/, "")
      .trim();
  }

  function scrapeStockName() {
    const optionChainNode = document.querySelector('[data-id="searchButtonPrefillOC"]');
    const optionChainText = cleanStockName(
      optionChainNode?.innerText.replace(/Option\s*Chain\s*for/i, "")
    );
    if (optionChainText) return optionChainText;

    const titleName = cleanStockName(document.title);
    if (titleName) return titleName;

    const heading = Array.from(document.querySelectorAll("h1,h2,h3,[data-id]"))
      .map((node) => cleanStockName(node.innerText))
      .find((text) => /^[A-Z][A-Z0-9 &.-]{1,30}$/.test(text));
    if (heading) return heading;

    const pathPart = decodeURIComponent(window.location.pathname)
      .split("/")
      .filter(Boolean)
      .pop();
    return cleanStockName(pathPart) || "Option Chain";
  }

  function getIndexName(stockName) {
    const normalized = String(stockName || "").toUpperCase().replace(/\s+/g, "");

    if (normalized.includes("BANKNIFTY") || normalized.includes("NIFTYBANK")) {
      return "NIFTY BANK";
    }
    if (normalized.includes("FINNIFTY")) {
      return "NIFTY FIN SERVICE";
    }
    if (normalized.includes("MIDCPNIFTY")) {
      return "NIFTY MID SELECT";
    }
    if (normalized.includes("NIFTY")) {
      return "NIFTY 50";
    }
    if (normalized.includes("SENSEX")) {
      return "SENSEX";
    }
    if (normalized.includes("BANKEX")) {
      return "BANKEX";
    }

    return "Stock Option";
  }

  function scrapeMaxPain(strikes, spotPrice) {
    const bodyText = document.body.innerText;
    const labelledValue = bodyText.match(/Max\s*pain\s*[:\-]?\s*(\d[\d,]*(?:\.\d+)?)/i)?.[1];
    if (labelledValue) return parseNumber(labelledValue);

    if (!strikes.length || !Number.isFinite(spotPrice)) return NaN;
    return strikes.reduce((nearest, row) => {
      return Math.abs(row.strike - spotPrice) < Math.abs(nearest - spotPrice) ? row.strike : nearest;
    }, strikes[0].strike);
  }

  function getActiveStrikes(strikes, spotPrice) {
    if (!strikes.length) return [];

    const ranked = [...strikes].sort((a, b) => {
      return Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice);
    });

    return ranked.slice(0, 10).sort((a, b) => a.strike - b.strike);
  }

  function scrapeMarketState() {
    const allStrikes = scrapeOptionRows();
    const sensex = scrapeTickerValue("SENSEX");
    const nifty = scrapeTickerValue("NIFTY");
    const spotPrice = Number.isFinite(sensex) ? sensex : nifty;
    const strikes = getActiveStrikes(allStrikes, spotPrice);
    const stockName = scrapeStockName();

    return {
      stockName,
      indexName: getIndexName(stockName),
      spotPrice,
      maxPain: scrapeMaxPain(allStrikes, spotPrice),
      indiaVix: scrapeIndiaVix(),
      timestamp: Date.now(),
      strikes
    };
  }

  function getHistoryForMarket(marketState) {
    return marketHistory.filter((state) => state.stockName === marketState.stockName);
  }

  function rememberMarketState(marketState) {
    const cutoff = marketState.timestamp - MARKET_HISTORY_WINDOW_MS;
    marketHistory = marketHistory
      .filter((state) => state.timestamp >= cutoff && state.stockName === marketState.stockName)
      .concat(marketState);
  }

  function createOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:99999",
      "display:flex",
      "flex-direction:column",
      "gap:3px",
      "width:max-content",
      "min-width:260px",
      "max-width:min(420px, calc(100vw - 32px))",
      "padding:10px 13px",
      "border-radius:10px",
      "box-shadow:0 10px 24px rgba(15,23,42,0.24)",
      "background:#d97706",
      "color:#ffffff",
      "font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "font-size:12px",
      "line-height:1.24",
      "letter-spacing:0",
      "pointer-events:none",
      "white-space:normal",
      "overflow:visible",
      "cursor:default",
      "user-select:none"
    ].join(";");

    overlay.innerHTML = [
      '<button type="button" data-role="drag" title="Move signal overlay" style="position:absolute;top:-9px;right:-9px;width:18px;height:18px;border:0;border-radius:999px;background:#0891b2;color:#ffffff;box-shadow:0 2px 7px rgba(15,23,42,0.24);cursor:grab;padding:0;font-size:12px;line-height:18px;font-weight:900;pointer-events:auto;">•</button>',
      '<div data-role="stock" style="font-weight:800;font-size:11px;opacity:0.86;text-transform:uppercase;overflow-wrap:anywhere;"></div>',
      '<div data-role="signal" style="font-weight:900;font-size:15px;overflow-wrap:anywhere;"></div>',
      '<div data-role="meta" style="opacity:0.92;font-weight:700;overflow-wrap:anywhere;"></div>',
      '<div data-role="forecast" style="opacity:0.95;font-weight:800;overflow-wrap:anywhere;"></div>',
      '<div data-role="detail" style="opacity:0.78;overflow-wrap:anywhere;"></div>'
    ].join("");

    document.documentElement.appendChild(overlay);
    restoreOverlayPosition(overlay);
    enableOverlayDrag(overlay);
    return overlay;
  }

  function clampOverlayPosition(left, top, overlay) {
    const margin = 8;
    const width = overlay.offsetWidth || 300;
    const height = overlay.offsetHeight || 120;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop)
    };
  }

  function setOverlayPosition(overlay, position) {
    const clamped = clampOverlayPosition(position.left, position.top, overlay);
    overlay.style.left = `${clamped.left}px`;
    overlay.style.top = `${clamped.top}px`;
    overlay.style.right = "auto";
    overlay.style.bottom = "auto";
    return clamped;
  }

  function restoreOverlayPosition(overlay) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return;

    storage.get(OVERLAY_POSITION_STORAGE_KEY, (items) => {
      const position = items?.[OVERLAY_POSITION_STORAGE_KEY];
      if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
      setOverlayPosition(overlay, position);
    });
  }

  function saveOverlayPosition(position) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return;
    storage.set({ [OVERLAY_POSITION_STORAGE_KEY]: position });
  }

  function enableOverlayDrag(overlay) {
    const dragHandle = overlay.querySelector('[data-role="drag"]');
    if (!dragHandle) return;

    let dragState = null;

    dragHandle.addEventListener("pointerdown", (event) => {
      const rect = overlay.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      dragHandle.setPointerCapture(event.pointerId);
      dragHandle.style.cursor = "grabbing";
      event.preventDefault();
      event.stopPropagation();
    });

    dragHandle.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      setOverlayPosition(overlay, {
        left: event.clientX - dragState.offsetX,
        top: event.clientY - dragState.offsetY
      });
      event.preventDefault();
    });

    function endDrag(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const rect = overlay.getBoundingClientRect();
      const position = setOverlayPosition(overlay, {
        left: rect.left,
        top: rect.top
      });
      saveOverlayPosition(position);
      dragState = null;
      dragHandle.style.cursor = "grab";
    }

    dragHandle.addEventListener("pointerup", endDrag);
    dragHandle.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", () => {
      const rect = overlay.getBoundingClientRect();
      const position = setOverlayPosition(overlay, {
        left: rect.left,
        top: rect.top
      });
      saveOverlayPosition(position);
    });
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString("en-IN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function formatSignedPercent(value) {
    if (!Number.isFinite(value)) return "0.00%";
    return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  }

  function formatForecastTrend(forecast) {
    const readyTrends = (forecast.horizonTrends || []).filter((row) => row.hasEnoughHistory);
    if (!readyTrends.length) return "collecting";

    const longestTrend = readyTrends[readyTrends.length - 1];
    const minutes = Math.round(longestTrend.lookbackMs / 60000);
    return `${minutes}m Spot: ${formatSignedPercent(longestTrend.spotChangePct)}`;
  }

  function updateOverlay(result) {
    const overlay = createOverlay();
    overlay.style.background = result.signal.color;
    const trendText = result.trend.hasEnoughHistory
      ? `5m Spot: ${formatSignedPercent(result.trend.spotChangePct)}`
      : "Trend: collecting";
    overlay.querySelector('[data-role="stock"]').innerText = result.marketState.stockName;
    overlay.querySelector('[data-role="signal"]').innerText = result.signal.label;
    overlay.querySelector('[data-role="meta"]').innerText =
      `${result.marketState.indexName} | Strength ${result.strength}/100`;
    overlay.querySelector('[data-role="forecast"]').innerText =
      `${result.forecast.label} | Confidence ${result.forecast.confidence}/100`;
    overlay.querySelector('[data-role="detail"]').innerText =
      `${result.signal.detail} | ${trendText} | ${formatForecastTrend(result.forecast)} | Updated: ${formatTime(result.marketState.timestamp)} | Refresh: 10s`;
  }

  function saveLatestSignalSnapshot(result) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return;

    storage.set({
      [LATEST_SIGNAL_STORAGE_KEY]: {
        stockName: result.marketState.stockName,
        indexName: result.marketState.indexName,
        signalLabel: result.signal.label,
        signalDetail: result.signal.detail,
        signalKey: result.signal.key,
        totalScore: result.totalScore,
        strength: result.strength,
        forecastLabel: result.forecast.label,
        forecastConfidence: result.forecast.confidence,
        forecastScore: result.forecast.score,
        spotPrice: result.marketState.spotPrice,
        spotChangePct5m: result.trend.spotChangePct,
        hasTrendHistory: result.trend.hasEnoughHistory,
        updatedAt: result.marketState.timestamp
      }
    });
  }

  function isBuySignal(result) {
    return ["call", "put"].includes(result.signal.key);
  }

  function getSignalBacktests(callback) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) {
      callback([]);
      return;
    }

    storage.get({ [BACKTEST_STORAGE_KEY]: [] }, (data) => {
      const records = Array.isArray(data[BACKTEST_STORAGE_KEY]) ? data[BACKTEST_STORAGE_KEY] : [];
      callback(records);
    });
  }

  function saveSignalBacktests(records) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return;

    storage.set({
      [BACKTEST_STORAGE_KEY]: records.slice(-BACKTEST_MAX_RECORDS)
    });
  }

  function getOutcomeThreshold(spotPrice) {
    return Math.max(5, spotPrice * 0.0005);
  }

  function recordSignalBacktest(result) {
    if (!Number.isFinite(result.marketState.spotPrice)) return;

    const record = {
      id: [
        result.marketState.timestamp,
        result.signal.key,
        result.marketState.stockName
      ].join("-"),
      status: "pending",
      signalKey: result.signal.key,
      signalLabel: result.signal.label,
      stockName: result.marketState.stockName,
      indexName: result.marketState.indexName,
      entrySpot: result.marketState.spotPrice,
      entryTime: result.marketState.timestamp,
      strength: result.strength,
      horizonMs: SIGNAL_EVALUATION_HORIZON_MS
    };

    getSignalBacktests((records) => {
      if (records.some((existing) => existing.id === record.id)) return;
      saveSignalBacktests(records.concat(record));
    });
  }

  function evaluatePendingSignals(marketState) {
    if (!Number.isFinite(marketState.spotPrice)) return;

    getSignalBacktests((records) => {
      let changed = false;
      const updatedRecords = records.map((record) => {
        const horizonMs = record.horizonMs || SIGNAL_EVALUATION_HORIZON_MS;
        const isReady = marketState.timestamp - record.entryTime >= horizonMs;

        if (
          record.status !== "pending" ||
          record.stockName !== marketState.stockName ||
          !isReady
        ) {
          return record;
        }

        const spotMove = marketState.spotPrice - record.entrySpot;
        const directionalMove = record.signalKey === "call" ? spotMove : -spotMove;
        const threshold = getOutcomeThreshold(record.entrySpot);
        const status = directionalMove > threshold
          ? "hit"
          : directionalMove < -threshold
            ? "miss"
            : "flat";

        changed = true;
        return {
          ...record,
          status,
          exitSpot: marketState.spotPrice,
          exitTime: marketState.timestamp,
          spotMove,
          spotMovePct: record.entrySpot ? (spotMove / record.entrySpot) * 100 : 0,
          threshold
        };
      });

      if (changed) saveSignalBacktests(updatedRecords);
    });
  }

  function sendSignalNotification(result) {
    const trendText = result.trend.hasEnoughHistory
      ? `5m spot ${formatSignedPercent(result.trend.spotChangePct)}`
      : "trend warming up";

    chrome.runtime.sendMessage({
      type: SIGNAL_NOTIFICATION_TYPE,
      signalKey: result.signal.key,
      signalLabel: result.signal.label,
      stockName: result.marketState.stockName,
      detail: `${result.signal.detail}. Strength ${result.strength}/100. ${result.forecast.label} ${result.forecast.confidence}/100. ${trendText}.`,
      meta: result.marketState.indexName
    });
  }

  function handleSignalTransition(result) {
    const signalChanged = result.signal.key !== lastSignalKey;
    lastSignalKey = result.signal.key;

    if (!isBuySignal(result) || !signalChanged) return;

    recordSignalBacktest(result);
    sendSignalNotification(result);
  }

  function updateOverlayError(message, stockName = "Option Chain") {
    const overlay = createOverlay();
    overlay.style.background = "#6b7280";
    overlay.querySelector('[data-role="stock"]').innerText = stockName;
    overlay.querySelector('[data-role="signal"]').innerText = "WAITING";
    overlay.querySelector('[data-role="meta"]').innerText = formatTime(Date.now());
    overlay.querySelector('[data-role="forecast"]').innerText = "10-20m Forecast Warming Up";
    overlay.querySelector('[data-role="detail"]').innerText = message;
  }

  function runQuantitativeCycle() {
    try {
      const marketState = scrapeMarketState();
      if (!marketState.strikes.length) {
        updateOverlayError("Option-chain rows not ready", marketState.stockName);
        return;
      }

      const history = getHistoryForMarket(marketState);
      const result = engine.analyze(marketState, history);
      rememberMarketState(result.marketState);
      evaluatePendingSignals(result.marketState);
      saveLatestSignalSnapshot(result);
      updateOverlay(result);
      handleSignalTransition(result);
    } catch (error) {
      console.warn("[Upstox Quant Signal] Cycle failed", error);
      updateOverlayError("Temporary Upstox DOM refresh");
    }
  }

  runQuantitativeCycle();
  window.setInterval(runQuantitativeCycle, POLL_INTERVAL_MS);
})();
