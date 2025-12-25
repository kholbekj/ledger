/**
 * Simple WebSocket signaling server for RTC Battery
 *
 * Usage: node server/signaling.js [port]
 * Default port: 8081
 */

import { WebSocketServer } from 'ws';

const PORT = parseInt(process.argv[2] || '8081', 10);

// Room -> Set of { ws, peerId }
const rooms = new Map();

const wss = new WebSocketServer({ port: PORT });

console.log(`Signaling server running on ws://localhost:${PORT}`);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Token required');
    return;
  }

  let peerId = null;
  let room = rooms.get(token);

  if (!room) {
    room = new Map();
    rooms.set(token, room);
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'join':
          peerId = msg.peerId;
          room.set(peerId, ws);

          // Send list of existing peers
          const existingPeers = Array.from(room.keys()).filter(id => id !== peerId);
          ws.send(JSON.stringify({ type: 'peers', peerIds: existingPeers }));

          // Notify others of new peer
          broadcast(room, peerId, { type: 'peer-join', peerId });
          console.log(`[${token}] Peer joined: ${peerId.slice(0, 8)}... (${room.size} total)`);
          break;

        case 'offer':
        case 'answer':
        case 'ice':
          // Forward to target peer
          const targetWs = room.get(msg.to);
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({
              type: msg.type,
              from: peerId,
              sdp: msg.sdp,
              candidate: msg.candidate
            }));
          }
          break;
      }
    } catch (e) {
      console.error('Message parse error:', e);
    }
  });

  ws.on('close', () => {
    if (peerId && room) {
      room.delete(peerId);
      broadcast(room, peerId, { type: 'peer-leave', peerId });
      console.log(`[${token}] Peer left: ${peerId.slice(0, 8)}... (${room.size} remaining)`);

      // Clean up empty rooms
      if (room.size === 0) {
        rooms.delete(token);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

function broadcast(room, excludePeerId, message) {
  const data = JSON.stringify(message);
  for (const [id, ws] of room) {
    if (id !== excludePeerId && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close(() => {
    process.exit(0);
  });
});
