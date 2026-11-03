// Local test only: 2..100 production E2EE services + real Rust WebRTC clients.
// Does not launch Android, contact Render/Turso, or validate camera/audio/UI.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const ts = require('typescript');
const crypto = require('node:crypto');
const count = Number(process.argv[2] || 10);
if (!Number.isInteger(count) || count < 2 || count > 100 || count % 2) throw Error('Choose an even user count from 2 to 100');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'backend', 'target');
fs.mkdirSync(target, {recursive: true});
const runId = crypto.randomUUID();
const fixturePath = path.join(target, `load-fixture-${runId}.json`);
const resultPath = path.join(target, `load-result-${runId}.json`);
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'src/services/e2ee.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
}).outputText;
function device() {
  const records = new Map();
  const keychain = {
    ACCESSIBLE: {WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only'},
    async getGenericPassword({service}) { return records.has(service) ? {password: records.get(service)} : false; },
    async setGenericPassword(user, value, {service}) { records.set(service, value); return {service}; },
    async resetGenericPassword({service}) { records.delete(service); return true; },
  };
  const context = {exports: {}, console, Buffer, require(name) {
    if (name === 'react-native-keychain') return keychain;
    if (name === './nativeCrypto') return {signalCrypto: crypto.webcrypto, ensureNativeCrypto: async () => {}};
    return require(name);
  }};
  vm.runInNewContext(source, context);
  return new context.exports.SignalE2EEService();
}

(async () => {
  const devices = [], bundles = [], users = Array.from({length: count}, (_, i) => `load_user_${i}`);
  const messages = [], expected = new Map();
  for (let i = 0; i < count; i++) {
    const service = device(); devices.push(service);
    bundles.push(await service.exportPreKeyBundle());
  }
  for (let i = 0; i < count; i++) await devices[i].establishSessionWithPeer(users[i ^ 1], bundles[i ^ 1]);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < count; i++) {
      const text = `round ${round}, ${users[i]} -> ${users[i ^ 1]}: বাংলা`;
      const envelope = await devices[i].encrypt(users[i ^ 1], text);
      const id = `load_msg_${i}_${round}`;
      expected.set(id, {text, sender: i, recipient: i ^ 1});
      messages.push({sender: i, envelope: {type: 'send_message', message_id: id, ciphertext_b64: envelope.body_b64, msg_type: envelope.type}});
    }
  }
  const offlineText = 'persisted while recipient offline: বাংলা';
  const offlineCipher = await devices[1].encrypt(users[0], offlineText);
  const offlineId = 'load_offline_1';
  const offline = {sender: 1, envelope: {type: 'send_message', message_id: offlineId, ciphertext_b64: offlineCipher.body_b64, msg_type: offlineCipher.type}};
  expected.set(offlineId, {text: offlineText, sender: 1, recipient: 0});
  fs.writeFileSync(fixturePath, JSON.stringify({users, messages, offline}));
  console.log(`Prepared ${count} E2EE clients, ${messages.length} encrypted envelopes. Starting local DTLS/SCTP test (2 Rust worker threads).`);
  await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['test', '--offline', '-j', '2', 'load_test::multi_user_datachannels', '--', '--ignored', '--nocapture'], {
      cwd: path.join(root, 'backend'), env: {...process.env, NEXA_LOAD_FIXTURE: fixturePath, NEXA_LOAD_OUTPUT: resultPath}, stdio: 'inherit', windowsHide: true,
    });
    const timer = setTimeout(() => { child.kill(); reject(Error('Local load test exceeded five-minute limit')); }, 300000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Rust load test failed: ${code}`)); });
  });
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(result.saved, messages.length + 1);
  assert.equal(result.unique_received, messages.length + 1);
  for (const {recipient, message} of result.received) {
    const wanted = expected.get(message.message_id);
    assert(wanted, 'Unexpected message');
    assert.equal(recipient, wanted.recipient, 'Cross-user message delivery');
    assert.equal(message.sender_uid, users[wanted.sender]);
    const plain = await devices[recipient].decrypt(message.sender_uid, message.msg_type, message.ciphertext_b64);
    assert.equal(plain, wanted.text, 'E2EE plaintext mismatch');
    expected.delete(message.message_id);
  }
  assert.equal(expected.size, 0);
  const arrivals = result.received.map(m => m.arrival_ms).sort((a, b) => a - b);
  const summary = {users: count, messages: messages.length + 1, decrypted: messages.length + 1, offline_recovered: true, saved: result.saved, reconnect: result.reconnected, connect_ms: result.connect_ms, chat_ms: result.chat_ms, batch_arrival_p50_ms: arrivals[Math.floor(arrivals.length * .5)], batch_arrival_p95_ms: arrivals[Math.floor(arrivals.length * .95)], node_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024), note: 'Local SQLite/loopback batch completion bounds, not Render capacity, Android UI latency or one-way message latency'};
  fs.writeFileSync(path.join(target, `load-summary-${count}.json`), JSON.stringify(summary, null, 2));
  console.log('PASS:', JSON.stringify(summary));
})().catch(error => { console.error(error); process.exitCode = 1; });
