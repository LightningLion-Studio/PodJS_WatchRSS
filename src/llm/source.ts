import type {SqlDatabase} from "../core/types.ts";
import type {SummarySource} from "./summary.ts";

/** Read only the native summary scan window, never hydrate a whole imported book. */
export async function loadSummarySource(db:SqlDatabase,id:string,original:()=>Promise<unknown>,waiting:()=>void):Promise<SummarySource>{
 const row=(await db.query(`SELECT a.title,a.link,substr(a.content,1,64000) content,substr(a.description,1,64000) description,COALESCE(p.use_original_content,0) original_mode FROM articles a LEFT JOIN source_preferences p ON p.channel_id=a.channel_id WHERE a.id=?`,[Number(id)]))[0];
 if(!row)throw new Error("文章不存在");
 const link=String(row.link??"").trim().toLowerCase();
 const importedText=link.startsWith("https://watchrss.local/import-content/txt/");
 const readChunks=async(table:string)=>{
  let content="";
  for(let index=0;content.length<64000;index++){
   const part=(await db.query(`SELECT substr(body,1,?) body FROM ${table} WHERE article_id=? AND chunk_index=?`,[64000-content.length,Number(id),index]))[0];
   if(!part)break;content+=String(part.body??"");
  }
  return content;
 };
 const cached=await readChunks("article_original_chunks");
 let content=cached.trim()?cached:await readChunks("article_body_chunks");
 if(!content.trim())content=String(row.content??"").trim()?String(row.content):String(row.description??"");
 if(!importedText&&!content.trim()&&Number(row.original_mode)){
  waiting();await original();content=await readChunks("article_original_chunks");
 }
 return {title:String(row.title??""),content,plainText:importedText};
}
