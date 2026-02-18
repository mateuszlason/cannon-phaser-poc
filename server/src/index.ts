import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom } from './GameRoom.js';

const PORT = Number(process.env.PORT ?? 2567);

const server = new Server({
  transport: new WebSocketTransport(),
});

server.define('GameRoom', GameRoom);

server.listen(PORT).then(() => {
  console.log(`[Colyseus] listening on ws://localhost:${PORT}`);
});
