import { SignalingClient } from './signaling';
import type { CRChange } from './crsqlite';

/**
 * DataChannel message types for cr-sqlite sync
 */
export type ChannelMessage =
  | { type: 'sync-request'; version: number }
  | { type: 'sync-response'; changes: CRChange[]; version: number }
  | { type: 'changes'; changes: CRChange[]; version: number }
  | { type: 'ping' }
  | { type: 'pong' };

interface PeerConnection {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  ready: boolean;
  lastSyncedVersion: number;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * WebRTC Manager for P2P connections with cr-sqlite sync
 */
export class WebRTCManager {
  private signaling: SignalingClient | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private iceServers: RTCIceServer[];
  private localPeerId: string;

  // Callbacks
  onSyncRequest: ((fromPeerId: string, sinceVersion: number) => Promise<{ changes: CRChange[]; version: number }>) | null = null;
  onChangesReceived: ((changes: CRChange[], fromPeerId: string) => Promise<void>) | null = null;
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onPeerReady: ((peerId: string) => void) | null = null;
  onReconnecting: ((attempt: number) => void) | null = null;
  onReconnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  getLocalVersion: (() => number) | null = null;

  constructor(localPeerId: string, iceServers?: RTCIceServer[]) {
    this.localPeerId = localPeerId;
    this.iceServers = iceServers || DEFAULT_ICE_SERVERS;
  }

  async connect(signalingUrl: string, token: string): Promise<void> {
    this.signaling = new SignalingClient(signalingUrl, token, this.localPeerId);

    this.signaling.on('peers', (event) => {
      if (event.type === 'peers') {
        for (const peerId of event.peerIds) {
          if (peerId !== this.localPeerId) {
            this.createPeerConnection(peerId, true);
          }
        }
      }
    });

    this.signaling.on('peer-join', (event) => {
      if (event.type === 'peer-join' && event.peerId !== this.localPeerId) {
        this.onPeerJoin?.(event.peerId);
      }
    });

    this.signaling.on('peer-leave', (event) => {
      if (event.type === 'peer-leave') {
        this.removePeer(event.peerId);
        this.onPeerLeave?.(event.peerId);
      }
    });

    this.signaling.on('offer', async (event) => {
      if (event.type === 'offer') {
        await this.handleOffer(event.from, event.sdp);
      }
    });

    this.signaling.on('answer', async (event) => {
      if (event.type === 'answer') {
        await this.handleAnswer(event.from, event.sdp);
      }
    });

    this.signaling.on('ice', async (event) => {
      if (event.type === 'ice') {
        await this.handleIceCandidate(event.from, event.candidate);
      }
    });

    this.signaling.on('reconnecting', (event) => {
      if (event.type === 'reconnecting') {
        this.onReconnecting?.(event.attempt);
      }
    });

    this.signaling.on('reconnected', () => {
      this.onReconnected?.();
    });

    this.signaling.on('disconnected', () => {
      this.onDisconnected?.();
    });

    await this.signaling.connect();
  }

  private async createPeerConnection(peerId: string, initiator: boolean): Promise<void> {
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peerConn: PeerConnection = { pc, dc: null, ready: false, lastSyncedVersion: 0 };
    this.peers.set(peerId, peerConn);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling?.sendIceCandidate(peerId, event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(peerId);
        this.onPeerLeave?.(peerId);
      }
    };

    if (initiator) {
      const dc = pc.createDataChannel('rtc-battery', { ordered: true });
      this.setupDataChannel(dc, peerId, peerConn);
      peerConn.dc = dc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling?.sendOffer(peerId, offer);
    } else {
      pc.ondatachannel = (event) => {
        peerConn.dc = event.channel;
        this.setupDataChannel(event.channel, peerId, peerConn);
      };
    }
  }

  private setupDataChannel(dc: RTCDataChannel, peerId: string, peerConn: PeerConnection): void {
    dc.onopen = () => {
      peerConn.ready = true;
      this.onPeerReady?.(peerId);

      // Request sync from this peer
      const localVersion = this.getLocalVersion?.() ?? 0;
      this.sendToPeer(peerId, { type: 'sync-request', version: localVersion });
    };

    dc.onclose = () => {
      peerConn.ready = false;
    };

    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ChannelMessage;
        this.handleChannelMessage(msg, peerId, peerConn);
      } catch (e) {
        console.error('Failed to parse channel message:', e);
      }
    };
  }

  private async handleChannelMessage(msg: ChannelMessage, fromPeerId: string, peerConn: PeerConnection): Promise<void> {
    switch (msg.type) {
      case 'sync-request': {
        // Peer wants changes since their version
        const result = await this.onSyncRequest?.(fromPeerId, msg.version);
        if (result) {
          this.sendToPeer(fromPeerId, {
            type: 'sync-response',
            changes: result.changes,
            version: result.version
          });
        }
        break;
      }

      case 'sync-response': {
        // Apply changes from peer
        if (msg.changes.length > 0) {
          await this.onChangesReceived?.(msg.changes, fromPeerId);
        }
        peerConn.lastSyncedVersion = msg.version;
        break;
      }

      case 'changes': {
        // Real-time changes broadcast
        if (msg.changes.length > 0) {
          await this.onChangesReceived?.(msg.changes, fromPeerId);
        }
        peerConn.lastSyncedVersion = msg.version;
        break;
      }

      case 'ping':
        this.sendToPeer(fromPeerId, { type: 'pong' });
        break;

      case 'pong':
        break;
    }
  }

  private async handleOffer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.createPeerConnection(from, false);
    const peer = this.peers.get(from);
    if (!peer) return;

    await peer.pc.setRemoteDescription(sdp);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    this.signaling?.sendAnswer(from, answer);
  }

  private async handleAnswer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return;
    await peer.pc.setRemoteDescription(sdp);
  }

  private async handleIceCandidate(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return;
    await peer.pc.addIceCandidate(candidate);
  }

  private removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.dc?.close();
      peer.pc.close();
      this.peers.delete(peerId);
    }
  }

  sendToPeer(peerId: string, message: ChannelMessage): boolean {
    const peer = this.peers.get(peerId);
    if (peer?.dc?.readyState === 'open') {
      peer.dc.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /**
   * Broadcast changes to all connected peers
   */
  broadcastChanges(changes: CRChange[], version: number): void {
    const message: ChannelMessage = { type: 'changes', changes, version };
    for (const [peerId, peer] of this.peers) {
      if (peer.dc?.readyState === 'open') {
        peer.dc.send(JSON.stringify(message));
        peer.lastSyncedVersion = version;
      }
    }
  }

  getConnectedPeers(): string[] {
    return Array.from(this.peers.entries())
      .filter(([_, peer]) => peer.ready)
      .map(([id]) => id);
  }

  disconnect(): void {
    for (const [peerId] of this.peers) {
      this.removePeer(peerId);
    }
    this.signaling?.disconnect();
    this.signaling = null;
  }

  isConnected(): boolean {
    return this.signaling?.isConnected() ?? false;
  }
}
