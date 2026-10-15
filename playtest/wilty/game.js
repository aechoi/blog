// Game rules and state for Would I Lie To You. Pure logic, no networking:
// the host device owns one game object, applies everyone's actions to it,
// and sends each player only their own view (viewFor).

export const TEAMS = ["Orange", "Teal", "Purple"];
export const MAX_CARD_LENGTH = 280;
export const MAX_CARDS_PER_PLAYER = 12;

const DEFAULT_SETTINGS = { writeSecs: 360, huddleSecs: 30, interrogateSecs: 90, verdictSecs: 30 };
const TIMED = { huddle: "huddleSecs", interrogation: "interrogateSecs", verdict: "verdictSecs" };

const shuffle = (arr, rng = Math.random) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];
let idCounter = 0;
const newId = () => `${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function createGame(code, hostId) {
  return {
    code,
    hostId,
    players: {},
    order: [],
    phase: "lobby",
    settings: { ...DEFAULT_SETTINGS },
    deadline: null,
    cards: {},
    writingDone: {},
    piles: [[], [], []],
    scores: [0, 0, 0],
    roundIndex: 0,
    totalRounds: 0,
    round: null,
    history: [],
    message: null,
  };
}

// Teams sit clockwise, so the team on your left is the next one clockwise.
// Pile i sits between team i and team i+1. Each turn is two rounds: the
// reading team's left pile, then its right pile. The guessers are the team
// across from the pile, who wrote none of its cards.
export function rolesForRound(k) {
  const reader = Math.floor(k / 2) % 3;
  if (k % 2 === 0) return { reader, partner: (reader + 1) % 3, guessers: (reader + 2) % 3, pile: reader, side: "left" };
  return { reader, partner: (reader + 2) % 3, guessers: (reader + 1) % 3, pile: (reader + 2) % 3, side: "right" };
}

export function scoreRound(isTruth, verdict, roles) {
  const delta = [0, 0, 0];
  if (isTruth && verdict === "truth") delta[roles.guessers] += 1;
  if (isTruth && verdict === "lie") delta[roles.reader] += 1;
  if (!isTruth && verdict === "truth") delta[roles.reader] += 2;
  if (!isTruth && verdict === "lie") { delta[roles.guessers] += 1; delta[roles.partner] += 1; }
  return delta;
}

const teamMembers = (g, team) => g.order.map((id) => g.players[id]).filter((p) => p.team === team);
const connectedIds = (g) => g.order.filter((id) => g.players[id].connected);
const cleanText = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function addPlayer(g, id, name) {
  const existing = g.players[id];
  if (existing) {
    existing.connected = true;
    if (name) existing.name = cleanText(name, 24) || existing.name;
    return existing;
  }
  // Late joiners can't write cards, but they can still join a team and play.
  const p = { id, name: cleanText(name, 24) || "Player", team: null, connected: true };
  g.players[id] = p;
  g.order.push(id);
  return p;
}

// Someone dropping out can leave everyone else waiting on them, so re-check
// the "everyone is done / locked in / ready" conditions.
export function setConnected(g, id, connected, now = Date.now(), rng = Math.random) {
  if (!g.players[id]) return;
  g.players[id].connected = connected;
  if (connected) return;
  const online = connectedIds(g);
  if (!online.length) return;
  const r = g.round;
  if (g.phase === "writing" && online.every((pid) => g.writingDone[pid])) finishWriting(g, now, rng);
  else if (g.phase === "verdict" && teamMembers(g, r.guessers).some((m) => m.connected && r.locked[m.id]) &&
    teamMembers(g, r.guessers).filter((m) => m.connected).every((m) => r.locked[m.id])) resolveVerdict(g, now, rng);
  else if (g.phase === "reveal" && online.every((pid) => r.ready[pid])) nextRound(g, now, rng);
}

function setPhase(g, phase, now) {
  g.phase = phase;
  g.message = null;
  const key = phase === "writing" ? "writeSecs" : TIMED[phase];
  g.deadline = key ? now + g.settings[key] * 1000 : null;
}

function randomizeTeams(g, rng) {
  shuffle(g.order, rng).forEach((id, i) => (g.players[id].team = i % 3));
}

function placeUnassigned(g, rng) {
  for (const id of shuffle(g.order, rng)) {
    const p = g.players[id];
    if (p.team !== null) continue;
    const sizes = [0, 1, 2].map((t) => teamMembers(g, t).length);
    p.team = sizes.indexOf(Math.min(...sizes));
  }
}

// Each team contributes the same even number of cards: half to the pile on
// its left, half to the pile on its right. Extra cards are left unused.
function buildPiles(g, rng) {
  const byTeam = [[], [], []];
  for (const c of Object.values(g.cards)) byTeam[c.team].push(c.id);
  let n = Math.min(...byTeam.map((cards) => cards.length));
  n -= n % 2;
  if (n < 2) return false;
  const piles = [[], [], []];
  byTeam.forEach((cards, t) => {
    const chosen = shuffle(cards, rng).slice(0, n);
    piles[t].push(...chosen.slice(0, n / 2));
    piles[(t + 2) % 3].push(...chosen.slice(n / 2));
  });
  g.piles = piles.map((p) => shuffle(p, rng));
  // Stop once about half of each pile is played; each rotation draws 2 per pile.
  g.totalRounds = 6 * Math.max(1, Math.floor(n / 4));
  return true;
}

function startRound(g, now, rng) {
  if (g.roundIndex >= g.totalRounds) return endGame(g, now);
  const roles = rolesForRound(g.roundIndex);
  const pile = g.piles[roles.pile];
  if (!pile.length) return endGame(g, now);
  const guessers = teamMembers(g, roles.guessers);
  const online = guessers.filter((p) => p.connected);
  g.round = {
    ...roles,
    cardId: pile.pop(),
    tiebreaker: (pick(online.length ? online : guessers, rng) || {}).id ?? null,
    votes: {},
    locked: {},
    ready: {},
    verdict: null,
    delta: null,
  };
  setPhase(g, "huddle", now);
}

function endGame(g, now) {
  g.round = null;
  setPhase(g, "over", now);
}

function resolveVerdict(g, now, rng) {
  const r = g.round;
  const guessers = teamMembers(g, r.guessers);
  const count = { truth: 0, lie: 0 };
  for (const p of guessers) if (r.votes[p.id]) count[r.votes[p.id]] += 1;
  let verdict = count.truth > count.lie ? "truth" : count.lie > count.truth ? "lie" : null;
  r.tieBroken = false;
  if (!verdict) {
    verdict = r.votes[r.tiebreaker] || pick(["truth", "lie"], rng);
    r.tieBroken = true;
  }
  const card = g.cards[r.cardId];
  r.verdict = verdict;
  r.isTruth = card.team === r.reader;
  r.delta = scoreRound(r.isTruth, verdict, r);
  r.delta.forEach((d, t) => (g.scores[t] += d));
  g.history.push({ round: g.roundIndex, cardId: r.cardId, reader: r.reader, isTruth: r.isTruth, verdict, delta: r.delta });
  setPhase(g, "reveal", now);
}

function nextRound(g, now, rng) {
  g.roundIndex += 1;
  startRound(g, now, rng);
}

const isHost = (g, id) => id === g.hostId;

// Applies one player's action. Returns an error string, or null on success.
export function act(g, id, a, now = Date.now(), rng = Math.random) {
  const p = g.players[id];
  if (!p || !a) return "Unknown player.";
  const r = g.round;

  switch (a.type) {
    case "setName":
      p.name = cleanText(a.name, 24) || p.name;
      return null;

    case "joinTeam":
      // Late joiners may pick a team once; everyone else is locked in after the lobby.
      if (g.phase !== "lobby" && (p.team !== null || a.team === null)) return "Teams are locked once the game starts.";
      p.team = a.team === null ? null : Math.max(0, Math.min(2, a.team | 0));
      return null;

    case "addCard": {
      if (g.phase !== "writing") return "It's not time to write.";
      if (p.team === null) return "Join a team first.";
      const text = cleanText(a.text, MAX_CARD_LENGTH);
      if (!text) return "Write something first.";
      const mine = Object.values(g.cards).filter((c) => c.authorId === id);
      if (mine.length >= MAX_CARDS_PER_PLAYER) return `That's ${MAX_CARDS_PER_PLAYER} — plenty.`;
      const card = { id: newId(), authorId: id, team: p.team, text };
      g.cards[card.id] = card;
      delete g.writingDone[id];
      return null;
    }

    case "removeCard":
      if (g.phase !== "writing") return "Too late to remove cards.";
      if (g.cards[a.id]?.authorId === id) delete g.cards[a.id];
      return null;

    case "doneWriting":
      if (g.phase !== "writing") return null;
      if (a.done) g.writingDone[id] = true;
      else delete g.writingDone[id];
      if (connectedIds(g).every((pid) => g.writingDone[pid])) return finishWriting(g, now, rng);
      return null;

    case "statementDone":
      if (g.phase !== "statement" || (p.team !== r.reader && !isHost(g, id))) return null;
      setPhase(g, "interrogation", now);
      return null;

    case "vote":
      if (g.phase !== "verdict" || p.team !== r.guessers || r.locked[id]) return null;
      if (a.choice !== "truth" && a.choice !== "lie") return null;
      r.votes[id] = a.choice;
      return null;

    case "lockIn": {
      if (g.phase !== "verdict" || p.team !== r.guessers) return null;
      if (!r.votes[id]) return "Pick Truth or Lie first.";
      r.locked[id] = true;
      const online = teamMembers(g, r.guessers).filter((m) => m.connected);
      if (online.every((m) => r.locked[m.id])) resolveVerdict(g, now, rng);
      return null;
    }

    case "ready":
      if (g.phase !== "reveal") return null;
      r.ready[id] = true;
      if (connectedIds(g).every((pid) => r.ready[pid])) nextRound(g, now, rng);
      return null;
  }

  // Everything below is host-only.
  if (!isHost(g, id)) return "Only the host can do that.";
  switch (a.type) {
    case "randomizeTeams":
      if (g.phase !== "lobby") return null;
      randomizeTeams(g, rng);
      return null;

    case "setTeamOf":
      if (g.phase !== "lobby" || !g.players[a.id]) return null;
      g.players[a.id].team = a.team === null ? null : Math.max(0, Math.min(2, a.team | 0));
      return null;

    case "removePlayer":
      if (g.phase !== "lobby" || a.id === g.hostId || !g.players[a.id]) return null;
      delete g.players[a.id];
      g.order = g.order.filter((pid) => pid !== a.id);
      return null;

    case "setting":
      if (!(a.key in DEFAULT_SETTINGS)) return null;
      g.settings[a.key] = Math.max(10, Math.min(1800, a.value | 0));
      return null;

    case "start": {
      if (g.phase !== "lobby") return null;
      placeUnassigned(g, rng);
      const sizes = [0, 1, 2].map((t) => teamMembers(g, t).length);
      if (sizes.some((s) => s === 0)) return "Each of the three teams needs at least one player.";
      g.cards = {};
      g.writingDone = {};
      setPhase(g, "writing", now);
      return null;
    }

    case "addTime":
      if (g.deadline) g.deadline += (a.secs | 0) * 1000;
      return null;

    case "endWriting":
      if (g.phase !== "writing") return null;
      return finishWriting(g, now, rng);

    case "skipCard":
      // "Already heard it": discard and draw again from the same pile.
      if (!["huddle", "statement"].includes(g.phase)) return null;
      delete g.cards[r.cardId];
      startRound(g, now, rng);
      return null;

    case "advance":
      return advance(g, now, rng);

    case "endGame":
      endGame(g, now);
      return null;

    case "newGame":
      if (g.phase !== "over") return null;
      Object.assign(g, { phase: "lobby", deadline: null, cards: {}, piles: [[], [], []], scores: [0, 0, 0], roundIndex: 0, totalRounds: 0, round: null, history: [] });
      return null;
  }
  return "Unknown action.";
}

function finishWriting(g, now, rng) {
  if (!buildPiles(g, rng)) {
    g.writingDone = {};
    g.deadline = now + 120 * 1000;
    return (g.message = "Every team needs at least 2 cards. Two more minutes!");
  }
  g.roundIndex = 0;
  startRound(g, now, rng);
  return null;
}

// Moves to the next phase early (host), or when a timer runs out (tick).
function advance(g, now, rng) {
  switch (g.phase) {
    case "writing": return finishWriting(g, now, rng);
    case "huddle": setPhase(g, "statement", now); return null;
    case "statement": setPhase(g, "interrogation", now); return null;
    case "interrogation": setPhase(g, "verdict", now); return null;
    case "verdict": resolveVerdict(g, now, rng); return null;
    case "reveal": nextRound(g, now, rng); return null;
  }
  return null;
}

// Called regularly on the host. Returns true if the state changed.
export function tick(g, now = Date.now(), rng = Math.random) {
  if (!g.deadline || now < g.deadline) return false;
  if (g.phase === "writing" || TIMED[g.phase]) {
    g.deadline = null;
    advance(g, now, rng);
    return true;
  }
  return false;
}

// What one player is allowed to see. Card text and truth only go to the
// players who would know them at the table.
export function viewFor(g, id, now = Date.now()) {
  const me = g.players[id];
  const nameOf = (pid) => g.players[pid]?.name ?? "Someone";
  const v = {
    code: g.code,
    phase: g.phase,
    me: me && { id, name: me.name, team: me.team, isHost: isHost(g, id) },
    players: g.order.map((pid) => {
      const p = g.players[pid];
      return { id: pid, name: p.name, team: p.team, connected: p.connected, isHost: isHost(g, pid) };
    }),
    scores: g.scores,
    remainingMs: g.deadline ? Math.max(0, g.deadline - now) : null,
    settings: g.settings,
    message: g.message,
  };

  if (g.phase === "writing") {
    v.myCards = Object.values(g.cards).filter((c) => c.authorId === id).map(({ id, text }) => ({ id, text }));
    v.teamCounts = [0, 1, 2].map((t) => Object.values(g.cards).filter((c) => c.team === t).length);
    v.done = !!g.writingDone[id];
    v.doneCount = connectedIds(g).filter((pid) => g.writingDone[pid]).length;
    v.onlineCount = connectedIds(g).length;
  }

  const r = g.round;
  if (r) {
    const card = g.cards[r.cardId];
    const myTeam = me?.team;
    const role = myTeam === r.reader ? "reader" : myTeam === r.guessers ? "guesser" : myTeam === r.partner ? "bystander" : "spectator";
    v.round = {
      number: g.roundIndex + 1,
      total: g.totalRounds,
      reader: r.reader,
      partner: r.partner,
      guessers: r.guessers,
      side: r.side,
      role,
      tiebreaker: r.tiebreaker && { id: r.tiebreaker, name: nameOf(r.tiebreaker) },
    };
    const isTruth = card.team === r.reader;
    if (role === "reader") {
      Object.assign(v.round, { text: card.text, isTruth, author: isTruth ? nameOf(card.authorId) : null, authorIsMe: card.authorId === id });
    }
    if (role === "bystander" && ["interrogation", "verdict"].includes(g.phase)) {
      Object.assign(v.round, { isTruth, text: card.text, author: isTruth ? null : nameOf(card.authorId), authorIsMe: card.authorId === id });
    }
    if (g.phase === "verdict" && role === "guesser") {
      v.round.votes = teamMembers(g, r.guessers).map((p) => ({ id: p.id, name: p.name, choice: r.votes[p.id] || null, locked: !!r.locked[p.id] }));
      v.round.myVote = r.votes[id] || null;
      v.round.myLocked = !!r.locked[id];
    }
    if (g.phase === "reveal") {
      Object.assign(v.round, {
        text: card.text,
        isTruth,
        author: nameOf(card.authorId),
        authorTeam: card.team,
        verdict: r.verdict,
        tieBroken: r.tieBroken,
        delta: r.delta,
        iAmReady: !!r.ready[id],
        readyCount: connectedIds(g).filter((pid) => r.ready[pid]).length,
        onlineCount: connectedIds(g).length,
      });
    }
  }

  if (g.phase === "over") {
    v.history = g.history.map((h) => ({ ...h, text: g.cards[h.cardId]?.text ?? "", author: nameOf(g.cards[h.cardId]?.authorId) }));
  }
  return v;
}
