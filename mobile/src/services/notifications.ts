import {AppState, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {TlsSignalingClient} from './signaling';
import {APP_CONFIG} from '../config';

type Registration = {installationId: string; token: string; configured: boolean; googleServices: boolean; enabled: boolean; headsUp?: boolean; receiptKey?: string; channelId?: string; soundEnabled?: boolean};
const native = NativeModules.NexaNotifications;
const ASKED = 'nexa.notifications.permission.asked.v1';

export async function notificationStatus(): Promise<Registration | null> {
  return native ? native.getRegistration() : null;
}
export function notificationSettings() { native?.openSettings(); }
let syncSoundSetting: (() => Promise<void>) | undefined;
export async function setNotificationSound(enabled: boolean) {
  await native?.setSoundEnabled(enabled);
  if (!syncSoundSetting) throw new Error('Sound saved on this phone. Reopen the app online to sync background alerts.');
  await syncSoundSetting();
}
export async function clearNotificationAccount() { await native?.setAccount(null); }
export function recordIncomingNotification(uid: string, conversation: string, message: string,
  sender?: {name: string; avatar?: string | null; unread: number}) {
  // This also records foreground deliveries to suppress a delayed push duplicate.
  native?.showMessage(uid, conversation, message, sender?.name || 'Nexa Chat', sender?.avatar || null, sender?.unread || 1);
}

let permissionRequest: Promise<void> | null = null;
export async function requestNotificationPermission(explicit = false): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (Number(Platform.Version) < 33 || await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) {
    if (explicit) notificationSettings();
    return;
  }
  // Android cannot reliably show a permission dialog while the activity is hidden.
  if (AppState.currentState !== 'active') return;
  if (!explicit && await AsyncStorage.getItem(ASKED)) return;
  if (permissionRequest) return permissionRequest;
  permissionRequest = (async () => {
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {
    title: 'New message alerts',
    message: 'Allow Nexa Chat to tell you about new messages when the app is in the background. You can change this in Settings.',
    buttonPositive: 'Continue', buttonNegative: 'Not now',
  });
  // A failed/interrupted native request must remain retryable on resume.
  await AsyncStorage.setItem(ASKED, '1');
  if (explicit && result === 'never_ask_again') notificationSettings();
  })();
  try { await permissionRequest; } finally { permissionRequest = null; }
}

/** One controller per signed-in account. It never stores authentication secrets. */
export function startNotifications(uid: string, getSignal: () => TlsSignalingClient | null,
  onOpen: (conversation: string) => void) {
  if (!native) return () => {};
  let disposed = false;
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let registrationKey = '';
  let registeredSignal: TlsSignalingClient | null = null;
  let installationId = '';
  let opening = false;
  let openAgain = false;
  const drainOpen = async () => {
    if (disposed) return;
    openAgain = true;
    if (opening) return;
    opening = true;
    try {
      while (openAgain && !disposed) {
        openAgain = false;
        const conversation = await native.consumeOpen(uid);
        if (!disposed && conversation) onOpen(conversation);
      }
    } catch { /* A pending native intent can be retried on resume or heartbeat. */ }
    finally { opening = false; }
  };
  const syncOnce = async () => {
    if (disposed) return;
    try {
      await requestNotificationPermission();
      const info = await notificationStatus();
      if (disposed || !info) return;
      installationId = info.installationId;
      if (AppState.currentState === 'active') {
        void drainOpen();
      }
      const signal = getSignal();
      if (!signal?.authenticated || !info.token) return;
      const enabled = info.enabled && info.configured && info.googleServices;
      const key = `${info.installationId}:${info.token}:${enabled}:${info.receiptKey || ''}:${info.channelId || 'nexa_messages_v1'}`;
      const foreground = AppState.currentState === 'active';
      if (registeredSignal !== signal || registrationKey !== key) {
        await signal.request({type:'register_push', installation_id:info.installationId, token:info.token, enabled, foreground,receipt_key:info.receiptKey||null,channel_id:info.channelId||'nexa_messages_v1'}, 'push_registered', 7000);
        if (disposed) return;
        registeredSignal = signal; registrationKey = key;
      }
      // Short lease prevents a killed app from looking foreground indefinitely.
      signal.send({type:'push_state', installation_id:info.installationId, foreground:AppState.currentState === 'active'});
    } catch { /* Retry on token refresh, reconnect or next bounded heartbeat. */ }
  };
  const sync = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    syncAgain = true;
    if (syncing) return syncing;
    syncing = (async () => {
      while (syncAgain && !disposed) { syncAgain = false; await syncOnce(); }
    })().finally(() => { syncing = null; if (syncAgain && !disposed) void sync(); });
    return syncing;
  };
  const syncSound = async () => {
    await sync();
    const info = await notificationStatus();
    const enabled = info && info.enabled && info.configured && info.googleServices;
    const key = info && `${info.installationId}:${info.token}:${enabled}:${info.receiptKey || ''}:${info.channelId || 'nexa_messages_v1'}`;
    if (!info || !registeredSignal?.authenticated || registeredSignal !== getSignal() || registrationKey !== key) {
      throw new Error('Sound saved on this phone. Keep the app online to sync background alerts.');
    }
  };
  syncSoundSetting = syncSound;
  void (async () => {
    await native.setAccount(uid);
    await native.configureServer?.(APP_CONFIG.SIGNALING_HOST);
    if (disposed) return;
    void drainOpen();
    if (!disposed) await sync();
  })().catch(() => {});
  const appState = AppState.addEventListener('change', next => {
    if (next === 'active') void drainOpen();
    // Do not wait for an in-flight registration: Android may suspend JS as soon
    // as Home is pressed. Clear the foreground lease while the socket is alive.
    const signal = getSignal();
    if (!disposed && installationId && signal?.authenticated) {
      try { signal.send({type:'push_state', installation_id:installationId, foreground:next === 'active'}); } catch {}
    }
    void sync();
  });
  const emitter = new NativeEventEmitter(native);
  const tokenChange = emitter.addListener('NexaPushTokenChanged', () => { void sync(); });
  const notificationOpen = emitter.addListener('NexaNotificationOpened', () => { void drainOpen(); });
  const timer = setInterval(() => { void sync(); }, 15000);
  return () => { disposed = true; if(syncSoundSetting===syncSound) syncSoundSetting=undefined; clearInterval(timer); appState.remove(); tokenChange.remove(); notificationOpen.remove(); };
}
