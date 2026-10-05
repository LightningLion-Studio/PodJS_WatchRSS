import {test,expect} from 'bun:test';
import {LibrarySyncSession,type LibrarySessionRepository,type TransferByteProgress} from '../../src/sync/session.ts';
import {StreamFrameConnection,TRANSFER_CHUNK_BYTES} from '../../src/sync/stream.ts';
import {FrameDecoder,encodeFrame,type JsonObject} from '../../src/sync/protocol.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
import {buildWatchMediaCapabilities} from '../../src/sync/media-capabilities.ts';
import {ReaderPreviewSession} from '../../src/reader/preview-session.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {handleReaderPreview} from '../../src/sync/reader-preview.ts';
import {fixture,sessionFixtureParts} from '../helpers/library-session-fixture.ts';

function phone(frames:JsonObject[],times:number[]=[],fragment=Infinity){
 const input=frames.map(encodeFrame),out:JsonObject[]=[],decoder=new FrameDecoder(),writes:number[]=[],reads:number[]=[],timeouts:number[]=[];
 let frame=0,offset=0,closed=0,time=0;
 const connection=new StreamFrameConnection({
  async read(max,timeout){reads.push(max);timeouts.push(timeout);if(frame>=input.length)return null;if(!offset)time=times[frame]??time;
   const raw=input[frame]!,end=Math.min(raw.length,offset+max,offset+fragment),bytes=raw.slice(offset,end);offset=end;if(offset===raw.length){frame++;offset=0;}return bytes;},
  async write(bytes){writes.push(bytes.length);out.push(...decoder.push(bytes));},async close(){closed++;}
 });
 return {connection,out,writes,reads,timeouts,clock:()=>time,closed:()=>closed,consumed:()=>frame};
}
function repository(){
 const row=fixture.cases[0]!,{window}=sessionFixtureParts(row);let marks=0;
 const repo:LibrarySessionRepository={deviceId:async()=>row.deviceId,cursor:async()=>row.beforeCursor,mergeSources:async()=>0,prepareWindow:async()=>window,exportSources:async()=>[],receiveArticle:async()=>0,exportRequested:async()=>[],finalizeSnapshot:async()=>{},resetPeerState:async()=>{},markSuccess:async()=>{marks++;}};
 return {repo,marks:()=>marks};
}
const preview=(sequence:number,extra:JsonObject={}):JsonObject=>({action:'previewReader',version:2,sessionId:'preview',phase:'update',sequence,changes:{name:'frame '+sequence},...extra});
function previewHandler(now:()=>number){
 const state=new ReaderPreviewSession({now,monotonic:now,after:()=>()=>{}});let count=0;
 return {state,handled:()=>count,handle:async(request:JsonObject)=>{count++;return handleReaderPreview(request,state,()=>{});}};
}
for(const terminal of ['stop','resourceHandoff'])test('continuous preview stream throttles at 50 ms and terminates without ACK: '+terminal,async()=>{
 const frames=[preview(1,{stream:true,preset:defaultReaderPreset()}),preview(2),preview(3,{phase:'heartbeat'}),preview(4),preview(4),preview(5,{phase:terminal})];
 const p=phone(frames,[1000,1020,1049,1050,1051,1052],7),h=previewHandler(p.clock),r=repository();const progress:TransferByteProgress[]=[];
 const results=await new LibrarySyncSession(p.connection,r.repo,{handleAction:h.handle,monotonic:p.clock,onTransferProgress:x=>progress.push(x)}).run();
 expect(h.handled()).toBe(6);expect(p.out.map(x=>x.sequence??x.phase)).toEqual([1,4,4,terminal==='stop'?'stop':5]);
 expect(p.out[2]?.applied).toBe(false);expect(p.consumed()).toBe(6);expect(p.closed()).toBe(1);expect(results).toHaveLength(1);expect(results[0]?.ack).toBeNull();expect(r.marks()).toBe(0);
 expect(p.timeouts).toContain(30000);expect(h.state.state()===null).toBe(terminal==='stop');h.state.dispose();
 expect(progress.filter(x=>x.direction==='read').reduce((n,x)=>n+x.bytes,0)).toBe(frames.reduce((n,x)=>n+encodeFrame(x).length,0));
});
test('preview interruption closes transport and a new session accepts reconnect',async()=>{
 for(let attempt=0;attempt<2;attempt++){
  const p=phone([preview(1,{stream:true,preset:defaultReaderPreset()}),preview(2)]),h=previewHandler(p.clock),r=repository();
  await expect(new LibrarySyncSession(p.connection,r.repo,{handleAction:h.handle,monotonic:p.clock}).run()).rejects.toThrow('Truncated');
  expect(h.handled()).toBe(2);expect(p.closed()).toBe(1);expect(r.marks()).toBe(0);h.state.dispose();
 }
});
test('preview stream rejects a different action instead of swallowing it as ACK',async()=>{
 const p=phone([preview(1,{stream:true,preset:defaultReaderPreset()}),{action:'ack',success:true}]),h=previewHandler(p.clock);
 await expect(new LibrarySyncSession(p.connection,repository().repo,{handleAction:h.handle}).run()).rejects.toThrow('其他蓝牙动作');expect(h.handled()).toBe(1);expect(p.closed()).toBe(1);h.state.dispose();
});
test('preview cancellation while applying a frame prevents reply and further reads',async()=>{
 const p=phone([preview(1,{stream:true})]);let release!:(r:JsonObject)=>void,started!:()=>void;const pending=new Promise<void>(r=>started=r);
 const session=new LibrarySyncSession(p.connection,repository().repo,{handleAction:async()=>{started();return new Promise(r=>release=r);}});
 const task=session.run();await pending;session.cancel();release({success:true,applied:true});await expect(task).rejects.toThrow('cancelled');expect(p.out).toEqual([]);expect(p.closed()).toBe(1);
});
for(const version of [13,14])for(const applied of [false,true])test(`v${version} received then ${applied?'applied':'EOF'} advances cursor only after applied`,async()=>{
 const row=fixture.cases[0]!;const frames=[{...row.inbound[0],version},row.inbound[1],{action:'ack',success:true,phase:'received',applied:false},...(applied?[{action:'ack',success:true,phase:'applied',applied:true}]:[])] as JsonObject[];
 const p=phone(frames,[],11),r=repository();const result=await new LibrarySyncSession(p.connection,r.repo).run();
 expect(r.marks()).toBe(applied?1:0);expect(result[0]?.libraryApplied).toBe(applied);expect(p.timeouts).toContain(120000);expect(p.closed()).toBe(1);
});
test('probe capabilities follow bound handlers and publish only known media data',async()=>{
 for(const wired of [false,true]){
  const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'watch',notesChanged:()=>{},...(wired?{readerSync:{apply:async()=>({success:true})},previewReader:()=>({success:true})}:{})});
  const media=buildWatchMediaCapabilities({physicalWidth:466,physicalHeight:466});
  const p=phone([{action:'syncLibrary',phase:'probe',version:14},{action:'ack',success:true,phase:'received'},{action:'ack',success:true,phase:'applied'}]);
  const result=await new LibrarySyncSession(p.connection,repository().repo,{handleAction:handler,watchCapabilities:media}).run();
  expect(p.out[0]).toMatchObject({supportsReaderPresets:wired,supportsReaderAssets:wired,supportsResourceChunkAck:wired,supportsReaderPresetPreview:wired,supportsTransferByteProgress:true,watchCapabilities:{widthPx:466,heightPx:466,videoDecoders:[]}});
  expect(media).not.toHaveProperty('refreshRateHz');expect(media).not.toHaveProperty('availableBytes');expect(result[0]?.ack?.applied).toBe(true);
  expect((await handler({action:'syncReader'})).success).toBe(wired);expect((await handler({action:'previewReader'})).success).toBe(wired);
 }
});
test('16 KiB body chunks and prefix deltas match native for both transfer directions',async()=>{
 const frame={text:'中'.repeat(15000)},raw=encodeFrame(frame),p=phone([frame]),progress:TransferByteProgress[]=[];
 p.connection.setTransferProgress(x=>progress.push(x));expect(await p.connection.readFrame(1000)).toEqual(frame);await p.connection.writeFrame(frame);
 const chunks=[4,16384,16384,raw.length-4-32768];expect(p.reads).toEqual(chunks);expect(p.writes).toEqual(chunks);expect(TRANSFER_CHUNK_BYTES).toBe(16384);
 for(const direction of ['read','write'])expect(progress.filter(x=>x.direction===direction).map(x=>x.bytes)).toEqual(chunks);await p.connection.close();
});
test('interrupted writes count only completed chunks and close once',async()=>{
 const progress:TransferByteProgress[]=[];let count=0,closed=0;
 const c=new StreamFrameConnection({read:async()=>null,write:async()=>{if(++count===3)throw Error('disconnected');},close:async()=>{closed++;}});c.setTransferProgress(p=>progress.push(p));
 await expect(c.writeFrame({text:'x'.repeat(40000)})).rejects.toThrow('disconnected');expect(progress.map(p=>p.bytes)).toEqual([4,16384]);expect(closed).toBe(1);await expect(c.writeFrame({})).rejects.toThrow('closed');
});
test('truncated body reports prefix and actual bytes without a completed frame',async()=>{
 const raw=encodeFrame({text:'x'.repeat(40000)}).slice(0,17000),progress:TransferByteProgress[]=[];let offset=0,closed=0;
 const c=new StreamFrameConnection({read:async max=>{if(offset===raw.length)return null;const bytes=raw.slice(offset,offset+max);offset+=bytes.length;return bytes;},write:async()=>{},close:async()=>{closed++;}});c.setTransferProgress(p=>progress.push(p));
 await expect(c.readFrame(1000)).rejects.toThrow('Truncated');expect(progress.map(p=>p.bytes)).toEqual([4,16384,612]);expect(closed).toBe(1);
});
