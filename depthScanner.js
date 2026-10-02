(function exposeDepthScanner(global) {
  'use strict';
  class OptionDepthScanner {
    constructor({ document, getContext, onQuote, onStatus, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
      Object.assign(this, { document, getContext, onQuote, onStatus, setTimer, clearTimer, now });
      this.running = false;
      this.timer = null;
      this.cache = new Map();
    }
    static parsePanel(text, rows, target) {
      const clean = value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const title = `${target.stockName} ${target.strike} ${target.side === 'call' ? 'CE' : 'PE'}`;
      const lines = text.split(/\n/).map(line => line.trim()).filter(Boolean);
      if (!lines.some(line => clean(line) === clean(title))) return null;
      const expiry = text.match(/\b(?:BFO|NFO|NSE_FO|BSE_FO)\s*(\d{2})\s*([A-Za-z]{3})\s*(\d{2}|\d{4})\b/i);
      if (!expiry) return null;
      const month = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(expiry[2].toUpperCase()) + 1;
      const date = `${expiry[3].length === 2 ? '20' : ''}${expiry[3]}-${String(month).padStart(2, '0')}-${expiry[1]}`;
      if (!month || date !== target.expiry) return null;
      const suppliedRows = Array.isArray(rows) ? rows : [];
      const headerMatch = text.match(/Quantity\s+Bid Price\s+Ask Price\s+Quantity([\s\S]*?)(?:Total buy qty|Estimated P&L|$)/i);
      const textNumbers = headerMatch
        ? (headerMatch[1].match(/\b\d[\d,]*(?:\.\d+)?\b/g) || [])
        : [];
      const textRows = [];
      for (let index = 0; index + 3 < textNumbers.length && textRows.length < 5; index += 4) {
        textRows.push(textNumbers.slice(index, index + 4));
      }
      const levels = [...suppliedRows, ...textRows].map(cells => cells.map(cell => {
        const value = String(cell).replace(/,/g, '').trim();
        return /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      })).filter(values => values.length === 4 && values.every(Number.isFinite));
      if (!levels.length) return null;
      // Supported layout: bid quantity | bid price | ask price | ask quantity.
      const [bidQty, bidPrice, askPrice, askQty] = levels[0];
      if (!Number.isInteger(bidQty) || !Number.isInteger(askQty) || bidQty <= 0 || askQty <= 0
        || bidPrice <= 0 || askPrice < bidPrice) return null;
      if (levels.some((level, i) => i && (level[1] > levels[i - 1][1] || level[2] < levels[i - 1][2]))) return null;
      return { bidPrice, askPrice, bidQty, askQty };
    }
    static extractTwoColumnRows(root) {
      const number = value => {
        const normalized = String(value ?? '').replace(/,/g, '').trim();
        return /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : null;
      };
      const directNumbers = row => Array.from(row.children || [])
        .map(child => number(child.innerText)).filter(value => value !== null);
      const columns = Array.from(root?.querySelectorAll?.('div') || []).find(node => {
        const children = Array.from(node.children || []);
        return children.length === 2 && children.every(column => {
          const rows = Array.from(column.children || []);
          return rows.length >= 1 && rows.length <= 30 && rows.every(row => directNumbers(row).length === 2);
        });
      });
      if (!columns) return [];
      const [bidColumn, askColumn] = Array.from(columns.children);
      const bids = Array.from(bidColumn.children).map(directNumbers);
      const asks = Array.from(askColumn.children).map(directNumbers);
      // Both Upstox columns use quantity then price in DOM order. CSS reverses
      // the ask column visually to show Ask Price then Quantity.
      return bids.slice(0, Math.min(bids.length, asks.length)).map((bid, index) => [
        bid[0], bid[1], asks[index][1], asks[index][0]
      ]);
    }
    readPanel(target) {
      const labels = Array.from(this.document.querySelectorAll('div,span,h2,h3,h4'))
        .filter(node => node.innerText?.trim() === 'Market Depth');
      for (const label of labels) {
        let depth = label.parentElement;
        // Locate the smallest depth block containing the documented header order.
        while (depth && depth !== this.document.body && !/Quantity\s+Bid Price\s+Ask Price\s+Quantity/i.test(depth.innerText || '')) depth = depth.parentElement;
        if (!depth || depth === this.document.body) continue;
        let panel = depth;
        while (panel && panel !== this.document.body && !/Scrip Info/i.test(panel.innerText || '')) panel = panel.parentElement;
        if (!panel || panel === this.document.body || panel.innerText.length > 15000) continue;
        let rows = OptionDepthScanner.extractTwoColumnRows(depth);
        const conventionalRows = Array.from(depth.querySelectorAll('tr,[role="row"],div')).map(row => Array.from(row.children || [])
          .map(child => child.innerText?.trim() || '')).filter(cells => cells.length === 4 && cells.every(cell => /^[\d,.]+$/.test(cell)));
        rows = rows.concat(conventionalRows);
        const quote = OptionDepthScanner.parsePanel(panel.innerText, rows, target);
        if (quote) return quote;
      }
      return null;
    }
    targets(context) {
      return ['left', 'right'].flatMap(side => Array.from(this.document.querySelectorAll(`tr[data-id^="${side}TableOCRow"]`)).flatMap(row => {
        const strike = Number((row.getAttribute('data-id') || '').slice(`${side}TableOCRow`.length));
        const button = row.querySelector('[data-id="symbolInfoBtnOC"]');
        return strike > 0 && button ? [{ ...context, strike, side: side === 'left' ? 'call' : 'put', instrumentKey: button.id, button }] : [];
      })).sort((a, b) => Math.abs(a.strike - context.spotPrice) - Math.abs(b.strike - context.spotPrice) || a.strike - b.strike || a.side.localeCompare(b.side));
    }
    stop(reason = 'Depth scan stopped') {
      this.running = false;
      this.clearTimer(this.timer);
      this.onStatus(reason, false);
    }
    start() {
      if (this.running) return;
      const context = this.getContext();
      if (!context?.expiry || !context.marketKey || !(context.spotPrice > 0)) return this.stop('Select a chain and expiry before scanning');
      this.queue = this.targets(context);
      if (!this.queue.length) return this.stop('No loaded Symbol Info buttons found');
      this.marketKey = context.marketKey;
      this.running = true;
      this.index = 0;
      this.captured = 0;
      this.skipped = 0;
      this.skipReasons = [];
      this.next();
    }
    validContext() {
      return this.running && !this.document.hidden && this.getContext()?.marketKey === this.marketKey;
    }
    next() {
      if (!this.validContext()) return this.stop('Depth scan stopped: tab hidden or chain changed');
      if (this.index >= this.queue.length) {
        const suffix = this.skipped ? `; skipped ${this.skipped} without usable market depth` : '';
        return this.stop(`Depth scan complete: captured ${this.captured}/${this.queue.length}${suffix}. Quotes expire after 10 seconds.`);
      }
      const target = this.queue[this.index++];
      if (!target.button.isConnected || target.button.getAttribute('data-id') !== 'symbolInfoBtnOC'
        || target.button.id !== target.instrumentKey) return this.stop('Chain rows changed; restart depth scan');
      const before = this.readPanel(this.lastTarget || target);
      const baseline = before ? JSON.stringify(before) : null;
      const startedAt = this.now();
      let stable = null, stableAt = 0;
      this.onStatus(`Scanning ${this.index}/${this.queue.length}: ${target.strike} ${target.side === 'call' ? 'CE' : 'PE'}`, true);
      const switched = this.lastTarget && (this.lastTarget.instrumentKey !== target.instrumentKey);
      this.lastTarget = target;
      target.button.click();
      const poll = () => {
        if (!this.validContext()) return this.stop('Depth scan stopped: tab hidden or chain changed');
        const now = this.now();
        const quote = this.readPanel(target);
        const fingerprint = quote ? JSON.stringify(quote) : null;
        if (fingerprint && !(switched && fingerprint === baseline) && now - startedAt >= 1000) {
          if (stable !== fingerprint) { stable = fingerprint; stableAt = now; }
          else if (now - stableAt >= 500) {
            const key = `${target.marketKey}|${target.strike}|${target.side}`;
            const cached = this.cache.get(key);
            // Reopening or polling identical prices must not keep an old quote fresh.
            const quoteUpdatedAt = cached?.fingerprint === fingerprint ? cached.quoteUpdatedAt
              : baseline === fingerprint ? startedAt : stableAt;
            this.cache.set(key, { fingerprint, quoteUpdatedAt });
            this.onQuote(target, { ...quote, quoteUpdatedAt, quoteSource: 'symbol-info', instrumentKey: target.instrumentKey });
            this.captured++;
            this.timer = this.setTimer(() => this.next(), 500);
            return;
          }
        } else stable = null;
        if (now - startedAt >= 5000) {
          this.skipped++;
          this.skipReasons.push({
            strike: target.strike,
            side: target.side,
            instrumentKey: target.instrumentKey,
            reason: 'Panel identity/expiry did not match, or market depth was empty, zero, or unavailable'
          });
          console.warn('[Upstox depth scan] Skipping unreadable contract', this.skipReasons.at(-1));
          this.timer = this.setTimer(() => this.next(), 500);
        } else this.timer = this.setTimer(poll, 250);
      };
      this.timer = this.setTimer(poll, 250);
    }
  }
  global.OptionDepthScanner = OptionDepthScanner;
  if (typeof globalThis !== "undefined") globalThis.OptionDepthScanner = OptionDepthScanner;
})(typeof window !== 'undefined' ? window : globalThis);
