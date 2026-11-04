const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict'), path = require('node:path');
const ts = require('typescript');
const events = new Map(), intervals = new Map(), stored = new Map(), frames = [], opened = [], local = [];
let nextTimer = 0, account, permissions = 0, pendingOpen = 'cv_notification';
let version = 33, permissionFailure = false, permissionResult = 'denied', settingsOpened = 0;
let registration = {installationId:'test-installation-001',token:'valid-token-with-20-characters',enabled:true,configured:true,googleServices:true,receiptKey:'a'.repeat(64)};
const native = {
  async setAccount(uid) { account = uid; },
  async getRegistration() { return registration; },
  async setSoundEnabled(enabled) {
    registration={...registration,soundEnabled:enabled,channelId:enabled?'nexa_messages_bubble_v2':'nexa_messages_quiet_v2'};
    events.get('NexaPushTokenChanged')?.();
  },
  async consumeOpen() { const value = pendingOpen; pendingOpen = null; return value; },
  showMessage(...args) { local.push(args); }, openSettings() { settingsOpened++; },
};
const app = {currentState:'active', addEventListener(_name, callback) { events.set('state', callback); return {remove(){events.delete('state');}}; }};
const context = {exports:{},setInterval(fn) {const id=++nextTimer;intervals.set(id,fn);return id;},clearInterval(id){intervals.delete(id);},
  require(name) {
    if (name === 'react-native') return {AppState:app,NativeModules:{NexaNotifications:native},Platform:{OS:'android',get Version(){return version;}},
      PermissionsAndroid:{PERMISSIONS:{POST_NOTIFICATIONS:'notifications'},async check(){return false;},async request(){permissions++;if(permissionFailure)throw Error('Activity interrupted');return permissionResult;}},
      NativeEventEmitter:class {addListener(name,callback){events.set(name,callback);return{remove(){events.delete(name);}};}}};
    if (name.includes('async-storage')) return {default:{async getItem(k){return stored.get(k)||null;},async setItem(k,v){stored.set(k,v);}}};
    if (name.endsWith('/config')) return {APP_CONFIG:{SIGNALING_HOST:'notifications.test'}};
    return {};
  }};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'src/services/notifications.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
}).outputText,context);
const api=context.exports;
const flush = async () => {for(let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve));};
const state = next => {app.currentState=next;events.get('state')?.(next);};

(async()=>{
  let release;
  let signal={authenticated:true,request(frame){frames.push(frame);return new Promise(resolve=>{release=resolve;});},send(frame){frames.push(frame);}};
  const stop=api.startNotifications('account-a',()=>signal,id=>opened.push(id));
  await flush();
  assert.equal(account,'account-a'); assert.equal(permissions,1);
  assert.equal(opened[0],'cv_notification');
  assert.equal(frames[0].type,'register_push'); assert.equal(frames[0].foreground,true);
  assert.equal(frames[0].receipt_key,registration.receiptKey,'native rendering is enabled only with the installation receipt key');
  pendingOpen='cv_tapped_while_registering';
  state('active'); await flush();
  assert(opened.includes('cv_tapped_while_registering'),'notification tap must not wait for push registration or a network timeout');
  pendingOpen='cv_warm_intent';
  events.get('NexaNotificationOpened')(); await flush();
  assert(opened.includes('cv_warm_intent'),'a warm notification intent opens without an AppState transition');
  state('background'); await flush();
  assert(frames.some(f=>f.type==='push_state' && f.foreground===false),'background clears lease even while registration awaits ACK');
  release({}); await flush();
  assert.equal(frames.at(-1).foreground,false,'late registration response uses latest app state');
  signal={authenticated:true,async request(frame){frames.push(frame);},send(frame){frames.push(frame);}};
  for(const fn of intervals.values())fn(); await flush();
  assert.equal(frames.filter(f=>f.type==='register_push').length,2,'new authenticated connection re-registers the installation');
  registration={...registration,token:'rotated-token-with-20-characters'};
  events.get('NexaPushTokenChanged')(); await flush();
  assert.equal(frames.filter(f=>f.type==='register_push').at(-1).token,registration.token);
  await api.setNotificationSound(false);await flush();
  assert.equal(frames.filter(f=>f.type==='register_push').at(-1).channel_id,'nexa_messages_quiet_v2');
  assert.equal(frames.filter(f=>f.type==='register_push').at(-1).enabled,true,'sound off must not disable notifications');
  await api.setNotificationSound(true);await flush();
  assert.equal(frames.filter(f=>f.type==='register_push').at(-1).channel_id,'nexa_messages_bubble_v2');
  registration={...registration,enabled:false};
  state('active'); await flush();
  assert.equal(frames.filter(f=>f.type==='register_push').at(-1).enabled,false,'permission revocation disables server pushes');
  api.recordIncomingNotification('account-a','cv','message-1');
  assert.deepEqual(local[0],['account-a','cv','message-1','Nexa Chat',null,1]);
  api.recordIncomingNotification('account-a','cv-b','message-2',{name:'Bob',avatar:null,unread:3});
  assert.deepEqual(local[1],['account-a','cv-b','message-2','Bob',null,3],'sender identity/count stay scoped to the intended chat without message text');
  stop(); assert.equal(intervals.size,0);assert.equal(events.size,0);
  const before=frames.length;
  const stop2=api.startNotifications('account-b',()=>null,()=>{}); await flush();
  assert.equal(account,'account-b');assert.equal(permissions,1,'denied permission is not prompted repeatedly');
  assert.equal(frames.length,before,'disconnected session cannot register a token');
  stop2(); await api.clearNotificationAccount();assert.equal(account,null);
  stored.clear();
  version=35;app.currentState='background';
  const beforePermissions=permissions;
  const stop3=api.startNotifications('account-c',()=>null,()=>{});await flush();
  assert.equal(permissions,beforePermissions,'background startup must defer permission');
  assert.equal(stored.size,0,'hidden startup must not consume the permission attempt');
  permissionFailure=true;state('active');await flush();
  assert.equal(stored.size,0,'interrupted native request remains retryable');
  permissionFailure=false;state('active');await flush();
  assert.equal(permissions,beforePermissions+2,'resume retries the interrupted dialog');
  permissionResult='never_ask_again';
  await api.requestNotificationPermission(true);
  assert.equal(settingsOpened,1,'explicit enable opens settings if Android blocks another dialog');
  stop3();
  version=32;stored.clear();
  const android12Permissions=permissions;
  await api.requestNotificationPermission(true);
  assert.equal(permissions,android12Permissions,'Android 12 does not request Android 13 permission');
  assert.equal(settingsOpened,2,'explicit enable on older Android opens notification settings');
  console.log('PASS: foreground/background race, reconnect, token rotation, permission denial/revocation, notification open and account cleanup.');
})().catch(error=>{console.error(error);process.exitCode=1;});
