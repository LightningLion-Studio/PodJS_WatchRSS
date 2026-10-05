import type {SqlParams} from '../core/types.ts';

/** A phone receive can promote a builtin video to the phone-import channel.
 * Keep one active saved entry, on the winning journal row, across those aliases.
 * Ordinary RSS copies keep their existing independent-channel semantics. */
export function externalSavedAliasCleanup(identity:string|number,type?:'favorite'|'watchLater'):{sql:string;params:SqlParams}[]{
  const identityWhere=typeof identity==='number'?'s.article_id IN (SELECT article_id FROM sync_article_aliases WHERE item_id=?)':'s.article_id=?';
  const where=`${identityWhere}${type?' AND s.save_type=?':''} AND s.item_id IS NOT NULL AND old.item_id!=s.item_id
    AND (a.link GLOB 'https://www.douyin.com/video/*' OR a.link GLOB 'https://www.bilibili.com/video/*')`;
  const params=[identity,...(type?[type]:[])];
  return [
    {sql:`UPDATE article_saved_states SET saved=0,changed_at=(SELECT s.changed_at FROM sync_saved_states s JOIN sync_article_aliases old ON old.article_id=s.article_id JOIN articles a ON a.id=old.item_id WHERE ${where} AND old.item_id=article_saved_states.article_id AND s.save_type=article_saved_states.save_type)
      WHERE EXISTS(SELECT 1 FROM sync_saved_states s JOIN sync_article_aliases old ON old.article_id=s.article_id JOIN articles a ON a.id=old.item_id WHERE ${where} AND old.item_id=article_saved_states.article_id AND s.save_type=article_saved_states.save_type)`,params:[...params,...params]},
    {sql:`UPDATE articles SET is_saved=COALESCE((SELECT saved FROM article_saved_states WHERE article_id=articles.id AND save_type='favorite'),0)
      WHERE id IN(SELECT old.item_id FROM sync_saved_states s JOIN sync_article_aliases old ON old.article_id=s.article_id JOIN articles a ON a.id=old.item_id WHERE ${where})`,params},
  ];
}
