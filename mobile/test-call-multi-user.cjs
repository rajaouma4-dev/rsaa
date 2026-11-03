const fs = require('fs'), vm = require('vm'), ts = require('typescript'), assert = require('node:assert/strict');
const timers = [];
let provideMedia;
const mediaDevices = {getUserMedia: () => new Promise(resolve => { provideMedia = resolve; })};
const context = {exports: {}, console, Buffer, setTimeout(fn, ms) { timers.push({fn, ms}); return timers.length; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {}, require(n) {
  if (n === 'react-native') return {Platform: {OS: 'android'}, PermissionsAndroid: {}};
  if (n.includes('config')) return {APP_CONFIG: {}};
  return {mediaDevices,
    RTCPeerConnection: class {
      addTrack() {} addEventListener() {} close() {}
      async createOffer() { return {sdp: 'v=0'}; }
      async setLocalDescription() {}
    },
    RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } },
  };
}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/services/callService.ts', 'utf8') + '\nexport {CallService};', {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText, context);
const Call = context.exports.CallService;
function call(id = 'ab', peer = 'a', status = 'connected') {
  const c = new Call(); c.currentCallId = id; c.remoteUser = {uid: peer, name: peer}; c.status = status; return c;
}
(async () => {
  const b = call(), signals = [], records = [];
  b.setSignalSender((to, payload) => signals.push({to, ...payload})); b.onCallEnd(e => records.push(e));
  await b.handleSignal('c', {type: 'call_invite', callId: 'cb', callType: 'audio'});
  assert.equal(signals[0].type, 'call_busy'); assert.equal(b.status, 'connected'); assert.equal(records[0].status, 'busy');
  await b.handleSignal('c', {type: 'call_end', callId: 'ab'}); assert.equal(b.status, 'connected');
  b.endCall(); await b.handleSignal('a', {type: 'call_invite', callId: 'ab', sdp: 'expired'}); assert.equal(b.status, 'idle');
  for (const [type, reason, outcome] of [['call_busy', 'in_call', 'busy'], ['call_busy', 'offline', 'offline'], ['call_reject', 'Missed call', 'missed'], ['call_reject', 'Call declined', 'declined']]) {
    const c = call('outgoing', 'b', 'outgoing_ringing'); c.isCaller = true;
    const events = []; c.onCallEnd(e => events.push(e));
    await c.handleSignal('b', {type, callId: 'outgoing', reason});
    assert(c.getState().endReason); timers.findLast(t => t.ms === 800).fn(); assert.equal(events[0].status, outcome);
  }
  const outgoing = new Call(); let allow;
  outgoing.requestPermissions = () => new Promise(r => { allow = r; });
  const first = outgoing.startCall({uid: 'b', name: 'B'}, 'audio', 'A');
  await outgoing.startCall({uid: 'c', name: 'C'}, 'audio', 'A');
  assert.equal(outgoing.remoteUser.uid, 'b'); allow(false); await first;
  const cancelled = new Call(); cancelled.requestPermissions = async () => true;
  const opening = cancelled.startCall({uid: 'old', name: 'Old'}, 'audio', 'Me');
  await new Promise(resolve => setImmediate(resolve));
  cancelled.endCall();
  cancelled.currentCallId = 'new'; cancelled.remoteUser = {uid: 'new-peer', name: 'New'}; cancelled.status = 'connected';
  let stopped = 0;
  provideMedia({getTracks: () => [{stop() { stopped++; }}], release() {}});
  await opening;
  assert.equal(cancelled.currentCallId, 'new'); assert.equal(cancelled.status, 'connected'); assert.equal(stopped, 1);
  const disconnected = new Call(); disconnected.requestPermissions = async () => true;
  disconnected.setSignalSender(() => false);
  const failedStart = disconnected.startCall({uid: 'peer', name: 'Peer'}, 'audio', 'Me');
  await new Promise(resolve => setImmediate(resolve));
  provideMedia({getTracks: () => [], release() {}});
  await failedStart;
  assert.equal(disconnected.status, 'idle', 'Dropped invite must not leave a phantom outgoing call');
  console.log('PASS: third caller gets busy without disrupting current call; sender binding; late invite rejection; correct busy/offline/missed/declined history; duplicate outgoing tap guarded; cancelled media result cannot overwrite a newer call.');
})().catch(e => { console.error(e); process.exitCode = 1; });
