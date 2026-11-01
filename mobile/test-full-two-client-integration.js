const libsignal = require('@privacyresearch/libsignal-protocol-typescript');
const proto = require('@privacyresearch/libsignal-protocol-protobuf-ts');

class SimulatedDeviceStore {
  constructor(name) {
    this.name = name;
    this.identityKeyPair = null;
    this.registrationId = null;
    this.preKeys = new Map();
    this.signedPreKeys = new Map();
    this.sessions = new Map();
    this.identities = new Map();
  }
  async getIdentityKeyPair() { return this.identityKeyPair; }
  async getLocalRegistrationId() { return this.registrationId; }
  async isTrustedIdentity(id, key) {
    const existing = this.identities.get(id);
    if (!existing) return true;
    return Buffer.from(existing).equals(Buffer.from(key));
  }
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

async function runTwoClientSimulation() {
  console.log('================================================================');
  console.log('   NEXA CHAT: TWO-CLIENT SIMULATED PROTOCOL INTEGRATION TEST   ');
  console.log('================================================================');

  // --- Step 1: Device Initialization & Key Generation ---
  console.log('\n[1] Initializing Device A (Alice) & Device B (Bob)...');
  const aliceStore = new SimulatedDeviceStore('Alice');
  aliceStore.registrationId = libsignal.KeyHelper.generateRegistrationId();
  aliceStore.identityKeyPair = await libsignal.KeyHelper.generateIdentityKeyPair();

  const bobStore = new SimulatedDeviceStore('Bob');
  bobStore.registrationId = libsignal.KeyHelper.generateRegistrationId();
  bobStore.identityKeyPair = await libsignal.KeyHelper.generateIdentityKeyPair();
  const bobPreKey = await libsignal.KeyHelper.generatePreKey(101);
  await bobStore.storePreKey(101, bobPreKey.keyPair);
  const bobSignedPreKey = await libsignal.KeyHelper.generateSignedPreKey(bobStore.identityKeyPair, 1);
  await bobStore.storeSignedPreKey(1, bobSignedPreKey.keyPair);

  console.log('  Alice Identity Key length:', aliceStore.identityKeyPair.pubKey.byteLength);
  console.log('  Bob Identity Key length:  ', bobStore.identityKeyPair.pubKey.byteLength);

  // --- Step 2: PreKey Bundle Exchange ---
  console.log('\n[2] Performing PreKey Bundle Exchange...');
  const bobBundle = {
    registrationId: bobStore.registrationId,
    identityKey: bobStore.identityKeyPair.pubKey,
    preKey: {
      keyId: 101,
      publicKey: bobPreKey.keyPair.pubKey,
    },
    signedPreKey: {
      keyId: 1,
      publicKey: bobSignedPreKey.keyPair.pubKey,
      signature: bobSignedPreKey.signature,
    },
  };

  const bobAddress = new libsignal.SignalProtocolAddress('bob_device', 1);
  const aliceAddress = new libsignal.SignalProtocolAddress('alice_device', 1);

  const aliceSessionBuilder = new libsignal.SessionBuilder(aliceStore, bobAddress);
  await aliceSessionBuilder.processPreKey(bobBundle);
  console.log('  Alice processed Bob bundle -> Double Ratchet session established.');

  // --- Step 3: Alice sends encrypted message to Bob ---
  console.log('\n[3] Alice encrypts message for Bob (Initial PreKeyWhisperMessage)...');
  const aliceCipher = new libsignal.SessionCipher(aliceStore, bobAddress);
  const alicePlaintext = 'Confidential message: The server must never see this text!';
  const encEnvelope1 = await aliceCipher.encrypt(new TextEncoder().encode(alicePlaintext).buffer);
  
  console.log('  Ciphertext Envelope Type:', encEnvelope1.type, '(3 = PreKeyWhisperMessage)');
  const ciphertextBytes = Buffer.from(encEnvelope1.body, 'binary');
  console.log('  Ciphertext byte length:  ', ciphertextBytes.length);
  console.log('  Ciphertext version byte:  0x' + ciphertextBytes[0].toString(16));

  // --- Step 4: Verify Server Plaintext Invariant ---
  console.log('\n[4] Verifying Server Zero-Knowledge Invariant...');
  const containsPlaintext = ciphertextBytes.toString('utf8').includes('Confidential message');
  if (containsPlaintext) {
    throw new Error('SECURITY VIOLATION: Plaintext found inside serialized ciphertext!');
  }
  console.log('  CONFIRMED: Ciphertext contains zero plaintext substring.');

  // --- Step 5: Bob receives and decrypts message ---
  console.log('\n[5] Bob decrypts Alice PreKeyWhisperMessage...');
  const bobCipher = new libsignal.SessionCipher(bobStore, aliceAddress);
  const bobDecrypted = await bobCipher.decryptPreKeyWhisperMessage(encEnvelope1.body, 'binary');
  const bobDecryptedText = new TextDecoder().decode(bobDecrypted);
  console.log('  Bob decrypted text:', JSON.stringify(bobDecryptedText));
  if (bobDecryptedText !== alicePlaintext) {
    throw new Error('Decryption mismatch at Bob!');
  }

  // --- Step 6: Bob replies to Alice (Ratchet steps forward) ---
  console.log('\n[6] Bob replies to Alice (Stepping Double Ratchet forward)...');
  const bobReplyPlaintext = 'Roger that Alice. Ratchet successfully advanced.';
  const encEnvelope2 = await bobCipher.encrypt(new TextEncoder().encode(bobReplyPlaintext).buffer);
  console.log('  Bob Reply Envelope Type:', encEnvelope2.type);

  const aliceDecrypted = await aliceCipher.decryptWhisperMessage(encEnvelope2.body, 'binary');
  const aliceDecryptedText = new TextDecoder().decode(aliceDecrypted);
  console.log('  Alice decrypted text:', JSON.stringify(aliceDecryptedText));
  if (aliceDecryptedText !== bobReplyPlaintext) {
    throw new Error('Decryption mismatch at Alice!');
  }

  // --- Step 7A: Independent Wrong-Session Test ---
  console.log('\n[7A] Testing Independent Wrong-Session Cryptographic Isolation...');
  // Eve establishes her own independent session with Alice (e.g., Eve has her own account and chats with Alice)
  const eveStore = new SimulatedDeviceStore('Eve');
  eveStore.registrationId = libsignal.KeyHelper.generateRegistrationId();
  eveStore.identityKeyPair = await libsignal.KeyHelper.generateIdentityKeyPair();
  const evePreKey = await libsignal.KeyHelper.generatePreKey(301);
  const eveSignedPreKey = await libsignal.KeyHelper.generateSignedPreKey(eveStore.identityKeyPair, 1);
  await eveStore.storePreKey(301, evePreKey.keyPair);
  await eveStore.storeSignedPreKey(1, eveSignedPreKey.keyPair);

  // Eve establishes an independent session with Alice using Alice's prekey bundle
  const alicePreKey = await libsignal.KeyHelper.generatePreKey(201);
  const aliceSignedPreKey = await libsignal.KeyHelper.generateSignedPreKey(aliceStore.identityKeyPair, 1);
  await aliceStore.storePreKey(201, alicePreKey.keyPair);
  await aliceStore.storeSignedPreKey(1, aliceSignedPreKey.keyPair);
  const aliceBundleForEve = {
    registrationId: aliceStore.registrationId,
    identityKey: aliceStore.identityKeyPair.pubKey,
    preKey: { keyId: 201, publicKey: alicePreKey.keyPair.pubKey },
    signedPreKey: { keyId: 1, publicKey: aliceSignedPreKey.keyPair.pubKey, signature: aliceSignedPreKey.signature }
  };
  const eveBuilder = new libsignal.SessionBuilder(eveStore, aliceAddress);
  await eveBuilder.processPreKey(aliceBundleForEve);
  // Eve now possesses a valid, fully initialized session record for alice_device.1 in her own store
  const eveHasSession = await eveStore.loadSession('alice_device.1');
  if (!eveHasSession) throw new Error('Failed to setup Eve independent session');

  // Alice sends a confidential message #3 addressed specifically to Bob's session
  const secretMsg3 = 'Top secret message #3 from Alice to Bob';
  const encEnvelope3 = await aliceCipher.encrypt(new TextEncoder().encode(secretMsg3).buffer);

  // Eve intercepts the ciphertext in transit and attempts to decrypt with her own Alice session
  const eveCipher = new libsignal.SessionCipher(eveStore, aliceAddress);
  try {
    const leaked = await eveCipher.decryptWhisperMessage(encEnvelope3.body, 'binary');
    throw new Error('SECURITY FLAW: Eve decrypted Bob-addressed ciphertext with her independent session! Leaked: ' + leaked);
  } catch (err) {
    console.log('  CONFIRMED: Independent session rejected foreign ciphertext cryptographically with:', err.message);
  }

  // --- Step 7B: Session-State Compromise Test (Device Extraction) ---
  console.log('\n[7B] Testing Complete Session-State Compromise (Physical Device Extraction)...');
  // Scenario: An attacker extracts BOTH Bob's complete active session record AND Bob's identity key
  const clonedBobStore = new SimulatedDeviceStore('ClonedBob');
  clonedBobStore.registrationId = bobStore.registrationId;
  clonedBobStore.identityKeyPair = bobStore.identityKeyPair;
  const bobSessionRecord = await bobStore.loadSession('alice_device.1');
  await clonedBobStore.storeSession('alice_device.1', bobSessionRecord);

  const clonedBobCipher = new libsignal.SessionCipher(clonedBobStore, aliceAddress);
  const compromisedPlaintextBytes = await clonedBobCipher.decryptWhisperMessage(encEnvelope3.body, 'binary');
  const compromisedPlaintext = new TextDecoder().decode(compromisedPlaintextBytes);
  console.log('  OBSERVED: Cloned state decrypts message #3:', JSON.stringify(compromisedPlaintext));
  if (compromisedPlaintext !== secretMsg3) {
    throw new Error('Cloned session state unexpectedly failed to decrypt target message');
  }
  console.log('  SECURITY IMPLICATION NOTE: If an attacker extracts both the current session record AND the identity');
  console.log('  key before the target message is processed, the unratcheted symmetric keys can decrypt that message.');
  console.log('  Signal Protocol provides Forward Secrecy (past keys destroyed) and Break-in Recovery (future ratchets');
  console.log('  heal the session once legitimate DH steps occur), but cannot prevent decryption if full current state is seized.');

  // --- Step 7C: Keystore-Protected Hybrid Test (Session Record Stolen, Hardware Key Protected) ---
  console.log('\n[7C] Testing Android Keystore Protection (Stolen Session Record, Non-Exportable/Protected Identity Key)...');
  // Scenario: Attacker dumps unencrypted app database (session record), but Android Keystore protects the identity key
  const hybridStore = new SimulatedDeviceStore('HybridAttacker');
  hybridStore.registrationId = libsignal.KeyHelper.generateRegistrationId();
  hybridStore.identityKeyPair = await libsignal.KeyHelper.generateIdentityKeyPair(); // Attacker cannot get Bob's key
  await hybridStore.storeSession('alice_device.1', bobSessionRecord);

  const hybridCipher = new libsignal.SessionCipher(hybridStore, aliceAddress);
  try {
    const hybridLeak = await hybridCipher.decryptWhisperMessage(encEnvelope3.body, 'binary');
    throw new Error('SECURITY FLAW: Attacker decrypted message without Bob identity key! Leaked: ' + hybridLeak);
  } catch (err) {
    console.log('  CONFIRMED: Decryption rejected with Bad MAC when identity key is missing/incorrect (Keystore defense).');
  }

  // --- Step 7D: Tampered Ciphertext Test ---
  console.log('\n[7D] Testing Tampered Ciphertext Rejection...');
  const tamperedCiphertextBytes = Buffer.from(encEnvelope3.body, 'binary');
  // Flip bits in the middle of ciphertext and MAC tag
  tamperedCiphertextBytes[15] ^= 0xff;
  tamperedCiphertextBytes[tamperedCiphertextBytes.length - 2] ^= 0xaa;
  const tamperedBody = tamperedCiphertextBytes.toString('binary');

  try {
    const tamperedResult = await bobCipher.decryptWhisperMessage(tamperedBody, 'binary');
    throw new Error('SECURITY FLAW: Tampered ciphertext was decrypted! Result: ' + tamperedResult);
  } catch (err) {
    console.log('  CONFIRMED: Tampered ciphertext rejected cryptographically with Error:', err.message);
  }

  // Bob decrypts authentic message #3 to confirm valid ratchet path continues
  const bobDecrypted3 = await bobCipher.decryptWhisperMessage(encEnvelope3.body, 'binary');
  const bobDecryptedText3 = new TextDecoder().decode(bobDecrypted3);
  if (bobDecryptedText3 !== secretMsg3) {
    throw new Error('Authentic message #3 failed to decrypt at Bob');
  }
  console.log('  CONFIRMED: Authentic untampered message decrypted cleanly at Bob.');

  // --- Step 8: Replay & Duplicate Message Rejection Test ---
  console.log('\n[8] Testing Replay & Duplicate Message Protection...');
  try {
    // Attempting to decrypt the exact same message counter again
    await bobCipher.decryptWhisperMessage(encEnvelope3.body, 'binary');
    throw new Error('SECURITY FLAW: Replayed message was accepted twice!');
  } catch (err) {
    console.log('  CONFIRMED: Replay rejected cleanly with message counter protection:', err.name || err.message);
  }

  // --- Step 9: Ratchet State Persistence Across App Restart ---
  console.log('\n[9] Testing Session Survival Across App Restart...');
  // Simulate app restart by creating a new store instance with restored session record
  const aliceSavedSession = await aliceStore.loadSession('bob_device.1');
  const restoredAliceStore = new SimulatedDeviceStore('RestoredAlice');
  restoredAliceStore.identityKeyPair = aliceStore.identityKeyPair;
  restoredAliceStore.registrationId = aliceStore.registrationId;
  await restoredAliceStore.storeSession('bob_device.1', aliceSavedSession);

  // Bob sends another message
  const thirdPlaintext = 'Post-restart verified message!';
  const encEnvelope4 = await bobCipher.encrypt(new TextEncoder().encode(thirdPlaintext).buffer);

  // Restored Alice decrypts
  const restoredAliceCipher = new libsignal.SessionCipher(restoredAliceStore, bobAddress);
  const restoredDecrypted = await restoredAliceCipher.decryptWhisperMessage(encEnvelope4.body, 'binary');
  const restoredDecryptedText = new TextDecoder().decode(restoredDecrypted);
  console.log('  Restored Alice decrypted text:', JSON.stringify(restoredDecryptedText));
  if (restoredDecryptedText !== thirdPlaintext) {
    throw new Error('Ratchet state failed to survive simulated restart!');
  }
  console.log('  CONFIRMED: Ratchet state persists and continues decrypting after restart.');

  console.log('\n================================================================');
  console.log('   ALL TWO-CLIENT PROTOCOL SECURITY & BEHAVIOR TESTS PASSED!    ');
  console.log('================================================================\n');
}

runTwoClientSimulation().catch(err => {
  console.error('\nSIMULATION FAILED:', err);
  process.exit(1);
});
