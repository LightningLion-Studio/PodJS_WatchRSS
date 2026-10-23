import type {SqlDatabase,SqlParams} from '../core/types.ts';
import type {ArticleManifest} from './manifest.ts';
import type {LibraryWindow,PendingSyncSuccess} from './session.ts';
import type {SyncCursor,SyncedSource} from './library-wire.ts';
import {nativeTrim} from './local-manifest.ts';
const WEEK=7*24*60*60*1000;
const exact=(n:number)=>{if(!Number.isSafeInteger(n))throw new Error('Sync sequence exceeds exact integer range');return n;};
export function changeLogStatement(kind:'article'|'rssSource',entityId:string,changedAt:number,deviceId:string,reason:string,createdAt=Date.now()):{sql:string;params:SqlParams}{
 exact(changedAt);exact(createdAt);return {sql:'INSERT INTO sync_change_log(kind,entity_id,changed_at,origin_device_id,reason,created_at) VALUES(?,?,?,?,?,?)',params:[kind,entityId,changedAt,deviceId,reason,createdAt]};
}
/** Durable cursor advancement is an explicit operation called by the session
 * only after the peer confirms application. Ordinary receive commits do not
 * advance either cursor. */
export class SqlLibrarySequenceStore {
 constructor(private readonly db:SqlDatabase,private readonly now=Date.now){}
 private peer(value:string):string{return nativeTrim(value)?value:'phone';}
 async cursor(peer:string):Promise<SyncCursor>{
  const row=(await this.db.query('SELECT COALESCE((SELECT MAX(seq) FROM sync_change_log),0) AS local_max,p.last_local_seq_acked,p.last_remote_seq_applied FROM (SELECT 1) LEFT JOIN sync_peer_state p ON p.peer_device_id=?',[this.peer(peer)]))[0]!;
  return {localMaxSeq:exact(Number(row.local_max)),lastLocalSeqAckedByPeer:exact(Number(row.last_local_seq_acked??0)),lastRemoteSeqApplied:exact(Number(row.last_remote_seq_applied??0))};
 }
 successStatement(pending:PendingSyncSuccess):{sql:string;params:SqlParams}{
  exact(pending.localSeqToInclusive);exact(pending.remoteSeqToInclusive);exact(pending.remoteProtocolVersion);const now=exact(this.now());
  return {sql:`INSERT INTO sync_peer_state(peer_device_id,last_local_seq_acked,last_remote_seq_applied,last_full_sync_at,last_protocol_version,updated_at) VALUES(?,?,?,?,?,?)
   ON CONFLICT(peer_device_id) DO UPDATE SET last_local_seq_acked=max(sync_peer_state.last_local_seq_acked,excluded.last_local_seq_acked),last_remote_seq_applied=max(sync_peer_state.last_remote_seq_applied,excluded.last_remote_seq_applied),last_full_sync_at=CASE WHEN ?=1 THEN excluded.last_full_sync_at ELSE sync_peer_state.last_full_sync_at END,last_protocol_version=excluded.last_protocol_version,updated_at=excluded.updated_at`,
   params:[this.peer(pending.remoteDeviceId),Math.max(0,pending.localSeqToInclusive),Math.max(0,pending.remoteSeqToInclusive),pending.fullSnapshot?now:0,pending.remoteProtocolVersion,now,pending.fullSnapshot?1:0]};
 }
 async markSuccess(pending:PendingSyncSuccess):Promise<void>{const s=this.successStatement(pending);await this.db.execute(s.sql,s.params);}
 async reset():Promise<void>{await this.db.execute('DELETE FROM sync_peer_state');}
 async prepareWindow(peer:string,localDeviceId:string,full:readonly ArticleManifest[],exportSources:(urls?:readonly string[])=>Promise<readonly SyncedSource[]>,peerAppliedLocalSeq?:number,options:{snapshotReconciled?:boolean}={}):Promise<LibraryWindow>{
  const state=(await this.db.query('SELECT * FROM sync_peer_state WHERE peer_device_id=?',[this.peer(peer)]))[0],now=exact(this.now());
  // The production repository has already reconciled exact signatures under
  // the revision guard. Standalone stores retain native timestamp repair.
  if(!options.snapshotReconciled){
  const unique=new Map<string,ArticleManifest>();for(const a of full)if(!a.deleted&&!unique.has(a.articleId)&&Math.max(a.updatedAt,a.independentChangedAt,a.favoriteChangedAt,a.watchLaterChangedAt,a.deletedAt)>0)unique.set(a.articleId,a);
  const repair=[...unique.values()].map(a=>{const changed=exact(Math.max(a.updatedAt,a.independentChangedAt,a.favoriteChangedAt,a.watchLaterChangedAt,a.deletedAt));return {sql:`INSERT INTO sync_change_log(kind,entity_id,changed_at,origin_device_id,reason,created_at) SELECT 'article',?,?,?,'repairState',? WHERE ?>COALESCE((SELECT MAX(changed_at) FROM sync_change_log WHERE kind='article' AND entity_id=?),0)`,params:[a.articleId,changed,nativeTrim(a.sourceDeviceId)?a.sourceDeviceId:localDeviceId,now,changed,a.articleId]};});
  for(let i=0;i<repair.length;i+=512)await this.db.transaction(repair.slice(i,i+512));
  }
  const max=(await this.cursor(peer)).localMaxSeq,cached=Number(state?.last_local_seq_acked??0),acked=peerAppliedLocalSeq===undefined?cached:Math.max(0,exact(peerAppliedLocalSeq));
  const reason=!state?'newPeer':Number(state.last_protocol_version)<13?'peerProtocol':peerAppliedLocalSeq!==undefined&&acked<cached?'peerCursorBehind':peerAppliedLocalSeq!==undefined&&acked>max?'peerCursorAhead':Number(state.last_full_sync_at)<=0?'noFullSnapshot':now-Number(state.last_full_sync_at)>=WEEK?'periodicFull':'';
  if(reason)return {articleManifest:full,fullArticleManifest:full,rssSources:await exportSources(),fullSnapshot:true,fromSeqExclusive:0,toSeqInclusive:max,peerAckedSeq:acked,fallbackReason:reason};
  const articles=new Set<string>(),sources:string[]=[];
  // Page in stable first-change order; cap by the captured maximum so later
  // writes remain eligible for the next exchange and cannot be acknowledged now.
  let last=0;
  while(true){const rows=await this.db.query(`SELECT kind,entity_id,MIN(seq) first_seq FROM sync_change_log WHERE seq>? AND seq<=? GROUP BY kind,entity_id HAVING MIN(seq)>? ORDER BY first_seq LIMIT 400`,[acked,max,last]);if(!rows.length)break;for(const row of rows){last=Number(row.first_seq);if(row.kind==='article')articles.add(String(row.entity_id));else if(row.kind==='rssSource')sources.push(String(row.entity_id));}if(rows.length<400)break;}
  return {articleManifest:full.filter(a=>articles.has(a.articleId)),fullArticleManifest:full,rssSources:await exportSources(sources),fullSnapshot:false,fromSeqExclusive:acked,toSeqInclusive:max,peerAckedSeq:acked,fallbackReason:''};
 }
}
