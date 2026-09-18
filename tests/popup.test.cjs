const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
function harness(snapshot) {
  let now = 100000;
  let tick;
  let changed;
  const elements = new Map();
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerText: '', dataset: {}, addEventListener() {} });
      return elements.get(id);
    } },
    window: { setInterval(callback) { tick = callback; } },
    chrome: { storage: {
      sync: { get(defaults, callback) { callback(defaults); } },
      local: { get(defaults, callback) { callback({ ...defaults, latestSignalSnapshot: snapshot }); } },
      onChanged: { addListener(callback) { changed = callback; } }
    } }
  });
  vm.runInContext(source, context);
  return { text: id => elements.get(id).innerText,
    advance(ms) { now += ms; tick(); },
    update(snapshot) { changed({ latestSignalSnapshot: { newValue: snapshot } }, 'local'); } };
}
const buy = { signalLabel: 'BUY CALL', signalKey: 'call', totalScore: 65, strength: 65, forecastConfidence: 60, updatedAt: 100000, dataUpdatedAt: 100000 };
test('popup expires a saved BUY when content stops updating and recovers on new data', () => {
  const app = harness(buy);
  assert.equal(app.text('scoreSignal'), 'BUY CALL');
  app.advance(31000);
  assert.match(app.text('scoreSignal'), /WAIT.*stale/);
  assert.equal(app.text('currentScore'), '--');
  assert.equal(app.text('currentStrength'), '--');
  app.update({ ...buy, updatedAt: 131000, dataUpdatedAt: 131000 });
  assert.equal(app.text('scoreSignal'), 'BUY CALL');
});
test('recent analysis does not make old market data fresh', () => {
  const app = harness({ ...buy, dataUpdatedAt: 60000 });
  assert.match(app.text('scoreSignal'), /stale/);
});
test('opening without a saved snapshot remains a waiting state', () => {
  const app = harness(null); app.advance(60000);
  assert.equal(app.text('scoreSignal'), '--');
});

test('early BUY with no forecast history says Collecting instead of zero', () => {
  const app = harness({ ...buy, forecastKey: 'warming', forecastLabel: '10-20m Forecast Warming Up', forecastDetail: 'Collecting price history', forecastConfidence: 0 });
  assert.equal(app.text('scoreSignal'), 'BUY CALL');
  assert.equal(app.text('forecastConfidence'), 'Collecting');
  assert.match(app.text('scoreDetail'), /Collecting price history/);
});
test('old warming snapshots are recognized; a ready zero forecast remains zero', () => {
  const app = harness({ ...buy, forecastLabel: '10-20m Forecast Warming Up', forecastConfidence: 0 });
  assert.equal(app.text('forecastConfidence'), 'Collecting');
  app.update({ ...buy, forecastKey: 'sideways', forecastLabel: '10-20m Sideways / Wait', forecastConfidence: 0 });
  assert.equal(app.text('forecastConfidence'), '0/100');
  assert.match(app.text('scoreDetail'), /Sideways/);
});
