import type {SqlDatabase,SqlParams} from '../core/types.ts';
/** Host queries cap rows and serialized bytes. Callers supply a stable order;
 * their surrounding revision checks reject a concurrently shifted result. */
export async function querySyncPages(db:SqlDatabase,query:string,params:SqlParams=[],pageSize=400):Promise<Record<string,unknown>[]>{
 const result:Record<string,unknown>[]=[];
 let offset=0,size=pageSize;
 while(true){
  let rows:Record<string,unknown>[];
  try{rows=await db.query(query+' LIMIT ? OFFSET ?',[...params,size,offset]);}
  catch(error){
   if(size>1&&/query result too large/i.test(String(error))){size=Math.max(1,Math.floor(size/2));continue;}
   throw error;
  }
  result.push(...rows);offset+=rows.length;if(rows.length<size)return result;
 }
}
