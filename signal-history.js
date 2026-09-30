(function initializeSignalHistory() {
  "use strict";

  const STORAGE_KEY = "signalHistory";
  const rows = document.getElementById("historyRows");
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

  function render() {
    const visible = visibleRecords();
    rows.replaceChildren();
    for (const record of visible) {
      const tr = document.createElement("tr");
      tr.append(cell(Number.isFinite(record.signalTime) ? new Date(record.signalTime).toLocaleString("en-IN") : "--"));
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
    summary.textContent = `${records.length} signal${records.length === 1 ? "" : "s"} stored locally; ${visible.length} shown.`;
    emptyState.hidden = visible.length !== 0;
    downloadJson.disabled = records.length === 0;
  }

  function load() {
    chrome.storage.local.get({ [STORAGE_KEY]: [] }, (data) => {
      records = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
      render();
    });
  }

  instrumentFilter.addEventListener("input", render);
  signalFilter.addEventListener("change", render);
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
      records = changes[STORAGE_KEY].newValue || [];
      render();
    }
  });
  load();
})();
