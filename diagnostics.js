(function initializeDiagnostics() {
  "use strict";
  const LOG_KEY = "signalEvaluationLog";
  const LATEST_KEY = "latestSignalSnapshot";
  const summary = document.getElementById("summary");
  const currentMeta = document.getElementById("currentMeta");
  const currentSignal = document.getElementById("currentSignal");
  const healthGrid = document.getElementById("healthGrid");
  const factorGrid = document.getElementById("factorGrid");
  const currentIssues = document.getElementById("currentIssues");
  const evaluationRows = document.getElementById("evaluationRows");
  const emptyState = document.getElementById("emptyState");
  const instrumentFilter = document.getElementById("instrumentFilter");
  const signalFilter = document.getElementById("signalFilter");
  let records = [];

  const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "--";
  const addCard = (parent, label, value, className = "") => {
    const card = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = value;
    strong.className = className;
    const small = document.createElement("small");
    small.textContent = label;
    card.append(strong, small);
    parent.append(card);
  };

  function renderLatest(snapshot) {
    healthGrid.replaceChildren();
    factorGrid.replaceChildren();
    if (!snapshot) return;
    currentSignal.textContent = snapshot.signalLabel || "--";
    currentSignal.className = `badge ${snapshot.signalKey || "neutral"}`;
    currentMeta.textContent = `${snapshot.stockName || "Option Chain"} · ${snapshot.expiry || "expiry unavailable"} · ${new Date(snapshot.updatedAt).toLocaleString("en-IN")}`;
    const research = snapshot.research;
    if (research) {
      addCard(healthGrid, "Experimental bias (no alerts)", research.available ? `${research.bias} · ${research.score}` : "Collecting / unavailable");
      addCard(healthGrid, "Recent buildup (experimental)", number(research.recentBuildUp?.score, 0));
      addCard(healthGrid, "25-delta skew change score (experimental)", number(research.matchedSkew?.score, 0));
    }
    addCard(healthGrid, "Score", String(snapshot.totalScore ?? "--"));
    addCard(healthGrid, "Directional bias", snapshot.biasSignalLabel || "--");
    addCard(healthGrid, "Entry timing", snapshot.entryTiming?.key || "--");
    const setup = snapshot.entryTiming?.setup;
    if (setup) {
      addCard(healthGrid, "Spot trigger", number(setup.entryLevel ?? setup.triggerSpot));
      addCard(healthGrid, "Spot invalidation", number(setup.invalidationSpot));
      addCard(healthGrid, "Fresh price updates", String(setup.updates));
      addCard(healthGrid, "Setup / entry expires", new Date(setup.expiresAt).toLocaleTimeString("en-IN"));
    }
    addCard(healthGrid, "Candidate spread", Number.isFinite(snapshot.candidate?.spreadPct) ? `${number(snapshot.candidate.spreadPct)}%` : "--");
    addCard(healthGrid, "Data quality", `${snapshot.dataQuality?.score ?? 0}/100`);
    addCard(healthGrid, "Loaded / valid rows", `${snapshot.dataQuality?.loadedRows ?? 0} / ${snapshot.dataQuality?.validRows ?? 0}`);
    addCard(healthGrid, "OI PCR", number(snapshot.metrics?.pcrOi));
    addCard(healthGrid, "Data age", Number.isFinite(snapshot.dataUpdatedAt) ? `${Math.max(0, Math.round((Date.now() - snapshot.dataUpdatedAt) / 1000))}s` : "--");
    for (const [name, value] of Object.entries(snapshot.factors || {})) {
      addCard(factorGrid, name.replace(/([A-Z])/g, " $1"), `${value > 0 ? "+" : ""}${number(value, 0)}`, value > 0 ? "positive" : value < 0 ? "negative" : "");
    }
    currentIssues.textContent = [research?.reason ? `Experimental: ${research.reason}` : "", snapshot.entryTiming?.eligible === false ? snapshot.entryTiming.detail : "", ...(snapshot.blockers || []), ...(snapshot.dataQuality?.warnings || [])].filter(Boolean).join(" · ") || "No current blockers.";
  }

  function outcomeCell(record, minutes) {
    const outcome = record.outcomes?.[String(minutes)];
    const td = document.createElement("td");
    td.textContent = outcome ? `${outcome.result}${Number.isFinite(outcome.spotMovePct) ? ` ${outcome.spotMovePct > 0 ? "+" : ""}${outcome.spotMovePct.toFixed(2)}%` : ""}` : "pending";
    if (outcome?.comparisonReady) td.title = `Directional comparison only: existing ${outcome.baselineBiasResult}; experimental ${outcome.researchBiasResult}`;
    if (outcome?.result) td.className = `result-${outcome.result}`;
    return td;
  }

  function renderLog() {
    const term = instrumentFilter.value.trim().toLowerCase();
    const signal = signalFilter.value;
    const visible = records.filter((record) => {
      const name = `${record.stockName || ""} ${record.indexName || ""}`.toLowerCase();
      return (!term || name.includes(term)) && (!signal || record.signalKey === signal);
    }).sort((a, b) => b.time - a.time);
    evaluationRows.replaceChildren();
    for (const record of visible.slice(0, 1000)) {
      const tr = document.createElement("tr");
      const values = [
        new Date(record.time).toLocaleString("en-IN"), record.stockName || record.indexName || "--",
        record.signalLabel || "--", String(record.score ?? "--"),
        record.research?.available ? `${record.research.bias} / ${record.research.score}` : "--",
        `${record.dataQuality?.loadedRows ?? 0}/${record.dataQuality?.validRows ?? 0}`,
        Number.isFinite(record.dataUpdatedAt) ? `${Math.max(0, Math.round((record.time - record.dataUpdatedAt) / 1000))}s` : "--"
      ];
      values.forEach((value) => { const td = document.createElement("td"); td.textContent = value; tr.append(td); });
      [5, 10, 15, 20].forEach((minutes) => tr.append(outcomeCell(record, minutes)));
      evaluationRows.append(tr);
    }
    summary.textContent = `${records.length} evaluations stored locally; ${visible.length} match the filters.`;
    emptyState.hidden = visible.length !== 0;
  }

  function load() {
    chrome.storage.local.get({ [LOG_KEY]: [], [LATEST_KEY]: null }, (data) => {
      records = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
      renderLatest(data[LATEST_KEY]);
      renderLog();
    });
  }
  instrumentFilter.addEventListener("input", renderLog);
  signalFilter.addEventListener("change", renderLog);
  document.getElementById("clearLog").addEventListener("click", () => {
    if (confirm("Delete all stored evaluation samples?")) chrome.storage.local.set({ [LOG_KEY]: [] });
  });
  document.getElementById("downloadJson").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `signal-evaluations-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[LOG_KEY]) { records = changes[LOG_KEY].newValue || []; renderLog(); }
    if (changes[LATEST_KEY]) renderLatest(changes[LATEST_KEY].newValue);
  });
  load();
})();
