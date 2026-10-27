/** No exception text, request identifiers, URLs or credentials enter diagnostics. */
export function recordFailureDiagnostic(error:unknown):string{
 const value=error&&typeof error==='object'?error as {message?:unknown;code?:unknown;status?:unknown;name?:unknown}:{};
 const message=typeof value.message==='string'?value.message:'';
 const allowed=(v:unknown)=>typeof v==='string'&&v.length<=80&&(/^(?:cloud_|book_|library_|raw_json_)[a-z_]+$/.test(v)||['missing_key_version','client_upgrade_required','device_session_revoked','invalid_session','missing_device_authorization','service_maintenance'].includes(v));
 const code=/Query exceeds 1000 rows; use LIMIT and pagination/.test(message)?'host_query_row_limit':/Query result too large; use paging/.test(message)?'host_query_bytes_limit':allowed(value.code)?value.code:allowed(message)?message:'unclassified';
 const status=Number.isInteger(value.status)&&Number(value.status)>=100&&Number(value.status)<=599?Number(value.status):undefined;
 const name=['Error','TypeError','RangeError','SyntaxError','HostServiceError'].includes(String(value.name))?String(value.name):'Error';
 return JSON.stringify({event:'records-failed',code,name,...(status===undefined?{}:{status}),...(message.includes('SQLite')?{category:'sqlite'}:/Local library changed|book_changed/.test(message)?{category:'concurrent-library-change'}:{})});
}
