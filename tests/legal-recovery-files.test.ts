import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createLegalRecoveryFiles,validateLegalBodyReference,LegalRecoveryIdentityError,type LegalDocumentIdentity,type LegalRecoveryFilePorts} from '../src/onboarding/legal-recovery-files.ts';

const PRIVACY:LegalDocumentIdentity={page:'privacy',url:'https://legal.example/privacy?version=1'};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
let sequence=0;
function fixture(){
 const data=new Map<string,Buffer>();
 const calls={allocated:[] as string[],removed:[] as string[],writes:[] as {path:string;offset:number;size:number}[],commits:[] as string[],reads:[] as string[]};
 const bytes=(path:string)=>{const value=data.get(path);if(!value)throw Error('file missing');return value;};
 const ports:LegalRecoveryFilePorts={
  async createTemp(directory){const path=`${directory}/.pod-write-fixture-${++sequence}.part`;expect(data.has(path)).toBe(false);data.set(path,Buffer.alloc(0));calls.allocated.push(path);return {path};},
  async write(path,encoded){const value=Buffer.from(encoded,'base64');expect(value.length).toBeLessThanOrEqual(65536);data.set(path,value);calls.writes.push({path,offset:0,size:value.length});return {size:value.length};},
  async append(path,encoded,offset){const previous=bytes(path),value=Buffer.from(encoded,'base64');expect(previous.length).toBe(offset);expect(value.length).toBeLessThanOrEqual(65536);data.set(path,Buffer.concat([previous,value]));calls.writes.push({path,offset,size:value.length});return {size:offset+value.length};},
  async hash(path){const value=bytes(path);return {size:value.length,sha256:sha(value)};},
  async commit(path,target,size,hash){const value=bytes(path);expect(value.length).toBe(size);expect(sha(value)).toBe(hash);const prior=data.get(target),reused=!!prior&&prior.equals(value);data.set(target,value);data.delete(path);calls.commits.push(target);return {path:target,size,sha256:hash,reused};},
  async read(path,offset,maxBytes){calls.reads.push(path);const value=bytes(path),part=value.subarray(offset,offset+maxBytes);return {dataBase64:part.toString('base64'),offset,size:value.length,eof:offset+part.length===value.length};},
  async remove(path){calls.removed.push(path);data.delete(path);},
  async digest(value){return sha(value);},
 };
 return {data,calls,ports,files:createLegalRecoveryFiles(ports)};
}

test('default file digest and 64 KiB IO round-trip all 512 KiB with Unicode across chunk boundaries',async()=>{
 const f=fixture();delete f.ports.digest;
 const body=' '+ 'x'.repeat(65534)+'😀'+'中'+'y'.repeat(512*1024-65535-7-1)+' ';
 expect(Buffer.byteLength(body)).toBe(512*1024);
 const ref=await f.files.write(PRIVACY,body,'task_1');
 expect(ref.byteLength).toBe(512*1024);expect(ref.sha256).toBe(sha(Buffer.from(body)));
 expect(ref.identitySha256).toBe(sha(Buffer.from(JSON.stringify([PRIVACY.page,PRIVACY.url]))));
 expect(Object.isFrozen(ref)).toBe(true);expect(Object.isFrozen(ref.identity)).toBe(true);
 expect(JSON.stringify(ref).length).toBeLessThan(600);
 expect(await f.files.read(clone(ref),PRIVACY)).toBe(body);
 expect([...f.data.keys()]).toEqual([ref.path]);
 expect(f.calls.writes.every(row=>row.size<=65536)).toBe(true);
 expect(f.calls.allocated.filter(path=>path.startsWith('legal-recovery/digests/'))).toHaveLength(4);
 expect(f.calls.removed).toHaveLength(4);
});

test('identical snapshots get independent immutable paths and survive a new service instance',async()=>{
 const f=fixture(),body='\n 协议中文😀 \n';
 const a=await f.files.write(PRIVACY,body,'task-a'),b=await f.files.write(PRIVACY,body,'task-a'),c=await f.files.write(PRIVACY,body,'task-b');
 expect(new Set([a.path,b.path,c.path]).size).toBe(3);
 expect(a.sha256).toBe(b.sha256);expect(f.calls.removed).toEqual([]);
 const replacement=createLegalRecoveryFiles(f.ports);
 expect(await replacement.read(clone(a),PRIVACY)).toBe(body);
 await replacement.discardUnpublished(a);expect(f.data.has(a.path)).toBe(true);
 await f.files.discardUnpublished(a);expect(f.data.has(a.path)).toBe(true);
 await f.files.discardUnpublished(b);expect(f.data.has(b.path)).toBe(false);
 expect(f.data.has(a.path)).toBe(true);expect(f.data.has(c.path)).toBe(true);
});

test('published same-body reopen reuses the original verified reference without another commit',async()=>{
 const f=fixture(),body='正文😀',a=await f.files.write(PRIVACY,body,'task-a');
 f.files.markPublished(a);
 expect(await f.files.write(PRIVACY,body,'task-a')).toBe(a);
 await f.files.read(clone(a),PRIVACY);
 expect(await f.files.write(PRIVACY,body,'task-a')).toBe(a);
 expect(f.calls.commits).toEqual([a.path]);expect(f.calls.allocated).toHaveLength(1);
 await f.files.discardUnpublished(a);expect(f.calls.removed).toEqual([]);
 const replacement=createLegalRecoveryFiles(f.ports);
 await replacement.read(clone(a),PRIVACY);
 expect((await replacement.write(PRIVACY,body,'task-a')).path).toBe(a.path);
 expect(f.calls.commits).toEqual([a.path]);
});

test('published deduplication never crosses owner, URL, page or content identity',async()=>{
 const f=fixture(),a=await f.files.write(PRIVACY,'正文','task-a');f.files.markPublished(a);
 const refs=[
  await f.files.write(PRIVACY,'正文','task-b'),
  await f.files.write({...PRIVACY,url:PRIVACY.url+'&revision=2'},'正文','task-a'),
  await f.files.write({...PRIVACY,page:'useragreement'},'正文','task-a'),
  await f.files.write(PRIVACY,'其他','task-a'),
 ];
 expect(new Set([a.path,...refs.map(ref=>ref.path)]).size).toBe(5);
 expect(f.calls.commits).toHaveLength(5);expect(f.calls.removed).toEqual([]);
 expect(await f.files.write(PRIVACY,'正文','task-a')).toBe(a);
});

test('missing or corrupt published candidates fall back to a new snapshot without deletion',async()=>{
 for(const corrupt of [false,true]){
  const f=fixture(),a=await f.files.write(PRIVACY,'正文','task-a');f.files.markPublished(a);
  if(corrupt)f.data.set(a.path,Buffer.from('破损'));else f.data.delete(a.path);
  const b=await f.files.write(PRIVACY,'正文','task-a');
  expect(b.path).not.toBe(a.path);expect(f.calls.commits).toEqual([a.path,b.path]);expect(f.calls.removed).toEqual([]);
  if(corrupt)expect(f.data.get(a.path)?.toString()).toBe('破损');
  f.files.markPublished(b);
  expect(await f.files.write(PRIVACY,'正文','task-a')).toBe(b);
  expect(f.calls.commits).toHaveLength(2);expect(await f.files.read(b,PRIVACY)).toBe('正文');
 }
});

test('metadata rejects task/path escape, different route, invalid hashes and invalid size before reading',async()=>{
 const f=fixture(),ref=await f.files.write(PRIVACY,'正文','task-a');
 const cases=[
  {...ref,version:2},{...ref,owner:'../other'},{...ref,owner:''},{...ref,owner:'x'.repeat(97)},
  {...ref,path:'reader-assets/keep.txt'},{...ref,path:ref.path.replace('/task-a/','/task-b/')},
  {...ref,path:ref.path.replace('.utf8','/../outside.utf8')},{...ref,path:ref.path+'/extra'},
  {...ref,path:ref.path.replace(/fixture-[0-9]+\.utf8$/,'x'.repeat(97)+'.utf8')},
  {...ref,byteLength:0},{...ref,byteLength:512*1024+1},{...ref,byteLength:1.5},{...ref,byteLength:NaN},
  {...ref,sha256:'A'.repeat(64)},{...ref,identitySha256:'f'.repeat(63)},
  {...ref,identity:{page:'beian',url:PRIVACY.url}},{...ref,identity:{page:'privacy',url:'file:///secret'}},
  {...ref,identity:{page:'privacy',url:'https://legal.example/\ud800'}},
 ];
 for(const value of cases)expect(()=>validateLegalBodyReference(value)).toThrow();
 for(const expected of [{...PRIVACY,page:'useragreement'} as LegalDocumentIdentity,{...PRIVACY,url:PRIVACY.url+'&changed=1'}]){
  await expect(f.files.read(ref,expected)).rejects.toThrow('页面不匹配');
 }
 expect(f.calls.reads).toEqual([]);expect(f.calls.removed).toEqual([]);
 const valid=validateLegalBodyReference({...clone(ref),unexpected:'discarded'},PRIVACY);
 expect(valid).toEqual(ref);expect(valid).not.toBe(ref);expect(Object.isFrozen(valid.identity)).toBe(true);
});

test('empty, oversized and non-round-tripping UTF-16 bodies allocate nothing',async()=>{
 for(const body of ['', ' \n\t ', 'x'.repeat(512*1024+1), '中'.repeat(180000), '\ud800', 'ok\udfff']){
  const f=fixture();await expect(f.files.write(PRIVACY,body,'task-a')).rejects.toThrow();expect(f.calls.allocated).toEqual([]);
 }
 const f=fixture();await expect(f.files.write(PRIVACY,'body','../task')).rejects.toThrow();expect(f.calls.allocated).toEqual([]);
});

test('unexpected allocation paths never convey ownership or permit unrelated deletion',async()=>{
 for(const digestViaFiles of [false,true]){
  const f=fixture();if(digestViaFiles)delete f.ports.digest;
  f.data.set('reader-assets/keep.txt',Buffer.from('keep'));
  f.ports.createTemp=async()=>({path:'reader-assets/keep.txt'});
  await expect(f.files.write(PRIVACY,'正文','task-a')).rejects.toThrow('路径无效');
  expect(f.calls.writes).toEqual([]);expect(f.calls.removed).toEqual([]);expect(f.data.size).toBe(1);
 }
});

test('short writes, append failures and staged hash mismatch clean only the owned temporary',async()=>{
 for(const failure of ['short','append','hash']){
  const f=fixture();f.data.set('legal-recovery/v1/task-a/keep.utf8',Buffer.from('keep'));
  if(failure==='short')f.ports.write=async()=>({size:0});
  if(failure==='append')f.ports.append=async()=>{throw Error('append failed');};
  if(failure==='hash')f.ports.hash=async()=>({size:1,sha256:'0'.repeat(64)});
  await expect(f.files.write(PRIVACY,'x'.repeat(65537),'task-a')).rejects.toThrow();
  expect(f.calls.commits).toEqual([]);expect(f.calls.removed).toEqual(f.calls.allocated);
  expect([...f.data.keys()]).toEqual(['legal-recovery/v1/task-a/keep.utf8']);
 }
});

test('commit errors and mismatched receipts never delete response-selected or unowned final paths',async()=>{
 for(const failure of ['throw','path','size','hash','reuse']){
  const f=fixture(),sentinel='reader-assets/keep.txt';f.data.set(sentinel,Buffer.from('keep'));
  f.ports.commit=async(_path,target,size,hash)=>{
   if(failure==='throw')throw Error('commit rejected');
   return {path:failure==='path'?sentinel:target,size:failure==='size'?0:size,sha256:failure==='hash'?'0'.repeat(64):hash,reused:failure==='reuse'?undefined as never:false};
  };
  await expect(f.files.write(PRIVACY,'正文','task-a')).rejects.toThrow();
  expect(f.calls.removed).toEqual(f.calls.allocated);expect(f.data.has(sentinel)).toBe(true);
 }
});

test('a reused commit returns a readable reference but never grants unpublished deletion',async()=>{
 const f=fixture(),commit=f.ports.commit;
 f.ports.commit=async(path,target,size,hash)=>{f.data.set(target,Buffer.from(f.data.get(path)!));return commit(path,target,size,hash);};
 const ref=await f.files.write(PRIVACY,'正文','task-a');
 await f.files.discardUnpublished(ref);expect(f.calls.removed).toEqual([]);expect(f.data.has(ref.path)).toBe(true);
 expect(await f.files.read(ref,PRIVACY)).toBe('正文');
});

test('lost commit acknowledgement conservatively retains the final immutable file',async()=>{
 const f=fixture(),commit=f.ports.commit;
 f.ports.commit=async(...args)=>{await commit(...args);throw Error('ack lost');};
 await expect(f.files.write(PRIVACY,'正文','task-a')).rejects.toThrow('ack lost');
 expect(f.calls.commits).toHaveLength(1);expect(f.calls.removed).toEqual(f.calls.allocated);
 expect([...f.data.keys()]).toEqual(f.calls.commits);
});

test('failed post-commit validation removes only an exclusively created target',async()=>{
 for(const reused of [false,true]){
  const f=fixture(),commit=f.ports.commit,hash=f.ports.hash;
  f.ports.commit=async(...args)=>({...await commit(...args),reused});
  f.ports.hash=async path=>path.endsWith('.utf8')?{size:1,sha256:'0'.repeat(64)}:hash(path);
  await expect(f.files.write(PRIVACY,'正文','task-a')).rejects.toThrow('摘要或大小不匹配');
  expect(f.calls.removed).toEqual(reused?[]:f.calls.commits);
  expect(f.data.has(f.calls.commits[0])).toBe(reused);
 }
});

test('restoration rejects missing or corrupted files without deleting anything',async()=>{
 for(const failure of ['missing','content','metadata']){
  const f=fixture(),ref=await f.files.write(PRIVACY,'正文','task-a');
  if(failure==='missing')f.data.delete(ref.path);
  if(failure==='content')f.data.set(ref.path,Buffer.from('其他'));
  const value=failure==='metadata'?{...ref,byteLength:ref.byteLength+1}:ref;
  await expect(f.files.read(value,PRIVACY)).rejects.toThrow();expect(f.calls.removed).toEqual([]);
 }
});

test('URL digest is checked independently of valid metadata and the expected route',async()=>{
 const f=fixture(),ref=await f.files.write(PRIVACY,'正文','task-a');
 const different={...PRIVACY,url:'https://legal.example/changed'};
 const changed={...ref,identity:different};expect(validateLegalBodyReference(changed,different)).toEqual(changed);
 await expect(f.files.read(changed,different)).rejects.toBeInstanceOf(LegalRecoveryIdentityError);
 expect(f.calls.reads).toEqual([]);expect(f.calls.removed).toEqual([]);
});

test('read rejects inconsistent chunks, noncanonical base64 and byte changes after file hash',async()=>{
 for(const invalid of [{offset:1},{size:99},{eof:false},{dataBase64:''},{dataBase64:'!!!!'},{dataBase64:'eB=='},{dataBase64:'eA==eA=='},{dataBase64:'eQ=='}]){
  const f=fixture(),ref=await f.files.write(PRIVACY,'x','task-a'),read=f.ports.read;
  f.ports.read=async(...args)=>({...await read(...args),...invalid});
  await expect(f.files.read(ref,PRIVACY)).rejects.toThrow();expect(f.calls.removed).toEqual([]);
 }
 const f=fixture(),ref=await f.files.write(PRIVACY,'A中😀B','task-a'),read=f.ports.read;
 f.ports.read=(path,offset)=>read(path,offset,1);
 expect(await f.files.read(ref,PRIVACY)).toBe('A中😀B');expect(f.calls.reads).toHaveLength(9);
});

test('otherwise valid restored files still require strict nonempty UTF-8',async()=>{
 for(const bytes of [Buffer.from([0xe4,0xb8]),Buffer.from([0xc0,0xaf]),Buffer.from([0xed,0xa0,0x80]),Buffer.from(' \n')]){
  const f=fixture(),original=await f.files.write(PRIVACY,'seed','task-a'),hash=sha(bytes);
  const ref={...original,path:original.path.replace(original.sha256,hash),sha256:hash,byteLength:bytes.length};
  f.data.set(ref.path,bytes);
  await expect(f.files.read(ref,PRIVACY)).rejects.toThrow();expect(f.calls.removed).toEqual([]);
 }
});

test('only the exact unpublished write object grants cleanup; unknown and other-owner refs are inert',async()=>{
 const f=fixture(),ref=await f.files.write(PRIVACY,'正文','task-a'),other=await f.files.write(PRIVACY,'正文','task-b');
 const forged={...ref,owner:'task-b',path:ref.path.replace('/task-a/','/task-b/')};
 await f.files.discardUnpublished(clone(ref));await f.files.discardUnpublished(forged);
 await createLegalRecoveryFiles(f.ports).discardUnpublished(other);
 expect(f.calls.removed).toEqual([]);
 await f.files.discardUnpublished(ref);await f.files.discardUnpublished(ref);
 expect(f.calls.removed).toEqual([ref.path]);expect(f.data.has(other.path)).toBe(true);
 expect(()=>f.files.markPublished(ref)).toThrow();
 expect('cleanupTask' in f.files).toBe(false);
});

test('markPublished revokes deletion before any saved acknowledgement, including through a cloned ref',async()=>{
 for(const copy of [false,true]){
  const f=fixture(),ref=await f.files.write(PRIVACY,'正文','task-a');
  f.files.markPublished(copy?validateLegalBodyReference(clone(ref)):ref);
  // A saved-state write may now reject after the host already accepted it.
  await f.files.discardUnpublished(ref);expect(f.calls.removed).toEqual([]);expect(f.data.has(ref.path)).toBe(true);
 }
 const f=fixture(),ref=await f.files.write(PRIVACY,'正文','task-a');
 await f.files.read(clone(ref),PRIVACY);await f.files.discardUnpublished(ref);
 expect(f.calls.removed).toEqual([]);
 const other=createLegalRecoveryFiles(f.ports);expect(()=>other.markPublished(ref)).toThrow('尚未验证');
});

test('starting unpublished deletion prevents racing publication even when deletion fails ambiguously',async()=>{
 const f=fixture(),ref=await f.files.write(PRIVACY,'正文','task-a');
 let finish!:(value?:unknown)=>void;
 f.ports.remove=()=>new Promise((_,reject)=>{finish=()=>reject(Error('uncertain deletion'));});
 const pending=f.files.discardUnpublished(ref);
 expect(()=>f.files.markPublished(ref)).toThrow('已释放');finish();
 await expect(pending).rejects.toThrow('uncertain deletion');
 await expect(f.files.read(ref,PRIVACY)).rejects.toThrow('已释放');
});

test('a read started before unpublished disposal cannot publish its late result in another instance',async()=>{
 const f=fixture(),ref=await f.files.write(PRIVACY,'正文','task-a'),read=f.ports.read;
 let finish!:()=>void,started!:()=>void;
 const reading=new Promise<void>(resolve=>{started=resolve;});
 f.ports.read=async(...args)=>{const value=await read(...args);started();await new Promise<void>(resolve=>{finish=resolve;});return value;};
 const replacement=createLegalRecoveryFiles(f.ports),pending=replacement.read(clone(ref),PRIVACY);
 await reading;await f.files.discardUnpublished(ref);finish();
 await expect(pending).rejects.toThrow('已释放');
 expect(()=>replacement.markPublished(ref)).toThrow('已释放');expect(f.calls.removed).toEqual([ref.path]);
});

test('host digest fallback cleans reserved files on failures and rejects malformed digest output',async()=>{
 for(const failure of ['write','size','digest']){
  const f=fixture();delete f.ports.digest;
  if(failure==='write')f.ports.write=async()=>{throw Error('digest write failed');};
  if(failure==='size')f.ports.hash=async()=>({size:0,sha256:'a'.repeat(64)});
  if(failure==='digest')f.ports.hash=async()=>({size:Buffer.byteLength('正文'),sha256:'not-a-hash'});
  await expect(f.files.write(PRIVACY,'正文','task-a')).rejects.toThrow();
  expect(f.calls.removed).toEqual(f.calls.allocated);expect(f.data.size).toBe(0);
 }
});
