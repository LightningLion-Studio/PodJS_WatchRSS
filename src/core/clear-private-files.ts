/** Owned content namespaces only. Fonts, reader configuration, credentials and logs stay outside. */
export const PRIVATE_CONTENT_ROOTS=['books','article_content','offline/rss','notes','sync_body','feeds','original','managed-cache/rss-offline','watch-cloud-cache','cloud-crypto'] as const;
export interface PrivateLibraryFiles {
 list(path:string):Promise<{entries:{path:string;file:boolean;directory:boolean}[]}>;
 remove(path:string):Promise<unknown>;
 stat(path:string):Promise<{exists:boolean}>;
}
/** Fail closed on malformed listings or failed deletion; never acknowledge partial cleanup. */
export async function clearPrivateContentFiles(files:PrivateLibraryFiles):Promise<void>{
 let seen=0;
 async function clear(root:string,depth:number):Promise<void>{
  if(depth>20)throw Error('private_library_path_limit');
  for(const entry of (await files.list(root)).entries){
   if(++seen>100000||!entry.path.startsWith(root+'/'))throw Error('private_library_invalid_path');
   const name=entry.path.slice(root.length+1);
   if(!name||name.includes('/')||name.includes('\\')||name==='.'||name==='..'||entry.file===entry.directory)throw Error('private_library_invalid_path');
   if(entry.directory)await clear(entry.path,depth+1);
   else{await files.remove(entry.path);if((await files.stat(entry.path)).exists)throw Error('private_library_file_remains');}
  }
 }
 for(const root of PRIVATE_CONTENT_ROOTS)await clear(root,0);
}
