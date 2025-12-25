/**
 * Hybrid Logical Clock implementation
 * Provides monotonically increasing timestamps that combine physical time with logical counters
 */

export interface HLC {
  ts: number;      // Physical timestamp in ms
  counter: number; // Logical counter for same-ms events
  nodeId: string;  // Unique node identifier
}

export class HybridClock {
  private ts: number = 0;
  private counter: number = 0;
  private nodeId: string;

  constructor(nodeId?: string) {
    this.nodeId = nodeId || crypto.randomUUID();
  }

  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Generate a new timestamp for a local event
   */
  now(): HLC {
    const physicalNow = Date.now();

    if (physicalNow > this.ts) {
      this.ts = physicalNow;
      this.counter = 0;
    } else {
      this.counter++;
    }

    return {
      ts: this.ts,
      counter: this.counter,
      nodeId: this.nodeId
    };
  }

  /**
   * Update local clock based on received remote timestamp
   * Returns a new timestamp that is guaranteed to be greater than both local and remote
   */
  receive(remote: HLC): HLC {
    const physicalNow = Date.now();
    const maxTs = Math.max(this.ts, remote.ts, physicalNow);

    if (maxTs === this.ts && maxTs === remote.ts) {
      // All three are equal, increment counter
      this.counter = Math.max(this.counter, remote.counter) + 1;
    } else if (maxTs === this.ts) {
      // Local ts is max, increment local counter
      this.counter++;
    } else if (maxTs === remote.ts) {
      // Remote ts is max, use remote counter + 1
      this.ts = remote.ts;
      this.counter = remote.counter + 1;
    } else {
      // Physical time is max
      this.ts = physicalNow;
      this.counter = 0;
    }

    this.ts = maxTs;

    return {
      ts: this.ts,
      counter: this.counter,
      nodeId: this.nodeId
    };
  }

  /**
   * Compare two HLCs
   * Returns: -1 if a < b, 0 if a == b, 1 if a > b
   */
  static compare(a: HLC, b: HLC): number {
    if (a.ts !== b.ts) {
      return a.ts < b.ts ? -1 : 1;
    }
    if (a.counter !== b.counter) {
      return a.counter < b.counter ? -1 : 1;
    }
    if (a.nodeId !== b.nodeId) {
      return a.nodeId < b.nodeId ? -1 : 1;
    }
    return 0;
  }

  /**
   * Convert HLC to a sortable string representation
   */
  static toString(hlc: HLC): string {
    const ts = hlc.ts.toString(36).padStart(11, '0');
    const counter = hlc.counter.toString(36).padStart(5, '0');
    return `${ts}-${counter}-${hlc.nodeId}`;
  }

  /**
   * Parse HLC from string representation
   */
  static fromString(str: string): HLC {
    const parts = str.split('-');
    if (parts.length < 3) {
      throw new Error('Invalid HLC string');
    }
    return {
      ts: parseInt(parts[0], 36),
      counter: parseInt(parts[1], 36),
      nodeId: parts.slice(2).join('-')
    };
  }
}
