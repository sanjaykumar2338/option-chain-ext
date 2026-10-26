(function installTradingHeaderSignal() {
  "use strict";

  const BADGE_ID = "upstox-header-option-signal";
  const STORAGE_KEY = "latestSignalSnapshot";
  const MAX_AGE_MS = 30000;
  let snapshot = null;
  let revision = 0;
  let timer;

  function findHeaderRow() {
    const banner = document.querySelector('[role="banner"]') || document.querySelector('header');
    if (!banner) return null;
    // Upstox's navigation is a direct flex child beneath the ticker.
    return Array.from(banner.children).find((child) => {
      const style = window.getComputedStyle(child);
      const height = child.getBoundingClientRect().height;
      return child.id !== "ticker" && style.display === "flex"
        && style.flexDirection !== "column" && height >= 36 && height <= 60;
    }) || null;
  }

  function render() {
    if (!/^\/trading-charts(?:\/|$)/.test(window.location.pathname)) {
      document.getElementById(BADGE_ID)?.remove();
      return;
    }
    const row = findHeaderRow();
    if (!row) {
      document.getElementById(BADGE_ID)?.remove();
      return;
    }
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = BADGE_ID;
      badge.setAttribute("role", "status");
      badge.setAttribute("aria-live", "polite");
      badge.style.cssText = "display:flex;flex-direction:column;justify-content:center;flex:0 1 250px;min-width:110px;max-width:250px;height:34px;box-sizing:border-box;padding:3px 9px;margin:0 6px;border-radius:6px;color:#fff;font:600 11px/14px system-ui,sans-serif;overflow:hidden;";
      badge.innerHTML = '<span data-role="action" style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span><span data-role="market" style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>';
    }
    if (badge.parentElement !== row) row.insertBefore(badge, row.children[1] || null);
    const now = Date.now();
    const fresh = snapshot && Number.isFinite(snapshot.updatedAt)
      && now >= snapshot.updatedAt && now - snapshot.updatedAt <= MAX_AGE_MS
      && Number.isFinite(snapshot.dataUpdatedAt)
      && now >= snapshot.dataUpdatedAt && now - snapshot.dataUpdatedAt <= MAX_AGE_MS;
    const key = fresh ? snapshot.signalKey : "neutral";
    const action = fresh ? snapshot.signalLabel || "WAITING" : "WAITING";
    const candidate = fresh && ["call", "put"].includes(key) ? snapshot.candidate : null;
    const actionText = `${action}${candidate ? ` · ${candidate.strike} ${key === "call" ? "CE" : "PE"}` : ""}`;
    const marketText = snapshot?.stockName
      ? `${snapshot.stockName} · ${snapshot.expiry || "Expiry unavailable"}`
      : "Open an option-chain tab";
    const detail = fresh ? snapshot.signalDetail || action
      : "Open or keep an Upstox option-chain tab running for fresh signals.";
    const title = `${marketText}\n${detail}${snapshot?.updatedAt ? `\nLast checked: ${new Date(snapshot.updatedAt).toLocaleTimeString("en-IN")}` : ""}`;
    // Avoid repeated live-region announcements for unchanged checks.
    const actionNode = badge.querySelector('[data-role="action"]');
    const marketNode = badge.querySelector('[data-role="market"]');
    if (actionNode.textContent !== actionText) actionNode.textContent = actionText;
    if (marketNode.textContent !== marketText) marketNode.textContent = marketText;
    badge.title = title;
    badge.style.background = key === "call" ? "#15803d" : key === "put" ? "#b91c1c" : "#6b7280";
  }

  function onStorageChanged(changes, area) {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    revision += 1;
    snapshot = changes[STORAGE_KEY].newValue || null;
    render();
  }

  // Recheck age before showing a signal after a suspended/throttled tab resumes.
  function onResume() {
    if (!document.hidden) render();
  }
  document.addEventListener("visibilitychange", onResume);
  window.addEventListener("focus", onResume);
  window.addEventListener("pageshow", onResume);
  chrome.storage.onChanged.addListener(onStorageChanged);
  const initialRevision = revision;
  chrome.storage.local.get(STORAGE_KEY, (items) => {
    if (chrome.runtime.lastError) return;
    if (revision === initialRevision) snapshot = items?.[STORAGE_KEY] || null;
    render();
  });
  // Also handles delayed header mounting, React remounts, SPA routes and expiry.
  timer = window.setInterval(() => {
    try {
      if (!chrome.runtime?.id) throw new Error("Extension invalidated");
      render();
    } catch (_error) {
      window.clearInterval(timer);
      document.getElementById(BADGE_ID)?.remove();
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_ignored) {}
    }
  }, 1000);
})();
