import Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { BottomChrome } from '@/components/BottomChrome';
import { GradientBackground } from '@/components/GradientBackground';
import { useTheme } from '@/hooks/useTheme';
import { createJam, joinJam, leaveJam } from '@/services/jam/jamService';
import { jamStore } from '@/store/jamStore';
import { errMessage } from '@/utils/errorMessage';

const JAM_ERROR_KEYS: Record<string, string> = {
  invalidRoomCode: 'jamInvalidCode',
  missingCredentials: 'jamMissingCredentials',
  jamConnectionFailed: 'jamConnectionFailed',
  jamUnknownError: 'jamUnknownError',
  'Invalid Subsonic server URL': 'jamInvalidServerUrl',
  'Nova-Jam requires an HTTP or HTTPS Subsonic server URL': 'jamRequiresHttp',
  'Playback changed while applying the Nova-Jam queue': 'jamPlaybackChanged',
  'A Nova-Jam queue track is not available for playback': 'jamQueueUnavailable',
  'Nova-Jam current track is unavailable': 'jamCurrentTrackUnavailable',
};

export function JamScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const router = useRouter();
  const { code } = useLocalSearchParams<{ code?: string }>();
  const codeHandled = useRef<string | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const status = jamStore((state) => state.status);
  const roomId = jamStore((state) => state.roomId);
  const members = jamStore((state) => state.members);
  const rttMs = jamStore((state) => state.rttMs);
  const error = jamStore((state) => state.error);
  const isBusy = status === 'connecting' || status === 'reconnecting';
  const canStartRoom = !isBusy && status !== 'active';

  useEffect(() => {
    if (!code || codeHandled.current === code) return;
    codeHandled.current = code;
    setRoomCode(code.slice(0, 3).toUpperCase());
    joinJam(code);
  }, [code]);

  if (Platform.OS !== 'android') {
    return (
      <View style={[styles.unsupported, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.textSecondary }}>{t('jamAndroidOnly')}</Text>
      </View>
    );
  }

  const handleJoin = () => {
    if (!canStartRoom) return;
    setLocalError(null);
    joinJam(roomCode);
  };

  const handleCopyCode = () => {
    if (!roomId) return;
    void Clipboard.setStringAsync(roomId).catch((copyError: unknown) => {
      setLocalError(errMessage(copyError));
    });
  };

  const statusText = status === 'active'
    ? t('jamActive')
    : status === 'connecting'
      ? t('jamConnecting')
      : status === 'reconnecting'
        ? t('jamReconnecting')
        : status === 'error'
          ? t('jamError')
          : t('jamDisconnected');

  return (
    <>
      <Stack.Screen options={{ title: t('jamListening') }} />
      <GradientBackground scrollable>
        <ScrollView
          style={styles.container}
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: headerHeight + 20,
              paddingBottom: Math.max(insets.bottom, 24),
            },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{t('jamListening')}</Text>
            <Text style={[styles.description, { color: colors.textSecondary }]}>
              {t('jamDescription')}
            </Text>

            {roomId ? (
              <View style={[styles.roomCodePanel, { borderColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>{t('jamRoomCode')}</Text>
                <Text style={[styles.roomCode, { color: colors.textPrimary }]}>{roomId}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleCopyCode}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    { borderColor: colors.border },
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.secondaryButtonText, { color: colors.textPrimary }]}>
                    {t('jamCopyCode')}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <View style={styles.statusRow}>
              {isBusy ? <ActivityIndicator size="small" color={colors.primary} /> : null}
              <Text style={[styles.status, { color: status === 'active' ? colors.primary : colors.textSecondary }]}>
                {statusText}
              </Text>
              {status === 'active' ? (
                <Text style={[styles.statusDetail, { color: colors.textSecondary }]}>
                  {t('jamListenerCount', { count: members.length })}
                </Text>
              ) : null}
            </View>

            {status === 'active' ? (
              <View style={[styles.details, { borderTopColor: colors.border }]}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>
                  {t('jamLatency', { rtt: rttMs })}
                </Text>
                {members.map((member) => (
                  <Text key={member.id} style={[styles.member, { color: colors.textPrimary }]}>
                    {member.username}
                  </Text>
                ))}
              </View>
            ) : null}

            {error || localError ? (
              <Text accessibilityRole="alert" style={[styles.error, { color: colors.red }]}>
                {localError ?? (error
                  ? t(JAM_ERROR_KEYS[error] ?? (
                    error.startsWith('Nova-Jam track is unavailable:')
                      ? 'jamTrackUnavailable'
                      : error
                  ))
                  : null)}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={!canStartRoom}
              onPress={() => {
                setLocalError(null);
                createJam();
              }}
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: colors.primary },
                !canStartRoom && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>{t('jamCreateRoom')}</Text>
            </Pressable>

            <TextInput
              accessibilityLabel={t('jamRoomCode')}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={3}
              onChangeText={(value) => setRoomCode(value.toUpperCase())}
              placeholder={t('jamEnterCode')}
              placeholderTextColor={colors.textSecondary}
              returnKeyType="join"
              style={[
                styles.input,
                { borderColor: colors.border, color: colors.textPrimary },
              ]}
              value={roomCode}
              onSubmitEditing={handleJoin}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!canStartRoom || roomCode.trim().length !== 3}
              onPress={handleJoin}
              style={({ pressed }) => [
                styles.secondaryButton,
                { borderColor: colors.border },
                (!canStartRoom || roomCode.trim().length !== 3) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.textPrimary }]}>
                {t('jamJoinRoom')}
              </Text>
            </Pressable>

            {roomId ? (
              <Pressable
                accessibilityRole="button"
                onPress={leaveJam}
                style={({ pressed }) => [
                  styles.leaveButton,
                  { borderColor: colors.red },
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.red }]}>
                  {t('jamLeaveRoom')}
                </Text>
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={() => router.back()}
              style={styles.backButton}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.textSecondary }]}>
                {t('back')}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
        <BottomChrome withSafeAreaPadding />
      </GradientBackground>
    </>
  );
}

const styles = StyleSheet.create({
  unsupported: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  container: { flex: 1 },
  content: { paddingHorizontal: 16 },
  card: { borderRadius: 16, padding: 20 },
  title: { fontSize: 22, fontWeight: '700' },
  description: { fontSize: 15, lineHeight: 21, marginTop: 8 },
  roomCodePanel: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    marginTop: 20,
    padding: 16,
  },
  label: { fontSize: 14 },
  roomCode: { fontSize: 34, fontWeight: '700', letterSpacing: 6, marginVertical: 8 },
  statusRow: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 20 },
  status: { fontSize: 15, fontWeight: '600' },
  statusDetail: { fontSize: 14, marginLeft: 'auto' },
  details: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 16, paddingTop: 12 },
  member: { fontSize: 15, marginTop: 8 },
  error: { fontSize: 14, marginTop: 12 },
  primaryButton: { alignItems: 'center', borderRadius: 10, marginTop: 20, paddingVertical: 13 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    fontSize: 18,
    letterSpacing: 4,
    marginTop: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlign: 'center',
  },
  secondaryButton: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    marginTop: 10,
    paddingVertical: 12,
  },
  secondaryButtonText: { fontSize: 16, fontWeight: '600' },
  leaveButton: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    marginTop: 16,
    paddingVertical: 12,
  },
  backButton: { alignItems: 'center', marginTop: 12, paddingVertical: 10 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.4 },
});
