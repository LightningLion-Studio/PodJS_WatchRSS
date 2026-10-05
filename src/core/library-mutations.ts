/** Commit notifications are separate from visible channel refreshes: reading and
 * save-state writes also need to wake debug cloud scheduling. No IO here. */
const observers=new Set<()=>void>();
const mutation=/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+["`\[]?(?:articles|channels|article_reading_state|article_saved_states|sync_saved_states|sync_article_deletions|sync_source_states|local_article_deletions)\b/i;
export function notifyLibrarySqlCommit(statements:readonly {sql:string}[]){if(!statements.some(s=>mutation.test(s.sql)))return;for(const fn of observers)try{fn();}catch{}}
export function subscribeLibraryMutations(fn:()=>void){observers.add(fn);return ()=>{observers.delete(fn);};}
