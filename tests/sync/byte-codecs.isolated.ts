import {expect,test} from 'bun:test';
import {differential} from '../../scripts/bench/byte-codecs-differential.ts';
test('production default byte paths match frozen loops on random, boundary, malformed and sync inputs',async()=>{
 expect(await differential()).toBeGreaterThan(12000);
});
