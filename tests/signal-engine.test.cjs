const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../OptionSignalEngine.js");

function marketState(direction) {
  const bullish = direction === "bullish";
  const bearish = direction === "bearish";
  return {
    stockName: "NIFTY",
    spotPrice: 25000,
    timestamp: 1000000,
    strikes: Array.from({ length: 10 }, (_, index) => ({
      strike: 24800 + index * 50,
      call: {
        ltp: 100, oi: bearish ? 20000 : 10000,
        ltpChangePct: bearish ? -5 : 5,
        oiChg: bearish ? 2000 : 1000,
        volume: 1000
      },
      put: {
        ltp: 100, oi: bullish ? 20000 : 10000,
        ltpChangePct: bullish ? -5 : 5,
        oiChg: bullish ? 2000 : 1000,
        volume: 1000
      }
    }))
  };
}

test("aligned bullish data produces BUY CALL without waiting for history", () => {
  const result = new OptionSignalEngine().analyze(marketState("bullish"));
  assert.equal(result.totalScore, 50);
  assert.equal(result.factors.directionalBuildUp, 36);
  assert.equal(result.signal.label, "BUY CALL");
  assert.equal(result.trend.hasEnoughHistory, false);
});

test("aligned bearish data produces BUY PUT without waiting for history", () => {
  const result = new OptionSignalEngine().analyze(marketState("bearish"));
  assert.equal(result.totalScore, -50);
  assert.equal(result.factors.directionalBuildUp, -36);
  assert.equal(result.signal.label, "BUY PUT");
  assert.equal(result.trend.hasEnoughHistory, false);
});

test("conflicting data legitimately remains NEUTRAL / WAIT", () => {
  const result = new OptionSignalEngine().analyze(marketState("conflicting"));
  assert.equal(result.totalScore, 0);
  assert.equal(result.signal.label, "NEUTRAL / WAIT");
});

test("signal boundaries remain at +50 and -50", () => {
  const engine = new OptionSignalEngine();
  const trend = { hasEnoughHistory: true };
  for (const [score, expected] of [[49, "neutral"], [50, "call"], [-49, "neutral"], [-50, "put"]]) {
    assert.equal(engine.getSignal(score, trend).key, expected, `score ${score}`);
  }
});


test("missing core fields and stale data block trade alerts", () => {
  for (const patch of [{ strikes: [] }, { dataUpdatedAt: 900000 }, { hasObservedChange: false }, { sessionOpen: false }]) {
    const result = new OptionSignalEngine().analyze({ ...marketState("bullish"), ...patch });
    assert.equal(result.signal.key, "neutral");
    assert.ok(result.blockers.length);
  }
});

test("invalid expiry Greeks and wide spreads cannot become entry candidates", () => {
  for (const patch of [{ iv: 500 }, { iv: 0 }, { delta: 1 }, { delta: -0.5 }, { theta: -1000 }, { bidPrice: 80, askPrice: 120 }]) {
    const state = marketState("bullish");
    state.strikes.forEach(row => Object.assign(row.call, patch));
    const result = new OptionSignalEngine().analyze(state);
    assert.equal(result.signal.key, "neutral", JSON.stringify(patch));
    assert.equal(result.candidate, null);
  }
});

test("OI PCR uses total OI, independent of today's OI changes", () => {
  const state = marketState("bullish");
  state.strikes.forEach(row => { row.call.oi = 40000; row.put.oi = 10000; });
  const result = new OptionSignalEngine().analyze(state);
  assert.equal(result.metrics.pcrOi, 0.25);
  assert.equal(result.metrics.pcrOiChange, 2);
});

test("thirty-second changes contribute fast momentum without mixing expiries", () => {
  const previous = { ...marketState("bullish"), expiry: "2026-09-24" };
  const current = { ...marketState("bullish"), expiry: "2026-09-24", timestamp: previous.timestamp + 31000, spotPrice: 25025 };
  const result = new OptionSignalEngine().analyze(current, [previous]);
  assert.ok(result.factors.fastMomentum > 0);
  const other = new OptionSignalEngine().analyze({ ...current, expiry: "2026-10-01" }, [previous]);
  assert.equal(other.factors.fastMomentum, 0);
});

test("one-minute OI lookback tolerates timer jitter", () => {
  const engine = new OptionSignalEngine();
  const state = marketState("bullish");
  engine.analyze(state);
  assert.ok(engine.getOiLookbackSnapshot({ ...state, timestamp: state.timestamp + 61000 }, 60000));
});
