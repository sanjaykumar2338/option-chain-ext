const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const engineSource = fs.readFileSync(path.join(__dirname, "../OptionSignalEngine.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");

// Run the actual content-script entrypoint with deterministic browser boundaries.
// The real parser, engine, observer callback, scheduler and alerts all execute.
function createHarness({ stockName = "NIFTY", spot = 25000, centre = 25000,
  headers = ["SENSEX 80,000.00 +1.00%", "NIFTY 25,000.00 +1.00%"] } = {}) {
  let now = Date.parse("2026-09-18T10:00:00+05:30");
  let nextTimer = 0;
  let observer;
  const timers = new Map();
  const elementsById = new Map();
  const listeners = new Map();
  const stored = {};
  const snapshots = [];
  const notifications = [];
  const warnings = [];

  class Element {
    constructor(text = "", dataId = "") {
      this.innerText = text;
      this.dataId = dataId;
      this.nodeType = 1;
      this.style = {};
      this.children = [];
      this.roles = new Map();
    }
    set innerHTML(value) {
      this.roles.clear();
      for (const match of value.matchAll(/data-role="([^"]+)"/g)) {
        this.roles.set(match[1], new Element());
      }
    }
    querySelector(selector) {
      const role = selector.match(/^\[data-role="([^"]+)"\]$/)?.[1];
      return role ? this.roles.get(role) || null : null;
    }
    querySelectorAll(selector) { return selector === "td" ? this.children : []; }
    getAttribute(name) { return name === "data-id" ? this.dataId : null; }
    addEventListener() {}
    appendChild(child) { if (child.id) elementsById.set(child.id, child); }
    closest() { return this.dataId ? this : null; }
    getBoundingClientRect() { return { left: 20, top: 20 }; }
  }

  function row(strike, side) {
    const cells = side === "left"
      ? ["1,000", "15", "2", "0.001", "-2", "0.5", "+1,000", "0.1 +10%", "100 +5%", ""]
      : ["", "100 -5%", "0.2 +10%", "+2,000", "-0.5", "-2", "0.001", "2", "15", "1,000"];
    const element = new Element("", `${side}TableOCRow${strike}`);
    element.children = cells.map((text) => new Element(text));
    return element;
  }

  const leftRows = [centre - 50, centre, centre + 50].map((strike) => row(strike, "left"));
  const rightRows = [centre - 50, centre, centre + 50].map((strike) => row(strike, "right"));
  const selected = new Element(`Option Chain for ${stockName}`, "searchButtonPrefillOC");
  const spotNode = spot == null ? null : new Element(`Spot ${spot}`, "spotPrice");
  const tickerNodes = headers.map((text) => new Element(text, "headerIndicesScripDropdown"));
  const document = {
    title: stockName,
    hidden: false,
    body: new Element(),
    documentElement: new Element(),
    getElementById: (id) => elementsById.get(id) || null,
    createElement: () => new Element(),
    addEventListener: (event, callback) => listeners.set(`document:${event}`, callback),
    querySelector(selector) {
      if (selector === '[data-id="spotPrice"]') return spotNode;
      if (selector === '[data-id="searchButtonPrefillOC"]') return selected;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'tr[data-id^="leftTableOCRow"]') return leftRows;
      if (selector === 'tr[data-id^="rightTableOCRow"]') return rightRows;
      if (selector === '[data-id="headerIndicesScripDropdown"]') return tickerNodes;
      if (selector === 'input[type="radio"]:checked') return [{ getAttribute: name => name === "name" ? "24 Sep 2026" : null }];
      return [];
    }
  };

  function addTimer(callback, delay, interval = false) {
    const id = ++nextTimer;
    timers.set(id, { callback, time: now + delay, interval: interval ? delay : 0 });
    return id;
  }

  const window = {
    location: { pathname: "/option-chain/NSE_INDEX/NIFTY" },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (event, callback) => listeners.set(event, callback),
    dispatchEvent: event => listeners.get(event.type)?.(event),
    setTimeout: (callback, delay) => addTimer(callback, delay),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => addTimer(callback, delay, true),
    clearInterval: (id) => timers.delete(id)
  };
  const context = vm.createContext({
    window,
    URL,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    document,
    Node: { ELEMENT_NODE: 1 },
    Date: class extends Date { static now() { return now; } },
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
    },
    console: { warn: (...args) => warnings.push(args) },
    chrome: {
      storage: { local: {
        get(keys, callback) {
          const defaults = typeof keys === "object" ? keys : {};
          callback({ ...defaults, ...stored });
        },
        set(values) {
          Object.assign(stored, values);
          if (values.latestSignalSnapshot) snapshots.push(values.latestSignalSnapshot);
        }
      } },
      runtime: { sendMessage(message, callback) {
        notifications.push({ ...message, at: now });
        callback({ ok: true });
      } }
    }
  });
  vm.runInContext(engineSource, context, { filename: "OptionSignalEngine.js" });
  vm.runInContext(contentSource, context, { filename: "content.js" });

  return {
    snapshots,
    setSpot(value) { spotNode.innerText = `Spot ${value}`; observer([{ target: spotNode, addedNodes: [] }]); },
    setTime(value) { for (const timer of timers.values()) timer.time += value - now; now = value; },
    notifications,
    warnings,
    get latest() { return stored.latestSignalSnapshot; },
    readOverlay(role) {
      return elementsById.get("upstox-quant-signal-overlay")?.roles.get(role)?.innerText;
    },
    mutateRow() { observer([{ target: leftRows[0], addedNodes: [] }]); },
    emitNetwork(payload) {
      listeners.get("upstox-option-chain-network-payload")({ detail: {
        payload, timestamp: now, source: "network"
      } });
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.time <= target)
          .sort((a, b) => a[1].time - b[1].time || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.time;
        if (timer.interval) timer.time += timer.interval;
        else timers.delete(id);
        timer.callback();
      }
      now = target;
    }
  };
}

test("continuous updates run within 250ms instead of starving", () => {
  const app = createHarness();
  for (let elapsed = 0; elapsed < 2000; elapsed += 100) { app.mutateRow(); app.advance(100); }
  assert.ok(app.snapshots.length >= 7);
  assert.equal(app.warnings.length, 0);
});

test("one-second heartbeat updates without DOM mutations", () => {
  const app = createHarness();
  app.advance(999); assert.equal(app.snapshots.length, 1);
  app.advance(1); assert.equal(app.snapshots.length, 2);
});

test("initial data waits for a live change; fresh bullish data alerts", () => {
  const app = createHarness();
  assert.equal(app.notifications.length, 0);
  assert.match(app.latest.signalDetail, /live/);
  app.setSpot(25001); app.advance(250);
  assert.equal(app.latest.signalLabel, "BUY CALL");
  assert.equal(app.latest.candidate.side, "call");
  assert.equal(app.notifications.length, 1);
  assert.equal(app.latest.dataQuality.validRows, 3);
});

test("stale unchanged data suppresses repeat alerts", () => {
  const app = createHarness(); app.setSpot(25001); app.advance(250);
  app.advance(31000);
  assert.equal(app.latest.signalKey, "neutral");
  assert.match(app.latest.signalDetail, /unchanged/);
  app.advance(120000); assert.equal(app.notifications.length, 1);
});

test("fresh active signal repeats after two minutes", () => {
  const app = createHarness(); app.setSpot(25001); app.advance(250);
  for (let i = 0; i < 6; i++) { app.advance(19750); app.setSpot(25002 + i); app.advance(250); }
  assert.equal(app.notifications.length, 2);
});

test("selected spot beats unrelated tickers and total OI units are correct", () => {
  const app = createHarness({ headers: ["SENSEX 80,000.00"] });
  assert.equal(app.latest.spotPrice, 25000);
  assert.equal(app.latest.metrics.callOi, 30000);
  assert.equal(app.latest.metrics.putOi, 60000);
});

test("correct ticker fallback and loading labels", () => {
  for (const [stockName, centre] of [["NIFTY BANK", 50000], ["NIFTY50", 25000]]) {
    const app = createHarness({ stockName, centre, spot: null, headers: ["NIFTY BANK 50,000.00", "NIFTY 50 25,000.00"] });
    assert.equal(app.latest.spotPrice, centre);
  }
  for (const header of ["NIFTY 50 --", "NIFTY 500 25,000.00"]) {
    const app = createHarness({ spot: null, headers: [header] });
    assert.equal(app.readOverlay("signal"), "WAITING");
    assert.equal(app.notifications.length, 0);
  }
});

test("outside regular session cannot alert even when prices change", () => {
  const app = createHarness(); app.setTime(Date.parse("2026-09-18T21:00:00+05:30"));
  app.setSpot(25001); app.advance(250);
  assert.equal(app.notifications.length, 0);
  assert.match(app.latest.signalDetail, /regular trading session/);
});

module.exports = { createHarness };

test('matching network rows supplement the chain; other expiries are rejected', () => {
  const app = createHarness();
  const row = { strike_price: 25100, underlying_key: 'NSE_INDEX|Nifty 50', expiry: '2026-09-24',
    call_options: { market_data: { ltp: 100, oi: 10000, prev_oi: 9000, volume: 1000, close_price: 95 } },
    put_options: { market_data: { ltp: 100, oi: 20000, prev_oi: 18000, volume: 1000, close_price: 105 } } };
  app.emitNetwork({ data: [row] });
  assert.equal(app.latest.dataQuality.loadedRows, 4);
  app.emitNetwork({ data: [{ ...row, strike_price: 25200, expiry: '2026-10-01' }] });
  assert.equal(app.latest.dataQuality.loadedRows, 4);
  app.advance(16000);
  assert.equal(app.latest.dataQuality.loadedRows, 3);
});
