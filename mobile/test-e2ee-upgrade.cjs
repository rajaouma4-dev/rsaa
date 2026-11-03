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
  // A fresh login uses scoped keys. Restarting with a saved login must not
  // switch that account back to the old, unscoped identity.
  const scoped = client();
  await scoped.service.setAccount('account-a');
  const scopedBundle = await scoped.service.exportPreKeyBundle();
  const scopedRestart = client(scoped.data);
  await scopedRestart.service.setAccount('account-a', true);
  assert.equal((await scopedRestart.service.exportPreKeyBundle()).identityKey, scopedBundle.identityKey);
  assert.equal(scoped.data.has('nexa.e2ee.legacy_owner'), false);
  const interruptedScoped = client(new Map(alice.data));
  await interruptedScoped.service.setAccount('new-login');
  const interruptedRestart = client(interruptedScoped.data);
  await interruptedRestart.service.setAccount('new-login', true);
  assert.notEqual((await interruptedRestart.service.exportPreKeyBundle()).identityKey,
    JSON.parse(identity).pubKey);
  assert.equal(interruptedScoped.data.has('nexa.e2ee.legacy_owner'), false);

  // Saved pre-upgrade sessions retain their identity and ratchet; signing in
  // as another account creates separate keys and peer trust pins.
  const migrated = client(alice.data);
  await migrated.service.setAccount('alice', true);
  assert.equal((await migrated.service.exportPreKeyBundle()).identityKey,
    JSON.parse(identity).pubKey);
  const migratedMessage = await migrated.service.encrypt('bob', 'legacy ratchet restored');
  assert.equal(await bob.service.decrypt('alice', migratedMessage.type, migratedMessage.body_b64), 'legacy ratchet restored');
  await migrated.service.setAccount('other');
  const otherBundle = await migrated.service.exportPreKeyBundle();
  assert.notEqual(otherBundle.identityKey, JSON.parse(identity).pubKey);
  assert.equal(await migrated.service.hasSession('bob'), false);
  const otherBob = client();
  await migrated.service.establishSessionWithPeer('bob', await otherBob.service.exportPreKeyBundle());
  const otherMessage = await migrated.service.encrypt('bob', 'separate account');
  assert.equal(await otherBob.service.decrypt('other', otherMessage.type, otherMessage.body_b64), 'separate account');
  await migrated.service.setAccount('alice');
  const returnedMessage = await migrated.service.encrypt('bob', 'original account returns');
  assert.equal(await bob.service.decrypt('alice', returnedMessage.type, returnedMessage.body_b64), 'original account returns');
  await assert.rejects(() => migrated.service.establishSessionWithPeer('bob', otherBundle), /identity/i);
  console.log('PASS: concurrent/interrupted initialization; provider compatibility; persistent upgrade; replay/tamper and storage failure; scoped restart; legacy migration; account and peer-trust isolation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
