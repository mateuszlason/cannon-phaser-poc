# AGENTS.md — Cannon Phaser POC

Coding-agent reference for this repository. Read before making changes.

---

## Project Overview

A monorepo: authoritative Colyseus game server + React + Phaser 3 client.

- **Server** (`server/`) runs the full game simulation at 20 Hz and broadcasts
  `GameState` JSON to the client each tick.
- **Client** (`src/`) is a pure renderer: Phaser interpolates between server
  ticks; React owns the shell (start/game-over screens).
- **Shared** (`shared/`) contains all pure-TypeScript game logic: constants,
  types, and the `GameSimulation` class — no Phaser or Node deps.
- React → Server: `GameCanvas` creates a Colyseus `Client`, joins `GameRoom`,
  injects `room` into `GameScene`, then sends `'start'`.
- Server → Client: room broadcasts `'state'` (full `GameState`) every 50 ms.
- Client → Server: `GameScene` sends `'input'` (`InputMessage`) on pointer events.
- Scene → React: `scene.events.emit('gameOver', payload)` triggers state change.

**Stack:** Vite · React 19 · TypeScript (strict) · Phaser 3 · Colyseus 0.16 · CSS Modules

**Version note:** Server uses `colyseus@0.16.5` and client uses `colyseus.js@0.16.22`.
These must stay on the same major/minor version — the wire protocol is not
compatible across 0.16 ↔ 0.17.

---

## Commands

```bash
# ── Client (root) ──────────────────────────────────────────────────────────

# Development server (hot reload) — requires server running separately
npm run dev

# Production build (runs tsc + vite build)
npm run build

# Type-check only (no emit)
npx tsc --noEmit

# Preview production build locally
npm run preview

# Lint
npm run lint

# ── Server ─────────────────────────────────────────────────────────────────

# Dev server with hot reload (from server/)
cd server && npm run dev

# ── Run both together ──────────────────────────────────────────────────────
# Terminal 1:  cd server && npm run dev
# Terminal 2:  npm run dev   (from root)
# Then open:   http://localhost:5173
```

No test suite exists yet. When adding tests, prefer Vitest (already compatible
with the Vite setup).

---

## Directory Structure

```
cannon-phaser-poc/
├── public/
│   └── assets/          # Static game sprites (served at /assets/*)
│       ├── background.png
│       ├── cannon.png
│       ├── laser.png
│       └── rock.png
├── shared/
│   ├── package.json     # @cannon/shared (no deps)
│   └── src/
│       ├── constants.ts # ALL tunable game values — edit here first
│       ├── types.ts     # GameState, RockState, LaserState, InputMessage
│       ├── simulation.ts # GameSimulation class (authoritative server logic)
│       └── index.ts     # barrel export
├── server/
│   ├── package.json     # @cannon/server, colyseus 0.16, tsx
│   ├── tsconfig.json    # includes ../shared/src
│   └── src/
│       ├── index.ts     # Server + WebSocketTransport + define('GameRoom') + listen(2567)
│       └── GameRoom.ts  # Colyseus Room; 20 Hz tick; input/start message handlers
├── src/
│   ├── main.tsx         # ReactDOM.createRoot (no StrictMode)
│   ├── App.tsx          # renders <GameCanvas />
│   ├── index.css        # global reset
│   ├── components/
│   │   ├── GameCanvas.tsx        # Creates Colyseus Client, joins GameRoom,
│   │   │                         # injects room into GameScene, handles screens
│   │   └── GameCanvas.module.css # overlay UI styles
│   └── game/
│       ├── config.ts        # Phaser.Game config factory (imports from shared)
│       ├── GameScene.ts     # Renderer-only Phaser scene; interpolates server ticks
│       ├── AudioManager.ts  # Procedural Web Audio (music + laser + explosion SFX)
│       └── constants.ts     # LEGACY — kept for reference but superseded by shared/
├── package.json         # root client — react, phaser, colyseus.js 0.16, vite
├── tsconfig.app.json    # includes both src/ and ../shared/src
└── vite.config.ts       # @shared alias → ../shared/src
```

---

## Architecture Rules

1. **All game constants live in `shared/src/constants.ts`.** Never hardcode
   magic numbers anywhere; always import from constants.
   `src/game/constants.ts` is legacy — do not add new values there.

2. **Server is authoritative.** All game logic (movement, spawning, collisions,
   scoring, timers) runs in `GameSimulation` on the server. The client
   only renders what the server tells it.

3. **Phaser scene is a pure renderer.** `GameScene` holds no game state; it only
   maintains sprite maps and interpolates between `prevState` / `nextState`.

4. **Room injection pattern.** `GameCanvas` sets `scene.room` on the `GameScene`
   instance *before* `create()` fires (via `game.events.once('ready', ...)`).
   `GameScene.create()` subscribes to `room.onMessage('state', ...)` using this
   injected room reference.

5. **Phaser → React communication uses `scene.events.emit`.** React listens via
   `game.events.once('ready', ...)` then attaches to scene events.
   Do not import React hooks inside Phaser scenes.

6. **React → Phaser communication:** Restart by destroying and recreating the
   `Phaser.Game` instance. Do not call Phaser APIs from React render functions.

7. **No `React.StrictMode`** — double-mount breaks Phaser canvas lifecycle.

8. **No Phaser Arcade physics.** All object movement is manual (server-side).
   `GameScene` does not use physics bodies.

---

## Code Style

### TypeScript
- Strict mode is on (`tsconfig.json`). No `any`; use `unknown` and narrow.
- Prefer `interface` for object shapes used as data (e.g. `RockState`).
- Use `type` for union aliases (e.g. `type Screen = 'start' | 'playing' | 'gameover'`).
- All function parameters and return types must be explicitly typed except
  where inference is unambiguous (e.g. trivial arrow callbacks).
- Use `private` on all class fields that are not part of the public API.

### Naming
| Entity              | Convention        | Example                  |
|---------------------|-------------------|--------------------------|
| React components    | PascalCase        | `GameCanvas`             |
| Phaser scenes       | PascalCase        | `GameScene`              |
| Constants           | SCREAMING_SNAKE   | `CANNON_SPEED`           |
| Private class field | camelCase         | `this.shootTimer`        |
| CSS module class    | camelCase         | `styles.scoreValue`      |
| Asset keys          | lowercase-kebab   | `'rock'`, `'background'` |
| Colyseus messages   | lowercase         | `'state'`, `'input'`, `'start'` |

### Imports
- Order: external packages → internal absolute → relative. Blank line between groups.
- Import Phaser types explicitly: `import Phaser from 'phaser'`.
- Import shared types from `../../shared/src/...` (relative) — do NOT use the
  `@shared` alias inside `src/` (it exists for the bundler but not tsc's rootDir).
- CSS modules: `import styles from './Foo.module.css'`.
- No barrel `index.ts` files unless the directory has 4+ exports.

### Formatting
- 2-space indentation, single quotes, trailing commas (ES5 default from Vite).
- Max line length: ~100 chars (not enforced by linter, but keep readable).
- Use `// ── Section ─────` comment dividers inside large files (see GameScene).

### Error Handling
- In Phaser scene lifecycle methods (`preload`, `create`, `update`): let errors
  bubble — Phaser will log them. Do not silently swallow.
- In React event handlers: wrap async operations in try/catch; surface errors
  to the user via state (see `connectError` in `GameCanvas`).

---

## Game Logic Reference

All logic lives in `shared/src/simulation.ts` (`GameSimulation` class).

| Mechanic             | Location in `GameSimulation`         |
|----------------------|--------------------------------------|
| Cannon movement      | `tick()` — lerps toward `pointerX`   |
| Shooting             | `tick()` → `spawnLaser()`            |
| Rock spawn           | `tick()` → `spawnRock()`             |
| Weighted HP roll     | `weightedHp()`                       |
| HP → visual size     | `hpToDisplaySize()` (module-level)   |
| Rock movement/bounce | `moveRocks()`                        |
| Laser-rock collision | `checkLaserRockCollisions()`         |
| Cannon-rock collision| `checkRockCannonCollision()`         |
| Splitting            | inside `checkLaserRockCollisions()`  |
| End game             | `endGame()` sets `phase = 'gameover'`|

**Split rule:** rocks with `maxHp > 30` (SPLIT_THRESHOLD) split into two
children each with `floor(maxHp / 2)` HP, spawned ±30 px from parent.
Children do not re-split (they inherit a lower maxHp).

**Bounce rule:** Each top or bottom wall collision increments `rock.bounces`.
After `ROCK_MAX_BOUNCES` (3) bounces the rock is flagged `escaping = true`,
velocity reversed upward ×1.5, and auto-removed after 1.5 s.

**Controls:** Hold left mouse button (or touch) to move cannon to pointer X
and fire. Release to stop both. Cannon only moves while firing is active and
`shootUnlocked` (after 2 s grace period).

---

## Asset Guidelines

- All sprites are loaded via `this.load.image(key, '/assets/filename.png')` in
  `GameScene.preload()`.
- Background is `1080×1920` (portrait). Game canvas is `480×854` (same ratio).
- Do not resize or re-export assets without updating `setDisplaySize()` calls
  in `GameScene.create()`.

---

## Adding New Features

1. Add constants to `shared/src/constants.ts` first.
2. If the feature changes game state, add fields to the relevant interface in
   `shared/src/types.ts` and update `GameSimulation.snapshot()`.
3. Implement server logic in `GameSimulation` (`shared/src/simulation.ts`) as
   private methods called from `tick()`.
4. Update `GameScene.ts` to render the new state (add sprites, animations, etc.).
5. If the feature needs React UI (HUD element, overlay), emit a Phaser event
   and handle it in `GameCanvas.tsx` via state — no DOM manipulation in scenes.
6. Run `npm run build` (from root) to confirm zero TypeScript errors.
