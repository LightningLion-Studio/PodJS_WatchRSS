import {encodeBase64} from '@podjs/framework/bytes';
import {sha256Hex} from '@podjs/framework/crypto';
export type NoteAssetHost=<T>(method:string,args:Record<string,unknown>)=>Promise<T>;
/** Phone/mini local image references, including Markdown and HTML bodies. */
export function noteAssetKeys(markdown:string){
 const keys=new Set<string>();
 markdown.replace(/<img\b[^>]*\bsrc\s*=\s*(?:"assets\/([^"<>]+)"|'assets\/([^'<>]+)'|assets\/([^\s<>]+))[^>]*>|!\[[^\]]*\]\(assets\/([^)]*)\)/gi,(_,a,b,c,d)=>{const key=a||b||c||d;if(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(key))keys.add(key);return _;});
 return keys;
}
/** Run only after every readable head has merged. Omission of an archive is
 * never an instruction to delete another note's images. Re-read references
 * before each deletion; partial files and unrecognized names are not targets. */
export function createNoteAssetCollector(host:NoteAssetHost){return async(references:()=>Promise<ReadonlySet<string>>,check:()=>void)=>{
 check();const {entries}=await host<{entries:{file:boolean;path:string}[]}>('file.list',{path:'notes/assets'});let removed=0;
 for(const entry of entries){check();if(!entry.file||!entry.path.startsWith('notes/assets/'))continue;const key=entry.path.slice(13);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(key)||/\.(?:part|pending|async-\d+|kv-migration)$/.test(key))continue;
  if((await references()).has(key))continue;check();const result=await host<{deleted:boolean}>('file.delete',{path:entry.path});
  if(!result.deleted&&(await host<{file:boolean}>('file.stat',{path:entry.path})).file)throw Error('cloud_note_asset_delete_incomplete');removed++;
 }return removed;
};}
/** Atomic target publication, using the same directory as local phone sync. */
export function createNoteAssetWriter(host:NoteAssetHost){return async(key:string,bytes:Uint8Array)=>{
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(key))throw Error('cloud_note_asset_path_invalid');
 const target='notes/assets/'+key,digest=sha256Hex(bytes),stat=await host<{file:boolean;size:number}>('file.stat',{path:target});
 if(stat.file&&stat.size===bytes.length&&(await host<{sha256:string}>('file.hash',{path:target})).sha256===digest)return 0;
 const {path}=await host<{path:string}>('file.createTemp',{directory:'notes/assets'});
 try{for(let at=0;at<bytes.length;at+=65535){const part=bytes.subarray(at,at+65535),r=await host<{size:number}>('file.write',{path,dataBase64:encodeBase64(part),append:true,expectedOffset:at});if(r.size!==at+part.length)throw Error('cloud_note_asset_write_incomplete');}
  await host('file.commit',{path,target,expectedSize:bytes.length,expectedSha256:digest});return 1;
 }finally{await host('file.delete',{path}).catch(()=>{});}
};}
