(function runUpstoxOptionChainSignal() {
  "use strict";

  /**
   * @typedef {{ltp:number,ltpChangePct:number,oiChg:number,oiChgPct:number,volume:number,iv:number,delta:number,gamma:number,vega:number,oi?:number}} OptionSide
   * @typedef {{strike:number,call:OptionSide,put:OptionSide}} OptionStrike
   * @typedef {{stockName:string,indexName:string,spotPrice:number,maxPain:number,indiaVix:number,timestamp:number,strikes:OptionStrike[],source?:string}} MarketState
   */

  const NETWORK_EVENT_NAME = "upstox-option-chain-network-payload";
  const FALLBACK_DEBOUNCE_MS = 700;
  const SIGNAL_REPEAT_NOTIFICATION_MS = 2 * 60 * 1000;
  const SIGNAL_TOAST_MS = 8000;
  const MARKET_HISTORY_WINDOW_MS = 30 * 60 * 1000;
  const SIGNAL_EVALUATION_HORIZON_MS = 5 * 60 * 1000;
  const BACKTEST_STORAGE_KEY = "signalBacktests";
  const LATEST_SIGNAL_STORAGE_KEY = "latestSignalSnapshot";
  const OVERLAY_POSITION_STORAGE_KEY = "signalOverlayPosition";
  const BACKTEST_MAX_RECORDS = 100;
  const OVERLAY_ID = "upstox-quant-signal-overlay";
  const SIGNAL_TOAST_ID = "upstox-quant-signal-toast";
  const SIGNAL_NOTIFICATION_TYPE = "UPSTOX_OPTION_SIGNAL";
  const engine = new OptionSignalEngine();
  let marketHistory = [];
  let lastSignalKey = null;
  let lastNotification = {
    signalKey: null,
    stockName: null,
    timestamp: 0
  };
  let fallbackTimer = null;
  let signalToastTimer = null;

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

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function firstFiniteValue(source, keys, fallback = NaN) {
    if (!isPlainObject(source)) return fallback;

    for (const key of keys) {
      const directValue = source[key];
      const numericValue = typeof directValue === "number" ? directValue : parseNumber(directValue);
      if (Number.isFinite(numericValue)) return numericValue;

      const matchedKey = Object.keys(source).find((candidate) => {
        return candidate.toLowerCase() === key.toLowerCase();
      });
      if (!matchedKey) continue;

      const matchedValue = source[matchedKey];
      const matchedNumericValue = typeof matchedValue === "number"
        ? matchedValue
        : parseNumber(matchedValue);
      if (Number.isFinite(matchedNumericValue)) return matchedNumericValue;
    }

    return fallback;
  }

  function firstTextValue(source, keys, fallback = "") {
    if (!isPlainObject(source)) return fallback;

    for (const key of keys) {
      const directValue = source[key];
      if (typeof directValue === "string" && directValue.trim()) return directValue.trim();

      const matchedKey = Object.keys(source).find((candidate) => {
        return candidate.toLowerCase() === key.toLowerCase();
      });
      const matchedValue = matchedKey ? source[matchedKey] : null;
      if (typeof matchedValue === "string" && matchedValue.trim()) return matchedValue.trim();
    }

    return fallback;
  }

  function normalizeNetworkSide(source) {
    return {
      ltp: safeNumber(firstFiniteValue(source, ["ltp", "lastPrice", "last_price", "lastTradedPrice"])),
      ltpChangePct: safeNumber(firstFiniteValue(source, [
        "ltpChangePct",
        "ltp_change_pct",
        "changePercent",
        "change_percentage",
        "priceChangePercent",
        "pChange"
      ])),
      oiChg: safeNumber(firstFiniteValue(source, [
        "oiChg",
        "oi_change",
        "openInterestChange",
        "changeInOpenInterest",
        "oiChange"
      ])),
      oiChgPct: safeNumber(firstFiniteValue(source, [
        "oiChgPct",
        "oi_change_pct",
        "openInterestChangePercent",
        "oiChangePercent"
      ])),
      volume: safeNumber(firstFiniteValue(source, ["volume", "tradedVolume", "totalTradedVolume"])),
      iv: safeNumber(firstFiniteValue(source, ["iv", "impliedVolatility", "implied_volatility"])),
      delta: safeNumber(firstFiniteValue(source, ["delta"])),
      gamma: safeNumber(firstFiniteValue(source, ["gamma"])),
      vega: safeNumber(firstFiniteValue(source, ["vega"])),
      oi: safeNumber(firstFiniteValue(source, ["oi", "openInterest", "open_interest"]), NaN)
    };
  }

  function mergeSide(primary, fallback) {
    const merged = { ...primary };
    Object.keys(fallback || {}).forEach((key) => {
      if (Number.isFinite(fallback[key]) && (!Number.isFinite(merged[key]) || merged[key] === 0)) {
        merged[key] = fallback[key];
      }
    });
    return merged;
  }

  function findOptionSideContainer(row, side) {
    if (!isPlainObject(row)) return null;

    const aliases = side === "call"
      ? ["call", "ce", "CE", "Call", "CALL", "callOption", "callData"]
      : ["put", "pe", "PE", "Put", "PUT", "putOption", "putData"];

    for (const key of aliases) {
      if (isPlainObject(row[key])) return row[key];
    }

    return null;
  }

  function normalizeNetworkStrike(row) {
    if (!isPlainObject(row)) return null;

    const strike = firstFiniteValue(row, [
      "strike",
      "strikePrice",
      "strike_price",
      "sp",
      "strike_price_value"
    ]);
    if (!Number.isFinite(strike)) return null;

    const optionType = firstTextValue(row, ["optionType", "option_type", "instrumentType", "type"])
      .toLowerCase();
    const callContainer = findOptionSideContainer(row, "call");
    const putContainer = findOptionSideContainer(row, "put");

    if (callContainer || putContainer) {
      return {
        strike,
        call: normalizeNetworkSide(callContainer || {}),
        put: normalizeNetworkSide(putContainer || {})
      };
    }

    if (optionType.includes("ce") || optionType.includes("call")) {
      return { strike, call: normalizeNetworkSide(row), put: normalizeNetworkSide({}) };
    }

    if (optionType.includes("pe") || optionType.includes("put")) {
      return { strike, call: normalizeNetworkSide({}), put: normalizeNetworkSide(row) };
    }

    return null;
  }

  function collectNetworkStrikes(payload, collected = []) {
    if (Array.isArray(payload)) {
      const normalizedRows = payload.map(normalizeNetworkStrike).filter(Boolean);
      if (normalizedRows.length >= 2) collected.push(...normalizedRows);
      payload.forEach((item) => collectNetworkStrikes(item, collected));
      return collected;
    }

    if (!isPlainObject(payload)) return collected;

    const normalizedRow = normalizeNetworkStrike(payload);
    if (normalizedRow) collected.push(normalizedRow);

    Object.values(payload).forEach((value) => {
      if (value && typeof value === "object") collectNetworkStrikes(value, collected);
    });

    return collected;
  }

  function groupNetworkStrikes(rows) {
    const rowsByStrike = new Map();

    rows.forEach((row) => {
      const existing = rowsByStrike.get(row.strike) || {
        strike: row.strike,
        call: normalizeNetworkSide({}),
        put: normalizeNetworkSide({})
      };

      rowsByStrike.set(row.strike, {
        strike: row.strike,
        call: mergeSide(existing.call, row.call),
        put: mergeSide(existing.put, row.put)
      });
    });

    return Array.from(rowsByStrike.values()).sort((a, b) => a.strike - b.strike);
  }

  function findFirstNumberDeep(payload, keys, maxDepth = 5) {
    if (maxDepth < 0 || payload == null) return NaN;
    if (isPlainObject(payload)) {
      const directValue = firstFiniteValue(payload, keys);
      if (Number.isFinite(directValue)) return directValue;

      for (const value of Object.values(payload)) {
        const nestedValue = findFirstNumberDeep(value, keys, maxDepth - 1);
        if (Number.isFinite(nestedValue)) return nestedValue;
      }
    }

    if (Array.isArray(payload)) {
      for (const item of payload) {
        const nestedValue = findFirstNumberDeep(item, keys, maxDepth - 1);
        if (Number.isFinite(nestedValue)) return nestedValue;
      }
    }

    return NaN;
  }

  function findFirstTextDeep(payload, keys, maxDepth = 5) {
    if (maxDepth < 0 || payload == null) return "";
    if (isPlainObject(payload)) {
      const directValue = firstTextValue(payload, keys);
      if (directValue) return directValue;

      for (const value of Object.values(payload)) {
        const nestedValue = findFirstTextDeep(value, keys, maxDepth - 1);
        if (nestedValue) return nestedValue;
      }
    }

    if (Array.isArray(payload)) {
      for (const item of payload) {
        const nestedValue = findFirstTextDeep(item, keys, maxDepth - 1);
        if (nestedValue) return nestedValue;
      }
    }

    return "";
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

  function parseNetworkMarketState(detail) {
    const payload = detail?.payload;
    const allStrikes = groupNetworkStrikes(collectNetworkStrikes(payload));
    if (!allStrikes.length) return null;

    const fallbackState = scrapeMarketState();
    const payloadSpot = findFirstNumberDeep(payload, [
      "spotPrice",
      "spot_price",
      "underlyingValue",
      "underlying_value",
      "indexValue",
      "lastPrice"
    ]);
    const spotPrice = Number.isFinite(payloadSpot) ? payloadSpot : fallbackState.spotPrice;
    const stockName = cleanStockName(findFirstTextDeep(payload, [
      "symbol",
      "tradingSymbol",
      "trading_symbol",
      "underlyingSymbol",
      "underlying",
      "name"
    ])) || fallbackState.stockName;
    const maxPain = findFirstNumberDeep(payload, ["maxPain", "max_pain"]);
    const indiaVix = findFirstNumberDeep(payload, ["indiaVix", "india_vix", "vix"]);

    return {
      stockName,
      indexName: getIndexName(stockName),
      spotPrice,
      maxPain: Number.isFinite(maxPain) ? maxPain : scrapeMaxPain(allStrikes, spotPrice),
      indiaVix: Number.isFinite(indiaVix) ? indiaVix : fallbackState.indiaVix,
      timestamp: Number.isFinite(detail?.timestamp) ? detail.timestamp : Date.now(),
      strikes: getActiveStrikes(allStrikes, spotPrice),
      source: detail?.source || "network"
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

  function getAtmStrike(marketState) {
    if (!marketState.strikes.length || !Number.isFinite(marketState.spotPrice)) return null;

    return marketState.strikes.reduce((nearest, row) => {
      return Math.abs(row.strike - marketState.spotPrice) <
        Math.abs(nearest.strike - marketState.spotPrice)
        ? row
        : nearest;
    }, marketState.strikes[0]);
  }

  function getRiskMatrix(result) {
    const atmStrike = getAtmStrike(result.marketState);
    const side = result.signal.key === "call"
      ? atmStrike?.call
      : result.signal.key === "put"
        ? atmStrike?.put
        : null;
    const entryPrice = side?.ltp;

    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return {
        action: result.signal.label,
        strike: atmStrike?.strike,
        entryPrice: NaN,
        stopLoss: NaN,
        target: NaN
      };
    }

    return {
      action: result.signal.label,
      strike: atmStrike.strike,
      entryPrice,
      stopLoss: Math.max(0, entryPrice - 20),
      target: entryPrice + 100
    };
  }

  function formatPrice(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "--";
  }

  function formatRiskMatrix(result) {
    const risk = getRiskMatrix(result);
    if (!["call", "put"].includes(result.signal.key)) {
      return `Action: ${risk.action} | Entry: -- | SL: -- | Target: --`;
    }

    return `Action: ${risk.action} ${risk.strike || ""} | Entry: ${formatPrice(risk.entryPrice)} | SL: ${formatPrice(risk.stopLoss)} | Target: ${formatPrice(risk.target)}`;
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
      `${result.signal.detail} | ${formatRiskMatrix(result)} | ${trendText} | ${formatForecastTrend(result.forecast)} | Updated: ${formatTime(result.marketState.timestamp)} | Source: ${result.marketState.source || "dom"}`;
  }

  function showSignalToast(result, isRepeat) {
    let toast = document.getElementById(SIGNAL_TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = SIGNAL_TOAST_ID;
      toast.style.cssText = [
        "position:fixed",
        "top:72px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:100000",
        "display:flex",
        "flex-direction:column",
        "gap:4px",
        "width:max-content",
        "min-width:260px",
        "max-width:min(460px, calc(100vw - 32px))",
        "padding:11px 14px",
        "border-radius:8px",
        "box-shadow:0 12px 30px rgba(15,23,42,0.28)",
        "color:#ffffff",
        "font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        "font-size:12px",
        "line-height:1.25",
        "letter-spacing:0",
        "pointer-events:none",
        "white-space:normal",
        "overflow-wrap:anywhere"
      ].join(";");
      toast.innerHTML = [
        '<div data-role="signal" style="font-weight:900;font-size:16px;"></div>',
        '<div data-role="detail" style="font-weight:700;opacity:0.92;"></div>'
      ].join("");
      document.documentElement.appendChild(toast);
    }

    toast.style.background = result.signal.color;
    toast.querySelector('[data-role="signal"]').innerText =
      `${isRepeat ? "STILL ACTIVE: " : ""}${result.signal.label}`;
    toast.querySelector('[data-role="detail"]').innerText =
      `${result.marketState.stockName} | Strength ${result.strength}/100 | ${result.forecast.label}`;
    toast.style.display = "flex";

    window.clearTimeout(signalToastTimer);
    signalToastTimer = window.setTimeout(() => {
      toast.style.display = "none";
    }, SIGNAL_TOAST_MS);
  }

  function playSignalAudioCue(signalKey) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const audioContext = new AudioContextCtor();
      const frequencies = signalKey === "call" ? [660, 880] : [440, 330];
      const startedAt = audioContext.currentTime;

      frequencies.forEach((frequency, index) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const start = startedAt + index * 0.13;
        const stop = start + 0.11;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, stop);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(stop);
      });

      window.setTimeout(() => {
        audioContext.close().catch(() => {});
      }, 500);
    } catch (error) {
      console.warn("[Upstox Quant Signal] Audio cue failed", error);
    }
  }

  function saveLatestSignalSnapshot(result) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return;

    const risk = getRiskMatrix(result);
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
        risk,
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
    }, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        console.warn("[Upstox Quant Signal] Notification send failed", lastError.message);
      }
    });
  }

  function handleSignalTransition(result) {
    const previousSignalKey = lastSignalKey;
    const signalChanged = result.signal.key !== previousSignalKey;
    lastSignalKey = result.signal.key;

    if (!isBuySignal(result)) return;

    const notificationChanged =
      result.signal.key !== lastNotification.signalKey ||
      result.marketState.stockName !== lastNotification.stockName;
    const notificationStale =
      result.marketState.timestamp - lastNotification.timestamp >= SIGNAL_REPEAT_NOTIFICATION_MS;

    if (!signalChanged && !notificationChanged && !notificationStale) return;

    if (signalChanged) {
      recordSignalBacktest(result);
      playSignalAudioCue(result.signal.key);
    }

    lastNotification = {
      signalKey: result.signal.key,
      stockName: result.marketState.stockName,
      timestamp: result.marketState.timestamp
    };
    showSignalToast(result, !signalChanged);
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

  function processMarketState(marketState) {
    try {
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

  function runFallbackDomCycle() {
    processMarketState(scrapeMarketState());
  }

  function scheduleFallbackDomCycle() {
    window.clearTimeout(fallbackTimer);
    fallbackTimer = window.setTimeout(runFallbackDomCycle, FALLBACK_DEBOUNCE_MS);
  }

  function handleNetworkPayload(event) {
    try {
      const marketState = parseNetworkMarketState(event.detail);
      if (!marketState?.strikes.length) return;
      processMarketState(marketState);
    } catch (error) {
      console.warn("[Upstox Quant Signal] Network payload ignored", error);
      scheduleFallbackDomCycle();
    }
  }

  function installDomFallbackObserver() {
    const observer = new MutationObserver((mutations) => {
      const hasOptionChainMutation = mutations.some((mutation) => {
        const targetElement = mutation.target?.nodeType === Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target?.parentElement;
        if (targetElement?.closest?.('tr[data-id^="leftTableOCRow"],tr[data-id^="rightTableOCRow"]')) {
          return true;
        }

        return Array.from(mutation.addedNodes).some((node) => {
          return node.nodeType === Node.ELEMENT_NODE &&
            (node.matches?.('tr[data-id^="leftTableOCRow"],tr[data-id^="rightTableOCRow"]') ||
              node.querySelector?.('tr[data-id^="leftTableOCRow"],tr[data-id^="rightTableOCRow"]'));
        });
      });

      if (hasOptionChainMutation) scheduleFallbackDomCycle();
    });

    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  window.addEventListener(NETWORK_EVENT_NAME, handleNetworkPayload);
  installDomFallbackObserver();
  runFallbackDomCycle();
})();
