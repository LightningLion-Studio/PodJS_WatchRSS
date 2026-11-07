import {test,expect} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {LibrarySyncSession,type LibrarySessionRepository} from '../../src/sync/session';
import {StreamFrameConnection} from '../../src/sync/stream';
import {WatchLocalObjectSession} from '../../src/sync-v2/local-session';
import {LocalProofSession} from '../../src/sync-v2/local-proof';
import {objectCapability} from '../../src/sync-v2/local-capability';
import {localObjectFrames,LocalReadClient} from '../../src/sync-v2/local-read';
import {sealV2} from '../../src/sync-v2/sealed';
import {digest} from '../../src/sync-v2/protocol';
import {signControl} from '../../src/sync-v2/signing';
import {PeerCustodyStore} from '../../src/sync-v2/peer-custody';
import {tcpStreams} from './p4-tcp';
import {cache,nonce,watchId,phoneId,approved} from './p4-fixture';
import {crypt,keys} from './p3-fixture';
import {scope} from './fixture';
for(const version of [13,14])test('real TCP v'+version+' product session upgrades at the complete old-JSON boundary',async()=>{
 const f=await cache(),sockets=await tcpStreams(),sessionId=await nonce(),proof=new LocalProofSession(sessionId,keys.id,{scope,deviceId:watchId,nonce:await nonce(),features:[]},async()=> 'active',()=>!sockets.server.socket.destroyed),peer=new LocalProofSession(sessionId,keys.id,{scope,deviceId:phoneId,nonce:await nonce(),features:[]},async()=> 'active',()=>!sockets.client.socket.destroyed),old=new StreamFrameConnection(sockets.client),serverConnection=new StreamFrameConnection(sockets.server),custody=new PeerCustodyStore(f.store,scope,watchId,crypt,approved);
 const objects=new WatchLocalObjectSession({enabled:true,proof,requiredFeatures:[],supportedFeatures:[],objects:f.objects,snapshot:async()=>({serverRevision:'0',refs:[],account:{commitOid:null,revision:'0',rollbackGeneration:'0'},historyFloorRevision:'0',checkpointOid:null}),nonce,closeSocket:()=>sockets.server.close(),custody});
 let resets=0,marks=0;const repo={deviceId:async()=>'synthetic-watch',resetPeerState:async()=>{resets++;},markSuccess:async()=>{marks++;}} as unknown as LibrarySessionRepository;
 const running=new LibrarySyncSession(serverConnection,repo,{localObjects:objects}).run().then(()=>null,e=>(e as Error).message);
 try{
  await old.writeFrame({version,action:'syncLibrary',phase:'probe',deviceId:'synthetic-phone',supportsPersistentSession:true,requestPersistentSession:true,...objectCapability(scope,true)});expect((await old.readFrame(10000)).supportsSyncObjectsV2).toBe(true);await old.writeFrame({action:'ack',success:true,applied:true});
  const exchange=async(action:string,body:any)=>{const requestId=await nonce();await old.writeFrame({requestId,action,body});const response=await old.readFrame(10000);expect(response.requestId).toBe(requestId);expect(response.ok).toBe(true);return response.body as any;};
  await peer.negotiate(await exchange('syncObjectsV2.negotiate',peer.hello));const remote=await exchange('syncObjectsV2.negotiate',{scope,proof:peer.proof()});await peer.verify(remote.proof,[]);
  const window=await exchange('syncObjectsV2.negotiate',{scope,knownRefs:[],features:[]}),switchId=await nonce();await exchange('syncObjectsV2.prepareFraming',{sessionId,framing:'WRP2',switchId});expect(objects.boundary.enabled).toBe(false);const final=await exchange('syncObjectsV2.commitFraming',{switchId});expect(final.committed).toBe(true);
  const frames=localObjectFrames(old.detachStream(),scope,sessionId,()=>peer.verified),client=new LocalReadClient(scope,sessionId,frames,nonce),blob=await sealV2(crypt,keys.id,keys.content,scope,'blob',1,randomBytes(100000));await client.upload(blob.oid,{size:blob.bytes.length,read:async(at,n)=>blob.bytes.slice(at,at+n)},window.windowId);expect(await client.object(blob.oid,undefined,window.windowId)).toEqual(blob.bytes);
  const b={scope,transferId:await nonce(),oid:'blob:sha256:'+'0'.repeat(64),totalBytes:1,offset:0,partBytes:1,partSha256:'0'.repeat(64)};await expect(client.control('syncObjectsV2.putPart',b,()=>frames.writePart({...b,sessionId},new Uint8Array([9])))).rejects.toThrow('hash_mismatch');expect((await f.objects.status(b.oid)).status).toBe('missing');
  const pin=await signControl(crypt,'fixture','wrss.sync.v2/custody-pin-sign',{version:2,scope,pinId:await nonce(),holderDeviceId:phoneId,claimantDeviceId:watchId,entityKey:'1'.repeat(64),bodyRevision:'2'.repeat(32),recipeOid:'recipe:sha256:'+'3'.repeat(64),blobOidsHash:digest([]),createdAtMillis:1}),receipt=await client.control('syncObjectsV2.receipt',{kind:'custody',custody:pin});expect(receipt.pinId).toBe(pin.body.pinId);expect(receipt.state).toBe('active');expect(resets).toBe(0);expect(marks).toBe(0);await frames.close();
 }finally{await sockets.close();await running;await f.close();}
});
for(const version of [13,14])test('real TCP old v'+version+' probe never sends a new action or changes cursors',async()=>{
 const f=await cache(),sockets=await tcpStreams(),proof=new LocalProofSession(await nonce(),keys.id,{scope,deviceId:watchId,nonce:await nonce(),features:[]},async()=> 'active',()=>true),local=new WatchLocalObjectSession({enabled:true,proof,requiredFeatures:[],supportedFeatures:[],objects:f.objects,snapshot:async()=>({serverRevision:'0',refs:[],account:{commitOid:null,revision:'0',rollbackGeneration:'0'},historyFloorRevision:'0',checkpointOid:null}),nonce,closeSocket:()=>sockets.server.close()}),outbound:any[]=[],serverConnection=new StreamFrameConnection(sockets.server),write=serverConnection.writeFrame.bind(serverConnection);serverConnection.writeFrame=async v=>{outbound.push(v);await write(v);};const old=new StreamFrameConnection(sockets.client),cursor={pairing:'kept',received:'opaque-r',applied:'opaque-a'},before=JSON.stringify(cursor),running=new LibrarySyncSession(serverConnection,{deviceId:async()=>'synthetic-watch'} as LibrarySessionRepository,{localObjects:local}).run().catch(e=>e);
 try{await old.writeFrame({version,action:'syncLibrary',phase:'probe',deviceId:'old-phone',supportsPersistentSession:true,requestPersistentSession:true});await old.readFrame(10000);await old.writeFrame({action:'ack',success:true,applied:true});await old.writeFrame({version,action:'syncSession',phase:'complete'});await old.readFrame(10000);await old.writeFrame({action:'ack',success:true,applied:true});await running;expect(outbound.some(v=>String(v.action).startsWith('syncObjectsV2.'))).toBe(false);expect(JSON.stringify(cursor)).toBe(before);expect(proof.verified).toBe(false);}finally{await sockets.close();await f.close();}
});
