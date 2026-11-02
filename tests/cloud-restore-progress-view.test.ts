import {expect,test} from 'bun:test';
import {restoreProgressView} from '../src/ui/cloud-sync-view.ts';
import {emptyRestoreProgress} from '../src/cloud/restore-progress.ts';

const ph=(done:number,total:number,doneBytes=0,totalBytes=0)=>({done,total,doneBytes,totalBytes});
test('restore progress: hidden until the denominator is fixed and after every head is acknowledged',()=>{
  expect(restoreProgressView(undefined)).toBeUndefined();
  expect(restoreProgressView(emptyRestoreProgress())).toBeUndefined();
  const done={...emptyRestoreProgress(),ready:true,headsTotal:2,headsDone:2,download:ph(1,1,10,10)};
  expect(restoreProgressView(done)).toBeUndefined();
});
test('restore progress: phases count equally, bytes win over items, never shows 100% early',()=>{
  const p={...emptyRestoreProgress(),ready:true,headsTotal:2,headsDone:0,download:ph(0,10,50,100),decompress:ph(5,10),apply:ph(0,0),projection:ph(10,10,0,0)};
  expect(restoreProgressView(p)!.progress).toEqual({label:'恢复云端资料 66%',fraction:2/3});
  const all={...p,download:ph(10,10,100,100),decompress:ph(10,10)};
  expect(restoreProgressView(all)!.progress.fraction).toBe(0.99);
});
