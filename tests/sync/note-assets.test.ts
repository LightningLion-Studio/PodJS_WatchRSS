import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,stat,unlink,rename,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {NoteAssetReceiver,type NoteAssetFiles} from '../../src/sync/note-assets.ts';
import native from '../fixtures/note-assets-native.json';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'note-assets-'));
 const file=async(p:string)=>{try{const s=await stat(join(root,p));return {file:s.isFile(),size:s.size};}catch{return {file:false,size:0};}};
 const files:NoteAssetFiles={stat:file,hash:async p=>{const b=await readFile(join(root,p));return {size:b.length,sha256:sha(b)};},remove:async p=>{await unlink(join(root,p)).catch(()=>{});},write:async(p,s)=>{const b=Buffer.from(s,'base64');expect(b.length).toBeLessThanOrEqual(256*1024);await mkdir(dirname(join(root,p)),{recursive:true});await writeFile(join(root,p),b);return {size:b.length};},append:async(p,s,offset)=>{expect((await file(p)).size).toBe(offset);const b=Buffer.from(s,'base64');expect(b.length).toBeLessThanOrEqual(256*1024);await writeFile(join(root,p),b,{flag:'a'});return {size:offset+b.length};},commit:async(p,t,size,h)=>{const before=await files.hash(p);expect(before).toEqual({size,sha256:h});await rename(join(root,p),join(root,t));}};
 async function snapshot(){const values:Record<string,unknown>={};for(const p of await readdir(root,{recursive:true})){if((await file(p)).file)values[p]=await files.hash(p);}return values;}
 return {root,files,snapshot,receiver:new NoteAssetReceiver(files)};
}
test('native note asset responses and staged/target file states match every executed oracle step',async()=>{
 for(const c of native.cases){const f=await fixture();try{for(let i=0;i<c.steps.length;i++){
  const step=c.steps[i] as Record<string,any>,request={...step,data:step.data??Buffer.alloc(step.dataLength,step.dataByte).toString('base64')};let result:unknown,error:unknown;
  try{result=await f.receiver.apply(request);}catch(e){error=e;}
  const expected=c.results[i] as {response?:unknown;error?:string;files:Record<string,unknown>};
  if(expected.error)expect(error,c.name+' '+i).toBeDefined();else {expect(error,c.name+' '+i).toBeUndefined();expect(result).toEqual(expected.response);}
  expect(await f.snapshot(),c.name+' '+i).toEqual(expected.files);
 }}finally{await rm(f.root,{recursive:true,force:true});}}
});
test('concurrent chunks serialize and a failure does not poison the next request',async()=>{const f=await fixture();try{const body=Buffer.alloc(512*1024+3,65),base={version:1,storageKey:'parallel.png',sha256:sha(body),chunkCount:2};const a=f.receiver.apply({...base,chunkIndex:0,data:body.subarray(0,512*1024).toString('base64')}),b=f.receiver.apply({...base,chunkIndex:1,data:body.subarray(512*1024).toString('base64')});expect(await a).toMatchObject({complete:false});expect(await b).toMatchObject({complete:true});await expect(f.receiver.apply({...base,storageKey:'../bad'})).rejects.toThrow();expect(await f.receiver.apply({...base,chunkIndex:0,data:'!'})).toMatchObject({alreadyPresent:true});}finally{await rm(f.root,{recursive:true,force:true});}});

test('application dispatch notifies only completed assets and reports write failures',async()=>{const {createApplicationActionHandler}=await import('../../src/sync/application-actions.ts');let changes=0;const handler=createApplicationActionHandler({notes:{initialize:async()=>{},merge:async()=>0,allIncludingDeleted:async()=>[]},deviceId:async()=>'watch',notesChanged:()=>{changes++;},noteAssets:{apply:async request=>{if(request.fail)throw new Error('storage failure');return {success:true,complete:request.done===true};}}});expect(await handler({action:'syncNoteAsset'})).toMatchObject({success:true,complete:false});expect(changes).toBe(0);expect(await handler({action:'syncNoteAsset',done:true})).toMatchObject({complete:true});expect(changes).toBe(1);expect(await handler({action:'syncNoteAsset',fail:true})).toEqual({success:false,message:'storage failure'});expect(changes).toBe(1);});
