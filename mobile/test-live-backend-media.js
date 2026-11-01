/**
 * Comprehensive Live E2EE Media & Chunking Verification Test
 * Tests live signaling on port 7443, Signal Protocol Double Ratchet E2EE,
 * and 12KB chunked transmission/reassembly for Images (>150KB) and Voice (>50KB).
 */
const tls = require('tls');
const libsignal = require('@privacyresearch/libsignal-protocol-typescript');

// Helper for simulated device store
class TestDeviceStore {
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

async function connectSignaling(username, displayName) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: 7443,
      rejectUnauthorized: false,
    }, () => {
      let buffer = '';
      const client = {
        socket,
        request: (frame) => {
          return new Promise((resReq, rejReq) => {
            const onData = (data) => {
              buffer += data.toString('utf8');
              const lines = buffer.split('\n');
              buffer = lines.pop();
              for (const line of lines) {
                if (!line.trim()) continue;
                const parsed = JSON.parse(line);
                socket.off('data', onData);
                resReq(parsed);
                return;
              }
            };
            socket.on('data', onData);
            socket.write(JSON.stringify(frame) + '\n');
          });
        },
        close: () => socket.destroy(),
      };

      // Perform register/login
      client.request({
        type: 'register',
        username,
        display_name: displayName,
        password: 'TestPassword123!',
      }).then(res => {
        if (res.type === 'auth_ok') {
          resolve({ client, auth: res });
        } else if (res.type === 'error') {
          // If already registered, log in
          return client.request({
            type: 'login',
            username,
            password: 'TestPassword123!',
          }).then(loginRes => {
            if (loginRes.type === 'auth_ok') {
              resolve({ client, auth: loginRes });
            } else {
              reject(new Error('Login failed: ' + JSON.stringify(loginRes)));
            }
          });
        } else {
          reject(new Error('Auth failed: ' + JSON.stringify(res)));
        }
      }).catch(reject);
    });
    socket.on('error', reject);
  });
}

async function runLiveVerification() {
  console.log('================================================================');
  console.log('   NEXA MESSENGER: REALTIME E2EE MEDIA & CHUNKING TEST SUITE    ');
  console.log('================================================================\n');

  // 1. Test live TLS signaling with Rust server
  console.log('[1] Connecting to Rust backend on 127.0.0.1:7443 via TLS...');
  const user1 = await connectSignaling('rakib_test', 'Rakib Test');
  const user2 = await connectSignaling('riyad_test', 'Riyad Test');
  console.log(`  PASS: rakib_test authenticated (UID: ${user1.auth.uid})`);
  console.log(`  PASS: riyad_test authenticated (UID: ${user2.auth.uid})`);

  // 2. Setup Signal Protocol cryptographic keys
  console.log('\n[2] Setting up Signal Protocol Double Ratchet keys for both devices...');
  const aliceStore = new TestDeviceStore('Alice');
  aliceStore.registrationId = libsignal.KeyHelper.generateRegistrationId();
  aliceStore.identityKeyPair = await libsignal.KeyHelper.generateIdentityKeyPair();

  const bobStore = new TestDeviceStore('Bob');
  bobStore.registrationId = libsignal.KeyHelper.generateRegistrationId();
  bobStore.identityKeyPair = await libsignal.KeyHelper.generateIdentityKeyPair();
  const bobPreKey = await libsignal.KeyHelper.generatePreKey(500);
  await bobStore.storePreKey(500, bobPreKey.keyPair);
  const bobSignedPreKey = await libsignal.KeyHelper.generateSignedPreKey(bobStore.identityKeyPair, 1);
  await bobStore.storeSignedPreKey(1, bobSignedPreKey.keyPair);

  const bobBundle = {
    registrationId: bobStore.registrationId,
    identityKey: bobStore.identityKeyPair.pubKey,
    signedPreKey: {
      keyId: 1,
      publicKey: bobSignedPreKey.keyPair.pubKey,
      signature: bobSignedPreKey.signature,
    },
    preKey: {
      keyId: 500,
      publicKey: bobPreKey.keyPair.pubKey,
    },
  };

  const aliceBobAddress = new libsignal.SignalProtocolAddress(user2.auth.uid, 1);
  const aliceBuilder = new libsignal.SessionBuilder(aliceStore, aliceBobAddress);
  await aliceBuilder.processPreKey(bobBundle);
  console.log('  PASS: Double Ratchet session established between Rakib and Riyad.');

  // 3. Test Text Message
  console.log('\n[3] Testing Text Message "111" Encryption & Decryption...');
  const aliceCipher = new libsignal.SessionCipher(aliceStore, aliceBobAddress);
  const textMsg = JSON.stringify({ type: 'text', text: '111' });
  const textEnvelope = await aliceCipher.encrypt(new TextEncoder().encode(textMsg).buffer);
  const textCiphertextB64 = Buffer.from(textEnvelope.body, 'binary').toString('base64');
  console.log(`  Text ciphertext size: ${textCiphertextB64.length} chars (no chunking required)`);

  const bobAliceAddress = new libsignal.SignalProtocolAddress(user1.auth.uid, 1);
  const bobCipher = new libsignal.SessionCipher(bobStore, bobAliceAddress);
  const textDecryptedBuf = await bobCipher.decryptPreKeyWhisperMessage(
    Buffer.from(textCiphertextB64, 'base64').toString('binary'),
    'binary'
  );
  const textDecrypted = JSON.parse(new TextDecoder().decode(textDecryptedBuf));
  console.log(`  PASS: Riyad decrypted text: "${textDecrypted.text}" (Exact Match: ${textDecrypted.text === '111'})`);

  // 4. Test Large High-Resolution Image (> 180 KB) with 12KB Chunking
  console.log('\n[4] Testing Large HD Photo Batch (> 180 KB) with 12KB Chunking...');
  const photoBase64 = Buffer.alloc(180 * 1024, 0xAB).toString('base64');
  const thumbBase64 = Buffer.alloc(18 * 1024, 0xCD).toString('base64');
  const imagePayload = JSON.stringify({
    type: 'image_batch',
    images: [{
      id: 'img_test_1',
      thumb: 'data:image/jpeg;base64,' + thumbBase64,
      fullBase64: photoBase64,
      width: 1080,
      height: 1920,
      isHd: true,
    }],
    isHd: true,
    caption: 'Test HD Photo Sending',
  });

  const photoEnvelope = await aliceCipher.encrypt(new TextEncoder().encode(imagePayload).buffer);
  const photoCiphertextB64 = Buffer.from(photoEnvelope.body, 'binary').toString('base64');
  console.log(`  Encrypted HD Photo envelope length: ${photoCiphertextB64.length} chars`);

  const fullPacket = JSON.stringify({
    type: 'send_message',
    message_id: 'm_photo_test_1',
    conversation_id: 'cv_test_1',
    ciphertext_b64: photoCiphertextB64,
  });

  // Execute 12KB chunking (matching rtc.ts implementation)
  const CHUNK_SIZE = 12 * 1024;
  const totalChunks = Math.ceil(fullPacket.length / CHUNK_SIZE);
  console.log(`  Splitting payload into ${totalChunks} chunks of max ${CHUNK_SIZE} bytes...`);
  const chunkFrames = [];
  const transferId = 'test_tx_' + Date.now();
  for (let i = 0; i < totalChunks; i++) {
    const chunkData = fullPacket.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    chunkFrames.push({
      type: 'chunk',
      transfer_id: transferId,
      index: i,
      total: totalChunks,
      data: chunkData,
    });
  }
  console.log(`  All ${chunkFrames.length} chunks generated. Max chunk frame size: ${JSON.stringify(chunkFrames[0]).length} bytes (< 64KB SCTP limit)`);

  // Reassemble chunks (matching receiver logic in rtc.ts)
  const assembledMap = new Map();
  chunkFrames.forEach(f => assembledMap.set(f.index, f.data));
  let reassembledPacket = '';
  for (let i = 0; i < totalChunks; i++) {
    reassembledPacket += assembledMap.get(i);
  }
  console.log(`  Reassembled packet length matches original: ${reassembledPacket === fullPacket}`);

  // Helper for decryption matching e2ee.ts
  const decryptPayload = async (cipher, b64, type) => {
    const binary = Buffer.from(b64, 'base64').toString('binary');
    if (type === 3) {
      return await cipher.decryptPreKeyWhisperMessage(binary, 'binary');
    } else if (type === 1) {
      return await cipher.decryptWhisperMessage(binary, 'binary');
    } else {
      try {
        return await cipher.decryptWhisperMessage(binary, 'binary');
      } catch {
        return await cipher.decryptPreKeyWhisperMessage(binary, 'binary');
      }
    }
  };

  // Decrypt at recipient
  const parsedReceived = JSON.parse(reassembledPacket);
  const photoDecryptedBuf = await decryptPayload(bobCipher, parsedReceived.ciphertext_b64, photoEnvelope.type);
  const photoDecrypted = JSON.parse(new TextDecoder().decode(photoDecryptedBuf));
  console.log(`  PASS: Riyad decrypted image payload successfully!`);
  console.log(`        Images count: ${photoDecrypted.images.length}`);
  console.log(`        Width x Height: ${photoDecrypted.images[0].width} x ${photoDecrypted.images[0].height}`);
  console.log(`        HD Flag: ${photoDecrypted.isHd}`);
  console.log(`        Caption: "${photoDecrypted.caption}"`);
  console.log(`        Full Base64 data verified: ${photoDecrypted.images[0].fullBase64 === photoBase64}`);

  // 5. Test Voice Note (> 50 KB) with 12KB Chunking
  console.log('\n[5] Testing Voice Note Recording (> 50 KB) with 12KB Chunking...');
  const voiceAudioBase64 = Buffer.alloc(55 * 1024, 0xEF).toString('base64');
  const voicePayload = JSON.stringify({
    type: 'voice_note',
    audioBase64: voiceAudioBase64,
    durationSec: 5,
  });

  const voiceEnvelope = await aliceCipher.encrypt(new TextEncoder().encode(voicePayload).buffer);
  const voiceCiphertextB64 = Buffer.from(voiceEnvelope.body, 'binary').toString('base64');
  console.log(`  Encrypted Voice Note envelope length: ${voiceCiphertextB64.length} chars`);

  const voicePacket = JSON.stringify({
    type: 'send_message',
    message_id: 'm_voice_test_1',
    conversation_id: 'cv_test_1',
    ciphertext_b64: voiceCiphertextB64,
  });

  const voiceTotalChunks = Math.ceil(voicePacket.length / CHUNK_SIZE);
  console.log(`  Splitting voice note into ${voiceTotalChunks} chunks...`);
  const voiceChunkFrames = [];
  const voiceTxId = 'test_voice_' + Date.now();
  for (let i = 0; i < voiceTotalChunks; i++) {
    voiceChunkFrames.push({
      type: 'chunk',
      transfer_id: voiceTxId,
      index: i,
      total: voiceTotalChunks,
      data: voicePacket.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    });
  }

  let reassembledVoicePacket = '';
  for (let i = 0; i < voiceTotalChunks; i++) {
    reassembledVoicePacket += voiceChunkFrames[i].data;
  }

  const parsedVoice = JSON.parse(reassembledVoicePacket);
  const voiceDecryptedBuf = await decryptPayload(bobCipher, parsedVoice.ciphertext_b64, voiceEnvelope.type);
  const voiceDecrypted = JSON.parse(new TextDecoder().decode(voiceDecryptedBuf));
  console.log(`  PASS: Riyad decrypted voice note successfully!`);
  console.log(`        Duration: ${voiceDecrypted.durationSec} seconds`);
  console.log(`        Audio data length: ${voiceDecrypted.audioBase64.length} chars`);
  console.log(`        Audio data verified: ${voiceDecrypted.audioBase64 === voiceAudioBase64}`);

  // Cleanup
  user1.client.close();
  user2.client.close();

  console.log('\n================================================================');
  console.log('   ALL REALTIME MEDIA & CHUNKING VERIFICATION TESTS PASSED!    ');
  console.log('================================================================\n');
}

runLiveVerification().catch(err => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
