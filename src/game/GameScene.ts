import Phaser from 'phaser';
import type { Room } from 'colyseus.js';
import { AudioManager } from './AudioManager';
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  CANNON_Y,
  CANNON_BOUND_LEFT,
  CANNON_BOUND_RIGHT,
  TICK_MS,
} from '../../shared/src/constants';
import type { GameState, RockState, LaserState } from '../../shared/src/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RockSprite {
  img: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
}

// ─── Scene ────────────────────────────────────────────────────────────────────

export class GameScene extends Phaser.Scene {
  // Colyseus room injected before scene start
  room!: Room;

  // sprites
  private cannon!: Phaser.GameObjects.Image;
  private laserSprites = new Map<number, Phaser.GameObjects.Image>();
  private rockSprites = new Map<number, RockSprite>();

  // hud
  private scoreText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;

  // audio
  private audio!: AudioManager;

  // input state
  private isFiring = false;
  private pointerGameX = GAME_WIDTH / 2;
  // Pending input that hasn't been flushed to the server yet this frame.
  // mousemove events can fire hundreds of times per second; we coalesce them
  // and send at most one message per animation frame in update().
  private inputDirty = false;

  // client-side prediction — cannon X we compute locally each frame
  private predictedCannonX = GAME_WIDTH / 2;
  private serverCorrection = 0; // offset blended out smoothly after each server tick
  private shootUnlocked = false; // mirrors server unlock so prediction only runs after grace period
  private gameStartTime = 0;    // performance.now() snapshot when phase first becomes 'playing'

  // set to true once room.leave() has been called so sendInput() stops trying
  roomClosed = false;

  // window-level listeners kept so we can remove them on shutdown
  private onWindowMouseMove!: (e: MouseEvent) => void;
  private onWindowMouseDown!: (e: MouseEvent) => void;
  private onWindowMouseUp!: (e: MouseEvent) => void;

  // interpolation — we hold prev + next server states and lerp between them
  private prevState: GameState | null = null;
  private nextState: GameState | null = null;
  private interpAlpha = 0;   // 0→1 between prev and next; may exceed 1 slightly for extrapolation
  private tickMs = TICK_MS;  // estimated server tick cadence, updated from measured inter-arrival time
  private lastTickArrival = 0; // performance.now() of last received server state

  // track destroyed rocks to play explosion sound once
  private knownRockIds = new Set<number>();
  private prevCannonAlive = true;
  private prevScore = 0;

  constructor() {
    super({ key: 'GameScene' });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  preload() {
    this.load.image('background', '/assets/background.png');
    this.load.image('cannon', '/assets/cannon.png');
    this.load.image('laser', '/assets/laser.png');
    this.load.image('rock', '/assets/rock.png');
  }

  create() {
    this.audio = new AudioManager();
    this.laserSprites.clear();
    this.rockSprites.clear();
    this.knownRockIds.clear();
    this.prevState = null;
    this.nextState = null;
    this.interpAlpha = 0;
    this.prevCannonAlive = true;
    this.prevScore = 0;
    this.predictedCannonX = GAME_WIDTH / 2;
    this.serverCorrection = 0;
    this.shootUnlocked = false;
    this.gameStartTime = 0;
    this.roomClosed = false;
    this.inputDirty = false;
    this.tickMs = TICK_MS;
    this.lastTickArrival = 0;

    // Background
    this.add
      .image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'background')
      .setDisplaySize(GAME_WIDTH, GAME_HEIGHT);

    // Cannon
    this.cannon = this.add
      .image(GAME_WIDTH / 2, CANNON_Y, 'cannon')
      .setDisplaySize(90, 108)
      .setDepth(10);

    // HUD
    this.scoreText = this.add
      .text(16, 16, 'Score: 0', {
        fontSize: '22px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setDepth(20);

    this.timerText = this.add
      .text(GAME_WIDTH - 16, 16, '2:00', {
        fontSize: '22px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(1, 0)
      .setDepth(20);

    // "Hold to shoot" hint
    const hintText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 60, 'HOLD TO SHOOT', {
        fontSize: '28px',
        color: '#ffdd00',
        stroke: '#000000',
        strokeThickness: 6,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(30);

    this.time.delayedCall(2000, () => hintText.destroy());

    // ── Pointer input (window-level so leaving the canvas doesn't break it) ──

    this.onWindowMouseMove = (e: MouseEvent) => {
      this.pointerGameX = this.pageXToGameX(e.clientX);
      if (this.isFiring) this.inputDirty = true; // flushed in update() — at most once per frame
    };

    this.onWindowMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      this.pointerGameX = this.pageXToGameX(e.clientX);
      this.isFiring = true;
      this.audio.resume();
      if (!this.audio['musicPlaying']) this.audio.startMusic();
      this.sendInput(); // send immediately on press for lowest possible click latency
    };

    this.onWindowMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      this.isFiring = false;
      this.sendInput(); // send immediately on release too
    };

    window.addEventListener('mousemove', this.onWindowMouseMove);
    window.addEventListener('mousedown', this.onWindowMouseDown);
    window.addEventListener('mouseup', this.onWindowMouseUp);

    // ── Subscribe to server state ──────────────────────────────────────────

    this.room.onMessage('state', (state: GameState) => {
      // ── Measure actual inter-arrival time and adapt tickMs ──────────────
      const now = performance.now();
      if (this.lastTickArrival > 0) {
        const measured = now - this.lastTickArrival;
        // Exponential moving average — reacts to real cadence without overfit
        this.tickMs = this.tickMs * 0.9 + measured * 0.1;
      }
      this.lastTickArrival = now;

      this.prevState = this.nextState ?? state;
      this.nextState = state;
      this.interpAlpha = 0;
      // Reconcile: instead of snapping, accumulate the error as a correction
      // offset that bleeds away smoothly in update(). This eliminates the
      // visible stutter from hard position resets every 50ms tick.
      if (state.cannonAlive) {
        this.serverCorrection += state.cannonX - this.predictedCannonX;
      }
      // Mirror the server's shoot-unlock using a local timer keyed to when the
      // phase first became 'playing'. Avoids the ~50ms lag of waiting to see a
      // laser in the server state.
      if (!this.shootUnlocked && state.phase === 'playing') {
        if (this.gameStartTime === 0) this.gameStartTime = performance.now();
        if (performance.now() - this.gameStartTime >= 2000) {
          this.shootUnlocked = true;
        }
      }
    });
  }

  update(_time: number, delta: number) {
    if (!this.nextState) return;

    // ── Flush coalesced input (at most once per frame) ────────────────────
    if (this.inputDirty) {
      this.sendInput();
      this.inputDirty = false;
    }

    // Advance interpolation. Allow slight overshoot (up to 1.2×) so the scene
    // continues to extrapolate smoothly if a server tick arrives a few ms late,
    // rather than freezing at the last known position.
    this.interpAlpha = Math.min(1.2, this.interpAlpha + delta / this.tickMs);

    const state = this.nextState;

    // ── Cannon (client-side prediction + smooth reconciliation) ──────────
    // Mirror the server's direct snap: cannon X = pointer X instantly.
    // Server correction is still blended out smoothly so any divergence
    // (e.g. boundary clamping) fades without a visible jump.
    if (state.cannonAlive) {
      if (this.shootUnlocked && this.isFiring) {
        this.predictedCannonX = Math.max(CANNON_BOUND_LEFT, Math.min(CANNON_BOUND_RIGHT, this.pointerGameX));
      }

      // Bleed server correction — 20% per frame, so it's gone within ~3 frames
      const bleed = this.serverCorrection * Math.min(1, (delta / TICK_MS) * 0.2);
      this.predictedCannonX += bleed;
      this.serverCorrection -= bleed;

      this.cannon.x = this.predictedCannonX;
      this.cannon.setVisible(true);
    } else {
      if (this.prevCannonAlive) {
        this.prevCannonAlive = false;
        this.audio.playExplosion(1.5);
        this.cameras.main.shake(300, 0.015);
        this.tweens.add({
          targets: this.cannon,
          alpha: 0,
          angle: 90,
          duration: 500,
        });
      }
    }

    // ── Lasers ────────────────────────────────────────────────────────────
    const incomingLaserIds = new Set(state.lasers.map((l: LaserState) => l.id));

    // Add new lasers
    for (const laser of state.lasers) {
      if (!this.laserSprites.has(laser.id)) {
        const sprite = this.add
          .image(laser.x, laser.y, 'laser')
          .setDisplaySize(16, 24)
          .setDepth(8);
        this.laserSprites.set(laser.id, sprite);
        this.audio.playLaser();
      }
    }

    // Remove gone lasers
    for (const [id, sprite] of this.laserSprites) {
      if (!incomingLaserIds.has(id)) {
        sprite.destroy();
        this.laserSprites.delete(id);
      }
    }

    // Update laser positions with interpolation
    const prevLaserMap = new Map(this.prevState?.lasers.map((l: LaserState) => [l.id, l]) ?? []);
    for (const laser of state.lasers) {
      const sprite = this.laserSprites.get(laser.id);
      if (!sprite) continue;
      const prev = prevLaserMap.get(laser.id);
      sprite.x = prev ? Phaser.Math.Linear(prev.x, laser.x, this.interpAlpha) : laser.x;
      sprite.y = prev ? Phaser.Math.Linear(prev.y, laser.y, this.interpAlpha) : laser.y;
    }

    // ── Rocks ─────────────────────────────────────────────────────────────
    const incomingRockIds = new Set(state.rocks.map((r: RockState) => r.id));

    // Add new rocks
    for (const rock of state.rocks) {
      if (!this.rockSprites.has(rock.id)) {
        const img = this.add
          .image(rock.x, rock.y, 'rock')
          .setDisplaySize(rock.displaySize, rock.displaySize)
          .setDepth(5);
        const label = this.add
          .text(rock.x, rock.y, String(rock.hp), {
            fontSize: `${Math.max(12, Math.round(rock.displaySize * 0.3))}px`,
            color: '#ffffff',
            stroke: '#000000',
            strokeThickness: 3,
            fontStyle: 'bold',
          })
          .setOrigin(0.5)
          .setDepth(6);
        this.rockSprites.set(rock.id, { img, label });
        this.knownRockIds.add(rock.id);
      }
    }

    // Remove destroyed rocks (play explosion)
    for (const [id, { img, label }] of this.rockSprites) {
      if (!incomingRockIds.has(id)) {
        const oldRock = this.prevState?.rocks.find((r: RockState) => r.id === id);
        const sizeFactor = oldRock
          ? (oldRock.maxHp - 1) / 49
          : 0.5;
        this.audio.playExplosion(sizeFactor);
        label.destroy();
        this.tweens.add({
          targets: img,
          alpha: 0,
          scaleX: img.scaleX * 1.4,
          scaleY: img.scaleY * 1.4,
          duration: 180,
          onComplete: () => img.destroy(),
        });
        this.rockSprites.delete(id);
        this.knownRockIds.delete(id);
      }
    }

    // Update rock positions, angles, hp labels
    const prevRockMap = new Map(this.prevState?.rocks.map((r: RockState) => [r.id, r]) ?? []);
    for (const rock of state.rocks) {
      const sprites = this.rockSprites.get(rock.id);
      if (!sprites) continue;
      const prev = prevRockMap.get(rock.id);
      sprites.img.x = prev ? Phaser.Math.Linear(prev.x, rock.x, this.interpAlpha) : rock.x;
      sprites.img.y = prev ? Phaser.Math.Linear(prev.y, rock.y, this.interpAlpha) : rock.y;
      sprites.img.angle = prev
        ? Phaser.Math.Linear(prev.angle, rock.angle, this.interpAlpha)
        : rock.angle;
      sprites.label.setPosition(sprites.img.x, sprites.img.y);
      sprites.label.setText(String(rock.hp));
    }

    // ── Score changed ─────────────────────────────────────────────────────
    if (state.score !== this.prevScore) {
      this.prevScore = state.score;
      this.scoreText.setText(`Score: ${state.score}`);
    }

    // ── Timer ─────────────────────────────────────────────────────────────
    const totalSec = Math.ceil(state.timeLeftMs / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    this.timerText.setText(`${mins}:${secs.toString().padStart(2, '0')}`);
    if (totalSec <= 20) this.timerText.setColor('#ff4444');

    // ── Game over ─────────────────────────────────────────────────────────
    if (state.phase === 'gameover') {
      this.roomClosed = true; // stop sendInput() immediately
      this.audio.stopMusic();
      this.scene.pause(); // stop update() loop — no more sends, no more renders
      this.events.emit('gameOver', {
        score: state.score,
        reason: state.gameOverReason ?? 'TIME',
      });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Convert a clientX page coordinate to Phaser game X, accounting for canvas scale/offset. */
  private pageXToGameX(clientX: number): number {
    const canvas = this.sys.game?.canvas;
    if (!canvas) return this.pointerGameX; // scene is shutting down — keep last known value
    const rect = canvas.getBoundingClientRect();
    const scaleX = GAME_WIDTH / rect.width;
    return (clientX - rect.left) * scaleX;
  }

  private sendInput() {
    if (this.roomClosed) return;
    const clamped = Math.max(CANNON_BOUND_LEFT, Math.min(CANNON_BOUND_RIGHT, this.pointerGameX));
    this.room.send('input', { pointerX: clamped, firing: this.isFiring });
  }

  shutdown() {
    this.roomClosed = true;
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mousedown', this.onWindowMouseDown);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
    this.audio?.destroy();
  }
}
