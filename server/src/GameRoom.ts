import { Room, type Client } from 'colyseus';
import { GameSimulation } from '../../shared/src/simulation.js';
import { TICK_MS } from '../../shared/src/constants.js';
import type { InputMessage, GameState } from '../../shared/src/types.js';

// Set LATENCY_MS env var to simulate one-way network delay, e.g.:
//   LATENCY_MS=150 npm run dev
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);

export class GameRoom extends Room {
  private sim!: GameSimulation;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  // Wall-clock tracking — used only to compute the game timer display value.
  // The simulation itself always receives a fixed TICK_MS delta so its PRNG
  // and physics are perfectly deterministic regardless of server load.
  private wallStartTime = 0;

  // One player per room — no need for matchmaking beyond that
  maxClients = 1;

  onCreate() {
    this.sim = new GameSimulation();

    // Accept input messages from the client
    this.onMessage<InputMessage>('input', (_client, message) => {
      if (LATENCY_MS > 0) {
        setTimeout(() => this.sim.applyInput(message), LATENCY_MS);
      } else {
        this.sim.applyInput(message);
      }
    });

    // Client sends this when they click "Play" on start screen
    this.onMessage('start', () => {
      this.wallStartTime = Date.now();
      this.sim.start();
    });
  }

  onJoin(client: Client) {
    console.log(
      `[GameRoom] client joined: ${client.sessionId}${LATENCY_MS ? ` (simulated latency: ${LATENCY_MS}ms one-way)` : ''}`,
    );

    // Start the server-side game loop.
    // IMPORTANT: we always pass the nominal TICK_MS as delta — never the measured
    // wall-clock delta. This makes GameSimulation fully deterministic: the same
    // seed produces the exact same rock sequence, positions, and collisions every
    // run, regardless of server load or timer jitter. The displayed game timer is
    // derived from wall-clock time separately (see snapshot override below).
    this.tickInterval = setInterval(() => {
      this.sim.tick(TICK_MS);

      // Override timeLeftMs with wall-clock time so the HUD countdown is accurate
      // even though the simulation uses fixed steps internally.
      const state: GameState = this.sim.snapshot();
      if (this.wallStartTime > 0 && state.phase === 'playing') {
        state.timeLeftMs = this.sim.wallTimeLeft(Date.now() - this.wallStartTime);
      }

      if (LATENCY_MS > 0) {
        setTimeout(() => this.broadcast('state', state), LATENCY_MS);
      } else {
        this.broadcast('state', state);
      }
    }, TICK_MS);
  }

  onLeave(client: Client) {
    console.log(`[GameRoom] client left: ${client.sessionId}`);
    this.clearTick();
  }

  onDispose() {
    this.clearTick();
  }

  private clearTick() {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }
}
