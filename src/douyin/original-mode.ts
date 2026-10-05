import type { SqlDatabase } from "../core/types.ts";

export const DOUYIN_ORIGINAL_MODE_KEY = "watchrss.douyin.original-content";
export const douyinOriginalContentEnabled = (channel?: {useOriginalContent?: boolean}) => channel?.useOriginalContent ?? true;

/** A persisted channel preference wins, including explicit false. Never revive deleted channels. */
export async function migrateDouyinOriginalMode(db: SqlDatabase, store: {get<T>(key:string):T|undefined;delete(key:string):void}) {
  const legacy=store.get<unknown>(DOUYIN_ORIGINAL_MODE_KEY);
  await db.execute(`INSERT OR IGNORE INTO source_preferences(channel_id,use_original_content)
    SELECT id,? FROM channels WHERE url='builtin:douyin'`,[typeof legacy==="boolean"?(legacy?1:0):1]);
  // Remove only after the database write succeeds; an interrupted migration is safe to repeat.
  store.delete(DOUYIN_ORIGINAL_MODE_KEY);
}
