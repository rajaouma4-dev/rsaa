import Storage from '@react-native-async-storage/async-storage';
export type Appearance = {wallpaper: string; color: string; effect: 'solid'|'gradient'|'glow'};
export type Wallpaper = {id: string; name: string; version: string; data_uri: string};
export const DEFAULT_APPEARANCE: Appearance = {wallpaper: 'botanical', color: '#7957E8', effect:'gradient'};
export const BUBBLE_COLORS = ['#7957E8','#1669D8','#087E74','#A63878','#A54520','#485C78'];
export async function readAppearance(chatId: string): Promise<Appearance> {
 try { const value=JSON.parse(await Storage.getItem('chat.appearance.'+chatId)||'null');
  return value && /^#[0-9a-f]{6}$/i.test(value.color) && typeof value.wallpaper==='string' ? {...value,effect:['solid','gradient','glow'].includes(value.effect)?value.effect:'gradient'} : DEFAULT_APPEARANCE;
 } catch { return DEFAULT_APPEARANCE; }
}
export async function saveAppearance(chatId: string, value: Appearance) {
 await Storage.setItem('chat.appearance.'+chatId,JSON.stringify(value));
}
let pending: Promise<Wallpaper[]> | undefined;
export async function loadWallpapers(fetchThemes: (id?: string) => Promise<any>): Promise<Wallpaper[]> {
 if(pending) return pending;
 pending=(async()=>{
  const saved=JSON.parse(await Storage.getItem('chat.wallpaper.catalog')||'null');
  let catalog=saved?.items || [];
  if(!saved || Date.now()-saved.at>86400000) {
   try { catalog=await fetchThemes(); await Storage.setItem('chat.wallpaper.catalog',JSON.stringify({at:Date.now(),items:catalog})); }
   catch(error) { if(!catalog.length) throw error; }
  }
  const result: Wallpaper[]=[];
  for(const item of catalog) {
   const key='chat.wallpaper.'+item.id;
   let asset=JSON.parse(await Storage.getItem(key)||'null');
   if(asset?.version!==item.version) {
    try { const fresh=await fetchThemes(item.id);
     if(!/^data:image\/jpeg;base64,/.test(fresh.data_uri)||fresh.data_uri.length>60000) throw Error('Invalid wallpaper');
     await Storage.setItem(key,JSON.stringify(fresh)); asset=fresh;
    } catch(error) { if(!asset) continue; }
   }
   result.push(asset);
  }
  return result;
 })();
 try { return await pending; } finally {pending=undefined;}
}
export async function cachedWallpapers(): Promise<Wallpaper[]> {
 try { const saved=JSON.parse(await Storage.getItem('chat.wallpaper.catalog')||'null');
 const items=[]; for(const item of saved?.items||[]) {const asset=await Storage.getItem('chat.wallpaper.'+item.id);if(asset)items.push(JSON.parse(asset));} return items;
 } catch {return [];}
}

export function bubbleTextColor(color:string):string {
 const n=parseInt(color.slice(1),16);return (((n>>16)&255)*.299+((n>>8)&255)*.587+(n&255)*.114)>165?'#101828':'#FFFFFF';
}
export function bubbleEffect(value:Appearance) {
 return value.effect==='gradient'?{backgroundImage:`linear-gradient(135deg, ${value.color}, ${value.color}BB)`}:
 value.effect==='glow'?{shadowColor:value.color,shadowOpacity:.5,shadowRadius:8,shadowOffset:{width:0,height:2},elevation:4}:{};
}
