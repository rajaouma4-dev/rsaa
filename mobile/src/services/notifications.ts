import {AppState, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {TlsSignalingClient} from './signaling';
import {APP_CONFIG} from '../config';

type Registration = {installationId: string; token: string; configured: boolean; googleServices: boolean; enabled: boolean; receiptKey?: string};
const native = NativeModules.NexaNotifications;
const ASKED = 'nexa.notifications.permission.asked.v1';

export async function notificationStatus(): Promise<Registration | null> {
  return native ? native.getRegistration() : null;
}
export function notificationSettings() { native?.openSettings(); }
export async function clearNotificationAccount() { await native?.setAccount(null); }
export function recordIncomingNotification(uid: string, conversation: string, message: string,
  sender?: {name: string; avatar?: string | null; unread: number}) {
  // This also records foreground deliveries to suppress a delayed push duplicate.
  native?.showMessage(uid, conversation, message, sender?.name || 'Nexa Chat', sender?.avatar || null, sender?.unread || 1);
}

async function requestPermissionOnce() {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return;
  if (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) return;
  if (await AsyncStorage.getItem(ASKED)) return;
  await AsyncStorage.setItem(ASKED, '1');
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {
    title: 'New message alerts',
    message: 'Allow Nexa Chat to tell you about new messages when the app is in the background. You can change this in Settings.',
    buttonPositive: 'Continue', buttonNegative: 'Not now',
  });
}

/** One controller per signed-in account. It never stores authentication secrets. */
export function startNotifications(uid: string, getSignal: () => TlsSignalingClient | null,
  onOpen: (conversation: string) => void) {
  if (!native) return () => {};
  let disposed = false;
  let busy = false;
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
  const sync = async () => {
    if (disposed || busy) return;
    busy = true;
    try {
      const info = await notificationStatus();
      if (disposed || !info) return;
      installationId = info.installationId;
      if (AppState.currentState === 'active') {
        void drainOpen();
      }
      const signal = getSignal();
      if (!signal?.authenticated || !info.token) return;
      const enabled = info.enabled && info.configured && info.googleServices;
      const key = `${info.installationId}:${info.token}:${enabled}:${info.receiptKey || ''}`;
      const foreground = AppState.currentState === 'active';
      if (registeredSignal !== signal || registrationKey !== key) {
        await signal.request({type:'register_push', installation_id:info.installationId, token:info.token, enabled, foreground,receipt_key:info.receiptKey||null}, 'push_registered', 7000);
        if (disposed) return;
        registeredSignal = signal; registrationKey = key;
      }
      // Short lease prevents a killed app from looking foreground indefinitely.
      signal.send({type:'push_state', installation_id:info.installationId, foreground:AppState.currentState === 'active'});
    } catch { /* Retry on token refresh, reconnect or next bounded heartbeat. */ }
    finally { busy = false; }
  };
  void (async () => {
    await native.setAccount(uid);
    await native.configureServer?.(APP_CONFIG.SIGNALING_HOST);
    if (disposed) return;
    void drainOpen();
    await requestPermissionOnce();
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
  return () => { disposed = true; clearInterval(timer); appState.remove(); tokenChange.remove(); notificationOpen.remove(); };
}
