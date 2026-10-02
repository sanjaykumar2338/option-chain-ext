const assert = require('node:assert/strict');
const { test } = require('node:test');
require('../OptionSignalEngine.js');

function state(timestamp = Date.parse('2026-09-18T10:00:00+05:30')) {
  const quote = delta => ({ ltp: 100, oi: 10000, volume: 1000, ltpChangePct: 5, oiChg: 1000, delta, iv: 15 });
  return { stockName: 'NIFTY', expiry: '2026-09-24', timestamp, spotPrice: 25000,
    strikes: [24900, 24950, 25000, 25050, 25100].map(strike => ({ strike, call: quote(0.25), put: quote(-0.25) })) };
}
const clone = value => JSON.parse(JSON.stringify(value));
function moved(prior, direction = 1) {
  const current = clone(prior);
  current.timestamp += 60000;
  for (const row of current.strikes) {
    row.call.ltp += direction * 2;
    row.put.ltp -= direction * 2;
    for (const side of ['call', 'put']) { row[side].oi += 100; row[side].volume += 100; }
  }
  return current;
}

test('recent buildup follows interval changes despite contradictory daily changes', () => {
  const engine = new OptionSignalEngine();
  const prior = state();
  for (const direction of [1, -1]) {
    const current = moved(prior, direction);
    current.strikes.forEach(row => {
      row.call.ltpChangePct = -direction * 5;
      row.put.ltpChangePct = direction * 5;
    });
    assert.equal(engine.recentBuildUp(current, prior).score, direction * 36);
  }
});

test('unchanged volume adds no directional evidence; volume resets are rejected', () => {
  const engine = new OptionSignalEngine();
  const prior = state(), current = moved(prior);
  current.strikes.forEach(row => { row.call.volume = 1000; row.put.volume = 1000; });
  assert.equal(engine.recentBuildUp(current, prior).score, 0);
  current.strikes.forEach(row => { row.call.volume = 10; });
  assert.equal(engine.recentBuildUp(current, prior).available, false);
});

test('missing volume does not become a valid zero after normalization', () => {
  const engine = new OptionSignalEngine();
  const prior = state(), current = moved(prior);
  prior.strikes.forEach(row => delete row.call.volume);
  assert.equal(engine.recentBuildUp(engine.normalizeMarketState(current), engine.normalizeMarketState(prior)).available, false);
});

test('research lookback selects nearest minute and isolates expiry, day and future data', () => {
  const engine = new OptionSignalEngine();
  const current = state();
  const good = { ...current, timestamp: current.timestamp - 61000 };
  assert.equal(engine.researchLookback(current, [{ ...current, timestamp: current.timestamp - 45000 }, good]), good);
  for (const prior of [{ ...good, expiry: '2026-10-01' }, { ...good, stockName: 'BANKNIFTY' },
    { ...good, timestamp: current.timestamp + 60000 }, { ...good, timestamp: current.timestamp - 76000 }]) {
    assert.equal(engine.researchLookback(current, [prior]), undefined);
  }
  const midnight = state(Date.parse('2026-09-19T00:00:20+05:30'));
  assert.equal(engine.researchLookback(midnight, [{ ...midnight, timestamp: midnight.timestamp - 60000 }]), undefined);
});

test('25-delta interpolation compares equivalent points without extrapolation', () => {
  const engine = new OptionSignalEngine();
  const market = state();
  market.strikes = [
    { strike: 25050, call: { delta: 0.3, iv: 16 } },
    { strike: 25100, call: { delta: 0.2, iv: 14 } },
    { strike: 24950, put: { delta: -0.3, iv: 18 } },
    { strike: 24900, put: { delta: -0.2, iv: 16 } }
  ];
  const rr = engine.matchedDeltaRiskReversal(market);
  assert.equal(rr.callIv, 15);
  assert.equal(rr.putIv, 17);
  assert.equal(rr.rr25, -2);
  market.strikes.pop();
  assert.equal(engine.matchedDeltaRiskReversal(market).available, false);
});

test('invalid IV and wrong-sign deltas cannot supply a matched wing', () => {
  const engine = new OptionSignalEngine();
  for (const patch of [{ iv: 0 }, { iv: NaN }, { delta: 0.25 }, { delta: -0.5 }]) {
    const market = state();
    market.strikes.forEach(row => Object.assign(row.put, patch));
    assert.equal(engine.matchedDeltaRiskReversal(market).available, false);
  }
});

test('research skew sign and score are invariant to consistent IV unit scaling', () => {
  const engine = new OptionSignalEngine();
  for (const scale of [1, 0.01]) {
    const prior = state(), current = moved(prior);
    prior.strikes.forEach(row => { row.call.iv = 15 * scale; row.put.iv = 15 * scale; });
    current.strikes.forEach(row => { row.call.iv = 15 * scale; row.put.iv = 17 * scale; });
    const result = engine.analyze(current, [prior]);
    assert.equal(result.research.matchedSkew.score, -10);
    assert.equal(result.research.available, true);
    assert.equal(result.research.mode, 'shadow');
    assert.equal(result.research.baselineScore, result.totalScore);
  }
});

test('research cannot manufacture a bias from missing history or invalid market data', () => {
  const engine = new OptionSignalEngine();
  const prior = state(), current = moved(prior);
  assert.equal(engine.analyze(current).research.bias, null);
  current.hasObservedChange = false;
  assert.equal(engine.analyze(current, [prior]).research.available, false);
});

test('comparison recomputes a replacement score without adding duplicate factors', () => {
  const engine = new OptionSignalEngine();
  const prior = state(), current = moved(prior);
  current.strikes.forEach(row => { row.call.iv = 17; });
  const result = engine.analyze(current, [prior]);
  const research = result.research;
  const proposed = { ...result.factors, directionalBuildUp: research.recentBuildUp.score,
    ivSkewChange: research.matchedSkew.score,
    spotConfirmation: engine.scoreSpotConfirmation(research.recentBuildUp.score, result.trend) };
  assert.equal(research.score, engine.clamp(Math.round(Object.values(proposed).reduce((a, b) => a + b, 0)), -100, 100));
  assert.equal(result.totalScore, research.baselineScore);
});
