const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path'),ts=require('typescript');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'src/services/visibleReadReceipts.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
const {acknowledgeVisibleMessages:ack}=context.exports;
(async()=>{
 let selected='a',active=true,connected=true,sent=[],read=[];
 const remembered=new Set();
 const messages=[{id:'incoming',from:'them',status:'delivered'},{id:'outgoing',from:'me',status:'sent'},{id:'already-seen',from:'them',status:'seen'}];
 const options={conversation:()=>selected,visible:()=>active,load:async()=>messages,sendSeen:id=>{if(!connected)return false;sent.push(id);return true;},acknowledged:remembered,markRead:id=>read.push(id)};
 assert.equal(await ack(options),true);assert.deepEqual(sent,['incoming']);assert.deepEqual(read,['a']);assert.equal(messages[0].status,'delivered','do not turn a buffered ACK into a permanently persisted read receipt');
 await ack(options);assert.deepEqual(sent,['incoming'],'same connection does not flood duplicate read ACKs');
 remembered.clear();connected=false;read=[];assert.equal(await ack(options),false);assert.equal(remembered.size,0);assert.equal(read.length,0);
 connected=true;assert.equal(await ack(options),true);assert.equal(sent.length,2,'reconnect retries the unconfirmed read');
 active=false;read=[];assert.equal(await ack(options),false);assert.equal(read.length,0,'background chat is not marked read');
 active=true;remembered.clear();let resolve;
 const pending=ack({...options,load:()=>new Promise(r=>{resolve=r;})});selected='b';resolve(messages);
 assert.equal(await pending,false);assert.equal(read.length,0,'switching chats during storage I/O cannot mark the old chat read');
 console.log('PASS: foreground resume read ACKs, transport retry, deduplication and hidden-chat protection');
})().catch(e=>{console.error(e);process.exitCode=1;});
