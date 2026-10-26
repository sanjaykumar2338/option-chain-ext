const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../header-signal.js'), 'utf8');

function harness() {
  let badge, changed, tick;
  let now = 100000;
  const listeners = new Map();
  const row = { children: [{}, {}], insertBefore(node) { badge = node; node.parentElement = this; },
    getBoundingClientRect: () => ({ height: 44 }) };
  const location = { pathname: '/trading-charts' };
  const context = {
    Date: class extends Date { static now() { return now; } },
    document: {
      addEventListener: (name, fn) => listeners.set(name, fn),
      querySelector: () => ({ children: [row] }),
      getElementById: () => badge,
      createElement() {
        const roles = { action: {}, market: {} };
        return { style: {}, setAttribute() {}, remove() { badge = null; },
          querySelector: selector => roles[selector.includes('action') ? 'action' : 'market'] };
      }
    },
    window: { addEventListener: (name, fn) => listeners.set(name, fn), location, getComputedStyle: () => ({ display: 'flex', flexDirection: 'row' }),
      setInterval(fn) { tick = fn; }, clearInterval() {} },
    chrome: { runtime: { id: 'test' }, storage: {
      local: { get(key, cb) { cb({}); } },
      onChanged: { addListener(fn) { changed = fn; }, removeListener() {} }
    } }
  };
  vm.runInNewContext(source, context);
  return { get badge() { return badge; }, location, tick: () => tick(),
    advance(ms) { now += ms; tick(); },
    resumeAfter(ms) { now += ms; listeners.get("visibilitychange")(); },
    signal(signalKey, overrides = {}) { changed({ latestSignalSnapshot: { newValue: {
      signalKey, signalLabel: `BUY ${signalKey.toUpperCase()}`, stockName: 'NIFTY', expiry: '2026-10-27',
      updatedAt: now, dataUpdatedAt: now, candidate: { strike: 22500 }, ...overrides
    } } }, 'local'); } };
}

test('header follows call/put updates and never presents stale entries as active', () => {
  const h = harness();
  const action = () => h.badge.querySelector('[data-role="action"]').textContent;
  assert.equal(action(), 'WAITING');
  h.signal('call');
  assert.equal(action(), 'BUY CALL · 22500 CE');
  assert.equal(h.badge.style.background, '#15803d');
  assert.match(h.badge.querySelector('[data-role="market"]').textContent, /NIFTY.*2026-10-27/);
  h.signal('put');
  assert.equal(action(), 'BUY PUT · 22500 PE');
  assert.equal(h.badge.style.background, '#b91c1c');
  h.advance(30001);
  assert.equal(action(), 'WAITING');
  h.signal('call', { dataUpdatedAt: 1 });
  assert.equal(action(), 'WAITING');
});

test('header recovers after remount and follows SPA navigation', () => {
  const h = harness();
  h.signal('put');
  h.badge.remove();
  h.tick();
  assert.match(h.badge.querySelector('[data-role="action"]').textContent, /BUY PUT/);
  h.location.pathname = '/option-chain';
  h.tick();
  assert.equal(h.badge, null);
  h.location.pathname = '/trading-charts';
  h.tick();
  assert.ok(h.badge);
});

 test('returning to charts clears stale signals without waiting for a timer', () => {
  const h = harness();
  h.signal('call');
  h.resumeAfter(60000);
  assert.equal(h.badge.querySelector('[data-role="action"]').textContent, 'WAITING');
});
