import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { Child } from '../../../services/subsonicService';

interface CapturedListProps {
  data: Child[];
  renderItem: (info: { item: Child; index: number }) => React.ReactElement;
  onReorder: (event: { from: number; to: number }) => void;
  onDragEnd: () => void;
  scrollEnabled: boolean;
}

const mockCaptureListProps = jest.fn<void, [CapturedListProps]>();
const mockDrag = jest.fn();
const mockMoveQueueItem = jest.fn<Promise<void>, [number, number]>();
const mockFail = jest.fn();
let mockPlayerState: { currentTrackIndex: number | null; queue: Child[] } = {
  currentTrackIndex: 1,
  queue: [],
};

jest.mock('react-native-reorderable-list', () => {
  const { View } = require('react-native');

  return {
    __esModule: true,
    default: ({
      data,
      renderItem,
      ...props
    }: CapturedListProps) => {
      mockCaptureListProps({ data, renderItem, ...props });
      return (
        <View testID="reorderable-list">
          {data.map((item, index) => (
            <View key={`${item.id}-${index}`}>
              {renderItem({ item, index })}
            </View>
          ))}
        </View>
      );
    },
    useReorderableDrag: () => mockDrag,
  };
});

jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return { ...actual, runOnJS: (callback: () => void) => callback };
});

jest.mock('../../QueueItemRow', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    QueueItemRow: ({
      track,
      onDragHandlePressIn,
      onDragHandlePressOut,
    }: {
      track: Child;
      onDragHandlePressIn?: () => void;
      onDragHandlePressOut?: () => void;
    }) => (
      <View>
        <Text>{track.id}</Text>
        {onDragHandlePressIn && (
          <Pressable
            testID={`drag-handle-${track.id}`}
            onPressIn={onDragHandlePressIn}
            onPressOut={onDragHandlePressOut}
          />
        )}
      </View>
    ),
  };
});

jest.mock('../../../services/playerService', () => ({
  moveQueueItem: (from: number, to: number) => mockMoveQueueItem(from, to),
}));

jest.mock('../../../store/playerStore', () => ({
  playerStore: { getState: () => mockPlayerState },
}));

jest.mock('../../../store/playbackToastStore', () => ({
  playbackToastStore: { getState: () => ({ fail: mockFail }) },
}));

import { ReorderableQueueList } from '../ReorderableQueueList';

const queue = [
  { id: 'played', title: 'Played' },
  { id: 'active', title: 'Active' },
  { id: 'upcoming-1', title: 'Upcoming 1' },
  { id: 'upcoming-2', title: 'Upcoming 2' },
] as Child[];

function latestListProps(): CapturedListProps {
  const latest = mockCaptureListProps.mock.calls.at(-1)?.[0];
  if (!latest) throw new Error('ReorderableList props were not captured');
  return latest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMoveQueueItem.mockResolvedValue(undefined);
  mockPlayerState = { currentTrackIndex: 1, queue };
});

describe('ReorderableQueueList', () => {
  it('shows drag handles only after the active track', () => {
    render(
      <ReorderableQueueList
        queue={queue}
        currentTrackIndex={1}
        colors={{
          textPrimary: '#fff',
          textSecondary: '#888',
          primary: '#f60',
          border: '#333',
          red: '#f00',
        }}
        onPress={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('drag-handle-played')).toBeNull();
    expect(screen.queryByTestId('drag-handle-active')).toBeNull();
    expect(screen.getByTestId('drag-handle-upcoming-1')).toBeTruthy();
    expect(screen.getByTestId('drag-handle-upcoming-2')).toBeTruthy();
  });

  it('locks scrolling from handle touch-down until the gesture ends', () => {
    render(
      <ReorderableQueueList
        queue={queue}
        currentTrackIndex={1}
        colors={{
          textPrimary: '#fff',
          textSecondary: '#888',
          primary: '#f60',
          border: '#333',
          red: '#f00',
        }}
        onPress={jest.fn()}
      />,
    );

    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    expect(latestListProps().scrollEnabled).toBe(false);
    expect(mockDrag).toHaveBeenCalledTimes(1);

    act(() => latestListProps().onDragEnd());
    expect(latestListProps().scrollEnabled).toBe(true);
  });

  it('clamps a drop to the upcoming region and ignores a drag after the active track', () => {
    render(
      <ReorderableQueueList
        queue={queue}
        currentTrackIndex={1}
        colors={{
          textPrimary: '#fff',
          textSecondary: '#888',
          primary: '#f60',
          border: '#333',
          red: '#f00',
        }}
        onPress={jest.fn()}
      />,
    );

    latestListProps().onReorder({ from: 3, to: 0 });
    expect(mockMoveQueueItem).toHaveBeenCalledWith(3, 2);

    latestListProps().onReorder({ from: 1, to: 3 });
    expect(mockMoveQueueItem).toHaveBeenCalledTimes(1);
  });
});
