(function registerNotificationWorker() {
  "use strict";

  const SIGNAL_NOTIFICATION_TYPE = "UPSTOX_OPTION_SIGNAL";
  const NOTIFICATIONS_ENABLED_KEY = "notificationsEnabled";
  const ICON_URL = chrome.runtime.getURL("icon-128.png");

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== SIGNAL_NOTIFICATION_TYPE) return;

    chrome.storage.sync.get({ [NOTIFICATIONS_ENABLED_KEY]: true }, (settings) => {
      if (!settings[NOTIFICATIONS_ENABLED_KEY]) return;

      const notificationId = [
        "upstox-option-signal",
        message.stockName || "option-chain",
        message.signalKey || "signal",
        Date.now()
      ].join("-");

      chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: ICON_URL,
        title: [message.stockName, message.signalLabel].filter(Boolean).join(" - ") ||
          "Option Chain Signal",
        message: message.detail || "New option-chain signal detected.",
        contextMessage: message.meta || "Upstox Option Chain",
        priority: 2
      });
    });
  });
})();
