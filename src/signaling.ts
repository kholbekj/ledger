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
  | { type: 'ice'; from: string; candidate: RTCIceCandidateInit }
  | { type: 'reconnecting'; attempt: number }
  | { type: 'reconnected' }
  | { type: 'disconnected' };

export class SignalingClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private peerId: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseDelay = 1000;
  private maxDelay = 30000;
  private handlers: Map<string, Set<(event: SignalingEvent) => void>> = new Map();
  private shouldReconnect = true;
  private isInitialConnect = true;

  constructor(url: string, token: string, peerId: string) {
    this.url = url;
    this.token = token;
    this.peerId = peerId;
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (e) {
        reject(new Error('WebSocket connection failed'));
        return;
      }

      const onOpen = () => {
        cleanup();
        this.reconnectAttempts = 0;

        if (!this.isInitialConnect) {
          this.emit('reconnected', { type: 'reconnected' });
        }
        this.isInitialConnect = false;

        this.send({ type: 'join', peerId: this.peerId });
        resolve();
      };

      const onError = () => {
        cleanup();
        if (this.isInitialConnect) {
          reject(new Error('WebSocket connection failed'));
        }
      };

      const cleanup = () => {
        this.ws?.removeEventListener('open', onOpen);
        this.ws?.removeEventListener('error', onError);
      };

      this.ws.addEventListener('open', onOpen);
      this.ws.addEventListener('error', onError);

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
    if (!this.shouldReconnect) {
      this.emit('disconnected', { type: 'disconnected' });
      return;
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(
        this.baseDelay * Math.pow(2, this.reconnectAttempts - 1),
        this.maxDelay
      );

      this.emit('reconnecting', {
        type: 'reconnecting',
        attempt: this.reconnectAttempts
      });

      setTimeout(() => {
        if (this.shouldReconnect) {
          this.connect().catch(() => {
            // Will trigger another reconnect attempt via onclose
          });
        }
      }, delay);
    } else {
      this.emit('disconnected', { type: 'disconnected' });
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
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
