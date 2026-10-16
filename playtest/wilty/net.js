// Connections between the host phone and the players' phones.
//
// Phones talk through free public MQTT brokers over secure WebSockets: plain
// web traffic, so it works on any network that can load the site. (Direct
// phone-to-phone WebRTC was tried first, but often never connected on
// mobile.) Messages go through two brokers at once, in case one is down, and
// duplicates are dropped. Everything is encrypted with a key derived from the
// room code, and topics are hashed, so the public broker only sees noise.
//
// `?local` swaps in a BroadcastChannel transport so the whole game can be
// tested in several tabs of one browser, without any network. `?broker=URL[,URL]`
// uses brokers of your choice instead of the public ones.

import mqtt from "./vendor/mqtt.esm.js";

const PUBLIC_BROKERS = ["wss://broker.emqx.io:8084/mqtt", "wss://broker.hivemq.com:8884/mqtt"];
const PING_MS = 4000;
const TIMEOUT_MS = 15000;

const params = new URLSearchParams(location.search);
export const isLocalMode = () => params.has("local");
const brokers = () => (params.get("broker") ? params.get("broker").split(",") : PUBLIC_BROKERS);
const randomId = () => Math.random().toString(36).slice(2, 12);

// ---------- Encryption ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function roomCrypto(code) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`aechoi-wilty-topic:${code}`));
  const topic = `aechoi-wilty/v1/${[...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const base = await crypto.subtle.importKey("raw", enc.encode(`wilty:${code}`), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("aechoi-wilty-v1"), iterations: 100000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    topic,
    async seal(obj) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      // Sent as base64 text: the MQTT library's browser build mangles raw Uint8Arrays.
      let bin = "";
      for (const byte of out) bin += String.fromCharCode(byte);
      return btoa(bin);
    },
    async open(text) {
      try {
        const buf = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
        return JSON.parse(dec.decode(pt));
      } catch {
        return null; // not ours, or tampered with
      }
    },
  };
}

// One logical channel over several brokers. onState(connected) reports
// whether at least one broker is reachable.
function relay(rc, subTopic, onMsg, onState) {
  const seen = new Set();
  const seenOrder = [];
  const up = new Set();
  const clients = brokers().map((url, i) => {
    const c = mqtt.connect(url, { clientId: `wilty_${randomId()}`, clean: true, keepalive: 30, reconnectPeriod: 2000, connectTimeout: 10000 });
    c.on("connect", () => {
      c.subscribe(subTopic);
      up.add(i);
      onState(true);
    });
    const down = () => { if (up.delete(i) && !up.size) onState(false); };
    c.on("close", down);
    c.on("offline", down);
    c.on("error", () => {});
    c.on("message", async (_topic, payload) => {
      const m = await rc.open(dec.decode(payload));
      if (!m || seen.has(m.id)) return;
      seen.add(m.id);
      seenOrder.push(m.id);
      if (seenOrder.length > 500) seen.delete(seenOrder.shift());
      onMsg(m);
    });
    return c;
  });
  return {
    async publish(topic, obj) {
      const payload = await rc.seal({ ...obj, id: randomId() + randomId() });
      for (const c of clients) if (c.connected) c.publish(topic, payload);
    },
    close() { clients.forEach((c) => c.end(true)); },
  };
}

// ---------- Host ----------

// handlers: { onOpen(), onMessage(connId, msg), onClose(connId), onError(text) }
export function hostRoom(code, handlers) {
  return isLocalMode() ? localHost(code, handlers) : relayHost(code, handlers);
}

function relayHost(code, h) {
  const lastSeen = new Map();
  // Increasing across host reloads, so players can drop stale, reordered messages.
  let seq = Date.now() * 1000;
  let r = null;
  let opened = false;
  const queue = [];

  roomCrypto(code).then((rc) => {
    r = relay(rc, `${rc.topic}/h`, ({ from, msg }) => {
      if (typeof from !== "string") return;
      if (msg?.t === "bye") {
        if (lastSeen.delete(from)) h.onClose(from);
        return;
      }
      lastSeen.set(from, Date.now());
      if (msg?.t === "ping") send(from, { t: "pong" });
      h.onMessage(from, msg);
    }, (connected) => {
      if (connected && !opened) { opened = true; h.onOpen(); }
      if (!connected) h.onError("Lost the connection. Retrying…");
    });
    r.rc = rc;
    queue.splice(0).forEach(([id, msg]) => send(id, msg));
  });

  // Players ping every few seconds; silence means they left or their phone slept.
  setInterval(() => {
    const cutoff = Date.now() - TIMEOUT_MS;
    for (const [id, t] of lastSeen) if (t < cutoff) { lastSeen.delete(id); h.onClose(id); }
  }, 2000);

  function send(connId, msg) {
    if (!r) return queue.push([connId, msg]);
    r.publish(`${r.rc.topic}/c/${connId}`, { msg, seq: ++seq });
  }
  return { send, close() { r?.close(); } };
}

function localHost(code, h) {
  const bc = new BroadcastChannel(`aechoi-wilty-${code}`);
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

// handlers: { onOpen(), onMessage(msg), onStatus(text|null) }
export function joinRoom(code, handlers) {
  return isLocalMode() ? localJoin(code, handlers) : relayJoin(code, handlers);
}

function relayJoin(code, h) {
  const connId = randomId();
  let r = null;
  let lastSeq = 0;
  let lastHeard = 0;
  let everHeard = false;
  const startedAt = Date.now();

  roomCrypto(code).then((rc) => {
    let opened = false;
    r = relay(rc, `${rc.topic}/c/${connId}`, ({ msg, seq }) => {
      if (seq <= lastSeq) return; // an older message arriving late via the other broker
      lastSeq = seq;
      lastHeard = Date.now();
      everHeard = true;
      h.onStatus(null);
      if (msg?.t !== "pong") h.onMessage(msg);
    }, (connected) => {
      if (!connected) return h.onStatus("Reconnecting…");
      h.onStatus(everHeard ? null : `Looking for room ${code}…`);
      if (!opened) { opened = true; h.onOpen(); }
      else send({ t: "ping" });
    });
    r.rc = rc;
  });

  const send = (msg) => r?.publish(`${r.rc.topic}/h`, { from: connId, msg });

  // Heartbeat: tells the host we're still here, and the pong tells us the host is.
  setInterval(() => {
    send({ t: "ping" });
    const quiet = Date.now() - lastHeard;
    if (!everHeard && Date.now() - startedAt > TIMEOUT_MS) {
      h.onStatus(`Can't find room ${code}. Check the code, and make sure the host's page is open.`);
    } else if (everHeard && quiet > TIMEOUT_MS) {
      h.onStatus("Waiting for the host's phone…");
    }
  }, PING_MS);

  // Phones pause pages when the screen locks; say hello again when back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") send({ t: "ping" });
  });
  addEventListener("pagehide", () => send({ t: "bye" }));

  return { send, close() { send({ t: "bye" }); r?.close(); } };
}

function localJoin(code, h) {
  const bc = new BroadcastChannel(`aechoi-wilty-${code}`);
  const id = randomId();
  bc.onmessage = ({ data }) => { if (data.to === id) h.onMessage(data.msg); };
  addEventListener("pagehide", () => bc.postMessage({ from: id, bye: true }));
  setTimeout(() => h.onOpen(), 0);
  return {
    send(msg) { bc.postMessage({ from: id, msg }); },
    close() { bc.postMessage({ from: id, bye: true }); bc.close(); },
  };
}
