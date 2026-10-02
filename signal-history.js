(function initializeSignalHistory() {
  "use strict";

  const STORAGE_KEY = "signalHistory";
  const dateRows = document.getElementById("dateRows");
  const pageInfo = document.getElementById("pageInfo");
  const previousPage = document.getElementById("previousPage");
  const nextPage = document.getElementById("nextPage");
  const expandedDates = new Set();
  let page = 1;
  const pageSize = document.getElementById("pageSize");
  const emptyState = document.getElementById("emptyState");
  const summary = document.getElementById("summary");
  const instrumentFilter = document.getElementById("instrumentFilter");
  const signalFilter = document.getElementById("signalFilter");
  const downloadJson = document.getElementById("downloadJson");
  const clearHistory = document.getElementById("clearHistory");
  let records = [];

  function formatNumber(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : "--";
  }

  function visibleRecords() {
    const instrument = instrumentFilter.value.trim().toLowerCase();
    const signal = signalFilter.value;
    return records.filter((record) => {
      const name = `${record.stockName || ""} ${record.indexName || ""}`.toLowerCase();
      return (!instrument || name.includes(instrument)) && (!signal || record.signalKey === signal);
    }).sort((a, b) => (b.signalTime || 0) - (a.signalTime || 0));
  }

  function cell(text) {
    const td = document.createElement("td");
    td.textContent = text;
    return td;
  }

  function dateKey(timestamp) {
    if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return 'unknown';
    return new Date(timestamp + 19800000).toISOString().slice(0, 10);
  }

  function appendDate(key, matching) {
    const row = document.createElement('tr');
    row.className = 'date-summary';
    const dateLabel = key === 'unknown' ? 'Unknown date' : `${new Date(`${key}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' })}, ${key}`;
    row.append(cell(dateLabel), cell(String(matching.length)),
      cell(String(matching.filter(record => record.signalKey === 'call').length)),
      cell(String(matching.filter(record => record.signalKey === 'put').length)),
      cell([...new Set(matching.map(record => record.stockName || record.indexName || '--'))].join(', ')),
      cell(key === 'unknown' ? '--' : new Date(matching[0].signalTime).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })));
    const action = document.createElement('td');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'view-signals';
    toggle.setAttribute('aria-controls', `signals-${key}`);
    toggle.setAttribute('aria-label', `View or hide signals for ${dateLabel}`);
    action.append(toggle);
    row.append(action);
    const details = document.createElement('tr');
    details.id = `signals-${key}`;
    details.className = 'date-details';
    const content = document.createElement('td');
    content.colSpan = 7;
    const table = document.createElement('table');
    table.className = 'detail-table';
    table.setAttribute('aria-label', `Signals for ${dateLabel}`);
    table.innerHTML = '<thead><tr><th scope="col">Time (IST)</th><th scope="col">Instrument</th><th scope="col">Expiry</th><th scope="col">Signal</th><th scope="col">Score</th><th scope="col">Spot</th><th scope="col">Contract</th><th scope="col">Price</th></tr></thead>';
    const rows = document.createElement('tbody');
    renderRows(rows, matching);
    table.append(rows);
    content.append(table);
    details.append(content);
    const updateToggle = () => {
      const expanded = expandedDates.has(key);
      details.hidden = !expanded;
      toggle.textContent = expanded ? 'Hide Signals' : 'View Signals';
      toggle.setAttribute('aria-expanded', String(expanded));
    };
    toggle.addEventListener('click', () => {
      if (expandedDates.has(key)) expandedDates.delete(key);
      else expandedDates.add(key);
      updateToggle();
    });
    updateToggle();
    dateRows.append(row, details);
  }

  function renderRows(rows, visible) {
    rows.replaceChildren();
    for (const record of visible) {
      const tr = document.createElement("tr");
      tr.append(cell(Number.isFinite(record.signalTime) ? new Date(record.signalTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--"));
      tr.append(cell(record.stockName || record.indexName || "--"));
      tr.append(cell(record.expiry || "--"));
      const signalCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `signal ${record.signalKey || ""}`;
      badge.textContent = record.signalLabel || "--";
      signalCell.append(badge);
      tr.append(signalCell);
      tr.append(cell(Number.isFinite(record.score) ? String(record.score) : "--"));
      tr.append(cell(formatNumber(record.spotPrice)));
      tr.append(cell(record.candidate?.strike ? `${record.candidate.strike} ${record.candidate.side === "call" ? "CE" : "PE"}` : "--"));
      tr.append(cell(formatNumber(record.candidate?.ltp)));
      rows.append(tr);
    }
  }

  function render() {
    const visible = visibleRecords();
    const size = Number(pageSize.value) || 10;
    const dates = new Map();
    for (const record of visible) {
      const key = dateKey(record.signalTime);
      if (!dates.has(key)) dates.set(key, []);
      dates.get(key).push(record);
    }
    const ordered = [...dates].sort(([a], [b]) => a === b ? 0 : a === 'unknown' ? 1 : b === 'unknown' ? -1 : b.localeCompare(a));
    const pages = Math.max(1, Math.ceil(ordered.length / size));
    page = Math.max(1, Math.min(page, pages));
    const start = (page - 1) * size;
    dateRows.replaceChildren();
    for (const [key, matching] of ordered.slice(start, start + size)) appendDate(key, matching);
    pageInfo.textContent = `Page ${page} of ${pages} · ${ordered.length ? start + 1 : 0}–${Math.min(start + size, ordered.length)} of ${ordered.length} dates`;
    previousPage.disabled = page === 1;
    nextPage.disabled = page === pages;
    summary.textContent = `${records.length} signals stored locally; ${visible.length} match your filters across ${ordered.length} dates. Newest first.`;
    emptyState.hidden = visible.length !== 0;
    downloadJson.disabled = records.length === 0;
    clearHistory.disabled = records.length === 0;
  }

  function resetPages() {
    page = 1;
    render();
  }

  function load() {
    chrome.storage.local.get({ [STORAGE_KEY]: [] }, (data) => {
      records = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
      render();
    });
  }

  previousPage.addEventListener('click', () => { page--; render(); });
  nextPage.addEventListener('click', () => { page++; render(); });
  instrumentFilter.addEventListener("input", resetPages);
  signalFilter.addEventListener("change", resetPages);
  pageSize.addEventListener("change", resetPages);
  clearHistory.addEventListener("click", () => {
    if (!confirm("Delete all locally stored signal history?")) return;
    chrome.storage.local.set({ [STORAGE_KEY]: [] });
  });
  downloadJson.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `option-signals-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STORAGE_KEY]) {
      records = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
      render();
    }
  });
  load();
})();
