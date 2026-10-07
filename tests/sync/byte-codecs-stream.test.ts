import {expect,test} from 'bun:test';
import {StreamFrameConnection} from '../../src/sync/stream.ts';
test('production default transport closes a large encoding job before publishing any frame bytes',async()=>{
 const writes:Uint8Array[]=[],connection=new StreamFrameConnection({read:async()=>null,write:async bytes=>{writes.push(bytes);},close:async()=>{}});
 const operation=connection.writeFrame({body:'同步🙂'.repeat(50000)});
 const result=operation.then(()=>null,error=>error);
 await connection.close();expect(await result).toEqual(new Error('byte codec cancelled'));expect(writes).toHaveLength(0);
});
