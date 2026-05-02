// ===== Constants =====
const PHASES = {
  LOBBY: "lobby",
  DECISION: "decision",
  REVEAL: "reveal",
};
const DECISION_MS = 15_000;
const MAX_PLAYERS = 8;
const GRACE_MS = 15_000; // keep a disconnected player around this long for reconnect

const SUITS = [
  { sym: "♠", color: "black" },
  { sym: "♥", color: "red" },
  { sym: "♦", color: "red" },
  { sym: "♣", color: "black" },
];
const RANKS = [
  { v: 2, label: "2" }, { v: 3, label: "3" }, { v: 4, label: "4" },
  { v: 5, label: "5" }, { v: 6, label: "6" }, { v: 7, label: "7" },
  { v: 8, label: "8" }, { v: 9, label: "9" }, { v: 10, label: "10" },
  { v: 11, label: "J" }, { v: 12, label: "Q" }, { v: 13, label: "K" },
  { v: 14, label: "A" },
];

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ ...r, suit: s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ===== Hand evaluator (5-card poker; supports best-of-N) =====
const TIER_NAMES = [
  "ハイカード", "ワンペア", "ツーペア", "スリーカード",
  "ストレート", "フラッシュ", "フルハウス", "フォーカード",
  "ストレートフラッシュ", "ロイヤルフラッシュ",
];

function evaluate5(hand) {
  const ranks = hand.map(c => c.v).sort((a, b) => b - a);
  const suitsArr = hand.map(c => c.suit.sym);
  const flush = suitsArr.every(s => s === suitsArr[0]);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const sortedCounts = Object.entries(counts)
    .map(([k, v]) => ({ rank: +k, count: v }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const countVals = sortedCounts.map(c => c.count);

  let isStraight = false;
  let straightTop = 0;
  if (countVals[0] === 1) {
    if (ranks[0] - ranks[4] === 4) {
      isStraight = true;
      straightTop = ranks[0];
    } else if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
      isStraight = true;
      straightTop = 5;
    }
  }

  let tier;
  let primary = [];
  if (flush && isStraight) {
    tier = (straightTop === 14) ? 9 : 8;
    primary = [straightTop];
  } else if (countVals[0] === 4) {
    tier = 7;
    primary = [sortedCounts[0].rank, sortedCounts[1].rank];
  } else if (countVals[0] === 3 && countVals[1] === 2) {
    tier = 6;
    primary = [sortedCounts[0].rank, sortedCounts[1].rank];
  } else if (flush) {
    tier = 5;
    primary = ranks;
  } else if (isStraight) {
    tier = 4;
    primary = [straightTop];
  } else if (countVals[0] === 3) {
    tier = 3;
    primary = [sortedCounts[0].rank, sortedCounts[1].rank, sortedCounts[2].rank];
  } else if (countVals[0] === 2 && countVals[1] === 2) {
    tier = 2;
    primary = [sortedCounts[0].rank, sortedCounts[1].rank, sortedCounts[2].rank];
  } else if (countVals[0] === 2) {
    tier = 1;
    primary = sortedCounts.map(c => c.rank);
  } else {
    tier = 0;
    primary = ranks;
  }
  return { tier, primary, name: TIER_NAMES[tier] };
}

function compareHands(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  for (let i = 0; i < Math.max(a.primary.length, b.primary.length); i++) {
    const av = a.primary[i] || 0;
    const bv = b.primary[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function combinations(arr, k) {
  const result = [];
  const n = arr.length;
  if (k > n || k < 0) return result;
  const indices = Array.from({ length: k }, (_, i) => i);
  while (true) {
    result.push(indices.map(i => arr[i]));
    let i = k - 1;
    while (i >= 0 && indices[i] === n - k + i) i--;
    if (i < 0) break;
    indices[i]++;
    for (let j = i + 1; j < k; j++) indices[j] = indices[j - 1] + 1;
  }
  return result;
}

function bestHand(cards) {
  let best = null;
  let bestCombo = null;
  for (const combo of combinations(cards, 5)) {
    const ev = evaluate5(combo);
    if (!best || compareHands(ev, best) > 0) {
      best = ev;
      bestCombo = combo;
    }
  }
  return { ...best, cards: bestCombo };
}

// ===== Worker entry =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(room)) {
        return new Response("Invalid room code", { status: 400 });
      }
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// ===== GameRoom Durable Object =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map(); // sessionId -> { ws, playerId }
    this.players = new Map(); // playerId -> { name, hole, decision, drinkCount }
    this.community = [];
    this.phase = PHASES.LOBBY;
    this.hostId = null;
    this.phaseEndAt = null;
    this.timer = null;
    this.lastResult = null;
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 20);
    const clientId = (url.searchParams.get("clientId") || "").trim();
    if (!name) return new Response("Missing name", { status: 400 });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) {
      return new Response("Missing or invalid clientId", { status: 400 });
    }

    const existing = this.players.get(clientId);

    if (existing) {
      // Reconnect / takeover: kick any prior socket for this clientId
      // and reuse the existing seat (preserves cards, decision, drinkCount).
      const prior = this.sessions.get(clientId);
      if (prior) {
        try { prior.ws.close(4002, "Replaced by new connection"); } catch {}
        this.sessions.delete(clientId);
      }
      // Reconnected in time — cancel the pending grace removal
      if (existing.removeTimer) {
        clearTimeout(existing.removeTimer);
        existing.removeTimer = null;
      }
      // Allow renaming on reconnect
      existing.name = name;
    } else {
      // Brand-new participant — apply join restrictions
      if (this.players.size >= MAX_PLAYERS && this.phase === PHASES.LOBBY) {
        return new Response("Room full", { status: 403 });
      }
      if (this.phase !== PHASES.LOBBY) {
        return new Response("Game in progress", { status: 423 });
      }
      this.players.set(clientId, {
        name,
        hole: null,
        decision: null,
        drinkCount: 0,
        removeTimer: null,
      });
      if (!this.hostId) this.hostId = clientId;
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    this.sessions.set(clientId, { ws: server, playerId: clientId });

    server.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      await this.handleMessage(clientId, msg);
    });
    const onClose = () => {
      // Ignore close events from sockets that were already replaced by a newer
      // connection for the same clientId.
      const sess = this.sessions.get(clientId);
      if (sess && sess.ws === server) {
        this.handleDisconnect(clientId);
      }
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(playerId, msg) {
    switch (msg.type) {
      case "start":
        if (playerId === this.hostId && this.phase === PHASES.LOBBY) {
          if (this.players.size < 2) return;
          this.startDecision();
        }
        break;
      case "decision":
        if (this.phase === PHASES.DECISION && (msg.choice === "fight" || msg.choice === "fold")) {
          const p = this.players.get(playerId);
          if (p && !p.decision) {
            p.decision = msg.choice;
            this.broadcast();
            if ([...this.players.values()].every(pl => pl.decision)) {
              this.endDecision();
            }
          }
        }
        break;
      case "next":
        if (playerId === this.hostId && this.phase === PHASES.REVEAL) {
          this.resetToLobby();
        }
        break;
    }
  }

  handleDisconnect(playerId) {
    this.sessions.delete(playerId);
    const player = this.players.get(playerId);
    if (!player) return;

    // In LOBBY, drop immediately — no game state worth preserving
    if (this.phase === PHASES.LOBBY) {
      this.removePlayer(playerId);
      this.broadcast();
      return;
    }

    // In active game, hold the seat for GRACE_MS so the client can reconnect
    if (player.removeTimer) clearTimeout(player.removeTimer);
    player.removeTimer = setTimeout(() => {
      player.removeTimer = null;
      this.removePlayer(playerId);
      if (this.players.size === 0) {
        this.clearTimer();
        this.phase = PHASES.LOBBY;
        this.lastResult = null;
        return;
      }
      if (this.players.size < 2 && this.phase !== PHASES.LOBBY) {
        this.resetToLobby();
        return;
      }
      if (this.phase === PHASES.DECISION
          && [...this.players.values()].every(pl => pl.decision)) {
        this.endDecision();
        return;
      }
      this.broadcast();
    }, GRACE_MS);
    this.broadcast();
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    if (this.hostId === playerId) {
      this.hostId = this.players.keys().next().value || null;
    }
  }

  startDecision() {
    this.phase = PHASES.DECISION;
    this.phaseEndAt = Date.now() + DECISION_MS;
    this.lastResult = null;
    const deck = buildDeck();
    for (const p of this.players.values()) {
      p.hole = [deck.pop(), deck.pop()];
      p.decision = null;
    }
    this.community = [];
    for (let i = 0; i < 7; i++) this.community.push(deck.pop());
    this.clearTimer();
    this.timer = setTimeout(() => this.timeoutDecision(), DECISION_MS);
    this.broadcast();
  }

  timeoutDecision() {
    // Anyone who didn't decide in time is auto-folded
    for (const p of this.players.values()) {
      if (!p.decision) p.decision = "fold";
    }
    this.endDecision();
  }

  endDecision() {
    this.phase = PHASES.REVEAL;
    this.phaseEndAt = null;
    this.clearTimer();

    // compute best hand for every player (for "would have won" detection)
    const handsById = {};
    for (const [id, p] of this.players) {
      handsById[id] = bestHand([...p.hole, ...this.community]);
    }

    const fighters = [...this.players.entries()].filter(([, p]) => p.decision === "fight");
    const folders = [...this.players.entries()].filter(([, p]) => p.decision === "fold");
    const fightCount = fighters.length;

    let winners = [];
    let losers = [];
    const drinks = {};

    if (fighters.length > 0) {
      // Find best (winners) and worst (losers) hand among fighters
      let bestRef = handsById[fighters[0][0]];
      let worstRef = handsById[fighters[0][0]];
      for (const [id] of fighters) {
        const h = handsById[id];
        if (compareHands(h, bestRef) > 0) bestRef = h;
        if (compareHands(h, worstRef) < 0) worstRef = h;
      }
      winners = fighters
        .filter(([id]) => compareHands(handsById[id], bestRef) === 0)
        .map(([id]) => id);
      losers = fighters
        .filter(([id]) => compareHands(handsById[id], worstRef) === 0)
        .map(([id]) => id);

      // Avoid winner/loser overlap (everyone tied → no losers)
      const winnerSet = new Set(winners);
      const realLosers = losers.filter(id => !winnerSet.has(id));

      const loserSet = new Set(realLosers);
      for (const [id, p] of fighters) {
        if (loserSet.has(id)) {
          drinks[id] = fightCount;
          p.drinkCount += fightCount;
        } else {
          drinks[id] = 0;
        }
      }
      for (const [id, p] of folders) {
        drinks[id] = 1;
        p.drinkCount += 1;
      }
      losers = realLosers;
    } else {
      // All folded — everyone drinks 1
      for (const [id, p] of folders) {
        drinks[id] = 1;
        p.drinkCount += 1;
      }
    }

    this.lastResult = {
      community: this.community,
      hands: Object.fromEntries(
        [...this.players.entries()].map(([id, p]) => [id, p.hole])
      ),
      bestHands: Object.fromEntries(
        Object.entries(handsById).map(([id, h]) => [id, {
          tier: h.tier,
          name: h.name,
          cards: h.cards,
        }])
      ),
      fighters: fighters.map(([id]) => id),
      folders: folders.map(([id]) => id),
      winners,
      losers,
      drinks,
      fightCount,
    };
    this.broadcast();
  }

  resetToLobby() {
    this.phase = PHASES.LOBBY;
    this.phaseEndAt = null;
    this.clearTimer();
    this.community = [];
    for (const p of this.players.values()) {
      p.hole = null;
      p.decision = null;
    }
    this.lastResult = null;
    this.broadcast();
  }

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  broadcast() {
    for (const [, session] of this.sessions) {
      try {
        const msg = this.viewForPlayer(session.playerId);
        session.ws.send(JSON.stringify(msg));
      } catch (e) {
        // ignore broken sockets
      }
    }
  }

  viewForPlayer(playerId) {
    const me = this.players.get(playerId);
    const players = [...this.players.entries()].map(([id, p]) => {
      const isYou = id === playerId;
      // Other players' hole cards stay hidden until REVEAL.
      let hole = null;
      if (this.phase === PHASES.REVEAL) hole = p.hole;
      return {
        id,
        name: p.name,
        drinkCount: p.drinkCount,
        decision: this.phase === PHASES.REVEAL ? p.decision : null,
        decided: !!p.decision,
        hole,
        isYou,
      };
    });
    const showCommunity = this.phase === PHASES.DECISION
      || this.phase === PHASES.REVEAL;
    return {
      type: "state",
      state: {
        phase: this.phase,
        players,
        hostId: this.hostId,
        you: playerId,
        phaseEndAt: this.phaseEndAt,
        community: showCommunity ? this.community : [],
        // YOUR own hole cards visible during DECISION (and remain visible at REVEAL)
        myHole: (this.phase === PHASES.DECISION && me) ? me.hole : null,
        result: this.phase === PHASES.REVEAL ? this.lastResult : null,
      },
    };
  }
}
