import { Fragment, memo, useCallback, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import ReorderableList, {
  useReorderableDrag,
  type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';
import { runOnJS } from 'react-native-reanimated';

import { QueueItemRow } from '../QueueItemRow';
import { closeOpenRow } from '../SwipeableRow';
import { type ThemeColors } from '../../constants/theme';
import { playbackToastStore } from '../../store/playbackToastStore';
import { playerStore } from '../../store/playerStore';
import { moveQueueItem } from '../../services/playerService';
import { type Child } from '../../services/subsonicService';

interface ReorderableQueueListProps {
  queue: Child[];
  currentTrackIndex: number | null;
  colors: Pick<ThemeColors, 'textPrimary' | 'textSecondary' | 'primary' | 'border' | 'red'>;
  onPress: (index: number) => void;
  onLongPress?: (track: Child) => void;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  ListHeaderComponent?: ReactElement | null;
}

interface QueueEntry {
  track: Child;
  key: string;
}

interface DragSnapshot {
  queue: Child[];
  currentTrackIndex: number | null;
}

interface ReorderableQueueRowProps {
  track: Child;
  index: number;
  colors: ReorderableQueueListProps['colors'];
  onPress: ReorderableQueueListProps['onPress'];
  onLongPress: ReorderableQueueListProps['onLongPress'];
  onHandleHeld: (track: Child, index: number) => boolean;
  onHandleReleased: () => void;
}

const ReorderableQueueRow = memo(function ReorderableQueueRow({
  track,
  index,
  colors,
  onPress,
  onLongPress,
  onHandleHeld,
  onHandleReleased,
}: ReorderableQueueRowProps) {
  const drag = useReorderableDrag();
  const handlePressIn = useCallback(() => {
    if (onHandleHeld(track, index)) drag();
  }, [drag, index, onHandleHeld, track]);

  return (
    <QueueItemRow
      track={track}
      index={index}
      isActive={false}
      colors={colors}
      onPress={onPress}
      onLongPress={onLongPress}
      onDragHandlePressIn={handlePressIn}
      onDragHandlePressOut={onHandleReleased}
    />
  );
});

export const ReorderableQueueList = memo(function ReorderableQueueList({
  queue,
  currentTrackIndex,
  colors,
  onPress,
  onLongPress,
  style,
  contentContainerStyle,
  ListHeaderComponent,
}: ReorderableQueueListProps) {
  const [handleHeld, setHandleHeld] = useState(false);
  const queueEntryKeys = useRef(new WeakMap<Child, string>());
  const nextQueueEntryKey = useRef(0);
  const dragSnapshot = useRef<DragSnapshot | null>(null);

  const entries = useMemo(() => {
    const occurrences = new Map<string, number>();
    return queue.map((track) => {
      let baseKey = queueEntryKeys.current.get(track);
      if (!baseKey) {
        baseKey = `queue-entry-${nextQueueEntryKey.current++}`;
        queueEntryKeys.current.set(track, baseKey);
      }

      const occurrence = occurrences.get(baseKey) ?? 0;
      occurrences.set(baseKey, occurrence + 1);
      return {
        track,
        key: occurrence === 0 ? baseKey : `${baseKey}#${occurrence}`,
      };
    });
  }, [queue]);
  const upcomingStart = Math.min(
    Math.max((currentTrackIndex ?? -1) + 1, 0),
    queue.length,
  );
  const fixedEntries = useMemo(
    () => entries.slice(0, upcomingStart),
    [entries, upcomingStart],
  );
  const upcomingEntries = useMemo(
    () => entries.slice(upcomingStart),
    [entries, upcomingStart],
  );

  const handleHeldOn = useCallback((track: Child, index: number) => {
    const state = playerStore.getState();
    const activeIndex = state.currentTrackIndex ?? -1;
    if (index <= activeIndex || state.queue[index] !== track) return false;

    dragSnapshot.current = {
      queue: [...state.queue],
      currentTrackIndex: state.currentTrackIndex,
    };
    setHandleHeld(true);
    return true;
  }, []);
  const handleHeldOff = useCallback(() => setHandleHeld(false), []);
  const releaseDrag = useCallback(() => {
    dragSnapshot.current = null;
    setHandleHeld(false);
  }, []);
  const releaseHandleOnDragEnd = useCallback(() => {
    'worklet';
    runOnJS(releaseDrag)();
  }, [releaseDrag]);

  const handleReorder = useCallback(({ from, to }: ReorderableListReorderEvent) => {
    const snapshot = dragSnapshot.current;
    if (!snapshot) return;

    const state = playerStore.getState();
    if (
      state.currentTrackIndex !== snapshot.currentTrackIndex
      || state.queue.length !== snapshot.queue.length
      || snapshot.queue.some((track, index) => track !== state.queue[index])
    ) {
      return;
    }

    const activeIndex = snapshot.currentTrackIndex ?? -1;
    const reorderableStart = activeIndex + 1;
    const queueLength = state.queue.length;
    const reorderableLength = queueLength - reorderableStart;
    if (
      !Number.isInteger(from)
      || !Number.isInteger(to)
      || from < 0
      || from >= reorderableLength
      || to < 0
      || to >= reorderableLength
    ) {
      return;
    }

    const source = reorderableStart + from;
    const destination = reorderableStart + to;
    if (source === destination) return;

    void moveQueueItem(source, destination).catch(() => {
      playbackToastStore.getState().fail();
    });
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: QueueEntry; index: number }) => (
      <ReorderableQueueRow
        track={item.track}
        index={upcomingStart + index}
        colors={colors}
        onPress={onPress}
        onLongPress={onLongPress}
        onHandleHeld={handleHeldOn}
        onHandleReleased={handleHeldOff}
      />
    ),
    [colors, currentTrackIndex, handleHeldOff, handleHeldOn, onLongPress, onPress, upcomingStart],
  );
  const keyExtractor = useCallback((item: QueueEntry) => item.key, []);
  const fixedRows = useMemo(
    () =>
      fixedEntries.map(({ track, key }, index) => (
        <QueueItemRow
          key={key}
          track={track}
          index={index}
          isActive={index === currentTrackIndex}
          colors={colors}
          onPress={onPress}
          onLongPress={onLongPress}
        />
      )),
    [colors, currentTrackIndex, fixedEntries, onLongPress, onPress],
  );
  const listHeader = useMemo(() => {
    if (!ListHeaderComponent && fixedRows.length === 0) return undefined;
    return (
      <Fragment>
        {ListHeaderComponent}
        {fixedRows}
      </Fragment>
    );
  }, [ListHeaderComponent, fixedRows]);

  return (
    <ReorderableList
      data={upcomingEntries}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      onReorder={handleReorder}
      onDragEnd={releaseHandleOnDragEnd}
      scrollEnabled={!handleHeld}
      onScrollBeginDrag={closeOpenRow}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={listHeader}
      style={style}
      contentContainerStyle={contentContainerStyle}
    />
  );
});
