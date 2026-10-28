export interface ClockSample {
  rttMs: number;
  offsetMs: number;
}

export function clockSample(t0: number, t2: number, serverTimeMs: number): ClockSample | null {
  if (![t0, t2, serverTimeMs].every(Number.isFinite) || t0 <= 0 || serverTimeMs <= 0) {
    return null;
  }
  const rttMs = Math.max(0, t2 - t0);
  return {
    rttMs,
    offsetMs: serverTimeMs - (t0 + t2) / 2,
  };
}

export class ClockSync {
  private bestRttMs = Number.POSITIVE_INFINITY;
  private interval: ReturnType<typeof setInterval> | null = null;
  private probeTimers: ReturnType<typeof setTimeout>[] = [];
  private pendingPings = new Set<number>();
  private offset = 0;
  private rtt = 0;

  constructor(
    private readonly sendPing: (t0: number) => void,
    private readonly onSample: (rttMs: number, offsetMs: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stop();
    this.bestRttMs = Number.POSITIVE_INFINITY;
    this.offset = 0;
    this.rtt = 0;
    this.probe();
    this.probeTimers = [
      setTimeout(() => this.probe(), 500),
      setTimeout(() => this.probe(), 1000),
    ];
    this.interval = setInterval(() => this.probe(), 10_000);
  }

  stop(): void {
    this.probeTimers.forEach(clearTimeout);
    this.probeTimers = [];
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    this.pendingPings.clear();
  }

  handlePong(t0: number, serverTimeMs: number): void {
    if (!this.pendingPings.delete(t0)) return;
    const sample = clockSample(t0, this.now(), serverTimeMs);
    if (!sample) return;

    this.rtt = sample.rttMs;
    if (sample.rttMs < this.bestRttMs) {
      this.bestRttMs = sample.rttMs;
      this.offset = sample.offsetMs;
    }
    this.onSample(this.rtt, this.offset);
  }

  get offsetMs(): number {
    return this.offset;
  }

  get rttMs(): number {
    return this.rtt;
  }

  private probe(): void {
    const t0 = this.now();
    this.pendingPings.add(t0);
    this.sendPing(t0);
  }
}
