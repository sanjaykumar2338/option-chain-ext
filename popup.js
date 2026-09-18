(function initializePopup() {
  "use strict";

  const NOTIFICATIONS_ENABLED_KEY = "notificationsEnabled";
  const BACKTEST_STORAGE_KEY = "signalBacktests";
  const LATEST_SIGNAL_STORAGE_KEY = "latestSignalSnapshot";
  const toggle = document.getElementById("notificationsToggle");
  const status = document.getElementById("status");
  const testNotification = document.getElementById("testNotification");
  const notificationTestStatus = document.getElementById("notificationTestStatus");
  const scoreStock = document.getElementById("scoreStock");
  const scoreSignal = document.getElementById("scoreSignal");
  const currentStrength = document.getElementById("currentStrength");
  const currentScore = document.getElementById("currentScore");
  const forecastConfidence = document.getElementById("forecastConfidence");
  const scoreDetail = document.getElementById("scoreDetail");
  const hitRate = document.getElementById("hitRate");
  const closedSignals = document.getElementById("closedSignals");
  const pendingSignals = document.getElementById("pendingSignals");
  const latestSignal = document.getElementById("latestSignal");
  const clearBacktest = document.getElementById("clearBacktest");

  function setStatus(enabled) {
    status.innerText = enabled ? "Chrome notifications are on." : "Chrome notifications are off.";
  }

  chrome.storage.sync.get({ [NOTIFICATIONS_ENABLED_KEY]: true }, (settings) => {
    const enabled = Boolean(settings[NOTIFICATIONS_ENABLED_KEY]);
    toggle.checked = enabled;
    setStatus(enabled);
  });

  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    chrome.storage.sync.set({ [NOTIFICATIONS_ENABLED_KEY]: enabled }, () => {
      setStatus(enabled);
    });
  });

  testNotification.addEventListener("click", () => {
    testNotification.disabled = true;
    notificationTestStatus.innerText = "Testing desktop notifications...";
    notificationTestStatus.dataset.state = "pending";

    const finishTest = (message, state) => {
      testNotification.disabled = false;
      notificationTestStatus.innerText = message;
      notificationTestStatus.dataset.state = state;
    };

    try {
      chrome.runtime.sendMessage({ type: "UPSTOX_OPTION_SIGNAL_TEST" }, (result) => {
        const error = chrome.runtime.lastError;
        if (error) {
          finishTest(`Could not test notifications: ${error.message}`, "error");
          return;
        }
        if (!result?.ok) {
          finishTest(result?.error || "The notification service did not respond. Reload the extension and try again.", "error");
          return;
        }
        finishTest("Chrome accepted the test notification. If it did not appear, check your system notification settings.", "success");
      });
    } catch (error) {
      finishTest(`Could not test notifications: ${error.message}`, "error");
    }
  });

  function formatRate(hits, misses) {
    const totalDirectional = hits + misses;
    if (!totalDirectional) return "--";
    return `${Math.round((hits / totalDirectional) * 100)}%`;
  }

  function formatTime(timestamp) {
    if (!Number.isFinite(timestamp)) return "--";
    return new Date(timestamp).toLocaleTimeString("en-IN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatSignedPercent(value) {
    if (!Number.isFinite(value)) return "0.00%";
    return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  }

  let latestSnapshot = null;

  function renderLatestSignal(snapshot) {
    latestSnapshot = snapshot;
    if (!snapshot) {
      scoreStock.innerText = "Open an option-chain page";
      scoreSignal.innerText = "--";
      currentStrength.innerText = "--";
      currentScore.innerText = "--";
      forecastConfidence.innerText = "--";
      scoreDetail.innerText = "Waiting for latest signal data.";
      return;
    }

    scoreStock.innerText = `${snapshot.stockName || "Option Chain"} | ${snapshot.indexName || "--"}`;
    const stale = !Number.isFinite(snapshot.updatedAt) || Date.now() - snapshot.updatedAt > 30000
      || (Number.isFinite(snapshot.dataUpdatedAt) && Date.now() - snapshot.dataUpdatedAt > 30000);
    scoreSignal.innerText = stale ? "WAIT — stale data" : snapshot.signalLabel || "--";
    scoreSignal.dataset.signal = stale ? "neutral" : snapshot.signalKey || "neutral";
    if (stale) {
      currentStrength.innerText = "--";
      currentScore.innerText = "--";
      forecastConfidence.innerText = "--";
      scoreDetail.innerText = `No recent data. Open or refresh the option-chain page. Last checked ${formatTime(snapshot.updatedAt)}.`;
      return;
    }
    currentStrength.innerText = Number.isFinite(snapshot.strength)
      ? `${snapshot.strength}/100`
      : "--";
    currentScore.innerText = Number.isFinite(snapshot.totalScore)
      ? String(snapshot.totalScore)
      : "--";
    forecastConfidence.innerText = Number.isFinite(snapshot.forecastConfidence)
      ? `${snapshot.forecastConfidence}/100`
      : "--";

    const trendText = snapshot.hasTrendHistory
      ? `5m spot ${formatSignedPercent(snapshot.spotChangePct5m)}`
      : "trend collecting";
    scoreDetail.innerText =
      `${snapshot.signalDetail || ""} | ${snapshot.dataQuality?.loadedRows ?? "--"} loaded strikes | OI PCR ${Number.isFinite(snapshot.metrics?.pcrOi) ? snapshot.metrics.pcrOi.toFixed(2) : "--"} | ${trendText} | ` +
      `Updated ${formatTime(snapshot.updatedAt)}`;
  }

  function loadLatestSignal() {
    chrome.storage.local.get({ [LATEST_SIGNAL_STORAGE_KEY]: null }, (data) => {
      renderLatestSignal(data[LATEST_SIGNAL_STORAGE_KEY]);
    });
  }

  function renderBacktestStats(records) {
    const checked = records.filter((record) => record.status && record.status !== "pending");
    const pending = records.filter((record) => record.status === "pending");
    const hits = checked.filter((record) => record.status === "hit").length;
    const misses = checked.filter((record) => record.status === "miss").length;
    const flats = checked.filter((record) => record.status === "flat").length;
    const latestChecked = checked.at(-1);

    hitRate.innerText = formatRate(hits, misses);
    closedSignals.innerText = String(checked.length);
    pendingSignals.innerText = String(pending.length);

    if (!latestChecked) {
      latestSignal.innerText = flats
        ? `${flats} flat signal${flats === 1 ? "" : "s"} checked.`
        : "No checked signals yet.";
      return;
    }

    const resultLabel = latestChecked.status.toUpperCase();
    const move = Number.isFinite(latestChecked.spotMovePct)
      ? `${latestChecked.spotMovePct > 0 ? "+" : ""}${latestChecked.spotMovePct.toFixed(2)}%`
      : "--";

    latestSignal.innerText =
      `${resultLabel}: ${latestChecked.stockName} ${latestChecked.signalLabel} ` +
      `at ${formatTime(latestChecked.entryTime)} moved ${move}.`;
  }

  function loadBacktestStats() {
    chrome.storage.local.get({ [BACKTEST_STORAGE_KEY]: [] }, (data) => {
      const records = Array.isArray(data[BACKTEST_STORAGE_KEY]) ? data[BACKTEST_STORAGE_KEY] : [];
      renderBacktestStats(records);
    });
  }

  clearBacktest.addEventListener("click", () => {
    chrome.storage.local.set({ [BACKTEST_STORAGE_KEY]: [] }, loadBacktestStats);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes[BACKTEST_STORAGE_KEY]) {
      renderBacktestStats(changes[BACKTEST_STORAGE_KEY].newValue || []);
    }

    if (changes[LATEST_SIGNAL_STORAGE_KEY]) {
      renderLatestSignal(changes[LATEST_SIGNAL_STORAGE_KEY].newValue);
    }
  });

  loadLatestSignal();
  loadBacktestStats();
  window.setInterval(() => renderLatestSignal(latestSnapshot), 1000);
})();
