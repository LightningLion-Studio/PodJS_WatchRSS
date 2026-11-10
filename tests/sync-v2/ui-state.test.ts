/** T-SYNCV2-UI §1 adapter tests: every phase, both choice kinds, the
 * canMerge=false reason, unopenable notes, recovery copies, all write gates
 * closed, and the "no body text in the snapshot" guarantee. Synthetic
 * backends only; the real control/store are exercised via the P5 fixture. */
import {test,expect} from 'bun:test';
import {p5Fixture,dirtyRollback} from './p5-fixture';
import {watchSyncV2UiState,type SyncV2StateReader,type ChoicePreview} from '../../src/sync-v2/ui-state';
import {initialState,type SyncState} from '../../src/sync-v2/state';
import type {WatchAccountControl} from '../../src/sync-v2/account-control';

const ACCOUNT_OID='commit:sha256:'+'a'.repeat(64);
type Candidate={entityKey:string;title:string;markdown:string;deleted?:boolean};
type CloudEntry={entityKey:string;title:string;markdown:string;deleted?:boolean;unopenable?:{code:string}};
type BaseEntry={entityKey:string;title:string;markdown:string;deleted?:boolean};
type Unopenable=Record<string,{entityKey:string;code:string;deleted:boolean}>;

/** Fake projection: the adapter reads through the same public store APIs. */
function fakeProjection(o:{state:SyncState;candidates?:Candidate[];cloud?:CloudEntry[];bases?:BaseEntry[];noteSegments?:boolean;unopenable?:Unopenable}):{projection:SyncV2StateReader}{
 const candidates=o.candidates??[],cloud=o.cloud??[],bases=Object.fromEntries((o.bases??[]).map(b=>[b.entityKey,{identity:b.entityKey,title:b.title,markdown:b.markdown,...(b.deleted===undefined?{}:{deleted:true})}]));
 const projection:SyncV2StateReader={
  async readState(){const s={...o.state} as SyncState;if(o.unopenable)s.cloud={...s.cloud,unopenableNotes:o.unopenable};return structuredClone(s);},
  async candidatePage(after='',limit=32){return structuredClone(candidates.filter(c=>c.entityKey>after).slice(0,limit).map(c=>({entityKey:c.entityKey,candidate:{meta:{kind:'note',logicalId:c.entityKey,payload:{title:c.title}},state:{payload:{markdown:c.markdown,...(c.deleted===undefined?{}:{deleted:true})}}}})));},
  async cloudRows(_root,after='',limit=32){return structuredClone(cloud.filter(c=>c.entityKey>after).slice(0,limit).map(c=>({row:{entityKey:c.entityKey,deleted:c.deleted===true},meta:{logicalId:c.entityKey,payload:{title:c.title}},state:{payload:{markdown:c.markdown,...(c.deleted===undefined?{}:{deleted:true})}}})));},
  async editBases(){return structuredClone(bases);},
  async readCandidate(entityKey:string){const c=candidates.find(x=>x.entityKey===entityKey);return c?{meta:{kind:'note',logicalId:c.entityKey,payload:{title:c.title}},state:{payload:{markdown:c.markdown}}}:null;},
  segmentOptions(){return {noteSegments:o.noteSegments===true};},
 };
 return {projection};
}
/** Fake control implementing only the adapter-consumed surface. */
function fakeControl(overrides:Record<string,(...args:any[])=>unknown>={}){
 const calls:Record<string,any[][]>={};
 const record=(name:string,impl:(...args:any[])=>unknown)=>async(...args:any[])=>{(calls[name]??=[]).push(args);return impl(...args);};
 const defaults:Record<string,(...args:any[])=>unknown>={
  settings:()=>({history_restore:true,choice_apply:true,keepDiscardedLocalChanges7Days:true,gc:false,key_rotation:false,custody_release:false}),
  recoveryCopies:()=>[],
  pendingChoice:()=>null,
  closePreview:()=>undefined,
  chooseLocal:()=>({applied:true}),chooseCloud:()=>({applied:true}),chooseMerge:()=>({applied:true}),
  history:(pageToken:string|null)=>({items:[],pageToken}),
  rollback:()=>({committed:true}),
  restoreRecovery:()=>({restored:true}),
  setKeepDiscardedLocalChanges7Days:(v:boolean)=>({keep:v}),
  captureAccount:()=>Object.freeze({stateVersion:'0',accountOid:ACCOUNT_OID,accountRevision:'1',generation:'1',localChangeRevision:'1'}),
  flushApplied:()=>null,
 };
 const control=Object.fromEntries(Object.keys(defaults).map(name=>[name,record(name,(overrides[name]??defaults[name]) as (...a:any[])=>unknown)]));
 return {control:control as unknown as WatchAccountControl,calls};
}
const fakeRuntime=(pullImpl:()=>unknown=async()=>({empty:true}))=>({runtime:{pull:async()=>pullImpl(),publish:async()=>({})}});
const baseState=(over:Partial<SyncState>={}):SyncState=>({...initialState(),account:{oid:ACCOUNT_OID,revision:'3',generation:'2'},lastSeenAccountOid:ACCOUNT_OID,lastSeenAccountRevision:'3',lastSeen:'2',rollbackGeneration:'2',editBase:{accountOid:ACCOUNT_OID,generation:'2'},cloud:{current:{commitOid:ACCOUNT_OID,treeRoot:'tree:sha256:'+'b'.repeat(64),rowCount:1}},...over} as SyncState);
const awaitChoiceState=(over:Partial<SyncState>={}):SyncState=>baseState({pendingChoice:{generation:'2',inboxKeys:[]},hasUnsentEdits:true,...over});
const adapter=(o:Parameters<typeof watchSyncV2UiState>[0])=>watchSyncV2UiState(o);
const p5Adapter=(f:Awaited<ReturnType<typeof p5Fixture>>)=>adapter({runtime:{pull:async()=>({empty:true}),publish:async()=>({})},control:f.control,projection:f.projection,trustedNow:()=>f.server.clock});

test('write gates all closed: runtime not open gives enabled=false and an entirely empty snapshot',async()=>{
 const {projection}=fakeProjection({state:initialState()});
 const ui=adapter({runtime:null,control:null,projection,trustedNow:()=>42});
 const s=await ui.snapshot();
 expect(s).toEqual({enabled:false,phase:'idle',lastSyncedAtMillis:null,errorCode:null,choice:null,unopenableNotes:[],recoveryCopies:[],keepDiscardedLocalChanges7Days:false,gates:{historyRestore:false,choiceApply:false,noteSegments:false},publication:null,ownDeviceId:null});
 for(const action of [()=>ui.syncNow(),()=>ui.openChoice(),()=>ui.history(null),()=>ui.rollback('commit:sha256:'+'c'.repeat(64)),()=>ui.restoreRecovery('x'),()=>ui.setKeepDiscarded(false),()=>ui.chooseLocal({} as ChoicePreview),()=>ui.chooseCloud({} as ChoicePreview),()=>ui.chooseMerge({} as ChoicePreview),()=>ui.closeChoice({} as ChoicePreview)])await expect(action()).rejects.toThrow('feature_disabled');
 expect(await ui.snapshot()).toEqual(s);// failures while closed keep the inert contract
});

test('phase idle -> syncing -> idle; syncNow pulls and acks; lastSyncedAtMillis only from the trusted clock',async()=>{
 let releasePull:((v:unknown)=>void)=()=>{};
 let firstPull=true;
 let clock=100;
 const {projection}=fakeProjection({state:initialState()});
 const {control,calls}=fakeControl();
 const ui=adapter({runtime:{pull:()=>firstPull?new Promise(r=>{releasePull=r;}):Promise.resolve({empty:true}),publish:async()=>({})},control,projection,trustedNow:()=>clock});
 expect((await ui.snapshot()).phase).toBe('idle');
 const running=ui.syncNow();
 expect((await ui.snapshot()).phase).toBe('syncing');
 clock=1777;firstPull=false;releasePull({empty:true});
 await running;
 const s=await ui.snapshot();
 expect(s.phase).toBe('idle');expect(s.lastSyncedAtMillis).toBe(1777);expect(s.errorCode).toBeNull();
 expect(calls.flushApplied).toHaveLength(1);
 // an unknown trusted clock never fabricates a time; the previous stamp survives
 clock=null as never;
 await ui.syncNow();
 expect((await ui.snapshot()).lastSyncedAtMillis).toBe(1777);
});

test('awaiting_choice: kind=rollback, counts vs cloud tree and baseline, canMerge=false reason passthrough',async()=>{
 const state=awaitChoiceState({rollbackGeneration:'2',editBase:{accountOid:ACCOUNT_OID,generation:'1'}});
 const {projection}=fakeProjection({state,candidates:[{entityKey:'e1',title:'local title',markdown:'mine'}],cloud:[{entityKey:'e1',title:'cloud title',markdown:'theirs'}],bases:[{entityKey:'e1',title:'seen title',markdown:'seen'}]});
 const {control,calls}=fakeControl({pendingChoice:()=>({canMerge:false,reason:'note_conflict',proof:{}})});
 const ui=adapter({...fakeRuntime(),control,projection,trustedNow:()=>7});
 const s=await ui.snapshot();
 expect(s.phase).toBe('awaiting_choice');
 expect(s.choice).toEqual({localChanges:1,cloudChanges:1,canMerge:false,mergeUnavailableReason:'note_conflict',kind:'rollback'});
 expect(calls.pendingChoice).toHaveLength(1);expect(calls.closePreview).toHaveLength(1);// the snapshot released its own preparation
 await ui.snapshot();
 expect(calls.pendingChoice).toHaveLength(1);// the same state fingerprint reuses the cached planner answer
 const preview=await ui.openChoice();
 expect(preview).toEqual({local:[{title:'local title',kind:'edit'}],cloud:[{title:'cloud title',kind:'edit'}],more:{local:0,cloud:0},canMerge:false,reason:'note_conflict'});
 // while a preview is open, snapshots must not consume the control's single active preview
 await ui.snapshot();
 expect(calls.pendingChoice).toHaveLength(2);// only openChoice itself consumed one more pass
 expect(calls.closePreview).toHaveLength(1);// the open preview is owned by the UI, not closed by a snapshot
 expect(JSON.stringify(preview)).not.toContain('commit:');
});

test('awaiting_choice: kind=concurrent; add and delete entry kinds; unchanged rows not counted',async()=>{
 const state=awaitChoiceState({rollbackGeneration:'1',editBase:{accountOid:ACCOUNT_OID,generation:'1'},pendingChoice:{generation:'1',inboxKeys:['legacy-1']}});
 const {projection}=fakeProjection({state,candidates:[
  {entityKey:'e-a',title:'fresh',markdown:'mine'},// not in cloud, not in base -> add
  {entityKey:'e-b',title:'gone',markdown:'mine',deleted:true},// locally deleted -> delete
  {entityKey:'e-c',title:'keep',markdown:'same'},// equals the cloud row -> not counted
 ],cloud:[
  {entityKey:'e-b',title:'gone',markdown:'mine'},
  {entityKey:'e-c',title:'keep',markdown:'same'},
  {entityKey:'e-d',title:'remote only',markdown:'r'},// changed against the kept baseline -> counted
 ],bases:[
  {entityKey:'e-b',title:'gone',markdown:'mine'},
  {entityKey:'e-c',title:'keep',markdown:'same'},
  {entityKey:'e-d',title:'was here',markdown:'b'},// base present -> edit
 ]});
 const {control}=fakeControl({pendingChoice:()=>({canMerge:true,reason:null,proof:{}})});
 const ui=adapter({...fakeRuntime(),control,projection});
 const s=await ui.snapshot();
 expect(s.choice).toEqual({localChanges:2,cloudChanges:1,canMerge:true,mergeUnavailableReason:null,kind:'concurrent'});
 const preview=await ui.openChoice();
 expect(preview.local).toEqual([{title:'fresh',kind:'add'},{title:'gone',kind:'delete'}]);
 expect(preview.cloud).toEqual([{title:'remote only',kind:'edit'}]);
 expect(preview).toMatchObject({canMerge:true,reason:null,more:{local:0,cloud:0}});
});

test('preview caps each side at 50 rows and reports the remainder as more',async()=>{
 const rows=Array.from({length:62},(_,i)=>({entityKey:'e'+String(i).padStart(3,'0'),title:'t'+i,markdown:'m'+i}));
 const {projection}=fakeProjection({state:awaitChoiceState(),candidates:rows,cloud:[],bases:[]});
 const {control}=fakeControl({pendingChoice:()=>({canMerge:true,reason:null,proof:{}})});
 const ui=adapter({...fakeRuntime(),control,projection});
 const preview=await ui.openChoice();
 expect(preview.local).toHaveLength(50);expect(preview.more).toEqual({local:12,cloud:0});
 expect(preview.local.every(r=>r.kind==='add')).toBe(true);
 const s=await ui.snapshot();expect(s.choice!.localChanges).toBe(62);
});

test('blocked: unopenableNotes come from state.cloud with the kept local title or null; quarantined rows leave the counts',async()=>{
 const eBig='0000000000000000000000000000000000000000000000000000000000000001';
 const {projection}=fakeProjection({state:awaitChoiceState({pendingChoice:null,hasUnsentEdits:false}),
  candidates:[{entityKey:eBig,title:'kept old title',markdown:'small old body'},{entityKey:'e2',title:'other',markdown:'x'}],
  cloud:[{entityKey:'e2',title:'other',markdown:'x'}],
  unopenable:{big:{entityKey:eBig,code:'storage_pressure',deleted:false},ghost:{entityKey:'missing-entity',code:'storage_pressure',deleted:false},bye:{entityKey:'deleted-entity',code:'storage_pressure',deleted:true}},
 });
 const ui=adapter({...fakeRuntime(),control:fakeControl().control,projection});
 const s=await ui.snapshot();
 expect(s.phase).toBe('blocked');
 expect(s.unopenableNotes).toEqual([{noteId:'big',title:'kept old title'},{noteId:'ghost',title:null}]);
 expect(s.choice).toBeNull();
 // a quarantined entity is neither a local change nor a cloud change
 const p2=fakeProjection({state:awaitChoiceState({editBase:{accountOid:ACCOUNT_OID,generation:'1'}}),candidates:[{entityKey:eBig,title:'kept',markdown:'old'}],cloud:[],bases:[],unopenable:{big:{entityKey:eBig,code:'storage_pressure',deleted:false}}});
 const {control:c2}=fakeControl({pendingChoice:()=>({canMerge:false,reason:'missing_base',proof:{}})});
 const s2=await adapter({...fakeRuntime(),control:c2,projection:p2.projection}).snapshot();
 expect(s2.unopenableNotes).toEqual([{noteId:'big',title:'kept'}]);
 expect(s2.choice).toEqual({localChanges:0,cloudChanges:0,canMerge:false,mergeUnavailableReason:'missing_base',kind:'rollback'});
});

test('recovery copies, keepDiscarded and gates surface through settings/recoveryCopies',async()=>{
 const {projection}=fakeProjection({state:baseState({keepDiscardedLocalChanges7Days:false}),candidates:[],cloud:[{entityKey:'e1',title:'t',markdown:'m'}],bases:[{entityKey:'e1',title:'t',markdown:'m'}],noteSegments:true});
 const {control,calls}=fakeControl({recoveryCopies:()=>[{copyId:'c1',createdAtMillis:11,expiresAtMillis:22,extra:'never shown'} as any]});
 const ui=adapter({...fakeRuntime(),control,projection});
 const s=await ui.snapshot();
 expect(s.recoveryCopies).toEqual([{copyId:'c1',createdAtMillis:11,expiresAtMillis:22}]);
 expect(s.keepDiscardedLocalChanges7Days).toBe(false);
 expect(s.gates).toEqual({historyRestore:true,choiceApply:true,noteSegments:true});
 await ui.setKeepDiscarded(true);
 expect(calls.setKeepDiscardedLocalChanges7Days).toEqual([[true]]);
 const closedProjection=fakeProjection({state:baseState(),noteSegments:false}).projection;
 const closed=adapter({...fakeRuntime(),control:fakeControl({settings:()=>({history_restore:false,choice_apply:false})}).control,projection:closedProjection});
 expect((await closed.snapshot()).gates).toEqual({historyRestore:false,choiceApply:false,noteSegments:false});
});

test('publication: pending, detached and cleared identities project with the first-seen trusted moment',async()=>{
 const {control}=fakeControl();
 const mk=(cloud:Record<string,unknown>)=>fakeProjection({state:{...initialState(),cloud:cloud as never}}).projection;
 const pending=adapter({...fakeRuntime(),control,projection:mk({pendingPublish:{requestId:'r1',phase:'queued'}}),trustedNow:()=>555});
 expect((await pending.snapshot()).publication).toEqual({state:'pending',since:555});
 const detached=adapter({...fakeRuntime(),control,projection:mk({detachedPublications:{a:{outcome:'unknown'},b:{outcome:'succeeded'}}}),trustedNow:()=>0});
 expect((await detached.snapshot()).publication).toEqual({state:'detached',since:0});
 const cleared=adapter({...fakeRuntime(),control,projection:mk({detachedPublications:{b:{outcome:'succeeded'}}})});
 expect((await cleared.snapshot()).publication).toBeNull();
});

test('error phase: a failing action records the protocol code verbatim; the next success clears it',async()=>{
 const {projection}=fakeProjection({state:initialState()});
 let broken=true;
 const {control,calls}=fakeControl({restoreRecovery:()=>{if(broken)throw Error('window_expired');return{restored:true};},history:()=>{if(!broken)throw Error('storage_pressure');return{items:[],pageToken:null};}});
 const ui=adapter({...fakeRuntime(),control,projection});
 await expect(ui.restoreRecovery('c1')).rejects.toThrow('window_expired');
 let s=await ui.snapshot();
 expect(s.phase).toBe('error');expect(s.errorCode).toBe('window_expired');
 expect(calls.restoreRecovery).toEqual([['c1']]);
 broken=false;
 await ui.restoreRecovery('c1');
 s=await ui.snapshot();expect(s.phase).toBe('idle');expect(s.errorCode).toBeNull();
 await expect(ui.history(null)).rejects.toThrow('storage_pressure');
 expect((await ui.snapshot()).phase).toBe('blocked');// storage_pressure blocks, per the contract table
 await ui.setKeepDiscarded(true);
 expect((await ui.snapshot()).phase).toBe('idle');
});

test('action wiring: history pageToken, rollback capture defaults and explicit pass-through',async()=>{
 const {projection}=fakeProjection({state:initialState()});
 const {control,calls}=fakeControl();
 const ui=adapter({...fakeRuntime(),control,projection,requestId:()=>'d'.repeat(32)});
 await ui.history('token-7');
 expect(calls.history).toEqual([['token-7']]);
 await ui.history();
 expect(calls.history).toEqual([['token-7'],[null]]);
 const capture=Object.freeze({stateVersion:'9',accountOid:ACCOUNT_OID,accountRevision:'4',generation:'2',localChangeRevision:'5'});
 await ui.rollback('commit:sha256:'+'e'.repeat(64),capture as never);
 expect(calls.rollback[0]![1]).toBe(capture);expect(calls.rollback[0]![2]).toBe('d'.repeat(32));
 await ui.rollback('commit:sha256:'+'f'.repeat(64));
 expect(calls.captureAccount).toHaveLength(1);// an omitted capture comes from the control
});

test('preview handles are process-local: replays fail closed, closes are forwarded',async()=>{
 const {projection}=fakeProjection({state:awaitChoiceState(),candidates:[],cloud:[],bases:[]});
 const {control,calls}=fakeControl({pendingChoice:()=>({canMerge:true,reason:null,proof:{brand:'proof'}})});
 const ui=adapter({...fakeRuntime(),control,projection});
 const preview=await ui.openChoice();
 await expect(ui.chooseLocal({} as ChoicePreview)).rejects.toThrow('choice_stale');
 await expect(ui.chooseLocal(JSON.parse(JSON.stringify(preview)) as ChoicePreview)).rejects.toThrow('choice_stale');
 await ui.chooseCloud(preview,'c'.repeat(32));
 expect(calls.chooseCloud[0]![0]).toEqual({brand:'proof'});
 expect(calls.chooseCloud[0]![2]).toBe('c'.repeat(32));
 const preview2=await ui.openChoice();
 await ui.closeChoice(preview2);
 expect(calls.closePreview).toEqual([[{brand:'proof'}]]);// closeChoice forwards exactly the held proof
 await expect(ui.chooseMerge(preview2)).rejects.toThrow('choice_stale');
});

test('subscribe notifies after state-changing actions and stops after unsubscribe',async()=>{
 const {projection}=fakeProjection({state:initialState()});
 let failHistory=false;
 const {control}=fakeControl({history:()=>{if(failHistory)throw Error('window_expired');return{items:[],pageToken:null};}});
 const ui=adapter({...fakeRuntime(),control,projection});
 let hits=0;const off=ui.subscribe(()=>{hits++;});
 await ui.syncNow();expect(hits).toBe(1);
 await ui.setKeepDiscarded(true);expect(hits).toBe(2);
 failHistory=true;
 await expect(ui.history(null)).rejects.toThrow('window_expired');
 expect(hits).toBe(3);// failures notify too
 off();
 await ui.syncNow();expect(hits).toBe(3);
});

/* ---------------- real control + real projection store (P5 fixture) ---------------- */

test('P5 rollback choice: canMerge=false reason comes from the real planner and the snapshot carries no body or oid',async()=>{
 const f=await p5Fixture();
 try{
  await dirtyRollback(f);// default: local title 'offline edit', cloud rolled back to 'title n'
  const direct=await f.control.pendingChoice();expect(direct).not.toBeNull();
  const ui=p5Adapter(f);
  const s=await ui.snapshot();
  expect(s.enabled).toBe(true);
  expect(s.phase).toBe('awaiting_choice');
  expect(s.choice!.kind).toBe('rollback');
  expect(s.choice!.canMerge).toBe(false);
  expect(s.choice!.mergeUnavailableReason).toBe(direct!.reason??null);// the real planner's reason, verbatim
  expect(typeof direct!.reason).toBe('string');
  expect(s.choice!.localChanges).toBe(1);expect(s.choice!.cloudChanges).toBe(1);
  expect(s.gates).toEqual({historyRestore:true,choiceApply:true,noteSegments:false});
  const json=JSON.stringify(s);
  expect(json).not.toContain('local\ntext');
  expect(json).not.toContain('ancestor');
  expect(json).not.toContain((await f.projection.readState()).account!.oid);
 }finally{f.close();}
});

test('P5 long note body never enters the snapshot or the choice preview',async()=>{
 const f=await p5Fixture();
 try{
  const marker='BODY-MARKER-'+Math.random().toString(36).slice(2);
  const body=(word:string)=>Array.from({length:9000},(_,i)=>`${word}${i}`).join(' ');
  const longMarkdown=`${marker}\n${body('md')}`,longPlain=body('tx');
  await dirtyRollback(f,async()=>{await f.db.execute('UPDATE memo_notes SET markdown=?,plain_text=?,updated_at=updated_at+1 WHERE note_id=?',[longMarkdown,longPlain,'n']);await f.scan();});
  const ui=p5Adapter(f);
  const s=await ui.snapshot();
  expect(s.phase).toBe('awaiting_choice');
  expect(s.choice).toMatchObject({localChanges:1,cloudChanges:1,kind:'rollback',canMerge:true,mergeUnavailableReason:null});
  const preview=await ui.openChoice();
  const json=JSON.stringify({s,preview});
  expect(json).not.toContain(marker);
  expect(json).not.toContain(longPlain.slice(0,64));
  expect(preview.local.map(r=>r.title)).toEqual(['before rollback']);
  expect(preview.cloud.map(r=>r.kind)).toEqual(['edit']);
  await ui.chooseMerge(preview);// mergeable preview round-trips through the real publisher
  expect((await f.projection.readState()).pendingChoice).toBeNull();
 }finally{f.close();}
});

test('P5 recovery: chooseCloud through the adapter leaves a findable copy; restoreRecovery brings the edit back',async()=>{
 const f=await p5Fixture();
 try{
  await dirtyRollback(f);
  const ui=p5Adapter(f);
  expect((await ui.snapshot()).recoveryCopies).toEqual([]);
  const preview=await ui.openChoice();
  await ui.chooseCloud(preview);
  expect((await f.projection.readState()).pendingChoice).toBeNull();
  let s=await ui.snapshot();
  expect(s.recoveryCopies).toHaveLength(1);
  expect(Object.keys(s.recoveryCopies[0]!).sort()).toEqual(['copyId','createdAtMillis','expiresAtMillis']);
  expect(s.keepDiscardedLocalChanges7Days).toBe(true);
  expect(((await f.db.query('SELECT title FROM memo_notes'))[0] as any).title).toBe('title n');
  await ui.restoreRecovery(s.recoveryCopies[0]!.copyId);
  expect(((await f.db.query('SELECT title FROM memo_notes'))[0] as any).title).toBe('offline edit');
  s=await ui.snapshot();
  expect(s.enabled).toBe(true);
  expect(s.choice).toBeNull();// the restored edits are pending publication, not a pending choice
 }finally{f.close();}
});

test('P5 chooseLocal through the adapter publishes resolve-local and returns the UI to idle',async()=>{
 const f=await p5Fixture();
 try{
  await dirtyRollback(f);
  const ui=p5Adapter(f);
  const preview=await ui.openChoice();
  expect(preview.canMerge).toBe(false);
  await ui.chooseLocal(preview);
  const s=await ui.snapshot();
  expect(s.choice).toBeNull();expect(s.phase).toBe('idle');expect(s.errorCode).toBeNull();
  expect(((await f.db.query('SELECT title FROM memo_notes'))[0] as any).title).toBe('offline edit');
 }finally{f.close();}
});

test('P5 syncNow runs pull+ack through the runtime and stamps the trusted time',async()=>{
 const f=await p5Fixture();
 try{
  await dirtyRollback(f);
  let pulls=0,acks=0;
  const ui=adapter({runtime:{pull:async()=>{pulls++;return{empty:false};},publish:async()=>({})},control:f.control,projection:f.projection,trustedNow:()=>f.server.clock});
  const original=f.control.flushApplied.bind(f.control);
  (f.control as any).flushApplied=async()=>{acks++;return original();};
  await ui.syncNow();
  expect(pulls).toBe(1);expect(acks).toBe(1);
  const s=await ui.snapshot();
  expect(s.lastSyncedAtMillis).toBe(f.server.clock);
  expect(s.phase).toBe('awaiting_choice');// a dirty device keeps the choice open after a sync
  expect(s.errorCode).toBeNull();
 }finally{f.close();}
});
