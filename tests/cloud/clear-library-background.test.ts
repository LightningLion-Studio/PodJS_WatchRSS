import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {initializeSchema} from '../../src/core/schema';
import type {SqlDatabase} from '../../src/core/types';
import {createBackgroundLibrary} from '../../src/cloud/background-library';
import {cloudFormatFailure} from '../../src/cloud/format-diagnostic';
import {recordFailureDiagnostic} from '../../src/cloud/record-diagnostic';
test('headless cloud refuses a committed clear intent before any content or key IO, with a fixed suspended category',async()=>{
 const sql=new Database(':memory:');
 try{
  const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[]);},transaction:async ss=>sql.transaction(()=>{for(const s of ss)sql.query(s.sql).run(...(s.params??[]) as any[]);})()};
  await initializeSchema(db,{seedBuiltinChannels:false});
  await db.execute('INSERT INTO library_clear_journal VALUES(1,0,?)',[JSON.stringify({itemIds:[],channels:[],bookPaths:[]})]);
  let unexpected=0;
  const host=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{
   if(method==='sql.query')return await db.query(String(args.sql),args.params as unknown[]) as T;
   if(method==='sql.execute'){await db.execute(String(args.sql),args.params as unknown[]);return {} as T;}
   if(method==='sql.transaction'){await db.transaction(args.statements as any);return {} as T;}
   unexpected++;throw Error('unexpected host IO');
  };
  let failure:unknown;
  try{await createBackgroundLibrary(host,async()=>null,{require(){}});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toBe('cloud_sync_suspended');
  expect(unexpected).toBe(0);expect(cloudFormatFailure(failure)).toBe('suspended');
  expect(JSON.parse(recordFailureDiagnostic(failure))).toMatchObject({code:'cloud_sync_suspended'});
  expect((await db.query('SELECT * FROM library_clear_journal')).length).toBe(1);
 }finally{sql.close();}
});
