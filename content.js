(function runUpstoxOptionChainSignal() {
  "use strict";

  /**
   * @typedef {{ltp:number,ltpChangePct:number,oiChg:number,oiChgPct:number,volume:number,iv:number,delta:number,gamma:number,vega:number,oi?:number}} OptionSide
   * @typedef {{strike:number,call:OptionSide,put:OptionSide}} OptionStrike
   * @typedef {{stockName:string,indexName:string,spotPrice:number,maxPain:number,indiaVix:number,timestamp:number,strikes:OptionStrike[],source?:string}} MarketState
   */

  const NETWORK_EVENT_NAME = "upstox-option-chain-network-payload";
  const FALLBACK_THROTTLE_MS = 250;
  const DOM_REFRESH_INTERVAL_MS = 1000;
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

  function normalizeNumericText(value) {
    return String(value ?? "").replace(/[\u2212\u2013\u2014]/g, "-")
      .replace(/\uFF0B/g, "+").replace(/,/g, "").trim();
  }

  function parseNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    const match = normalizeNumericText(value).match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(Cr|crores?|L|lakhs?|K|thousands?)?\s*%?$/i);
    if (!match) return NaN;
    const unit = (match[2] || "").toLowerCase();
    const multiplier = unit.startsWith("cr") ? 10000000
      : unit.startsWith("l") ? 100000 : /^(k|thousand)/.test(unit) ? 1000 : 1;
    return Number(match[1]) * multiplier;
  }

  function parseCellNumber(value, header = "") {
    const text = normalizeNumericText(value);
    const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(Cr|crores?|L|lakhs?|K|thousands?)?(?![a-z])/i);
    if (!match || text.slice(match[0].length).trim().startsWith("%")) return NaN;
    const numeric = parseNumber(match[0]);
    // Explicit units on the value take precedence over table header units.
    if (match[2]) return numeric;
    if (/\b(lakhs?|lacs?)\b/i.test(header)) return numeric * 100000;
    if (/\bcrores?\b/i.test(header)) return numeric * 10000000;
    if (/\bthousands?\b/i.test(header)) return numeric * 1000;
    return numeric;
  }

  function parsePercentage(value) {
    return parseNumber(normalizeNumericText(value).match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*%/)?.[0]);
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

  function normalizeNetworkSide(source = {}) {
    const market = isPlainObject(source.market_data) ? source.market_data : source;
    const greeks = isPlainObject(source.option_greeks) ? source.option_greeks : source;
    const read = (keys) => firstFiniteValue(market, keys, firstFiniteValue(source, keys));
    const result = {
      ltp: read(["ltp", "lastPrice", "last_price", "lastTradedPrice"]),
      ltpChangePct: read(["ltpChangePct", "ltp_change_pct", "changePercent", "change_percentage", "priceChangePercent", "pChange"]),
      oi: read(["oi", "openInterest", "open_interest"]),
      oiChg: read(["oiChg", "oi_change", "openInterestChange", "changeInOpenInterest", "oiChange"]),
      oiChgPct: read(["oiChgPct", "oi_change_pct", "openInterestChangePercent", "oiChangePercent"]),
      volume: read(["volume", "tradedVolume", "totalTradedVolume"]),
      iv: firstFiniteValue(greeks, ["iv", "impliedVolatility", "implied_volatility"]),
      delta: firstFiniteValue(greeks, ["delta"]),
      gamma: firstFiniteValue(greeks, ["gamma"]),
      vega: firstFiniteValue(greeks, ["vega"]),
      theta: firstFiniteValue(greeks, ["theta"]),
      closePrice: read(["close_price", "closePrice", "previousClose"]),
      prevOi: read(["prev_oi", "prevOi", "previousOi"]),
      bidPrice: read(["bid_price", "bidPrice", "bestBid"]),
      askPrice: read(["ask_price", "askPrice", "bestAsk"]),
      bidQty: read(["bid_qty", "bidQty", "bidQuantity"]),
      askQty: read(["ask_qty", "askQty", "askQuantity"]),
      instrumentKey: firstTextValue(source, ["instrument_key", "instrumentKey"])
    };
    if (!Number.isFinite(result.ltpChangePct) && Number.isFinite(result.ltp) && result.closePrice > 0) {
      result.ltpChangePct = (result.ltp / result.closePrice - 1) * 100;
    }
    if (!Number.isFinite(result.oiChg) && Number.isFinite(result.oi) && Number.isFinite(result.prevOi)) {
      result.oiChg = result.oi - result.prevOi;
    }
    if (!Number.isFinite(result.oiChgPct) && Number.isFinite(result.oiChg) && result.prevOi > 0) {
      result.oiChgPct = result.oiChg / result.prevOi * 100;
    }
    return result;
  }

  function mergeSide(primary, fallback) {
    const merged = { ...primary };
    Object.keys(fallback || {}).forEach((key) => {
      if (Number.isFinite(fallback[key]) && !Number.isFinite(merged[key])) merged[key] = fallback[key];
      if (key === "instrumentKey" && !merged[key]) merged[key] = fallback[key];
    });
    return merged;
  }

  function findOptionSideContainer(row, side) {
    if (!isPlainObject(row)) return null;
    const aliases = side === "call"
      ? ["call_options", "call", "ce", "CE", "Call", "CALL", "callOption", "callData"]
      : ["put_options", "put", "pe", "PE", "Put", "PUT", "putOption", "putData"];
    return aliases.map((key) => row[key]).find(isPlainObject) || null;
  }

  function normalizeNetworkStrike(row, context = {}) {
    if (!isPlainObject(row)) return null;
    const strike = firstFiniteValue(row, ["strike", "strikePrice", "strike_price", "sp", "strike_price_value"]);
    if (!(strike > 0 && strike < Number.MAX_SAFE_INTEGER)) return null;
    const optionType = firstTextValue(row, ["optionType", "option_type", "instrumentType", "type"]).toLowerCase();
    const callContainer = findOptionSideContainer(row, "call");
    const putContainer = findOptionSideContainer(row, "put");
    const call = callContainer || (/^(ce|call)$/.test(optionType) ? row : null);
    const put = putContainer || (/^(pe|put)$/.test(optionType) ? row : null);
    if (!call && !put) return null;
    return {
      strike,
      call: normalizeNetworkSide(call || {}),
      put: normalizeNetworkSide(put || {}),
      expiry: normalizeExpiry(firstTextValue(row, ["expiry", "expiry_date", "expiryDate"])) || context.expiry || "",
      underlyingKey: firstTextValue(row, ["underlying_key", "underlyingKey", "underlying_instrument_key"]) || context.underlyingKey || "",
      spotPrice: firstFiniteValue(row, ["underlying_spot_price", "spotPrice", "spot_price", "underlyingValue", "underlying_value"], context.spotPrice)
    };
  }

  function collectNetworkStrikes(payload, collected = [], context = {}, depth = 0) {
    if (!payload || depth > 12 || collected.length >= 5000) return collected;
    if (Array.isArray(payload)) {
      payload.forEach((item) => collectNetworkStrikes(item, collected, context, depth + 1));
    } else if (isPlainObject(payload)) {
      const inherited = {
        expiry: normalizeExpiry(firstTextValue(payload, ["expiry", "expiry_date", "expiryDate"])) || context.expiry || "",
        underlyingKey: firstTextValue(payload, ["underlying_key", "underlyingKey", "underlying_instrument_key"]) || context.underlyingKey || "",
        spotPrice: firstFiniteValue(payload, ["underlying_spot_price", "spotPrice", "spot_price", "underlyingValue", "underlying_value", "indexValue"], context.spotPrice)
      };
      const row = normalizeNetworkStrike(payload, inherited);
      if (row) collected.push(row);
      else Object.values(payload).forEach((value) => {
        if (value && typeof value === "object") collectNetworkStrikes(value, collected, inherited, depth + 1);
      });
    }
    return collected;
  }

  function groupNetworkStrikes(rows) {
    const rowsByStrike = new Map();
    rows.forEach((row) => {
      const existing = rowsByStrike.get(row.strike);
      rowsByStrike.set(row.strike, existing ? {
        ...existing,
        call: mergeSide(existing.call, row.call),
        put: mergeSide(existing.put, row.put)
      } : row);
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

  function getCellTexts(row) {
    return Array.from(row.querySelectorAll("td")).map((cell) => String(cell.innerText ?? cell.textContent ?? "").replace(/\s+/g, " ").trim());
  }

  function columnField(header) {
    const name = String(header || "").toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
    if (/^(oi|open interest)/.test(name)) {
      if (/(chg|change)/.test(name)) return /%|percent/.test(name) ? "oiChgPct" : "oiChg";
      return "oi";
    }
    if (/^(ltp|last (traded )?price)/.test(name)) return /%|percent/.test(name) ? "ltpChangePct" : "ltp";
    if (/^(bid|buy).*(qty|quantity)/.test(name)) return "bidQty";
    if (/^(ask|offer|sell).*(qty|quantity)/.test(name)) return "askQty";
    if (/^(bid|buy)( price)?$/.test(name)) return "bidPrice";
    if (/^(ask|offer|sell)( price)?$/.test(name)) return "askPrice";
    if (/^(iv|implied volatility)(\b|$)/.test(name)) return "iv";
    if (/^(volume|vol)(\b|$)/.test(name)) return "volume";
    return ["delta", "gamma", "vega", "theta"].find((field) => name === field) || "";
  }

  function parseOptionRow(row, side) {
    const cells = getCellTexts(row);
    const table = row.closest?.("table");
    const headers = Array.from(table?.querySelectorAll("thead th") || [])
      .map((cell) => String(cell.innerText ?? cell.textContent ?? "").trim());
    const result = normalizeNetworkSide({});
    let fields;
    let labels = headers;
    if (headers.length) {
      // A changed/hidden column must never shift unrelated values into Greeks.
      if (headers.length !== cells.length) return result;
      fields = headers.map(columnField);
      if (!fields.includes("ltp") || new Set(fields.filter(Boolean)).size !== fields.filter(Boolean).length) return result;
    } else {
      // Only the observed ten-column Upstox layout has a fixed-index fallback.
      if (cells.length !== 10) return result;
      fields = side === "call"
        ? ["volume", "iv", "vega", "gamma", "theta", "delta", "oiChg", "oi", "ltp", ""]
        : ["", "ltp", "oi", "oiChg", "delta", "theta", "gamma", "vega", "iv", "volume"];
      labels = fields.map((field) => field === "oi" ? "OI (lakhs)" : field);
    }
    fields.forEach((field, index) => {
      if (!field) return;
      result[field] = /Pct$/.test(field) ? parsePercentage(cells[index]) : parseCellNumber(cells[index], labels[index]);
      if (field === "ltp") result.ltpChangePct = parsePercentage(cells[index]);
      if (field === "oi") result.oiChgPct = parsePercentage(cells[index]);
    });
    return result;
  }

  function parseCallRow(row) { return parseOptionRow(row, "call"); }
  function parsePutRow(row) { return parseOptionRow(row, "put"); }

  function getStrikeFromRow(row, side) {
    const value = row.getAttribute("data-id") || "";
    const prefix = `${side}TableOCRow`;
    if (!value.startsWith(prefix)) return NaN;
    const strike = parseNumber(value.slice(prefix.length));
    return strike > 0 && strike < Number.MAX_SAFE_INTEGER ? strike : NaN;
  }

  function scrapeOptionRows() {
    const rowsByStrike = new Map();
    for (const [position, side] of [["left", "call"], ["right", "put"]]) {
      for (const row of document.querySelectorAll(`tr[data-id^="${position}TableOCRow"]`)) {
        const strike = getStrikeFromRow(row, position);
        if (!Number.isFinite(strike)) continue;
        const current = rowsByStrike.get(strike) || { strike, call: normalizeNetworkSide({}), put: normalizeNetworkSide({}) };
        current[side] = parseOptionRow(row, side);
        rowsByStrike.set(strike, current);
      }
    }
    return Array.from(rowsByStrike.values()).sort((a, b) => a.strike - b.strike);
  }

  function scrapeTickerValue(label) {
    const nodes = Array.from(document.querySelectorAll('[data-id="headerIndicesScripDropdown"]'));
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`^${escapedLabel}\\s+(\\d[\\d,]*(?:\\.\\d+)?)`, "i");

    for (const node of nodes) {
      const numericText = node.innerText.trim().match(pattern)?.[1];
      // A bare integer after the abbreviated NIFTY label may be part of an
      // index name (NIFTY 50 / NIFTY 500). Require a formatted quote here;
      // the full NIFTY 50 alias above can also read unformatted integer prices.
      if (label.toUpperCase() === "NIFTY" && /^\d+$/.test(numericText || "")) continue;
      const value = parseNumber(numericText);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return NaN;
  }

  function scrapeSpotPrice(stockName) {
    const spotNode = document.querySelector('[data-id="spotPrice"]');
    const spotText = spotNode?.innerText.match(/\d[\d,]*(?:\.\d+)?/)?.[0];
    const spotPrice = parseNumber(spotText);
    if (Number.isFinite(spotPrice) && spotPrice > 0) return spotPrice;

    const indexName = getIndexName(stockName);
    const aliases = {
      "NIFTY 50": ["NIFTY 50", "NIFTY"],
      "NIFTY BANK": ["NIFTY BANK", "BANK NIFTY", "BANKNIFTY"],
      "NIFTY FIN SERVICE": ["NIFTY FIN SERVICE", "FINNIFTY"],
      "NIFTY MID SELECT": ["NIFTY MID SELECT", "MIDCPNIFTY"]
    };
    for (const label of aliases[indexName] || [stockName]) {
      const value = scrapeTickerValue(label);
      if (Number.isFinite(value)) return value;
    }
    return NaN;
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
    if (normalized.includes("FINNIFTY") || normalized.includes("NIFTYFINSERVICE")) {
      return "NIFTY FIN SERVICE";
    }
    if (normalized.includes("MIDCPNIFTY") || normalized.includes("NIFTYMIDSELECT")) {
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

  function scrapeMaxPain() {
    const bodyText = document.body?.innerText || "";
    return parseNumber(bodyText.match(/Max\s*pain\s*[:\-]?\s*(\d[\d,]*(?:\.\d+)?)/i)?.[1]);
  }

  function normalizeExpiry(value) {
    const text = String(value || "").trim();
    const iso = text.match(/^(20\d{2})-(\d{2})-(\d{2})(?:$|T)/);
    const label = text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(20\d{2})\b/i);
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const year = iso ? Number(iso[1]) : label ? Number(label[3]) : NaN;
    const month = iso ? Number(iso[2]) : label ? months.indexOf(label[2].toLowerCase()) + 1 : NaN;
    const day = iso ? Number(iso[3]) : label ? Number(label[1]) : NaN;
    if (!Number.isFinite(year)) return "";
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function scrapeExpiry() {
    // The captured Upstox page uses checked radio inputs named by expiry date.
    const selectors = ['input[type="radio"]:checked', '[role="tab"][aria-selected="true"]', '[data-expiry][aria-selected="true"]'];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const expiry = normalizeExpiry(node.getAttribute("data-expiry"))
          || normalizeExpiry(node.getAttribute("name")) || normalizeExpiry(node.innerText);
        if (expiry) return expiry;
      }
    }
    return "";
  }

  function canonicalUnderlyingKey(value) {
    const parts = String(value || "").trim().split("|");
    if (parts.length !== 2) return String(value || "").toUpperCase().replace(/\s+/g, "");
    const name = getIndexName(parts[1]);
    return `${parts[0].toUpperCase()}|${(name === "Stock Option" ? parts[1] : name).toUpperCase().replace(/\s+/g, "")}`;
  }

  function scrapeUnderlyingKey(stockName) {
    const selected = document.querySelector('[data-id="searchButtonPrefillOC"]');
    const explicit = selected?.getAttribute?.("data-instrument-key");
    if (explicit) return explicit;
    let parts;
    try { parts = decodeURIComponent(window.location.pathname).split("/").filter(Boolean); } catch (_error) { parts = []; }
    const chainIndex = parts.indexOf("option-chain");
    const exchange = parts[chainIndex + 1];
    const routeSymbol = parts[chainIndex + 2];
    if (routeSymbol && /^[A-Z]+_(INDEX|EQ)$/i.test(exchange)) {
      return `${exchange}|${exchange.endsWith("INDEX") ? getIndexName(stockName) : routeSymbol}`;
    }
    return "";
  }

  function buildMarketKey(stockName, expiry, underlyingKey) {
    return [String(stockName).toUpperCase().replace(/\s+/g, ""), expiry || "unknown-expiry", canonicalUnderlyingKey(underlyingKey)].join("::");
  }

  let networkSupplement = null;

  function mergeStrikeSources(primary, fallback) {
    const fallbackByStrike = new Map(fallback.map((row) => [row.strike, row]));
    const rows = primary.map((row) => {
      const other = fallbackByStrike.get(row.strike);
      fallbackByStrike.delete(row.strike);
      return other ? { ...row, call: mergeSide(row.call, other.call), put: mergeSide(row.put, other.put) } : row;
    });
    return [...rows, ...fallbackByStrike.values()].sort((a, b) => a.strike - b.strike);
  }

  function scrapeMarketState(includeNetwork = true) {
    const stockName = scrapeStockName();
    const expiry = scrapeExpiry();
    const underlyingKey = scrapeUnderlyingKey(stockName);
    const marketKey = buildMarketKey(stockName, expiry, underlyingKey);
    const state = {
      stockName, indexName: getIndexName(stockName), expiry, underlyingKey, marketKey,
      spotPrice: scrapeSpotPrice(stockName), maxPain: scrapeMaxPain(), indiaVix: scrapeIndiaVix(),
      timestamp: Date.now(), strikes: scrapeOptionRows(), source: "dom"
    };
    if (networkSupplement && (networkSupplement.marketKey !== marketKey || state.timestamp - networkSupplement.timestamp > 15000 || state.timestamp < networkSupplement.timestamp)) {
      networkSupplement = null;
    }
    if (includeNetwork && networkSupplement) {
      state.strikes = mergeStrikeSources(state.strikes, networkSupplement.strikes);
      if (!Number.isFinite(state.spotPrice)) state.spotPrice = networkSupplement.spotPrice;
      if (!Number.isFinite(state.maxPain)) state.maxPain = networkSupplement.maxPain;
      if (!Number.isFinite(state.indiaVix)) state.indiaVix = networkSupplement.indiaVix;
      state.source = "dom+network";
      state.networkTimestamp = networkSupplement.timestamp;
    }
    return state;
  }

  function networkRequestContext(detail) {
    try {
      const url = new URL(detail?.url || "", "https://pro.upstox.com");
      return {
        underlyingKey: url.searchParams.get("instrument_key") || url.searchParams.get("underlying_key") || "",
        expiry: normalizeExpiry(url.searchParams.get("expiry_date") || url.searchParams.get("expiry"))
      };
    } catch (_error) { return {}; }
  }

  function parseNetworkMarketState(detail) {
    const fallbackState = scrapeMarketState(false);
    const timestamp = Number.isFinite(detail?.timestamp) ? detail.timestamp : Date.now();
    if (Date.now() - timestamp > 15000 || timestamp > Date.now() + 1000) return null;
    const context = networkRequestContext(detail);
    const rows = collectNetworkStrikes(detail?.payload, [], context);
    // Unidentified responses cannot safely be assigned to the selected chain.
    const allStrikes = groupNetworkStrikes(rows.filter((row) => {
      if (!fallbackState.expiry || !row.expiry || row.expiry !== fallbackState.expiry) return false;
      if (!fallbackState.underlyingKey || !row.underlyingKey) return false;
      return canonicalUnderlyingKey(row.underlyingKey) === canonicalUnderlyingKey(fallbackState.underlyingKey);
    }));
    if (!allStrikes.length) return null;
    const payloadSpot = allStrikes.find((row) => Number.isFinite(row.spotPrice) && row.spotPrice > 0)?.spotPrice;
    const payload = detail?.payload;
    // Metadata is only accepted at response scope after every parsed row matches.
    const allRowsMatch = allStrikes.length === groupNetworkStrikes(rows).length
      && rows.every((row) => row.expiry === fallbackState.expiry && canonicalUnderlyingKey(row.underlyingKey) === canonicalUnderlyingKey(fallbackState.underlyingKey));
    const maxPain = allRowsMatch ? findFirstNumberDeep(payload, ["maxPain", "max_pain"]) : NaN;
    const indiaVix = allRowsMatch ? findFirstNumberDeep(payload, ["indiaVix", "india_vix", "vix"]) : NaN;
    networkSupplement = {
      ...fallbackState, timestamp, strikes: allStrikes,
      spotPrice: Number.isFinite(payloadSpot) ? payloadSpot : fallbackState.spotPrice,
      maxPain, indiaVix
    };
    return {
      ...fallbackState,
      spotPrice: Number.isFinite(fallbackState.spotPrice) ? fallbackState.spotPrice : payloadSpot,
      maxPain: Number.isFinite(fallbackState.maxPain) ? fallbackState.maxPain : maxPain,
      indiaVix: Number.isFinite(fallbackState.indiaVix) ? fallbackState.indiaVix : indiaVix,
      timestamp, networkTimestamp: timestamp,
      strikes: mergeStrikeSources(fallbackState.strikes, allStrikes),
      source: `dom+${detail?.source || "network"}`
    };
  }

  function getHistoryForMarket(marketState) {
    return marketHistory.filter((state) => engine.marketKey(state) === engine.marketKey(marketState));
  }

  function rememberMarketState(marketState) {
    const cutoff = marketState.timestamp - MARKET_HISTORY_WINDOW_MS;
    marketHistory = marketHistory.filter((state) => state.timestamp >= cutoff && engine.marketKey(state) === engine.marketKey(marketState));
    if (!marketHistory.length || marketState.timestamp - marketHistory.at(-1).timestamp >= 5000) marketHistory.push(marketState);
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
    const candidate = isBuySignal(result) ? result.candidate : null;
    return { action: result.signal.label, strike: candidate?.strike,
      entryPrice: candidate?.ltp, stopLoss: NaN, target: NaN };
  }

  function formatPrice(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "--";
  }

  function formatRiskMatrix(result) {
    const candidate = isBuySignal(result) ? result.candidate : null;
    if (!candidate) return "No entry candidate";
    return `${candidate.strike} ${candidate.side === "call" ? "CE" : "PE"} | LTP ${formatPrice(candidate.ltp)} | Spread ${formatPrice(candidate.spreadPct)}% | Δ ${formatPrice(candidate.delta)} | IV ${formatPrice(candidate.iv)} | θ ${formatPrice(candidate.theta)}`;
  }

  function updateOverlay(result) {
    const overlay = createOverlay();
    overlay.style.background = result.signal.color;
    const trendText = result.trend.hasEnoughHistory
      ? `5m Spot: ${formatSignedPercent(result.trend.spotChangePct)}`
      : "Trend: collecting";
    overlay.querySelector('[data-role="stock"]').innerText = `${result.marketState.stockName} | ${result.marketState.expiry || "Expiry unavailable"}`;
    overlay.querySelector('[data-role="signal"]').innerText = result.signal.label;
    overlay.querySelector('[data-role="meta"]').innerText =
      `${result.marketState.strikes.length} loaded strikes | Score ${result.totalScore} | Data ${result.dataQuality?.score ?? 0}/100`;
    overlay.querySelector('[data-role="forecast"]').innerText =
      `${formatRiskMatrix(result)} | OI PCR ${formatPrice(result.metrics?.pcrOi)}`;
    overlay.querySelector('[data-role="detail"]').innerText =
      `${result.signal.detail} | ${(result.reasons || []).join("; ")} | ${trendText} | Support ${result.metrics?.support?.strike || "--"} / Resistance ${result.metrics?.resistance?.strike || "--"} | ${(result.candidate?.warnings || result.dataQuality?.warnings || []).join("; ")} | Data changed: ${formatTime(result.marketState.dataUpdatedAt)} | Checked: ${formatTime(result.marketState.timestamp)}`;
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
        forecastKey: result.forecast.key,
        forecastDetail: result.forecast.detail,
        forecastConfidence: result.forecast.confidence,
        forecastScore: result.forecast.score,
        spotPrice: result.marketState.spotPrice,
        risk,
        expiry: result.marketState.expiry,
        marketKey: engine.marketKey(result.marketState),
        dataQuality: result.dataQuality,
        reasons: result.reasons,
        blockers: result.blockers,
        metrics: result.metrics,
        candidate: result.candidate,
        dataUpdatedAt: result.marketState.dataUpdatedAt,
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
      marketKey: engine.marketKey(result.marketState),
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
          record.marketKey !== engine.marketKey(marketState) ||
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
      detail: `${result.signal.detail}. Strength ${result.strength}/100. ${result.forecast.label}${result.forecast.key === "warming" ? "" : ` ${result.forecast.confidence}/100`}. ${trendText}.`,
      meta: result.marketState.indexName
    }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        console.warn("[Upstox Quant Signal] Notification send failed", lastError.message);
      } else if (response?.ok === false && response.reason !== "disabled") {
        console.warn("[Upstox Quant Signal] Notification failed", response.error);
      }
    });
  }

  function handleSignalTransition(result) {
    const previousSignalKey = lastSignalKey;
    const signalChanged = result.signal.key !== previousSignalKey || engine.marketKey(result.marketState) !== lastNotification.marketKey;
    lastSignalKey = result.signal.key;

    if (!isBuySignal(result)) return;

    const notificationChanged =
      result.signal.key !== lastNotification.signalKey ||
      engine.marketKey(result.marketState) !== lastNotification.marketKey;
    const notificationStale =
      result.marketState.timestamp - lastNotification.timestamp >= SIGNAL_REPEAT_NOTIFICATION_MS;

    if (!signalChanged && !notificationChanged && !notificationStale) return;

    if (signalChanged) {
      recordSignalBacktest(result);
      playSignalAudioCue(result.signal.key);
    }

    lastNotification = {
      marketKey: engine.marketKey(result.marketState),
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
    lastSignalKey = null;
    const toast = document.getElementById(SIGNAL_TOAST_ID);
    if (toast) toast.style.display = "none";
    globalThis.chrome?.storage?.local?.set({ [LATEST_SIGNAL_STORAGE_KEY]: {
      stockName, signalKey: "neutral", signalLabel: "WAITING", signalDetail: message, updatedAt: Date.now()
    } });
  }

  let freshness = null;

  function isOptionChainPage() {
    return /^\/option-chain(?:\/|$)/.test(window.location.pathname);
  }

  function stampDataStatus(state) {
    const now = Date.now();
    const key = engine.marketKey(state);
    const rows = new Map(state.strikes.map((row) => [row.strike, row]));
    let changed = false;
    if (freshness?.key === key) {
      changed = Number.isFinite(state.spotPrice) && Number.isFinite(freshness.spot) && state.spotPrice !== freshness.spot;
      for (const [strike, row] of rows) {
        const previous = freshness.rows.get(strike);
        if (!previous) continue;
        for (const side of ["call", "put"]) for (const field of ["ltp", "oi", "volume"]) {
          if (Number.isFinite(row[side]?.[field]) && Number.isFinite(previous[side]?.[field]) && row[side][field] !== previous[side][field]) changed = true;
        }
      }
    } else freshness = { key, updatedAt: now, observed: false };
    freshness = { ...freshness, rows, spot: state.spotPrice,
      updatedAt: changed ? now : freshness.updatedAt, observed: freshness.observed || changed };
    state.timestamp = now;
    state.dataUpdatedAt = freshness.updatedAt;
    state.hasObservedChange = freshness.observed;
    const ist = new Date(now + 19800000);
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    // Regular equity derivatives session; no holiday/special-session calendar.
    const closeMinute = ist.toISOString().slice(0, 10) >= "2026-08-03" ? 940 : 930;
    state.sessionOpen = ist.getUTCDay() > 0 && ist.getUTCDay() < 6 && minutes >= 555 && minutes < closeMinute;
  }

  function processMarketState(marketState) {
    try {
      if (!isOptionChainPage()) return;
      stampDataStatus(marketState);
      if (!marketState.strikes.length) {
        updateOverlayError("Option-chain rows not ready", marketState.stockName);
        return;
      }
      if (!Number.isFinite(marketState.spotPrice) || marketState.spotPrice <= 0) {
        updateOverlayError("Waiting for the selected option chain's spot price", marketState.stockName);
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
    window.clearTimeout(fallbackTimer);
    fallbackTimer = null;
    try {
      if (!isOptionChainPage()) {
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(SIGNAL_TOAST_ID)?.remove();
        marketHistory = []; freshness = null; networkSupplement = null; lastSignalKey = null;
        return;
      }
      processMarketState(scrapeMarketState());
    } catch (error) {
      console.warn("[Upstox Quant Signal] DOM read failed", error);
      updateOverlayError("Waiting for option-chain data to refresh");
    }
  }

  function scheduleFallbackDomCycle() {
    // Do not postpone an already scheduled check on each incoming quote.
    if (fallbackTimer !== null) return;
    fallbackTimer = window.setTimeout(runFallbackDomCycle, FALLBACK_THROTTLE_MS);
  }

  function handleNetworkPayload(event) {
    try {
      if (!isOptionChainPage()) return;
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
        if (targetElement?.closest?.('tr[data-id^="leftTableOCRow"],tr[data-id^="rightTableOCRow"],[data-id="spotPrice"],[data-id="searchButtonPrefillOC"]')) {
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
  window.addEventListener("focus", scheduleFallbackDomCycle);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleFallbackDomCycle();
  });
  document.addEventListener("change", scheduleFallbackDomCycle);
  installDomFallbackObserver();
  window.dispatchEvent(new CustomEvent("upstox-option-chain-request-latest"));
  runFallbackDomCycle();
  window.setInterval(runFallbackDomCycle, DOM_REFRESH_INTERVAL_MS);
})();
