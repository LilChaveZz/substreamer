import { Platform } from 'react-native';
import { digestStringAsync } from 'expo-crypto';

import { authStore } from '../../../store/authStore';
import { connectivityStore } from '../../../store/connectivityStore';
import { jamStore } from '../../../store/jamStore';
import {
  createJam,
  getJamWebSocketUrl,
  joinJam,
  leaveJam,
  sendJamTransport,
  startJamService,
  stopJamService,
} from '../jamService';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { MD5: 'MD5' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: jest.fn().mockResolvedValue('md5-token'),
  getRandomBytesAsync: jest.fn().mockResolvedValue(new Uint8Array([10, 255])),
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = jest.fn();
  close = jest.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  });

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  disconnect(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }
}

describe('jamService', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const sockets: MockWebSocket[] = [];

  beforeAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: class extends MockWebSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      } as unknown as typeof WebSocket,
    });
  });

  afterAll(() => {
    if (platformDescriptor) Object.defineProperty(Platform, 'OS', platformDescriptor);
    if (webSocketDescriptor) Object.defineProperty(globalThis, 'WebSocket', webSocketDescriptor);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  });

  beforeEach(() => {
    jest.useFakeTimers();
    sockets.length = 0;
    jamStore.getState().reset();
    connectivityStore.getState().setHasConnection(true);
    authStore.setState({
      isLoggedIn: true,
      serverUrl: 'https://music.example.com/subsonic',
      username: 'alice',
      password: 'secret',
    });
  });

  afterEach(() => {
    stopJamService();
    jest.useRealTimers();
  });

  it('derives a WebSocket URL at the server origin', () => {
    expect(getJamWebSocketUrl('https://music.example.com/rest/')).toBe(
      'wss://music.example.com/ws',
    );
    expect(getJamWebSocketUrl('http://localhost:4533')).toBe('ws://localhost:4533/ws');
    expect(getJamWebSocketUrl('music.example.com')).toBe('wss://music.example.com/ws');
    expect(getJamWebSocketUrl('localhost:4533')).toBe('wss://localhost:4533/ws');
    expect(() => getJamWebSocketUrl('file:///music')).toThrow(
      'Nova-Jam requires an HTTP or HTTPS Subsonic server URL',
    );
    expect(() => getJamWebSocketUrl('not a url')).toThrow('Invalid Subsonic server URL');
  });

  it('rejects codes that are not three alphanumeric characters', () => {
    joinJam('AB-');

    expect(jamStore.getState()).toMatchObject({
      status: 'error',
      error: 'invalidRoomCode',
    });
    expect(sockets).toHaveLength(0);
  });

  it('does not open a socket on iOS', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    startJamService();
    createJam();
    expect(sockets).toHaveLength(0);
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  });

  it('reports missing credentials without opening a socket', () => {
    authStore.setState({ isLoggedIn: false });
    createJam();

    expect(jamStore.getState()).toMatchObject({
      status: 'error',
      error: 'missingCredentials',
    });
    expect(sockets).toHaveLength(0);
  });

  it('keeps authentication failures visible instead of resetting to disconnected', async () => {
    jest.mocked(digestStringAsync).mockRejectedValueOnce(new Error('digest failed'));
    startJamService();
    createJam();
    sockets[0].open();
    await Promise.resolve();
    await Promise.resolve();

    expect(jamStore.getState()).toMatchObject({
      status: 'error',
      error: 'digest failed',
    });
  });

  it('keeps a sidecar authentication error visible after closing the socket', () => {
    startJamService();
    createJam();
    sockets[0].receive({ event: 'error', data: { message: 'Authentication rejected' } });

    expect(jamStore.getState()).toMatchObject({
      status: 'error',
      error: 'Authentication rejected',
    });
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
  });

  it('authenticates, creates a room, and rejoins it after reconnecting', async () => {
    startJamService();
    createJam();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('wss://music.example.com/ws');

    sockets[0].open();
    await Promise.resolve();
    await Promise.resolve();
    const auth = sockets[0].send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find((message) => message.event === 'authenticate');
    expect(auth).toEqual({
      event: 'authenticate',
      data: {
        serverUrl: 'https://music.example.com/subsonic',
        username: 'alice',
        token: 'md5-token',
        salt: '0aff',
      },
    });

    sockets[0].receive({ event: 'authenticated', data: { memberId: 'member-1' } });
    expect(sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw as string).event))
      .toContain('createRoom');
    sockets[0].receive({
      event: 'roomState',
      data: {
        roomId: 'A7K',
        members: [{ id: 'member-1', username: 'alice' }],
        seq: 1,
        transport: { playing: false, positionMs: 0, trackId: '', queue: [], queueIndex: -1 },
      },
    });
    expect(jamStore.getState()).toMatchObject({
      status: 'active',
      roomId: 'A7K',
      memberId: 'member-1',
    });

    sockets[0].disconnect();
    await jest.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await Promise.resolve();
    await Promise.resolve();
    sockets[1].receive({ event: 'authenticated', data: { memberId: 'member-2' } });
    expect(sockets[1].send.mock.calls.map(([raw]) => JSON.parse(raw as string)))
      .toContainEqual({ event: 'joinRoom', data: { roomId: 'A7K' } });
  });

  it('publishes transport only for an authenticated active room and leaves cleanly', async () => {
    startJamService();
    createJam();
    sockets[0].open();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].receive({ event: 'authenticated', data: { memberId: 'm1' } });
    sendJamTransport({ playing: false, positionMs: 0, trackId: '', queueIndex: -1 });
    expect(sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw as string).event))
      .not.toContain('transport');

    sockets[0].receive({
      event: 'roomState',
      data: { roomId: 'A7K', members: [], seq: 1, transport: {} },
    });

    joinJam('a7k');
    sockets[0].receive({
      event: 'roomState',
      data: {
        roomId: 'A7K',
        members: [{ id: 'm1', username: 'alice' }],
        seq: 1,
        transport: { playing: false, positionMs: 0, trackId: '', queue: [], queueIndex: -1 },
      },
    });
    expect(sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw as string)))
      .toContainEqual({ event: 'joinRoom', data: { roomId: 'A7K' } });

    sendJamTransport({
      playing: true,
      positionMs: 2500,
      trackId: 'song-1',
      queue: ['song-1'],
      queueIndex: 0,
    });
    expect(sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw as string)))
      .toContainEqual(expect.objectContaining({
        event: 'transport',
        data: expect.objectContaining({ trackId: 'song-1', playing: true }),
      }));

    leaveJam();
    expect(sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw as string).event))
      .toContain('leaveRoom');
    expect(jamStore.getState().status).toBe('disconnected');
  });

  it('sends an integer clientTimeMs when clock synchronization has a fractional offset', async () => {
    startJamService();
    createJam();
    sockets[0].open();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].receive({ event: 'authenticated', data: { memberId: 'm1' } });

    const ping = sockets[0].send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find((message) => message.event === 'ping');
    await jest.advanceTimersByTimeAsync(1);
    sockets[0].receive({
      event: 'pong',
      data: { t0: ping.data.t0, serverTimeMs: ping.data.t0 },
    });
    expect(jamStore.getState().clockOffsetMs).toBe(-0.5);
    sockets[0].receive({
      event: 'roomState',
      data: {
        roomId: 'A7K',
        members: [{ id: 'm1', username: 'alice' }],
        seq: 1,
        transport: { playing: false, positionMs: 0, trackId: '', queue: [], queueIndex: -1 },
      },
    });

    sendJamTransport({
      playing: true,
      positionMs: 1500,
      trackId: 'song-1',
      queueIndex: 0,
    });

    const transport = sockets[0].send.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .find((message) => message.event === 'transport');
    expect(transport.data.clientTimeMs).toBe(Math.round(transport.data.clientTimeMs));
  });

  it('reopens immediately when connectivity returns during a room session', async () => {
    connectivityStore.getState().setHasConnection(false);
    startJamService();
    createJam();
    sockets[0].disconnect();

    connectivityStore.getState().setHasConnection(true);

    expect(sockets).toHaveLength(2);
  });

  it('stops reconnecting when the user session ends', () => {
    startJamService();
    createJam();
    sockets[0].disconnect();
    stopJamService();

    expect(jamStore.getState().status).toBe('disconnected');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('surfaces malformed WebSocket messages instead of processing them', () => {
    startJamService();
    createJam();
    sockets[0].receive({ event: 'not-an-envelope' });
    sockets[0].onmessage?.({ data: '{' } as MessageEvent);

    expect(jamStore.getState()).toMatchObject({ status: 'error' });
  });

  it('does not open duplicate sockets while connecting or already connected', async () => {
    startJamService();
    createJam();
    createJam();
    expect(sockets).toHaveLength(1);

    sockets[0].open();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].receive({ event: 'authenticated', data: { memberId: 'm1' } });
    joinJam('A7K');
    expect(sockets).toHaveLength(1);
  });

  it('reports a WebSocket error before authentication', () => {
    startJamService();
    createJam();
    sockets[0].onerror?.({} as Event);

    expect(jamStore.getState()).toMatchObject({
      status: 'error',
      error: 'jamConnectionFailed',
    });
  });

  it('does not accept room state before authentication or non-string messages', () => {
    startJamService();
    createJam();
    sockets[0].receive({
      event: 'roomState',
      data: { roomId: 'A7K', members: [], seq: 1, transport: {} },
    });
    sockets[0].onmessage?.({ data: { event: 'authenticated' } } as unknown as MessageEvent);

    expect(jamStore.getState().status).toBe('connecting');
  });

  it('reports invalid server URLs without attempting a connection', () => {
    authStore.setState({ serverUrl: 'not a URL' });
    createJam();

    expect(jamStore.getState()).toMatchObject({
      status: 'error',
      error: 'Invalid Subsonic server URL',
    });
    expect(sockets).toHaveLength(0);
  });

  it('normalizes the saved server URL for the socket and authentication request', async () => {
    authStore.setState({ serverUrl: 'music.example.com/rest' });
    createJam();

    expect(sockets[0].url).toBe('wss://music.example.com/ws');

    sockets[0].open();
    await Promise.resolve();
    await Promise.resolve();

    const auth = sockets[0].send.mock.calls
      .map(([message]) => JSON.parse(message as string))
      .find((message) => message.event === 'authenticate');
    expect(auth.data.serverUrl).toBe('https://music.example.com');
  });
});
