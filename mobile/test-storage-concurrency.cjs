const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const disk = new Map(); let rejectWrite = false;
const storage = {async getItem(k) { await new Promise(r => setImmediate(r)); return disk.get(k) || null; }, async setItem(k, v) { if (rejectWrite) throw Error('disk unavailable'); await new Promise(r => setImmediate(r)); disk.set(k, v); }};
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const context = {exports: {}, console, setTimeout, clearTimeout, require(n) {
    if (n.includes('async-storage')) return {default: storage};
    if (n.includes('utils/time')) return {getMessageTimestamp: m => m.timestamp || 0};
    if (n === './messageStatus') return load('messageStatus');
    throw Error(n);
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`src/services/${name}.ts`, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText, context);
  modules.set(name, context.exports); return context.exports;
}
(async () => {
  const store = load('messageStore');
  await Promise.all(Array.from({length: 100}, (_, i) => store.appendLocalMessage('chat', {id: `m${i}`, text: `message ${i}`, timestamp: i, from: 'me', status: 'sent'})));
  assert.equal((await store.getLocalMessages('chat')).length, 100);
  assert.equal(JSON.parse(disk.get('nexa.chat.messages.v2.chat')).length, 100);
  await Promise.all([store.updateLocalMessageStatus('chat', 'm1', 'seen'), store.appendLocalMessage('chat', {id: 'm1', text: 'message 1', status: 'saved'})]);
  assert.equal((await store.getLocalMessages('chat')).find(m => m.id === 'm1').status, 'seen');
  rejectWrite = true;
  await assert.rejects(() => store.appendLocalMessage('chat', {id: 'unsaved', text: 'must not ACK', status: 'sent'}));
  assert.equal((await store.getLocalMessages('chat')).some(m => m.id === 'unsaved'), false);
  rejectWrite = false;
  const {DurableOutbox} = load('outbox');
  const a = await DurableOutbox.open('alice');
  await Promise.all(Array.from({length: 100}, (_, i) => a.enqueue({messageId: `q${i}`, conversationId: 'chat', recipientUid: 'bob', ciphertextB64: 'encrypted'})));
  const restarted = await DurableOutbox.open('alice');
  assert.equal(restarted.due(1000).length, 100);
  assert.equal((await DurableOutbox.open('bob')).due(1000).length, 0);
  rejectWrite = true;
  await assert.rejects(() => restarted.acknowledge('q1'));
  assert.equal(restarted.due(1000).length, 100);
  rejectWrite = false;
  assert.equal((await restarted.acknowledge('q1')).conversationId, 'chat');
  assert.equal((await DurableOutbox.open('alice')).due(1000).length, 99);
  console.log('PASS: 100 concurrent local saves and queue writes; monotonic receipts; rejected writes fail closed; ciphertext queue survives restart and isolates accounts; ACK deletion is durable.');
})().catch(e => { console.error(e); process.exitCode = 1; });

