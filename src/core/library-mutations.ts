/** Commit notifications are separate from visible channel refreshes: reading and
 * save-state writes also need to wake debug cloud scheduling. No IO here. */
const observers=new Set<()=>void>();
const mutation=/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+["`\[]?(?:articles|channels|article_previews|article_original_previews|article_body_chunks|article_original_chunks|source_preferences|source_media_preferences|notes|article_reading_state|article_saved_states|sync_saved_states|sync_article_deletions|sync_source_states|local_article_deletions|sync_books|sync_book_chapters|sync_book_reading|sync_book_events|memo_notes|memo_folders|memo_assets)\b/i;
export function notifyLibrarySqlCommit(statements:readonly {sql:string}[],changes?:readonly number[]){if(changes&&changes.length!==statements.length)throw Error('Invalid committed change receipt');if(!statements.some((s,i)=>mutation.test(s.sql)&&(!changes||changes[i]!>0)))return;for(const fn of observers)try{fn();}catch{}}
export function subscribeLibraryMutations(fn:()=>void){observers.add(fn);return ()=>{observers.delete(fn);};}
