import type {ProjectionSql,Statement} from '@podjs/framework/sql-projection';
import {ContentSha256} from '@podjs/framework/content-sha256';
import {updateSha256Parts} from '@podjs/framework/json-text-segments';
import {sqlExactSetGuards} from '@podjs/framework/sql-program';
import {digest,jsonBytes} from './protocol';
import type {LocalCipher} from './store';
import type {RecordFeed,StatementFeed} from './record-feed';

export const FOLLOW_PAGES_SCHEMA=[
 'CREATE TABLE IF NOT EXISTS syncv2_follow_pages(scope TEXT NOT NULL,token TEXT NOT NULL,kind TEXT NOT NULL,start INTEGER NOT NULL,part INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,token,kind,start,part))',
 'CREATE TABLE IF NOT EXISTS syncv2_follow_slot(scope TEXT PRIMARY KEY,token TEXT NOT NULL,binding TEXT NOT NULL,summary TEXT)',
 'CREATE TRIGGER IF NOT EXISTS wrss_follow_cleanup AFTER UPDATE OF state_version ON syncv2_state WHEN OLD.state_version!=NEW.state_version BEGIN DELETE FROM syncv2_follow_pages WHERE scope=OLD.scope; DELETE FROM syncv2_follow_slot WHERE scope=OLD.scope; END',
];
type Summary={records:number;operations:number;guards:number;inputHash:string;businessHash:string};
// One disposable encrypted spool per scope. The state CAS retires it. The
// random build token isolates conflicting writers and incomplete attempts.
export async function followPages(db:ProjectionSql,cipher:LocalCipher,scope:string,aad:string,stateHash:string,
 build:()=>Promise<{records:RecordFeed;business:StatementFeed}>){
 const binding=digest(aad);
 const slot=(await db.query('SELECT token,summary FROM syncv2_follow_slot WHERE scope=? AND binding=?',[scope,binding]))[0];
 let token=String(slot?.token??''),summary:Summary;
 const address=(kind:string,start:number,part:number)=>JSON.stringify([aad,token,kind,start,part]);
 if(slot?.summary)summary=await cipher.open(address('summary',0,0),String(slot.summary));
 else{
  token=String((await db.query('SELECT hex(randomblob(16)) AS token'))[0]!.token);
  const guard={sql:'INSERT INTO podjs_sql_cas_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM syncv2_follow_slot WHERE scope=? AND token=?) THEN 1 ELSE 0 END',params:[scope,token]};
  const clear={sql:'DELETE FROM podjs_sql_cas_guard'};
  await db.transaction([{sql:'DELETE FROM syncv2_follow_pages WHERE scope=?',params:[scope]},
   {sql:'INSERT OR REPLACE INTO syncv2_follow_slot VALUES(?,?,?,NULL)',params:[scope,token,binding]}]);
  const write=async(kind:string,start:number,rows:readonly unknown[])=>{
   const raw=JSON.stringify(rows);
   for(let part=0,at=0;at<raw.length;part++){
    let end=Math.min(at+8192,raw.length);
    if(end<raw.length&&raw.charCodeAt(end-1)>=0xd800&&raw.charCodeAt(end-1)<=0xdbff)end--;
    const body=await cipher.seal(address(kind,start,part),{last:end===raw.length,text:raw.slice(at,end)});
    at=end;
    await db.transaction([guard,clear,{sql:'INSERT INTO syncv2_follow_pages VALUES(?,?,?,?,?,?)',params:[scope,token,kind,start,part,body]}]);
   }
  };
  const {records,business}=await build(),hash=new ContentSha256();
  let operations=0,size=0,page:Statement[]=[];
  const flush=async()=>{if(page.length){await write('ops',operations,page);operations+=page.length;page=[];size=0;}};
  for await(const group of business.run())for(const op of group){
   const serialized=JSON.stringify(op);updateSha256Parts(hash,[jsonBytes(serialized)]);
   if(page.length>=64||size+serialized.length>16384)await flush();
   size+=serialized.length;page.push(op);
  }
  await flush();const inputHash=records.inputHash,businessHash=hash.finish();
  if(!inputHash)throw Error('sql_program_incomplete');
  const id=digest(['account-apply-v4',stateHash,inputHash,businessHash]);
  const guards=sqlExactSetGuards('syncv2_apply_keys',{scope,plan_id:id},'entity_key',records.keys);
  for(let i=0;i<guards.length;i+=64)await write('guards',i,guards.slice(i,i+64));
  for(let i=0;i<records.keys.length;i+=32)await write('keys',i,records.keys.slice(i,i+32));
  summary={records:records.keys.length,operations,guards:guards.length,inputHash,businessHash};
  await db.transaction([guard,clear,{sql:'UPDATE syncv2_follow_slot SET summary=? WHERE scope=? AND token=?',params:[await cipher.seal(address('summary',0,0),summary),scope,token]}]);
 }
 const read=async<T>(kind:string,offset:number,limit:number,total:number):Promise<T[]>=>{
  if(offset===total)return [];
  const first=(await db.query('SELECT start FROM syncv2_follow_pages WHERE scope=? AND token=? AND kind=? AND start<=? ORDER BY start DESC LIMIT 1',[scope,token,kind,offset]))[0];
  if(!first)throw Error('sql_program_incomplete');
  const start=Number(first.start),chunks:string[]=[];
  for(let part=0;;part++){
   const row=(await db.query('SELECT body FROM syncv2_follow_pages WHERE scope=? AND token=? AND kind=? AND start=? AND part=?',[scope,token,kind,start,part]))[0];
   if(!row)throw Error('sql_program_incomplete');
   const v=await cipher.open(address(kind,start,part),String(row.body));
   chunks.push(v.text);if(v.last)break;
  }
  const rows=JSON.parse(chunks.join('')).slice(offset-start,offset-start+limit);
  if(!rows.length)throw Error('sql_program_incomplete');
  return rows;
 };
 return {...summary,keys:(at:number,n:number)=>read<string>('keys',at,n,summary.records),
  statements:(at:number)=>read<Statement>('ops',at,64,summary.operations),
  membership:(at:number)=>read<Statement>('guards',at,64,summary.guards)};
}
export type FollowPages=Awaited<ReturnType<typeof followPages>>;
