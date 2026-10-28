let mockSearchParams: { code?: string } = {};
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ back: mockBack }),
}));

jest.mock('expo-router/react-navigation', () => ({
  HeaderHeightContext: require('react').createContext(0),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('@/components/BottomChrome', () => ({ BottomChrome: () => null }));
jest.mock('@/components/GradientBackground', () => ({
  GradientBackground: ({ children }: { children: React.ReactNode }) => children,
}));

const mockCreateJam = jest.fn();
const mockJoinJam = jest.fn();
const mockLeaveJam = jest.fn();
jest.mock('@/services/jam/jamService', () => ({
  createJam: (...args: unknown[]) => mockCreateJam(...args),
  joinJam: (...args: unknown[]) => mockJoinJam(...args),
  leaveJam: (...args: unknown[]) => mockLeaveJam(...args),
}));

const mockSetStringAsync = jest.fn();
jest.mock('expo-clipboard', () => ({
  setStringAsync: (...args: unknown[]) => mockSetStringAsync(...args),
}));

import React from 'react';
import { Platform } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import i18n from '../../i18n/i18n';
import { jamStore } from '../../store/jamStore';
import { JamScreen } from '../jam';

describe('JamScreen', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');

  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockCreateJam.mockReset();
    mockJoinJam.mockReset();
    mockLeaveJam.mockReset();
    mockBack.mockReset();
    mockSetStringAsync.mockReset().mockResolvedValue(undefined);
    mockSearchParams = {};
    jamStore.getState().reset();
  });

  afterAll(() => {
    if (platformDescriptor) Object.defineProperty(Platform, 'OS', platformDescriptor);
  });

  it('creates a room and joins a three-character alphanumeric code', () => {
    const screen = render(<JamScreen />);

    fireEvent.press(screen.getByText(i18n.t('jamCreateRoom')));
    expect(mockCreateJam).toHaveBeenCalledTimes(1);

    fireEvent.changeText(screen.getByLabelText(i18n.t('jamRoomCode')), 'a7k');
    fireEvent.press(screen.getByText(i18n.t('jamJoinRoom')));
    expect(mockJoinJam).toHaveBeenCalledWith('A7K');
  });

  it('shows room members, latency, reconnecting state, and leave action', () => {
    jamStore.getState().setState({
      status: 'active',
      roomId: 'A7K',
      members: [{ id: 'm1', username: 'Alice' }],
      rttMs: 42,
    });
    const screen = render(<JamScreen />);

    expect(screen.getByText('A7K')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText(i18n.t('jamLatency', { rtt: 42 }))).toBeTruthy();
    fireEvent.press(screen.getByText(i18n.t('jamLeaveRoom')));
    expect(mockLeaveJam).toHaveBeenCalledTimes(1);

    act(() => jamStore.getState().setState({ status: 'reconnecting' }));
    expect(screen.getByText(i18n.t('jamReconnecting'))).toBeTruthy();
    expect(screen.getByRole('button', { name: i18n.t('jamCreateRoom') }).props.accessibilityState?.disabled)
      .toBe(true);

    act(() => jamStore.getState().setState({ status: 'connecting' }));
    expect(screen.getByText(i18n.t('jamConnecting'))).toBeTruthy();
    act(() => jamStore.getState().setState({ status: 'error', error: 'jamConnectionFailed' }));
    expect(screen.getByText(i18n.t('jamError'))).toBeTruthy();
    expect(screen.getByText(i18n.t('jamConnectionFailed'))).toBeTruthy();
  });

  it('joins a room code from a route parameter only once and copies the active code', async () => {
    mockSearchParams = { code: 'A7K' };
    jamStore.getState().setState({
      status: 'active',
      roomId: 'A7K',
    });
    const screen = render(<JamScreen />);

    expect(mockJoinJam).toHaveBeenCalledWith('A7K');
    screen.rerender(<JamScreen />);
    expect(mockJoinJam).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText(i18n.t('jamCopyCode')));
    await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledWith('A7K'));
    fireEvent.press(screen.getByText(i18n.t('back')));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('shows clipboard errors to the user', async () => {
    jamStore.getState().setState({ status: 'active', roomId: 'A7K' });
    mockSetStringAsync.mockRejectedValue(new Error('Clipboard unavailable'));
    const screen = render(<JamScreen />);

    fireEvent.press(screen.getByText(i18n.t('jamCopyCode')));
    await waitFor(() => expect(screen.getByText('Clipboard unavailable')).toBeTruthy());
  });

  it('does not expose room controls on iOS', () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const screen = render(<JamScreen />);

    expect(screen.getByText(i18n.t('jamAndroidOnly'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('jamCreateRoom'))).toBeNull();
  });
});
