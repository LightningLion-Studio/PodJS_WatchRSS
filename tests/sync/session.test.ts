import {test,expect} from 'bun:test';
import {fixture,replaySessionFixture,normalizeSessionResponse,sessionFixtureParts} from '../helpers/library-session-fixture.ts';
import {LibrarySyncSession,type LibrarySessionRepository} from '../../src/sync/session.ts';
import {StreamFrameConnection} from '../../src/sync/stream.ts';
import {encodeFrame,decodeFrame,type JsonObject} from '../../src/sync/protocol.ts';
import {buildManifestFrames,combineManifestFrames,buildChunkedResponseFrames} from '../../src/sync/library-wire.ts';
for(const row of fixture.cases)test('native watch session: '+row.input.name,async()=>{
 const actual=await replaySessionFixture(row);expect(normalizeSessionResponse(actual.outbound)).toEqual(normalizeSessionResponse(row.outbound));expect(actual.peer).toEqual(row.peer);expect(actual.closed).toBe(true);expect(actual.actions.length).toBe(row.completedActions);
 if(row.input.name==='watch-source-nonempty-phone-article'){expect(row.returned).toBe(true);expect(row.itemCount).toBe(0);expect((row.inbound[1] as JsonObject).articles).toHaveLength(1);}
 if(row.unreadInputBytes>0)expect(actual.unread).toBeGreaterThan(0);
 if(row.peer){expect(actual.events.lastIndexOf('mark')).toBeGreaterThan(actual.events.lastIndexOf('write:manifest'));expect(actual.events.lastIndexOf('mark')).toBeGreaterThan(actual.events.indexOf('read:ack:applied'));}
});
test('no peer update when final write or peer persistence fails',async()=>{
 const row=fixture.cases[0]!;await expect(replaySessionFixture(row,repo=>{repo.markSuccess=async()=>{throw new Error('disk full');};})).rejects.toThrow('disk full');
 const {window}=sessionFixtureParts(row);let marked=false,closed=false;
 const repo:LibrarySessionRepository={deviceId:async()=>row.deviceId,cursor:async()=>row.beforeCursor,mergeSources:async()=>0,prepareWindow:async()=>window,exportSources:async()=>[],receiveArticle:async()=>0,exportRequested:async()=>[],finalizeSnapshot:async()=>{},resetPeerState:async()=>{},markSuccess:async()=>{marked=true;}};
 let index=0;const s=new LibrarySyncSession({readFrame:async()=>row.inbound[index++]! as JsonObject,writeFrame:async frame=>{if(frame.phase==='complete')throw new Error('socket write failed');},close:async()=>{closed=true;}},repo);
 const result=await s.run();expect(result[0]!.response.fatalSession).toBe(true);expect(marked).toBe(false);expect(closed).toBe(true);
});
test('watch-to-phone replacement ignores incoming articles while completing the native batch exchange',async()=>{
 const row=fixture.cases[0]!,{window}=sessionFixtureParts(row);
 const manifest={...(row.inbound[0] as JsonObject),libraryMode:'watchToPhoneReplace'};
 const articles={...(row.inbound[1] as JsonObject),articles:[{articleId:'remote-only',url:'https://phone.example/post',title:'Phone article',body:{bodyHash:'hash',bodyByteCount:1,chunkSize:1,chunkHashes:['chunk'],chunks:[{index:0,hash:'chunk',data:'AA=='}]}}]};
 const incoming=[manifest,articles,row.inbound[2] as JsonObject],outgoing:JsonObject[]=[];let index=0,received=0,reset=0,marked=0;
 const repo:LibrarySessionRepository={deviceId:async()=>row.deviceId,cursor:async()=>row.beforeCursor,mergeSources:async()=>0,prepareWindow:async()=>window,exportSources:async()=>window.rssSources,receiveArticle:async()=>{received++;return 1;},exportRequested:async()=>[],finalizeSnapshot:async()=>{},resetPeerState:async()=>{reset++;},markSuccess:async()=>{marked++;}};
 const session=new LibrarySyncSession({readFrame:async()=>incoming[index++]!,writeFrame:async frame=>{outgoing.push(frame);},close:async()=>{}},repo,{now:()=>1789340000000});
 const result=await session.run();
 expect(result[0]?.response.success).toBe(true);
 expect((outgoing.find(frame=>frame.phase==='complete')?.stats as JsonObject)?.applied).toBe(0);
 expect(received).toBe(0);expect(reset).toBe(1);expect(marked).toBe(1);
});
test('cancel while repository prepare is pending prevents manifest and ACK progress',async()=>{
 const row=fixture.cases[0]!,{window}=sessionFixtureParts(row);let release!:(value:typeof window)=>void;const pending=new Promise<typeof window>(r=>release=r);let prepared!:(v?:unknown)=>void;const started=new Promise(r=>prepared=r),written=0;let writes=written,marks=0,closed=0;
 const repo:LibrarySessionRepository={deviceId:async()=>row.deviceId,cursor:async()=>row.beforeCursor,mergeSources:async()=>0,prepareWindow:async()=>{prepared();return pending;},exportSources:async()=>[],receiveArticle:async()=>0,exportRequested:async()=>[],finalizeSnapshot:async()=>{},resetPeerState:async()=>{},markSuccess:async()=>{marks++;}};
 const s=new LibrarySyncSession({readFrame:async()=>row.inbound[0]! as JsonObject,writeFrame:async()=>{writes++;},close:async()=>{closed++;}},repo);
 const result=s.run();await started;s.cancel();release(window);await expect(result).rejects.toThrow('cancelled');expect(writes).toBe(0);expect(marks).toBe(0);expect(closed).toBe(1);
});
test('stream connection respects fragmented reads and frame-wide deadline',async()=>{
 const raw=encodeFrame({version:14,action:'syncLibrary',phase:'probe',unicode:'正文 😀'}),writes:Uint8Array[]=[];let offset=0,clock=0,closes=0;
 const stream={read:async(max:number)=>{clock++;const n=Math.min(max,3,raw.length-offset);if(!n)return null;const b=raw.slice(offset,offset+n);offset+=n;return b;},write:async(b:Uint8Array)=>{writes.push(b.slice());},close:async()=>{closes++;}};
 const connection=new StreamFrameConnection(stream,()=>clock);expect(await connection.readFrame(1000)).toEqual(decodeFrame(raw));await connection.writeFrame({action:'ack',success:true});expect(decodeFrame(Uint8Array.from(writes.flatMap(b=>[...b])))).toEqual({action:'ack',success:true});await connection.close();await connection.close();expect(closes).toBe(1);
 offset=0;clock=0;await expect(new StreamFrameConnection(stream,()=>clock).readFrame(4)).rejects.toThrow('timed out');
});
test('manifest batches preserve arrays and reject changed peer identity',()=>{
 const payload:JsonObject={version:14,action:'syncLibrary',phase:'manifest',deviceId:'p',sentAt:1789340000000,articleManifest:Array.from({length:12000},(_,i)=>({articleId:String(i),metadataHash:'x'.repeat(200)})),rssSources:[{url:'https://feed.example'}],bodyRequests:[{articleId:'1',bodyHash:'h',chunkIndexes:[]}]};
 const frames=buildManifestFrames(payload);expect(frames.length).toBeGreaterThan(2);const combined=combineManifestFrames(frames);expect(combined.articleManifest).toEqual(payload.articleManifest);expect(combined.rssSources).toEqual(payload.rssSources);expect(combined.bodyRequests).toEqual(payload.bodyRequests);
 frames[1]={...frames[1],deviceId:'changed'};expect(()=>combineManifestFrames(frames)).toThrow('identity/order');
});

test('R47 local transfer owns cloud priority only after first request and releases after close notification',async()=>{
 for(const fail of [false,true]){let acquired=0,released=0,closed=false,notified=false,index=0;const frames=[{action:'unknown'}, {action:'ack',success:true,applied:true}];const session=new LibrarySyncSession({readFrame:async()=>{expect(acquired).toBe(index?1:0);if(fail)throw Error('socket closed');return frames[index++]!;},writeFrame:async()=>{},close:async()=>{closed=true;}},{deviceId:async()=>'watch'} as LibrarySessionRepository,{acquireSession:()=>{acquired++;return()=>{expect(closed).toBe(true);expect(notified).toBe(true);released++;};},onSessionClosed:()=>{notified=true;}});if(fail)await expect(session.run()).rejects.toThrow('socket closed');else await session.run();expect(acquired).toBe(fail?0:1);expect(released).toBe(acquired);}
});

for(const fast of [false,true])test('persistent cursor defers projection only for both explicit R47.1 peers: '+fast,async()=>{
 const row=fixture.cases[0]!,parts=sessionFixtureParts(row),first=row.inbound[0] as JsonObject;let old=0,cheap=0,prepared=0,merged=false,index=0,marked=0;
 const incoming:JsonObject[]=[{version:14,action:'syncLibrary',phase:'cursor',deviceId:first.deviceId,supportsDomainFastPathV2:fast,requestPersistentSession:true,supportsPersistentSession:true},...row.inbound as JsonObject[],{version:14,action:'syncSession',phase:'complete'},{action:'ack',phase:'applied',success:true,applied:true}];
 const repo:LibrarySessionRepository={deviceId:async()=>row.deviceId,cursor:async()=>{old++;return row.beforeCursor;},exchangeCursor:async()=>{cheap++;return row.beforeCursor;},mergeSources:async()=>{merged=true;return 0;},prepareWindow:async()=>{expect(merged).toBe(true);prepared++;return parts.window;},exportSources:async()=>parts.window.rssSources,receiveArticle:async()=>0,exportRequested:async r=>parts.articles.filter(a=>r.some(q=>q.articleId===a.article.articleId)),finalizeSnapshot:async()=>{},resetPeerState:async()=>{},markSuccess:async()=>{marked++;}};
 const sent:JsonObject[]=[];await new LibrarySyncSession({readFrame:async()=>{const frame=incoming[index++];if(!frame)throw Error('EOF');return frame;},writeFrame:async f=>{sent.push(f);},close:async()=>{}},repo,{capabilities:{supportsDomainFastPathV2:true}}).run();
 expect(old).toBe(fast?0:1);expect(cheap).toBe(fast?1:0);expect(prepared).toBe(1);expect(marked).toBe(1);expect(sent.some(f=>f.phase==='cursor')).toBe(true);
});
