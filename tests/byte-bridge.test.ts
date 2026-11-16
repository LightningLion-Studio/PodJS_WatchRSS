import {test,expect} from 'bun:test';
import {HostSyncByteStream} from '../src/sync/rfcomm';
const op=<T>(value:T)=>({result:Promise.resolve(value),cancel(){}});
test('RFCOMM selects raw host IO without changing bytes or replaying a failed write',async()=>{
 const bytes=Uint8Array.from({length:65536},(_,i)=>i%256),written:Uint8Array[]=[];let reads=0,closed=0,legacy=0;
 const stream=new HostSyncByteStream('s',{
  read:()=>{legacy++;throw Error('legacy');},write:()=>{legacy++;throw Error('legacy');},close:async()=>{closed++;return {closed:true};},
  readBytes:()=>op({bytes:reads++?new Uint8Array():bytes,eof:reads>1}),writeBytes:(_,value)=>{written.push(value.slice());return op({written:value.length});},
 });
 expect(await stream.read(65536,1000)).toEqual(bytes);expect(await stream.read(65536,1000)).toBeNull();await stream.write(bytes);expect(written[0]).toEqual(bytes);expect(legacy).toBe(0);await stream.close();await stream.close();expect(closed).toBe(1);
 let fallback=0;const failed=new HostSyncByteStream('s',{read:()=>op({eof:true,dataBase64:''}),write:()=>{fallback++;return op({written:1});},close:async()=>({closed:true}),writeBytes:()=>({result:Promise.reject(Error('LOCAL_IO')),cancel(){}})});await expect(failed.write(new Uint8Array([1]))).rejects.toThrow('LOCAL_IO');expect(fallback).toBe(0);
});
test('legacy injected host ports remain byte-identical for existing phones',async()=>{
 const bytes=new Uint8Array([0,127,128,255]),writes:Uint8Array[]=[];const stream=new HostSyncByteStream('old',{read:()=>op({eof:false,dataBase64:'AH+A/w=='}),write:(_,value)=>{writes.push(value);return op({written:value.length});},close:async()=>({closed:true})});expect(await stream.read(4,1000)).toEqual(bytes);await stream.write(bytes);expect(writes[0]).toEqual(bytes);
});
