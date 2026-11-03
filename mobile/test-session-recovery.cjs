const fs = require('fs'), vm = require('vm'), ts = require('typescript'), assert = require('node:assert/strict');
function load(file, imports) {
  const context = {exports: {}, Buffer, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, require: imports};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText, context);
  return context.exports;
}
const {savedSessionIsInvalid} = load('src/services/session.ts', n => ({}));
const framing = load('src/services/framing.ts', n => require(n));
const {TlsSignalingClient} = load('src/services/signaling.ts', n => {
  if (n === './framing') return framing;
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
  const client = new TlsSignalingClient(); client.isConnected = true; client.ws = {send() {}};
  for (const code of ['AUTH_UNAVAILABLE', 'SESSION_EXPIRED']) {
    const response = client.request({type: 'resume', token: 'synthetic-test-token'}, 'auth_ok');
    await new Promise(resolve => setImmediate(resolve));
    for (const listener of [...client.listeners]) listener({type: 'error', code, message: 'server response'});
    await assert.rejects(response, error => error.code === code && savedSessionIsInvalid(error) === (code === 'SESSION_EXPIRED'));
  }
  console.log('PASS: transport/DNS/temporary auth failures retain login; explicit expired sessions require login; signaling error codes survive request rejection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
