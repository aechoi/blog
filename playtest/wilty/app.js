import { TEAMS, MAX_CARD_LENGTH, createGame, addPlayer, setConnected, act, tick, viewFor } from "./game.js";
import { hostRoom, joinRoom, isLocalMode } from "./net.js";

const $app = document.getElementById("app");
const HOST_KEY = "wilty-host-game";
const NAME_KEY = "wilty-name";
const ROOM_KEY = "wilty-room";
// Several test tabs in one browser need separate identities.
const idStore = isLocalMode() ? sessionStorage : localStorage;

const store = {
  get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = localStorage) { try { v === null ? s.removeItem(k) : s.setItem(k, v); } catch {} },
};

let myId = store.get("wilty-pid", idStore);
if (!myId) { myId = Math.random().toString(36).slice(2, 12); store.set("wilty-pid", myId, idStore); }

let myName = null;
let view = null;         // what the host last told us
let status = null;       // connection status line
let toastText = null;
let localDeadline = null;
let dispatch = () => {};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const team = (t, cls = "") => (t === null || t === undefined ? "" : `<span class="chip t${t} ${cls}">${TEAMS[t]}</span>`);
const btn = (label, action, cls = "") => `<button class="${cls}" data-act='${esc(JSON.stringify(action))}'>${label}</button>`;
const uiBtn = (label, name, cls = "") => `<button class="${cls}" data-ui="${name}">${label}</button>`;

function toast(text) {
  toastText = text;
  render();
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastText = null; render(); }, 3500);
}

// ---------- Hosting ----------

function startHosting(code, saved) {
  const g = saved || createGame(code, myId);
  if (saved) myId = g.hostId;
  const conns = new Map(); // connId -> playerId
  for (const p of Object.values(g.players)) p.connected = p.id === myId;
  addPlayer(g, myId, store.get(NAME_KEY) || "Host");

  const save = () => store.set(HOST_KEY, JSON.stringify({ savedAt: Date.now(), g }));
  const broadcast = () => {
    const now = Date.now();
    for (const [connId, pid] of conns) net.send(connId, { t: "view", v: viewFor(g, pid, now) });
    receiveView(viewFor(g, myId, now));
    save();
  };

  const net = hostRoom(code, {
    onOpen() { status = null; broadcast(); },
    onMessage(connId, msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "hello" && typeof msg.pid === "string" && msg.pid !== myId) {
        conns.set(connId, msg.pid);
        addPlayer(g, msg.pid, msg.name);
        return broadcast();
      }
      const pid = conns.get(connId);
      // A host that reloaded doesn't know existing connections yet; ask who they are.
      if (msg.t === "act" && !pid) return net.send(connId, { t: "who" });
      if (msg.t === "act" && pid) {
        const err = act(g, pid, msg.a);
        if (err) net.send(connId, { t: "error", text: err });
        broadcast();
      }
    },
    onClose(connId) {
      const pid = conns.get(connId);
      conns.delete(connId);
      if (pid && ![...conns.values()].includes(pid)) { setConnected(g, pid, false); broadcast(); }
    },
    onError(text) { toast(text); },
  });

  dispatch = (a) => {
    const err = act(g, myId, a);
    if (err) toast(err);
    broadcast();
  };
  setInterval(() => { if (tick(g)) broadcast(); }, 250);
  status = "Opening room…";
  receiveView(viewFor(g, myId));
}

// ---------- Joining ----------

function startJoining(code) {
  myName = store.get(NAME_KEY);
  store.set(ROOM_KEY, code);
  store.set("wilty-rejoin", "1", sessionStorage);
  const net = joinRoom(code, {
    onOpen() { status = null; net.send({ t: "hello", pid: myId, name: myName }); },
    onMessage(msg) {
      if (msg?.t === "view") receiveView(msg.v);
      if (msg?.t === "error") toast(msg.text);
      if (msg?.t === "who") { net.send({ t: "hello", pid: myId, name: myName }); toast("Reconnected. Tap again."); }
    },
    onStatus(text) { status = text; render(); },
    onFatal(text) { status = null; view = null; renderHome(text); },
  });
  dispatch = (a) => net.send({ t: "act", a });
  status = "Connecting…";
  renderWaiting();
}

function receiveView(v) {
  const prevPhase = view?.phase;
  view = v;
  localDeadline = v.remainingMs === null ? null : performance.now() + v.remainingMs;
  if (prevPhase && prevPhase !== v.phase && navigator.vibrate) navigator.vibrate(80);
  keepAwake();
  render();
}

// Keep phones from sleeping mid-game, which would drop the connection.
let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => (wakeLock = null));
  } catch {}
}
document.addEventListener("visibilitychange", keepAwake);

// ---------- Timer ----------

function remaining() {
  return localDeadline === null ? null : Math.max(0, localDeadline - performance.now());
}
const TOTALS = { writing: "writeSecs", huddle: "huddleSecs", interrogation: "interrogateSecs", verdict: "verdictSecs" };
let beeped = false;
setInterval(() => {
  const ms = remaining();
  const el = document.querySelector(".timer");
  if (!el || ms === null) return;
  const s = Math.ceil(ms / 1000);
  el.querySelector(".time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const total = (view?.settings?.[TOTALS[view.phase]] || 1) * 1000;
  el.querySelector(".bar i").style.width = `${Math.min(100, (ms / total) * 100)}%`;
  el.classList.toggle("low", s <= 10);
  if (s <= 0 && !beeped) { beeped = true; navigator.vibrate?.([150, 80, 150]); }
  if (s > 0) beeped = false;
}, 200);
const timer = () => (view.remainingMs === null ? "" : `<div class="timer"><div class="time">–:––</div><div class="bar"><i></i></div></div>`);

// ---------- Screens ----------

function renderHome(error) {
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get("room") || "").toUpperCase();
  let saved = null;
  try { saved = JSON.parse(store.get(HOST_KEY)); } catch {}
  if (saved && Date.now() - saved.savedAt > 6 * 3600 * 1000) saved = null;
  const name = store.get(NAME_KEY) || "";

  $app.innerHTML = `
    <header class="home-head"><h1>Would I Lie<br>To You?</h1><p>Party edition · playtest</p></header>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <section class="panel">
      <label class="field">Your name <input id="name" maxlength="24" autocomplete="nickname" value="${esc(name)}" placeholder="e.g. Sam"></label>
      <label class="field">Room code <input id="code" maxlength="4" autocapitalize="characters" value="${esc(roomParam || store.get(ROOM_KEY) || "")}" placeholder="ABCD"></label>
      <button class="primary" id="join">Join game</button>
    </section>
    <section class="panel">
      ${saved ? `<button id="resume">Resume hosting room ${esc(saved.g.code)}</button>` : ""}
      <button id="host">Host a new game</button>
      <p class="hint">The host's phone runs the game, so keep it open and awake until you're done.</p>
    </section>
    <p class="hint center"><a href="../would-i-lie.html">Read the rules</a></p>`;

  const getName = () => {
    const n = document.getElementById("name").value.trim();
    if (!n) { document.getElementById("name").focus(); toastInline("Enter your name first."); return null; }
    store.set(NAME_KEY, n);
    return n;
  };
  const toastInline = (t) => { let e = $app.querySelector(".error"); if (!e) { e = document.createElement("p"); e.className = "error"; $app.querySelector(".panel").before(e); } e.textContent = t; };
  document.getElementById("join").onclick = () => {
    const code = document.getElementById("code").value.trim().toUpperCase();
    if (!getName()) return;
    if (!/^[A-Z]{4}$/.test(code)) return toastInline("Room codes are four letters.");
    history.replaceState(null, "", `?${isLocalMode() ? "local&" : ""}room=${code}`);
    startJoining(code);
  };
  document.getElementById("host").onclick = () => {
    if (!getName()) return;
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
    startHosting(code);
  };
  const resume = document.getElementById("resume");
  if (resume) resume.onclick = () => startHosting(saved.g.code, saved.g);
}

function renderWaiting() {
  $app.innerHTML = `<div class="panel center"><p>${esc(status || "Connecting…")}</p></div>`;
}

function render() {
  if (!view) return status ? renderWaiting() : undefined;
  // Re-rendering replaces the DOM, so carry typed text and focus across.
  const keep = {};
  $app.querySelectorAll("[data-keep]").forEach((el) => {
    keep[el.dataset.keep] = { open: el.open, value: el.value, focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd };
  });

  const v = view;
  const body = { lobby, writing, huddle: round, statement: round, interrogation: round, verdict: round, reveal, over }[v.phase]?.(v) ?? "";
  $app.className = v.me?.team !== null && v.me?.team !== undefined ? `on-t${v.me.team}` : "";
  $app.innerHTML = `
    ${topBar(v)}
    ${v.message ? `<p class="error">${esc(v.message)}</p>` : ""}
    ${body}
    ${v.me?.isHost ? hostControls(v) : ""}
    ${toastText ? `<div class="toast">${esc(toastText)}</div>` : ""}`;

  $app.querySelectorAll("[data-keep]").forEach((el) => {
    const k = keep[el.dataset.keep];
    if (!k) return;
    if (el.tagName === "DETAILS") return void (el.open = k.open);
    el.value = k.value;
    if (k.focused) { el.focus(); try { el.setSelectionRange(k.start, k.end); } catch {} }
  });
}

function topBar(v) {
  const scores = v.phase === "lobby" ? "" : `<div class="scores">${[0, 1, 2].map((t) =>
    `<div class="score t${t} ${v.round?.reader === t ? "reading" : ""}"><span>${TEAMS[t]}</span><b>${v.scores[t]}</b></div>`).join("")}</div>`;
  return `
    <div class="topbar">
      <span>Room <b>${esc(v.code)}</b></span>
      <span>${esc(v.me?.name)} ${team(v.me?.team)}</span>
    </div>
    ${status ? `<p class="status">${esc(status)}</p>` : ""}
    ${scores}`;
}

function playerList(players, mine) {
  return players.map((p) => `<li class="${p.connected ? "" : "offline"}">${esc(p.name)}${p.id === mine ? " (you)" : ""}${p.isHost ? " ★" : ""}</li>`).join("") || `<li class="empty">nobody yet</li>`;
}

function lobby(v) {
  const joinUrl = `${location.origin}${location.pathname}?${isLocalMode() ? "local&" : ""}room=${v.code}`;
  const host = v.me.isHost;
  const cols = [0, 1, 2].map((t) => {
    const members = v.players.filter((p) => p.team === t);
    return `<div class="teamcol t${t}">
      <h3>${TEAMS[t]}</h3>
      <ul>${playerList(members, v.me.id)}</ul>
      ${v.me.team === t ? "" : btn("Join", { type: "joinTeam", team: t }, "small")}
    </div>`;
  }).join("");
  const unassigned = v.players.filter((p) => p.team === null);
  const hostTable = host ? `
    <details class="panel" data-keep="moveplayers"><summary>Move players</summary>
      ${v.players.map((p) => `<div class="row">${esc(p.name)} ${p.connected ? "" : "<i>(offline)</i>"}
        <span class="spacer"></span>
        ${[0, 1, 2].map((t) => btn(TEAMS[t], { type: "setTeamOf", id: p.id, team: t }, `small chip-btn t${t} ${p.team === t ? "on" : ""}`)).join("")}
        ${p.isHost ? "" : btn("✕", { type: "removePlayer", id: p.id }, "small")}
      </div>`).join("")}
    </details>` : "";
  return `
    <section class="panel center">
      <p class="big-code">${esc(v.code)}</p>
      <p class="hint">Friends open this page and enter the code, or use the link:</p>
      <p>${uiBtn("Share invite link", "share", "small")} <span class="hint" data-url="${esc(joinUrl)}">${esc(joinUrl.replace(/^https?:\/\//, ""))}</span></p>
    </section>
    <section class="panel">
      <label class="field">Your name <input data-keep="name" id="rename" maxlength="24" value="${esc(v.me.name)}"></label>
    </section>
    <h2>Pick a team</h2>
    <div class="teams">${cols}</div>
    ${unassigned.length ? `<p class="hint">Not on a team yet: ${unassigned.map((p) => esc(p.name)).join(", ")}. They'll be placed automatically at the start.</p>` : ""}
    ${host ? `<div class="actions">${btn("Randomize teams", { type: "randomizeTeams" })}${btn("Start game", { type: "start" }, "primary")}</div>${hostTable}` :
      `<p class="waiting">Waiting for the host to start…</p>`}`;
}

function writing(v) {
  if (v.me.team === null) return joinLate();
  const mins = Math.round(v.settings.writeSecs / 60);
  return `
    ${timer()}
    <section class="panel">
      <h2>Write your truths</h2>
      <ul class="tips">
        <li>Each card is one <b>true</b> fact about you. The stranger the better.</li>
        <li>No names or details that point at you. Nothing these people already know.</li>
        <li>Aim for a few cards each. Your team wants 8–12 total.</li>
      </ul>
      <textarea data-keep="draft" id="draft" rows="3" maxlength="${MAX_CARD_LENGTH}" placeholder="I once…"></textarea>
      <div class="actions">${uiBtn("Add card", "addCard", "primary")}</div>
    </section>
    <section class="panel">
      <h3>Your cards (${v.myCards.length})</h3>
      ${v.myCards.length ? `<ul class="cards">${v.myCards.map((c) => `<li><span>${esc(c.text)}</span>${btn("✕", { type: "removeCard", id: c.id }, "small")}</li>`).join("")}</ul>` : `<p class="hint">None yet.</p>`}
    </section>
    <p class="center">${[0, 1, 2].map((t) => `${team(t)} ${v.teamCounts[t]}`).join(" &nbsp; ")} <span class="hint">cards</span></p>
    <div class="actions">${btn(v.done ? "Wait, I have more" : "I'm done writing", { type: "doneWriting", done: !v.done }, v.done ? "" : "primary")}</div>
    <p class="hint center">${v.doneCount} of ${v.onlineCount} done. Writing ends when everyone is done or time runs out (${mins} min).</p>`;
}

function joinLate() {
  return `<section class="panel"><h2>Join a team</h2><p>The game already started. Pick a team to play along.</p>
    <div class="actions">${[0, 1, 2].map((t) => btn(TEAMS[t], { type: "joinTeam", team: t }, `chip-btn t${t}`)).join("")}</div></section>`;
}

const badge = (isTruth) => (isTruth ? `<span class="badge truth">TRUTH</span>` : `<span class="badge lie">LIE</span>`);
const cardBox = (text, isTruth) => `<blockquote class="card">${isTruth === undefined ? "" : badge(isTruth)}<p>${esc(text)}</p></blockquote>`;

function round(v) {
  const r = v.round;
  const R = team(r.reader), G = team(r.guessers), B = team(r.partner);
  const phaseName = { huddle: "Huddle", statement: "Statement", interrogation: "Interrogation", verdict: "Verdict" }[v.phase];
  const head = `
    <p class="roundinfo">Round ${r.number} of ${r.total} · ${R} reads from the pile shared with ${B} · ${G} guess</p>
    <h2 class="phase">${phaseName}</h2>
    ${timer()}`;
  let main = "";

  if (r.role === "reader") {
    const who = r.isTruth
      ? (r.authorIsMe ? "It's <b>your</b> card. You read it." : `It's <b>${esc(r.author)}</b>'s card. ${esc(r.author)} reads it.`)
      : `It's one of ${B}'s cards. Pick anyone on your team to read it, and sell it.`;
    main = {
      huddle: `${cardBox(r.text, r.isTruth)}<p>${who}</p><p class="hint">Use the full time, even if you're ready. Leaving early is a tell.</p>`,
      statement: `${cardBox(r.text, r.isTruth)}<p>${who}</p><p>Read it aloud as your own story.</p>
        <div class="actions">${btn("Statement finished — start questions", { type: "statementDone" }, "primary")}</div>`,
      interrogation: `${cardBox(r.text, r.isTruth)}<p class="lead">${r.isTruth ? "It's true: answer every question honestly. No dodging." : "It's a lie: make up whatever you need. Commit!"}</p>`,
      verdict: `${cardBox(r.text, r.isTruth)}<p class="lead">${G} are deciding…</p>`,
    }[v.phase];
  } else if (r.role === "guesser") {
    main = {
      huddle: `<p class="lead">${R} are reading their card. Get ready to grill them.</p>`,
      statement: `<p class="lead">Listen to ${R}'s story.</p>`,
      interrogation: `<p class="lead shout">Interrogate!</p><p>Ask ${R} anything you like. Truth or lie?</p>`,
      verdict: v.phase === "verdict" ? verdictPanel(v) : "",
    }[v.phase];
  } else if (r.role === "bystander") {
    const know = r.text === undefined ? "" : (r.isTruth
      ? `<p class="lead">Not one of yours, so it's <b>true</b>. Don't react.</p>${cardBox(r.text)}`
      : `<p class="lead">${r.authorIsMe ? "That's <b>your</b> card" : `That's <b>${esc(r.author)}</b>'s card`}, so it's a <b>lie</b>. Poker face!</p>${cardBox(r.text)}`);
    main = {
      huddle: `<p class="lead">${R} are drawing from the pile you share. Stay neutral.</p>`,
      statement: `<p class="lead">Listen, and keep a straight face.</p>`,
      interrogation: `${know}<p class="hint">No reactions, no hints, no faces.</p>`,
      verdict: `${know}<p class="hint">${G} are voting.</p>`,
    }[v.phase];
  } else {
    main = `<p class="lead">${R} are reading; ${G} are guessing.</p>${v.me.team === null ? joinLate() : ""}`;
  }
  return head + `<section class="panel stage">${main}</section>`;
}

function verdictPanel(v) {
  const r = v.round;
  const tb = r.tiebreaker ? (r.tiebreaker.id === v.me.id ? "<b>You</b> break ties." : `${esc(r.tiebreaker.name)} breaks ties.`) : "";
  const choice = (c, label) => btn(label, { type: "vote", choice: c }, `vote ${c} ${r.myVote === c ? "on" : ""}`);
  const votes = r.votes.map((p) => `<li>${esc(p.name)}: ${p.choice ? (p.choice === "truth" ? "Truth" : "Lie") : "…"}${p.locked ? " 🔒" : ""}</li>`).join("");
  return `
    <p class="lead">Truth or lie?</p>
    <div class="votes ${r.myLocked ? "locked" : ""}">${choice("truth", "Truth")}${choice("lie", "Lie")}</div>
    <div class="actions">${r.myLocked ? `<p>Locked in. Waiting for your team…</p>` : btn("Lock in", { type: "lockIn" }, "primary")}</div>
    <ul class="teamvotes">${votes}</ul>
    <p class="hint">Majority wins. ${tb} Votes that aren't locked in still count when time runs out.</p>`;
}

function reveal(v) {
  const r = v.round;
  const said = r.verdict === "truth" ? "Truth" : "Lie";
  const right = (r.verdict === "truth") === r.isTruth;
  const pts = r.delta.map((d, t) => (d ? `<li>${team(t)} +${d}</li>` : "")).join("");
  return `
    <p class="roundinfo">Round ${r.number} of ${r.total}</p>
    <section class="panel stage center">
      <p class="reveal ${r.isTruth ? "truth" : "lie"}">${r.isTruth ? "It was TRUE" : "It was a LIE"}</p>
      ${cardBox(r.text)}
      <p>Written by <b>${esc(r.author)}</b> ${team(r.authorTeam)}</p>
      <p>${team(r.guessers)} said <b>${said}</b>${r.tieBroken ? " (tie-break)" : ""}: ${right ? "correct!" : "fooled!"}</p>
      <ul class="points">${pts}</ul>
    </section>
    <div class="actions">${r.iAmReady ? `<p>Waiting for others… (${r.readyCount}/${r.onlineCount})</p>` : btn(`Ready (${r.readyCount}/${r.onlineCount})`, { type: "ready" }, "primary")}</div>`;
}

function over(v) {
  const best = Math.max(...v.scores);
  const winners = [0, 1, 2].filter((t) => v.scores[t] === best);
  return `
    <section class="panel center">
      <h2>${winners.length > 1 ? "It's a tie!" : `${team(winners[0], "big")} wins!`}</h2>
      ${[0, 1, 2].sort((a, b) => v.scores[b] - v.scores[a]).map((t) => `<p>${team(t)} ${v.scores[t]} points</p>`).join("")}
    </section>
    <h3>All the stories</h3>
    <ul class="history">${v.history.map((h) => `<li>${h.isTruth ? badge(true) : badge(false)} ${esc(h.text)} <span class="hint">— ${esc(h.author)}</span></li>`).join("")}</ul>
    <p class="center hint"><a href="../would-i-lie.html#playtest-notes">Leave playtest notes</a></p>`;
}

function hostControls(v) {
  const b = [];
  if (v.phase === "lobby") {
    const s = v.settings;
    b.push(`<label class="field inline">Writing time (min) <input type="number" min="1" max="30" value="${s.writeSecs / 60}" data-setting="writeSecs" data-scale="60"></label>`);
    b.push(`<label class="field inline">Interrogation (s) <input type="number" min="15" max="600" value="${s.interrogateSecs}" data-setting="interrogateSecs" data-scale="1"></label>`);
  }
  if (v.phase === "writing") b.push(btn("+1 minute", { type: "addTime", secs: 60 }), btn("End writing now", { type: "endWriting" }));
  if (["huddle", "statement"].includes(v.phase)) b.push(btn("Skip card (someone's heard it)", { type: "skipCard" }));
  if (["huddle", "statement", "interrogation", "verdict"].includes(v.phase)) b.push(btn("Next phase", { type: "advance" }), btn("+30 s", { type: "addTime", secs: 30 }));
  if (v.phase === "reveal") b.push(btn("Continue without waiting", { type: "advance" }));
  if (!["lobby", "over"].includes(v.phase)) b.push(btn("End game now", { type: "endGame" }, "danger"));
  if (v.phase === "over") b.push(btn("New game, same teams", { type: "newGame" }, "primary"));
  b.push(uiBtn("Close room", "closeRoom", "danger"));
  return `<details class="panel hostctl" data-keep="hostctl-${v.phase === "lobby" ? "lobby" : "game"}" ${v.phase === "lobby" ? "open" : ""}><summary>Host controls</summary><div class="actions wrap">${b.join("")}</div></details>`;
}

// ---------- Events ----------

$app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act],[data-ui]");
  if (!el) return;
  if (el.dataset.act) {
    const a = JSON.parse(el.dataset.act);
    if (a.type === "endGame" && !confirm("End the game now?")) return;
    return dispatch(a);
  }
  switch (el.dataset.ui) {
    case "addCard": {
      const box = document.getElementById("draft");
      if (!box.value.trim()) return box.focus();
      const text = box.value;
      box.value = ""; // before dispatch: the host re-renders synchronously and keeps typed text
      dispatch({ type: "addCard", text });
      document.getElementById("draft")?.focus();
      return;
    }
    case "share": {
      const url = $app.querySelector("[data-url]").dataset.url;
      try {
        if (navigator.share) await navigator.share({ title: "Would I Lie To You?", text: `Join room ${view.code}`, url });
        else { await navigator.clipboard.writeText(url); toast("Link copied."); }
      } catch {}
      return;
    }
    case "closeRoom":
      if (!confirm("Close the room? Everyone will be disconnected and the game is lost.")) return;
      store.set(HOST_KEY, null);
      location.href = location.pathname + (isLocalMode() ? "?local" : "");
      return;
  }
});

$app.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "rename" && el.value.trim()) {
    store.set(NAME_KEY, (myName = el.value.trim()));
    dispatch({ type: "setName", name: el.value });
  }
  if (el.dataset.setting) dispatch({ type: "setting", key: el.dataset.setting, value: Number(el.value) * Number(el.dataset.scale) });
});

$app.addEventListener("keydown", (e) => {
  if (e.target.id === "draft" && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $app.querySelector('[data-ui="addCard"]').click();
  }
});

// Leaving mid-game by accident (back swipe) is easy on a phone.
addEventListener("beforeunload", (e) => {
  if (view && !["lobby", "over"].includes(view.phase)) e.preventDefault();
});

const roomParam = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
if (!isLocalMode() && typeof Peer === "undefined") renderHome("Couldn't load the connection library. Check your internet and reload.");
// A reload mid-game drops straight back into the same room as the same player.
else if (roomParam && roomParam === store.get(ROOM_KEY) && store.get(NAME_KEY) && store.get("wilty-rejoin", sessionStorage)) startJoining(roomParam);
else renderHome();
