import {kv} from '@podjs/framework/watch';
import {hostOperation} from '@podjs/framework/services';
import {SyncHistory,bookRejections,type BookPage} from './sync-diagnostics';
export const syncHistory=new SyncHistory({get:key=>kv.get<string>(key),set:(key,value)=>kv.set(key,value)});
/** Import application storage only on an explicit read command, after startup.
 * Shell registration and foreground transport startup must not create a services cycle. */
async function reader(){
 const [{db,diagnosticChapterReadable},{LibraryDiagnostics},{createBookFiles}]=await Promise.all([import('../services'),import('./library-diagnostics'),import('../books/files-port')]);
 return new LibraryDiagnostics(db,createBookFiles(<T>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,args).result),diagnosticChapterReadable,bookRejections(syncHistory.last(12)));
}
export const libraryDiagnostics={books:async(check?:()=>void,page?:BookPage)=>(await reader()).books(check,page),summary:async(check?:()=>void)=>(await reader()).summary(check)};
