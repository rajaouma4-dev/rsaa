// Exercise the production service with persistent, isolated Keychain doubles.
// Node WebCrypto checks wire compatibility; Android native execution is separate.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const lib = require('@privacyresearch/libsignal-protocol-typescript');
const native = require('node:crypto').webcrypto;
const legacy = require('@privacyresearch/libsignal-protocol-typescript/lib/msrcrypto');
const source = ts.transpileModule(fs.readFileSync('src/services/e2ee.ts', 'utf8') + '\nexport {SignalProtocolStore};', {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
}).outputText;

function client(data = new Map()) {
  const keychain = {
    identityWrites: 0,
    ACCESSIBLE: {WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only'},
    async getGenericPassword({service}) { return data.has(service) ? {password: data.get(service)} : false; },
    async setGenericPassword(user, password, {service}) {
      if (service === 'com.nexa.chat.e2ee.identity') this.identityWrites++;
      data.set(service, password); return {service};
    },
    async resetGenericPassword({service}) { data.delete(service); return true; },
  };
  const context = {exports: {}, console, Buffer, require(name) {
    if (name === 'react-native-keychain') return keychain;
    if (name === './nativeCrypto') return {signalCrypto: native, ensureNativeCrypto: async () => {}};
    return require(name);
  }};
  vm.runInNewContext(source, context);
  return {service: new context.exports.SignalE2EEService(), Store: context.exports.SignalProtocolStore, data, keychain};
}

(async () => {
  const alice = client(), bob = client();
  await Promise.all(Array.from({length: 8}, () => alice.service.initialize()));
  assert.equal(alice.keychain.identityWrites, 1);
  const identity = alice.data.get('com.nexa.chat.e2ee.identity');
  const bundle = await bob.service.exportPreKeyBundle();
  lib.setWebCrypto(legacy);
  await alice.service.establishSessionWithPeer('bob', bundle);
  const first = await alice.service.encrypt('bob', 'old provider: বাংলা');
  lib.setWebCrypto(native);
  assert.equal(await bob.service.decrypt('alice', first.type, first.body_b64), 'old provider: বাংলা');
  const reply = await bob.service.encrypt('alice', 'new provider reply');
  lib.setWebCrypto(legacy);
  assert.equal(await alice.service.decrypt('bob', reply.type, reply.body_b64), 'new provider reply');
  const resumed = client(alice.data);
  await resumed.service.initialize();
  assert.equal(alice.data.get('com.nexa.chat.e2ee.identity'), identity);
  const afterUpgrade = await resumed.service.encrypt('bob', 'session survives upgrade');
  assert.equal(await bob.service.decrypt('alice', afterUpgrade.type, afterUpgrade.body_b64), 'session survives upgrade');
  await assert.rejects(() => bob.service.decrypt('alice', afterUpgrade.type, afterUpgrade.body_b64));
  const corrupt = await resumed.service.encrypt('bob', 'authentic after tampering');
  const wire = Buffer.from(corrupt.body_b64, 'base64'); wire[wire.length - 1] ^= 1;
  await assert.rejects(() => bob.service.decrypt('alice', corrupt.type, wire.toString('base64')));
  assert.equal(await bob.service.decrypt('alice', corrupt.type, corrupt.body_b64), 'authentic after tampering');
  const failed = client();
  const store = new failed.Store();
  await store.storeSession('peer.1', 'durable');
  failed.keychain.setGenericPassword = async () => false;
  await assert.rejects(() => store.storeSession('peer.1', 'unsaved'), /unavailable/);
  assert.equal(await store.loadSession('peer.1'), 'durable');
  await assert.rejects(() => store.saveIdentityKeyPair({pubKey: new ArrayBuffer(33), privKey: new ArrayBuffer(32)}), /persist/);
  const interrupted = client();
  const persist = interrupted.keychain.setGenericPassword.bind(interrupted.keychain);
  interrupted.keychain.setGenericPassword = async (user, value, options) => {
    if (options.service === 'nexa.e2ee.signed_prekey_sig_1') throw Error('storage interrupted');
    return persist(user, value, options);
  };
  await assert.rejects(() => interrupted.service.initialize(), /interrupted/);
  const originalIdentity = interrupted.data.get('com.nexa.chat.e2ee.identity');
  interrupted.keychain.setGenericPassword = persist;
  await interrupted.service.exportPreKeyBundle();
  assert.equal(interrupted.data.get('com.nexa.chat.e2ee.identity'), originalIdentity);
  console.log('PASS: concurrent/interrupted initialization; legacy/WebCrypto bidirectional compatibility; persistent session upgrade; replay/tamper rejection; storage failure preserves durable state.');
})().catch(error => { console.error(error); process.exitCode = 1; });
