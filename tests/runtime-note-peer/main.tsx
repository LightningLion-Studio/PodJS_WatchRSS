import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams,fileChunks,hostOperation} from '@podjs/framework/services';
import {getLibrarySyncRepository,memoRepository,db} from '../../src/services.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';
import {NoteAssetReceiver} from '../../src/sync/note-assets.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
const key='note-peer-result',uuid='ae7f76b9-9129-4ccb-b213-7695194d81f9',path='notes/assets/note-peer-owned.png';
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
async function run(){
 const repository=await getLibrarySyncRepository();await memoRepository.initialize();check((await memoRepository.allIncludingDeleted()).length===0,'Fixture notes must be empty');check(!(await fileChunks.stat(path)).exists,'Fixture image exists');check(!(await fileChunks.stat('notes/assets/.note-peer-owned.png.part')).exists,'Fixture staging file exists');const articles=await db.query('SELECT count(*) n FROM articles');let notifications=0,peerStarted=0,proof:Record<string,unknown>={};
 const listener=new RfcommLibraryListener(repository,{radio:{...rfcomm,listen:()=>rfcomm.listen('Paired Note Verification',uuid)},streams:byteStreams});
 try{
  const results=await listener.start({handleAction:createApplicationActionHandler({notes:memoRepository,deviceId:()=>repository.deviceId(),notesChanged:()=>{notifications++;},noteAssets:new NoteAssetReceiver(fileChunks)}),onListening:()=>kv.set(key,{state:'running',phase:'listening',uuid}),onPeer:()=>{peerStarted=Date.now();kv.set(key,{state:'running',phase:'connected',uuid});}});
  check(results.every(r=>r.ack?.success&&r.ack.applied),'Missing applied ACK');check(results.at(-1)?.request.action==='syncSession','Persistent completion missing');
  const assets=results.filter(r=>r.request.action==='syncNoteAsset');check(assets.length>=3,'Multi-chunk image plus reuse not observed');check(assets.at(-1)?.response.alreadyPresent===true,'Image reuse missing');
  const hash=await fileChunks.hash(path);check(assets.every(r=>r.request.sha256===hash.sha256),'Stored PNG checksum');
  const decoded=await hostOperation<{path:string;sourceWidth:number;sourceHeight:number}>('image.decode',{path,maxDimension:64}).result;try{check(decoded.sourceWidth===512&&decoded.sourceHeight===512,'PNG dimensions');}finally{await fileChunks.remove(decoded.path);}
  const notes=await memoRepository.allIncludingDeleted();check(notes.length===1&&notes[0].noteId==='note-peer-owned'&&notes[0].deleted&&notes[0].updatedAt===3,'Durable note tombstone');check((await memoRepository.list()).length===0,'Tombstone visible');check(results.filter(r=>r.response.success===false).length===1,'Expected malformed note rejection');check(notifications===7,'Unexpected change notifications');
  proof={watchId:await repository.deviceId(),pngSha256:hash.sha256,pngBytes:hash.size,pngChunks:assets.length-1,actions:results.length,notifications,appliedAcks:results.length,pngDecoded:true,durableTombstone:true,transferMs:Date.now()-peerStarted};
 }finally{listener.stop();await db.execute('DELETE FROM memo_notes WHERE note_id=?',['note-peer-owned']);await fileChunks.remove(path);await fileChunks.remove('notes/assets/.note-peer-owned.png.part');}
 check((await memoRepository.allIncludingDeleted()).length===0,'Owned notes cleanup');check(!(await fileChunks.stat(path)).exists,'Owned asset cleanup');check(JSON.stringify(await db.query('SELECT count(*) n FROM articles'))===JSON.stringify(articles),'Articles changed');kv.set(key,{state:'passed',...proof,ownedDataRemoved:true,articleCountUnchanged:true,persistentSession:true,visualAcceptance:false});
}
mount(()=><Text>Paired note synchronization verification</Text>);void run().catch(e=>kv.set(key,{state:'failed',error:String(e)}));
