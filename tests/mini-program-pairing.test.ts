import {expect,test} from 'bun:test';
import {MiniProgramPairing,PAIRING_FINISH_GRACE_MS,type PairingPorts,type PairingState} from '../src/ui/mini-program-pairing.ts';
import {PairingRequestBus} from '../src/ui/pairing-request.ts';

const qr='wrss-pair:'+Buffer.from(JSON.stringify({sessionId:'s1',deviceId:'d',installId:'i',secret:Buffer.alloc(32,9).toString('base64')})).toString('base64url');
type Call={method:string;args:Record<string,unknown>;cancelled:boolean};
function host(options:{permission?:string;startError?:{code:string};existingCloud?:boolean}={}){
 const calls:Call[]=[],inbox:{resolve:(v:any)=>void;reject:(e:any)=>void}[]=[],timers:{ms:number;fn:()=>void;live:boolean}[]=[];
 const states:PairingState[]=[];let confirmLabel='',delivered=false,agreement:Promise<boolean>|undefined;
 const ports:PairingPorts={
  op:<T,>(method:string,args:Record<string,unknown>)=>{
   const call:Call={method,args,cancelled:false};calls.push(call);
   let result:Promise<any>;
   if(method==='provision.requestPermission')result=Promise.resolve(options.permission??'granted');
   else if(method==='provision.start')result=options.startError?Promise.reject(options.startError):Promise.resolve({qr,sessionId:'s1'});
   else if(method==='provision.receive')result=new Promise((resolve,reject)=>inbox.push({resolve,reject}));
   else result=Promise.resolve({ok:true});
   return {result:result as Promise<T>,cancel:()=>{call.cancelled=true;}};
  },
  available:()=>true,
  identity:async()=>({deviceId:'d',installId:'i'}),
  handler:async({confirm})=>({handle:async message=>{
   if(message.action==='prepare'){confirmLabel=message.phoneMasked;agreement=confirm(message.phoneMasked,'12345678');return {success:true};}
   if(message.action==='configure'){if(agreement&&!await agreement)throw Error('配对未确认');return {success:true,bound:true,cloudReady:!!options.existingCloud};}
   if(message.action==='key'){delivered=true;return {success:true,cloudReady:true};}
   if(message.action==='finish')return {success:true,cloudReady:delivered||!!options.existingCloud};
   throw Error('x');
  }}),
  now:()=>0,
  after:(ms,fn)=>{const timer={ms,fn,live:true};timers.push(timer);return ()=>{timer.live=false;};},
 };
 const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
 const deliver=async(message:Record<string,unknown>)=>{await settle();inbox.pop()!.resolve(message);await settle();};
 const fail=async(error:unknown)=>{await settle();inbox.pop()!.reject(error);await settle();};
 const fire=(ms:number)=>{for(const t of timers)if(t.live&&t.ms===ms){t.live=false;t.fn();}};
 return {ports,calls,states,deliver,fail,settle,fire,label:()=>confirmLabel,methods:()=>calls.map(c=>c.method),responses:()=>calls.filter(c=>c.method==='provision.respond').map(c=>c.args.result as Record<string,unknown>)};
}
const last=(h:{states:PairingState[]})=>h.states.at(-1)!;

test('manual pairing blocks remote UI requests through QR and finish grace, then releases after close',async()=>{
 const h=host(),bus=new PairingRequestBus(()=>0);bus.setForeground(true);bus.subscribe(()=>bus.consumePending());
 h.ports.acquirePairingActivity=()=>bus.acquireActivity();const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));
 p.start();expect(await bus.request({})).toBe(false);await h.settle();expect(last(h).kind).toBe('scan');expect(await bus.request({})).toBe(false);
 await h.deliver({action:'prepare',phoneMasked:'x',_sequence:0});p.confirmSas(true);await h.settle();
 await h.deliver({action:'configure',_sequence:1});await h.deliver({action:'key',_sequence:2});await h.deliver({action:'finish',_sequence:3});
 expect(last(h).kind).toBe('done');expect(await bus.request({})).toBe(false);
 h.fire(PAIRING_FINISH_GRACE_MS);await h.settle();expect(await bus.request({})).toBe(true);p.dispose();
});

test('cancel, background, failure and disposal release the pairing UI activity lease',async()=>{
 for(const reason of ['cancel','background','failure','dispose'] as const){
  const h=host(),bus=new PairingRequestBus(()=>0);bus.setForeground(true);bus.subscribe(()=>bus.consumePending());
  h.ports.acquirePairingActivity=()=>bus.acquireActivity();const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));p.start();await h.settle();
  expect(await bus.request({})).toBe(false);
  if(reason==='cancel')p.cancel();else if(reason==='background')p.setForeground(false);else if(reason==='failure')await h.fail({code:'provision_network'});else p.dispose();
  expect(await bus.request({})).toBe(true);p.dispose();
 }
});

test('internet pairing never asks for nearby permission and reaches cloud-ready only after receipts',async()=>{
 const h=host();const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));
 p.start();await h.settle();
 expect(h.methods()).not.toContain('provision.requestPermission');
 expect(h.calls.find(c=>c.method==='provision.start')!.args).toEqual({deviceId:'d',installId:'i',transport:'internet'});
 expect(last(h)).toMatchObject({kind:'scan',transport:'internet',qr});
 await h.deliver({action:'prepare',phoneMasked:'138****0000',_sequence:0});
 expect(last(h)).toEqual({kind:'confirm',account:'138****0000',sas:'12345678',phoneMaskedTrusted:false});
 p.confirmSas(true);await h.settle();
 expect(last(h).kind).toBe('confirm');
 await h.deliver({action:'configure',_sequence:1});expect(last(h)).toEqual({kind:'working',step:'cloud'});
 await h.deliver({action:'key',_sequence:2});
 expect(h.states.some(s=>s.kind==='done')).toBe(false);
 await h.deliver({action:'finish',_sequence:3});expect(last(h)).toEqual({kind:'done',cloudReady:true});
 expect(h.calls.filter(c=>c.method==='provision.respond').map(c=>c.args.sessionId)).toEqual(['s1','s1','s1','s1']);
 expect(h.methods()).not.toContain('provision.close');
 h.fire(PAIRING_FINISH_GRACE_MS);await h.settle();
 expect(h.calls.find(c=>c.method==='provision.close')!.args).toEqual({sessionId:'s1'});
 expect(last(h)).toEqual({kind:'done',cloudReady:true});
});

test('legacy bluetooth hint is coerced to internet without requesting permission',async()=>{
 const h=host({permission:'denied'});const p=new MiniProgramPairing(h.ports,s=>h.states.push(s),'bluetooth');
 p.start();await h.settle();
 expect(h.methods()).not.toContain('provision.requestPermission');
 expect(h.calls.find(c=>c.method==='provision.start')!.args.transport).toBe('internet');
 expect(last(h)).toMatchObject({kind:'scan',transport:'internet'});
});

test('declining on the watch answers the phone, closes the owned session and changes nothing',async()=>{
 const h=host();const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));
 p.start();await h.deliver({action:'prepare',phoneMasked:'138****0000',_sequence:0});
 p.decline();await h.settle();
 expect(h.responses()).toEqual([{success:true}]);
 expect(last(h)).toEqual({kind:'cancelled'});
 expect(h.calls.find(c=>c.method==='provision.close')!.args).toEqual({sessionId:'s1'});
});

test('confirmation timeout is reported distinctly',async()=>{
 const h=host();const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));
 p.start();await h.deliver({action:'prepare',phoneMasked:'x',_sequence:0});
 h.fire(90_000);await h.settle();
 expect(last(h)).toMatchObject({kind:'failed',title:'等待确认超时'});
});

test('a disconnect after the account is saved keeps the true partial success',async()=>{
 const h=host();const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));
 p.start();await h.deliver({action:'prepare',phoneMasked:'x',_sequence:0});p.confirmSas(true);
 await h.deliver({action:'configure',_sequence:1});
 await h.fail(Object.assign(Error('closed'),{code:'provision_closed'}));
 expect(last(h)).toEqual({kind:'done',cloudReady:false});
});

test('offline watch offers network retry without Bluetooth fallback',async()=>{
 const h=host({startError:{code:'provision_offline'}});const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));
 p.start();await h.settle();
 expect(last(h)).toMatchObject({kind:'failed',title:'手表没连上网络',suggestOther:false});
 p.start();await h.settle();
 expect(p.transport).toBe('internet');
 expect(h.methods()).not.toContain('provision.requestPermission');
});

test('leaving the page pauses, cancels the pending receive and closes the session',async()=>{
 const h=host();const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));
 p.start();await h.settle();
 p.setForeground(false);await h.settle();
 expect(last(h)).toEqual({kind:'paused'});
 expect(h.calls.find(c=>c.method==='provision.receive')!.cancelled).toBe(true);
 expect(h.calls.find(c=>c.method==='provision.close')!.args).toEqual({sessionId:'s1'});
 p.start();await h.settle();expect(last(h)).toEqual({kind:'paused'});
 p.setForeground(true);p.start();await h.settle();expect(last(h)).toMatchObject({kind:'scan'});
});

test('cancel before anything happened closes the page; cancel mid-setup keeps the outcome visible',async()=>{
 const h=host();const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));
 p.start();await h.settle();expect(p.cancel()).toBe(true);
 p.start();await h.deliver({action:'prepare',phoneMasked:'x',_sequence:0});p.confirmSas(true);await h.settle();
 expect(p.cancel()).toBe(false);expect(last(h)).toEqual({kind:'cancelled'});
});

test('finish displays previously persisted authorization even without key delivery this session',async()=>{
 const h=host({existingCloud:true});const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));p.start();await h.deliver({action:'configure',_sequence:0});await h.deliver({action:'finish',_sequence:1});expect(last(h)).toEqual({kind:'done',cloudReady:true});
});

test('legacy account-only positive action cannot assert SAS agreement; the dedicated callback is required',async()=>{
 const h=host(),p=new MiniProgramPairing(h.ports,s=>h.states.push(s));p.start();await h.deliver({action:'prepare',phoneMasked:'unverified',_sequence:0});expect(p.confirm()).toBe(false);expect(last(h).kind).toBe('confirm');expect(h.responses()).toHaveLength(1);expect(p.confirmSas(true)).toBe(true);await h.settle();expect(h.responses()).toHaveLength(1);
});
test('QR context belongs to the live identity and its secret is cleared when the run ends',async()=>{
 const h=host();let secret:Uint8Array|undefined;const make=h.ports.handler;h.ports.handler=async ports=>{secret=ports.pairing.secret;expect(ports.pairing.sessionId).toBe('s1');return make(ports);};const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));p.start();await h.settle();expect(secret?.length).toBe(32);p.dispose();expect(secret?.every(b=>b===0)).toBe(true);
 const {pairingContext}=await import('../src/ui/mini-program-pairing');expect(()=>pairingContext(qr,'wrong','d','i')).toThrow('invalid_pairing_context');
});


test('finish uses fresh verified readiness rather than a stale earlier key receipt',async()=>{
 const h=host(),create=h.ports.handler;h.ports.handler=async ports=>{const handler=await create(ports);return{handle:async message=>message.action==='finish'?{success:true,cloudReady:false}:handler.handle(message)};};const p=new MiniProgramPairing(h.ports,s=>h.states.push(s));p.start();await h.deliver({action:'configure',_sequence:0});await h.deliver({action:'key',_sequence:1});await h.deliver({action:'finish',_sequence:2});expect(last(h)).toEqual({kind:'done',cloudReady:false});
});
test('pairing exposes upgrade and own-key conflict states without leaking raw service errors',async()=>{
 const {pairingFailure}=await import('../src/ui/mini-program-pairing');expect(pairingFailure(Error('client_upgrade_required'),'internet',true)).toMatchObject({needsUpgrade:true,title:'请升级腕上RSS'});expect(pairingFailure(Error('device_key_conflict'),'internet',true)).toMatchObject({needsReregistration:true,title:'需要重新登记本机'});
});
