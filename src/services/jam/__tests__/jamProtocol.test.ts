import {
  encodeJamEnvelope,
  parseJamEnvelope,
  parseJamRoomSnapshot,
} from '../jamProtocol';

describe('Nova-Jam protocol', () => {
  it('encodes events with data and event-only messages', () => {
    expect(encodeJamEnvelope('joinRoom', { roomId: 'A7K' })).toBe(
      '{"event":"joinRoom","data":{"roomId":"A7K"}}',
    );
    expect(encodeJamEnvelope('createRoom')).toBe('{"event":"createRoom","data":{}}');
  });

  it('rejects malformed envelopes and normalizes missing data', () => {
    expect(() => parseJamEnvelope('{')).toThrow();
    expect(() => parseJamEnvelope('{"event":1}')).toThrow('Invalid Nova-Jam message envelope');
    expect(parseJamEnvelope('{"event":"createRoom"}')).toEqual({
      event: 'createRoom',
      data: {},
    });
  });

  it('normalizes room snapshots without trusting optional fields', () => {
    expect(parseJamRoomSnapshot({
      roomId: 'A7K',
      seq: 4,
      members: [{ id: 'm1' }, null, { username: 'no-id' }],
      transport: {
        playing: true,
        positionMs: 500,
        trackId: 'song-1',
        queue: ['song-1', 42],
        queueIndex: 0,
      },
    })).toEqual({
      roomId: 'A7K',
      seq: 4,
      members: [{ id: 'm1', username: 'Anonymous' }],
      transport: {
        playing: true,
        positionMs: 500,
        trackId: 'song-1',
        queue: ['song-1'],
        queueIndex: 0,
        serverTimeMs: 0,
      },
    });
  });
});
