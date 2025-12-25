/**
 * WebSocket signaling client for WebRTC peer discovery
 */

export type SignalingMessage =
  | { type: 'join'; peerId: string }
  | { type: 'offer'; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; to: string; candidate: RTCIceCandidateInit };

export type SignalingEvent =
  | { type: 'peers'; peerIds: string[] }
  | { type: 'peer-join'; peerId: string }
  | { type: 'peer-leave'; peerId: string }
  | { type: 'offer'; from: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; from: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; from: string; candidate: RTCIceCandidateInit };

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private peerId: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private handlers: Map<string, Set<(event: SignalingEvent) => void>> = new Map();

  constructor(url: string, token: string, peerId: string) {
    this.url = url;
    this.token = token;
    this.peerId = peerId;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.send({ type: 'join', peerId: this.peerId });
        resolve();
      };

      this.ws.onerror = (err) => {
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        this.handleDisconnect();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as SignalingEvent;
          this.emit(msg.type, msg);
        } catch (e) {
          console.error('Failed to parse signaling message:', e);
        }
      };
    });
  }

  private handleDisconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      setTimeout(() => {
        this.connect().catch(console.error);
      }, delay);
    }
  }

  send(message: SignalingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendOffer(to: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ type: 'offer', to, sdp });
  }

  sendAnswer(to: string, sdp: RTCSessionDescriptionInit): void {
    this.send({ type: 'answer', to, sdp });
  }

  sendIceCandidate(to: string, candidate: RTCIceCandidateInit): void {
    this.send({ type: 'ice', to, candidate });
  }

  on(event: string, handler: (event: SignalingEvent) => void): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, data: SignalingEvent): void {
    this.handlers.get(event)?.forEach(handler => {
      try {
        handler(data);
      } catch (e) {
        console.error('Signaling handler error:', e);
      }
    });
  }

  disconnect(): void {
    this.maxReconnectAttempts = 0; // Prevent reconnection
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
