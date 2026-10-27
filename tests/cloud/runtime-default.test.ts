import {test,expect} from 'bun:test';
import {createCloudRuntime} from '../../src/cloud/runtime';
import {enabled} from './k2-crypto';
test('production cloud runtime default construction is host-free and defines all option defaults',()=>{
 let calls=0;const runtime=createCloudRuntime(async()=>{calls++;throw Error('Unexpected factory IO');},async()=>{throw Error('Repository must stay lazy');},enabled);
 expect(runtime.service.status.phase).toBe('idle');expect(calls).toBe(0);
});
test('foreground diagnostic callback construction does not start network, storage or timers',()=>{
 let calls=0;const runtime=createCloudRuntime(async()=>{calls++;throw Error('Unexpected factory IO');},async()=>{throw Error('Repository must stay lazy');},enabled,undefined,undefined,undefined,{recordDiagnostic:()=>{calls++;}});
 expect(runtime.service.status.phase).toBe('idle');expect(calls).toBe(0);
});
