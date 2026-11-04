import {stateSqlFixture} from './state-sql-fixture';
import {createCloudRuntime} from '../../src/cloud/runtime';
import {WatchAccountStore} from '../../src/account/store';
import {backgroundDiagnostics} from '../../src/cloud/background-diagnostic';
import {enabled,crypto} from './k2-crypto';
import type {CloudLibraryRepository} from '../../src/cloud/library';
import type {CloudSession} from '../../src/cloud/service';
export async function runtimeSession(repository:CloudLibraryRepository&{deviceId():Promise<string>},runCheck:()=>void=()=>{},options:{observe?:(name:string)=>void;createRuntime?:typeof createCloudRuntime}={}){
 const account={userId:'synthetic',watchDeviceToken:'synthetic-token',backendBaseUrl:'https://backend.invalid',tokenExpiresAtMillis:9e15,watchRefreshToken:''},values=new Map([['state_json',JSON.stringify(account)],['watchrss.library.owner',JSON.stringify([account.backendBaseUrl,account.userId])]]),logs:string[]=[];
 const accounts=new WatchAccountStore({get:k=>{options.observe?.('accountRead');return values.get(k)??null;},set:(k,v)=>{values.set(k,v);},remove:k=>{values.delete(k);}});
 const stateSql=stateSqlFixture();let held=false;
 const host=async<T>(method:string,args:any):Promise<T>=>{options.observe?.(method);if(method.startsWith('sql.'))return stateSql.host<T>(method,args);if(method==='secure.acquire'){if(held)throw Error('nested account lease');held=true;return {acquired:true} as T;}if(method==='secure.release'){if(!held)throw Error('missing account lease');held=false;return {} as T;}if(method==='crypto.hash')return {digestBase64:Buffer.from(await crypto.sha256(new Uint8Array(Buffer.from(args.dataBase64,'base64'))),'hex').toString('base64')} as T;if(method==='runtime.delay')return null as T;if(method==='secure.keys')return {keys:[...values.keys()].filter(k=>args.prefixes.some((p:string)=>k.startsWith(p))&&k>(args.after??'')).sort(),hasMore:false} as T;if(method==='secure.get')return {exists:values.has(args.key),value:values.get(args.key)} as T;if(method==='secure.set'){values.set(args.key,args.value);return null as T;}if(method==='log.append'){logs.push(args.text);return null as T;}throw Error('Unexpected runtime fixture host '+method);};
 const diagnostic=backgroundDiagnostics(host),runtime=(options.createRuntime??createCloudRuntime)(host,async()=>repository,enabled,accounts,undefined,{begin:()=>runCheck},{recordDiagnostic:diagnostic.report});
 // Invoke the actual private open port used by syncNow, not an injected session.
 const session:CloudSession=await (runtime.service as any).ports.open();
 return {runtime,session,accounts,values,account,logs,diagnostic,proxy:(session.library as any).repository as CloudLibraryRepository};
}
