import type {SqlDatabase,SqlParams} from '../core/types.ts';
import {MAX_BODY_JSON_BYTES} from './article-body.ts';
/** Read a trusted single-column SELECT (aliased `value`) in bounded byte pages.
 * BLOB substr preserves embedded NULs. A four-byte boundary probe keeps each
 * returned TEXT slice on UTF-8 boundaries, so the host performs decoding rather
 * than making the UI guest parse a doubled hex representation of every byte.
 * Callers guard their surrounding snapshot against concurrent library edits. */
export async function readSyncSqlText(db:SqlDatabase,select:string,params:SqlParams=[]):Promise<string|null>{
 const row=(await db.query(`SELECT typeof(value) AS kind,length(CAST(value AS BLOB)) AS bytes,
  CASE WHEN length(CAST(value AS BLOB))<=32768 THEN value ELSE NULL END AS small_value FROM (${select})`,params))[0];
 if(!row||row.kind==='null')return null;
 const size=Number(row.bytes);if(row.kind!=='text'||!Number.isSafeInteger(size)||size<0||size>MAX_BODY_JSON_BYTES)throw new Error('Invalid or oversized sync SQL text');
 if(size<=32768){if(typeof row.small_value!=='string')throw new Error('Sync SQL text changed during read');return row.small_value;}
 const parts:string[]=[];
 for(let offset=0;offset<size;){
  let count=Math.min(32768,size-offset);
  if(offset+count<size){
   const end=offset+count,probe=(await db.query(`SELECT hex(substr(CAST(value AS BLOB),?,4)) AS boundary FROM (${select})`,[end-2,...params]))[0];
   const hex=String(probe?.boundary??'');if(!/^[0-9A-Fa-f]{8}$/.test(hex))throw new Error('Sync SQL text changed during read');
   const byte=(i:number)=>parseInt(hex.slice(i*2,i*2+2),16);
   if((byte(3)&0xc0)===0x80){let start=2;while(start>=0&&(byte(start)&0xc0)===0x80)start--;if(start<0)throw new Error('Invalid UTF-8 boundary in sync SQL text');count-=3-start;}
  }
  const part=(await db.query(`SELECT CAST(substr(CAST(value AS BLOB),?,?) AS TEXT) AS value,length(substr(CAST(value AS BLOB),?,?)) AS bytes FROM (${select})`,[offset+1,count,offset+1,count,...params]))[0];
  if(typeof part?.value!=='string'||Number(part.bytes)!==count)throw new Error('Sync SQL text changed during read');
  parts.push(part.value);offset+=count;
 }
 return parts.join('');
}
