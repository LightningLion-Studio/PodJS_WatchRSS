/** Owned content namespaces only. Fonts, reader configuration, credentials and logs stay outside. */
export const LIBRARY_CONTENT_ROOTS=['books','article_content','offline/rss','sync_body','feeds','original','managed-cache/rss-offline'] as const;
export const PRIVATE_CONTENT_ROOTS=['books','article_content','offline/rss','notes','sync_body','feeds','original','managed-cache/rss-offline','watch-cloud-cache','cloud-crypto'] as const;
export interface PrivateLibraryFiles {
 list(path:string):Promise<{entries:{path:string;file:boolean;directory:boolean}[]}>;
 remove(path:string):Promise<unknown>;
 stat(path:string):Promise<{exists:boolean}>;
}
/** Fail closed on malformed listings or failed deletion; never acknowledge partial cleanup. */
export async function clearPrivateContentFiles(files:PrivateLibraryFiles,options:{roots?:readonly string[];check?:()=>void;onDeleted?:(count:number)=>void}={}):Promise<void>{
 let seen=0,deleted=0;
 const check=()=>options.check?.();
 async function clear(root:string,depth:number):Promise<void>{
  check();
  if(depth>20)throw Error('private_library_path_limit');
  for(const entry of (await files.list(root)).entries){
   check();
   if(++seen>100000||!entry.path.startsWith(root+'/'))throw Error('private_library_invalid_path');
   const name=entry.path.slice(root.length+1);
   if(!name||name.includes('/')||name.includes('\\')||name==='.'||name==='..'||entry.file===entry.directory)throw Error('private_library_invalid_path');
   if(entry.directory)await clear(entry.path,depth+1);
   else{check();await files.remove(entry.path);check();if((await files.stat(entry.path)).exists)throw Error('private_library_file_remains');check();options.onDeleted?.(++deleted);}
  }
 }
 for(const root of options.roots??PRIVATE_CONTENT_ROOTS){if(!(PRIVATE_CONTENT_ROOTS as readonly string[]).includes(root))throw Error('private_library_invalid_path');await clear(root,0);}
 check();
}
