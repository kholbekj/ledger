# Ledger

Peer-to-peer syncing SQL database for the browser. WebRTC + SQLite + CRDT replication.

## Stack

- **cr-sqlite** (`@vlcn.io/crsqlite-wasm`) - SQLite with built-in CRDT support
- **WebRTC DataChannels** - P2P data transfer
- **TypeScript** - Source in `src/`
- **esbuild** - Bundler

## Project Structure

```
src/
  index.ts      # Main Ledger class, public API
  crsqlite.ts   # cr-sqlite wrapper, change tracking
  webrtc.ts     # WebRTC peer connections
  signaling.ts  # WebSocket signaling client
  types.ts      # Shared types

server/
  signaling.js  # Node.js signaling server

demo/
  index.html    # Demo app
  ledger.js     # Built bundle (gitignored)
```

## Key Concepts

### CRDT Sync via cr-sqlite
- Tables marked with `enableSync(tableName)` are CRDT-enabled
- Changes tracked automatically in `crsql_changes` virtual table
- Cell-level conflict resolution (last-write-wins by logical clock)
- Schema is NOT synced - all peers must have identical table definitions

### Sync Protocol
1. Peer connects via WebRTC DataChannel
2. Sends `sync-request` with local `db_version`
3. Receives changes since that version
4. Applies changes via `INSERT INTO crsql_changes`

### Binary Serialization
`pk` and `site_id` fields are `Uint8Array` in cr-sqlite but sent as base64 over JSON/WebRTC.
See `uint8ToBase64()` and `base64ToUint8()` in `crsqlite.ts`.

## Commands

```bash
npm run build        # Build dist/ledger.js
npm run build:demo   # Build demo/ledger.js
npm run server       # Start signaling server (ws://localhost:8081)
npm run dev          # Watch mode + serve demo
npm run typecheck    # TypeScript check
```

## Testing Locally

1. `npm run server` - Start signaling
2. `npm run build:demo` - Build demo
3. `npx serve demo` - Serve demo
4. Open two tabs to same URL with hash (e.g., `http://localhost:3000/#test`)
5. Connect both, add notes, watch sync
