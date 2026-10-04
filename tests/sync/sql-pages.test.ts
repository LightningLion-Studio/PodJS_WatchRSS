import {expect,test} from 'bun:test';
import {querySyncPages} from '../../src/sync/sql-pages.ts';

test('paged SQL retries an oversized host response without skipping or duplicating rows',async()=>{
  const values=Array.from({length:11},(_,id)=>({id})),requested:number[]=[];
  const db={query:async(_sql:string,params?:unknown[])=>{
    const size=Number(params?.[0]),offset=Number(params?.[1]);requested.push(size);
    if(size>3)throw Error('Query result too large; use paging');
    return values.slice(offset,offset+size);
  }};
  expect(await querySyncPages(db as never,'SELECT id FROM articles ORDER BY id',[],8)).toEqual(values);
  expect(requested.slice(0,3)).toEqual([8,4,2]);
});

test('paged SQL does not conceal an unrelated query error',async()=>{
  await expect(querySyncPages({query:async()=>{throw Error('no such table');}} as never,'SELECT * FROM missing',[],100)).rejects.toThrow('no such table');
});
