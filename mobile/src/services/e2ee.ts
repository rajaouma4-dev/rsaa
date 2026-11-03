import {signalCrypto, ensureNativeCrypto} from './nativeCrypto';
import * as libsignal from '@privacyresearch/libsignal-protocol-typescript';
import {PreKeyWhisperMessage} from '@privacyresearch/libsignal-protocol-protobuf-ts';
import * as Keychain from 'react-native-keychain';
import {Buffer} from 'buffer';

libsignal.setWebCrypto(signalCrypto as any);

const KEYCHAIN_SERVICE = 'com.nexa.chat.e2ee.identity';
const STORAGE_PREFIX = 'nexa.e2ee.';

// Ratchet records and private prekeys must never be persisted in AsyncStorage.
// Existing installations require explicit secure reprovisioning; do not silently
// import potentially exposed legacy secrets into a trusted session.
const secureStore = {
  async getItem(key: string): Promise<string | null> {
    const result = await Keychain.getGenericPassword({service: key});
    return result ? result.password : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    const result = await Keychain.setGenericPassword('signal', value, {
      service: key,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!result) throw new Error('Secure Signal storage unavailable');
  },
  async removeItem(key: string): Promise<void> {
    await Keychain.resetGenericPassword({service: key});
  },
};

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
  private trustedIdentities = new Map<string, string | null>();

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
      throw new Error('Cannot access Signal identity securely');
    }
  }

  async saveIdentityKeyPair(keyPair: libsignal.KeyPairType): Promise<void> {
    const payload = JSON.stringify({
      pubKey: arrayBufferToBase64(keyPair.pubKey),
      privKey: arrayBufferToBase64(keyPair.privKey),
    });
    const result = await Keychain.setGenericPassword('identity', payload, {
      service: KEYCHAIN_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!result) throw new Error('Cannot persist Signal identity securely');
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    const raw = await secureStore.getItem(STORAGE_PREFIX + 'registration_id');
    return raw ? parseInt(raw, 10) : undefined;
  }

  async saveLocalRegistrationId(regId: number): Promise<void> {
    await secureStore.setItem(STORAGE_PREFIX + 'registration_id', regId.toString());
  }

  private async trustedIdentity(identifier: string): Promise<string | null> {
    // Signal checks a bare UID but saves UID.deviceId. Both refer to one pinned
    // identity in this single-device implementation; retain legacy UID.1 pins.
    const uid = identifier.replace(/\.[0-9]+$/, '');
    if (this.trustedIdentities.has(uid)) return this.trustedIdentities.get(uid)!;
    const saved = await secureStore.getItem(STORAGE_PREFIX + 'identity_' + uid)
      ?? await secureStore.getItem(STORAGE_PREFIX + 'identity_' + uid + '.1');
    this.trustedIdentities.set(uid, saved);
    return saved;
  }

  async isTrustedIdentity(identifier: string, identityKey: ArrayBuffer, _direction: libsignal.Direction): Promise<boolean> {
    const saved = await this.trustedIdentity(identifier);
    return saved === null || saved === arrayBufferToBase64(identityKey);
  }

  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer): Promise<boolean> {
    const uid = encodedAddress.replace(/\.[0-9]+$/, '');
    const value = arrayBufferToBase64(publicKey);
    const previous = await this.trustedIdentity(uid);
    if (previous !== null && previous !== value) {
      throw new Error('Peer identity changed; verify the new device before continuing');
    }
    // Signal calls this for every message. Persist only a newly accepted pin.
    if (previous === value) return false;
    await secureStore.setItem(STORAGE_PREFIX + 'identity_' + uid, value);
    this.trustedIdentities.set(uid, value);
    return false;
  }

  async loadPreKey(keyId: string | number): Promise<libsignal.KeyPairType | undefined> {
    const raw = await secureStore.getItem(STORAGE_PREFIX + 'prekey_' + keyId);
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
    await secureStore.setItem(STORAGE_PREFIX + 'prekey_' + keyId, payload);
  }

  async removePreKey(_keyId: number | string): Promise<void> {
    // Keep prekey retained locally so concurrent initial messages from peers do not fail
  }

  async loadSignedPreKey(keyId: number | string): Promise<libsignal.KeyPairType | undefined> {
    const raw = await secureStore.getItem(STORAGE_PREFIX + 'signed_prekey_' + keyId);
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
    await secureStore.setItem(STORAGE_PREFIX + 'signed_prekey_' + keyId, payload);
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    await secureStore.removeItem(STORAGE_PREFIX + 'signed_prekey_' + keyId);
  }

  async loadSession(encodedAddress: string): Promise<libsignal.SessionRecordType | undefined> {
    if (this.inMemorySessions.has(encodedAddress)) {
      return this.inMemorySessions.get(encodedAddress);
    }
    const val = await secureStore.getItem(STORAGE_PREFIX + 'session_' + encodedAddress);
    if (val) {
      this.inMemorySessions.set(encodedAddress, val);
    }
    return val ?? undefined;
  }

  async storeSession(encodedAddress: string, record: libsignal.SessionRecordType): Promise<void> {
    await secureStore.setItem(STORAGE_PREFIX + 'session_' + encodedAddress, record);
    this.inMemorySessions.set(encodedAddress, record);
  }

  async clearSession(encodedAddress: string): Promise<void> {
    this.inMemorySessions.delete(encodedAddress);
    await secureStore.removeItem(STORAGE_PREFIX + 'session_' + encodedAddress);
  }
}

export class SignalE2EEService {
  private store = new SignalProtocolStore();
  private initialized = false;
  private initialization?: Promise<void>;
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
    if (!this.initialization) {
      this.initialization = this.provision().catch(error => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async provision(): Promise<void> {
    await ensureNativeCrypto();

    let identity = await this.store.getIdentityKeyPair();
    let regId = await this.store.getLocalRegistrationId();

    if (!identity) {
      identity = await libsignal.KeyHelper.generateIdentityKeyPair();
      await this.store.saveIdentityKeyPair(identity);
    }
    if (!regId) {
      regId = libsignal.KeyHelper.generateRegistrationId();
      await this.store.saveLocalRegistrationId(regId);
    }

    // Resume interrupted first-time provisioning without replacing the identity.
    // The bundle is published only after every component is persisted.
    const signedKey = await this.store.loadSignedPreKey(1);
    const signature = await secureStore.getItem(STORAGE_PREFIX + 'signed_prekey_sig_1');
    if (!signedKey || !signature) {
      const signedPreKey = await libsignal.KeyHelper.generateSignedPreKey(identity, 1);
      await this.store.storeSignedPreKey(1, signedPreKey.keyPair);
      await secureStore.setItem(
        STORAGE_PREFIX + 'signed_prekey_sig_1',
        arrayBufferToBase64(signedPreKey.signature),
      );
    }
    if (!await this.store.loadPreKey(1)) {
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
    const signatureRaw = await secureStore.getItem(STORAGE_PREFIX + 'signed_prekey_sig_1');

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

    // Authentication failures and replays must not reset a valid ratchet or
    // trigger a retry under another wire format.
    if (type === 3) {
      decryptedBuffer = await cipher.decryptPreKeyWhisperMessage(binaryBody, 'binary');
    } else if (type === 1) {
      decryptedBuffer = await cipher.decryptWhisperMessage(binaryBody, 'binary');
    } else {
      throw new Error('Unsupported Signal message type');
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
