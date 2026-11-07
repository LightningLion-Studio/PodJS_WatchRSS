import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {initializeSchema} from '../../src/core/schema';
import {initializeMemoSchema} from '../../src/notes/repository';
import {SqlBusinessSource} from '../../src/sync-v2/source';
import {SqlFixture,binding} from './fixture';
for(const mode of ['DELETE','WAL'])test('SyncV2 actual SQLite '+mode+' child exit at mapping/log/checkpoint and COMMIT edges',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wrss-crash-'));try{
  const baseline=join(dir,'baseline.db');let db=new SqlFixture(baseline,mode);await initializeSchema(db);await initializeMemoSchema(db);await db.execute("INSERT INTO memo_notes VALUES('n',NULL,'t','m','p','h','b','ancestor',0,1,2,'watch',0,0)");let store=db.store();await store.initialize();await store.beginScan(binding);const source=await SqlBusinessSource.open(db);while(!(await store.checkpoint())!.after.includes('"table":3'))await store.scanPage(source,1);const before=await store.checkpoint();db.close();

  const counted=join(dir,'count.db');cpSync(baseline,counted);const counter=Bun.spawn([process.execPath,resolve(import.meta.dir,'crash-child.ts'),counted,mode,'count'],{stdout:'pipe',stderr:'pipe'}),[counterExit,counterOut,counterErr]=await Promise.all([counter.exited,new Response(counter.stdout).text(),new Response(counter.stderr).text()]);if(counterExit!==0)throw Error(counterErr);const statements=Number(counterOut.trim());expect(statements).toBeGreaterThan(10);
  for(let edge=0;edge<=statements+1;edge++){
   const path=join(dir,'crash-'+edge+'.db');cpSync(baseline,path);
   const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'crash-child.ts'),path,mode,String(edge)],{stdout:'pipe',stderr:'pipe'});const result=await child.exited;expect([0,78]).toContain(result);if(result!==0&&result!==78)throw Error(await new Response(child.stderr).text());
   db=new SqlFixture(path,mode);store=db.store();const cp=await store.checkpoint(),maps=(db.raw.query('SELECT count(*) n FROM syncv2_identity_map').get() as any).n,logs=(db.raw.query('SELECT count(*) n FROM syncv2_change_log').get() as any).n;
   expect(logs).toBe(maps);if(edge<=statements){expect(maps).toBe(0);expect(cp).toEqual(before);}else{expect(maps).toBe(1);expect(cp!.rows).toBe(1);}
   const resume=await SqlBusinessSource.open(db);while((await store.checkpoint())!.phase==='scan')await store.scanPage(resume,1);while((await store.checkpoint())!.phase==='tail')await store.catchUpPage(resume,1);expect(db.raw.query('SELECT count(*) n FROM syncv2_identity_map').get()).toEqual({n:1});expect(db.raw.query('SELECT count(*) n FROM syncv2_change_log').get()).toEqual({n:1});db.close();
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
},180000);
