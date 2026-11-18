import {test,expect} from 'bun:test';
import fixtures from '../fixtures/library-binary/peer-fixtures.json';
import {classifyPeer,routeScopes,ConnectionRoute,selectionComplete,SwitchGate,s2Capability,checkSelectedLimits,binaryCapability,RELEASE_B2_ENABLED,negotiate,type Ready,type PeerRoute} from '../../src/sync/library-binary/routing';
import {Preparation} from '../../src/sync/library-binary/prepare';
import {capabilityDigest,preparationDigest} from '../../src/sync/library-binary/digests';
import {cap,selection,binding,begin,object} from './helpers';
const ready:Ready={identityVerified:true,accountConfirmed:true,legacyAcksDrained:true};
for(const c of fixtures.cases)test('frozen peer projection: '+c.name,()=>expect(classifyPeer(c.probe,c.ready)).toBe(c.expected as PeerRoute));
test('release defaults off; explicit S2 adapter readiness sets limits 1/65536',()=>{
 expect(RELEASE_B2_ENABLED).toBe(false);expect(s2Capability(cap.kinds,{...cap.limits,maxInFlightChunks:8,maxInFlightBytes:524288})).toEqual(cap);expect(()=>s2Capability([],cap.limits)).toThrow();
});
test('routing matrix uses send/receive intersection and independent v1 tasks',()=>{
 const scopes=[{domain:'rss',kind:'rssSource',direction:'phoneToWatch' as const,v1Available:true},{domain:'books',kind:'bookState',direction:'phoneToWatch' as const,v1Available:true},{domain:'notes',kind:'noteRecord',direction:'watchToPhone' as const,v1Available:true}];
 for(const enabled of [false,true])for(const peer of ['B2','PODJS_V1','COMPOSE_V14'] as const){const r=routeScopes(enabled,peer,scopes,cap,cap);expect(r.map(r=>r.protocol)).toEqual([enabled&&peer==='B2'?'b2':'v1','v1','v1']);}
 const receiveOff={...cap,kinds:cap.kinds.map(k=>({...k,receive:false}))};expect(routeScopes(true,'B2',scopes,cap,receiveOff).every(r=>r.protocol==='v1')).toBe(true);
 for(const peer of ['CAPABILITY_MISMATCH','PEER_IMPLEMENTATION_UNKNOWN','WAIT_READY'] as const)expect(()=>routeScopes(true,peer,scopes,cap,cap)).toThrow();
 expect(()=>routeScopes(true,'PODJS_V1',[{...scopes[0]!,v1Available:false}])).toThrow('UNSUPPORTED_SCOPE');
 const routes=routeScopes(true,'B2',scopes,cap,cap),receipts=new Set(['phoneToWatch:rss:b2']);expect(selectionComplete(routes,receipts)).toBe(false);for(const r of routes)receipts.add(r.direction+':'+r.domain+':'+r.protocol);expect(selectionComplete(routes,receipts)).toBe(true);
});
test('S2×S3 selects window 1; S3×S3 formula remains 8; missing kind uses v1',()=>{
 const s3={...cap,limits:{...cap.limits,maxInFlightChunks:8,maxInFlightBytes:524288}};
 for(const [a,b] of [[cap,s3],[s3,cap]])expect(negotiate(a!,b!)!.limits.maxInFlightChunks).toBe(1);
 expect(negotiate(s3,s3)!.limits.maxInFlightChunks).toBe(8);
 const other={...cap,kinds:[{kind:'noteAsset' as const,schemaVersion:1 as const,send:true,receive:true}]};expect(negotiate(cap,other)).toBeNull();
});
test('malformed capability, identity conflict and unknown implementation never fall back',()=>{
 const p=fixtures.cases.find(c=>c.expected==='B2')!.probe;
 for(const bad of [{...p,libraryBinary:{...cap,chunkSizes:[32768]}},{...p,supportsAccountDataSpaces:false},{...p,libraryPeer:{implementation:'podjs',appVersion:'2.0.0-2'}}])expect(classifyPeer(bad,ready)).toBe('CAPABILITY_MISMATCH');
});
test('one physical connection cannot mix B2 and v1',()=>{
 const c=new ConnectionRoute();c.select('b2',ready);expect(()=>c.select('v1',ready)).toThrow();new ConnectionRoute().select('v1',ready);expect(()=>new ConnectionRoute().select('b2',{...ready,accountConfirmed:false})).toThrow();
});
test('switch validates digest, authorization and full-write barrier without old action:ack',()=>{
 const r={action:'syncLibraryBinary',version:2,phase:'switch',type:'request',requestId:'0'.repeat(32),payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(cap)}};
 const gate=new SwitchGate(true,cap);expect(()=>gate.requireBinary()).toThrow();const result=gate.accept(r,ready);expect(result).toEqual({action:r.action,version:2,phase:'switch',type:'response',requestId:r.requestId,success:true,result:r.payload});
 expect(Object.keys(result).sort()).toEqual(['action','phase','requestId','result','success','type','version']);expect(()=>gate.requireBinary()).toThrow();gate.responseFullyWritten();gate.requireBinary();
 expect(()=>new SwitchGate(false,cap).accept(r,ready)).toThrow();expect(()=>new SwitchGate(true,cap).accept({...r,payload:{...r.payload,watchCapabilityDigest:'f'.repeat(64)}},ready)).toThrow();
});
test('prepare persists offers/bindings before reply and binds full phone capability',async()=>{
 const p=new Preparation(cap),snapshot=begin([object('rssSource')]).payload.phoneSnapshot,offer={step:'offer',accountScope:'f'.repeat(64),phoneDeviceId:'phone',watchDeviceId:'watch',phoneCapabilities:cap,phoneSnapshot:snapshot,watchSnapshot:null};let writes=0;
 const result=await p.offerRequest('a'.repeat(32),offer,snapshot,async()=>{writes++;expect(()=>p.requireConfirmed()).toThrow();});
 const bs=[{direction:'phoneToWatch' as const,jobId:binding.jobId,intent:'create' as const,selection}];
 const confirm={step:'confirm',offerRequestId:'a'.repeat(32),bindings:bs,preparationDigest:preparationDigest(String(result.offerDigest),bs)};
 await expect(p.confirmRequest({...confirm,preparationDigest:'0'.repeat(64)},async()=>{})).rejects.toThrow();
 await p.confirmRequest(confirm,async()=>{writes++;expect(()=>p.requireConfirmed()).toThrow();});expect(()=>p.requireConfirmed()).toThrow('AUTH_REVOKED');p.confirmResponseFullyWritten();p.requireConfirmed();expect(writes).toBe(2);
 const changed=new Preparation(cap);const changedResult=await changed.offerRequest('b'.repeat(32),{...offer,phoneCapabilities:{...cap,kinds:cap.kinds.map(k=>({...k,send:false}))}},snapshot,async()=>{});expect(changedResult.offerDigest).not.toBe(result.offerDigest);
});
test('valid future peer book capabilities do not block inherited S2 kinds or migrate books',()=>{
 const future={...cap,kinds:[{kind:'bookState' as const,schemaVersion:1 as const,send:true,receive:true},...cap.kinds]};
 expect(negotiate(cap,future)!.kinds).toEqual(selection.kinds);const routes=routeScopes(true,'B2',[{domain:'book',kind:'bookState',direction:'phoneToWatch',v1Available:true}],cap,future);expect(routes[0]!.protocol).toBe('v1');
});
test('begin is bound to persisted prepare scope, both snapshots, direction, selection and job',async()=>{
 const p=new Preparation(cap),b=begin([object('rssSource')]),offer={step:'offer',accountScope:b.payload.accountScope,phoneDeviceId:b.payload.phoneDeviceId,watchDeviceId:b.payload.watchDeviceId,phoneCapabilities:cap,phoneSnapshot:b.payload.phoneSnapshot,watchSnapshot:null};
 const result=await p.offerRequest('a'.repeat(32),offer,b.payload.watchSnapshot,async()=>{}),bs=[{direction:'phoneToWatch' as const,jobId:binding.jobId,intent:'create' as const,selection:b.payload.selection}];
 await p.confirmRequest({step:'confirm',offerRequestId:'a'.repeat(32),bindings:bs,preparationDigest:preparationDigest(String(result.offerDigest),bs)},async()=>{});
 const {request}=await import('./helpers'),r=request('begin',b.payload as any,{planDigest:b.plan});expect(()=>p.authorizeBegin(r)).toThrow('AUTH_REVOKED');p.confirmResponseFullyWritten();expect(p.authorizeBegin(r)).toEqual(b.payload);
 const changed=request('begin',{...b.payload,phoneDeviceId:'another-phone'} as any,{planDigest:b.plan});expect(()=>p.authorizeBegin(changed)).toThrow('PLAN_CONFLICT');
});

test('S3 create takes the current intersection and resume can keep the frozen S2 window',()=>{
 const s3=binaryCapability(cap.kinds,{...cap.limits,maxInFlightChunks:8,maxInFlightBytes:524288});
 const selection=negotiate(s3,s3)!;
 const s2=negotiate(cap,s3)!;
 const bind={jobId:'1'.repeat(32),direction:'phoneToWatch' as const,intent:'create' as const,selection};
 expect(()=>checkSelectedLimits(bind,s3,s3)).not.toThrow();
 expect(()=>checkSelectedLimits({...bind,selection:s2},s3,s3)).toThrow('CAPABILITY_MISMATCH');
 expect(()=>checkSelectedLimits({...bind,intent:'resume',selection:s2},s3,s3)).not.toThrow();
 expect(()=>checkSelectedLimits({...bind,intent:'resume'},cap,s3)).toThrow('CAPABILITY_MISMATCH');
});
