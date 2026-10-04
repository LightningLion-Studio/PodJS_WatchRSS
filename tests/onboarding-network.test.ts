import {test,expect} from 'bun:test';
import {internetAvailability,observeInternet,type NetworkSnapshot} from '../src/onboarding/network.ts';
const base:NetworkSnapshot={active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:false};
test('native internet classification prioritizes validated Wi-Fi/cellular over Bluetooth',()=>{
 for(const wifi of [false,true])for(const cellular of [false,true])for(const bluetooth of [false,true])for(const active of [false,true])for(const internet of [false,true])for(const validated of [false,true]){
  expect(internetAvailability({active,internet,validated,wifi,cellular,bluetooth})).toBe(!active||!internet||!validated?'unavailable':wifi||cellular?'available':bluetooth?'bluetooth':'unavailable');
 }
});
test('network change supersedes old snapshots and disposal stops delivery and observation',async()=>{
 let changed!:()=>void,unsubscribed=0;const pending:((v:NetworkSnapshot)=>void)[]=[],states:string[]=[];
 const stop=observeInternet({snapshot:()=>new Promise(resolve=>pending.push(resolve)),subscribe:listener=>{changed=listener;return ()=>{unsubscribed++;};}},state=>states.push(state));
 expect(states).toEqual(['checking']);changed();pending.shift()!({...base,wifi:true});await Promise.resolve();await Promise.resolve();expect(states).toEqual(['checking']);
 pending.shift()!({...base,bluetooth:true});await Promise.resolve();await Promise.resolve();expect(states).toEqual(['checking','bluetooth']);
 changed();stop();stop();pending.shift()!({...base,wifi:true});await Promise.resolve();await Promise.resolve();expect(states).toEqual(['checking','bluetooth']);expect(unsubscribed).toBe(1);
});
test('a failed snapshot reports unavailable and a later update recovers',async()=>{
 let changed!:()=>void,calls=0;const states:string[]=[];
 const stop=observeInternet({snapshot:async()=>{if(++calls===1)throw Error('network changed');return {...base,cellular:true};},subscribe:listener=>{changed=listener;return ()=>{};}},status=>states.push(status));
 await Promise.resolve();await Promise.resolve();expect(states).toEqual(['checking','unavailable']);changed();await Promise.resolve();await Promise.resolve();expect(states).toEqual(['checking','unavailable','available']);stop();
});
