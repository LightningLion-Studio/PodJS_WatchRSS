import {readSqlText} from "@podjs/framework/sql";
import type {SqlDatabase,SqlParams} from '../core/types.ts';
import {MAX_BODY_JSON_BYTES} from './article-body.ts';
export function readSyncSqlText(db:SqlDatabase,select:string,params:SqlParams=[]):Promise<string|null>{
 return readSqlText(db,select,params,{maxBytes:MAX_BODY_JSON_BYTES,errors:{invalid:'Invalid or oversized sync SQL text',changed:'Sync SQL text changed during read',boundary:'Invalid UTF-8 boundary in sync SQL text'}});
}
