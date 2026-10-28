import { memo, useCallback, useState } from 'react';
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

interface ReorderableQueueRowProps {
  track: Child;
  index: number;
  currentTrackIndex: number | null;
  colors: ReorderableQueueListProps['colors'];
  onPress: ReorderableQueueListProps['onPress'];
  onLongPress: ReorderableQueueListProps['onLongPress'];
  onHandleHeld: () => void;
  onHandleReleased: () => void;
}

const ReorderableQueueRow = memo(function ReorderableQueueRow({
  track,
  index,
  currentTrackIndex,
  colors,
  onPress,
  onLongPress,
  onHandleHeld,
  onHandleReleased,
}: ReorderableQueueRowProps) {
  const drag = useReorderableDrag();
  const canReorder = index > (currentTrackIndex ?? -1);
  const handlePressIn = useCallback(() => {
    onHandleHeld();
    drag();
  }, [drag, onHandleHeld]);

  return (
    <QueueItemRow
      track={track}
      index={index}
      isActive={index === currentTrackIndex}
      colors={colors}
      onPress={onPress}
      onLongPress={onLongPress}
      onDragHandlePressIn={canReorder ? handlePressIn : undefined}
      onDragHandlePressOut={canReorder ? onHandleReleased : undefined}
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
  const handleHeldOn = useCallback(() => setHandleHeld(true), []);
  const handleHeldOff = useCallback(() => setHandleHeld(false), []);
  const releaseHandleOnDragEnd = useCallback(() => {
    'worklet';
    runOnJS(setHandleHeld)(false);
  }, []);

  const handleReorder = useCallback(({ from, to }: ReorderableListReorderEvent) => {
    const state = playerStore.getState();
    const activeIndex = state.currentTrackIndex ?? -1;
    const queueLength = state.queue.length;
    if (from <= activeIndex || from >= queueLength) return;

    const destination = Math.max(activeIndex + 1, Math.min(to, queueLength - 1));
    if (from === destination) return;

    void moveQueueItem(from, destination).catch(() => {
      playbackToastStore.getState().fail();
    });
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: Child; index: number }) => (
      <ReorderableQueueRow
        track={item}
        index={index}
        currentTrackIndex={currentTrackIndex}
        colors={colors}
        onPress={onPress}
        onLongPress={onLongPress}
        onHandleHeld={handleHeldOn}
        onHandleReleased={handleHeldOff}
      />
    ),
    [colors, currentTrackIndex, handleHeldOff, handleHeldOn, onLongPress, onPress],
  );
  const keyExtractor = useCallback(
    (item: Child, index: number) => `${item.id}-${index}`,
    [],
  );

  return (
    <ReorderableList
      data={queue}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      onReorder={handleReorder}
      onDragEnd={releaseHandleOnDragEnd}
      scrollEnabled={!handleHeld}
      onScrollBeginDrag={closeOpenRow}
      showsVerticalScrollIndicator={false}
      ListHeaderComponent={ListHeaderComponent ?? undefined}
      style={style}
      contentContainerStyle={contentContainerStyle}
    />
  );
});
