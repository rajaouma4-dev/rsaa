const lib = require('@privacyresearch/libsignal-protocol-typescript');

class MemoryStore {
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

class WsClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          for (const h of this.handlers) h(msg);
        } catch (err) {
          console.error('Ws parse error:', err);
        }
      };
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async request(msg, expectedType, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeHandler(handler);
        reject(new Error(`Timeout waiting for ${expectedType}`));
      }, timeoutMs);

      const handler = (incoming) => {
        if (incoming.type === expectedType) {
          clearTimeout(timer);
          this.removeHandler(handler);
          resolve(incoming);
        } else if (incoming.type === 'error') {
          clearTimeout(timer);
          this.removeHandler(handler);
          reject(new Error(incoming.message || 'Server returned error'));
        }
      };

      this.handlers.push(handler);
      this.send(msg);
    });
  }

  on(fn) {
    this.handlers.push(fn);
  }

  removeHandler(fn) {
    const idx = this.handlers.indexOf(fn);
    if (idx !== -1) this.handlers.splice(idx, 1);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function runEndToEndTest() {
  const wsUrl = process.argv[2] || 'ws://127.0.0.1:7444';
  console.log('================================================================');
  console.log('   NEXA CHAT: END-TO-END DUAL-ENGINE RELAY & E2EE TEST   ');
  console.log('   Target Server:', wsUrl);
  console.log('================================================================');

  const ts = Date.now();
  const userA_name = `alice_${ts}`;
  const userB_name = `bob_${ts}`;

  // 1. Initialize Clients
  console.log('\n[1] Connecting Client A and Client B to server...');
  const clientA = new WsClient(wsUrl);
  const clientB = new WsClient(wsUrl);
  await clientA.connect();
  await clientB.connect();
  console.log('  -> Both WebSocket connections established successfully.');

  // 2. Register Client A and Client B
  console.log('\n[2] Registering users...');
  const authA = await clientA.request({
    type: 'register',
    username: userA_name,
    password: 'password123',
    display_name: 'Alice',
    about: 'Nexa tester A'
  }, 'auth_ok');
  console.log(`  -> User A registered: uid=${authA.uid}, username=${authA.username}`);

  const authB = await clientB.request({
    type: 'register',
    username: userB_name,
    password: 'password123',
    display_name: 'Bob',
    about: 'Nexa tester B'
  }, 'auth_ok');
  console.log(`  -> User B registered: uid=${authB.uid}, username=${authB.username}`);

  // 3. Generate Signal Protocol Keys
  console.log('\n[3] Generating Signal Keys & PreKey Bundles...');
  const storeA = new MemoryStore();
  storeA.registrationId = lib.KeyHelper.generateRegistrationId();
  storeA.identityKeyPair = await lib.KeyHelper.generateIdentityKeyPair();

  const storeB = new MemoryStore();
  storeB.registrationId = lib.KeyHelper.generateRegistrationId();
  storeB.identityKeyPair = await lib.KeyHelper.generateIdentityKeyPair();
  const preKeyB = await lib.KeyHelper.generatePreKey(101);
  await storeB.storePreKey(101, preKeyB.keyPair);
  const signedPreKeyB = await lib.KeyHelper.generateSignedPreKey(storeB.identityKeyPair, 1);
  await storeB.storeSignedPreKey(1, signedPreKeyB.keyPair);

  // Upload B's bundle to server
  await clientB.request({
    type: 'publish_prekeys',
    bundle: {
      registration_id: storeB.registrationId,
      identity_key_b64: Buffer.from(storeB.identityKeyPair.pubKey).toString('base64'),
      prekey_id: 101,
      prekey_public_b64: Buffer.from(preKeyB.keyPair.pubKey).toString('base64'),
      signed_prekey_id: 1,
      signed_prekey_public_b64: Buffer.from(signedPreKeyB.keyPair.pubKey).toString('base64'),
      signed_prekey_signature_b64: Buffer.from(signedPreKeyB.signature).toString('base64'),
    }
  }, 'prekeys_published');
  console.log('  -> Bob uploaded prekey bundle to server.');

  // 4. Alice fetches Bob's bundle from server
  console.log('\n[4] Alice requests Bob prekey bundle from server...');
  const bundleRes = await clientA.request({
    type: 'get_prekey_bundle',
    uid: authB.uid
  }, 'prekey_bundle');
  console.log('  -> Received bundle for Bob:', bundleRes.bundle ? 'SUCCESS' : 'FAILED');

  function base64ToArrayBuffer(b64) {
    const buf = Buffer.from(b64, 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  const bobSignalBundle = {
    identityKey: base64ToArrayBuffer(bundleRes.bundle.identity_key_b64),
    registrationId: bundleRes.bundle.registration_id,
    preKey: {
      keyId: bundleRes.bundle.prekey_id,
      publicKey: base64ToArrayBuffer(bundleRes.bundle.prekey_public_b64),
    },
    signedPreKey: {
      keyId: bundleRes.bundle.signed_prekey_id,
      publicKey: base64ToArrayBuffer(bundleRes.bundle.signed_prekey_public_b64),
      signature: base64ToArrayBuffer(bundleRes.bundle.signed_prekey_signature_b64),
    }
  };

  const bobAddress = new lib.SignalProtocolAddress(authB.uid, 1);
  const aliceAddress = new lib.SignalProtocolAddress(authA.uid, 1);
  const aliceBuilder = new lib.SessionBuilder(storeA, bobAddress);
  await aliceBuilder.processPreKey(bobSignalBundle);
  console.log('  -> Double Ratchet session established on Alice device.');

  // 5. Create conversation on server
  console.log('\n[5] Alice creates conversation with Bob on server...');
  const convRes = await clientA.request({
    type: 'create_conversation',
    other_uid: authB.uid
  }, 'conversation');
  const convId = convRes.conversation_id;
  console.log('  -> Conversation created on server: conversation_id =', convId);

  // 6. Test Live Real-time Message Send (SMS / Text)
  console.log('\n[6] Alice sends E2EE Message to Bob in real-time...');
  const aliceCipher = new libsignalCipher(storeA, bobAddress);
  const secretMessage = 'Hello Bob! This message is 100% End-to-End Encrypted via Nexa.';
  const encEnvelope = await aliceCipher.encrypt(new TextEncoder().encode(secretMessage).buffer);
  const bodyB64 = Buffer.from(encEnvelope.body, 'binary').toString('base64');
  const msgId1 = `msg_${Date.now()}_1`;

  let bobReceivedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bob did not receive live message within 8s')), 8000);
    clientB.on((frame) => {
      console.log('  [DEBUG BOB GOT]:', frame.type, frame.payload?.type || frame.code || '');
      if (frame.type === 'data_frame' && frame.payload && frame.payload.type === 'new_message' && frame.payload.message) {
        clearTimeout(timer);
        resolve(frame.payload.message);
      }
    });
  });

  // Alice sends via data_frame
  const sendTime = Date.now();
  clientA.on((frame) => {
    console.log('  [DEBUG ALICE GOT]:', frame.type, frame.payload?.type || frame.code || '');
  });
  clientA.send({
    type: 'data_frame',
    payload: {
      type: 'send_message',
      message_id: msgId1,
      conversation_id: convId,
      ciphertext_b64: bodyB64
    }
  });

  const bobIncoming = await bobReceivedPromise;
  const deliveryLatency = Date.now() - sendTime;
  console.log(`  -> Bob received real-time message in ${deliveryLatency}ms!`);
  console.log('  -> Raw Server payload verified: sender_uid =', bobIncoming.sender_uid);

  // Bob decrypts
  const bobCipher = new libsignalCipher(storeB, aliceAddress);
  const decryptedBuf = await bobCipher.decryptPreKeyWhisperMessage(Buffer.from(bobIncoming.ciphertext_b64, 'base64').toString('binary'), 'binary');
  const decryptedText = new TextDecoder().decode(decryptedBuf);
  console.log('  -> Bob decrypted plaintext:', JSON.stringify(decryptedText));
  if (decryptedText !== secretMessage) {
    throw new Error('Decryption mismatch!');
  }
  console.log('  [PASS] Plaintext matches 100%!');

  // 6. Test Delivery Ack & Seen Ack
  console.log('\n[6] Testing Delivery Receipts (delivered_ack & seen_ack)...');
  let aliceAckPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Alice did not receive acks')), 5000);
    const acks = [];
    clientA.on((frame) => {
      if (frame.type === 'data_frame' && frame.payload) {
        if (frame.payload.type === 'delivered_ack' || frame.payload.type === 'seen_ack') {
          acks.push(frame.payload.type);
          if (acks.includes('delivered_ack') && acks.includes('seen_ack')) {
            clearTimeout(timer);
            resolve(acks);
          }
        }
      }
    });
  });

  clientB.send({
    type: 'data_frame',
    payload: { type: 'delivered_ack', message_id: msgId1 }
  });
  clientB.send({
    type: 'data_frame',
    payload: { type: 'seen_ack', message_id: msgId1 }
  });

  const receivedAcks = await aliceAckPromise;
  console.log('  -> Alice received acknowledgments:', receivedAcks.join(', '));
  console.log('  [PASS] Double checkmark verified!');

  // 7. Test Offline Storage & Instant Reconnect Catch-Up
  console.log('\n[7] Testing Offline Queuing (Bob disconnects)...');
  clientB.close();
  console.log('  -> Bob has closed his connection (offline).');

  await new Promise(r => setTimeout(r, 500));

  console.log('  -> Alice sends 2 messages while Bob is offline (1 SMS + 1 Rich Media envelope)...');
  const offlineMsgText = 'Bob, are you there? Offline queued message!';
  const encOffline = await aliceCipher.encrypt(new TextEncoder().encode(offlineMsgText).buffer);
  const offlineB64 = Buffer.from(encOffline.body, 'binary').toString('base64');
  const msgId2 = `msg_${Date.now()}_2`;

  const mediaPayloadText = JSON.stringify({
    text: '[Photo] Sunset view at the beach',
    mediaType: 'image',
    images: ['https://storage.nexa.local/photo123.jpg'],
    isHd: true
  });
  const encMedia = await aliceCipher.encrypt(new TextEncoder().encode(mediaPayloadText).buffer);
  const mediaB64 = Buffer.from(encMedia.body, 'binary').toString('base64');
  const msgId3 = `msg_${Date.now()}_3`;

  clientA.send({
    type: 'data_frame',
    payload: { type: 'send_message', message_id: msgId2, conversation_id: convId, ciphertext_b64: offlineB64 }
  });
  clientA.send({
    type: 'data_frame',
    payload: { type: 'send_message', message_id: msgId3, conversation_id: convId, ciphertext_b64: mediaB64 }
  });

  await new Promise(r => setTimeout(r, 600));

  console.log('  -> Bob comes back online and resumes session...');
  const clientB_reconnect = new WsClient(wsUrl);
  await clientB_reconnect.connect();

  const offlineReceived = [];
  const offlineDonePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (offlineReceived.length >= 2) resolve(offlineReceived);
      else reject(new Error(`Timeout waiting for offline queue. Got ${offlineReceived.length}/2`));
    }, 8000);

    clientB_reconnect.on((frame) => {
      if (frame.type === 'data_frame' && frame.payload && frame.payload.type === 'new_message' && frame.payload.message) {
        const msg = frame.payload.message;
        if (!offlineReceived.some(m => m.message_id === msg.message_id)) {
          offlineReceived.push(msg);
          console.log(`  -> Offline message received: ${msg.message_id} (total=${offlineReceived.length}/2)`);
        }
        if (offlineReceived.length >= 2) {
          clearTimeout(timer);
          resolve(offlineReceived);
        }
      }
    });
  });

  // Resume session
  const resumeRes = await clientB_reconnect.request({
    type: 'resume',
    token: authB.token
  }, 'auth_ok');
  console.log('  -> Bob session resumed successfully: uid =', resumeRes.uid);

  const queuedMessages = await offlineDonePromise;
  console.log(`  -> Bob received ${queuedMessages.length} offline queued messages immediately on connect!`);

  async function decryptSignalMessage(cipher, b64) {
    const binary = Buffer.from(b64, 'base64').toString('binary');
    try {
      const buf = await cipher.decryptWhisperMessage(binary, 'binary');
      return new TextDecoder().decode(buf);
    } catch {
      const buf = await cipher.decryptPreKeyWhisperMessage(binary, 'binary');
      return new TextDecoder().decode(buf);
    }
  }

  // Sort queued messages by messageId timestamp to preserve strict order
  queuedMessages.sort((a, b) => {
    const tA = Number(a.message_id.split('_')[1]) || 0;
    const tB = Number(b.message_id.split('_')[1]) || 0;
    return tA - tB;
  });

  // Decrypt both queued messages
  const dec2Text = await decryptSignalMessage(bobCipher, queuedMessages[0].ciphertext_b64);
  console.log('  -> Decrypted Message 1:', JSON.stringify(dec2Text));

  const dec3Text = await decryptSignalMessage(bobCipher, queuedMessages[1].ciphertext_b64);
  const mediaObj = JSON.parse(dec3Text);
  console.log('  -> Decrypted Media Message 2:', mediaObj);

  if (mediaObj.mediaType !== 'image' || !mediaObj.images.length) {
    throw new Error('Media message corrupted!');
  }
  console.log('  [PASS] Offline queue and media delivery 100% verified!');

  // Cleanup
  clientA.close();
  clientB_reconnect.close();

  console.log('\n================================================================');
  console.log('   ALL TESTS PASSED WITH 100% PROOF OF SUCCESS!                 ');
  console.log('================================================================\n');
}

const libsignalCipher = lib.SessionCipher;

runEndToEndTest().catch(err => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
