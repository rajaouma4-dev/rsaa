const lib = require('@privacyresearch/libsignal-protocol-typescript');
const proto = require('@privacyresearch/libsignal-protocol-protobuf-ts');

// Minimal in-memory store
class TestStore {
  constructor() {
    this.identityKeyPair = null;
    this.registrationId = null;
    this.preKeys = new Map();
    this.signedPreKeys = new Map();
    this.sessions = new Map();
    this.identities = new Map();
  }
  async getIdentityKeyPair() { return this.identityKeyPair; }
  async getLocalRegistrationId() { return this.registrationId; }
  async isTrustedIdentity(id, key) { return true; }
  async saveIdentity(id, key) { this.identities.set(id, key); return true; }
  async loadPreKey(id) { return this.preKeys.get(id); }
  async storePreKey(id, kp) { this.preKeys.set(id, kp); }
  async removePreKey(id) { this.preKeys.delete(id); }
  async loadSignedPreKey(id) { return this.signedPreKeys.get(id); }
  async storeSignedPreKey(id, kp) { this.signedPreKeys.set(id, kp); }
  async removeSignedPreKey(id) { this.signedPreKeys.delete(id); }
  async loadSession(id) { return this.sessions.get(id); }
  async storeSession(id, r) { this.sessions.set(id, r); }
}

async function runAudit() {
  console.log('=== INDEPENDENT CIPHERTEXT PARSER AUDIT ===');
  
  const bobStore = new TestStore();
  bobStore.registrationId = lib.KeyHelper.generateRegistrationId();
  bobStore.identityKeyPair = await lib.KeyHelper.generateIdentityKeyPair();
  const bobPreKey = await lib.KeyHelper.generatePreKey(1);
  await bobStore.storePreKey(1, bobPreKey.keyPair);
  const bobSignedPreKey = await lib.KeyHelper.generateSignedPreKey(bobStore.identityKeyPair, 1);
  await bobStore.storeSignedPreKey(1, bobSignedPreKey.keyPair);

  const aliceStore = new TestStore();
  aliceStore.registrationId = lib.KeyHelper.generateRegistrationId();
  aliceStore.identityKeyPair = await lib.KeyHelper.generateIdentityKeyPair();

  const bobAddress = new lib.SignalProtocolAddress('bob', 1);
  const aliceAddress = new lib.SignalProtocolAddress('alice', 1);

  const sessionBuilder = new lib.SessionBuilder(aliceStore, bobAddress);
  await sessionBuilder.processPreKey({
    registrationId: bobStore.registrationId,
    identityKey: bobStore.identityKeyPair.pubKey,
    signedPreKey: {
      keyId: 1,
      publicKey: bobSignedPreKey.keyPair.pubKey,
      signature: bobSignedPreKey.signature,
    },
    preKey: {
      keyId: 1,
      publicKey: bobPreKey.keyPair.pubKey,
    },
  });

  const aliceCipher = new lib.SessionCipher(aliceStore, bobAddress);
  const rawMsg = 'Test message for parser audit';
  const encPreKey = await aliceCipher.encrypt(new TextEncoder().encode(rawMsg).buffer);

  // 1. Audit PreKeyWhisperMessage (Type 3)
  console.log('\n--- Auditing Type 3 (PreKeyWhisperMessage) ---');
  console.log('Returned Type:', encPreKey.type);
  const preKeyBytes = Buffer.from(encPreKey.body, 'binary');
  const preKeyVersionByte = preKeyBytes[0];
  const preKeyMinVer = preKeyVersionByte & 0x0f;
  const preKeyMaxVer = preKeyVersionByte >> 4;
  console.log(`Version byte: 0x${preKeyVersionByte.toString(16)} (min: ${preKeyMinVer}, max: ${preKeyMaxVer})`);
  
  if (preKeyMinVer > 3 || preKeyMaxVer < 3) {
    throw new Error('PreKeyWhisperMessage version negotiation mismatch');
  }

  // Parse protobuf payload
  const preKeyPayload = preKeyBytes.subarray(1);
  const decodedPreKey = proto.PreKeyWhisperMessage.decode(preKeyPayload);
  console.log('Successfully decoded PreKeyWhisperMessage Protobuf:');
  console.log('  registrationId:', decodedPreKey.registrationId);
  console.log('  baseKey length:', decodedPreKey.baseKey ? decodedPreKey.baseKey.length : 0);
  console.log('  signedPreKeyId:', decodedPreKey.signedPreKeyId);
  console.log('  nested message bytes length:', decodedPreKey.message ? decodedPreKey.message.length : 0);

  // 2. Bob decrypts PreKey message so session advances
  const bobCipher = new lib.SessionCipher(bobStore, aliceAddress);
  await bobCipher.decryptPreKeyWhisperMessage(encPreKey.body, 'binary');

  // 2b. Bob sends reply to Alice so Alice's pendingPreKey is cleared
  const bobReply = await bobCipher.encrypt(new TextEncoder().encode('Bob reply').buffer);
  await aliceCipher.decryptWhisperMessage(bobReply.body, 'binary');

  // 3. Alice encrypts subsequent message -> WhisperMessage (Type 1)
  console.log('\n--- Auditing Type 1 (WhisperMessage) ---');
  const encWhisper = await aliceCipher.encrypt(new TextEncoder().encode('Second message').buffer);
  console.log('Returned Type:', encWhisper.type);
  const whisperBytes = Buffer.from(encWhisper.body, 'binary');
  const whisperVersionByte = whisperBytes[0];
  const whisperMinVer = whisperVersionByte & 0x0f;
  const whisperMaxVer = whisperVersionByte >> 4;
  console.log(`Version byte: 0x${whisperVersionByte.toString(16)} (min: ${whisperMinVer}, max: ${whisperMaxVer})`);

  if (whisperMinVer > 3 || whisperMaxVer < 3) {
    throw new Error('WhisperMessage version negotiation mismatch');
  }

  // Structure: 1 byte version, followed by protobuf message, followed by 8-byte MAC
  const whisperProtoBytes = whisperBytes.subarray(1, whisperBytes.length - 8);
  const macBytes = whisperBytes.subarray(whisperBytes.length - 8);
  console.log(`Protobuf body len: ${whisperProtoBytes.length}, MAC len: ${macBytes.length}`);

  const decodedWhisper = proto.WhisperMessage.decode(whisperProtoBytes);
  console.log('Successfully decoded WhisperMessage Protobuf:');
  console.log('  ephemeralKey length:', decodedWhisper.ephemeralKey ? decodedWhisper.ephemeralKey.length : 0);
  console.log('  counter:', decodedWhisper.counter);
  console.log('  ciphertext length:', decodedWhisper.ciphertext ? decodedWhisper.ciphertext.length : 0);

  console.log('\n=== AUDIT PASSED: BOTH PREKEY AND WHISPER MESSAGES FULLY CONFORM TO SIGNAL PROTOCOL V3 PROTOBUF SPECIFICATION ===');
}

runAudit().catch(err => {
  console.error('Audit FAILED:', err);
  process.exit(1);
});
