import {expect,spyOn,test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {ActivityState} from '@podjs/framework/services';
import * as bytes from '@podjs/framework/bytes';
import type {InformationSnapshot} from '../src/ui/InformationScreens.tsx';
import {
 captureLegalNavigation,hydrateLegalNavigation,legalDocumentIdentity,prepareLegalNavigation,restoreLegalNavigation,
 STARTUP_LEGAL_KEY as key,type LegalNavigation,type StartupLegalPage,
} from '../src/onboarding/legal-restoration.ts';
import {
 LegalRecoveryIdentityError,validateLegalBodyReference,type LegalBodyReference,type LegalDocumentIdentity,
} from '../src/onboarding/legal-recovery-files.ts';

const BASE='https://legal.example.test/',OWNER='task_codec';
const empty=():ActivityState=>({saved:{},retained:{}});
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const snapshot=(content:string|null='隐私正文📄',extra:Partial<InformationSnapshot>={}):InformationSnapshot=>({
 content,error:null,isLoading:content===null,reloadKey:3,listAnchor:content===null?null:{index:12,offsetPx:37},
 scrollOffset:180,...extra,
});
const navigation=(state:InformationSnapshot|null,covered=false,page:'privacy'|'useragreement'='privacy'):LegalNavigation=>({
 pages:covered?[page,'beian']:[page],snapshots:covered?[state,null]:[state],
});
// Deliberately mutable boundary values for corruption/schema tests.
const saved=(state:ActivityState)=>state.saved[key] as any;
const retained=(state:ActivityState)=>state.retained[key] as any;

function fixture(){
 const data=new Map<string,Buffer>(),writes:LegalBodyReference[]=[],reads:LegalBodyReference[]=[],discarded:LegalBodyReference[]=[];
 let sequence=0;
 const files={
  async write(identity:LegalDocumentIdentity,content:string,owner:string):Promise<LegalBodyReference>{
   const body=Buffer.from(content),digest=sha(body),identitySha256=sha(JSON.stringify([identity.page,identity.url]));
   const reference=validateLegalBodyReference({version:1,owner,identity,identitySha256,
    path:'legal-recovery/v1/'+owner+'/'+identitySha256+'-'+digest+'-fixture_'+(++sequence)+'.utf8',
    byteLength:body.length,sha256:digest},identity);
   data.set(reference.path,body);writes.push(reference);return reference;
  },
  async read(value:LegalBodyReference,expected:LegalDocumentIdentity):Promise<string>{
   const reference=validateLegalBodyReference(value,expected);
   if(sha(JSON.stringify([reference.identity.page,reference.identity.url]))!==reference.identitySha256)
    throw new LegalRecoveryIdentityError();
   reads.push(reference);
   const body=data.get(reference.path);
   if(!body)throw Error('body missing');
   if(body.length!==reference.byteLength||sha(body)!==reference.sha256)throw Error('body corrupt');
   return body.toString('utf8');
  },
  async discardUnpublished(reference:LegalBodyReference){discarded.push(reference);data.delete(reference.path);},
 };
 return {data,writes,reads,discarded,files};
}
async function commit(state:InformationSnapshot|null,covered=false,page:'privacy'|'useragreement'='privacy'){
 const f=fixture(),prepared=await prepareLegalNavigation(navigation(state,covered,page),f.files,BASE,OWNER);
 return {...f,prepared,state:captureLegalNavigation(empty(),prepared)};
}

test('top document metadata and canonical anchor survive both bags; hydration precedes mounting',async()=>{
 const original=snapshot(),f=await commit(original);
 const pending=restoreLegalNavigation(clone(f.state));
 expect(pending.pages).toEqual(['privacy']);
 expect(pending.snapshots).toEqual([{...original,content:null}]);
 expect(pending.restoreModes).toEqual(['recreated']);
 expect(pending.owner).toBe(OWNER);
 expect(saved(f.state).snapshots[0].identity).toEqual(legalDocumentIdentity('privacy',BASE));
 expect(()=>captureLegalNavigation(empty(),pending)).toThrow();
 const hydrated=await hydrateLegalNavigation(clone(f.state),f.files,BASE);
 expect(hydrated.snapshots).toEqual([original]);
 expect(hydrated.restoreModes).toEqual(['recreated']);
 expect(f.reads).toHaveLength(1);
 expect(captureLegalNavigation(empty(),hydrated)).toEqual(f.state);
});

test('only a matching settled non-configuration lower record retains its phase',async()=>{
 const original=snapshot(),f=await commit(original,true);
 const sameProcess=await hydrateLegalNavigation(clone(f.state),f.files,BASE);
 expect(sameProcess.snapshots).toEqual([original,null]);
 expect(sameProcess.restoreModes).toEqual(['retained-underlying','recreated']);

 const processDeath=await hydrateLegalNavigation({saved:clone(f.state.saved),retained:{}},f.files,BASE);
 expect(processDeath.snapshots).toEqual([original,null]);
 expect(processDeath.restoreModes).toEqual(['recreated','recreated']);

 const stale=clone(f.state);
 retained(stale).snapshots[0].state.reloadKey++;
 expect(restoreLegalNavigation(stale).restoreModes).toEqual(['recreated','recreated']);
 const noLower=clone(f.state);retained(noLower).snapshots[0]=null;
 expect(restoreLegalNavigation(noLower).restoreModes).toEqual(['recreated','recreated']);
});

test('settled lower errors retain only in matching retained state and still carry URL identity',async()=>{
 const original=snapshot(null,{error:'加载失败',isLoading:false,listAnchor:null,scrollOffset:0}),f=await commit(original,true);
 expect(f.writes).toHaveLength(0);
 expect(saved(f.state).snapshots[0].bodyReference).toBeNull();
 expect(saved(f.state).snapshots[0].identity.url).toBe(legalDocumentIdentity('privacy',BASE).url);
 const hydrated=await hydrateLegalNavigation(clone(f.state),f.files,BASE);
 expect(hydrated.snapshots).toEqual([original,null]);
 expect(hydrated.restoreModes).toEqual(['retained-underlying','recreated']);
 expect(f.reads).toHaveLength(0);
 expect(restoreLegalNavigation({saved:f.state.saved,retained:{}}).restoreModes).toEqual(['recreated','recreated']);
 await expect(hydrateLegalNavigation(clone(f.state),f.files,'https://other.example')).rejects.toThrow('身份');
});

test('loading and retry generations are authoritative and never inferred from zero offset',async()=>{
 for(const original of [
  snapshot(null,{isLoading:true,reloadKey:9,listAnchor:null,scrollOffset:0}),
  snapshot('pending旧正文',{isLoading:true,reloadKey:9,listAnchor:{index:0,offsetPx:0},scrollOffset:0}),
  snapshot('已完成正文',{isLoading:false,reloadKey:9,listAnchor:null,scrollOffset:0}),
 ]){
  const f=await commit(original,true),hydrated=await hydrateLegalNavigation(clone(f.state),f.files,BASE);
  expect(hydrated.snapshots).toEqual([original,null]);
  expect(hydrated.restoreModes?.[0]).toBe(original.isLoading?'recreated':'retained-underlying');
 }
});

test('all 512 KiB body bytes live in files while saved and retained stay below 4 KiB',async()=>{
 for(const content of ['"\n'.repeat(256*1024),String.fromCodePoint(0x3ffff).repeat(128*1024)]){
  expect(Buffer.byteLength(content)).toBe(512*1024);
  const f=await commit(snapshot(content),true);
  for(const bag of [f.state.saved,f.state.retained]){
   const encoded=JSON.stringify(bag);
   expect(Buffer.byteLength(encoded)).toBeLessThan(4096);
   expect(encoded).not.toContain('contentBase64');
   expect(encoded).not.toContain('"content":');
  }
  const processDeath=await hydrateLegalNavigation({saved:clone(f.state.saved),retained:{}},f.files,BASE);
  expect(processDeath.snapshots[0]?.content).toBe(content);
  expect(processDeath.snapshots[0]?.listAnchor).toEqual({index:12,offsetPx:37});
 }
 const f=fixture();
 await expect(prepareLegalNavigation(navigation(snapshot('x'.repeat(512*1024+1))),f.files,BASE,OWNER)).rejects.toThrow('过大');
 await expect(prepareLegalNavigation(navigation(snapshot('中'.repeat(180000))),f.files,BASE,OWNER)).rejects.toThrow('过大');
 await expect(prepareLegalNavigation(navigation(snapshot('bad\ud800')),f.files,BASE,OWNER)).rejects.toThrow('UTF-8');
 expect(f.writes).toHaveLength(0);
});

test('scroll-only preparation and capture reuse proof without re-encoding a 512 KiB body',async()=>{
 const body='x'.repeat(512*1024),f=fixture(),encode=bytes.stringToUtf8;
 let bodyEncodes=0;
 const spy=spyOn(bytes,'stringToUtf8').mockImplementation(value=>{
  if(value===body)bodyEncodes++;
  return encode(value);
 });
 try{
  let previous=await prepareLegalNavigation(navigation(snapshot(body)),f.files,BASE,OWNER);
  expect(bodyEncodes).toBe(1);
  const reference=previous.bodyReferences![0];
  for(let step=0;step<30;step++){
   previous=await prepareLegalNavigation(navigation(snapshot(body,{
    scrollOffset:step,listAnchor:{index:4+step,offsetPx:step%7},
   })),f.files,BASE,OWNER,previous);
   expect(previous.bodyReferences![0]).toBe(reference);
   captureLegalNavigation(empty(),previous);
  }
  expect(bodyEncodes).toBe(1);
  expect(f.writes).toHaveLength(1);
  expect(f.reads).toHaveLength(0);
 }finally{spy.mockRestore();}
});

test('same-length changed content gets a new commit and raw or altered navigation has no trusted body proof',async()=>{
 const f=fixture(),first=await prepareLegalNavigation(navigation(snapshot('AAAA')),f.files,BASE,OWNER);
 const changed=await prepareLegalNavigation({...navigation(snapshot('BBBB')),owner:OWNER,bodyReferences:first.bodyReferences},f.files,BASE,OWNER,first);
 expect(f.writes).toHaveLength(2);
 expect(changed.bodyReferences![0]).not.toBe(first.bodyReferences![0]);
 expect(captureLegalNavigation(empty(),changed)).toBeDefined();
 expect(()=>captureLegalNavigation(empty(),{...changed})).toThrow();
 expect(()=>captureLegalNavigation(empty(),navigation(snapshot('AAAA')))).toThrow();
 first.snapshots[0]!.content='BBBB';
 expect(()=>captureLegalNavigation(empty(),first)).toThrow('匹配');
 const urlChanged=await prepareLegalNavigation(navigation(snapshot('BBBB')),f.files,'https://new.example',OWNER,changed);
 expect(f.writes).toHaveLength(3);
 expect(urlChanged.bodyReferences![0]!.identity.url).toBe(legalDocumentIdentity('privacy','https://new.example').url);
});

test('missing or corrupt files become fresh loading without an anchor and emit one warning',async()=>{
 for(const corrupt of [false,true]){
  const original=snapshot('original',{reloadKey:7}),f=await commit(original,true),reference=f.prepared.bodyReferences![0]!;
  if(corrupt)f.data.set(reference.path,Buffer.from('tampered'));else f.data.delete(reference.path);
  const warnings:Array<{error:unknown;page:StartupLegalPage}>=[],before=JSON.stringify(f.state);
  const hydrated=await hydrateLegalNavigation(f.state,f.files,BASE,(error,page)=>warnings.push({error,page}));
  expect(hydrated.snapshots).toEqual([snapshot(null,{reloadKey:7,isLoading:true,listAnchor:null,scrollOffset:0}),null]);
  expect(hydrated.bodyReferences).toEqual([null,null]);
  expect(hydrated.restoreModes).toEqual(['recreated','recreated']);
  expect(warnings).toHaveLength(1);expect(warnings[0].page).toBe('privacy');
  expect(JSON.stringify(f.state)).toBe(before);
  const recaptured=captureLegalNavigation(empty(),hydrated);
  expect(saved(recaptured).snapshots[0].bodyReference).toBeNull();
 }
});

test('different page, endpoint, owner and malformed reference identity fail before body reads',async()=>{
 const f=await commit(snapshot(),true);
 const cases:Array<(state:ActivityState)=>void>=[
  state=>{saved(state).snapshots[0].page='useragreement';},
  state=>{saved(state).snapshots[0].identity.page='useragreement';},
  state=>{saved(state).snapshots[0].identity.url='file:///other';},
  state=>{delete saved(state).snapshots[0].identity;},
  state=>{saved(state).snapshots[0].bodyReference.identity.page='useragreement';},
  state=>{saved(state).snapshots[0].bodyReference.path='../outside';},
  state=>{saved(state).snapshots[0].bodyReference.owner='other_task';},
  state=>{retained(state).owner='other_task';},
 ];
 for(const mutate of cases){
  const state=clone(f.state);mutate(state);const before=JSON.stringify(state);
  expect(()=>restoreLegalNavigation(state)).toThrow();
  await expect(hydrateLegalNavigation(state,f.files,BASE)).rejects.toThrow();
  expect(JSON.stringify(state)).toBe(before);
 }
 await expect(hydrateLegalNavigation(f.state,f.files,'https://changed.example')).rejects.toThrow();
 expect(f.reads).toHaveLength(0);
});

test('a syntactically valid but forged URL digest is fatal rather than a recoverable body warning',async()=>{
 const f=await commit(snapshot()),state=clone(f.state),entry=saved(state).snapshots[0];
 const original=entry.bodyReference.identitySha256;
 entry.bodyReference.identitySha256='0'.repeat(64);
 entry.bodyReference.path=entry.bodyReference.path.replace(original,entry.bodyReference.identitySha256);
 state.retained={};
 let warnings=0;
 await expect(hydrateLegalNavigation(state,f.files,BASE,()=>warnings++)).rejects.toBeInstanceOf(LegalRecoveryIdentityError);
 expect(warnings).toBe(0);
});

test('malformed metadata and stack shapes throw without coercing absence into an anchor',async()=>{
 const f=await commit(snapshot(),true);
 const cases:Array<(state:ActivityState)=>void>=[
  state=>{saved(state).version=99;},
  state=>{saved(state).pages=['beian'];},
  state=>{saved(state).pages=['privacy','useragreement'];},
  state=>{saved(state).snapshots=[];},
  state=>{saved(state).snapshots[0].state.isLoading=0;},
  state=>{saved(state).snapshots[0].state.reloadKey=-1;},
  state=>{saved(state).snapshots[0].state.reloadKey=1.5;},
  state=>{saved(state).snapshots[0].state.scrollOffset=-1;},
  state=>{saved(state).snapshots[0].state.error='x'.repeat(8193);},
  state=>{delete saved(state).snapshots[0].state.listAnchor;},
  state=>{saved(state).snapshots[0].state.listAnchor={index:-1,offsetPx:0};},
  state=>{saved(state).snapshots[0].state.listAnchor={index:1,offsetPx:NaN};},
  state=>{saved(state).snapshots[1]=clone(saved(state).snapshots[0]);saved(state).snapshots[1].page='beian';},
  state=>{retained(state).snapshots=[];},
 ];
 for(const mutate of cases){const state=clone(f.state);mutate(state);expect(()=>restoreLegalNavigation(state)).toThrow();}
 for(const bad of [
  {pages:['privacy'],snapshots:[]},
  {pages:['privacy','useragreement'],snapshots:[null,null]},
  {pages:['privacy'],snapshots:[snapshot()],owner:'../task'},
 ]){
  await expect(prepareLegalNavigation(bad as LegalNavigation,f.files,BASE,OWNER)).rejects.toThrow();
 }
});

test('empty routes and unknown snapshots preserve unrelated host keys and invent no document state',async()=>{
 const prior:ActivityState={saved:{other:7},retained:{other:{keep:true}}},f=fixture();
 const unknown=await prepareLegalNavigation(navigation(null,true),f.files,BASE,OWNER);
 const state=captureLegalNavigation(prior,unknown),hydrated=await hydrateLegalNavigation(state,f.files,BASE);
 expect(hydrated.snapshots).toEqual([null,null]);
 expect(hydrated.restoreModes).toEqual(['recreated','recreated']);
 expect(f.reads).toHaveLength(0);expect(f.writes).toHaveLength(0);
 expect(captureLegalNavigation(state,{pages:[],snapshots:[]})).toEqual(prior);
 expect(prior).toEqual({saved:{other:7},retained:{other:{keep:true}}});
 expect(restoreLegalNavigation(empty())).toEqual({pages:[],snapshots:[]});
});

function legacy(content:string|null,error:string|null=null,topOnly=false):ActivityState {
 const value=content===null?null:Buffer.from(content).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');
 return {
  saved:{[key]:{version:1,pages:topOnly?['privacy']:['privacy','beian']}},
  retained:{[key]:{version:1,backgrounds:[{page:'privacy',state:{contentBase64:value,error,scrollOffset:180}},null]}},
 };
}

test('v1 read migration exposes only the historically saved lower state with no invented top or canonical anchor',()=>{
 const body='隐私\n\n正文📄',state=legacy(body),restored=restoreLegalNavigation(state);
 expect(restored.snapshots).toEqual([snapshot(body,{isLoading:false,reloadKey:0,listAnchor:null,scrollOffset:180}),null]);
 expect(restored.restoreModes).toEqual(['retained-underlying','recreated']);
 expect(restoreLegalNavigation(legacy(body,null,true)).snapshots).toEqual([null]);
 expect(restoreLegalNavigation({saved:state.saved,retained:{}}).snapshots).toEqual([null,null]);
 const malformed=legacy(body);(malformed.retained[key] as any).backgrounds[0].page='useragreement';
 expect(()=>restoreLegalNavigation(malformed)).toThrow('身份');
 const invalidBase64=legacy(body);(invalidBase64.retained[key] as any).backgrounds[0].state.contentBase64='not canonical base64!';
 expect(()=>restoreLegalNavigation(invalidBase64)).toThrow();
});

test('v1 hydration warns and discards URL-unknown content, errors and offsets without writing a new identity claim',async()=>{
 for(const state of [legacy('旧正文'),legacy(null,'旧错误'),legacy(null)]){
  const f=fixture(),restored=restoreLegalNavigation(state),warnings:unknown[]=[];
  await expect(prepareLegalNavigation(restored,f.files,BASE,OWNER)).rejects.toThrow('历史 URL');
  expect(()=>captureLegalNavigation(empty(),restored)).toThrow('历史 URL');
  const hydrated=await hydrateLegalNavigation(state,f.files,BASE,error=>warnings.push(error));
  expect(hydrated.snapshots).toEqual([snapshot(null,{reloadKey:0,scrollOffset:0,listAnchor:null,isLoading:true}),null]);
  expect(hydrated.restoreModes).toEqual(['recreated','recreated']);
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0])).toContain('历史 URL');
  expect(f.writes).toHaveLength(0);expect(f.reads).toHaveLength(0);
  const prepared=await prepareLegalNavigation(hydrated,f.files,BASE,OWNER);
  expect(saved(captureLegalNavigation(empty(),prepared)).snapshots[0].bodyReference).toBeNull();
 }
});

test('preparation failure rolls back only its newly returned unpublished references',async()=>{
 const f=fixture(),previous=await prepareLegalNavigation(navigation(snapshot('old')),f.files,BASE,OWNER);
 const oldReference=previous.bodyReferences![0]!,write=f.files.write;
 f.files.write=async(...args)=>({...await write(...args),byteLength:999});
 await expect(prepareLegalNavigation(navigation(snapshot('new')),f.files,BASE,OWNER,previous)).rejects.toThrow('大小');
 expect(f.discarded).toHaveLength(1);
 expect(f.discarded[0].path).not.toBe(oldReference.path);
 expect(f.data.has(oldReference.path)).toBe(true);
 expect(f.data.has(f.discarded[0].path)).toBe(false);

 f.files.write=async()=>oldReference;
 await expect(prepareLegalNavigation(navigation(snapshot('longer new body')),f.files,BASE,OWNER,previous)).rejects.toThrow('大小');
 expect(f.discarded).toHaveLength(1);
 expect(f.data.has(oldReference.path)).toBe(true);
});
