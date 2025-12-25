import { SignalingClient } from './signaling';
import type { Operation } from './types';
import { HybridClock } from './hlc';

/**
 * DataChannel message types
 */
export type ChannelMessage =
  | { type: 'op'; payload: Operation }
  | { type: 'sync-request'; fromVersion?: string }
  | { type: 'sync-response'; operations: Operation[] }
  | { type: 'ping' }
  | { type: 'pong' };

interface PeerConnection {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  ready: boolean;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * WebRTC Manager for P2P connections
 */
export class WebRTCManager {
  private signaling: SignalingClient | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private iceServers: RTCIceServer[];
  private localPeerId: string;

  // Callbacks
  onOperation: ((op: Operation, fromPeerId: string) => void) | null = null;
  onSyncRequest: ((fromPeerId: string, fromVersion?: string) => Operation[]) | null = null;
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onPeerReady: ((peerId: string) => void) | null = null;

  constructor(localPeerId: string, iceServers?: RTCIceServer[]) {
    this.localPeerId = localPeerId;
    this.iceServers = iceServers || DEFAULT_ICE_SERVERS;
  }

  async connect(signalingUrl: string, token: string): Promise<void> {
    this.signaling = new SignalingClient(signalingUrl, token, this.localPeerId);

    // Set up signaling handlers
    this.signaling.on('peers', (event) => {
      if (event.type === 'peers') {
        // Connect to existing peers
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
        // New peer will initiate connection to us
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

    await this.signaling.connect();
  }

  private async createPeerConnection(peerId: string, initiator: boolean): Promise<void> {
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peerConn: PeerConnection = { pc, dc: null, ready: false };
    this.peers.set(peerId, peerConn);

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling?.sendIceCandidate(peerId, event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(peerId);
      }
    };

    if (initiator) {
      // Create data channel
      const dc = pc.createDataChannel('rtc-battery', { ordered: true });
      this.setupDataChannel(dc, peerId, peerConn);
      peerConn.dc = dc;

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling?.sendOffer(peerId, offer);
    } else {
      // Wait for data channel from remote
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
      this.sendToPeer(peerId, { type: 'sync-request' });
    };

    dc.onclose = () => {
      peerConn.ready = false;
    };

    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ChannelMessage;
        this.handleChannelMessage(msg, peerId);
      } catch (e) {
        console.error('Failed to parse channel message:', e);
      }
    };
  }

  private handleChannelMessage(msg: ChannelMessage, fromPeerId: string): void {
    switch (msg.type) {
      case 'op':
        this.onOperation?.(msg.payload, fromPeerId);
        break;

      case 'sync-request':
        const ops = this.onSyncRequest?.(fromPeerId, msg.fromVersion) || [];
        this.sendToPeer(fromPeerId, { type: 'sync-response', operations: ops });
        break;

      case 'sync-response':
        for (const op of msg.operations) {
          this.onOperation?.(op, fromPeerId);
        }
        break;

      case 'ping':
        this.sendToPeer(fromPeerId, { type: 'pong' });
        break;

      case 'pong':
        // Peer is alive
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

  /**
   * Send message to a specific peer
   */
  sendToPeer(peerId: string, message: ChannelMessage): boolean {
    const peer = this.peers.get(peerId);
    if (peer?.dc?.readyState === 'open') {
      peer.dc.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /**
   * Broadcast operation to all connected peers
   */
  broadcast(op: Operation): void {
    const message: ChannelMessage = { type: 'op', payload: op };
    for (const [peerId, peer] of this.peers) {
      if (peer.dc?.readyState === 'open') {
        peer.dc.send(JSON.stringify(message));
      }
    }
  }

  /**
   * Request sync from all peers
   */
  requestSync(fromVersion?: string): void {
    const message: ChannelMessage = { type: 'sync-request', fromVersion };
    for (const [peerId, peer] of this.peers) {
      if (peer.dc?.readyState === 'open') {
        peer.dc.send(JSON.stringify(message));
      }
    }
  }

  /**
   * Get list of connected peer IDs
   */
  getConnectedPeers(): string[] {
    return Array.from(this.peers.entries())
      .filter(([_, peer]) => peer.ready)
      .map(([id]) => id);
  }

  /**
   * Disconnect from all peers and signaling
   */
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
