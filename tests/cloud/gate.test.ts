import {test,expect} from 'bun:test';
import {CloudGate} from '../../src/cloud/gate';
test('cloud admits real host metadata in release and debug, never missing or malformed identity',async()=>{
 for(const debugBuild of [false,true]){const g=new CloudGate();expect(()=>g.require()).toThrow();expect(await g.initialize(async()=>({debugBuild}))).toBe(true);expect(()=>g.require()).not.toThrow();}
 for(const value of [null,{}, {debugBuild:'false'}, {debugBuild:1}]){const g=new CloudGate();expect(await g.initialize(async()=>value as any)).toBe(false);expect(()=>g.require()).toThrow();}
 const failed=new CloudGate();expect(await failed.initialize(async()=>{throw Error('host unavailable');})).toBe(false);expect(()=>failed.require()).toThrow();
});
