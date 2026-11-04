const fs = require('fs'), vm = require('vm'), ts = require('typescript'), assert = require('node:assert/strict');
const intervals = [];
function load(file, imports) {
  const context = {exports: {}, Buffer, console, setTimeout, clearTimeout, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {}, require: imports};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText, context);
  return context.exports;
}
const {savedSessionIsInvalid} = load('src/services/session.ts', n => ({}));
const framing = load('src/services/framing.ts', n => require(n));
const {TlsSignalingClient} = load('src/services/signaling.ts', n => {
  if (n === './framing') return framing;
  if (n === './requestScheduler') return load('src/services/requestScheduler.ts', n => require(n));
  if (n.includes('config')) return {APP_CONFIG: {MAX_SIGNAL_FRAME_BYTES: 65536}};
  if (n.includes('tcp-socket')) return {};
  return require(n);
});
(async () => {
  assert.equal(savedSessionIsInvalid(Error('Signaling connection closed')), false);
  assert.equal(savedSessionIsInvalid(Error('DNS unavailable')), false);
  assert.equal(savedSessionIsInvalid({code: 'AUTH_UNAVAILABLE', message: 'retry shortly'}), false);
  assert.equal(savedSessionIsInvalid({code: 'SESSION_EXPIRED', message: 'sign in again'}), true);
  assert.equal(savedSessionIsInvalid(Error('invalid or expired session')), true);
  const client = new TlsSignalingClient(); client.isConnected = true; client.ws = {readyState:1,send() {}};
  for (const code of ['AUTH_UNAVAILABLE', 'SESSION_EXPIRED']) {
    const response = client.request({type: 'resume', token: 'synthetic-test-token'}, 'auth_ok');
    await new Promise(resolve => setImmediate(resolve));
    for (const listener of [...client.listeners]) listener({type: 'error', code, message: 'server response'});
    await assert.rejects(response, error => error.code === code && savedSessionIsInvalid(error) === (code === 'SESSION_EXPIRED'));
  }
  const reports = [], synced = new TlsSignalingClient();
  synced.isConnected = true;
  synced.ws = {readyState:1,send(raw) { reports.push(JSON.parse(raw)); }};
  let activeCall = null;
  synced.setCallStateProvider(() => activeCall);
  synced.setAuthenticated(false);
  assert.equal(reports.length, 0);
  synced.setAuthenticated(true);
  assert.equal(reports[0].type, 'call_state'); assert.equal(reports[0].call_id, null);
  activeCall = 'active-call';
  intervals.at(-1)();
  assert.equal(reports.at(-2).call_id, activeCall); assert.equal(reports.at(-1).type, 'ping');
  synced.awaitingPong = false; activeCall = null;
  intervals.at(-1)();
  assert.equal(reports.at(-2).call_id, null);
  synced.ws.readyState=2;
  assert.equal(synced.connected,false,'closing sockets must not keep the send path looking connected');
  console.log('PASS: temporary failures retain login; expiry requires login; signaling preserves error codes; authenticated reconnect and heartbeats report actual call state.');
})().catch(error => { console.error(error); process.exitCode = 1; });
