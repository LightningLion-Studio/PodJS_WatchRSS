import {test,expect} from 'bun:test';
import cases from '../fixtures/library-binary/planning-heartbeat-cases.json';
import {RecoveryRules,WorkTimers,NetworkWait} from '../../src/sync/library-binary/recovery';
import {planningHeartbeat} from '../../src/sync/library-binary/state';
import {request,reply} from './helpers';
test('search failure rule stops the third round, Ready clears only that counter',()=>{
 const r=new RecoveryRules();expect(r.recoveryRoundFailed()).toBe(true);expect(r.recoveryRoundFailed()).toBe(true);r.accountReady('c',false);expect(r.snapshot.searchFailures).toBe(0);r.recoveryRoundFailed();r.recoveryRoundFailed();expect(r.recoveryRoundFailed()).toBe(false);expect(r.snapshot.stopped).toBe(true);
});
for(const third of [10000,10001])test('3 physical disconnects inclusive 10s boundary '+third,()=>{
 const r=new RecoveryRules();[0,5000,third].forEach((at,i)=>{r.accountReady('c'+i,false);expect(r.ioFailure('c'+i,at,'EOF')).toBe(i<2||third===10001);});expect(r.snapshot.stopped).toBe(third===10000);
});
test('third reconnect Ready interval without new semantic progress stops; initial interval excluded',()=>{
 const r=new RecoveryRules();r.accountReady('initial',false);r.ioFailure('initial',0,'EOF');expect(r.snapshot.noProgress).toBe(0);
 for(let i=1;i<=3;i++){r.accountReady('c'+i,true);expect(r.ioFailure('c'+i,i*20000,'SocketTimeout')).toBe(i<3);}expect(r.snapshot.noProgress).toBe(3);
});
test('new metadata APPLIED is progress, replan and re-download cannot manufacture progress',()=>{
 const r=new RecoveryRules();r.accountReady('a',true);expect(r.confirm('APPLIED','metadata:clock:42')).toBe(true);r.ioFailure('a',0,'EOF');expect(r.snapshot.noProgress).toBe(0);
 r.accountReady('b',true);expect(r.confirm('APPLIED','metadata:clock:42')).toBe(false);expect(r.confirm('STAGED','content:hash:0')).toBe(true);r.ioFailure('b',20000,'EOF');expect(r.snapshot.noProgress).toBe(0);
 r.accountReady('new-job',true);expect(r.confirm('STAGED','content:hash:0')).toBe(false);r.ioFailure('new-job',40000,'EOF');expect(r.snapshot.noProgress).toBe(1);
});
test('one physical failure counted once; stale callbacks and route handoff do not reset logical counters',()=>{
 const r=new RecoveryRules();r.accountReady('a',true);r.ioFailure('a',0,'EOF');expect(r.ioFailure('a',1,'reset')).toBe(false);expect(r.snapshot.disconnects).toEqual([0]);
 r.accountReady('b',true);r.detach('b');expect(r.ioFailure('b',1000,'closed')).toBe(false);r.accountReady('c',true);expect(r.snapshot.noProgress).toBe(1);expect(r.ioFailure('old',1000,'EOF')).toBe(false);expect(r.snapshot.disconnects).toEqual([0]);
});
for(const c of cases.cases)test('frozen PLANNING contract '+c.id+' '+c.name,()=>{
 const timer=new WorkTimers(0),rules=new RecoveryRules();rules.accountReady('c',true);let sender='WAIT_REMOTE_WORK',receiver='WORKING',recoveryEvents=0,completedReplies=0,heartbeatTimeoutAtMs:number|null=null,localStopAtMs:number|null=null,pending:ReturnType<typeof request>|null=null,replyDue:number|null=null;
 for(let now=0;now<=c.durationMs;now+=50){
  if(sender==='STOP'||sender==='IO_RECOVERY')break;
  if(!c.receiverPaused){if(c.workEveryMs&&now&&now%c.workEveryMs===0)timer.localWorkUnit(now);if(timer.localStalled(now)){receiver='LOCAL_IO_STOP';localStopAtMs=now;rules.stop();sender='STOP';continue;}}
  if(replyDue!==null&&now>=replyDue&&pending){const body=planningHeartbeat(pending,{authenticated:true,beginAuthorized:true,admitted:false,state:'PLANNING',nextManifestPage:1,expiresAtMillis:30000});expect(timer.heartbeatReply(reply(pending,body),now)).toBe(true);completedReplies++;pending=null;replyDue=null;}
  if(timer.heartbeatExpired(now)){sender='IO_RECOVERY';recoveryEvents++;heartbeatTimeoutAtMs=now;rules.ioFailure('c',now,'SocketTimeout');break;}
  if(timer.heartbeatDue(now,true,true)){pending=request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0});timer.heartbeatWriteStarted(pending,now);if(!c.receiverPaused&&!c.networkBlackhole)replyDue=now+50;}
 }
 const result={sender,receiver,recoveryEvents,completedReplies,heartbeatTimeoutAtMs,localStopAtMs};for(const [k,v] of Object.entries(c.expected))expect(result[k as keyof typeof result]).toBe(v);
});
test('heartbeat deadline includes write blocking; noise and duplicate/wrong-bound replies never extend it',()=>{
 const t=new WorkTimers(0),h=request('missing',{afterObjectId:null,afterChunkIndex:null,limit:0});t.heartbeatWriteStarted(h,10000);
 const body={state:'PLANNING',nextManifestPage:0,expiresAtMillis:30000,items:[],next:null,done:true,completion:null};
 expect(t.heartbeatReply({...reply(h,body),epoch:2},39000)).toBe(false);expect(t.heartbeatDue(39000,true,true)).toBe(false);expect(t.heartbeatExpired(39999)).toBe(false);expect(t.heartbeatExpired(40000)).toBe(true);
 expect(()=>t.heartbeatReply(reply(h,body),40000)).toThrow('SocketTimeout');
});
test('unbegun job has no heartbeat exemption; half-frame absolute deadline survives byte activity',()=>{
 const t=new WorkTimers(0);expect(t.heartbeatDue(30000,true,false)).toBe(false);const n=new NetworkWait(0);expect(n.expired(30000)).toBe(true);
 n.wait('WAIT_REMOTE_WORK',0);expect(n.expired(45000)).toBe(false);n.validBytes(0,false);n.validBytes(59000,false);expect(n.expired(60000)).toBe(true);
 const local=new NetworkWait(0);local.wait('WAIT_LOCAL',0);expect(local.expired(45000)).toBe(false);
});
test('new semantic progress resets no-progress immediately and survives proactive handoff',()=>{
 const r=new RecoveryRules();for(let i=0;i<2;i++){r.accountReady('empty'+i,true);r.ioFailure('empty'+i,i*20000,'EOF');}expect(r.snapshot.noProgress).toBe(2);
 r.accountReady('progress',true);r.confirm('APPLIED','rssSource:clock:1');expect(r.snapshot.noProgress).toBe(0);r.detach('progress');r.accountReady('next-route',true);expect(r.ioFailure('next-route',60000,'EOF')).toBe(true);expect(r.snapshot.noProgress).toBe(1);
});
