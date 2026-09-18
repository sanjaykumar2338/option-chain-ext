const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../networkInterceptor.js'), 'utf8');
const payload = { data: [{ strike_price: 25000, call_options: { market_data: { ltp: 100 } }, put_options: { market_data: { ltp: 110 } } }] };
function harness() {
  const events = [], listeners = new Map();
  class XHR { open(method, url) { this.url = url; } addEventListener(name, cb) { this[name] = cb; } }
  class WS { static OPEN = 1; constructor(url) { this.url = url; } addEventListener(name, cb) { this[name] = cb; } }
  const response = { ok: true, clone: () => ({ text: async () => JSON.stringify(payload) }) };
  const promise = Promise.resolve(response);
  const window = { location: { href: 'https://pro.upstox.com/' }, fetch: () => promise, XMLHttpRequest: XHR, WebSocket: WS,
    addEventListener: (name, cb) => listeners.set(name, cb), dispatchEvent: e => events.push(e) };
  const context = vm.createContext({ window, URL, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  vm.runInContext(code, context);
  return { window, events, listeners, promise, response, WS };
}
test('fetch preserves original response and replay retains timestamp without credentials', async () => {
  const app = harness();
  assert.equal(app.window.fetch('https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX&access_token=secret'), app.promise);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.events.length, 1);
  assert.ok(!app.events[0].detail.url.includes('secret'));
  assert.ok(app.events[0].detail.url.includes('instrument_key'));
  app.listeners.get('upstox-option-chain-request-latest')();
  assert.equal(app.events[1].detail.timestamp, app.events[0].detail.timestamp);
});
test('unrelated fetch paths are ignored and XHR captures chain response', async () => {
  const app = harness(); app.window.fetch('/stocks');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(app.events.length, 0);
  const xhr = new app.window.XMLHttpRequest(); xhr.open('GET', '/option-chain/test');
  xhr.status = 200; xhr.responseType = 'json'; xhr.response = payload; xhr.load();
  assert.equal(app.events[0].detail.source, 'xhr');
});
test('WebSocket preserves native prototype/constants and ignores binary data', () => {
  const app = harness(); const ws = new app.window.WebSocket('wss://example.test/feed');
  assert.ok(ws instanceof app.WS); assert.equal(app.window.WebSocket.OPEN, 1);
  ws.message({ data: new Uint8Array([1, 2]) }); assert.equal(app.events.length, 0);
  ws.message({ data: JSON.stringify(payload) }); assert.equal(app.events.length, 1);
});
