import {test,expect} from 'bun:test';
import {BinaryConnection} from '../../src/sync/library-binary/connection';
import {SwitchGate} from '../../src/sync/library-binary/routing';
import {Grant} from '../../src/sync/library-binary/state';
import {capabilityDigest} from '../../src/sync/library-binary/digests';
import {data,cap,fixed} from './helpers';
import {decodeFrame,type ByteTransport,type AckFrame} from '../../src/sync/library-binary/codec';
function gate(){const g=new SwitchGate(true,cap);g.accept({action:'syncLibraryBinary',version:2,phase:'switch',type:'request',requestId:'0'.repeat(32),payload:{codec:'lb2',watchCapabilityDigest:capabilityDigest(cap)}},{identityVerified:true,accountConfirmed:true,legacyAcksDrained:true});g.responseFullyWritten();return g;}
test('default-off blocks both binary send/receive without touching transport',()=>{
 let calls=0;const io:ByteTransport={readFrame:async()=>{calls++;return new Uint8Array();},writeFrame:async()=>{calls++;},close:()=>calls++};expect(()=>new BinaryConnection(new SwitchGate(false,cap),io,new Grant('c',1),()=>0)).toThrow();expect(calls).toBe(0);
});
test('one writer preserves complete frames and picks durable ACK before queued DATA',async()=>{
 let release!:()=>void;const writes:Uint8Array[]=[],io:ByteTransport={readFrame:async()=>new Uint8Array(),writeFrame:async b=>{writes.push(b);if(writes.length===1)await new Promise<void>(r=>release=r);},close:()=>{}};
 const connection=new BinaryConnection(gate(),io,new Grant('c',1),()=>0),first=connection.write(data()),second=connection.write({...data(),txSeq:2});
 const ack=decodeFrame(Buffer.from(fixed.ackHex,'hex')) as AckFrame,third=connection.write(ack);expect(writes.length).toBe(1);release();await Promise.all([first,second,third]);expect(writes.map(x=>x[8])).toEqual([2,3,2]);connection.close();
});
test('malformed frame fences connection; read cannot fall back to legacy',async()=>{
 let closes=0;const io:ByteTransport={readFrame:async()=>new Uint8Array([0,0,0,1,0]),writeFrame:async()=>{},close:()=>closes++},grant=new Grant('c',1),token=grant.token(),connection=new BinaryConnection(gate(),io,grant,()=>0);
 await expect(connection.read()).rejects.toThrow();expect(closes).toBe(1);expect(()=>grant.check(token)).toThrow('AUTH_REVOKED');expect(()=>connection.write(data())).toThrow('AUTH_REVOKED');
});
test('fence suppresses late read result from old transport',async()=>{
 let release!:(b:Uint8Array)=>void;const connection=new BinaryConnection(gate(),{readFrame:()=>new Promise(r=>release=r),writeFrame:async()=>{},close:()=>{}},new Grant('old',1),()=>0);const p=connection.read();connection.close();release(Buffer.from(fixed.dataHex,'hex'));await expect(p).rejects.toThrow('AUTH_REVOKED');
});
