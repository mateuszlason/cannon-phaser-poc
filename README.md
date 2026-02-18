# Cannon Blast — Architecture & Platform Reference

A proof-of-concept for an authoritative-server arcade game built with
**Colyseus + Phaser 3 + React**. This document explains the architecture,
the anti-cheat guarantees it provides, known improvement opportunities, and
a comparison against a Unity WebGL + WebRTC alternative — with a specific
focus on a mobile-first gaming platform hosting dozens of small arcade games.

---

## Table of contents

1. [Running the project](#running-the-project)
2. [Repository structure](#repository-structure)
3. [Architecture](#architecture)
4. [Determinism and fair async PvP](#determinism-and-fair-async-pvp)
5. [Anti-cheat guarantees](#anti-cheat-guarantees)
6. [Client-side prediction](#client-side-prediction)
7. [Latency simulation](#latency-simulation)
8. [Improvement opportunities](#improvement-opportunities)
9. [Comparison: this stack vs Unity WebGL + WebRTC](#comparison-this-stack-vs-unity-webgl--webrtc)
10. [Production checklist](#production-checklist)

---

## Running the project

```bash
# Terminal 1 — game server (Colyseus, port 2567)
cd server && npm run dev

# Terminal 2 — client dev server (Vite, port 5173)
npm run dev

# Open http://localhost:5173
```

To simulate realistic network latency (e.g. Spain → Warsaw, ~35ms one-way):

```bash
# Terminal 1
cd server && LATENCY_MS=35 npm run dev
```

`LATENCY_MS` is one-way delay. Round-trip = `LATENCY_MS × 2`.

---

## Repository structure

```
cannon-phaser-poc/
├── shared/src/
│   ├── constants.ts     — all tunable game values (single source of truth)
│   ├── types.ts         — GameState, RockState, LaserState, InputMessage
│   ├── simulation.ts    — GameSimulation class (pure TS, no deps)
│   └── index.ts         — barrel export
├── server/src/
│   ├── index.ts         — Colyseus Server + WebSocketTransport, port 2567
│   └── GameRoom.ts      — Room subclass; 20 Hz tick loop; input handlers
└── src/
    ├── components/
    │   └── GameCanvas.tsx   — React shell; creates Colyseus client; manages screens
    └── game/
        ├── GameScene.ts     — Phaser renderer; client-side prediction; interpolation
        ├── AudioManager.ts  — procedural Web Audio (music + SFX, no asset files)
        └── config.ts        — Phaser.Game config factory
```

---

## Architecture

### The core principle: server is the only source of truth

The server runs the entire game simulation. The client never calculates any
game state — it sends raw input and renders what the server returns. The player
cannot influence score, rock HP, cannon position, or collision results by
modifying client code, because none of those values originate on the client.

### Data flow

```
Player mouse / touch
        │
        ▼
  GameScene.ts                                  GameRoom.ts
  sendInput() ──── WebSocket ('input') ────►   applyInput()
  { pointerX, firing }                               │
                                                     ▼
                                             GameSimulation
                                             tick() at 20 Hz
                                             ┌─────────────────┐
                                             │ move cannon      │
                                             │ fire lasers      │
                                             │ spawn rocks      │
                                             │ check collisions │
                                             │ update score     │
                                             └─────────────────┘
                                                     │
                                             snapshot() → GameState
                                                     │
  GameScene.ts  ◄──── WebSocket ('state') ──── broadcast()
  onMessage('state')                           every 50 ms
  render frame
```

### What runs where

| Concern | Where | Reason |
|---|---|---|
| Cannon movement | Server | Prevents teleportation / speed cheats |
| Laser firing rate | Server | Prevents auto-fire exploits |
| Rock spawning + RNG | Server | Client cannot force easy rocks |
| Collision detection | Server | Cannot fake hits or skip damage |
| Score | Server | Never touches the client |
| Sprite rendering | Client | Pure visual, no game logic |
| Cannon visual position | Client (predicted) | Smoothness only — server corrects each tick |
| Input | Client → Server | Raw intent only; server decides outcome |

### Tick rate

The server runs at **20 Hz (50 ms per tick)**. This is a deliberate tradeoff:

- Low enough to keep bandwidth minimal on mobile (one small JSON payload per 50 ms)
- High enough that interpolation between ticks is invisible at normal play speed
- Client renders at the display's native refresh rate (60/120 Hz); Phaser
  interpolates rock and laser positions between server ticks

---

## Determinism and fair async PvP

### The multiplayer model

This game is designed for **async PvP**: two players are given the same seed
and each plays their own solo game within a time window. Their scores are
compared at the end. There is no real-time synchronisation between players —
they do not share a room, they do not see each other, and their network
conditions have zero effect on each other.

### Why determinism matters

For async score comparison to be fair, the same seed must produce **exactly the
same game** for every player. This means:

- Rock #1 always spawns at the same position, with the same HP and velocity
- Every subsequent rock, every split, every bounce follows the same sequence
- The only thing that differs between two runs is the player's own inputs

If the simulation were not deterministic, one player might face an easy rock
sequence by luck of server timing, and another might face a hard one. That
would make score comparison meaningless.

### How determinism is achieved

**1. Seeded PRNG** — all randomness (rock position, HP, velocity, angle) comes
from `xorshift32` seeded at game creation. The sequence is fixed for the seed;
no `Math.random()` is used anywhere in the simulation.

**2. Fixed tick delta** — `GameRoom` always passes the nominal `TICK_MS`
constant to `GameSimulation.tick()`, never the measured wall-clock delta.
This is the critical guarantee:

```ts
// GameRoom.ts — what we do (deterministic)
this.sim.tick(TICK_MS);           // always exactly 50 ms

// What we explicitly do NOT do (non-deterministic)
this.sim.tick(Date.now() - lastTick); // varies ±5–15 ms under load
```

If we used wall-clock deltas, a server under load would pass `58ms` on one
tick instead of `50ms`. The rock would travel further, potentially bouncing
at a slightly different position, causing the PRNG sequence to diverge from
that point forward.

**3. No `setTimeout` in the simulation** — the original code called
`setTimeout(() => endGame('DESTROYED'), 600)` inside `GameSimulation` after
a cannon hit. `setTimeout` is non-deterministic (it fires whenever the event
loop is free) and broke the "pure function" guarantee. This is replaced with
a deterministic tick counter (`GAME_OVER_DELAY_TICKS`).

**4. Wall-clock timer is display-only** — the HUD countdown (`timeLeftMs`)
shown to the player is derived from actual wall time by `GameRoom`, not from
the simulation's fixed-step counter. This keeps the timer accurate for the
player without contaminating the simulation's determinism.

### What about connection quality?

Because players do not share a real-time session, network conditions are
irrelevant to fairness:

- A player with 200ms ping experiences the same rock sequence as a player with
  5ms ping — the simulation is identical
- The score reflects skill + input precision, not connection quality
- Client-side prediction compensates for any perceived cannon lag, so even
  high-latency players see their cannon respond instantly on their own screen

---

## Anti-cheat guarantees

### What the client sends

Each input message contains exactly two values:

```ts
{ pointerX: number, firing: boolean }
```

There is nothing else to tamper with. The server handles all outcomes.

### Specific attack vectors and how they are closed

**Score manipulation** — impossible. `GameSimulation.score` lives only in
server memory. The client receives it read-only in the state snapshot and
displays it. There is no endpoint that accepts a score from the client.

**Speed hacks** — the simulation always advances by exactly `TICK_MS` per tick
(not wall-clock time). A client running at 1000 fps or 1 fps has no effect on
how fast rocks move or how many lasers fire.

**Firing rate exploits** — `SHOOT_RATE_MS = 67` is enforced in
`GameSimulation.tick()`. Even if the client sends `firing: true` on every
message, lasers only spawn when the server's accumulator exceeds 67 ms.

**Teleportation / position hacks** — `pointerX` is clamped server-side in
`applyInput()`. The cannon snaps directly to the clamped pointer position;
it cannot be placed outside `[CANNON_BOUND_LEFT, CANNON_BOUND_RIGHT]` regardless
of what the client sends.

**Rock / HP manipulation** — rocks exist only as `Rock[]` in
`GameSimulation`. The client receives display-only snapshots (`RockState`)
with no write path back to the server.

**Replay / audit** — `GameSimulation` is pure and deterministic (seeded
xorshift32 PRNG). Any session can be replayed server-side from its input log
for post-hoc review or anti-cheat analysis.

**Out-of-bounds input** — `pointerX` outside `[CANNON_BOUND_LEFT,
CANNON_BOUND_RIGHT]` is silently clamped. Malformed or missing fields on the
input message are ignored.

---

## Client-side prediction

Laser and rock positions are not predicted — they come entirely from the
server every 50 ms and are interpolated visually. Only the **cannon** is
predicted, because it is the object the player directly controls and where
input lag is most perceptible.

### Cannon prediction — direct snap

```
Client predicts:  ──────────────────────────────►  (what you see, ~0ms lag)
Server corrects:  ────────┬────────┬────────┬────►  (ground truth, every 50ms)
                         50ms    50ms    50ms
```

The cannon uses **direct snap** prediction: the client sets the cannon position
to the pointer position immediately on the same frame the input is received —
no lerp, no interpolation. The server mirrors this exactly.

```ts
// Client (GameScene.ts) — same frame as mousemove
predictedCannonX = clamp(pointerGameX, CANNON_BOUND_LEFT, CANNON_BOUND_RIGHT);

// Server (simulation.ts) — next tick after input arrives (~RTT/2 later)
cannonX = clamp(pointerX, CANNON_BOUND_LEFT, CANNON_BOUND_RIGHT);
```

When a server tick arrives, the difference between the server's authoritative
position and the predicted position is stored as `serverCorrection`. That
correction bleeds out at 20% per frame (~3 frames, ~50 ms), making any
divergence invisible.

### Input coalescing

`mousemove` fires hundreds of times per second at high DPI. Rather than
sending a WebSocket message on every event (which would flood the connection),
the client sets an `inputDirty` flag on each move and flushes exactly one
message per animation frame in `update()`. Press and release events still send
immediately for lowest possible latency on state changes.

### Rock and laser interpolation

Rocks and lasers are rendered by interpolating between the two most recent
server snapshots:

```
prevState ──────────────────────► nextState
          alpha: 0 ─────────── 1
```

`interpAlpha` advances from 0 to 1 over `tickMs` milliseconds each frame.
If a server tick arrives late, `interpAlpha` is allowed to slightly overshoot
to `1.2` — objects continue extrapolating along their last known trajectory
rather than freezing in place.

`tickMs` is not hardcoded. It is updated every tick using an exponential moving
average of actual inter-arrival times (`0.9 × old + 0.1 × measured`), so the
interpolation window adapts to the real server cadence automatically.

### Shoot-unlock prediction

The server withholds firing for the first 2 seconds (grace period). The client
mirrors this with a local `performance.now()` timer started when the game phase
first becomes `'playing'`, rather than waiting to see a laser appear in the
server state. This removes up to one full tick (50 ms) of unlock lag.

### Why prediction is safe

Prediction only affects rendered sprite positions. It has zero influence on:

- When lasers fire (server accumulator)
- Whether a laser hits a rock (server collision)
- The player's score (server only)

If a player hacked the prediction to show the cannon somewhere it isn't, they
would only be deceiving their own screen. All damage and scoring use the
server's authoritative cannon position.

---

## Latency simulation

`GameRoom.ts` reads `process.env.LATENCY_MS` at startup and wraps both
outgoing broadcasts and incoming input handlers in `setTimeout`. This
simulates realistic one-way network delay without any external tooling.

| Scenario | `LATENCY_MS` | RTT |
|---|---|---|
| Same city / cloud region | 5–10 | 10–20 ms |
| Cross-country (e.g. Warsaw → London) | 15–25 | 30–50 ms |
| Cross-continent (e.g. Spain → Warsaw) | 30–40 | 60–80 ms |
| Intercontinental (e.g. EU → US East) | 80–120 | 160–240 ms |

---

## Improvement opportunities

These are concrete, achievable improvements roughly ordered by impact. Several
are directly reusable across any game built on this platform.

### High impact — gameplay / platform

**Matchmaking service**
Colyseus has a built-in matchmaker (`joinOrCreate` with filter options). A
lightweight matchmaking layer that groups players by skill (ELO), latency
region, and game mode can be added without changing `GameSimulation`. This
is reusable across all games on the platform.

**Shared-seed simultaneous play (async PvP)**
`GameSimulation` already uses a seeded PRNG. Two players given the same seed
play an identical rock sequence. Their scores are compared at the end — no
real-time synchronisation required, RTT becomes irrelevant, and the
architecture scales to thousands of concurrent "matches" at near-zero server cost.

**Real-time PvP (same room, shared state)**
Extend `GameSimulation` to hold two cannon instances. Both players' inputs
go to the same simulation; the full state is broadcast to both. The additional
bandwidth is one extra cannon position + laser array per tick — negligible.

**Turn-based support**
Replace the `setInterval` tick with a request-driven step: the server advances
the simulation only when a player commits a move. Zero changes to
`GameSimulation.tick()` — only `GameRoom` changes. The same simulation class
supports both real-time and turn-based modes.

**Persistent leaderboard**
Hook `GameRoom.onGameOver` (already called when the simulation ends) to write
`{ userId, score, seed, timestamp }` to a database. Because the simulation is
deterministic and the score is server-authoritative, any entry can be
independently verified by replaying the input log.

### Medium impact — performance / mobile

**Delta compression**
Currently the full `GameState` is broadcast every tick as JSON (~400–800
bytes). Sending only changed fields (delta encoding) or using MessagePack
binary serialisation can cut payload size by 60–80%, which matters on
metered mobile connections and reduces server CPU for JSON serialisation.

**Adaptive tick rate**
Drop to 10 Hz during low-action phases (no rocks, no lasers) and increase to
30 Hz during intense moments. The client interpolation already handles variable
tick cadence — `tickMs` is already derived from measured inter-arrival times
on the client, so no client changes are needed; only the server broadcast
interval would change.

**Asset preloading / caching**
Phaser loads assets on first `preload()`. On a platform with many games,
a service worker can pre-cache all game assets after the first visit. Game
cold-start time drops from ~2–3 s to near-instant on repeat visits.

**Touch input improvements**
Currently using `mousedown`/`mousemove`. Add `touchstart`/`touchmove`/
`touchend` window listeners with the same coordinate conversion. Mobile
browsers fire touch events before mouse events, so touch-first handling
removes a layer of synthetic event overhead.

### Low impact — developer experience / toolchain

**Game SDK / base classes**
Extract `GameRoom`, `GameSimulation`, and `GameScene` into a shared base
package (`@platform/sdk`). Game developers extend these base classes,
implement only their own `tick()` logic, and get matchmaking, state
broadcasting, client-side prediction, and interpolation for free.

**Hot-swap rooms**
Colyseus supports graceful room handoff. When a new version of a game is
deployed, existing sessions finish on the old binary; new sessions start on
the new one. Zero downtime per game update.

**Input replay logging**
Store `{ timestamp, pointerX, firing }` for every input in Redis with a TTL.
Enables server-side replay for anti-cheat review and can power a "watch
replay" feature at no simulation cost.

---

## Comparison: this stack vs Unity WebGL + WebRTC

The target context: a mobile-first gaming platform, browser/PWA only (no
native), hosting ~20–50 small arcade games, with PvP, shared-seed, and
turn-based modes, where fast game switching and low friction matter most.

### Transport layer: WebSocket vs WebRTC

| | This stack (WebSocket) | Unity WebGL + WebRTC |
|---|---|---|
| Connection setup | ~1 round trip (HTTP upgrade) | 3–5 round trips (ICE, DTLS, SCTP) |
| Time to first game packet | ~50–100 ms | ~300–800 ms |
| Reliable ordered delivery | Yes (TCP-backed) | Requires a reliable data channel (extra config) |
| Unreliable/unordered channel | No (requires workaround) | Yes (native UDP semantics) |
| Firewall/NAT traversal | Works everywhere | Needs STUN/TURN servers; TURN adds latency and cost |
| Browser support | Universal | Universal, but TURN fallback is expensive at scale |
| Server infrastructure | One Colyseus process | Signalling server + STUN + TURN + game server |
| Ops complexity | Low | High |

**Verdict on transport:** For arcade games at 20 Hz, WebSocket is strictly
simpler and more reliable. WebRTC's unreliable channel (UDP semantics) benefits
fast-paced shooters at 60+ Hz where you want to drop stale packets. At 20 Hz
with interpolation, a dropped packet is just a missed tick — the next one
arrives in 50 ms and catches up. The added infrastructure cost and connection
latency of WebRTC is not justified for this use case.

### Rendering: Phaser (HTML5 Canvas/WebGL) vs Unity WebGL

| | Phaser 3 + Vite | Unity WebGL |
|---|---|---|
| Initial download size | ~1.5 MB gzipped (Phaser + game) | 5–25 MB (Unity runtime alone) |
| Time to interactive (cold, mobile) | 1–3 s | 10–30 s (download + Wasm compile) |
| Time to interactive (warm, cached) | <500 ms | 3–8 s (Wasm recompile is not cached by browsers) |
| Game switching (platform with 20+ games) | Fast: each game is a JS bundle loaded on demand | Slow: each game loads a separate Wasm runtime |
| Memory per game | ~50–150 MB | ~200–400 MB |
| Hot reload / iteration speed | Instant (Vite HMR) | Full recompile (~30–60 s) |
| Mobile performance (Canvas 2D) | Good for 2D arcade | Good |
| Mobile performance (WebGL) | Excellent | Excellent, but runtime overhead is higher |
| PWA / add to home screen | Trivial (Vite + manifest) | Possible but awkward |
| Shared platform UI (React shell) | Native — React wraps Phaser | Requires postMessage bridge between Unity and DOM |
| TypeScript / web toolchain | First-class | Not applicable (C#) |
| Developer onboarding (web devs) | Low friction | High friction — requires Unity knowledge |

### Game logic authority

Both approaches can run authoritative server simulation. The difference is
where game logic lives:

- **This stack:** `GameSimulation` is plain TypeScript, runs on Node.js,
  no engine dependency. The same class could run in a browser worker, a
  Cloudflare Worker, or a Deno Deploy function.
- **Unity server:** Game logic in C#, runs as a Unity headless build or
  via a separate server-side C# project. Requires maintaining two codebases
  (client build + server build) or a shared assembly, and a VM with Unity
  server runtime.

### PvP / multiplayer patterns

| Pattern | This stack | Unity + WebRTC |
|---|---|---|
| Shared-seed async PvP | First-class — simulation is a pure deterministic function of (seed, inputs); fixed-step tick guarantees identical gameplay for all players on the same seed | Possible, but requires care: Unity's physics engine is not bit-exact across versions or platforms; determinism must be enforced manually |
| Real-time same-room PvP | Extend `GameSimulation` + broadcast | Extend server logic |
| Turn-based | Replace `setInterval` with request-driven step | Same, more boilerplate |
| Spectators | Broadcast same state to N clients | Same |
| Reconnection | Colyseus built-in (`allowReconnection`) | Custom logic required |
| Replay / anti-cheat audit | Replay input log through `GameSimulation` server-side; determinism guarantees identical result | Possible if custom deterministic physics, but not out of the box |

### Summary recommendation

For a **mobile-first browser/PWA platform** running **dozens of small arcade
games** with **PvP, shared-seed, and turn-based modes**:

**Use this stack (Phaser + Colyseus + WebSocket).**

The decisive factors are:

1. **Cold-start time** — Unity WebGL cannot match a 1–2 s load time on mobile.
   Players finding an opponent and waiting 20 s for a Unity build to load will
   churn. A Phaser game is playable in under 2 s on a 4G connection.

2. **Game switching** — switching between 20+ Unity games means loading 20+
   Wasm runtimes. With Phaser, each game is a JS bundle; the platform shell
   (React) stays mounted, and only the game bundle is swapped. The Phaser
   engine itself can be shared across games as a single cached chunk.

3. **Infrastructure simplicity** — WebSocket needs one server process.
   WebRTC needs signalling, STUN, and TURN. TURN relay traffic is billed
   per GB and can become a significant cost at scale, with no gameplay benefit
   at 20 Hz tick rates.

4. **Web toolchain** — web developers can build games for this platform
   without learning Unity or C#. TypeScript, Vite, and npm are the entire
   toolchain. Iteration speed is an order of magnitude faster.

5. **PWA / mobile UX** — Phaser games in a React shell integrate naturally
   with service workers, Web App Manifest, and mobile browser APIs. Unity
   WebGL has no natural integration with any of these.

**Where Unity would win:** if games require complex 3D rendering, physics
(Havok/PhysX), or are already built in Unity by a dedicated game studio.
For a platform of small 2D arcade games made by web developers, it is the
wrong tool.

---

## Production checklist

Before deploying this architecture to production:

- [ ] **WSS/HTTPS** — put Colyseus behind nginx or Caddy with a TLS certificate;
  never expose `ws://` to the public internet
- [ ] **Authentication** — pass a signed JWT in `client.joinOrCreate('GameRoom', { token })`
  and verify it in `GameRoom.onAuth()` before allowing a join
- [ ] **Input rate limiting** — reject clients sending more than ~30 input
  messages per second in `GameRoom.onMessage('input', ...)`
- [ ] **Room guard** — add a max-duration watchdog in `GameRoom` that calls
  `this.disconnect()` if a room runs longer than `GAME_DURATION_MS + 10s`,
  preventing abandoned rooms from running indefinitely
- [ ] **Score persistence** — hook `simulation.onGameOver` to write
  `{ userId, score, seed, durationMs, inputCount }` to a database
- [ ] **Horizontal scaling** — Colyseus supports a Redis presence/driver for
  running multiple server processes behind a load balancer; rooms are
  automatically distributed across processes
- [ ] **LATENCY_MS=0** — ensure the latency simulation env var is not set in
  production (default is 0, so this is safe but worth confirming in your
  deployment config)
- [ ] **Asset CDN** — serve `/assets/*` from a CDN rather than the Vite dev
  server; add aggressive cache headers (`Cache-Control: public, max-age=31536000`)
- [ ] **Service worker** — add a Workbox service worker to pre-cache game
  bundles after first load; critical for PWA cold-start performance on mobile
