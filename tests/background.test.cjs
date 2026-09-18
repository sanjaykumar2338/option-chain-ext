const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function createWorker(options = {}) {
  let listener;
  const notifications = [];
  let permissionChecks = 0;
  const runtime = {
    getURL: (file) => `chrome-extension://test/${file}`,
    onMessage: { addListener: (callback) => { listener = callback; } }
  };
  function complete(callback, value, error) {
    setImmediate(() => {
      runtime.lastError = error ? { message: error } : undefined;
      try {
        callback(value);
      } finally {
        runtime.lastError = undefined;
      }
    });
  }
  vm.runInNewContext(source, {
    chrome: {
      runtime,
      storage: {
        sync: {
          get: (_defaults, callback) => complete(callback,
            { notificationsEnabled: options.enabled ?? true }, options.settingsError)
        }
      },
      notifications: {
        getPermissionLevel: (callback) => {
          permissionChecks += 1;
          complete(callback, options.permission || "granted", options.permissionError);
        },
        create: (id, details, callback) => {
          notifications.push({ id, details });
          complete(callback, options.emptyId ? "" : id, options.createError);
        }
      }
    }
  });
  return {
    notifications,
    get permissionChecks() { return permissionChecks; },
    listener,
    send(message = { type: "UPSTOX_OPTION_SIGNAL", stockName: "NIFTY", signalLabel: "BUY CALL" }) {
      return new Promise((resolve) => {
        let returned = false;
        const keptOpen = listener(message, {}, (response) => {
          assert.equal(returned, true, "the response must arrive asynchronously");
          resolve(response);
        });
        assert.equal(keptOpen, true, "the worker must keep the response channel open");
        returned = true;
      });
    }
  };
}

test("ignores unrelated messages", () => {
  const worker = createWorker();
  assert.equal(worker.listener({ type: "OTHER" }, {}, () => assert.fail("unexpected response")), undefined);
  assert.equal(worker.notifications.length, 0);
});

test("reports disabled notifications without creating an alert", async () => {
  const worker = createWorker({ enabled: false });
  const response = await worker.send();
  assert.equal(response.ok, false);
  assert.equal(response.reason, "disabled");
  assert.match(response.error, /off/);
  assert.equal(worker.permissionChecks, 0);
  assert.equal(worker.notifications.length, 0);
});

test("reports denied notification permission", async () => {
  const worker = createWorker({ permission: "denied" });
  const response = await worker.send();
  assert.equal(response.ok, false);
  assert.equal(response.reason, "permission_denied");
  assert.equal(worker.notifications.length, 0);
});

for (const [option, reason] of [
  ["settingsError", "settings_error"],
  ["permissionError", "permission_error"],
  ["createError", "create_error"]
]) {
  test(`reports ${reason} from Chrome`, async () => {
    const worker = createWorker({ [option]: "Chrome API failed" });
    const response = await worker.send();
    assert.equal(response.ok, false);
    assert.equal(response.reason, reason);
    assert.match(response.error, /Chrome API failed/);
    assert.equal(worker.notifications.length, option === "createError" ? 1 : 0);
  });
}

test("does not report success when Chrome returns no notification ID", async () => {
  const response = await createWorker({ emptyId: true }).send();
  assert.equal(response.ok, false);
  assert.equal(response.reason, "create_error");
});

test("acknowledges the notification only after Chrome creates it", async () => {
  const worker = createWorker();
  const response = await worker.send();
  assert.equal(response.ok, true);
  assert.equal(worker.notifications.length, 1);
  assert.equal(response.notificationId, worker.notifications[0].id);
  assert.equal(worker.notifications[0].details.title, "NIFTY - BUY CALL");
});

test("test notifications use the same permission and preference checks", async () => {
  const message = { type: "UPSTOX_OPTION_SIGNAL_TEST" };
  for (const [options, reason] of [
    [{ enabled: false }, "disabled"],
    [{ permission: "denied" }, "permission_denied"]
  ]) {
    const worker = createWorker(options);
    const response = await worker.send(message);
    assert.equal(response.reason, reason);
    assert.equal(worker.notifications.length, 0);
  }
  const worker = createWorker();
  const response = await worker.send(message);
  assert.equal(response.ok, true);
  assert.equal(worker.permissionChecks, 1);
  assert.match(worker.notifications[0].details.title, /Test notification/);
  assert.match(worker.notifications[0].details.message, /not a trading signal/);
});
