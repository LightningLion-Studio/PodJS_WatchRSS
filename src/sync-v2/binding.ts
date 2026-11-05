import {readSqlKeysetPage,type ProjectionSql} from '@podjs/framework/sql-projection';
import {digest,canonical} from './protocol';
import {PROJECTION_SOURCE_TABLES,type ScanBinding} from './store';
/** Persistent scan binding is based on relevant stored SQL semantics, never
 * only user_version or the cookie. Changing data goes through the outbox. */
export async function projectionScanBinding(db:ProjectionSql,identity:{descriptorPin:string;accountScope:string;capability:string}):Promise<ScanBinding>{
 const tables=new Set(Object.keys(PROJECTION_SOURCE_TABLES)),definitions:unknown[]=[];let after='';
 for(;;){const page=await readSqlKeysetPage(db,"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','index') AND name>? ORDER BY name",[after],64);for(const row of page.rows)if(tables.has(String(row.tbl_name)))definitions.push([row.type,row.name,row.tbl_name,row.sql]);if(page.rows.length<page.limit)break;after=String(page.rows.at(-1)!.name);}
 return {schema:digest({version:2,wire:'v2-rc6',definitions}),...identity};
}
