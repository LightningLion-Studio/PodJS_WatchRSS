import type {SqlDatabase} from "../core/types.ts";
export interface TokenCounts {prompt:number;completion:number;total:number}
export interface UsageRecord extends TokenCounts {id:number;provider:string;model:string;createdAt:number;reasoning?:number}
export interface UsageGroup extends TokenCounts {provider:string;model:string;calls:number}
export interface UsageDay extends TokenCounts {dayTimestamp:number;calls:number}
export interface UsageSnapshot {statistics:TokenCounts&{calls:number};providers:UsageGroup[];daily:UsageDay[];recent:UsageRecord[]}
const count=(value:unknown):number|undefined=>{if((typeof value!=="number"&&typeof value!=="string")||(typeof value==="string"&&!value.trim()))return;const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=2147483647?Math.trunc(n):undefined;};
/** Preserve raw history while accepting OpenAI, Gemini and the actual WatchRSS response fields.
 * Native only normalizes snake_case for aggregate columns; camelCase server summaries were lost there. */
export function normalizeUsage(raw:unknown):{aggregate:TokenCounts;record:TokenCounts&{reasoning?:number}} {
 const u=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,any>:{};
 const prompt=count(u.prompt_tokens)??count(u.input_tokens)??count(u.inputTokens)??count(u.promptTokenCount)??0;
 const completion=count(u.completion_tokens)??count(u.output_tokens)??count(u.outputTokens)??count(u.candidatesTokenCount)??0;
 const total=count(u.total_tokens)??count(u.totalTokens)??count(u.totalTokenCount)??prompt+completion;
 const aggregate={prompt,completion,total};
 return {aggregate,record:{...aggregate,reasoning:count(u.completion_tokens_details?.reasoning_tokens)??count(u.reasoning_tokens)??count(u.reasoningTokens)}};
}
/** Keyset pages bound host response size; a high-water ID excludes concurrently added calls. */
export async function readUsage(db:SqlDatabase,now=Date.now()):Promise<UsageSnapshot> {
 const snapshot:UsageSnapshot={statistics:{calls:0,prompt:0,completion:0,total:0},providers:[],daily:[],recent:[]};
 const upper=Number((await db.query("SELECT COALESCE(MAX(id),0) upper_id FROM llm_token_usage"))[0]?.upper_id??0);
 const groups=new Map<string,UsageGroup>(),days=new Map<number,UsageDay>();let after=0;
 const add=(target:TokenCounts&{calls:number},counts:TokenCounts)=>{target.calls++;target.prompt+=counts.prompt;target.completion+=counts.completion;target.total+=counts.total;};
 while(after<upper){
  const rows=await db.query("SELECT id,provider,model,usage_json,created_at FROM llm_token_usage WHERE id>? AND id<=? ORDER BY id LIMIT 100",[after,upper]);if(!rows.length)break;
  for(const row of rows){let raw:unknown;try{raw=JSON.parse(String(row.usage_json));}catch{raw=null;}
   const counts=normalizeUsage(raw),provider=String(row.provider),model=String(row.model),createdAt=Number(row.created_at),id=Number(row.id);after=id;add(snapshot.statistics,counts.aggregate);
   const key=JSON.stringify([provider,model]);let group=groups.get(key);if(!group){group={provider,model,calls:0,prompt:0,completion:0,total:0};groups.set(key,group);}add(group,counts.aggregate);
   if(createdAt>=now-7*86400000){const dayTimestamp=Math.trunc(createdAt/86400000)*86400000;let day=days.get(dayTimestamp);if(!day){day={dayTimestamp,calls:0,prompt:0,completion:0,total:0};days.set(dayTimestamp,day);}add(day,counts.aggregate);}
   snapshot.recent.push({id,provider,model,createdAt,...counts.record});
  }
  snapshot.recent.sort((a,b)=>b.createdAt-a.createdAt||b.id-a.id);snapshot.recent.length=Math.min(200,snapshot.recent.length);
 }
 snapshot.providers=[...groups.values()].sort((a,b)=>b.total-a.total);snapshot.daily=[...days.values()].sort((a,b)=>a.dayTimestamp-b.dayTimestamp);return snapshot;
}
export async function clearUsage(db:SqlDatabase):Promise<void>{await db.execute("DELETE FROM llm_token_usage");}
