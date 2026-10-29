import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { Child } from '../../../services/subsonicService';

interface CapturedQueueEntry {
  track: Child;
  key: string;
}

interface CapturedListProps {
  data: CapturedQueueEntry[];
  renderItem: (info: { item: CapturedQueueEntry; index: number }) => React.ReactElement;
  keyExtractor: (item: CapturedQueueEntry, index: number) => string;
  onReorder: (event: { from: number; to: number }) => void;
  onDragEnd: (event: { from: number; to: number }) => void;
  scrollEnabled: boolean;
  ListHeaderComponent?: React.ReactElement;
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
      keyExtractor,
      ListHeaderComponent,
      ...props
    }: CapturedListProps) => {
      mockCaptureListProps({ data, renderItem, keyExtractor, ListHeaderComponent, ...props });
      return (
        <View testID="reorderable-list">
          {ListHeaderComponent}
          {data.map((item, index) => (
            <View key={keyExtractor(item, index)}>
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
      index,
      onPress,
      onDragHandlePressIn,
    }: {
      track: Child;
      index: number;
      onPress: (index: number) => void;
      onDragHandlePressIn?: () => void;
    }) => (
      <View>
        <Text>{track.id}</Text>
        <Pressable testID={`row-press-${index}`} onPress={() => onPress(index)} />
        {onDragHandlePressIn && (
          <Pressable
            testID={`drag-handle-${track.id}`}
            onPressIn={onDragHandlePressIn}
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

function enterReorderMode() {
  fireEvent.press(screen.getByTestId('queue-reorder-mode-toggle'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMoveQueueItem.mockResolvedValue(undefined);
  mockPlayerState = { currentTrackIndex: 1, queue };
});

describe('ReorderableQueueList', () => {
  it('shows the edit control for upcoming tracks and hides handles before editing', () => {
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

    expect(latestListProps().data.map((entry) => entry.track.id)).toEqual([
      'upcoming-1',
      'upcoming-2',
    ]);
    expect(screen.getByTestId('row-press-0')).toBeTruthy();
    expect(screen.getByTestId('row-press-1')).toBeTruthy();
    expect(screen.queryByTestId('drag-handle-played')).toBeNull();
    expect(screen.queryByTestId('drag-handle-active')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByTestId('drag-handle-upcoming-1')).toBeNull();
    expect(screen.queryByTestId('drag-handle-upcoming-2')).toBeNull();
  });

  it('disables scrolling for reorder mode and restores it only after Done', () => {
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

    expect(latestListProps().scrollEnabled).toBe(true);
    enterReorderMode();
    expect(latestListProps().scrollEnabled).toBe(false);
    expect(screen.getByTestId('drag-handle-upcoming-1')).toBeTruthy();
    expect(screen.getByTestId('drag-handle-upcoming-2')).toBeTruthy();

    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    expect(mockDrag).toHaveBeenCalledTimes(1);
    act(() => latestListProps().onDragEnd({ from: 0, to: 0 }));
    expect(latestListProps().scrollEnabled).toBe(false);

    enterReorderMode();
    expect(latestListProps().scrollEnabled).toBe(true);
    expect(screen.queryByTestId('drag-handle-upcoming-1')).toBeNull();
  });

  it('keeps Done available if the queue shrinks while reordering', () => {
    const { rerender } = render(
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

    enterReorderMode();
    rerender(
      <ReorderableQueueList
        queue={queue.slice(0, 3)}
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

    expect(latestListProps().scrollEnabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    enterReorderMode();
    expect(latestListProps().scrollEnabled).toBe(true);
    expect(screen.queryByTestId('queue-reorder-mode-toggle')).toBeNull();
  });

  it('keeps fixed-row presses mapped to their queue indexes', () => {
    const onPress = jest.fn();
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
        onPress={onPress}
      />,
    );

    fireEvent.press(screen.getByTestId('row-press-0'));
    fireEvent.press(screen.getByTestId('row-press-1'));
    fireEvent.press(screen.getByTestId('row-press-2'));
    expect(onPress.mock.calls).toEqual([[0], [1], [2]]);
  });

  it('preserves custom list header content before the fixed queue rows', () => {
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
        ListHeaderComponent={<Text>Queue controls</Text>}
      />,
    );

    expect(screen.getByText('Queue controls')).toBeTruthy();
    expect(screen.getByTestId('row-press-0')).toBeTruthy();
  });

  it('makes the full queue reorderable when there is no active track', () => {
    mockPlayerState = { currentTrackIndex: null, queue };
    render(
      <ReorderableQueueList
        queue={queue}
        currentTrackIndex={null}
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

    expect(latestListProps().data.map((entry) => entry.track.id)).toEqual([
      'played',
      'active',
      'upcoming-1',
      'upcoming-2',
    ]);
    expect(latestListProps().ListHeaderComponent).toBeUndefined();
  });

  it('keeps reorder snapshots while dragging', () => {
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

    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    expect(latestListProps().scrollEnabled).toBe(false);
    expect(mockDrag).toHaveBeenCalledTimes(1);

    act(() => latestListProps().onDragEnd({ from: 0, to: 0 }));
    expect(latestListProps().scrollEnabled).toBe(false);
  });

  it('clears the drag snapshot when the item did not move', () => {
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

    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    latestListProps().onDragEnd({ from: 0, to: 0 });
    latestListProps().onReorder({ from: 0, to: 1 });
    expect(mockMoveQueueItem).not.toHaveBeenCalled();
  });

  it('maps reorder indexes to the upcoming section of the queue', () => {
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

    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-2'), 'pressIn');
    latestListProps().onDragEnd({ from: 1, to: 0 });
    latestListProps().onReorder({ from: 1, to: 0 });
    expect(mockMoveQueueItem).toHaveBeenCalledWith(3, 2);
  });

  it('ignores reorder events without a valid drag snapshot or indexes', () => {
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

    latestListProps().onReorder({ from: 0, to: 1 });
    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    latestListProps().onReorder({ from: -1, to: 0 });
    latestListProps().onReorder({ from: 0, to: 2 });
    latestListProps().onReorder({ from: 0.5, to: 1 });
    latestListProps().onReorder({ from: 0, to: 0 });
    expect(mockMoveQueueItem).not.toHaveBeenCalled();
  });

  it('does not start dragging a row that no longer matches the player queue', () => {
    const staleQueue = [...queue];
    staleQueue[2] = { ...queue[2] };
    render(
      <ReorderableQueueList
        queue={staleQueue}
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

    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    expect(mockDrag).not.toHaveBeenCalled();
    expect(latestListProps().scrollEnabled).toBe(false);
  });

  it('rejects a drop if playback advances during the drag', () => {
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

    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    mockPlayerState = { currentTrackIndex: 2, queue };
    latestListProps().onReorder({ from: 0, to: 1 });
    expect(mockMoveQueueItem).not.toHaveBeenCalled();
  });

  it('rejects a drop if the queue changes during the drag', () => {
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

    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    mockPlayerState = {
      currentTrackIndex: 1,
      queue: [queue[0], queue[1], queue[3], queue[2]],
    };
    latestListProps().onReorder({ from: 0, to: 1 });
    expect(mockMoveQueueItem).not.toHaveBeenCalled();
  });

  it('rejects a drop if the queue length changes during the drag', () => {
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

    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    mockPlayerState = {
      currentTrackIndex: 1,
      queue: [...queue, { id: 'new', title: 'New' } as Child],
    };
    latestListProps().onReorder({ from: 0, to: 1 });
    expect(mockMoveQueueItem).not.toHaveBeenCalled();
  });

  it('reports a move failure through the playback toast', async () => {
    mockMoveQueueItem.mockRejectedValue(new Error('move failed'));
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

    enterReorderMode();
    fireEvent(screen.getByTestId('drag-handle-upcoming-1'), 'pressIn');
    await act(async () => {
      latestListProps().onReorder({ from: 0, to: 1 });
      await Promise.resolve();
    });
    expect(mockFail).toHaveBeenCalledTimes(1);
  });

  it('keeps row keys stable through reordering and unique for repeated entries', () => {
    const { rerender } = render(
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

    const movedEntry = latestListProps().data[0];
    const originalKey = latestListProps().keyExtractor(movedEntry, 0);
    const reorderedQueue = [queue[0], queue[1], queue[3], queue[2]];
    mockPlayerState = { currentTrackIndex: 1, queue: reorderedQueue };
    rerender(
      <ReorderableQueueList
        queue={reorderedQueue}
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

    const sameEntryAfterMove = latestListProps().data.find(
      (entry) => entry.track === movedEntry.track,
    );
    expect(sameEntryAfterMove).toBeDefined();
    expect(latestListProps().keyExtractor(sameEntryAfterMove!, 1)).toBe(originalKey);

    const repeated = { id: 'repeat', title: 'Repeat' } as Child;
    rerender(
      <ReorderableQueueList
        queue={[queue[0], queue[1], repeated, repeated]}
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
    const repeatedKeys = latestListProps().data.map((entry, index) =>
      latestListProps().keyExtractor(entry, index),
    );
    expect(new Set(repeatedKeys).size).toBe(repeatedKeys.length);
  });
});
