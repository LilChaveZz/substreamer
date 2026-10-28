jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Platform: { OS: 'android' },
}));

const mockSendJamTransport = jest.fn();
jest.mock('../jamService', () => ({
  sendJamTransport: (...args: unknown[]) => mockSendJamTransport(...args),
}));

let mockUserSeekListener: ((position: number) => void) | null = null;
const mockSubscribeToUserSeeks = jest.fn((listener: (position: number) => void) => {
  mockUserSeekListener = listener;
  return jest.fn();
});
jest.mock('../../playerService', () => ({
  applyJamPlayback: jest.fn(),
  subscribeToUserSeeks: (...args: Parameters<typeof mockSubscribeToUserSeeks>) =>
    mockSubscribeToUserSeeks(...args),
}));

jest.mock('../../../db/repository/songs', () => ({
  getSongById: jest.fn(),
}));

jest.mock('../../../store/persistence/db', () => ({
  getDb: jest.fn(() => null),
}));

jest.mock('../../subsonicService', () => ({
  getSongById: jest.fn(),
}));

import { Platform } from 'react-native';
import { jamStore } from '../../../store/jamStore';
import { playerStore } from '../../../store/playerStore';
import { getSongById, type Child } from '../../subsonicService';
import { applyJamPlayback } from '../../playerService';
import type { JamRoomSnapshot } from '../jamProtocol';
import {
  startJamPlayerBridge,
  stopJamPlayerBridge,
} from '../jamPlayerBridge';

const mockApplyJamPlayback = jest.mocked(applyJamPlayback);

const song = (id: string): Child => ({
  id,
  title: `Song ${id}`,
  artist: 'Artist',
  album: 'Album',
  duration: 180,
} as Child);

function snapshot(
  seq: number,
  queue: string[],
  overrides: Partial<JamRoomSnapshot['transport']> = {},
): JamRoomSnapshot {
  return {
    roomId: 'A7K',
    members: [],
    seq,
    transport: {
      playing: true,
      positionMs: 1000,
      trackId: 'song-1',
      queue,
      queueIndex: 0,
      serverTimeMs: Date.now(),
      ...overrides,
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('jamPlayerBridge', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    mockSendJamTransport.mockReset();
    mockSubscribeToUserSeeks.mockClear();
    mockUserSeekListener = null;
    mockApplyJamPlayback.mockReset();
    mockApplyJamPlayback.mockImplementation(async (queue) => {
      playerStore.getState().setQueue(queue);
    });
    jest.mocked(getSongById).mockImplementation(async (id) => song(id));
    jamStore.getState().reset();
    playerStore.setState({
      currentTrack: song('song-1'),
      currentTrackIndex: 0,
      playbackState: 'playing',
      queue: [song('song-1')],
      position: 1,
      duration: 180,
      bufferedPosition: 0,
      queueLoading: false,
    });
  });

  afterEach(() => {
    stopJamPlayerBridge();
    jamStore.getState().reset();
    jest.useRealTimers();
  });

  it('applies remote queue snapshots without echoing them back as local transport', async () => {
    startJamPlayerBridge();
    startJamPlayerBridge();
    jamStore.getState().setState({ status: 'active', rttMs: 20 });
    jamStore.getState().setState({
      snapshot: snapshot(1, ['song-1', 'song-2']),
    });

    await jest.advanceTimersByTimeAsync(700);
    expect(mockApplyJamPlayback).toHaveBeenCalledWith(
      [song('song-1'), song('song-2')],
      undefined,
      true,
      true,
      true,
    );
    expect(mockSendJamTransport).not.toHaveBeenCalled();
  });

  it('updates a queue-only snapshot without seeking or changing transport', async () => {
    startJamPlayerBridge();
    jamStore.getState().setState({ status: 'active', rttMs: 20 });
    jamStore.getState().setState({ snapshot: snapshot(1, ['song-1', 'song-2']) });
    await jest.advanceTimersByTimeAsync(700);

    jest.setSystemTime(1_000_100);
    jamStore.getState().setState({
      snapshot: snapshot(2, ['song-1', 'song-3'], {
        positionMs: 1100,
        serverTimeMs: Date.now(),
      }),
    });
    await flushPromises();

    expect(mockApplyJamPlayback).toHaveBeenLastCalledWith(
      [song('song-1'), song('song-3')],
      undefined,
      true,
      true,
      false,
    );
    expect(mockSendJamTransport).not.toHaveBeenCalled();
  });

  it('publishes settled local playback changes and debounced seeks only in an active room', async () => {
    startJamPlayerBridge();
    playerStore.getState().setPlaybackState('paused');
    await jest.advanceTimersByTimeAsync(400);
    expect(mockSendJamTransport).not.toHaveBeenCalled();

    jamStore.getState().setState({ status: 'active' });
    playerStore.getState().setQueue([]);
    playerStore.getState().setPlaybackState('playing');
    await jest.advanceTimersByTimeAsync(100);
    playerStore.getState().setPlaybackState('paused');
    await jest.advanceTimersByTimeAsync(400);
    expect(mockSendJamTransport).toHaveBeenCalledWith(expect.objectContaining({
      playing: false,
      trackId: 'song-1',
      queue: ['song-1'],
      queueIndex: 0,
    }));

    mockSendJamTransport.mockClear();
    mockUserSeekListener?.(35);
    await jest.advanceTimersByTimeAsync(300);
    expect(mockSendJamTransport).toHaveBeenCalledWith(expect.objectContaining({
      positionMs: 35_000,
      trackId: 'song-1',
    }));
  });

  it('applies a remote track change at its clock-adjusted position', async () => {
    startJamPlayerBridge();
    jamStore.getState().setState({
      status: 'active',
      rttMs: 20,
      clockOffsetMs: 100,
    });
    jamStore.getState().setState({
      snapshot: snapshot(1, ['song-2', 'song-3'], {
        trackId: 'song-2',
        positionMs: 5000,
        serverTimeMs: Date.now() - 1000,
      }),
    });
    await jest.advanceTimersByTimeAsync(700);

    expect(mockApplyJamPlayback).toHaveBeenCalledWith(
      [song('song-2'), song('song-3')],
      6.1,
      true,
      false,
      true,
    );
    expect(mockSendJamTransport).not.toHaveBeenCalled();
  });

  it('waits briefly for the first clock sample before applying room state', async () => {
    startJamPlayerBridge();
    jamStore.getState().setState({ status: 'active', rttMs: 0 });
    jamStore.getState().setState({
      snapshot: snapshot(1, ['song-2'], { trackId: 'song-2' }),
    });
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockApplyJamPlayback).not.toHaveBeenCalled();

    jamStore.getState().setState({ rttMs: 20 });
    await jest.advanceTimersByTimeAsync(700);
    expect(mockApplyJamPlayback).toHaveBeenCalledTimes(1);
  });

  it('bounds hard drift corrections with the seek fuse', async () => {
    startJamPlayerBridge();
    jamStore.getState().setState({ status: 'active', rttMs: 20 });
    jamStore.getState().setState({ snapshot: snapshot(1, ['song-1']) });
    await jest.advanceTimersByTimeAsync(700);
    mockApplyJamPlayback.mockClear();

    playerStore.getState().setProgress(0, 180, 0);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockApplyJamPlayback).toHaveBeenCalledTimes(2);
    expect(mockApplyJamPlayback).toHaveBeenNthCalledWith(
      1,
      [song('song-1')],
      4,
      true,
      true,
    );
    expect(mockApplyJamPlayback).toHaveBeenNthCalledWith(
      2,
      [song('song-1')],
      8.5,
      true,
      true,
    );
  });

  it('does not start the bridge on iOS', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    startJamPlayerBridge();
    if (descriptor) Object.defineProperty(Platform, 'OS', descriptor);

    playerStore.getState().setPlaybackState('paused');
    expect(mockSubscribeToUserSeeks).not.toHaveBeenCalled();
  });

  it('reports an unresolved remote track and ignores stale snapshots', async () => {
    const { getSongById } = require('../../subsonicService');
    jest.mocked(getSongById).mockResolvedValue(null);
    startJamPlayerBridge();
    jamStore.getState().setState({ status: 'active', rttMs: 20 });
    jamStore.getState().setState({
      snapshot: snapshot(2, ['missing-song'], { trackId: 'missing-song' }),
    });
    await flushPromises();

    expect(jamStore.getState().status).toBe('error');
    expect(jamStore.getState().error).toContain('missing-song');
    expect(mockApplyJamPlayback).not.toHaveBeenCalled();

    jamStore.getState().setState({ status: 'active' });
    jamStore.getState().setState({
      snapshot: snapshot(2, ['song-1'], { trackId: 'song-1' }),
    });
    await jest.advanceTimersByTimeAsync(700);
    mockApplyJamPlayback.mockClear();
    jamStore.getState().setState({
      snapshot: snapshot(1, ['song-1'], { trackId: 'song-1' }),
    });
    await flushPromises();
    expect(mockApplyJamPlayback).not.toHaveBeenCalled();
  });

  it('publishes local transport when the room has no current track', async () => {
    startJamPlayerBridge();
    jamStore.getState().setState({ status: 'active', rttMs: 20 });
    jamStore.getState().setState({
      snapshot: snapshot(1, [], { trackId: '' }),
    });
    await flushPromises();

    expect(mockSendJamTransport).toHaveBeenCalledWith(expect.objectContaining({
      trackId: 'song-1',
      queue: ['song-1'],
    }));
  });

  it('does not publish transport after the bridge stops', async () => {
    startJamPlayerBridge();
    jamStore.getState().setState({ status: 'active' });
    playerStore.getState().setPlaybackState('paused');
    stopJamPlayerBridge();
    await jest.advanceTimersByTimeAsync(400);

    expect(mockSendJamTransport).not.toHaveBeenCalled();
  });
});
