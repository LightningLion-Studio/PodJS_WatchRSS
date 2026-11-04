import {Database} from 'bun:sqlite';
import {SqlCloudChangeDetection} from '../../src/cloud/change-detection';
import type {CloudHostRequest} from '../../src/cloud/host-ports';
export function detectorFixture(){
 const db=new Database(':memory:');db.run('CREATE TABLE articles(id INTEGER PRIMARY KEY,title TEXT,reading_progress REAL)');db.run('CREATE TABLE memo_notes(id TEXT PRIMARY KEY,body TEXT)');let queries=0;
 const host:CloudHostRequest=async<T>(method:string,args:any):Promise<T>=>{let result:any;queries++;
  if(method==='sql.query')result=db.query(args.sql).all(...(args.params??[]));
  else if(method==='sql.execute'){db.query(args.sql).run(...(args.params??[]));result=null;}
  else if(method==='sql.transaction'){const counts:number[]=[];db.transaction(()=>{for(const s of args.statements){db.query(s.sql).run(...(s.params??[]));counts.push((db.query('SELECT changes() AS n').get() as any).n);}})();result=args.reportChanges?counts:null;}
  else throw Error('unexpected test method');return result as T;
 };
 const detector=new SqlCloudChangeDetection(host,'account+backend+device','build-1');return {db,host,detector,queries:()=>queries};
}
