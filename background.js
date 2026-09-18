(function registerNotificationWorker() {
  "use strict";

  const SIGNAL_NOTIFICATION_TYPE = "UPSTOX_OPTION_SIGNAL";
  const TEST_NOTIFICATION_TYPE = "UPSTOX_OPTION_SIGNAL_TEST";
  const NOTIFICATIONS_ENABLED_KEY = "notificationsEnabled";
  const ICON_URL = chrome.runtime.getURL("icon-128.png");

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (![SIGNAL_NOTIFICATION_TYPE, TEST_NOTIFICATION_TYPE].includes(message?.type)) return;

    const isTest = message.type === TEST_NOTIFICATION_TYPE;
    const fail = (reason, error) => sendResponse({ ok: false, reason, error });

    chrome.storage.sync.get({ [NOTIFICATIONS_ENABLED_KEY]: true }, (settings) => {
      const settingsError = chrome.runtime.lastError;
      if (settingsError) {
        fail("settings_error", `Could not read notification settings: ${settingsError.message}`);
        return;
      }
      if (!settings[NOTIFICATIONS_ENABLED_KEY]) {
        fail("disabled", "Chrome notifications are off. Enable them in the extension popup.");
        return;
      }

      chrome.notifications.getPermissionLevel((permission) => {
        const permissionError = chrome.runtime.lastError;
        if (permissionError) {
          fail("permission_error", `Could not check notification permission: ${permissionError.message}`);
          return;
        }
        if (permission !== "granted") {
          fail("permission_denied", "Notification permission is blocked. Check Chrome notification settings.");
          return;
        }

        const notificationId = [
          isTest ? "upstox-option-test" : "upstox-option-signal",
          message.stockName || "option-chain",
          message.signalKey || "signal",
          Date.now()
        ].join("-");

        chrome.notifications.create(notificationId, {
          type: "basic",
          iconUrl: ICON_URL,
          title: isTest ? "Option Signals - Test notification" :
            [message.stockName, message.signalLabel].filter(Boolean).join(" - ") ||
            "Option Chain Signal",
          message: isTest ? "Desktop notification test. This is not a trading signal." :
            message.detail || "New option-chain signal detected.",
          contextMessage: isTest ? "Upstox Option Chain" : message.meta || "Upstox Option Chain",
          priority: 2
        }, (createdId) => {
          const createError = chrome.runtime.lastError;
          if (createError || !createdId) {
            fail("create_error", createError?.message || "Chrome did not create the notification.");
            return;
          }
          sendResponse({ ok: true, notificationId: createdId });
        });
      });
    });

    return true;
  });
})();
