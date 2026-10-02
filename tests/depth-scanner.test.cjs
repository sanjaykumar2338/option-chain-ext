const test = require('node:test');
const assert = require('node:assert/strict');

require('../depthScanner.js');

test('market depth parser accepts a verified matching contract', () => {
  const quote = OptionDepthScanner.parsePanel(
    'Scrip Info\nSENSEX 71100 PE\nBFO 08 OCT 26\nMarket Depth',
    [
      ['20', '221.85', '247.20', '400'],
      ['80', '221.80', '247.90', '160']
    ],
    { stockName: 'SENSEX', strike: 71100, side: 'put', expiry: '2026-10-08' }
  );
  assert.deepEqual(quote, { bidPrice: 221.85, askPrice: 247.2, bidQty: 20, askQty: 400 });
});

test('market depth parser reads the four-column text layout when rows are nested divs', () => {
  const quote = OptionDepthScanner.parsePanel(
    'Scrip Info\nSENSEX 71100 PE\nBFO 08OCT26\nMarket Depth\nQuantity\nBid Price\nAsk Price\nQuantity\n20\n221.85\n247.20\n400\n80\n221.80\n247.90\n160\nTotal buy qty.\n1,840',
    [],
    { stockName: 'SENSEX', strike: 71100, side: 'put', expiry: '2026-10-08' }
  );
  assert.deepEqual(quote, { bidPrice: 221.85, askPrice: 247.2, bidQty: 20, askQty: 400 });
});

test('extracts Upstox two-column depth where CSS reverses the ask display', () => {
  const leaf = text => ({ innerText: text, children: [] });
  const row = (quantity, price) => ({ children: [leaf(''), leaf(quantity), leaf(price)] });
  const bidColumn = { children: [row('20', '221.85'), row('80', '221.80')] };
  const askColumn = { children: [row('400', '247.20'), row('160', '247.90')] };
  const columns = { children: [bidColumn, askColumn] };
  const root = { querySelectorAll: () => [columns] };
  assert.deepEqual(OptionDepthScanner.extractTwoColumnRows(root), [
    ['20', '221.85', '247.20', '400'],
    ['80', '221.80', '247.90', '160']
  ]);
});

test('closed-market zero depth is never accepted as a quote', () => {
  const quote = OptionDepthScanner.parsePanel(
    'Scrip Info\nSENSEX 72500 PE\nBFO 12NOV26\nMarket Depth',
    Array.from({ length: 5 }, () => ['0', '0.00', '0.00', '0']),
    { stockName: 'SENSEX', strike: 72500, side: 'put', expiry: '2026-11-12' }
  );
  assert.equal(quote, null);
});

test('market depth parser rejects a different contract, expiry, or malformed book', () => {
  const target = { stockName: 'SENSEX', strike: 71100, side: 'put', expiry: '2026-10-08' };
  const validRows = [['20', '221.85', '247.20', '400']];
  assert.equal(OptionDepthScanner.parsePanel('Scrip Info\nSENSEX 71200 PE\nBFO 08 OCT 26', validRows, target), null);
  assert.equal(OptionDepthScanner.parsePanel('Scrip Info\nSENSEX 71100 PE\nBFO 15 OCT 26', validRows, target), null);
  assert.equal(OptionDepthScanner.parsePanel('Scrip Info\nSENSEX 71100 PE\nBFO 08 OCT 26', [['20', '250', '240', '400']], target), null);
});

test('scanner orders loaded contracts nearest spot and includes both sides', () => {
  const button = id => ({ id, isConnected: true, getAttribute: () => 'symbolInfoBtnOC' });
  const row = (side, strike) => ({
    getAttribute: () => `${side}TableOCRow${strike}`,
    querySelector: () => button(`${side}-${strike}`)
  });
  const rows = {
    left: [row('left', 71900), row('left', 72000)],
    right: [row('right', 71900), row('right', 72000)]
  };
  const scanner = new OptionDepthScanner({
    document: { querySelectorAll: selector => rows[selector.includes('left') ? 'left' : 'right'] },
    getContext() {}, onQuote() {}, onStatus() {}
  });
  const targets = scanner.targets({ marketKey: 'sensex', expiry: '2026-10-08', stockName: 'SENSEX', spotPrice: 71910 });
  assert.deepEqual(targets.map(item => [item.strike, item.side]), [
    [71900, 'call'], [71900, 'put'], [72000, 'call'], [72000, 'put']
  ]);
});
