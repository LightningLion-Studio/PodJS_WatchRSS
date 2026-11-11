import {expect,test} from 'bun:test';
import {MiniProgramPairing,type PairingPorts} from '../src/ui/mini-program-pairing';
const qr='wrss-pair:'+Buffer.from(JSON.stringify({sessionId:'s',deviceId:'d',installId:'i',secret:Buffer.alloc(32,9).toString('base64')})).toString('base64url');
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
for(const stage of ['receive','start'] as const)for(const cause of ['back','background'] as const)test(`ALERTWRV: ${cause} cancels ${stage} synchronously while close cannot progress`,async()=>{
 const cancelled:unknown[]=[],closes:unknown[]=[];let rejectPending!:(e:any)=>void;
 const ports:PairingPorts={available:()=>true,identity:async()=>({deviceId:'d',installId:'i'}),now:()=>0,after:()=>()=>{},handler:async()=>({handle:async()=>({})}),op:<T>(method:string,args:Record<string,unknown>)=>{
  const result=method==='provision.start'&&stage!=='start'?Promise.resolve({sessionId:'s',qr}):method==='provision.close'?(closes.push(args.reason),new Promise(()=>{})):new Promise((_,reject)=>{rejectPending=reject;});
  return{result:result as Promise<T>,cancel(reason?:string){cancelled.push(reason);rejectPending?.({code:'cancelled'});}};
 }};
 const pairing=new MiniProgramPairing(ports,()=>{});pairing.start();await settle();
 if(cause==='back')pairing.cancel();else pairing.setForeground(false);
 expect(cancelled).toEqual([cause==='back'?'user_back':'background']);
 await settle();pairing.dispose();expect(cancelled).toHaveLength(1);
});
