import {expect,test} from 'bun:test';
import {foregroundRequestFilter,FOREGROUND_SYNC_ACTIONS} from '../../src/sync/action-policy.ts';
import {LibrarySyncSession,type LibrarySessionRepository} from '../../src/sync/session.ts';
import type {JsonObject} from '../../src/sync/protocol.ts';
const ack={action:'ack',phase:'applied',success:true,applied:true};
function replay(frames:JsonObject[],filterRequest:typeof foregroundRequestFilter|undefined){
 const input=[...frames],output:JsonObject[]=[],handled:string[]=[];let cursors=0;
 const unexpected=async():Promise<never>=>{throw Error('policy test unexpectedly touched library');};
 const repo:LibrarySessionRepository={mergeSources:unexpected,prepareWindow:unexpected,exportSources:unexpected,receiveArticle:unexpected,exportRequested:unexpected,finalizeSnapshot:unexpected,resetPeerState:unexpected,markSuccess:unexpected,deviceId:async()=>'watch',cursor:async()=>{cursors++;return {lastLocalSeqAckedByPeer:0,lastRemoteSeqApplied:0,localMaxSeq:0};}};
 const session=new LibrarySyncSession({readFrame:async()=>{const next=input.shift();if(!next)throw Error('EOF');return next;},writeFrame:async frame=>{output.push(frame);},close:async()=>{}},repo,{filterRequest,handleAction:async request=>{handled.push(String(request.action));return {success:true,action:request.action};}});
 return {run:()=>session.run(),output,handled,cursors:()=>cursors};
}
test('automatic allowlist retains native Bluetooth/IP actions and allows the pairing UI request',()=>{
 expect(FOREGROUND_SYNC_ACTIONS).toEqual(['syncLibrary','clearLibrary','syncNotes','syncNoteAsset','syncReader','previewReader','syncAccount','syncLlmTokenUsage','openPairing']);
 for(const action of FOREGROUND_SYNC_ACTIONS)expect(foregroundRequestFilter({action})).toBeUndefined();
});
for(const action of ['ping','remoteInput','pullSavedItems','pullDebugLog','unknown'])test(`automatic rejects ${action} with native reply; active/debug default still dispatches`,async()=>{
 for(const policy of [foregroundRequestFilter,undefined]){
  const f=replay([{action},ack],policy);const results=await f.run();expect(results[0]?.ack?.applied).toBe(true);
  expect(f.handled).toEqual(policy?[]:[action]);expect(f.output[0]).toEqual(policy?{success:false,message:'当前前台自动同步不支持此操作，请在手表上打开对应连接页面'}:{success:true,action});
 }
});
test('rejection consumes ACK and keeps persistent session alive for allowed work and completion',async()=>{
 const f=replay([{action:'pullDebugLog',requestPersistentSession:true,supportsPersistentSession:true},ack,{action:'clearLibrary'},ack,{action:'syncSession',phase:'complete'},ack],foregroundRequestFilter);
 const results=await f.run();expect(results.map(r=>r.response.success)).toEqual([false,true,true]);expect(f.handled).toEqual(['clearLibrary']);expect(f.output[0]).toMatchObject({supportsPersistentSession:true,persistentSessionAccepted:true});
});
test('cursor continuation cannot bypass automatic policy',async()=>{
 const f=replay([{action:'syncLibrary',phase:'cursor',version:14},{action:'pullDebugLog'},ack],foregroundRequestFilter);
 await f.run();expect(f.cursors()).toBe(1);expect(f.handled).toEqual([]);expect(f.output.at(-1)).toMatchObject({success:false,message:'当前前台自动同步不支持此操作，请在手表上打开对应连接页面'});
});

import {BluetoothActionPolicy} from '../../src/sync/action-policy.ts';
test('connection page scope keeps persistent ping/saved/debug dispatch allowed and releases idempotently',async()=>{
 const policy=new BluetoothActionPolicy(),first=policy.acquireConnectionPage(),second=policy.acquireConnectionPage();
 first();first();expect(policy.filterRequest({action:'ping'})).toBeUndefined();
 const f=replay([{action:'ping',requestPersistentSession:true,supportsPersistentSession:true},ack,{action:'pullSavedItems'},ack,{action:'pullDebugLog'},ack,{action:'syncSession',phase:'complete'},ack],policy.filterRequest);
 expect((await f.run()).map(r=>r.response.success)).toEqual([true,true,true,true]);expect(f.handled).toEqual(['ping','pullSavedItems','pullDebugLog']);
 second();expect(policy.filterRequest({action:'ping'})?.success).toBe(false);
});
