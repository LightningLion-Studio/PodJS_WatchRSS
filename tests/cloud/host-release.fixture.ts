import {expect} from 'bun:test';
import {__pumpPodEvents} from '@podjs/framework/watch';
import {createHostCloudFoundation} from '../../src/cloud/host';
async function verify(){
 const previous=(globalThis as {pod?:unknown}).pod;const commands:any[]=[];let batch:string|undefined;
 (globalThis as any).pod={capabilities:()=> '["host.lifecycle","crypto.basic","data.secure","data.files.chunks"]',emit:(line:string)=>{commands.push(JSON.parse(line));},takeEvents:()=>{const value=batch;batch=undefined;return value;}};
 try{
  const foundation=createHostCloudFoundation('user','device',{request:async()=>{throw Error('network forbidden');}},{baseUrl:'https://fixture.invalid',accessToken:'fixture'});
  await Promise.resolve();await Promise.resolve();expect(commands).toHaveLength(1);expect(commands[0].method).toBe('app.buildInfo');
  batch=JSON.stringify([{t:'service.result',id:commands[0].id,ok:true,value:{debugBuild:false}}]);__pumpPodEvents();
  expect(await foundation).toBeUndefined();expect(commands).toHaveLength(1);
 }finally{(globalThis as {pod?:unknown}).pod=previous;}
}
await verify();

