import type {SqlDatabase} from '../core/types.ts';

export interface OfflineMediaEntry {originUrl:string;mediaType:'IMAGE'|'VIDEO';relativePath:string|null}
export interface OfflineMediaFiles {stat(path:string):Promise<{file:boolean;size:number}>}
export interface OfflineMediaDownloadFiles extends OfflineMediaFiles {
  download(url:string,path:string,maxBytes:number):Promise<unknown>;
  remove(path:string):Promise<void>;
}

/** Only app-owned RSS media paths are passed to the native image decoder. */
export function offlineMediaPath(itemId:number,value:string|null):string|null {
  if(!Number.isSafeInteger(itemId)||itemId<=0||!value)return null;
  const prefix=`offline/rss/${itemId}/`;
  if(!value.startsWith(prefix))return null;
  const name=value.slice(prefix.length);
  return name&&!name.startsWith('.')&&!name.includes('/')&&!name.includes('\\')&&!name.includes('..')&&!name.endsWith('.part')?value:null;
}

export async function readOfflineMedia(db:Pick<SqlDatabase,'query'>,files:OfflineMediaFiles,itemId:number):Promise<{available:Record<string,string>;failed:number}> {
  if(!Number.isSafeInteger(itemId)||itemId<=0)return {available:{},failed:0};
  const rows=await db.query('SELECT origin_url,media_type,relative_path FROM offline_media WHERE item_id=? ORDER BY id',[itemId],"reader.offlineMedia");
  const available:Record<string,string>={};let failed=0;
  for(const row of rows){
    const origin=String(row.origin_url??''),path=offlineMediaPath(itemId,row.relative_path==null?null:String(row.relative_path));
    if(!origin){failed++;continue;}
    if(!path){failed++;continue;}
    const info=await files.stat(path).catch(()=>null);
    if(!info?.file||!Number.isSafeInteger(info.size)||info.size<=0){failed++;continue;}
    available[origin]=path;
  }
  return {available,failed};
}

/** Retry persisted failures without changing their row or discarding an existing good file. */
export async function retryOfflineMedia(db:Pick<SqlDatabase,'query'|'execute'>,files:OfflineMediaDownloadFiles,itemId:number):Promise<{available:Record<string,string>;failed:number}> {
  if(!Number.isSafeInteger(itemId)||itemId<=0)return {available:{},failed:0};
  const rows=await db.query('SELECT id,origin_url,media_type,relative_path FROM offline_media WHERE item_id=? ORDER BY id',[itemId],"reader.offlineMedia");
  for(const row of rows){
    const url=String(row.origin_url??''),kind=String(row.media_type??''),rowId=Number(row.id);
    const old=offlineMediaPath(itemId,row.relative_path==null?null:String(row.relative_path));
    if(old){const info=await files.stat(old).catch(()=>null);if(info?.file&&info.size>0)continue;}
    if(!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(url)||!['IMAGE','VIDEO'].includes(kind)||!Number.isSafeInteger(rowId)||rowId<=0)continue;
    const extension=(url.split(/[?#]/,1)[0]??'').match(/\.([a-z0-9]{1,6})$/i)?.[1]?.toLowerCase()??(kind==='VIDEO'?'mp4':'jpg');
    const path=old??`offline/rss/${itemId}/${kind.toLowerCase()}_${rowId}.${extension}`;
    try{
      await files.download(url,path,32*1024*1024);
      const info=await files.stat(path);
      if(!info.file||!Number.isSafeInteger(info.size)||info.size<=0)throw new Error('Offline media download is empty');
      await db.execute('UPDATE offline_media SET relative_path=? WHERE id=? AND item_id=?',[path,rowId,itemId]);
    }catch{await files.remove(path).catch(()=>{});}
  }
  return readOfflineMedia(db,files,itemId);
}
