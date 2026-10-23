import type {SqlDatabase} from '../core/types.ts';
import type {JsonObject} from './protocol.ts';
import {parseWireJson,wireNumberToken} from './wire-json.ts';
import {wireFields} from './article-batches.ts';
const {object}=wireFields;
/** Android JSONObject.optInt: Long narrows, Double clamps, numeric strings parse as Double. */
export function tokenUsageOptInt(parent:JsonObject,key:string,fallback:number):number {
 const value=parent[key],token=wireNumberToken(parent,key);
 if(typeof value!=='number'&&typeof value!=='string')return fallback;
 const clamp=(n:number)=>Number.isNaN(n)?0:Math.max(-2147483648,Math.min(2147483647,Math.trunc(n)))||0;
 if(typeof value==='number'){
  if(token&&/^-?[0-9]+$/.test(token)){const integer=BigInt(token);if(integer>=-9223372036854775808n&&integer<=9223372036854775807n)return Number(BigInt.asIntN(32,integer));}
  if(token===undefined&&Number.isSafeInteger(value))return value|0;
  return clamp(value);
 }
 const text=value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g,'');
 if(/^[+-]?(?:NaN|Infinity)$/.test(text))return text.endsWith('NaN')?0:clamp(text.startsWith('-')?-Infinity:Infinity);
 if(/^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)[fFdD]?$/.test(text))return clamp(Number(text.replace(/[fFdD]$/,'')));
 const hex=/^([+-]?)0[xX]([0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)[pP]([+-]?[0-9]+)[fFdD]?$/.exec(text);
 if(hex){const parts=hex[2]!.split('.'),digits=parts.join(''),integer=BigInt('0x'+digits),shift=Number(hex[3])-4*(parts[1]?.length??0);if(integer===0n)return 0;
  if(shift>32)return hex[1]==='-'?-2147483648:2147483647;
  if(shift< -digits.length*4)return 0;
  const absolute=shift>=0?integer<<BigInt(shift):integer>>BigInt(-shift);return clamp(Number(absolute)*(hex[1]==='-'?-1:1));
 }
 return fallback;
}
/** Reproduce native normalized columns, not the UI's aggregated/fallback totals. */
export function tokenUsageWireFields(raw:JsonObject):JsonObject {
 const result:JsonObject={};
 const count=(parent:JsonObject,key:string)=>{const value=tokenUsageOptInt(parent,key,-1);return value>=0?value:undefined;};
 const fields=[['promptTokens','prompt_tokens'],['completionTokens','completion_tokens'],['totalTokens','total_tokens'],['inputTokens','input_tokens'],['outputTokens','output_tokens'],['promptTokenCount','promptTokenCount'],['candidatesTokenCount','candidatesTokenCount'],['totalTokenCount','totalTokenCount']] as const;
 for(const [wire,key] of fields){const value=count(raw,key);if(value!==undefined)result[wire]=value;}
 const reasoning=count(object(raw.completion_tokens_details)??{},'reasoning_tokens')??count(raw,'reasoning_tokens');if(reasoning!==undefined)result.reasoningTokens=reasoning;
 const cached=count(object(raw.prompt_tokens_details)??{},'cached_tokens');if(cached!==undefined)result.cachedPromptTokens=cached;
 return result;
}
/** Native LIMIT semantics: zero is empty and a negative value means all rows.
 * Keyset pages avoid overflowing the host's per-query JSON response limit. */
export async function readTokenUsageForSync(db:SqlDatabase,limit:number):Promise<JsonObject[]> {
 if(limit===0)return [];
 const upper=Number((await db.query('SELECT COALESCE(MAX(id),0) upper_id FROM llm_token_usage'))[0]?.upper_id??0);
 const result:JsonObject[]=[];let cursor:{createdAt:number;id:number}|undefined;
 while(limit<0||result.length<limit){
  const pageSize=limit<0?100:Math.min(100,limit-result.length);
  const where=cursor?' AND (created_at<? OR (created_at=? AND id>?))':'';
  const params=cursor?[upper,cursor.createdAt,cursor.createdAt,cursor.id,pageSize]:[upper,pageSize];
  const rows=await db.query('SELECT id,provider,model,request_id,usage_json,created_at FROM llm_token_usage WHERE id<=?'+where+' ORDER BY created_at DESC,id ASC LIMIT ?',params);
  if(!rows.length)break;
  for(const row of rows){
   const id=Number(row.id),createdAt=Number(row.created_at);if(!Number.isSafeInteger(id)||!Number.isSafeInteger(createdAt))throw new Error('Token usage identity exceeds exact integer range');
   let raw:JsonObject={};try{raw=parseWireJson(String(row.usage_json));}catch{}
   result.push({id,provider:String(row.provider),model:String(row.model),requestId:String(row.request_id),createdAt,...tokenUsageWireFields(raw)});cursor={createdAt,id};
  }
  if(rows.length<pageSize)break;
 }
 return result;
}

export interface TokenUsagePage {records:JsonObject[];count:number;usageEpoch:string;nextAfterId:number;hasMore:boolean;reset?:boolean}
/** Durable generation changes before a deleted tail can reuse an INTEGER PK. */
export const TOKEN_USAGE_CURSOR_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS sync_token_usage_epoch(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL)`,
 `CREATE TRIGGER IF NOT EXISTS token_usage_generation_delete AFTER DELETE ON llm_token_usage WHEN OLD.id>COALESCE((SELECT MAX(id) FROM llm_token_usage),0) BEGIN UPDATE sync_token_usage_epoch SET epoch=lower(hex(randomblob(16))) WHERE id=1; END`,
];
export async function readTokenUsagePage(db:SqlDatabase,options:{limit:number;afterId:number;usageEpoch?:string}):Promise<TokenUsagePage>{
 const {limit,afterId,usageEpoch}=options;
 if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(afterId)||afterId<0||usageEpoch!==undefined&&(typeof usageEpoch!=='string'||!usageEpoch))throw Error('Invalid usage cursor');
 await db.transaction([...TOKEN_USAGE_CURSOR_SCHEMA.map(sql=>({sql})),{sql:'INSERT OR IGNORE INTO sync_token_usage_epoch(id,epoch) VALUES(1,lower(hex(randomblob(16))))'}]);
 const epoch=String((await db.query('SELECT epoch FROM sync_token_usage_epoch WHERE id=1'))[0]?.epoch??'');if(!epoch)throw Error('Usage epoch unavailable');
 const reset=usageEpoch!==undefined&&usageEpoch!==epoch||usageEpoch===undefined&&afterId>0,after=reset?0:afterId;
 const rows=await db.query('SELECT id,provider,model,request_id,usage_json,created_at FROM llm_token_usage WHERE id>? ORDER BY id ASC LIMIT ?',[after,limit+1]);
 const records=rows.slice(0,limit).map(row=>{let raw:JsonObject={};try{raw=parseWireJson(String(row.usage_json));}catch{}return {id:Number(row.id),provider:String(row.provider),model:String(row.model),requestId:String(row.request_id),createdAt:Number(row.created_at),...tokenUsageWireFields(raw)};});
 if(records.some(r=>!Number.isSafeInteger(r.id)||r.id<=after||!Number.isSafeInteger(r.createdAt)))throw Error('Invalid usage row identity');
 const current=String((await db.query('SELECT epoch FROM sync_token_usage_epoch WHERE id=1'))[0]?.epoch??'');if(current!==epoch)throw Error('Usage generation changed during export');
 return {records,count:records.length,usageEpoch:epoch,nextAfterId:records.at(-1)?.id??after,hasMore:rows.length>limit,...(reset?{reset:true}:{})};
}
