import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

const DEMO_KEY = 'nexa.demo.session.v1';
const LIVE_SERVICE = 'com.nexa.chat.session';

export type LiveSession = {
  uid: string;
  username: string;
  displayName: string;
  about: string;
  token: string;
};

// Demo-only identity is non-sensitive and may live in AsyncStorage.
export async function saveDemoSession(value: {username: string; displayName: string}) {
  await AsyncStorage.setItem(DEMO_KEY, JSON.stringify(value));
}
export async function readDemoSession() {
  const value = await AsyncStorage.getItem(DEMO_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {username?: unknown; displayName?: unknown};
    if (typeof parsed.username !== 'string' || typeof parsed.displayName !== 'string') return null;
    return {username: parsed.username, displayName: parsed.displayName};
  } catch {
    return null;
  }
}
export async function clearDemoSession() {
  await AsyncStorage.removeItem(DEMO_KEY);
}

// Live bearer tokens are stored with Android Keystore / iOS Keychain, never AsyncStorage.
export async function saveLiveSession(value: LiveSession): Promise<void> {
  await Keychain.setGenericPassword('nexa-session', JSON.stringify(value), {
    service: LIVE_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function readLiveSession(): Promise<LiveSession | null> {
  const credentials = await Keychain.getGenericPassword({service: LIVE_SERVICE});
  if (!credentials) return null;
  try {
    const value = JSON.parse(credentials.password) as Partial<LiveSession>;
    if (
      typeof value.uid !== 'string' ||
      typeof value.username !== 'string' ||
      typeof value.displayName !== 'string' ||
      typeof value.about !== 'string' ||
      typeof value.token !== 'string' ||
      value.token.length < 32 || value.token.length > 256
    ) return null;
    return value as LiveSession;
  } catch {
    return null;
  }
}

export async function clearLiveSession(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({service: LIVE_SERVICE});
  } catch {}
  try {
    await Keychain.resetGenericPassword();
  } catch {}
  try {
    await AsyncStorage.removeItem(DEMO_KEY);
  } catch {}
}
