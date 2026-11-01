const lib = require('@privacyresearch/libsignal-protocol-typescript');

// Implement an in-memory SignalProtocolStore for testing
class InMemorySignalProtocolStore {
  constructor() {
    this.identityKeyPair = null;
    this.registrationId = null;
    this.preKeys = new Map();
    this.signedPreKeys = new Map();
    this.sessions = new Map();
    this.identities = new Map();
  }

  async getIdentityKeyPair() {
    return this.identityKeyPair;
  }

  async getLocalRegistrationId() {
    return this.registrationId;
  }

  async isTrustedIdentity(identifier, identityKey, direction) {
    if (!identifier) throw new Error('isTrustedIdentity: identifier required');
    const existing = this.identities.get(identifier);
    if (!existing) return true;
    return Buffer.from(existing).equals(Buffer.from(identityKey));
  }

  async saveIdentity(identifier, identityKey) {
    this.identities.set(identifier, identityKey);
    return true;
  }

  async loadPreKey(keyId) {
    return this.preKeys.get(keyId);
  }

  async storePreKey(keyId, keyPair) {
    this.preKeys.set(keyId, keyPair);
  }

  async removePreKey(keyId) {
    this.preKeys.delete(keyId);
  }

  async loadSignedPreKey(keyId) {
    return this.signedPreKeys.get(keyId);
  }

  async storeSignedPreKey(keyId, keyPair) {
    this.signedPreKeys.set(keyId, keyPair);
  }

  async removeSignedPreKey(keyId) {
    this.signedPreKeys.delete(keyId);
  }

  async loadSession(identifier) {
    return this.sessions.get(identifier);
  }

  async storeSession(identifier, record) {
    this.sessions.set(identifier, record);
  }
}

async function runTest() {
  console.log('--- Running Signal Protocol Alice <-> Bob Double Ratchet Test ---');

  // 1. Bob creates keys and prekey bundle
  const bobStore = new InMemorySignalProtocolStore();
  bobStore.registrationId = lib.KeyHelper.generateRegistrationId();
  bobStore.identityKeyPair = await lib.KeyHelper.generateIdentityKeyPair();

  const bobPreKey = await lib.KeyHelper.generatePreKey(1);
  await bobStore.storePreKey(1, bobPreKey.keyPair);

  const bobSignedPreKey = await lib.KeyHelper.generateSignedPreKey(bobStore.identityKeyPair, 1);
  await bobStore.storeSignedPreKey(1, bobSignedPreKey.keyPair);

  const bobPreKeyBundle = {
    identityKey: bobStore.identityKeyPair.pubKey,
    registrationId: bobStore.registrationId,
    preKey: {
      keyId: 1,
      publicKey: bobPreKey.keyPair.pubKey,
    },
    signedPreKey: {
      keyId: 1,
      publicKey: bobSignedPreKey.keyPair.pubKey,
      signature: bobSignedPreKey.signature,
    },
  };

  // 2. Alice initializes her store
  const aliceStore = new InMemorySignalProtocolStore();
  aliceStore.registrationId = lib.KeyHelper.generateRegistrationId();
  aliceStore.identityKeyPair = await lib.KeyHelper.generateIdentityKeyPair();

  const bobAddress = new lib.SignalProtocolAddress('bob', 1);
  const aliceAddress = new lib.SignalProtocolAddress('alice', 1);

  // 3. Alice processes Bob's prekey bundle to establish a session
  const aliceSessionBuilder = new lib.SessionBuilder(aliceStore, bobAddress);
  await aliceSessionBuilder.processPreKey(bobPreKeyBundle);

  // 4. Alice encrypts a message for Bob
  const aliceCipher = new lib.SessionCipher(aliceStore, bobAddress);
  const rawText = 'Hello Bob! This is an audited Double Ratchet test message.';
  const plaintextBytes = new TextEncoder().encode(rawText);
  const ciphertextEnvelope = await aliceCipher.encrypt(plaintextBytes.buffer);
  console.log('Ciphertext envelope type:', ciphertextEnvelope.type);
  console.log('Ciphertext body len:', ciphertextEnvelope.body.length);

  // 5. Bob receives and decrypts Alice's PreKeySignalMessage
  const bobCipher = new lib.SessionCipher(bobStore, aliceAddress);
  let decrypted;
  if (ciphertextEnvelope.type === 3) { // PREKEY_BUNDLE message
    decrypted = await bobCipher.decryptPreKeyWhisperMessage(ciphertextEnvelope.body, 'binary');
  } else {
    decrypted = await bobCipher.decryptWhisperMessage(ciphertextEnvelope.body, 'binary');
  }

  console.log('decrypted type:', typeof decrypted, decrypted);
  const decryptedText = new TextDecoder().decode(decrypted);
  console.log('Decrypted message at Bob:', JSON.stringify(decryptedText));
  console.log('Original message was:   ', JSON.stringify(rawText));
  if (decryptedText !== rawText) {
    throw new Error('Decryption mismatch!');
  }

  // 6. Bob replies to Alice (ratchet forward)
  const replyRawText = 'Hi Alice! I received your encrypted message cleanly.';
  const replyBytes = new TextEncoder().encode(replyRawText);
  const replyEnvelope = await bobCipher.encrypt(replyBytes.buffer);
  console.log('Reply envelope type:', replyEnvelope.type);

  // 7. Alice receives and decrypts Bob's response
  const aliceDecrypted = await aliceCipher.decryptWhisperMessage(replyEnvelope.body, 'binary');
  const aliceDecryptedText = new TextDecoder().decode(aliceDecrypted);
  console.log('Decrypted reply at Alice:', JSON.stringify(aliceDecryptedText));
  if (aliceDecryptedText !== replyRawText) {
    throw new Error('Alice decryption mismatch!');
  }

  console.log('--- ALL SIGNAL PROTOCOL DOUBLE RATCHET TESTS PASSED! ---');
}

runTest().catch(err => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
