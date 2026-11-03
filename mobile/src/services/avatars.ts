import Storage from '@react-native-async-storage/async-storage';
export type AvatarRecord={uid:string;version:string;data_uri:string|null};
type Loader=(uid:string,version?:string)=>Promise<AvatarRecord>;
const records=new Map<string,AvatarRecord>(), listeners=new Map<string,Set<()=>void>>(), pending=new Map<string,Promise<void>>(), checked=new Map<string,number>(), desired=new Map<string,string>();
let loader:Loader|undefined;
export function avatarUri(uid?:string){return uid?records.get(uid)?.data_uri||null:null;}
function emit(uid:string){listeners.get(uid)?.forEach(fn=>fn());}
export function configureAvatars(next:Loader){loader=next;refreshVisibleAvatars();}
export function refreshVisibleAvatars(){checked.clear();for(const uid of listeners.keys())void loadAvatar(uid);}
export function avatarChanged(uid:string,version:string){desired.set(uid,version);if(records.get(uid)?.version===version)return;checked.delete(uid);if(listeners.get(uid)?.size)void loadAvatar(uid);}
export function installAvatar(record:AvatarRecord){
 desired.set(record.uid,record.version);records.set(record.uid,record);
 if(records.size>128)for(const key of records.keys()){if(!listeners.has(key)&&key!==record.uid){records.delete(key);checked.delete(key);desired.delete(key);if(records.size<=128)break;}}
 checked.set(record.uid,Date.now());emit(record.uid);
 void Storage.setItem('profile.avatar.'+record.uid,JSON.stringify(record)).catch(()=>{});
}
export function subscribeAvatar(uid:string,fn:()=>void){
 const set=listeners.get(uid)||new Set();set.add(fn);listeners.set(uid,set);void loadAvatar(uid);
 return ()=>{set.delete(fn);if(!set.size)listeners.delete(uid);};
}
export async function loadAvatar(uid:string):Promise<void>{
 if(pending.has(uid))return pending.get(uid);
 if(Date.now()-(checked.get(uid)||0)<60000)return;
 let stale=false;
 const job=(async()=>{
  try{
   if(!records.has(uid)){
    try{const saved=JSON.parse(await Storage.getItem('profile.avatar.'+uid)||'null');if(saved?.uid===uid){records.set(uid,saved);emit(uid);}}catch{}
   }
   if(!loader)return;
   const cached=records.get(uid);const expected=desired.get(uid);
   const result=await loader(uid,cached?.version);
   // A version event received while the request was running wins over its stale response.
   if(desired.get(uid)!==expected && desired.get(uid)!==result.version){stale=true;return;}
   const uri=result.data_uri || (cached?.version===result.version?cached.data_uri:null);
   installAvatar({...result,data_uri:uri});
  }catch{/* Cached photo/initials remain available; a reconnect or remount retries. */}
 })();pending.set(uid,job);
 try{await job;}finally{pending.delete(uid);if(stale&&records.get(uid)?.version!==desired.get(uid)&&listeners.get(uid)?.size){checked.delete(uid);void loadAvatar(uid);}}
}
