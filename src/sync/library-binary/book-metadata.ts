import type {SqlDatabase,SqlParams} from '../../core/types';
import type {ReceiptBoundary,Statement} from './store';
import {deviceOrder} from '../saved-state';
import {ResumeError} from './wire';

export const BOOK_METADATA_BODY_BYTES=1024*1024;
export const BOOK_METADATA_STRING_BYTES=256*1024;

/** A permanent book apply policy decision, independent of the wire object limit. */
export class BookMetadataRejected extends ResumeError {
 constructor(){super('BUSINESS_REJECTED');}
}

const PAGE_CHARS=8192;

/** JSON cells contain no literal NUL. SQLite counts Unicode characters here
 * and returns complete code points, including at page boundaries. */
export async function* bookSqlText(db:SqlDatabase,select:string,params:SqlParams,chars:number){
 for(let at=0;at<chars;at+=PAGE_CHARS){
  const part=(await db.query(`SELECT substr(value,?,?) AS value FROM (${select})`,[at+1,PAGE_CHARS,...params]))[0]?.value;
  if(typeof part!=='string'||!part.length)throw Error('book_state_changed');
  yield part;
 }
}

function* stringPieces(text:string){
 for(let at=0;at<text.length;){
  let end=Math.min(at+PAGE_CHARS,text.length);
  if(end<text.length&&/[\ud800-\udbff]/.test(text[end-1]!))end--;
  yield text.slice(at,end);
  at=end;
 }
}

function* jsonPieces(value:unknown):Generator<string>{
 if(typeof value==='string'){
  yield '"';
  for(const piece of stringPieces(value))yield JSON.stringify(piece).slice(1,-1);
  yield '"';
 }else if(Array.isArray(value)){
  yield '[';
  for(let i=0;i<value.length;i++){if(i)yield ',';yield*jsonPieces(value[i]);}
  yield ']';
 }else if(value&&typeof value==='object'){
  const row=value as Record<string,unknown>;
  yield '{';
  let first=true;
  for(const key of Object.keys(row).sort()){
   if(row[key]===undefined)continue;
   if(!first)yield ',';
   first=false;yield JSON.stringify(key);yield ':';yield*jsonPieces(row[key]);
  }
  yield '}';
 }else yield JSON.stringify(value);
}

export function sameBookJson(a:unknown,b:unknown):boolean{
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
 const keys=Object.keys(left).filter(key=>left[key]!==undefined);
 return keys.length===Object.keys(right).filter(key=>right[key]!==undefined).length&&
  keys.every(key=>sameBookJson(left[key],right[key]));
}

class PagedValue {
 constructor(readonly pieces:()=>Iterable<string>){}
}

/** Large bind values stay out of a single host request. The final transaction
 * reconstructs their exact values and commits the business row and APPLIED. */
export function pagedBookBoundary(db:SqlDatabase,key:readonly string[],boundary:ReceiptBoundary):ReceiptBoundary {
 const predicate='scope=? AND job_id=? AND object_id=?';
 const remove={sql:'DELETE FROM library_binary_book_text WHERE '+predicate,params:key};
 return {...boundary,json(value){
  let initial='';
  for(const piece of jsonPieces(value)){
   if(initial.length+piece.length>8192)return new PagedValue(()=>jsonPieces(value));
   initial+=piece;
  }
  return initial;
 },sourceOrder:text=>
  text.length<=512?deviceOrder(text):new PagedValue(function*(){for(const piece of stringPieces(text))yield deviceOrder(piece);}),
 async transaction(statements:Statement[]){
  const total=statements.reduce((n,s)=>n+(s.params??[]).reduce<number>((p,v)=>p+(v instanceof PagedValue?32769:typeof v==='string'?v.length:0),0),0);
  const transact=boundary.transaction??(writes=>db.transaction(writes));
  if(total<=32768)return transact(statements);
  await db.execute(remove.sql,remove.params);
  try{
   let field=0;
   const writes:Statement[]=[];
   const saved=new Map<string|PagedValue,number>();
   for(const statement of statements){
    const bindings=statement.params??[],replacements=new Map<number,number>();
    for(let i=0;i<bindings.length;i++){
     const value=bindings[i];
     if(!(value instanceof PagedValue)&&(typeof value!=='string'||value.length<=512))continue;
     const prior=saved.get(value);
     if(prior!==undefined){replacements.set(i,prior);continue;}
     const id=field++;
     saved.set(value,id);
     replacements.set(i,id);
     let buffer='',ordinal=0;
     const flush=async()=>{
      boundary.check?.();
      await db.execute('INSERT INTO library_binary_book_text VALUES(?,?,?,?,?,?)',[...key,id,ordinal++,buffer]);
      buffer='';
     };
     for(const piece of value instanceof PagedValue?value.pieces():stringPieces(value)){
      if(buffer.length+piece.length>PAGE_CHARS&&buffer.length)await flush();
      buffer+=piece;
     }
     if(buffer.length||!ordinal)await flush();
    }
    if(!replacements.size){writes.push(statement);continue;}
    let index=0;
    const next:unknown[]=[];
    const sql=statement.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g,token=>{
     if(token!=='?')return token;
     const at=index++,id=replacements.get(at);
     if(id===undefined){next.push(bindings[at]);return token;}
     next.push(...key,id);
     return `(SELECT group_concat(value,'') FROM (SELECT value FROM library_binary_book_text WHERE ${predicate} AND field=? ORDER BY ordinal))`;
    });
    if(index!==bindings.length)throw Error('book_sql_bindings');
    writes.push({sql,params:next});
   }
   boundary.check?.();
   await transact([...writes,remove]);
  }catch(error){
   await db.execute(remove.sql,remove.params).catch(()=>{});
   throw error;
  }
 }};
}
