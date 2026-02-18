// Game dimensions — portrait layout matching background aspect ratio
export const GAME_WIDTH = 480;
export const GAME_HEIGHT = 854;

// Cannon
export const CANNON_SPEED = 280; // px/sec horizontal
export const CANNON_Y_OFFSET = 80; // px from bottom
export const CANNON_WIDTH = 90;

// Shooting
export const SHOOT_DELAY_MS = 2000; // delay before first shot
export const SHOOT_RATE_MS = 67;    // ~15 shots/sec
export const LASER_SPEED = 700;     // px/sec upward

// Rocks
export const ROCK_SPAWN_DELAY_MS = 2000;
export const ROCK_SPAWN_INTERVAL_MS = 1200; // base interval; adjusted by difficulty
export const ROCK_SPEED_MIN = 180;
export const ROCK_SPEED_MAX = 340;
export const SPLIT_THRESHOLD = 30; // rocks with hp > this split on death

// Rock size scaling: hp → display scale
export const ROCK_SCALE_MIN = 0.14; // smallest rock
export const ROCK_SCALE_MAX = 0.42; // largest rock
export const ROCK_HP_MIN = 1;
export const ROCK_HP_MAX = 50;

// Land boundaries (horizontal, in game coords) — cannon stays inside
export const LAND_LEFT = 60;
export const LAND_RIGHT = GAME_WIDTH - 60;

// Cannon boundary — centre of cannon sprite
export const CANNON_BOUND_LEFT = LAND_LEFT + CANNON_WIDTH / 2;
export const CANNON_BOUND_RIGHT = LAND_RIGHT - CANNON_WIDTH / 2;

// Game timer
export const GAME_DURATION_MS = 120_000; // 2 minutes

// How many top/bottom bounces before rock escapes
export const ROCK_MAX_BOUNCES = 3;

// Colours
export const COLOUR_HUD = '#ffffff';
export const COLOUR_ROCK_TEXT = '#ffffff';
