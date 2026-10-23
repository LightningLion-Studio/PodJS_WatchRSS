import {test,expect} from 'bun:test';
import {createHmac} from 'node:crypto';
import {WatchSetupHandler,type SetupPorts} from '../src/onboarding/watch-setup';
import {MiniProgramPairing,PAIRING_CONFIRM_MS,PAIRING_REJECT_GRACE_MS,type PairingPorts,type PairingState} from '../src/ui/mini-program-pairing';
import fixture from './cloud/fixtures/setup-shape.json';
const [prepare,configure]=fixture.exchanges.map(e=>e.request);
const deferred=<T=void>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};
function setup(){
 const states:PairingState[]=[],events:string[]=[],responses:{sequence:number;result:any}[]=[],timers:{ms:number;fn:()=>void;live:boolean}[]=[];
 let receiver:{resolve(v:any):void;reject(e:unknown):void}|undefined,closed=false,phoneClosed=false,confirmationChecks=0,now=fixture.now,sessionSecret:Uint8Array|undefined;
 const qr='wrss-pair:'+Buffer.from(JSON.stringify({sessionId:fixture.pairing.sessionId,deviceId:fixture.deviceId,installId:fixture.installId,secret:fixture.pairing.secretBase64})).toString('base64url');
 const business:Pick<SetupPorts,'saveAccount'|'registerSelf'|'readAccount'|'verifiedReady'|'now'>={readAccount:async()=>null,saveAccount:async()=>{events.push('save');},registerSelf:async()=>{events.push('register');},verifiedReady:async()=>false,now:()=>now};
 let captureNextProbe=false;
 let checkGate:ReturnType<typeof deferred>|undefined,responseGate:ReturnType<typeof deferred>|undefined;
 const ports:PairingPorts={available:()=>true,identity:async()=>({deviceId:fixture.deviceId,installId:fixture.installId}),now:()=>now,after:(ms,fn)=>{const timer={ms,fn,live:true};timers.push(timer);return()=>{timer.live=false;};},op:<T>(method:string,args:Record<string,unknown>)=>{
  let reject:(e:unknown)=>void=()=>{};const result=(async()=>{
   if(method==='provision.start')return{qr,sessionId:fixture.pairing.sessionId};
   if(method==='provision.close'){closed=true;receiver?.reject({code:'provision_closed'});receiver=undefined;return{};}
   if(method==='provision.check'){confirmationChecks++;const snapshot=captureNextProbe,wasClosed=phoneClosed||closed;captureNextProbe=false;await checkGate?.promise;if(snapshot?wasClosed:phoneClosed||closed)throw{code:'provision_closed'};return{active:true};}
   if(method==='provision.receive'){if(phoneClosed||closed)throw{code:'provision_closed'};return new Promise((resolve,no)=>{reject=no;receiver={resolve,reject:no};});}
   if(method==='provision.respond'){await responseGate?.promise;if(phoneClosed||closed)throw{code:'provision_closed'};responses.push({sequence:args.sequence as number,result:args.result});return{sent:true};}
   throw Error(method);
  })();return{result:result as Promise<T>,cancel:()=>reject({code:'provision_closed'})};
 },handler:async({active,checkSession,confirm,pairing})=>{sessionSecret=pairing.secret;return new WatchSetupHandler({deviceId:fixture.deviceId,installId:fixture.installId,active,checkSession,confirm,pairing,...business,readAccount:()=>business.readAccount(),saveAccount:state=>business.saveAccount(state),registerSelf:state=>business.registerSelf(state),verifiedReady:user=>business.verifiedReady(user),crypto:{hmac:async(k,b)=>createHmac('sha256',k).update(b).digest('hex')},publicKey:async()=>fixture.exchanges[0].response.publicKeySpki!,currentKeyVersion:async()=>0,trust:async()=>fixture.trust,acceptDelivery:async()=>{events.push('key');},parseBackend:async()=>({valid:true,scheme:'https',host:'sly-data-plane.watchrss.cn'})});}};
 const pairing=new MiniProgramPairing(ports,s=>states.push(s));
 const settle=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
 const deliver=async(message:any,sequence:number)=>{await settle();expect(receiver).toBeDefined();const receive=receiver!;receiver=undefined;receive.resolve({...message,_sequence:sequence});await settle();};
 const fire=async(ms:number)=>{for(const timer of [...timers])if(timer.live&&timer.ms===ms){timer.live=false;timer.fn();}await settle();};
 const queuedTimeout=()=>timers.find(t=>t.ms===PAIRING_CONFIRM_MS)!.fn;
 const closePhone=()=>{phoneClosed=true;receiver?.reject({code:'provision_closed'});receiver=undefined;};
 return{pairing,states,events,responses,business,captureNextProbe:()=>{captureNextProbe=true;},settle,deliver,fire,closePhone,queuedTimeout,checkGate:()=>checkGate=deferred(),responseGate:()=>responseGate=deferred(),setNow:(n:number)=>{now=n;},closed:()=>closed,checks:()=>confirmationChecks,secretCleared:()=>sessionSecret?.every(b=>b===0),state:()=>states.at(-1)!};
}
async function prepared(){const f=setup();f.pairing.start();await f.deliver(prepare,0);expect(f.responses).toEqual([{sequence:0,result:fixture.exchanges[0].response}]);expect(f.state()).toMatchObject({kind:'confirm',phoneMaskedTrusted:false});expect(f.events).toEqual([]);return f;}
test('R43 prepare replies with public identity immediately while SAS is still awaiting consent',async()=>{
 const f=await prepared();expect(Object.keys(f.responses[0].result).sort()).toEqual(['deviceId','installId','publicKeySpki','success','userId']);expect(f.responses[0].result).not.toHaveProperty('secret');expect(f.responses[0].result).not.toHaveProperty('sas');expect(f.responses[0].result).not.toHaveProperty('watchAccessToken');f.pairing.dispose();
});
test('R43 phone first: configure is held with SAS visible, then save and R28 registration precede bound',async()=>{
 const f=await prepared(),gate=deferred();f.business.registerSelf=async()=>{f.events.push('register');await gate.promise;};
 await f.deliver(configure,1);expect(f.responses).toHaveLength(1);expect(f.events).toEqual([]);expect(f.state().kind).toBe('confirm');await f.fire(1000);expect(f.checks()).toBe(1);expect(f.events).toEqual([]);
 expect(f.pairing.confirmSas(true)).toBe(true);await f.settle();expect(f.events).toEqual(['save','register']);expect(f.responses).toHaveLength(1);gate.resolve();await f.settle();expect(f.responses[1]).toEqual({sequence:1,result:fixture.exchanges[1].response});f.pairing.dispose();
});
test('R43 watch first: agreement keeps SAS visible and writes nothing until the scanner sends configure',async()=>{
 const f=await prepared();expect(f.pairing.confirmSas(true)).toBe(true);await f.settle();expect(f.state().kind).toBe('confirm');expect(f.events).toEqual([]);expect(f.responses).toHaveLength(1);await f.deliver(configure,1);expect(f.events).toEqual(['save','register']);expect(f.responses[1].result.bound).toBe(true);f.pairing.dispose();
});
for(const pending of [false,true])test(`R43 watch mismatch ${pending?'with held configure':'before configure'} closes without account/key writes`,async()=>{
 const f=await prepared();if(pending)await f.deliver(configure,1);expect(f.pairing.confirmSas(false)).toBe(true);await f.settle();expect(f.state().kind).toBe('cancelled');expect(f.closed()).toBe(true);expect(f.events).toEqual([]);expect(f.secretCleared()).toBe(true);if(pending)expect(f.responses[1]).toMatchObject({sequence:1,result:{success:false}});else expect(f.responses).toHaveLength(1);
});
for(const pending of [false,true])test(`R43 confirmation timeout ${pending?'with held configure':'before configure'} ends the session and late agreement does nothing`,async()=>{
 const f=await prepared();if(pending)await f.deliver(configure,1);await f.fire(PAIRING_CONFIRM_MS);expect(f.state()).toMatchObject({kind:'failed',title:'等待确认超时'});expect(f.events).toEqual([]);expect(f.closed()).toBe(true);expect(f.pairing.confirmSas(true)).toBe(false);if(pending)expect(f.responses[1].result.success).toBe(false);
});
for(const pending of [false,true])test(`R43 phone mismatch/relay close ${pending?'while configure waits':'before configure'} prevents late watch agreement from binding`,async()=>{
 const f=await prepared();if(pending)await f.deliver(configure,1);f.closePhone();if(pending)await f.fire(1000);else await f.settle();expect(f.closed()).toBe(true);expect(f.events).toEqual([]);expect(f.pairing.confirmSas(true)).toBe(false);expect(f.secretCleared()).toBe(true);
});
test('R43 watch-first agreement can still be declined before configure arrives',async()=>{
 const f=await prepared();f.pairing.confirmSas(true);expect(f.state().kind).toBe('confirm');expect(f.pairing.confirmSas(false)).toBe(true);await f.settle();expect(f.closed()).toBe(true);expect(f.events).toEqual([]);
});
test('R43 phone closes while the final session check is pending: no account is saved',async()=>{
 const f=await prepared(),check=f.checkGate();await f.deliver(configure,1);f.pairing.confirmSas(true);await f.settle();expect(f.checks()).toBe(1);f.closePhone();check.resolve(undefined);await f.settle();expect(f.closed()).toBe(true);expect(f.events).toEqual([]);expect(f.responses).toHaveLength(1);
});
test('R43 local cancellation during the final session check cannot save an account',async()=>{
 const f=await prepared(),check=f.checkGate();await f.deliver(configure,1);f.pairing.confirmSas(true);await f.settle();f.pairing.cancel();check.resolve(undefined);await f.settle();expect(f.events).toEqual([]);expect(f.closed()).toBe(true);
});
test('R43 credentials that expire while the configure waits are rejected before saving',async()=>{
 const f=await prepared();await f.deliver(configure,1);f.setNow(fixture.exchanges[1].request.account!.accessTokenExpiresAt!+1);f.pairing.confirmSas(true);await f.settle();expect(f.events).toEqual([]);expect(f.responses[1].result.success).toBe(false);f.pairing.dispose();
});

for(const timeout of [false,true])test(`R43 ${timeout?'timeout':'mismatch'} still closes if its rejection receipt stalls`,async()=>{
 const f=await prepared();await f.deliver(configure,1);const response=f.responseGate();
 if(timeout)await f.fire(PAIRING_CONFIRM_MS);else{f.pairing.confirmSas(false);await f.settle();}
 expect(f.closed()).toBe(false);expect(f.events).toEqual([]);await f.fire(PAIRING_REJECT_GRACE_MS);
 expect(f.closed()).toBe(true);expect(f.state().kind).toBe(timeout?'failed':'cancelled');expect(f.secretCleared()).toBe(true);
 response.resolve(undefined);await f.settle();expect(f.events).toEqual([]);expect(f.responses).toHaveLength(1);
});

test('R43 an already queued old timeout cannot override agreement or prevent a later mismatch before configure',async()=>{
 const f=await prepared(),queued=f.queuedTimeout();f.pairing.confirmSas(true);queued();
 expect(f.pairing.confirmSas(false)).toBe(true);await f.settle();expect(f.closed()).toBe(true);expect(f.events).toEqual([]);
});

test('R43 a delayed monitor 200 from before phone mismatch cannot authorize saving after watch agreement',async()=>{
 const f=await prepared(),probe=f.checkGate();await f.deliver(configure,1);f.captureNextProbe();await f.fire(1000);expect(f.checks()).toBe(1);
 f.closePhone();f.pairing.confirmSas(true);probe.resolve(undefined);await f.settle();
 expect(f.checks()).toBe(2);expect(f.events).toEqual([]);expect(f.closed()).toBe(true);expect(f.responses).toHaveLength(1);
});
