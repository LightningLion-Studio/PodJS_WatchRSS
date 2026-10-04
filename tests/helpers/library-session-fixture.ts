import fixture from '../fixtures/library-session-android.json';
import {LibrarySyncSession,type LibrarySessionRepository,type LibrarySessionOptions,type PendingSyncSuccess,type SessionActionResult} from '../../src/sync/session.ts';
import {parseArticleManifest} from '../../src/sync/manifest.ts';
import {parseChangeSequence,parseSources} from '../../src/sync/library-wire.ts';
import {decodeChunkData,type JsonObject} from '../../src/sync/protocol.ts';
import type {PreparedArticle,ExportedArticle} from '../../src/sync/article-export.ts';
export {fixture};
export type SessionCase=(typeof fixture.cases)[number];
export function normalizeSessionResponse(value:unknown):unknown {
 if(Array.isArray(value))return value.map(normalizeSessionResponse);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='sentAt').map(([key,v])=>[key,key==='message'&&(value as JsonObject).errorCode==='library_exchange_failed'?'exchange failed':normalizeSessionResponse(v)]));return value;
}
export function sessionFixtureParts(row:SessionCase){
 const frame=row.preparedWindow as JsonObject,full=parseArticleManifest(frame),sources=parseSources(frame),range=parseChangeSequence(frame);
 const articles:PreparedArticle[]=row.preparedArticles.map(r=>{const wire=r.wireArticle as JsonObject,{body,...fields}=wire;return {article:{imageUrl:null,rssSourceUrl:null,rssSourceTitle:null,...fields,contentHtml:r.contentHtml,contentText:r.contentText} as ExportedArticle,manifest:full.find(a=>a.articleId===fields.articleId)!,encodedBody:decodeChunkData(r.encodedBase64)};});
 return {window:{...range,articleManifest:full,fullArticleManifest:full,rssSources:sources,peerAckedSeq:0},articles};
}
export async function replaySessionFixture(row:SessionCase,modify?:(repo:LibrarySessionRepository,options:LibrarySessionOptions)=>void){
 const {window,articles}=sessionFixtureParts(row);const inbound=structuredCopy(row.inbound) as JsonObject[],outbound:JsonObject[]=[],actions:SessionActionResult[]=[],marks:PendingSyncSuccess[]=[],events:string[]=[],timeouts:number[]=[];let closed=false,index=0;
 const repo:LibrarySessionRepository={deviceId:async()=>row.deviceId,cursor:async()=>row.beforeCursor,mergeSources:async()=>{events.push('mergeSources');return 0;},prepareWindow:async()=>{events.push('prepare');return window;},exportSources:async()=>window.rssSources,receiveArticle:async()=>{throw new Error('Unexpected incoming article');},exportRequested:async requests=>{events.push('export');const ids=new Set(requests.map(r=>r.articleId));return articles.filter(a=>ids.has(a.article.articleId));},finalizeSnapshot:async()=>{events.push('finalize');},resetPeerState:async()=>{events.push('reset');},markSuccess:async pending=>{events.push('mark');marks.push(pending);}};
 const probe=(row.outbound as JsonObject[]).find(f=>f.phase==='probe');const options:LibrarySessionOptions={now:()=>1789340000000,watchCapabilities:probe?.watchCapabilities as JsonObject|undefined,capabilities:{supportsReaderPresets:true,supportsReaderAssets:true,supportsResourceChunkAck:true,supportsReaderPresetPreview:true},onActionCompleted:r=>actions.push(r)};modify?.(repo,options);
 const connection={readFrame:async(timeout:number)=>{timeouts.push(timeout);const next=inbound[index++];if(!next)throw new Error('EOF');events.push('read:'+String(next.action)+':'+String(next.phase));return next;},writeFrame:async(frame:JsonObject)=>{outbound.push(structuredCopy(frame));events.push('write:'+String(frame.phase));},close:async()=>{closed=true;}};
 const session=new LibrarySyncSession(connection,repo,options),results=await session.run();
 const pending=marks.at(-1),peer=pending?{localSeq:pending.localSeqToInclusive,remoteSeq:pending.remoteSeqToInclusive,protocol:pending.remoteProtocolVersion,fullSync:pending.fullSnapshot}:null;
 return {outbound,results,peer,events,timeouts,closed,unread:Math.max(0,inbound.length-index),actions,marks};
}
function structuredCopy<T>(value:T):T{return JSON.parse(JSON.stringify(value));}
