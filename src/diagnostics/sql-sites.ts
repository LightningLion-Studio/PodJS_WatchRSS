/** Statement families are code-owned. Never hash or print SQL literals or bind values. */
export const SQL_SITES:Readonly<Record<number,string>>={0:'other',1:'schema',2:'cloud.migration.marker',3:'cloud.state.header',4:'cloud.state.chunks',5:'cloud.state.revision',6:'cloud.state.write',7:'cloud.state.stage',8:'sync.revision',9:'sync.definitions',10:'sync.projection',11:'reading.lookup',12:'reading.state',13:'sync.identity',14:'sync.saved',15:'sync.deletions',16:'sync.books',17:'notes',18:'home.channels',19:'articles',20:'article.body',21:'offline.media',22:'sync.registers',23:'cloud.records',24:'cloud.sources',25:'usage',26:'yield',27:'pragma',28:'sync.other',29:'cloud.other'};
export function sqlSite(sql:unknown):number{
 if(typeof sql!=='string')return 0;
 if(sql==='SELECT 1')return 26;if(sql.startsWith('PRAGMA'))return 27;
 if(/^(?:CREATE|ALTER|DROP)\b/.test(sql))return 1;
 if(sql.includes('cloud_state_migration_chunks'))return 7;
 if(sql.includes('cloud_state_migrations'))return 2;
 if(sql.includes('cloud_state_')){if(!sql.startsWith('SELECT'))return 6;if(sql.includes('SELECT revision,parts'))return 3;if(sql.includes('SELECT revision FROM'))return 5;return 4;}
 if(sql.includes('cloud_reading_lookup'))return 11;
 if(sql.includes('sync_fast_'))return 9;
 if(sql.includes('sync_projection_'))return 10;
 if(sql.includes('sync_library_revision'))return 8;
 if(sql.includes('sync_local_identity')||sql.includes('sync_stable_article_ids'))return 13;
 if(sql.includes('article_register_'))return 22;
 if(sql.includes('cloud_record'))return 23;
 if(sql.includes('cloud_source'))return 24;
 if(sql.includes('local_article_deletions')||sql.includes('sync_article_deletions'))return 15;
 if(sql.includes('sync_book'))return 16;
 if(sql.includes('memo_'))return 17;
 if(sql.includes('offline_media'))return 21;
 if(sql.includes('article_reading_state')||sql.includes('native_reading_sources'))return 12;
 if(sql.includes('sync_saved_states')||sql.includes('article_saved_states'))return 14;
 if(sql.includes('article_body_chunks')||sql.includes('article_original_chunks')||sql.includes('article_sync_content'))return 20;
 if(sql.includes('articles'))return 19;if(sql.includes('channels'))return 18;
 if(sql.includes('llm_token_usage'))return 25;if(sql.includes('sync_'))return 28;if(sql.includes('cloud_'))return 29;return 0;
}
export function sqlRequestSite(args:Record<string,unknown>):number{
 if(Array.isArray(args.statements)){let fallback=0;for(const item of args.statements){const site=sqlSite(item?.sql);if(site!==1&&site!==8&&site!==0)return site;if(!fallback)fallback=site;}return fallback;}
 return sqlSite(args.sql);
}
