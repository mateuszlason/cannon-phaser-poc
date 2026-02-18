import { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import { Client, type Room } from 'colyseus.js';
import { createPhaserConfig } from '../game/config';
import type { GameScene } from '../game/GameScene';
import styles from './GameCanvas.module.css';

// ─── Types ───────────────────────────────────────────────────────────────────

type Screen = 'start' | 'playing' | 'gameover';

interface GameOverPayload {
  score: number;
  reason: 'TIME' | 'DESTROYED';
}

const COLYSEUS_URL = 'ws://localhost:2567';

// ─── Component ───────────────────────────────────────────────────────────────

export function GameCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const roomRef = useRef<Room | null>(null);
  const [screen, setScreen] = useState<Screen>('start');
  const [result, setResult] = useState<GameOverPayload | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // ── Teardown helper — safe to call multiple times ────────────────────────
  const teardown = () => {
    roomRef.current?.leave();
    roomRef.current = null;
    gameRef.current?.destroy(true);
    gameRef.current = null;
  };

  const startGame = async () => {
    setConnectError(null);
    setConnecting(true);
    teardown();

    try {
      const client = new Client(COLYSEUS_URL);
      const room = await client.joinOrCreate('GameRoom');
      roomRef.current = room;
      setScreen('playing');
      setConnecting(false);

      // Wait a tick so React has rendered the canvas container
      requestAnimationFrame(() => {
        if (!containerRef.current) return;

        const game = new Phaser.Game(createPhaserConfig(containerRef.current));
        gameRef.current = game;

        game.events.once('ready', () => {
          const scene = game.scene.getScene('GameScene') as GameScene;
          scene.room = room;
          room.send('start');

          scene.events.on('gameOver', (payload: GameOverPayload) => {
            // Mark room closed before destroying so shutdown() doesn't send on a dead socket
            scene.roomClosed = true;
            roomRef.current?.leave();
            roomRef.current = null;
            setResult(payload);
            setScreen('gameover');
          });
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConnectError(`Could not connect to game server: ${msg}`);
      setConnecting(false);
    }
  };

  // Destroy Phaser when leaving playing screen (e.g. manual nav, hot reload)
  useEffect(() => {
    if (screen !== 'playing') {
      gameRef.current?.destroy(true);
      gameRef.current = null;
    }
  }, [screen]);

  // Final cleanup on unmount
  useEffect(() => () => teardown(), []);

  const handlePlayAgain = () => {
    setResult(null);
    void startGame();
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className={styles.wrapper}>
      {/* Phaser canvas container — always mounted so Phaser has a DOM target */}
      <div
        ref={containerRef}
        className={styles.canvas}
        style={{ visibility: screen === 'playing' ? 'visible' : 'hidden' }}
      />

      {/* Start screen */}
      {screen === 'start' && (
        <div className={styles.overlay}>
          <div className={styles.card}>
            <h1 className={styles.title}>CANNON BLAST</h1>
            <p className={styles.subtitle}>
              Destroy rocks before they destroy you!
            </p>
            <ul className={styles.instructions}>
              <li>Hold left mouse / touch to aim and fire</li>
              <li>Cannon follows your pointer while held</li>
              <li>Rocks split when HP &gt; 30</li>
              <li>Survive 2 minutes for max score</li>
            </ul>
            {connectError && (
              <p style={{ color: '#ff6b6b', fontSize: '0.85rem', margin: 0 }}>
                {connectError}
              </p>
            )}
            <button
              className={styles.btn}
              onClick={() => void startGame()}
              disabled={connecting}
            >
              {connecting ? 'CONNECTING…' : 'PLAY'}
            </button>
          </div>
        </div>
      )}

      {/* Game over screen */}
      {screen === 'gameover' && result && (
        <div className={styles.overlay}>
          <div className={styles.card}>
            <h1 className={styles.title}>
              {result.reason === 'DESTROYED' ? 'CANNON DESTROYED' : 'TIME UP!'}
            </h1>
            <p className={styles.scoreLabel}>Final Score</p>
            <p className={styles.scoreValue}>{result.score.toLocaleString()}</p>
            <button className={styles.btn} onClick={handlePlayAgain}>
              PLAY AGAIN
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
