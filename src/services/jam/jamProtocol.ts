export interface JamEnvelope<T = Record<string, unknown>> {
  event: string;
  data?: T;
}

export interface JamMember {
  id: string;
  username: string;
}

export interface JamTransport {
  playing: boolean;
  positionMs: number;
  trackId: string;
  queue: string[];
  queueIndex: number;
  serverTimeMs: number;
}

export interface JamRoomSnapshot {
  roomId: string;
  members: JamMember[];
  seq: number;
  transport: JamTransport;
}

export function encodeJamEnvelope(
  event: string,
  data: Record<string, unknown> = {},
): string {
  return JSON.stringify({ event, data });
}

export function parseJamEnvelope(raw: string): JamEnvelope {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('event' in parsed)
    || typeof parsed.event !== 'string'
  ) {
    throw new Error('Invalid Nova-Jam message envelope');
  }
  const data = 'data' in parsed && typeof parsed.data === 'object' && parsed.data !== null
    ? parsed.data as Record<string, unknown>
    : {};
  return { event: parsed.event, data };
}

export function parseJamRoomSnapshot(data: Record<string, unknown>): JamRoomSnapshot {
  const rawTransport = data.transport;
  const transport = typeof rawTransport === 'object' && rawTransport !== null
    ? rawTransport as Record<string, unknown>
    : {};
  const rawMembers = Array.isArray(data.members) ? data.members : [];
  const rawQueue = Array.isArray(transport.queue) ? transport.queue : [];

  return {
    roomId: typeof data.roomId === 'string' ? data.roomId : '',
    members: rawMembers.flatMap((member): JamMember[] => {
      if (typeof member !== 'object' || member === null) return [];
      const record = member as Record<string, unknown>;
      if (typeof record.id !== 'string') return [];
      return [{
        id: record.id,
        username: typeof record.username === 'string' ? record.username : 'Anonymous',
      }];
    }),
    seq: finiteNumber(data.seq),
    transport: {
      playing: transport.playing === true,
      positionMs: finiteNumber(transport.positionMs),
      trackId: typeof transport.trackId === 'string' ? transport.trackId : '',
      queue: rawQueue.filter((id): id is string => typeof id === 'string'),
      queueIndex: finiteNumber(transport.queueIndex, -1),
      serverTimeMs: finiteNumber(transport.serverTimeMs),
    },
  };
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
