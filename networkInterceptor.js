(function installUpstoxOptionChainNetworkInterceptor() {
  "use strict";

  const EVENT_NAME = "upstox-option-chain-network-payload";
  const OPTION_CHAIN_URL_PATTERN = /option[-_]?chain|optionchain|oc/i;

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input?.url || "";
  }

  function looksLikeOptionChainPayload(url, payload) {
    const text = `${url} ${JSON.stringify(payload).slice(0, 2000)}`;
    return OPTION_CHAIN_URL_PATTERN.test(text) && /strike|ltp|oi|openInterest|option/i.test(text);
  }

  function emitPayload(source, url, payload) {
    if (!payload || !looksLikeOptionChainPayload(url, payload)) return;

    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: {
        source,
        url,
        payload,
        timestamp: Date.now()
      }
    }));
  }

  if (!window.__upstoxOptionChainFetchPatched) {
    window.__upstoxOptionChainFetchPatched = true;
    const nativeFetch = window.fetch;

    window.fetch = async function interceptedFetch(input, init) {
      const response = await nativeFetch.apply(this, arguments);
      const url = getRequestUrl(input);

      if (OPTION_CHAIN_URL_PATTERN.test(url)) {
        response.clone().json()
          .then((payload) => emitPayload("fetch", url, payload))
          .catch(() => {});
      }

      return response;
    };
  }

  if (!window.__upstoxOptionChainWebSocketPatched) {
    window.__upstoxOptionChainWebSocketPatched = true;
    const NativeWebSocket = window.WebSocket;

    function InterceptedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;

        try {
          emitPayload("websocket", String(url || ""), JSON.parse(event.data));
        } catch (_error) {
          // Non-JSON frames are unrelated to option-chain state.
        }
      });

      return socket;
    }

    Object.setPrototypeOf(InterceptedWebSocket, NativeWebSocket);
    InterceptedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = InterceptedWebSocket;
    window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    window.WebSocket.OPEN = NativeWebSocket.OPEN;
    window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
    window.WebSocket.CLOSED = NativeWebSocket.CLOSED;
  }
})();
