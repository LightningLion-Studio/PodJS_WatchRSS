import type {SqlCancellationCheck,SqlDatabase} from './types';

/** Keep the native cancellation registration active until the transaction settles. */
export function cancellableSql(db:SqlDatabase,check?:SqlCancellationCheck):SqlDatabase{
 if(!check)return db;
 const cancellable=db.transactionChangesCancellable,subscribe=check.onCancel;
 if(!subscribe||!cancellable)return {
  ...db,execute:(...args)=>{check();return db.execute(...args);},
  transaction:statements=>{check();return db.transaction(statements);},
  ...(db.transactionChanges?{transactionChanges:(statements:Parameters<SqlDatabase['transaction']>[0])=>{check();return db.transactionChanges!(statements);}}:{}),
 };
 const transactionChanges=(statements:Parameters<SqlDatabase['transaction']>[0])=>{
  check();return cancellable.call(db,statements,subscribe);
 };
 return {...db,transactionChanges,transaction:async statements=>{await transactionChanges(statements);},
  execute:async(sql,params)=>{await transactionChanges([{sql,params}]);}};
}
