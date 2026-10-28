import { AppState, Platform } from 'react-native';

import { getSongById as getLibrarySongById } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { jamStore } from '../../store/jamStore';
import { playerStore } from '../../store/playerStore';
import { errMessage } from '../../utils/errorMessage';
import {
  applyJamPlayback,
  subscribeToUserSeeks,
} from '../playerService';
import type { Child } from '../subsonicService';
import { getSongById } from '../subsonicService';
import { sendJamTransport } from './jamService';
import type { JamRoomSnapshot, JamTransport } from './jamProtocol';

const QUEUE_LIMIT = 100;
const SETTLE_MS = 400;
const SEEK_DEBOUNCE_MS = 300;
const APPLY_COOLDOWN_MS = 700;
const CLOCK_WAIT_MS = 3000;
const DRIFT_PLAYING_MS = 600;
const DRIFT_PAUSED_MS = 300;
const QUEUE_ONLY_TOLERANCE_MS = 300;
const CONTROL_TICK_MS = 1500;
const SEEK_START_MS = 500;
const COOLDOWN_MS = 4000;
const FUSE_WINDOW_MS = 30_000;
const FUSE_MAX_SEEKS = 2;
const LOCAL_ACTION_QUIET_MS = 2000;
const APPLY_QUIET_MS = 2500;
const MAX_QUEUE_LENGTH = QUEUE_LIMIT;

interface Timeline {
  positionMs: number;
  serverTimeMs: number;
  playing: boolean;
  trackId: string;
}

let started = false;
let applying = false;
let lastAppliedSeq = -1;
let timeline: Timeline | null = null;
let roomTrackId: string | null = null;
let roomPlaying: boolean | null = null;
let roomQueue: string[] = [];
let quietUntil = 0;
let progressUpdatedAt = Date.now();
let lastSignature = '';
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let seekTimer: ReturnType<typeof setTimeout> | null = null;
let controlTimer: ReturnType<typeof setInterval> | null = null;
let applyTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: JamRoomSnapshot | null = null;
let applyingSnapshots = false;
let hardSeekTimes: number[] = [];
let playerUnsubscribe: (() => void) | null = null;
let seekUnsubscribe: (() => void) | null = null;
let jamUnsubscribe: (() => void) | null = null;
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

export function startJamPlayerBridge(): void {
  if (Platform.OS !== 'android' || started) return;
  started = true;
  lastSignature = playerSignature(playerStore.getState());
  playerUnsubscribe = playerStore.subscribe((state, previous) => {
    const signature = playerSignature(state);
    if (signature === lastSignature) {
      if (state.position !== previous.position) progressUpdatedAt = Date.now();
      return;
    }
    lastSignature = signature;
    if (!applying) schedulePublish();
  });
  seekUnsubscribe = subscribeToUserSeeks(scheduleSeekPublish);
  jamUnsubscribe = jamStore.subscribe((state, previous) => {
    if (state.status !== 'active') {
      if (previous.status === 'active' || state.status === 'disconnected') resetRoomState();
      return;
    }
    if (previous.status !== 'active') lastAppliedSeq = -1;
    if (state.snapshot) enqueueSnapshot(state.snapshot);
  });
  appStateSubscription = AppState.addEventListener('change', () => {
    progressUpdatedAt = Date.now();
  });
  controlTimer = setInterval(controlTick, CONTROL_TICK_MS);
}

export function stopJamPlayerBridge(): void {
  started = false;
  applying = false;
  playerUnsubscribe?.();
  playerUnsubscribe = null;
  seekUnsubscribe?.();
  seekUnsubscribe = null;
  jamUnsubscribe?.();
  jamUnsubscribe = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (controlTimer) clearInterval(controlTimer);
  controlTimer = null;
  clearPendingTimers();
  pendingSnapshot = null;
  applyingSnapshots = false;
  resetRoomState();
}

function playerSignature(state: ReturnType<typeof playerStore.getState>): string {
  const queueIds = state.queue.map((track) => track.id);
  return JSON.stringify([
    state.currentTrack?.id ?? null,
    state.playbackState,
    state.currentTrackIndex,
    queueIds,
  ]);
}

function schedulePublish(): void {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishLocalState();
  }, SETTLE_MS);
}

function scheduleSeekPublish(positionSec: number): void {
  if (seekTimer) clearTimeout(seekTimer);
  seekTimer = setTimeout(() => {
    seekTimer = null;
    const state = playerStore.getState();
    if (applying || jamStore.getState().status !== 'active' || !state.currentTrack) return;
    publishLocalState(positionSec * 1000);
  }, SEEK_DEBOUNCE_MS);
}

function publishLocalState(positionMs?: number): void {
  const session = jamStore.getState();
  const state = playerStore.getState();
  const trackId = state.currentTrack?.id;
  if (applying || session.status !== 'active' || !trackId) return;

  const queue = state.queue
    .slice(Math.max(state.currentTrackIndex ?? 0, 0), MAX_QUEUE_LENGTH + (state.currentTrackIndex ?? 0))
    .map((track) => track.id);
  if (queue[0] !== trackId) queue.unshift(trackId);

  const playing = state.playbackState === 'playing' || state.playbackState === 'buffering';
  const sameTrackAndPlaying = trackId === roomTrackId && playing === roomPlaying;
  if (
    positionMs == null
    && sameTrackAndPlaying
    && queue.length === roomQueue.length
    && queue.every((id, index) => id === roomQueue[index])
  ) {
    return;
  }

  let position = positionMs ?? (
    sameTrackAndPlaying && timeline
      ? expectedAt(timeline.positionMs, timeline.serverTimeMs, timeline.playing, session.clockOffsetMs)
      : livePositionMs()
  );
  if (playing) position += session.rttMs / 2;

  quietUntil = Date.now() + LOCAL_ACTION_QUIET_MS;
  roomTrackId = trackId;
  roomPlaying = playing;
  roomQueue = queue;
  sendJamTransport({
    playing,
    positionMs: Math.max(0, Math.round(position)),
    trackId,
    queue: queue.length ? queue : undefined,
    queueIndex: 0,
  });
}

function enqueueSnapshot(snapshot: JamRoomSnapshot): void {
  pendingSnapshot = snapshot;
  if (applyingSnapshots) return;
  applyingSnapshots = true;
  void processSnapshots();
}

async function processSnapshots(): Promise<void> {
  try {
    while (pendingSnapshot) {
      const snapshot = pendingSnapshot;
      pendingSnapshot = null;
      if (snapshot.seq <= lastAppliedSeq) continue;
      lastAppliedSeq = snapshot.seq;
      await applySnapshot(snapshot);
    }
  } catch (error) {
    // Surface native queue or stream failures in the session details.
    jamStore.getState().setState({ status: 'error', error: errMessage(error) });
  } finally {
    applyingSnapshots = false;
    if (pendingSnapshot) enqueueSnapshot(pendingSnapshot);
  }
}

async function applySnapshot(snapshot: JamRoomSnapshot): Promise<void> {
  const transport = snapshot.transport;
  await waitForClockSample();

  const remoteTrackId = transport.trackId.trim();
  if (!remoteTrackId) {
    if (playerStore.getState().currentTrack) publishLocalState();
    return;
  }

  const previousTimeline = timeline;
  const previousTrack = roomTrackId;
  const previousPlaying = roomPlaying;
  const nextTimeline: Timeline = {
    positionMs: transport.positionMs,
    serverTimeMs: transport.serverTimeMs,
    playing: transport.playing,
    trackId: remoteTrackId,
  };
  const session = jamStore.getState();
  const queueOnlyEvent = Boolean(
    previousTimeline
    && previousTimeline.trackId === remoteTrackId
    && previousTrack === remoteTrackId
    && previousPlaying === transport.playing
    && Math.abs(
      expectedAt(
        previousTimeline.positionMs,
        previousTimeline.serverTimeMs,
        previousTimeline.playing,
        session.clockOffsetMs,
      ) - expectedAt(
        nextTimeline.positionMs,
        nextTimeline.serverTimeMs,
        nextTimeline.playing,
        session.clockOffsetMs,
      ),
    ) < QUEUE_ONLY_TOLERANCE_MS,
  );

  roomTrackId = remoteTrackId;
  roomPlaying = transport.playing;
  roomQueue = transport.queue;
  timeline = nextTimeline;

  const ids = queueFromTransport(transport, remoteTrackId);
  applying = true;
  if (publishTimer) clearTimeout(publishTimer);
  if (seekTimer) clearTimeout(seekTimer);
  publishTimer = null;
  seekTimer = null;
  try {
    const songs = await resolveQueue(ids);
    const sameCurrentTrack = remoteTrackId === playerStore.getState().currentTrack?.id;
    const positionMs = expectedAt(
      transport.positionMs,
      transport.serverTimeMs,
      transport.playing,
      jamStore.getState().clockOffsetMs,
    );

    if (queueOnlyEvent && sameCurrentTrack) {
      await applyJamPlayback(songs, undefined, transport.playing, true, false);
      quietUntil = Date.now() + APPLY_QUIET_MS;
      return;
    }

    let positionToApply: number | undefined;
    if (!sameCurrentTrack) {
      positionToApply = positionMs / 1000;
    } else {
      const drift = Math.abs(livePositionMs() - positionMs);
      const threshold = transport.playing ? DRIFT_PLAYING_MS : DRIFT_PAUSED_MS;
      if (positionMs >= 0 && drift > threshold) positionToApply = positionMs / 1000;
    }

    await applyJamPlayback(
      songs,
      positionToApply,
      transport.playing,
      sameCurrentTrack,
      true,
    );
    quietUntil = Date.now() + APPLY_QUIET_MS;
    if (applyTimer) clearTimeout(applyTimer);
    await new Promise<void>((resolve) => {
      applyTimer = setTimeout(() => {
        applyTimer = null;
        resolve();
      }, APPLY_COOLDOWN_MS);
    });
  } finally {
    applying = false;
  }
}

function queueFromTransport(transport: JamTransport, currentTrackId: string): string[] {
  if (transport.queue.length === 0) return [currentTrackId];
  const preferredIndex = Number.isInteger(transport.queueIndex)
    ? Math.max(0, Math.min(transport.queueIndex, transport.queue.length - 1))
    : 0;
  const trackIndex = transport.queue[preferredIndex] === currentTrackId
    ? preferredIndex
    : transport.queue.indexOf(currentTrackId);
  const ids = trackIndex >= 0 ? transport.queue.slice(trackIndex) : [currentTrackId];
  return ids.slice(0, QUEUE_LIMIT);
}

async function resolveQueue(ids: string[]): Promise<Child[]> {
  const localQueue = playerStore.getState().queue;
  const localSongs = new Map(localQueue.map((song) => [song.id, song]));
  const db = getDb();
  const songs: Child[] = [];
  for (const id of ids) {
    const localSong = localSongs.get(id);
    if (localSong) {
      songs.push(localSong);
      continue;
    }
    const librarySong = db ? await getLibrarySongById(db, id) : null;
    const song = librarySong ?? await getSongById(id);
    if (!song) throw new Error(`Nova-Jam track is unavailable: ${id}`);
    songs.push(song);
  }
  return songs;
}

function expectedAt(
  positionMs: number,
  serverTimeMs: number,
  playing: boolean,
  clockOffsetMs: number,
): number {
  if (!playing || serverTimeMs <= 0) return positionMs;
  return positionMs + ((Date.now() + clockOffsetMs) - serverTimeMs);
}

function livePositionMs(): number {
  const state = playerStore.getState();
  const elapsedMs = state.playbackState === 'playing'
    ? Math.max(0, Date.now() - progressUpdatedAt)
    : 0;
  const position = state.position * 1000 + elapsedMs;
  return state.duration > 0
    ? Math.min(position, state.duration * 1000)
    : position;
}

function controlTick(): void {
  const session = jamStore.getState();
  const currentTimeline = timeline;
  const now = Date.now();
  if (!currentTimeline || applying || now < quietUntil) return;
  if (session.status !== 'active') return;

  const state = playerStore.getState();
  const buffering = state.queueLoading
    || state.playbackState === 'buffering'
    || state.playbackState === 'loading';
  if (
    !currentTimeline.playing
    || state.playbackState !== 'playing'
    || state.currentTrack?.id !== currentTimeline.trackId
    || buffering
  ) return;

  const expected = expectedAt(
    currentTimeline.positionMs,
    currentTimeline.serverTimeMs,
    currentTimeline.playing,
    session.clockOffsetMs,
  );
  const drift = livePositionMs() - expected;
  if (Math.abs(drift) <= SEEK_START_MS || expected < 0) return;

  hardSeekTimes = hardSeekTimes.filter((time) => now - time <= FUSE_WINDOW_MS);
  if (hardSeekTimes.length >= FUSE_MAX_SEEKS) return;
  hardSeekTimes.push(now);
  quietUntil = now + COOLDOWN_MS;
  applying = true;
  void applyJamPlayback(
    [state.currentTrack, ...state.queue.slice((state.currentTrackIndex ?? 0) + 1)],
    expected / 1000,
    true,
    true,
  ).catch((error: unknown) => {
    jamStore.getState().setState({ status: 'error', error: errMessage(error) });
  }).finally(() => {
    applying = false;
  });
}

function waitForClockSample(): Promise<void> {
  if (jamStore.getState().rttMs > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = jamStore.subscribe((state) => {
      if (state.rttMs > 0) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve();
    }, CLOCK_WAIT_MS);
  });
}

function resetRoomState(): void {
  timeline = null;
  roomTrackId = null;
  roomPlaying = null;
  roomQueue = [];
  lastAppliedSeq = -1;
  hardSeekTimes = [];
  quietUntil = 0;
}

function clearPendingTimers(): void {
  if (publishTimer) clearTimeout(publishTimer);
  if (seekTimer) clearTimeout(seekTimer);
  if (applyTimer) clearTimeout(applyTimer);
  publishTimer = null;
  seekTimer = null;
  applyTimer = null;
}
