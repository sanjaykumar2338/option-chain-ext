const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../OptionSignalEngine.js");

const clone = (value) => JSON.parse(JSON.stringify(value));

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

function liveState(direction = "bullish", timestamp = 1000000, spotPrice = 25000, premium = 100) {
  const state = { ...marketState(direction), sessionOpen: true, expiry: "2026-09-24", timestamp, spotPrice };
  for (const row of state.strikes) for (const side of ["call", "put"]) {
    Object.assign(row[side], { bidPrice: premium - 1, askPrice: premium + 1, quoteUpdatedAt: timestamp });
  }
  return state;
}

test("live directional bias waits for timing history before alerting", () => {
  const result = new OptionSignalEngine().analyze(liveState());
  assert.equal(result.biasSignal.key, "call");
  assert.equal(result.signal.key, "neutral");
  assert.equal(result.entryTiming.key, "warming");
  assert.match(result.signal.label, /BULLISH.*WAIT/);
});

test("entry timing rejects chasing and arms rather than buys a non-extended setup", () => {
  const engine = new OptionSignalEngine();
  const previous = liveState();
  const chased = liveState("bullish", previous.timestamp + 31000, 25050);
  const chasedResult = engine.analyze(chased, [previous]);
  assert.equal(chasedResult.biasSignal.key, "call");
  assert.equal(chasedResult.signal.key, "neutral");
  assert.equal(chasedResult.entryTiming.key, "spot-extended");

  const ready = liveState("bullish", previous.timestamp + 31000, 25005);
  const readyResult = new OptionSignalEngine().analyze(ready, [previous]);
  assert.equal(readyResult.signal.key, "neutral");
  assert.equal(readyResult.entryTiming.key, "confirming");
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

test("invalid Greeks cannot become entry candidates", () => {
  for (const patch of [{ iv: 500 }, { iv: 0 }, { delta: 1 }, { delta: -0.5 }, { theta: -1000 }]) {
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

test("delta-weighted new option flow confirms bullish and bearish pressure", () => {
  const engine = new OptionSignalEngine();
  const previous = marketState("conflicting");
  previous.strikes.forEach((row) => {
    Object.assign(row.call, { ltp: 100, bidPrice: 99, askPrice: 101, delta: 0.5, volume: 1000, oi: 10000 });
    Object.assign(row.put, { ltp: 100, bidPrice: 99, askPrice: 101, delta: -0.5, volume: 1000, oi: 10000 });
  });

  const moved = (direction) => {
    const state = clone(previous);
    state.timestamp += 31000;
    state.strikes.forEach((row) => {
      const callMove = direction === "bullish" ? 5 : -5;
      const putMove = -callMove;
      Object.assign(row.call, { ltp: 100 + callMove, bidPrice: 99 + callMove, askPrice: 101 + callMove, volume: 1200, oi: 10100 });
      Object.assign(row.put, { ltp: 100 + putMove, bidPrice: 99 + putMove, askPrice: 101 + putMove, volume: 1200, oi: 10100 });
    });
    return engine.normalizeMarketState(state);
  };
  const normalizedPrevious = engine.normalizeMarketState(previous);
  assert.equal(engine.scoreDeltaWeightedFlow(moved("bullish"), [normalizedPrevious]), 24);
  assert.equal(engine.scoreDeltaWeightedFlow(moved("bearish"), [normalizedPrevious]), -24);
});

test("PCR adapts to the instrument's rolling baseline", () => {
  const engine = new OptionSignalEngine();
  const baseline = marketState("conflicting");
  baseline.strikes.forEach((row) => { row.call.oi = 10000; row.put.oi = 10000; });
  const history = Array.from({ length: 5 }, (_, index) => engine.normalizeMarketState({
    ...clone(baseline), timestamp: baseline.timestamp - (5 - index) * 10000
  }));
  const current = clone(baseline);
  current.strikes.forEach((row) => {
    row.put.oi = 11500;
    row.put.ltpChangePct = -1;
    row.call.ltpChangePct = 1;
  });
  const score = engine.scorePcrContext(engine.normalizeMarketState(current), { hasEnoughHistory: false }, history);
  assert.equal(score, 14);
});

test("rising comparable put IV skew is bearish", () => {
  const engine = new OptionSignalEngine();
  const previous = marketState("conflicting");
  previous.strikes.forEach((row) => {
    Object.assign(row.call, { delta: 0.25, iv: 15 });
    Object.assign(row.put, { delta: -0.25, iv: 15 });
  });
  const current = clone(previous);
  current.timestamp += 31000;
  current.strikes.forEach((row) => { row.put.iv = 17; });
  assert.equal(engine.scoreIvSkewChange(
    engine.normalizeMarketState(current),
    [engine.normalizeMarketState(previous)]
  ), -10);
});

test("one-minute OI lookback tolerates timer jitter", () => {
  const engine = new OptionSignalEngine();
  const state = marketState("bullish");
  engine.analyze(state);
  assert.ok(engine.getOiLookbackSnapshot({ ...state, timestamp: state.timestamp + 61000 }, 60000));
});

test("each trend horizon requires history near its actual duration", () => {
  const engine = new OptionSignalEngine();
  const current = marketState("bullish");
  const fourMinutesAgo = { ...current, timestamp: current.timestamp - 240000, spotPrice: 24900 };
  for (const minutes of [5, 10, 15]) {
    assert.equal(engine.calculateSpotTrendForLookback(current, [fourMinutesAgo], minutes * 60000).hasEnoughHistory, false);
    const accurate = { ...fourMinutesAgo, timestamp: current.timestamp - minutes * 60000 + 5000 };
    assert.equal(engine.calculateSpotTrendForLookback(current, [accurate], minutes * 60000).hasEnoughHistory, true);
  }
});

test("one-sided zero bid or ask does not block a contract recommendation", () => {
  for (const patch of [{ bidPrice: 0 }, { askPrice: 0 }, { bidPrice: -1 }]) {
    const state = marketState("bullish");
    state.strikes.forEach(row => Object.assign(row.call, patch));
    const result = new OptionSignalEngine().analyze(state);
    assert.equal(result.signal.key, "call");
    assert.ok(result.candidate);
  }
});

function precisionScenario(direction = 'bullish') {
  const engine = new OptionSignalEngine();
  const prior = liveState(direction);
  const sign = direction === 'bullish' ? 1 : -1;
  const history = [prior];
  const tick = (seconds, move, premium = 100, patch = {}) => {
    const state = Object.assign(liveState(direction, prior.timestamp + seconds * 1000, 25000 + sign * move, premium), patch);
    return engine.analyze(state, history);
  };
  return { engine, tick, prior };
}

for (const direction of ['bullish', 'bearish']) {
  test(`${direction} needs elapsed confirmation, a spot trigger and a stronger option premium`, () => {
    const { tick } = precisionScenario(direction);
    assert.equal(tick(31, 5).entryTiming.key, 'confirming');
    assert.equal(tick(32, 6, 101).entryTiming.key, 'confirming');
    assert.equal(tick(33, 9, 102).entryTiming.key, 'confirming');
    // Polling the same prices later must not finish confirmation.
    assert.equal(tick(41, 9, 102).entryTiming.key, 'confirming');
    const result = tick(42, 10, 103);
    assert.equal(result.signal.key, direction === 'bullish' ? 'call' : 'put');
    assert.equal(result.entryTiming.setup.triggerType, 'breakout');
    assert.equal(result.entryTiming.setup.expiresAt, 1057000);
    assert.equal(tick(57, 11, 104).entryTiming.key, 'expired');
    assert.equal(tick(58, 12, 105).signal.key, 'neutral');
  });
}

test('a breakout without premium confirmation waits', () => {
  const { tick } = precisionScenario();
  tick(31, 5); tick(36, 6);
  const result = tick(41, 10);
  assert.equal(result.signal.key, 'neutral');
  assert.equal(result.entryTiming.key, 'premium-unconfirmed');
});

test('spot remaining inside the setup range does not produce an entry', () => {
  const { tick } = precisionScenario();
  tick(31, 5); tick(36, 6, 101);
  assert.equal(tick(41, 7, 102).entryTiming.key, 'armed');
});

test('pullback recovery can trigger below the original breakout level', () => {
  const { tick } = precisionScenario();
  tick(31, 10); tick(36, 6, 101);
  const result = tick(41, 10, 102);
  assert.equal(result.signal.key, 'call');
  assert.equal(result.entryTiming.setup.triggerType, 'pullback recovery');
});

test('invalidation cancels the setup and prevents immediate re-entry', () => {
  const engine = new OptionSignalEngine();
  const state = liveState();
  const history = [liveState('bullish', state.timestamp - 31000)];
  const candidate = engine.selectCandidate(state, 'call');
  const timing = { eligible: true, metrics: {} };
  engine.assessPrecisionEntry(state, history, 'call', candidate, timing, []);
  const invalid = { ...state, timestamp: state.timestamp + 10000, spotPrice: 24997 };
  assert.equal(engine.assessPrecisionEntry(invalid, history, 'call', candidate, timing, []).key, 'invalidated');
  assert.equal(engine.assessPrecisionEntry({ ...state, timestamp: state.timestamp + 11000 }, history, 'call', candidate, timing, []).key, 'invalidated');
});

test('loss of premium confirmation cancels a ready entry', () => {
  const { tick } = precisionScenario();
  tick(31, 5); tick(36, 6, 101); tick(41, 10, 102);
  assert.equal(tick(42, 11, 100).entryTiming.key, 'invalidated');
});

test('bid/ask availability and spread do not block an ITM candidate', () => {
  for (const patch of [
    { bidPrice: undefined }, { askPrice: undefined }, { bidPrice: 96, askPrice: 104 },
    { quoteUpdatedAt: undefined }, { quoteUpdatedAt: 989999 }, { quoteUpdatedAt: 1000001 }
  ]) {
    const state = liveState();
    state.strikes.forEach(row => Object.assign(row.call, patch));
    const result = new OptionSignalEngine().analyze(state);
    assert.equal(result.signal.key, 'neutral');
    assert.ok(result.candidate);
    assert.doesNotMatch(result.signal.detail, /bid\/ask|spread/i);
  }
});

test('wide spread remains informational and does not change candidate eligibility', () => {
  const state = liveState();
  state.strikes.forEach(row => Object.assign(row.call, { bidPrice: 98, askPrice: 102 }));
  const candidate = new OptionSignalEngine().selectCandidate(state, 'call');
  assert.ok(candidate);
  assert.ok(candidate.spreadPct > 3);
});

test('candidate selection uses only the first three ITM strikes', () => {
  const engine = new OptionSignalEngine();
  const state = marketState('bullish');
  assert.deepEqual(engine.getItmStrikes(state, 'call'), [24950, 24900, 24850]);
  assert.deepEqual(engine.getItmStrikes(state, 'put'), [25050, 25100, 25150]);
  assert.equal(engine.selectCandidate(state, 'call').strike, 24950);
  assert.equal(engine.selectCandidate(state, 'put').strike, 25050);
  state.strikes.find(row => row.strike === 24800).call.volume = 999999999;
  assert.notEqual(engine.selectCandidate(state, 'call').strike, 24800);
});

test('switching expiry cannot reuse a pending setup', () => {
  const { tick } = precisionScenario();
  tick(31, 5); tick(36, 6, 101);
  assert.equal(tick(41, 10, 102, { expiry: '2026-10-01' }).entryTiming.key, 'warming');
  const result = tick(42, 11, 103);
  assert.equal(result.entryTiming.key, 'confirming');
  assert.equal(result.entryTiming.setup.updates, 1);
});

test('a pending setup expires without a trigger', () => {
  const engine = new OptionSignalEngine();
  const state = liveState();
  const history = [liveState('bullish', state.timestamp - 31000)];
  const candidate = engine.selectCandidate(state, 'call');
  const timing = { eligible: true, metrics: {} };
  engine.assessPrecisionEntry(state, history, 'call', candidate, timing, []);
  const result = engine.assessPrecisionEntry({ ...state, timestamp: state.timestamp + 90000 }, history, 'call', candidate, timing, []);
  assert.equal(result.key, 'expired');
});
