import {test,expect} from 'bun:test';
import {backgroundMediaWork,backgroundResult} from '../src/media/background-work.ts';
test('route suspension cancels its in-flight host request exactly once',async()=>{
 const work=backgroundMediaWork();let cancellations=0,reject!:(error:Error)=>void;
 const result=backgroundResult({result:new Promise((_,r)=>reject=r),cancel(){cancellations++;reject(Error('cancelled'));}},work);
 work.cancel();work.cancel();await expect(result).rejects.toThrow('cancelled');expect(cancellations).toBe(1);expect(work.isCurrent()).toBe(false);
});
test('a completed request removes its cancellation subscription',async()=>{
 const work=backgroundMediaWork();let cancellations=0;
 expect(await backgroundResult({result:Promise.resolve(7),cancel(){cancellations++;}},work)).toBe(7);work.cancel();expect(cancellations).toBe(0);
});
test('a late request in an already-cancelled lifetime is cancelled immediately',async()=>{
 const work=backgroundMediaWork();work.cancel();let reject!:(error:Error)=>void;
 const result=backgroundResult({result:new Promise((_,r)=>reject=r),cancel(){reject(Error('cancelled'));}},work);await expect(result).rejects.toThrow('cancelled');
});
