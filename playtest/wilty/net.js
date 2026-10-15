// Connections between the host phone and the players' phones.
//
// Normal mode uses PeerJS (WebRTC). PeerJS's free public server only
// introduces the phones to each other; game data then flows directly between
// them. `?local` swaps in a BroadcastChannel transport so the whole game can
// be tested in several tabs of one browser, without any network.

const PEER_PREFIX = "aechoi-wilty-";

export const isLocalMode = () => new URLSearchParams(location.search).has("local");

// ---------- Host ----------

// handlers: { onOpen(), onMessage(connId, msg), onClose(connId), onError(text) }
export function hostRoom(code, handlers) {
  return isLocalMode() ? localHost(code, handlers) : peerHost(code, handlers);
}

function peerHost(code, h) {
  const conns = new Map();
  let peer;
  let retries = 0;
  let closed = false;

  const start = () => {
    peer = new Peer(PEER_PREFIX + code);
    peer.on("open", () => { retries = 0; h.onOpen(); });
    peer.on("connection", (conn) => {
      conn.on("open", () => conns.set(conn.connectionId, conn));
      conn.on("data", (msg) => h.onMessage(conn.connectionId, msg));
      const drop = () => {
        if (conns.delete(conn.connectionId)) h.onClose(conn.connectionId);
      };
      conn.on("close", drop);
      conn.on("error", drop);
    });
    // Losing the signalling server doesn't drop existing players; reconnect quietly.
    peer.on("disconnected", () => { if (!closed) setTimeout(() => !closed && !peer.destroyed && peer.reconnect(), 1000); });
    peer.on("error", (err) => {
      // After a reload, the server can hold on to our old id for a few seconds.
      if (err.type === "unavailable-id" && retries++ < 10) {
        peer.destroy();
        setTimeout(start, 2000);
        return;
      }
      if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) return;
      h.onError(`Connection problem (${err.type}).`);
    });
  };
  start();

  return {
    send(connId, msg) {
      const c = conns.get(connId);
      if (c?.open) c.send(msg);
    },
    close() { closed = true; peer.destroy(); },
  };
}

function localHost(code, h) {
  const bc = new BroadcastChannel(PEER_PREFIX + code);
  bc.onmessage = ({ data }) => {
    if (data.to) return;
    if (data.bye) h.onClose(data.from);
    else h.onMessage(data.from, data.msg);
  };
  setTimeout(() => h.onOpen(), 0);
  return {
    send(connId, msg) { bc.postMessage({ to: connId, msg }); },
    close() { bc.close(); },
  };
}

// ---------- Player ----------

// handlers: { onOpen(), onMessage(msg), onStatus(text|null), onFatal(text) }
export function joinRoom(code, handlers) {
  return isLocalMode() ? localJoin(code, handlers) : peerJoin(code, handlers);
}

function peerJoin(code, h) {
  let peer;
  let conn;
  let closed = false;
  let retryTimer = null;
  let attempts = 0;

  const retry = () => {
    if (closed || retryTimer) return;
    h.onStatus("Reconnecting…");
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, Math.min(1000 * 2 ** attempts++, 8000));
  };

  const connect = () => {
    if (closed) return;
    if (!peer || peer.destroyed) {
      peer = new Peer();
      peer.on("open", connect);
      peer.on("disconnected", () => !closed && !peer.destroyed && peer.reconnect());
      peer.on("error", (err) => {
        if (err.type === "peer-unavailable") {
          // The host may just be reloading; give it a few tries before giving up.
          if (attempts > 6) return h.onFatal(`Room ${code} isn't open. Check the code, or ask the host to reopen the page.`);
          return retry();
        }
        if (err.type === "browser-incompatible") return h.onFatal("This browser can't connect. Try Chrome or Safari.");
        retry();
      });
      return;
    }
    if (!peer.open || conn?.open) return;
    conn?.close();
    conn = peer.connect(PEER_PREFIX + code, { reliable: true });
    conn.on("open", () => { attempts = 0; h.onStatus(null); h.onOpen(); });
    conn.on("data", (msg) => h.onMessage(msg));
    conn.on("close", retry);
    conn.on("error", retry);
  };

  // Phones drop connections when the screen locks; reconnect when back.
  const onVisible = () => {
    if (document.visibilityState === "visible" && !conn?.open) { attempts = 0; connect(); }
  };
  document.addEventListener("visibilitychange", onVisible);

  h.onStatus("Connecting…");
  connect();
  return {
    send(msg) { if (conn?.open) conn.send(msg); },
    close() {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      peer?.destroy();
    },
  };
}

function localJoin(code, h) {
  const bc = new BroadcastChannel(PEER_PREFIX + code);
  const id = Math.random().toString(36).slice(2);
  bc.onmessage = ({ data }) => { if (data.to === id) h.onMessage(data.msg); };
  addEventListener("pagehide", () => bc.postMessage({ from: id, bye: true }));
  setTimeout(() => h.onOpen(), 0);
  return {
    send(msg) { bc.postMessage({ from: id, msg }); },
    close() { bc.postMessage({ from: id, bye: true }); bc.close(); },
  };
}
