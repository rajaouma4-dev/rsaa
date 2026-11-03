const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path'),ts=require('typescript');
function load(file,extra='',mock=()=>({})) {const ctx={exports:{},console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,require:mock};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,file),'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,ctx);return ctx.exports;}
(async()=>{
 const {DataChannelWriter}=load('src/services/dataChannelWriter.ts');
 const packets=[],channel={readyState:'open',bufferedAmount:0,send(x){packets.push(x);}};
 const writer=new DataChannelWriter(channel),body='encrypted-'.repeat(40000);
 const big=writer.send(body),text=writer.send('tiny-encrypted-text');await Promise.all([big,text]);
 assert.ok(packets.indexOf('tiny-encrypted-text')<=4,'text must bypass remaining media chunks');
 const chunks=packets.filter(x=>x!=='tiny-encrypted-text').map(JSON.parse).sort((a,b)=>a.index-b.index);
 assert.equal(chunks.map(x=>x.data).join(''),body);assert.equal(new Set(chunks.map(x=>x.index)).size,chunks.length);
 let sent=0;const congested={readyState:'open',bufferedAmount:200000,send(){sent++;}};
 const blocked=new DataChannelWriter(congested);const waiting=blocked.send('ciphertext');await new Promise(r=>setTimeout(r,15));assert.equal(sent,0);congested.bufferedAmount=0;await waiting;assert.equal(sent,1);
 congested.bufferedAmount=200000;const closed=blocked.send('ciphertext');const rejection=assert.rejects(closed,/closed/);blocked.close();await rejection;
 const {advanceMessageStatus}=load('src/services/messageStatus.ts');assert.equal(advanceMessageStatus('seen','saved'),'seen');assert.equal(advanceMessageStatus('saved','delivered'),'delivered');
 const {optimizeSdp}=load('src/services/callService.ts','\nexport {optimizeSdp};',n=>n==='react-native'?{Platform:{OS:'android'},PermissionsAndroid:{}}:n.includes('config')?{APP_CONFIG:{}}:{});
 const video='m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
 const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=ptime:20\r\n'+video;
 const tuned=optimizeSdp(sdp);assert.equal(optimizeSdp(tuned),tuned);assert.ok(tuned.endsWith(video));assert.equal((tuned.match(/useinbandfec=/g)||[]).length,1);assert.ok(tuned.includes('usedtx=1'));assert.ok(tuned.includes('a=ptime:10\r\n'));assert.ok(!tuned.includes(';ptime='));
 console.log('PASS: text preempts media within four frames; media reassembles exactly; backpressure and close handled; receipts monotonic; Opus tuning idempotent and video unchanged.');
})().catch(e=>{console.error(e);process.exitCode=1;});
