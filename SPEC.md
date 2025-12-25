# RTC Battery - WebRTC + SQL + CRDT Replication Library

## Overview

A browser-based library that provides:
- **SQL interface** via sql.js (SQLite compiled to WASM)
- **Persistent storage** via IndexedDB
- **P2P sync** via WebRTC DataChannels
- **Conflict-free replication** via CRDT operations

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser Peer                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  SQL API    │  │  CRDT Layer │  │  WebRTC Manager     │  │
│  │  (sql.js)   │◄─┤  (ops log)  │◄─┤  (DataChannels)     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │            │
│  ┌──────▼──────┐  ┌──────▼──────┐              │            │
│  │  IndexedDB  │  │  IndexedDB  │              │            │
│  │  (db file)  │  │  (ops log)  │              │            │
│  └─────────────┘  └─────────────┘              │            │
└────────────────────────────────────────────────┼────────────┘
                                                 │
                                    WebRTC DataChannel (P2P)
                                                 │
┌────────────────────────────────────────────────┼────────────┐
│                   Signaling Server             │            │
│  ┌─────────────────────────────────────────────▼─────────┐  │
│  │  Room Manager (token-based)                           │  │
│  │  - WebSocket connections                              │  │
│  │  - SDP/ICE exchange                                   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. RTCBattery (Main Entry Point)

```typescript
interface RTCBatteryConfig {
  // Signaling server URL
  signalingUrl: string;

  // Room/database token (peers with same token sync together)
  token: string;

  // Optional: Custom ICE servers
  iceServers?: RTCIceServer[];

  // Optional: Database name for IndexedDB
  dbName?: string;
}

interface RTCBattery {
  // Initialize and connect
  connect(): Promise<void>;

  // Execute SQL (returns results, auto-syncs mutations)
  exec(sql: string, params?: any[]): Promise<QueryResult>;

  // Execute raw SQL without CRDT tracking (local only)
  execLocal(sql: string, params?: any[]): Promise<QueryResult>;

  // Event emitters
  on(event: 'sync', callback: (peerId: string) => void): void;
  on(event: 'peer-join', callback: (peerId: string) => void): void;
  on(event: 'peer-leave', callback: (peerId: string) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;

  // Get sync status
  getPeers(): string[];
  getLocalVersion(): number;

  // Disconnect and cleanup
  disconnect(): Promise<void>;
}
```

### 2. CRDT Strategy: Operation-Based with Hybrid Logical Clocks

Each SQL mutation is captured as an operation with a HLC timestamp for ordering.

```typescript
interface Operation {
  // Hybrid Logical Clock timestamp
  hlc: {
    ts: number;      // Physical timestamp (ms)
    counter: number; // Logical counter
    nodeId: string;  // Peer ID
  };

  // Operation type
  type: 'INSERT' | 'UPDATE' | 'DELETE';

  // Target table
  table: string;

  // Primary key of affected row (required for all tables)
  pk: Record<string, any>;

  // For INSERT/UPDATE: column values
  values?: Record<string, any>;

  // For UPDATE: previous values (for conflict detection)
  prev?: Record<string, any>;
}
```

**Conflict Resolution Strategy:**
- Last-Write-Wins (LWW) based on HLC timestamp
- Same HLC: lexicographic nodeId comparison
- Deleted rows with later operations: operation wins over delete

### 3. SQL Layer

Built on sql.js with operation interception:

```typescript
interface SQLLayer {
  // Parse and execute SQL, extract operations
  execute(sql: string, params?: any[]): {
    result: QueryResult;
    operations: Operation[];
  };

  // Apply operation from remote peer
  applyOperation(op: Operation): void;

  // Export full database state
  exportDatabase(): Uint8Array;

  // Import database state
  importDatabase(data: Uint8Array): void;
}
```

**Schema Requirements:**
- All synced tables MUST have a primary key
- Recommended: Use UUIDs for primary keys to avoid conflicts

### 4. WebRTC Manager

Handles peer connections and data channels:

```typescript
interface WebRTCManager {
  // Connect to signaling server and join room
  connect(signalingUrl: string, token: string): Promise<void>;

  // Send operation to all peers
  broadcast(op: Operation): void;

  // Request full sync from a peer
  requestSync(peerId: string): Promise<Operation[]>;

  // Event handlers
  onOperation: (op: Operation, peerId: string) => void;
  onPeerJoin: (peerId: string) => void;
  onPeerLeave: (peerId: string) => void;
}
```

**DataChannel Protocol:**

```typescript
type Message =
  | { type: 'op'; payload: Operation }
  | { type: 'sync-request'; fromVersion: number }
  | { type: 'sync-response'; operations: Operation[] }
  | { type: 'sync-full'; database: string } // base64 encoded
  | { type: 'ping' }
  | { type: 'pong' };
```

### 5. Persistence Layer

IndexedDB stores:

```typescript
// Database file store
interface DBStore {
  key: 'main';
  value: Uint8Array; // SQLite database file
}

// Operations log (for sync)
interface OpsStore {
  key: string; // HLC string representation
  value: Operation;
  indexes: ['table', 'hlc'];
}

// Sync state
interface SyncStore {
  key: 'lastSync';
  value: {
    hlc: HLC;
    peers: Record<string, HLC>; // Last known version per peer
  };
}
```

---

## Signaling Server Specification

### Endpoint

```
WebSocket: wss://your-server.com/signal?token=<room-token>
```

### Protocol

```typescript
// Client -> Server
type ClientMessage =
  | { type: 'join'; peerId: string }
  | { type: 'offer'; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; to: string; candidate: RTCIceCandidateInit };

// Server -> Client
type ServerMessage =
  | { type: 'peers'; peerIds: string[] }  // Existing peers in room
  | { type: 'peer-join'; peerId: string }
  | { type: 'peer-leave'; peerId: string }
  | { type: 'offer'; from: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; from: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; from: string; candidate: RTCIceCandidateInit };
```

### Server Requirements

1. **Token-based rooms**: Peers with same token join same room
2. **No authentication**: Token IS the secret (share link = share access)
3. **Ephemeral**: No persistence needed, just relay messages
4. **Peer list**: Track connected peers per room
5. **Message relay**: Forward offers/answers/ICE candidates between peers

### Example Implementation (Node.js)

```javascript
// Minimal signaling server
const rooms = new Map(); // token -> Set<{ws, peerId}>

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');

  ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.type === 'join') {
      // Add to room, notify others, send peer list
    } else if (['offer', 'answer', 'ice'].includes(msg.type)) {
      // Forward to target peer
    }
  });

  ws.on('close', () => {
    // Remove from room, notify others
  });
});
```

---

## Sample Static Site

### File Structure

```
/demo
  /index.html      # Main UI
  /app.js          # Application logic
  /style.css       # Styling
  /rtc-battery.js  # The library (bundled)
```

### Features

1. **URL-based rooms**: `https://site.com/#<token>` - same URL = same room
2. **SQL Editor**: Textarea for raw SQL input
3. **Results Table**: Display query results
4. **Sync Status**: Show connected peers
5. **Auto-generate token**: If no hash, generate random token and update URL

### UI Mockup

```
┌─────────────────────────────────────────────────────────────┐
│  RTC Battery Demo                    [3 peers connected 🟢] │
├─────────────────────────────────────────────────────────────┤
│  Share URL: https://demo.com/#abc123xyz         [Copy 📋]  │
├─────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────┐  │
│  │ SELECT * FROM notes ORDER BY created_at DESC;        │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│  [Run Query]                                                │
├─────────────────────────────────────────────────────────────┤
│  Results:                                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ id       │ content          │ created_at              │  │
│  ├──────────┼──────────────────┼─────────────────────────┤  │
│  │ uuid-1   │ Hello world      │ 2025-12-25 10:00:00     │  │
│  │ uuid-2   │ Test note        │ 2025-12-25 09:30:00     │  │
│  └───────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  Sync Log:                                                  │
│  • Peer abc joined                                          │
│  • Synced 5 operations from peer abc                        │
│  • Peer xyz joined                                          │
└─────────────────────────────────────────────────────────────┘
```

### Sample Schema (Auto-created)

```sql
-- Auto-created on first run
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  content TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

---

## Implementation Phases

### Phase 1: Core SQL + Persistence
- [ ] sql.js integration
- [ ] IndexedDB persistence
- [ ] Operation extraction from SQL statements

### Phase 2: CRDT Layer
- [ ] HLC implementation
- [ ] Operation log storage
- [ ] Conflict resolution
- [ ] Operation application

### Phase 3: WebRTC
- [ ] Signaling client
- [ ] Peer connection management
- [ ] DataChannel messaging
- [ ] Reconnection handling

### Phase 4: Sync Protocol
- [ ] Operation broadcast
- [ ] Full sync on join
- [ ] Delta sync for reconnection
- [ ] Peer version tracking

### Phase 5: Demo Site
- [ ] Static HTML/CSS/JS
- [ ] URL token handling
- [ ] SQL editor UI
- [ ] Results display
- [ ] Sync status

---

## Dependencies

```json
{
  "dependencies": {
    "sql.js": "^1.10.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "esbuild": "^0.20.0"
  }
}
```

## Browser Support

- Chrome 80+
- Firefox 78+
- Safari 14+
- Edge 80+

(Requires WebRTC DataChannel and IndexedDB support)
