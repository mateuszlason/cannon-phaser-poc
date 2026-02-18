// ─── Shared state types ───────────────────────────────────────────────────────
// These are plain data objects sent from server → client each tick.
// No Phaser or Node types here.

export type GamePhase = 'waiting' | 'playing' | 'gameover';
export type GameOverReason = 'TIME' | 'DESTROYED';

export interface LaserState {
  id: number;
  x: number;
  y: number;
}

export interface RockState {
  id: number;
  x: number;
  y: number;
  angle: number;       // degrees, for client-side visual rotation
  hp: number;
  maxHp: number;
  displaySize: number; // px — computed once on spawn, sent for rendering
}

export interface GameState {
  phase: GamePhase;
  cannonX: number;
  cannonAlive: boolean;
  lasers: LaserState[];
  rocks: RockState[];
  score: number;
  timeLeftMs: number;
  gameOverReason?: GameOverReason;
}

// ─── Input message client → server ───────────────────────────────────────────

export interface InputMessage {
  pointerX: number;  // pointer X in game coordinates (0–480)
  firing: boolean;
}
