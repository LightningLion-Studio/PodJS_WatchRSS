import type {CloudHostRequest} from '../cloud/host-ports';

const LEASE='watchrss.account.session.v1';
/** Cross-guest/process account transaction. Busy is retryable; it never sends a
 * refresh request or clears a session. Release follows durable publication. */
export async function withAccountLease<T>(host:CloudHostRequest,action:()=>Promise<T>):Promise<T>{
  if(!(await host<{acquired:boolean}>('secure.acquire',{key:LEASE})).acquired)throw Error('account_busy: 账号正在更新，请稍后重试');
  try{return await action();}finally{await host('secure.release',{key:LEASE});}
}
