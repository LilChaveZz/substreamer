import * as ExpoCrypto from 'expo-crypto';
import { Platform } from 'react-native';

import { authStore } from '../../store/authStore';
import { connectivityStore } from '../../store/connectivityStore';
import { jamStore } from '../../store/jamStore';
import { errMessage } from '../../utils/errorMessage';
import { normalizeServerUrl } from '../subsonicService';
import { ClockSync } from './clockSync';
import {
  encodeJamEnvelope,
  parseJamEnvelope,
  parseJamRoomSnapshot,
  type JamEnvelope,
} from './jamProtocol';

const { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync, getRandomBytesAsync } = ExpoCrypto;
const MAX_RECONNECT_DELAY_MS = 30_000;

type RoomAction = { event: 'createRoom' } | { event: 'joinRoom'; roomId: string };

let enabled = false;
let socket: WebSocket | null = null;
let authenticated = false;
let shouldReconnect = false;
let roomId: string | null = null;
let pendingAction: RoomAction | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectivityUnsubscribe: (() => void) | null = null;
let clockSync: ClockSync | null = null;

export function getJamWebSocketUrl(serverUrl: string): string {
  const trimmedServerUrl = serverUrl.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmedServerUrl) && !/^https?:\/\//i.test(trimmedServerUrl)) {
    throw new Error('Nova-Jam requires an HTTP or HTTPS Subsonic server URL');
  }

  let url: URL;
  try {
    url = new URL(normalizeServerUrl(trimmedServerUrl));
  } catch {
    throw new Error('Invalid Subsonic server URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Nova-Jam requires an HTTP or HTTPS Subsonic server URL');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function startJamService(): void {
  if (Platform.OS !== 'android' || enabled) return;
  enabled = true;
  connectivityUnsubscribe = connectivityStore.subscribe((state, previous) => {
    if (state.hasConnection && !previous.hasConnection && shouldReconnect) {
      clearReconnectTimer();
      openSocket();
    }
  });
}

export function stopJamService(): void {
  enabled = false;
  shouldReconnect = false;
  authenticated = false;
  roomId = null;
  pendingAction = null;
  reconnectAttempt = 0;
  clearReconnectTimer();
  clockSync?.stop();
  clockSync = null;
  connectivityUnsubscribe?.();
  connectivityUnsubscribe = null;
  const current = socket;
  socket = null;
  current?.close();
  jamStore.getState().reset();
}

export function createJam(): void {
  requestRoom({ event: 'createRoom' });
}

export function joinJam(code: string): void {
  const normalizedCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(normalizedCode)) {
    jamStore.getState().setState({ status: 'error', error: 'invalidRoomCode' });
    return;
  }
  requestRoom({ event: 'joinRoom', roomId: normalizedCode });
}

export function leaveJam(): void {
  shouldReconnect = false;
  roomId = null;
  pendingAction = null;
  reconnectAttempt = 0;
  clearReconnectTimer();
  clockSync?.stop();
  clockSync = null;
  if (authenticated) send({ event: 'leaveRoom' });
  authenticated = false;
  const current = socket;
  socket = null;
  current?.close();
  jamStore.getState().reset();
}

export function sendJamTransport(data: {
  playing: boolean;
  positionMs: number;
  trackId: string;
  queue?: string[];
  queueIndex: number;
}): void {
  if (!authenticated || jamStore.getState().status !== 'active') return;
  send({
    event: 'transport',
    data: {
      ...data,
      clientTimeMs: Math.round(Date.now() + (clockSync?.offsetMs ?? 0)),
    },
  });
}

function requestRoom(action: RoomAction): void {
  if (Platform.OS !== 'android') return;
  if (!enabled) startJamService();
  shouldReconnect = true;
  pendingAction = action;
  if (action.event === 'createRoom') {
    roomId = null;
    jamStore.getState().setState({ roomId: null, snapshot: null, members: [] });
  } else {
    roomId = action.roomId;
    jamStore.getState().setState({ roomId: action.roomId, snapshot: null, members: [] });
  }
  jamStore.getState().setState({ status: 'connecting', error: null });
  if (authenticated) {
    sendRoomAction(action);
  } else {
    openSocket();
  }
}

function openSocket(): void {
  if (!enabled || !shouldReconnect) return;
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  const { isLoggedIn, serverUrl, username, password } = authStore.getState();
  if (!isLoggedIn || !serverUrl || !username || !password) {
    jamStore.getState().setState({ status: 'error', error: 'missingCredentials' });
    shouldReconnect = false;
    return;
  }

  let wsUrl: string;
  let normalizedServerUrl: string;
  try {
    normalizedServerUrl = normalizeServerUrl(serverUrl);
    wsUrl = getJamWebSocketUrl(normalizedServerUrl);
  } catch (error) {
    jamStore.getState().setState({ status: 'error', error: errMessage(error) });
    shouldReconnect = false;
    return;
  }

  try {
    const current = new WebSocket(wsUrl);
    socket = current;
    authenticated = false;
    current.onopen = () => {
      void authenticate(current, username, password, normalizedServerUrl);
    };
    current.onmessage = ({ data }) => {
      if (current !== socket || typeof data !== 'string') return;
      try {
        handleEnvelope(parseJamEnvelope(data));
      } catch (error) {
        jamStore.getState().setState({ status: 'error', error: errMessage(error) });
      }
    };
    current.onerror = () => {
      if (current === socket && !authenticated) {
        jamStore.getState().setState({ status: 'error', error: 'jamConnectionFailed' });
      }
    };
    current.onclose = () => {
      if (current !== socket) return;
      socket = null;
      authenticated = false;
      clockSync?.stop();
      clockSync = null;
      if (shouldReconnect && enabled) {
        jamStore.getState().setState({ status: roomId ? 'reconnecting' : 'connecting' });
        scheduleReconnect();
      } else {
        jamStore.getState().reset();
      }
    };
  } catch (error) {
    jamStore.getState().setState({ status: 'error', error: errMessage(error) });
    scheduleReconnect();
  }
}

async function authenticate(
  current: WebSocket,
  username: string,
  password: string,
  serverUrl: string,
): Promise<void> {
  try {
    const salt = Array.from(await getRandomBytesAsync(16), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const token = await digestStringAsync(
      CryptoDigestAlgorithm.MD5,
      password + salt,
      { encoding: CryptoEncoding.HEX },
    );
    if (current !== socket || current.readyState !== WebSocket.OPEN) return;
    send({
      event: 'authenticate',
      data: { serverUrl, username, token, salt },
    });
  } catch (error) {
    if (current !== socket) return;
    jamStore.getState().setState({ status: 'error', error: errMessage(error) });
    shouldReconnect = false;
    socket = null;
    current.close();
  }
}

function handleEnvelope(envelope: JamEnvelope): void {
  const data = envelope.data ?? {};
  switch (envelope.event) {
    case 'authenticated': {
      authenticated = true;
      reconnectAttempt = 0;
      jamStore.getState().setState({
        memberId: typeof data.memberId === 'string' ? data.memberId : null,
        rttMs: 0,
        clockOffsetMs: 0,
      });
      clockSync = new ClockSync(
        (t0) => send({ event: 'ping', data: { t0 } }),
        (rttMs, clockOffsetMs) => jamStore.getState().setState({ rttMs, clockOffsetMs }),
      );
      clockSync.start();
      jamStore.getState().setState({ status: roomId ? 'reconnecting' : 'connecting' });
      if (roomId) send({ event: 'joinRoom', data: { roomId } });
      else if (pendingAction) sendRoomAction(pendingAction);
      return;
    }
    case 'roomState': {
      if (!authenticated) return;
      const snapshot = parseJamRoomSnapshot(data);
      roomId = snapshot.roomId || roomId;
      pendingAction = null;
      jamStore.getState().setState({
        status: 'active',
        roomId,
        members: snapshot.members,
        snapshot,
        error: null,
      });
      return;
    }
    case 'pong':
      clockSync?.handlePong(
        typeof data.t0 === 'number' ? data.t0 : 0,
        typeof data.serverTimeMs === 'number' ? data.serverTimeMs : 0,
      );
      return;
    case 'error':
      jamStore.getState().setState({
        status: 'error',
        error: typeof data.message === 'string' ? data.message : 'jamUnknownError',
      });
      if (!authenticated) {
        shouldReconnect = false;
        const current = socket;
        socket = null;
        current?.close();
      }
      return;
    default:
      return;
  }
}

function sendRoomAction(action: RoomAction): void {
  send(action.event === 'createRoom'
    ? { event: 'createRoom' }
    : { event: 'joinRoom', data: { roomId: action.roomId } });
}

function send(message: JamEnvelope): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(encodeJamEnvelope(message.event, message.data ?? {}));
  }
}

function scheduleReconnect(): void {
  clearReconnectTimer();
  const delay = Math.min(1000 * (2 ** reconnectAttempt), MAX_RECONNECT_DELAY_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}
