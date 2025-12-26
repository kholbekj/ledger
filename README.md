# Ledger

WebRTC + SQLite + CRDT replication. Peer-to-peer syncing SQL database for the browser. Built on [cr-sqlite](https://vlcn.io/) for conflict-free replication.

## Install

```bash
npm install ledger
```

## Usage

```javascript
import { Ledger } from 'ledger';

// Create instance
const db = new Ledger({ dbName: 'my-app' });

// Initialize database
await db.init();

// Create tables and enable sync
await db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY NOT NULL,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
await db.enableSync('notes');

// Connect to peers (same token = same room)
await db.connect('wss://your-signaling-server.com', 'room-token');

// Use SQL normally - changes sync automatically
await db.exec('INSERT INTO notes (id, content) VALUES (?, ?)', [crypto.randomUUID(), 'Hello']);
await db.exec('UPDATE notes SET content = ? WHERE id = ?', ['Updated', id]);
await db.exec('DELETE FROM notes WHERE id = ?', [id]);

// Query
const result = await db.exec('SELECT * FROM notes');
console.log(result.rows);

// Events
db.on('sync', (count, peerId) => console.log(`Synced ${count} changes from ${peerId}`));
db.on('peer-join', (peerId) => console.log(`Peer joined: ${peerId}`));
db.on('peer-leave', (peerId) => console.log(`Peer left: ${peerId}`));
db.on('connected', () => console.log('Connected to signaling'));
db.on('disconnected', () => console.log('Disconnected'));

// Cleanup
await db.close();
```

## API

### `new Ledger(config?)`

| Option | Type | Description |
|--------|------|-------------|
| `dbName` | `string` | Database name (default: `'ledger-default'`) |
| `signalingUrl` | `string` | WebSocket signaling server URL |
| `token` | `string` | Room token (peers with same token sync together) |
| `iceServers` | `RTCIceServer[]` | Custom ICE servers |

### Methods

| Method | Description |
|--------|-------------|
| `init()` | Initialize the database |
| `connect(url?, token?)` | Connect to signaling server and start P2P sync |
| `disconnect()` | Disconnect from peers |
| `close()` | Close database and cleanup |
| `exec(sql, params?)` | Execute SQL query, returns `{ columns, rows }` |
| `enableSync(tableName)` | Enable CRDT sync on a table (call after CREATE TABLE) |
| `getNodeId()` | Get this peer's unique ID |
| `getVersion()` | Get current database version |
| `getPeers()` | Get list of connected peer IDs |
| `isConnected()` | Check if connected to signaling |

### Events

| Event | Callback | Description |
|-------|----------|-------------|
| `sync` | `(count, peerId)` | Received changes from peer |
| `peer-join` | `(peerId)` | Peer discovered |
| `peer-ready` | `(peerId)` | Peer connection established |
| `peer-leave` | `(peerId)` | Peer disconnected |
| `connected` | `()` | Connected to signaling |
| `disconnected` | `()` | Disconnected from signaling |
| `reconnecting` | `(attempt)` | Attempting to reconnect |
| `reconnected` | `()` | Successfully reconnected |

## Running the Demo

```bash
# Install dependencies
npm install

# Start signaling server
npm run server

# Build and serve demo
npm run build:demo
npx serve demo
```

Open two browser tabs to `http://localhost:3000/#room-token` (same hash = same room).

## Signaling Server

The included signaling server handles WebRTC connection setup:

```bash
npm run server  # Runs on ws://localhost:8081
```

For production, deploy `server/signaling.js` or use any WebSocket server that implements the signaling protocol.

## How It Works

- **cr-sqlite**: SQLite compiled to WASM with built-in CRDT support
- **Automatic change tracking**: All mutations to synced tables are captured
- **Cell-level conflict resolution**: Last-write-wins based on logical clocks
- **WebRTC DataChannels**: Direct peer-to-peer data transfer
- **Signaling server**: Only used for initial peer discovery (no data passes through it)

## Schema Requirements

- Tables must have `PRIMARY KEY NOT NULL`
- Call `enableSync(tableName)` after creating each table you want to sync
- Schema is not synced - all peers must have identical table definitions
