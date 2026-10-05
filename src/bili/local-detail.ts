import type { SqlDatabase } from '../core/types.ts';
import { localBiliDetail, type DetailTarget } from './detail.ts';
/** Read B2's existing article rows, including rows restored by phone sync. */
export async function readLocalBiliDetail(db: SqlDatabase, target: DetailTarget) {
  const identities = [target.bvid, target.aid ? `av${target.aid}` : undefined].filter((v): v is string => !!v);
  if (!identities.length) return;
  const rows = await db.query(`SELECT title,link,description,content,image_url FROM articles WHERE ${identities.map(() => 'instr(lower(link),?)>0').join(' OR ')} ORDER BY fetched_at DESC`, identities.map(id => `/video/${id.toLowerCase()}`));
  for (const row of rows) {
    const detail = localBiliDetail({ title: String(row.title ?? ''), link: row.link as string, description: row.description as string, content: row.content as string, imageUrl: row.image_url as string }, target);
    if (detail) return detail;
  }
}
