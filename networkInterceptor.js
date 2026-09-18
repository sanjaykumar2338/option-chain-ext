(function installUpstoxOptionChainNetworkInterceptor() {
  "use strict";

  if (window.__upstoxOptionChainNetworkInterceptorInstalled) return;
  window.__upstoxOptionChainNetworkInterceptorInstalled = true;

  const EVENT_NAME = "upstox-option-chain-network-payload";
  const REPLAY_EVENT_NAME = "upstox-option-chain-request-latest";
  const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024;
  const MAX_NODES = 25000;
  const MAX_DEPTH = 14;
  const OPTION_CHAIN_PATH = /(?:^|\/)(?:option[-_]?chain|options?\/chain|oc)(?:\/|$)/i;
  const IDENTITY_PARAMS = new Set([
    "symbol", "underlying", "underlying_symbol", "underlyingsymbol", "instrument_key",
    "instrumentkey", "underlying_key", "underlyingkey", "expiry", "expiry_date",
    "expirydate", "exchange", "segment"
  ]);
  let latestPayload = null;

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return typeof input?.url === "string" ? input.url : "";
  }

  function parseUrl(value) {
    try {
      return new URL(value, window.location?.href || "https://pro.upstox.com/");
    } catch (_error) {
      return null;
    }
  }

  function isOptionChainUrl(value) {
    const url = parseUrl(value);
    return url ? OPTION_CHAIN_PATH.test(url.pathname) : false;
  }

  function publicUrl(value) {
    const url = parseUrl(value);
    if (!url) return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    // Keep chain identity for the reader, without forwarding access tokens.
    for (const key of Array.from(url.searchParams.keys())) {
      if (!IDENTITY_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.href;
  }

  function hasOptionRows(payload) {
    const pending = [{ value: payload, depth: 0 }];
    let nodes = 0;
    let found = false;
    while (pending.length) {
      if (++nodes > MAX_NODES) return false;
      const { value, depth } = pending.pop();
      if (!value || typeof value !== "object") continue;
      if (depth > MAX_DEPTH) return false;
      let strike = false;
      let side = false;
      for (const [key, item] of Object.entries(value)) {
        const normalized = key.toLowerCase().replace(/[_\s-]/g, "");
        if (["strike", "strikeprice", "strikepricevalue", "sp"].includes(normalized)) {
          strike = item != null && item !== "" && Number.isFinite(Number(item)) && Number(item) > 0;
        }
        if (/^(call|put|ce|pe|calloption|putoption|calloptions|putoptions|calldata|putdata)$/.test(normalized)
          && item && typeof item === "object") side = true;
        if (["optiontype", "instrumenttype", "type"].includes(normalized)
          && /^(ce|pe|call|put)$/i.test(String(item))) side = true;
        if (item && typeof item === "object") pending.push({ value: item, depth: depth + 1 });
      }
      if (strike && side) found = true;
    }
    return found;
  }

  function dispatch(detail) {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
    } catch (_error) {
      // Capture is observational; it must never interrupt the trading page.
    }
  }

  function captureText(source, url, text) {
    if (typeof text !== "string" || text.length > MAX_PAYLOAD_SIZE) return;
    try {
      const payload = JSON.parse(text);
      if (!hasOptionRows(payload)) return;
      latestPayload = { source, url: publicUrl(url), payload, timestamp: Date.now() };
      dispatch(latestPayload);
    } catch (_error) {
      // Ignore non-JSON and unsupported messages without changing the response.
    }
  }

  window.addEventListener(REPLAY_EVENT_NAME, () => {
    if (latestPayload) dispatch(latestPayload);
  });

  async function captureResponse(response, url) {
    try {
      if (!response || !response.ok) return;
      const declaredSize = Number(response.headers?.get("content-length"));
      if (declaredSize > MAX_PAYLOAD_SIZE) return;
      const copy = response.clone();
      if (copy.body?.getReader && typeof TextDecoder === "function") {
        const reader = copy.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_PAYLOAD_SIZE) {
            // Do not await cancellation of a tee branch: the page owns the other branch.
            Promise.resolve(reader.cancel()).catch(() => {});
            return;
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        captureText("fetch", url, text);
      } else {
        captureText("fetch", url, await copy.text());
      }
    } catch (_error) {
      // An opaque, consumed, failed, or non-JSON response cannot be inspected.
    }
  }

  if (typeof window.fetch === "function") {
    const nativeFetch = window.fetch;
    window.fetch = function interceptedFetch(input) {
      const result = Reflect.apply(nativeFetch, this, arguments);
      try {
        const url = getRequestUrl(input);
        if (isOptionChainUrl(url)) {
          result.then((response) => captureResponse(response, url)).catch(() => {});
        }
      } catch (_error) {
        // Preserve the original promise and rejection, including on capture errors.
      }
      return result;
    };
  }

  if (window.XMLHttpRequest?.prototype) {
    const prototype = window.XMLHttpRequest.prototype;
    const nativeOpen = prototype.open;
    const urls = new WeakMap();
    const observed = new WeakSet();
    prototype.open = function interceptedOpen(method, url) {
      const result = Reflect.apply(nativeOpen, this, arguments);
      try {
        urls.set(this, String(url));
        if (!observed.has(this)) {
          this.addEventListener("load", () => {
            try {
              const requestUrl = urls.get(this);
              if (!isOptionChainUrl(requestUrl) || this.status < 200 || this.status >= 300) return;
              if (this.responseType === "json") {
                captureText("xhr", requestUrl, JSON.stringify(this.response));
              } else if (!this.responseType || this.responseType === "text") {
                captureText("xhr", requestUrl, this.responseText);
              }
            } catch (_error) {
              // Other response types and access errors belong to the page.
            }
          });
          observed.add(this);
        }
      } catch (_error) {
        // Preserve successful native open() even if observation is unavailable.
      }
      return result;
    };
  }

  if (typeof window.WebSocket === "function") {
    const NativeWebSocket = window.WebSocket;
    // A construct-only proxy preserves constants, prototypes, subclassing and
    // native failures (including calling WebSocket without `new`).
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        try {
          const url = socket.url || String(args[0] || "");
          socket.addEventListener("message", (event) => {
            if (typeof event.data === "string") captureText("websocket", url, event.data);
          });
        } catch (_error) {
          // Never prevent the page from opening a socket.
        }
        return socket;
      }
    });
  }
})();
