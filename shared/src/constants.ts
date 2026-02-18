// ─── Game dimensions ──────────────────────────────────────────────────────────
export const GAME_WIDTH = 480;
export const GAME_HEIGHT = 854;

// ─── Cannon ───────────────────────────────────────────────────────────────────
export const CANNON_Y = GAME_HEIGHT - 80;   // fixed Y (centre of sprite)
export const CANNON_WIDTH = 90;
export const LAND_LEFT = 10;
export const LAND_RIGHT = GAME_WIDTH - 10;
export const CANNON_BOUND_LEFT = LAND_LEFT + CANNON_WIDTH / 2;
export const CANNON_BOUND_RIGHT = LAND_RIGHT - CANNON_WIDTH / 2;

// ─── Shooting ─────────────────────────────────────────────────────────────────
export const SHOOT_DELAY_MS = 2000;   // grace period before firing unlocks
export const SHOOT_RATE_MS = 67;      // ~15/sec
export const LASER_SPEED = 700;       // px/sec upward

// ─── Rocks ────────────────────────────────────────────────────────────────────
export const ROCK_SPAWN_DELAY_MS = 2000;
export const ROCK_SPAWN_INTERVAL_MS = 1200;
export const ROCK_SPEED_MIN = 180;
export const ROCK_SPEED_MAX = 340;
export const SPLIT_THRESHOLD = 30;
export const ROCK_SCALE_MIN = 0.08;
export const ROCK_SCALE_MAX = 0.26;
export const ROCK_HP_MIN = 1;
export const ROCK_HP_MAX = 50;
export const ROCK_SOURCE_SIZE = 521;  // source image width/height in px
export const ROCK_MAX_BOUNCES = 3;

// ─── Collision radii (fraction of displayWidth/2) ────────────────────────────
export const LASER_ROCK_HIT_FRAC = 0.80;
export const CANNON_HIT_RADIUS = 36;
export const ROCK_CANNON_HIT_FRAC = 0.75;

// ─── Game timer ───────────────────────────────────────────────────────────────
export const GAME_DURATION_MS = 120_000;

// ─── Server tick ─────────────────────────────────────────────────────────────
export const TICK_RATE_HZ = 20;
export const TICK_MS = 1000 / TICK_RATE_HZ; // 50 ms
