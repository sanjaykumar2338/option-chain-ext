const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const context = vm.createContext({ OptionSignalEngine: class {}, URL });
vm.runInContext(source.slice(0, source.indexOf('  function getHistoryForMarket')) + '\nObject.assign(globalThis, { parseNumber, parseCellNumber, parsePercentage, normalizeNetworkSide, collectNetworkStrikes, mergeSide, parseOptionRow, normalizeExpiry }); })();', context);

test('Indian units, unicode minus, decimals and missing values remain distinct', () => {
  assert.equal(context.parseNumber('−1.5Cr'), -15000000);
  assert.equal(context.parseNumber('2.5L'), 250000);
  assert.equal(context.parseCellNumber('0.15 +20%', 'OI (lakhs)'), 15000);
  assert.equal(context.parseCellNumber('1K', 'OI (lakhs)'), 1000);
  assert.equal(context.parsePercentage('100 −5%'), -5);
  assert.ok(Number.isNaN(context.parseCellNumber('−5%')));
  assert.ok(Number.isNaN(context.parseNumber('--')));
  assert.equal(context.parseNumber('0'), 0);
});

test('official nested payload includes Greeks, quote depth and derived changes', () => {
  const side = context.normalizeNetworkSide({ instrument_key: 'NSE_FO|123', market_data: { ltp: 120, close_price: 100, oi: 15000, prev_oi: 10000, volume: 900, bid_price: 119, ask_price: 121, bid_qty: 10, ask_qty: 20 }, option_greeks: { delta: .5, theta: -2, gamma: .001, vega: 4, iv: 15 } });
  assert.ok(Math.abs(side.ltpChangePct - 20) < 1e-9);
  assert.equal(side.oiChg, 5000); assert.equal(side.oiChgPct, 50);
  assert.equal(side.theta, -2); assert.equal(side.askQty, 20); assert.equal(side.bidPrice, 119);
  assert.equal(side.instrumentKey, 'NSE_FO|123');
});

test('all strikes survive extraction and mixed expiry identity is retained', () => {
  const rows = context.collectNetworkStrikes({ data: Array.from({ length: 30 }, (_, i) => ({ strike_price: 24000 + i * 50, underlying_key: 'NSE_INDEX|Nifty 50', expiry: i < 15 ? '2026-09-24' : '2026-10-01', call_options: { market_data: { ltp: 100 } }, put_options: { market_data: { ltp: 110 } } })) });
  assert.equal(rows.length, 30);
  assert.equal(rows[29].expiry, '2026-10-01');
  assert.equal(rows[0].underlyingKey, 'NSE_INDEX|Nifty 50');
});

test('header mapping handles reordered columns and refuses mismatched layouts', () => {
  const headers = ['Theta', 'LTP', 'OI (lakhs)', 'Volume', 'Delta'];
  const row = { querySelectorAll: () => ['-2', '100 +5%', '0.15 +20%', '2L', '.5'].map(innerText => ({innerText})), closest: () => ({ querySelectorAll: () => headers.map(innerText => ({innerText})) }) };
  const side = context.parseOptionRow(row, 'call');
  assert.equal(side.theta, -2); assert.equal(side.ltp, 100); assert.equal(side.oi, 15000); assert.equal(side.volume, 200000);
  headers.pop(); assert.ok(Number.isNaN(context.parseOptionRow(row, 'call').ltp));
});

test('supplement never replaces valid zero and expiry date validates', () => {
  const merged = context.mergeSide({ oiChg: 0, theta: NaN }, { oiChg: 100, theta: -2 });
  assert.equal(merged.oiChg, 0); assert.equal(merged.theta, -2);
  assert.equal(context.normalizeExpiry('24 Sep 2026'), '2026-09-24');
  assert.equal(context.normalizeExpiry('31 Feb 2026'), '');
});
