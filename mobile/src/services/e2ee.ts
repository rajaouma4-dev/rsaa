import * as libsignal from '@privacyresearch/libsignal-protocol-typescript';
import {PreKeyWhisperMessage} from '@privacyresearch/libsignal-protocol-protobuf-ts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {Buffer} from 'buffer';

const KEYCHAIN_SERVICE = 'com.nexa.chat.e2ee.identity';
const STORAGE_PREFIX = 'nexa.e2ee.';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const buf = Buffer.from(b64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export interface RemotePreKeyBundle {
  identityKey: string; // base64
  registrationId: number;
  preKeyId: number;
  preKeyPublic: string; // base64
  signedPreKeyId: number;
  signedPreKeyPublic: string; // base64
  signedPreKeySignature: string; // base64
}

export interface EncryptedMessagePayload {
  type: number; // 1 = WhisperMessage, 3 = PreKeyWhisperMessage
  body_b64: string; // Base64 ciphertext
}

class SignalProtocolStore implements libsignal.StorageType {
  private inMemorySessions = new Map<string, string>();

  async getIdentityKeyPair(): Promise<libsignal.KeyPairType | undefined> {
    try {
      const credentials = await Keychain.getGenericPassword({service: KEYCHAIN_SERVICE});
      if (!credentials) return undefined;
      const parsed = JSON.parse(credentials.password);
      return {
        pubKey: base64ToArrayBuffer(parsed.pubKey),
        privKey: base64ToArrayBuffer(parsed.privKey),
      };
    } catch {
      return undefined;
    }
  }

  async saveIdentityKeyPair(keyPair: libsignal.KeyPairType): Promise<void> {
    const payload = JSON.stringify({
      pubKey: arrayBufferToBase64(keyPair.pubKey),
      privKey: arrayBufferToBase64(keyPair.privKey),
    });
    await Keychain.setGenericPassword('identity', payload, {
      service: KEYCHAIN_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    const raw = await AsyncStorage.getItem(STORAGE_PREFIX + 'registration_id');
    return raw ? parseInt(raw, 10) : undefined;
  }

  async saveLocalRegistrationId(regId: number): Promise<void> {
    await AsyncStorage.setItem(STORAGE_PREFIX + 'registration_id', regId.toString());
  }

  async isTrustedIdentity(_identifier: string, _identityKey: ArrayBuffer, _direction: libsignal.Direction): Promise<boolean> {
    // In chat messenger lifecycle, allow re-keyed identities (e.g. peer app re-registration / new device)
    return true;
  }

  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer): Promise<boolean> {
    const key = STORAGE_PREFIX + 'identity_' + encodedAddress;
    await AsyncStorage.setItem(key, arrayBufferToBase64(publicKey));
    return true;
  }

  async loadPreKey(keyId: string | number): Promise<libsignal.KeyPairType | undefined> {
    const raw = await AsyncStorage.getItem(STORAGE_PREFIX + 'prekey_' + keyId);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return {
      pubKey: base64ToArrayBuffer(parsed.pubKey),
      privKey: base64ToArrayBuffer(parsed.privKey),
    };
  }

  async storePreKey(keyId: number | string, keyPair: libsignal.KeyPairType): Promise<void> {
    const payload = JSON.stringify({
      pubKey: arrayBufferToBase64(keyPair.pubKey),
      privKey: arrayBufferToBase64(keyPair.privKey),
    });
    await AsyncStorage.setItem(STORAGE_PREFIX + 'prekey_' + keyId, payload);
  }

  async removePreKey(_keyId: number | string): Promise<void> {
    // Keep prekey retained locally so concurrent initial messages from peers do not fail
  }

  async loadSignedPreKey(keyId: number | string): Promise<libsignal.KeyPairType | undefined> {
    const raw = await AsyncStorage.getItem(STORAGE_PREFIX + 'signed_prekey_' + keyId);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return {
      pubKey: base64ToArrayBuffer(parsed.pubKey),
      privKey: base64ToArrayBuffer(parsed.privKey),
    };
  }

  async storeSignedPreKey(keyId: number | string, keyPair: libsignal.KeyPairType): Promise<void> {
    const payload = JSON.stringify({
      pubKey: arrayBufferToBase64(keyPair.pubKey),
      privKey: arrayBufferToBase64(keyPair.privKey),
    });
    await AsyncStorage.setItem(STORAGE_PREFIX + 'signed_prekey_' + keyId, payload);
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    await AsyncStorage.removeItem(STORAGE_PREFIX + 'signed_prekey_' + keyId);
  }

  async loadSession(encodedAddress: string): Promise<libsignal.SessionRecordType | undefined> {
    if (this.inMemorySessions.has(encodedAddress)) {
      return this.inMemorySessions.get(encodedAddress);
    }
    const val = await AsyncStorage.getItem(STORAGE_PREFIX + 'session_' + encodedAddress);
    if (val) {
      this.inMemorySessions.set(encodedAddress, val);
    }
    return val ?? undefined;
  }

  async storeSession(encodedAddress: string, record: libsignal.SessionRecordType): Promise<void> {
    this.inMemorySessions.set(encodedAddress, record);
    await AsyncStorage.setItem(STORAGE_PREFIX + 'session_' + encodedAddress, record);
  }

  async clearSession(encodedAddress: string): Promise<void> {
    this.inMemorySessions.delete(encodedAddress);
    await AsyncStorage.removeItem(STORAGE_PREFIX + 'session_' + encodedAddress);
  }
}

export class SignalE2EEService {
  private store = new SignalProtocolStore();
  private initialized = false;
  private peerLocks = new Map<string, Promise<any>>();

  private async runForPeer<T>(remoteUid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.peerLocks.get(remoteUid) || Promise.resolve();
    let resolveCurrent!: (val: T) => void;
    let rejectCurrent!: (err: any) => void;
    const current = new Promise<T>((res, rej) => {
      resolveCurrent = res;
      rejectCurrent = rej;
    });

    this.peerLocks.set(
      remoteUid,
      prev.then(
        async () => {
          try {
            const res = await fn();
            resolveCurrent(res);
          } catch (err) {
            rejectCurrent(err);
          }
        },
        async () => {
          try {
            const res = await fn();
            resolveCurrent(res);
          } catch (err) {
            rejectCurrent(err);
          }
        }
      )
    );

    return current;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    let identity = await this.store.getIdentityKeyPair();
    let regId = await this.store.getLocalRegistrationId();

    if (!identity || !regId) {
      regId = libsignal.KeyHelper.generateRegistrationId();
      identity = await libsignal.KeyHelper.generateIdentityKeyPair();
      await this.store.saveLocalRegistrationId(regId);
      await this.store.saveIdentityKeyPair(identity);

      // Generate signed prekey 1
      const signedPreKey = await libsignal.KeyHelper.generateSignedPreKey(identity, 1);
      await this.store.storeSignedPreKey(1, signedPreKey.keyPair);
      await AsyncStorage.setItem(
        STORAGE_PREFIX + 'signed_prekey_sig_1',
        arrayBufferToBase64(signedPreKey.signature),
      );

      // Generate prekey 1
      const preKey = await libsignal.KeyHelper.generatePreKey(1);
      await this.store.storePreKey(1, preKey.keyPair);
    }

    this.initialized = true;
  }

  async exportPreKeyBundle(): Promise<RemotePreKeyBundle> {
    await this.initialize();
    const identity = await this.store.getIdentityKeyPair();
    const regId = await this.store.getLocalRegistrationId();
    const preKey = await this.store.loadPreKey(1);
    const signedPreKey = await this.store.loadSignedPreKey(1);
    const signatureRaw = await AsyncStorage.getItem(STORAGE_PREFIX + 'signed_prekey_sig_1');

    if (!identity || !regId || !preKey || !signedPreKey || !signatureRaw) {
      throw new Error('E2EE service not fully provisioned with prekeys');
    }

    return {
      identityKey: arrayBufferToBase64(identity.pubKey),
      registrationId: regId,
      preKeyId: 1,
      preKeyPublic: arrayBufferToBase64(preKey.pubKey),
      signedPreKeyId: 1,
      signedPreKeyPublic: arrayBufferToBase64(signedPreKey.pubKey),
      signedPreKeySignature: signatureRaw,
    };
  }

  async clearSessionWithPeer(remoteUid: string): Promise<void> {
    return this.runForPeer(remoteUid, async () => {
      const remoteAddress = new libsignal.SignalProtocolAddress(remoteUid, 1);
      await this.store.clearSession(remoteAddress.toString());
    });
  }

  async establishSessionWithPeer(remoteUid: string, bundle: RemotePreKeyBundle): Promise<void> {
    return this.runForPeer(remoteUid, async () => {
      await this.initialize();
      const remoteAddress = new libsignal.SignalProtocolAddress(remoteUid, 1);
      const builder = new libsignal.SessionBuilder(this.store, remoteAddress);

      await builder.processPreKey({
        registrationId: bundle.registrationId,
        identityKey: base64ToArrayBuffer(bundle.identityKey),
        signedPreKey: {
          keyId: bundle.signedPreKeyId,
          publicKey: base64ToArrayBuffer(bundle.signedPreKeyPublic),
          signature: base64ToArrayBuffer(bundle.signedPreKeySignature),
        },
        preKey: {
          keyId: bundle.preKeyId,
          publicKey: base64ToArrayBuffer(bundle.preKeyPublic),
        },
      });
    });
  }

  async encrypt(remoteUid: string, plaintext: string): Promise<EncryptedMessagePayload> {
    return this.runForPeer(remoteUid, async () => {
      await this.initialize();
      const remoteAddress = new libsignal.SignalProtocolAddress(remoteUid, 1);
      const cipher = new libsignal.SessionCipher(this.store, remoteAddress);

      const plaintextBytes = Buffer.from(plaintext, 'utf8');
      const cleanArrayBuffer = plaintextBytes.buffer.slice(
        plaintextBytes.byteOffset,
        plaintextBytes.byteOffset + plaintextBytes.byteLength,
      );

      const envelope = await cipher.encrypt(cleanArrayBuffer);
      if (!envelope.body) throw new Error('Cipher failed to produce ciphertext');
      const bodyBase64 = Buffer.from(envelope.body, 'binary').toString('base64');

      return {
        type: envelope.type,
        body_b64: bodyBase64,
      };
    });
  }

  async decrypt(remoteUid: string, type: number, bodyBase64: string): Promise<string> {
    return this.runForPeer(remoteUid, async () => {
      return this.doDecrypt(remoteUid, type, bodyBase64);
    });
  }

  private isPreKeyWhisperPayload(rawBytes: Buffer): boolean {
    try {
      if (rawBytes.length < 35) return false;
      const decoded = PreKeyWhisperMessage.decode(rawBytes.slice(1));
      return Boolean(
        decoded &&
        decoded.baseKey &&
        decoded.baseKey.length === 33 &&
        decoded.identityKey &&
        decoded.identityKey.length === 33 &&
        decoded.message &&
        decoded.message.length > 0 &&
        typeof decoded.signedPreKeyId === 'number'
      );
    } catch {
      return false;
    }
  }

  private async doDecrypt(remoteUid: string, type: number, bodyBase64: string): Promise<string> {
    await this.initialize();
    const remoteAddress = new libsignal.SignalProtocolAddress(remoteUid, 1);
    const cipher = new libsignal.SessionCipher(this.store, remoteAddress);

    const rawBuffer = Buffer.from(bodyBase64, 'base64');
    const binaryBody = rawBuffer.toString('binary');
    let decryptedBuffer: ArrayBuffer | null = null;

    // Detect exact Signal protocol wire type:
    // If explicitly provided (type === 3 or type === 1), honor it.
    // Otherwise, inspect the protobuf envelope directly.
    const isPreKey = type === 3 || (type !== 1 && this.isPreKeyWhisperPayload(rawBuffer));

    let lastError: any = null;
    if (isPreKey) {
      try {
        decryptedBuffer = await cipher.decryptPreKeyWhisperMessage(binaryBody, 'binary');
      } catch (err) {
        lastError = err;
        try {
          decryptedBuffer = await cipher.decryptWhisperMessage(binaryBody, 'binary');
          lastError = null;
        } catch (whisperErr) {
          lastError = whisperErr;
        }
      }
    } else {
      try {
        decryptedBuffer = await cipher.decryptWhisperMessage(binaryBody, 'binary');
      } catch (err) {
        lastError = err;
        try {
          decryptedBuffer = await cipher.decryptPreKeyWhisperMessage(binaryBody, 'binary');
          lastError = null;
        } catch (preKeyErr) {
          lastError = preKeyErr;
        }
      }
    }

    if (!decryptedBuffer && lastError) {
      const errMsg = lastError?.message || String(lastError);
      console.warn(`[E2EE] Decryption error with peer ${remoteUid} (isPreKey=${isPreKey}):`, errMsg);

      // If session is broken / Bad MAC / desynced, automatically clear the broken local session
      // so subsequent messages can re-establish cleanly rather than failing permanently
      if (
        errMsg.includes('Bad MAC') ||
        errMsg.includes('No record for device') ||
        errMsg.includes('No session found') ||
        errMsg.includes('Message key not found')
      ) {
        const addr = new libsignal.SignalProtocolAddress(remoteUid, 1);
        await this.store.clearSession(addr.toString());
      }
      throw lastError;
    }

    if (!decryptedBuffer) {
      throw new Error('Decryption failed to produce plaintext buffer');
    }

    return Buffer.from(decryptedBuffer).toString('utf8');
  }

  async hasSession(remoteUid: string): Promise<boolean> {
    const remoteAddress = new libsignal.SignalProtocolAddress(remoteUid, 1);
    const cipher = new libsignal.SessionCipher(this.store, remoteAddress);
    return await cipher.hasOpenSession();
  }
}

export const e2eeService = new SignalE2EEService();
