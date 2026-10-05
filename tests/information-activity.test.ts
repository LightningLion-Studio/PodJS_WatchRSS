import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {InformationActivity} from '../src/navigation/information-activity.ts';
import {captureActivityNavigation,restoreActivityNavigation,routeMemory,type ActivityRoute} from '../src/navigation/activity-navigation.ts';
import {validateLegalBodyReference,type LegalRecoveryFiles} from '../src/onboarding/legal-recovery-files.ts';
import type {InformationSnapshot} from '../src/ui/InformationScreens.tsx';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const snapshot=(content:string|null):InformationSnapshot=>({content,error:null,isLoading:content===null,reloadKey:3,listAnchor:{index:9,offsetPx:26},scrollOffset:190});
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function filesFixture(){
 const bodies=new Map<string,string>(),published=new Set<string>(),events:string[]=[];let writes=0,reads=0;
 let allow!:()=>void;const gate=new Promise<void>(resolve=>allow=resolve);
 const files:LegalRecoveryFiles={
  async write(identity,body,owner){
   const identitySha256=sha(JSON.stringify([identity.page,identity.url])),hash=sha(body);
   const ref=validateLegalBodyReference({version:1,owner,identity,identitySha256,sha256:hash,byteLength:Buffer.byteLength(body),path:`legal-recovery/v1/${owner}/${identitySha256}-${hash}-fixture_${++writes}.utf8`});
   events.push('write-began');await gate;bodies.set(ref.path,body);events.push('write-committed');return ref;
  },
  async read(ref,identity){reads++;validateLegalBodyReference(ref,identity);const body=bodies.get(ref.path);if(body===undefined||sha(body)!==ref.sha256)throw Error('corrupt fixture');return body;},
  markPublished(ref){expect(bodies.has(ref.path)).toBe(true);events.push('published');published.add(ref.path);},
  async discardUnpublished(ref){if(!published.has(ref.path)){events.push('discarded');bodies.delete(ref.path);}},
 };
 return {files,bodies,published,events,allow,writes:()=>writes,reads:()=>reads};
}
function restored(entry:ActivityRoute,process=false){const state=captureActivityNavigation({saved:{},retained:{}},[{page:'home'},entry]);return restoreActivityNavigation(clone(process?{saved:state.saved,retained:{}}:state))!.at(-1)!;}

test('main legal documents commit body before publishing metadata, reuse files, and hydrate before both remount paths',async()=>{
 const f=filesFixture(),entry:ActivityRoute={page:'information',informationPage:'privacy'};let changes=0;const errors:unknown[]=[];
 const owner=new InformationActivity(()=>{changes++;},error=>errors.push(error),f.files),body='正文📄'.repeat(16000);
 owner.save(entry,snapshot(body));await turn();expect(changes).toBe(0);expect(routeMemory(entry).saved.legal).toBeUndefined();expect(f.events).toEqual(['write-began']);
 f.allow();await turn();expect(changes).toBe(1);expect(f.events).toEqual(['write-began','write-committed','published']);
 const state=captureActivityNavigation({saved:{},retained:{}},[{page:'home'},entry]);expect(JSON.stringify(state)).not.toContain(body);expect(Buffer.byteLength(JSON.stringify(state.saved))).toBeLessThan(4096);
 for(const process of [false,true]){
  const next=restored(entry,process),reader=new InformationActivity(()=>{},error=>errors.push(error),f.files);
  await reader.restore(next);expect(next.informationSnapshot).toEqual(snapshot(body));reader.close();
 }
 owner.save(entry,{...snapshot(body),scrollOffset:230,listAnchor:{index:12,offsetPx:6}});await turn();expect(f.writes()).toBe(1);expect(changes).toBe(2);
 const next=restored(entry,true);await owner.restore(next);expect(next.informationSnapshot?.listAnchor).toEqual({index:12,offsetPx:6});
 owner.prune([]);await turn();expect(f.bodies.size).toBe(1);expect(f.published.size).toBe(1);expect(errors).toEqual([]);
});

test('corrupt legal file and stale page identity are rejected without discarding other route state',async()=>{
 const f=filesFixture();f.allow();const entry:ActivityRoute={page:'information',informationPage:'privacy'},errors:unknown[]=[];
 const owner=new InformationActivity(()=>{},error=>errors.push(error),f.files);owner.save(entry,snapshot('verified body'));await turn();
 for(const path of f.bodies.keys())f.bodies.set(path,'tampered');
 const next=restored(entry,true);routeMemory(next).saved.other=true;await owner.restore(next);
 expect(next.informationSnapshot).toMatchObject({content:null,isLoading:true,listAnchor:null,scrollOffset:0});expect(routeMemory(next).saved.other).toBe(true);expect(errors.length).toBeGreaterThan(0);
 const wrong=restored(entry);wrong.informationPage='useragreement';await owner.restore(wrong);expect(wrong.informationSnapshot).toBeUndefined();owner.close();
});

test('built-in information restores only anchors and reload metadata from the current bundled source',async()=>{
 const f=filesFixture(),entry:ActivityRoute={page:'information',informationPage:'licenses'};
 const owner=new InformationActivity(()=>{},()=>{},f.files);owner.save(entry,snapshot('bundled body, not a Bundle payload'));
 const next=restored(entry,true);await owner.restore(next);
 expect(next.informationSnapshot).toEqual({...snapshot(null),isLoading:false});expect(f.writes()).toBe(0);expect(f.reads()).toBe(0);
 const stale=restored(entry,true);routeMemory(stale).saved.information={reloadKey:NaN,scrollOffset:3,listAnchor:null};await owner.restore(stale);expect(stale.informationSnapshot).toBeUndefined();owner.close();
});
