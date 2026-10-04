import {expect,test} from 'bun:test';
import {createLegalSnapshotWriter,type LegalSnapshotWriterOptions} from '../src/onboarding/legal-snapshot-writer.ts';
import type {LegalBodyReference} from '../src/onboarding/legal-recovery-files.ts';
import type {LegalNavigation} from '../src/onboarding/legal-restoration.ts';

function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
function navigation(content:string|null='正文',scrollOffset=0,page:'privacy'|'useragreement'='privacy'):LegalNavigation {
 return {pages:[page],snapshots:[{content,error:null,isLoading:false,reloadKey:0,listAnchor:null,scrollOffset}]};
}
const empty=():LegalNavigation=>({pages:[],snapshots:[]});
function reference(path:string,page:'privacy'|'useragreement'='privacy'):LegalBodyReference {
 return {version:1,owner:'fixture',identity:{page,url:`https://example.org/${page}`},identitySha256:'a'.repeat(64),
  path,byteLength:512*1024,sha256:'b'.repeat(64)};
}
function fixture(overrides:Partial<LegalSnapshotWriterOptions>={}){
 const preparations:{navigation:LegalNavigation;previous:LegalNavigation|undefined;prepared:LegalNavigation}[]=[];
 const published:LegalNavigation[]=[],discarded:LegalBodyReference[]=[],errors:unknown[]=[];
 let bodyWrites=0;
 const prepare=async(current:LegalNavigation,previous?:LegalNavigation)=>{
  const body=current.snapshots[0]?.content;
  const reusable=body&&previous&&previous.snapshots[0]?.content===body&&current.pages[0]===previous.pages[0]
   ?previous.bodyReferences?.[0]:undefined;
  const ref=body?(reusable??reference(`body-${++bodyWrites}`,current.pages[0] as 'privacy'|'useragreement')):null;
  const prepared={...current,bodyReferences:current.pages.map((_,index)=>index===0?ref:null)};
  preparations.push({navigation:current,previous,prepared});
  return prepared;
 };
 const ports:LegalSnapshotWriterOptions={prepare,publish:prepared=>{published.push(prepared);},
  discard:async ref=>{discarded.push(ref);},onError:error=>{errors.push(error);},...overrides};
 const writer=createLegalSnapshotWriter(ports);
 return {writer,ports,prepare,preparations,published,discarded,errors,bodyWrites:()=>bodyWrites};
}

test('a 512 KiB scroll storm prepares serially, reuses the superseded result and publishes only the latest offset',async()=>{
 const body='x'.repeat(512*1024),started=deferred<void>(),gate=deferred<void>();
 const f=fixture();let active=0,maximum=0,calls=0;
 f.ports.prepare=async(nav,previous)=>{
  active++;maximum=Math.max(maximum,active);
  try {if(++calls===1){started.resolve();await gate.promise;}return await f.prepare(nav,previous);}
  finally {active--;}
 };
 f.writer.save(navigation(body,0));await started.promise;
 for(let offset=1;offset<=1000;offset++)f.writer.save(navigation(body,offset));
 let idle=false;const waiting=f.writer.idle().then(()=>{idle=true;});
 await Promise.resolve();expect(idle).toBe(false);expect(calls).toBe(1);
 gate.resolve();await waiting;
 expect(maximum).toBe(1);expect(calls).toBe(2);expect(f.bodyWrites()).toBe(1);
 expect(f.preparations[1].previous).toBe(f.preparations[0].prepared);
 expect(f.preparations[1].prepared.bodyReferences?.[0]).toBe(f.preparations[0].prepared.bodyReferences?.[0]);
 expect(f.published).toEqual([f.preparations[1].prepared]);
 expect(f.published[0].snapshots[0]?.scrollOffset).toBe(1000);
 expect(f.discarded).toEqual([]);expect(f.errors).toEqual([]);
});

test('popping a route while its body is being prepared suppresses publication and releases its unpublished file',async()=>{
 const started=deferred<void>(),gate=deferred<void>(),f=fixture();
 f.ports.prepare=async(nav,previous)=>{if(nav.pages.length){started.resolve();await gate.promise;}return f.prepare(nav,previous);};
 f.writer.save(navigation());await started.promise;f.writer.save(empty());gate.resolve();await f.writer.idle();
 expect(f.published.map(nav=>nav.pages)).toEqual([[]]);expect(f.bodyWrites()).toBe(1);
 expect(f.discarded).toEqual([f.preparations[0].prepared.bodyReferences![0]!]);
 expect(f.preparations[1].previous).toBe(f.preparations[0].prepared);
});

test('a superseding route with the same body gets its own identity and discards only the old path before publishing',async()=>{
 const started=deferred<void>(),gate=deferred<void>(),events:string[]=[],f=fixture();
 f.ports.prepare=async(nav,previous)=>{if(nav.pages[0]==='privacy'){started.resolve();await gate.promise;}return f.prepare(nav,previous);};
 f.ports.discard=async ref=>{f.discarded.push(ref);events.push(`discard:${ref.identity.page}`);};
 f.ports.publish=prepared=>{f.published.push(prepared);events.push(`publish:${prepared.pages[0]}`);};
 f.writer.save(navigation('same'));await started.promise;
 f.writer.save(navigation('same',9,'useragreement'));gate.resolve();await f.writer.idle();
 expect(f.bodyWrites()).toBe(2);expect(events).toEqual(['discard:privacy','publish:useragreement']);
 expect(f.published).toEqual([f.preparations[1].prepared]);
 expect(f.discarded[0]).toBe(f.preparations[0].prepared.bodyReferences![0]!);
});

test('close during preparation ignores further saves, cleans its late result and never publishes or reports cleanup errors',async()=>{
 const started=deferred<void>(),gate=deferred<void>(),f=fixture();
 f.ports.prepare=async(nav,previous)=>{started.resolve();await gate.promise;return f.prepare(nav,previous);};
 f.ports.discard=async ref=>{f.discarded.push(ref);throw Error('closed cleanup failed');};
 f.writer.save(navigation());await started.promise;f.writer.close();f.writer.close();f.writer.save(navigation('ignored'));
 gate.resolve();await f.writer.idle();
 expect(f.bodyWrites()).toBe(1);expect(f.published).toEqual([]);expect(f.errors).toEqual([]);
 expect(f.discarded).toHaveLength(1);
});

test('a late preparation rejection after close is silent and still releases earlier unpublished references',async()=>{
 const old=reference('old'),initial={...navigation(),bodyReferences:[old]},started=deferred<void>(),gate=deferred<LegalNavigation>();
 const f=fixture({initial,prepare:async()=>{started.resolve();return gate.promise;}});
 f.writer.save(navigation('new'));await started.promise;f.writer.close();gate.reject(Error('late prepare'));
 await f.writer.idle();expect(f.discarded).toEqual([old]);expect(f.published).toEqual([]);expect(f.errors).toEqual([]);
});

test('prepare failure is reported once and a later save recovers without losing the last prepared object',async()=>{
 const initial={...navigation(),bodyReferences:[reference('initial')]},failure=Error('prepare failed');
 const f=fixture({initial});let attempts=0;
 f.ports.prepare=async(nav,previous)=>{if(++attempts===1)throw failure;return f.prepare(nav,previous);};
 f.writer.save(navigation('bad'));await f.writer.idle();expect(f.errors).toEqual([failure]);
 f.writer.save(navigation('正文',27));await f.writer.idle();
 expect(f.preparations[0].previous).toBe(initial);expect(f.bodyWrites()).toBe(0);
 expect(f.published[0].snapshots[0]?.scrollOffset).toBe(27);expect(f.errors).toEqual([failure]);expect(f.discarded).toEqual([]);
});

test('publish failure is reported once and later scroll reuses the prepared file instead of writing another body',async()=>{
 const failure=Error('uncertain host acknowledgement'),f=fixture();let publishes=0;
 f.ports.publish=prepared=>{if(++publishes===1)throw failure;f.published.push(prepared);};
 f.writer.save(navigation());await f.writer.idle();expect(f.errors).toEqual([failure]);
 f.writer.save(navigation('正文',42));await f.writer.idle();
 expect(f.bodyWrites()).toBe(1);expect(f.preparations[1].previous).toBe(f.preparations[0].prepared);
 expect(f.published).toEqual([f.preparations[1].prepared]);expect(f.discarded).toEqual([]);expect(f.errors).toEqual([failure]);
});

test('an in-flight host write finishes before the coalesced newer write, and idle includes both',async()=>{
 const started=deferred<void>(),gate=deferred<void>(),finished:number[]=[],f=fixture();let publishes=0;
 f.ports.publish=async prepared=>{
  if(++publishes===1){started.resolve();await gate.promise;}
  finished.push(prepared.snapshots[0]!.scrollOffset);
 };
 f.writer.save(navigation());await started.promise;
 f.writer.save(navigation('正文',5));f.writer.save(navigation('正文',10));
 expect(f.preparations).toHaveLength(1);expect(finished).toEqual([]);
 const waiting=f.writer.idle();gate.resolve();await waiting;
 expect(finished).toEqual([0,10]);expect(f.preparations).toHaveLength(2);expect(f.bodyWrites()).toBe(1);
});

test('path equality preserves a shared reference, and eventual cleanup receives its original allocation object once',async()=>{
 const original=reference('shared'),initial={...navigation(),bodyReferences:[original]},clone={...original};
 const f=fixture({initial,prepare:async nav=>({...nav,bodyReferences:nav.pages.length?[clone,clone]:[]})});
 f.writer.save(navigation('正文',5));await f.writer.idle();expect(f.discarded).toEqual([]);
 f.writer.save(empty());await f.writer.idle();expect(f.discarded).toHaveLength(1);expect(f.discarded[0]).toBe(original);
});

test('a reference used by the latest pending navigation survives a superseded candidate with another path',async()=>{
 const old=reference('old'),next=reference('next'),initial={...navigation('old'),bodyReferences:[old]};
 const started=deferred<void>(),gate=deferred<void>(),f=fixture({initial});
 f.ports.prepare=async nav=>{
  if(nav.snapshots[0]?.content==='next'){started.resolve();await gate.promise;return {...nav,bodyReferences:[next]};}
  return {...nav,bodyReferences:[old]};
 };
 f.writer.save(navigation('next'));await started.promise;
 f.writer.save({...navigation('old',99),bodyReferences:[{...old}]});gate.resolve();await f.writer.idle();
 expect(f.discarded).toEqual([next]);expect(f.published[0].bodyReferences).toEqual([old]);
 expect(f.published[0].snapshots[0]?.scrollOffset).toBe(99);
});

test('cleanup and a throwing error reporter cannot reject idle or prevent a queued save from progressing',async()=>{
 const initial={...navigation('old'),bodyReferences:[reference('old')]},failure=Error('cleanup failed'),reported:unknown[]=[];
 const f=fixture({initial,discard:async()=>{throw failure;},onError:error=>{reported.push(error);throw Error('reporter failed');}});
 f.writer.save(navigation('new'));await f.writer.idle();
 expect(reported).toEqual([failure]);expect(f.published).toHaveLength(1);
 f.writer.save(navigation('new',17));await f.writer.idle();
 expect(reported).toEqual([failure]);expect(f.published).toHaveLength(2);expect(f.bodyWrites()).toBe(1);
});

test('synchronous reentrant save from prepare is serialized and suppresses the original publication',async()=>{
 const f=fixture();let calls=0;
 f.ports.prepare=(nav,previous)=>{if(++calls===1)f.writer.save(navigation('正文',8));return f.prepare(nav,previous);};
 f.writer.save(navigation());await f.writer.idle();
 expect(calls).toBe(2);expect(f.published.map(nav=>nav.snapshots[0]?.scrollOffset)).toEqual([8]);expect(f.bodyWrites()).toBe(1);
});

test('closing an idle writer discards each tracked path once and published-file protection remains with the file port',async()=>{
 const protectedPaths=new Set<string>(),removed:string[]=[],f=fixture();
 f.ports.publish=prepared=>{for(const ref of prepared.bodyReferences??[])if(ref)protectedPaths.add(ref.path);};
 f.ports.discard=async ref=>{f.discarded.push(ref);if(!protectedPaths.has(ref.path))removed.push(ref.path);};
 f.writer.save(navigation());await f.writer.idle();f.writer.close();f.writer.close();await f.writer.idle();
 expect(f.discarded).toHaveLength(1);expect(removed).toEqual([]);expect(f.errors).toEqual([]);
});

test('close between drain completion and promise settlement still cleans tracked references before idle resolves',async()=>{
 const closed=deferred<void>(),f=fixture();
 f.ports.publish=()=>{queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>{f.writer.close();closed.resolve();})));};
 f.writer.save(navigation());await closed.promise;await f.writer.idle();
 expect(f.discarded).toEqual([f.preparations[0].prepared.bodyReferences![0]!]);
});

test('a queued save proceeds after a gated preparation failure even when onError returns a rejected promise',async()=>{
 const started=deferred<void>(),gate=deferred<LegalNavigation>(),failure=Error('first prepare'),f=fixture();let attempts=0;
 f.ports.prepare=async(nav,previous)=>{if(++attempts===1){started.resolve();return gate.promise;}return f.prepare(nav,previous);};
 f.ports.onError=async error=>{f.errors.push(error);throw Error('async error reporter');};
 f.writer.save(navigation('stale'));await started.promise;f.writer.save(navigation('latest',12));gate.reject(failure);
 await f.writer.idle();expect(f.errors).toEqual([failure]);expect(f.published[0].snapshots[0]?.content).toBe('latest');
 expect(f.published[0].snapshots[0]?.scrollOffset).toBe(12);
});

test('close during an already dispatched host write suppresses late errors and any pending newer publication',async()=>{
 const started=deferred<void>(),gate=deferred<void>(),f=fixture();let publications=0;
 f.ports.publish=async()=>{publications++;started.resolve();await gate.promise;};
 f.writer.save(navigation());await started.promise;f.writer.save(navigation('latest'));f.writer.close();
 gate.reject(Error('closed host acknowledgement'));await f.writer.idle();
 expect(publications).toBe(1);expect(f.preparations).toHaveLength(1);expect(f.discarded).toHaveLength(1);expect(f.errors).toEqual([]);
});
