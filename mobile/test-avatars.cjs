const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict');
const disk=new Map();const storage={async getItem(k){return disk.get(k)||null},async setItem(k,v){disk.set(k,v)}};
function create(){const c={exports:{},Date,require(){return {default:storage}}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/services/avatars.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,c);return c.exports;}
const flush=()=>new Promise(r=>setImmediate(r));
(async()=>{const api=create();let requests=0,current={uid:'a',version:'1',data_uri:'data:image/jpeg;base64,one'};
api.configureAvatars(async(uid,version)=>{requests++;return {...current,data_uri:version===current.version?null:current.data_uri}});
let updates=0;const off=api.subscribeAvatar('a',()=>updates++);await Promise.all([api.loadAvatar('a'),api.loadAvatar('a')]);assert.equal(requests,1);assert.equal(api.avatarUri('a'),current.data_uri);
api.refreshVisibleAvatars();await flush();assert.equal(api.avatarUri('a'),current.data_uri);assert.equal(requests,2);
current={...current,version:'2',data_uri:'data:image/jpeg;base64,two'};api.avatarChanged('a','2');await flush();assert.equal(api.avatarUri('a'),current.data_uri);assert(updates>=2);
let release;api.configureAvatars(()=>new Promise(r=>release=r));await flush();api.installAvatar({uid:'a',version:'3',data_uri:'newest'});release({uid:'a',version:'2',data_uri:'stale'});await flush();assert.equal(api.avatarUri('a'),'newest');
api.installAvatar({uid:'a',version:'4',data_uri:null});assert.equal(api.avatarUri('a'),null);off();
api.installAvatar({uid:'b',version:'saved',data_uri:'cached'});await flush();const restarted=create();restarted.configureAvatars(async()=>{throw Error('Offline')});await restarted.loadAvatar('b');assert.equal(restarted.avatarUri('b'),'cached');
console.log('PASS: deduplicated downloads, version-only refresh, realtime subscribers, stale-response rejection, removal and persistent offline avatar cache');})().catch(e=>{console.error(e);process.exitCode=1});
