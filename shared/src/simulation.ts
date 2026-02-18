// ─── GameSimulation ───────────────────────────────────────────────────────────
// Pure deterministic game loop. No Phaser, no Node, no I/O — not even
// setTimeout. The server creates one instance per room and calls tick() at
// TICK_RATE_HZ, always passing the nominal TICK_MS as delta.
//
// DETERMINISM GUARANTEE
// ---------------------
// Because tick() always receives TICK_MS (not a measured wall-clock delta),
// the simulation is a pure function of (seed, inputLog). Two players given
// the same seed will experience identical rock sequences, spawn positions,
// velocities, and collision outcomes — regardless of when they play or what
// load the server is under at the time. This is the foundation of fair
// async PvP score comparison.

import {
  GAME_WIDTH,
  GAME_HEIGHT,
  CANNON_Y,
  CANNON_BOUND_LEFT,
  CANNON_BOUND_RIGHT,
  SHOOT_DELAY_MS,
  SHOOT_RATE_MS,
  LASER_SPEED,
  ROCK_SPAWN_DELAY_MS,
  ROCK_SPAWN_INTERVAL_MS,
  ROCK_SPEED_MIN,
  ROCK_SPEED_MAX,
  SPLIT_THRESHOLD,
  ROCK_SCALE_MIN,
  ROCK_SCALE_MAX,
  ROCK_HP_MIN,
  ROCK_HP_MAX,
  ROCK_SOURCE_SIZE,
  ROCK_MAX_BOUNCES,
  LASER_ROCK_HIT_FRAC,
  CANNON_HIT_RADIUS,
  ROCK_CANNON_HIT_FRAC,
  GAME_DURATION_MS,
  TICK_MS,
} from './constants';

import type { GameState, GameOverReason, LaserState, RockState } from './types';

// ─── Internal entity types (server-only, not sent over wire) ─────────────────

interface Laser {
  id: number;
  x: number;
  y: number;
}

interface Rock {
  id: number;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  displaySize: number;
  bounces: number;
  escaping: boolean;      // flagged after ROCK_MAX_BOUNCES
  escapeTimer: number;    // ticks until auto-remove when escaping
}

// ─── Seeded PRNG (xorshift32) — deterministic randomness ─────────────────────

function createRng(seed: number) {
  let s = seed >>> 0 || 0xdeadbeef;
  return {
    next(): number {
      s ^= s << 13; s ^= s >> 17; s ^= s << 5;
      return (s >>> 0) / 0xffffffff;
    },
    between(lo: number, hi: number): number {
      return Math.floor(this.next() * (hi - lo + 1)) + lo;
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function hpToDisplaySize(hp: number): number {
  const t = (clamp(hp, ROCK_HP_MIN, ROCK_HP_MAX) - ROCK_HP_MIN) / (ROCK_HP_MAX - ROCK_HP_MIN);
  const scale = ROCK_SCALE_MIN + t * (ROCK_SCALE_MAX - ROCK_SCALE_MIN);
  return Math.round(scale * ROCK_SOURCE_SIZE);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// How many ticks the game-over is delayed after cannon is destroyed, so the
// client has time to animate the explosion before the game-over screen appears.
// This is deterministic: no setTimeout, just a counter.
const GAME_OVER_DELAY_TICKS = Math.ceil(600 / TICK_MS); // ~12 ticks @ 20 Hz

// ─── Simulation ───────────────────────────────────────────────────────────────

export class GameSimulation {
  // entities
  private lasers: Laser[] = [];
  private rocks: Rock[] = [];
  private nextId = 1;

  // cannon
  private cannonX: number = GAME_WIDTH / 2;
  private cannonAlive = true;

  // input (last received from client)
  private pointerX: number = GAME_WIDTH / 2;
  private firing = false;

  // timers — all in tick counts or ms accumulators fed by fixed TICK_MS steps
  private shootAccum = 0;
  private rockSpawnAccum = 0;
  // elapsedMs is always tickCount × TICK_MS — never uses wall-clock delta
  private elapsedMs = 0;

  // state
  private phase: 'waiting' | 'playing' | 'gameover' = 'waiting';
  private score = 0;
  private gameOverReason?: GameOverReason;
  private shootUnlocked = false;
  private rockSpawnUnlocked = false;

  // game-over delay: counts down in ticks after cannon is destroyed
  private gameOverCountdown = 0;

  private rng = createRng(Date.now());

  // callbacks so the room can react to events
  onGameOver?: (reason: GameOverReason, score: number) => void;

  // ── Public API ──────────────────────────────────────────────────────────────

  start() {
    this.phase = 'playing';
    this.elapsedMs = 0;
  }

  applyInput(input: { pointerX: number; firing: boolean }) {
    this.pointerX = clamp(input.pointerX, CANNON_BOUND_LEFT, CANNON_BOUND_RIGHT);
    this.firing = input.firing;
  }

  /**
   * Advance the simulation by one fixed step.
   * Always call with TICK_MS — do NOT pass a measured wall-clock delta.
   * Keeping the step fixed is what makes the simulation deterministic.
   */
  tick(deltaMs: number) {
    if (this.phase !== 'playing') return;

    this.elapsedMs += deltaMs;

    // ── Pending game-over countdown (after cannon destroyed) ───────────────
    if (this.gameOverCountdown > 0) {
      this.gameOverCountdown--;
      if (this.gameOverCountdown === 0) {
        this.endGame('DESTROYED');
      }
      // Still tick rocks for visual continuity during the countdown
      this.moveRocks(deltaMs);
      return;
    }

    // ── Unlock phases ──────────────────────────────────────────────────────
    if (!this.shootUnlocked && this.elapsedMs >= SHOOT_DELAY_MS) {
      this.shootUnlocked = true;
      this.shootAccum = SHOOT_RATE_MS; // fire immediately on first tick
    }
    if (!this.rockSpawnUnlocked && this.elapsedMs >= ROCK_SPAWN_DELAY_MS) {
      this.rockSpawnUnlocked = true;
      this.rockSpawnAccum = ROCK_SPAWN_INTERVAL_MS;
    }

    if (!this.cannonAlive) {
      // Still tick rocks/lasers for visual continuity, but skip input/shoot
      this.moveRocks(deltaMs);
      return;
    }

    // ── Cannon follows pointer (only while firing) ─────────────────────────
    // Direct snap: no lerp. Client-side prediction is instant too, so the
    // cannon tracks the pointer with zero perceivable lag regardless of tick rate.
    if (this.firing && this.shootUnlocked) {
      this.cannonX = clamp(this.pointerX, CANNON_BOUND_LEFT, CANNON_BOUND_RIGHT);
    }

    // ── Shooting ──────────────────────────────────────────────────────────
    if (this.shootUnlocked && this.firing) {
      this.shootAccum += deltaMs;
      while (this.shootAccum >= SHOOT_RATE_MS) {
        this.shootAccum -= SHOOT_RATE_MS;
        this.spawnLaser();
      }
    } else {
      this.shootAccum = 0;
    }

    // ── Rock spawning ─────────────────────────────────────────────────────
    if (this.rockSpawnUnlocked) {
      this.rockSpawnAccum += deltaMs;
      while (this.rockSpawnAccum >= ROCK_SPAWN_INTERVAL_MS) {
        this.rockSpawnAccum -= ROCK_SPAWN_INTERVAL_MS;
        this.spawnRock();
      }
    }

    // ── Move everything ───────────────────────────────────────────────────
    this.moveLasers(deltaMs);
    this.moveRocks(deltaMs);

    // ── Collisions ────────────────────────────────────────────────────────
    this.checkLaserRockCollisions();
    this.checkRockCannonCollision();

    // ── Timer ─────────────────────────────────────────────────────────────
    if (this.elapsedMs >= GAME_DURATION_MS) {
      this.endGame('TIME');
    }
  }

  snapshot(): GameState {
    return {
      phase: this.phase,
      cannonX: this.cannonX,
      cannonAlive: this.cannonAlive,
      lasers: this.lasers.map<LaserState>((l) => ({ id: l.id, x: l.x, y: l.y })),
      rocks: this.rocks.map<RockState>((r) => ({
        id: r.id,
        x: r.x,
        y: r.y,
        angle: r.angle,
        hp: r.hp,
        maxHp: r.maxHp,
        displaySize: r.displaySize,
      })),
      score: this.score,
      // timeLeftMs from fixed step count — accurate for determinism.
      // GameRoom overrides this with wall-clock time for the HUD display.
      timeLeftMs: Math.max(0, GAME_DURATION_MS - this.elapsedMs),
      gameOverReason: this.gameOverReason,
    };
  }

  /**
   * Returns the wall-clock-accurate time remaining given how many real
   * milliseconds have elapsed since start(). Used by GameRoom to override
   * the HUD timer so it shows accurate real-world countdown despite fixed steps.
   */
  wallTimeLeft(wallElapsedMs: number): number {
    return Math.max(0, GAME_DURATION_MS - wallElapsedMs);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private spawnLaser() {
    this.lasers.push({
      id: this.nextId++,
      x: this.cannonX,
      y: CANNON_Y - 55,
    });
  }

  private spawnRock(hp?: number, x?: number, y?: number) {
    const resolvedHp = hp ?? this.weightedHp();
    const displaySize = hpToDisplaySize(resolvedHp);
    const spawnX = x ?? this.rng.between(40, GAME_WIDTH - 40);
    const spawnY = y ?? -displaySize / 2;

    const angleDeg = this.rng.between(-70, 70);
    const rad = (angleDeg * Math.PI) / 180;
    const speed = this.rng.between(ROCK_SPEED_MIN, ROCK_SPEED_MAX);

    this.rocks.push({
      id: this.nextId++,
      x: spawnX,
      y: spawnY,
      angle: 0,
      vx: Math.sin(rad) * speed,
      vy: Math.cos(rad) * speed,
      hp: resolvedHp,
      maxHp: resolvedHp,
      displaySize,
      bounces: 0,
      escaping: false,
      escapeTimer: 0,
    });
  }

  private weightedHp(): number {
    const roll = this.rng.next();
    if (roll < 0.60) return this.rng.between(1, 15);
    if (roll < 0.85) return this.rng.between(16, 30);
    return this.rng.between(31, ROCK_HP_MAX);
  }

  private moveLasers(deltaMs: number) {
    const dy = (LASER_SPEED * deltaMs) / 1000;
    this.lasers = this.lasers.filter((l) => {
      l.y -= dy;
      return l.y > -20;
    });
  }

  private moveRocks(deltaMs: number) {
    const dt = deltaMs / 1000;
    const toRemove = new Set<number>();

    for (const rock of this.rocks) {
      if (rock.escaping) {
        rock.escapeTimer -= deltaMs;
        if (rock.escapeTimer <= 0) {
          toRemove.add(rock.id);
          continue;
        }
      }

      rock.x += rock.vx * dt;
      rock.y += rock.vy * dt;
      rock.angle += 60 * dt * (rock.vx > 0 ? 1 : -1);

      const radius = (rock.displaySize / 2) * 0.85;

      if (rock.x - radius < 0) { rock.x = radius; rock.vx = Math.abs(rock.vx); }
      else if (rock.x + radius > GAME_WIDTH) { rock.x = GAME_WIDTH - radius; rock.vx = -Math.abs(rock.vx); }

      if (rock.y - radius < 0) {
        rock.y = radius; rock.vy = Math.abs(rock.vy); rock.bounces++;
      } else if (rock.y + radius > GAME_HEIGHT) {
        rock.y = GAME_HEIGHT - radius; rock.vy = -Math.abs(rock.vy); rock.bounces++;
      }

      if (!rock.escaping && rock.bounces >= ROCK_MAX_BOUNCES) {
        rock.escaping = true;
        rock.escapeTimer = 1500;
        rock.vy = -Math.abs(rock.vy) * 1.5;
      }
    }

    this.rocks = this.rocks.filter((r) => !toRemove.has(r.id));
  }

  private checkLaserRockCollisions() {
    const deadLasers = new Set<number>();
    const deadRocks = new Set<number>();

    for (const laser of this.lasers) {
      if (deadLasers.has(laser.id)) continue;
      for (const rock of this.rocks) {
        if (deadRocks.has(rock.id)) continue;
        const hitRadius = (rock.displaySize / 2) * LASER_ROCK_HIT_FRAC;
        if (dist2(laser.x, laser.y, rock.x, rock.y) < hitRadius) {
          deadLasers.add(laser.id);
          rock.hp--;
          if (rock.hp <= 0) {
            this.score += rock.maxHp;
            deadRocks.add(rock.id);
            if (rock.maxHp > SPLIT_THRESHOLD) {
              const half = Math.max(1, Math.floor(rock.maxHp / 2));
              this.spawnRock(half, rock.x - 30, rock.y);
              this.spawnRock(half, rock.x + 30, rock.y);
            }
          }
          break;
        }
      }
    }

    this.lasers = this.lasers.filter((l) => !deadLasers.has(l.id));
    this.rocks = this.rocks.filter((r) => !deadRocks.has(r.id));
  }

  private checkRockCannonCollision() {
    for (const rock of this.rocks) {
      const hitRadius = (rock.displaySize / 2) * ROCK_CANNON_HIT_FRAC + CANNON_HIT_RADIUS;
      if (dist2(rock.x, rock.y, this.cannonX, CANNON_Y) < hitRadius) {
        this.cannonAlive = false;
        // Start the deterministic countdown — no setTimeout, just a tick counter.
        // The game-over phase is set after GAME_OVER_DELAY_TICKS ticks so the
        // client has time to play the explosion animation.
        this.gameOverCountdown = GAME_OVER_DELAY_TICKS;
        return;
      }
    }
  }

  private endGame(reason: GameOverReason) {
    if (this.phase === 'gameover') return;
    this.phase = 'gameover';
    this.gameOverReason = reason;
    this.firing = false;
    this.onGameOver?.(reason, this.score);
  }
}
