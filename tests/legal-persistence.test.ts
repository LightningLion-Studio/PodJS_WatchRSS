import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {ActivityState} from '@podjs/framework/services';
import {createLegalRecoveryFiles,type LegalRecoveryFilePorts} from '../src/onboarding/legal-recovery-files.ts';
import {captureLegalNavigation,hydrateLegalNavigation,prepareLegalNavigation,type LegalNavigation} from '../src/onboarding/legal-restoration.ts';
import {createLegalSnapshotWriter} from '../src/onboarding/legal-snapshot-writer.ts';

const baseUrl='https://legal.example.test';
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
function fixture(){
 const data=new Map<string,Buffer>();
 let allocations=0,commits=0;
 const ports:LegalRecoveryFilePorts={
  async createTemp(directory){const path=`${directory}/.pod-write-integration-${++allocations}.part`;data.set(path,Buffer.alloc(0));return {path};},
  async write(path,encoded){const bytes=Buffer.from(encoded,'base64');data.set(path,bytes);return {size:bytes.length};},
  async append(path,encoded,offset){const previous=data.get(path)!;if(previous.length!==offset)throw Error('offset');const bytes=Buffer.concat([previous,Buffer.from(encoded,'base64')]);data.set(path,bytes);return {size:bytes.length};},
  async hash(path){const bytes=data.get(path);if(!bytes)throw Error('missing file');return {size:bytes.length,sha256:hash(bytes)};},
  async commit(path,target,size,sha256){const bytes=data.get(path)!;if(bytes.length!==size||hash(bytes)!==sha256)throw Error('invalid commit');data.set(target,bytes);data.delete(path);commits++;return {path:target,size,sha256,reused:false};},
  async read(path,offset,maxBytes){const bytes=data.get(path);if(!bytes)throw Error('missing file');const chunk=bytes.subarray(offset,offset+maxBytes);return {offset,size:bytes.length,dataBase64:chunk.toString('base64'),eof:offset+chunk.length===bytes.length};},
  async remove(path){data.delete(path);},
  async digest(bytes){return hash(bytes);},
 };
 return {data,ports,files:createLegalRecoveryFiles(ports),commits:()=>commits};
}
function navigation(content:string,index=9):LegalNavigation {
 return {pages:['privacy'],snapshots:[{content,error:null,isLoading:false,reloadKey:3,listAnchor:{index,offsetPx:17},scrollOffset:0}]};
}
function storage(f:ReturnType<typeof fixture>,initial?:LegalNavigation){
 let state:ActivityState={saved:{unrelated:7},retained:{unrelated:8}};
 const writes:ActivityState[]=[],errors:unknown[]=[];
 const writer=createLegalSnapshotWriter({initial,
  prepare:(value,previous)=>prepareLegalNavigation(value,f.files,baseUrl,'integration-task',previous),
  publish:prepared=>{state=captureLegalNavigation(state,prepared);for(const ref of prepared.bodyReferences??[])if(ref)f.files.markPublished(ref);writes.push(JSON.parse(JSON.stringify(state)));},
  discard:ref=>f.files.discardUnpublished(ref),onError:error=>errors.push(error),
 });
 return {writer,writes,errors,state:()=>state};
}

test('real file codec writer pipeline saves a bounded top checkpoint and reuses its verified process-restored body',async()=>{
 const f=fixture(),s=storage(f),body='中'.repeat(170000)+'尾';
 s.writer.save(navigation(body));await s.writer.idle();
 expect(s.errors).toEqual([]);expect(f.commits()).toBe(1);
 expect(Buffer.byteLength(JSON.stringify(s.state().saved))).toBeLessThan(4096);
 expect(Buffer.byteLength(JSON.stringify(s.state().retained))).toBeLessThan(4096);
 expect(JSON.stringify(s.state())).not.toContain('中');
 const restored=await hydrateLegalNavigation({saved:JSON.parse(JSON.stringify(s.state().saved)),retained:{}},createLegalRecoveryFiles(f.ports),baseUrl);
 expect(restored.snapshots[0]?.content).toBe(body);
 expect(restored.snapshots[0]?.listAnchor).toEqual({index:9,offsetPx:17});
 expect(restored.restoreModes).toEqual(['recreated']);
 const replacement={...f,files:createLegalRecoveryFiles(f.ports)};
 const verified=await hydrateLegalNavigation({saved:s.state().saved,retained:{}},replacement.files,baseUrl);
 const resumed=storage(replacement,verified);
 resumed.writer.save(navigation(body,12));await resumed.writer.idle();
 expect(resumed.errors).toEqual([]);expect(f.commits()).toBe(1);
 expect(resumed.state().saved.unrelated).toBe(7);expect(resumed.state().retained.unrelated).toBe(8);
 s.writer.close();resumed.writer.close();await Promise.all([s.writer.idle(),resumed.writer.idle()]);
 expect([...f.data.keys()].filter(path=>path.endsWith('.utf8'))).toHaveLength(1);
});

test('pop supersedes a body commit in flight and removes only its unpublished file',async()=>{
 const f=fixture(),s=storage(f),entered=deferred(),release=deferred(),commit=f.ports.commit;
 f.data.set('reader-assets/unrelated.txt',Buffer.from('keep'));
 f.ports.commit=async(...args)=>{entered.resolve();await release.promise;return commit(...args);};
 s.writer.save(navigation('即将写入但已退出的正文'));
 await entered.promise;
 s.writer.save({pages:[],snapshots:[]});release.resolve();await s.writer.idle();
 expect(s.errors).toEqual([]);expect(s.writes).toHaveLength(1);
 expect(s.state()).toEqual({saved:{unrelated:7},retained:{unrelated:8}});
 expect([...f.data.keys()]).toEqual(['reader-assets/unrelated.txt']);
});

test('unknown saved acknowledgement cannot revoke a published recovery file',async()=>{
 const f=fixture(),errors:unknown[]=[],body='主机可能已保存的正文';
 let accepted:ActivityState|undefined;
 const writer=createLegalSnapshotWriter({
  prepare:(value,previous)=>prepareLegalNavigation(value,f.files,baseUrl,'integration-task',previous),
  publish:prepared=>{accepted=captureLegalNavigation({saved:{},retained:{}},prepared);for(const ref of prepared.bodyReferences??[])if(ref)f.files.markPublished(ref);throw Error('reply lost after acceptance');},
  discard:ref=>f.files.discardUnpublished(ref),onError:error=>errors.push(error),
 });
 writer.save(navigation(body));await writer.idle();writer.close();await writer.idle();
 expect(errors).toHaveLength(1);expect([...f.data.keys()]).toHaveLength(1);
 const restored=await hydrateLegalNavigation({saved:accepted!.saved,retained:{}},createLegalRecoveryFiles(f.ports),baseUrl);
 expect(restored.snapshots[0]?.content).toBe(body);
});
