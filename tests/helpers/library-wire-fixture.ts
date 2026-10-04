import fixture from '../fixtures/library-wire-android.json';
import {decodeChunkData,type JsonObject} from '../../src/sync/protocol.ts';
import type {PreparedArticle,ExportedArticle} from '../../src/sync/article-export.ts';
import type {ArticleManifest} from '../../src/sync/manifest.ts';
import type {RequestedArticleBody} from '../../src/sync/article-batches.ts';
export {fixture};
export type LibraryWireCase=(typeof fixture.cases)[number];
export function wireFixtureBody(length:number):string {let x=123456789;const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';const out:string[]=[];for(let i=0;i<length;i++){x=(Math.imul(x,1664525)+1013904223)>>>0;out.push(i%257===0?'文😀':alphabet[x>>>26]!);}return out.join('');}
export function wireFixtureParts(row:LibraryWireCase):{prepared:PreparedArticle[];requests:RequestedArticleBody[]}{
 const contentText=wireFixtureBody(row.input.length);
 const prepared=row.prepared.map(p=>{const {body,...fields}=p.article as JsonObject;const article={imageUrl:null,rssSourceUrl:null,rssSourceTitle:null,...fields,contentHtml:null,contentText} as ExportedArticle,b=body as JsonObject;
  const manifest:ArticleManifest={articleId:article.articleId,sourceDeviceId:article.sourceDeviceId,contentHash:article.contentHash,updatedAt:article.updatedAt,independentChangedAt:article.independentChangedAt,favoriteChangedAt:article.favoriteChangedAt,watchLaterChangedAt:article.watchLaterChangedAt,deletedAt:article.deletedAt,deleted:article.deleted,bodyHash:String(b.bodyHash),bodyByteCount:Number(b.bodyByteCount),chunkSize:Number(b.chunkSize),chunkHashes:b.chunkHashes as string[],metadataHash:p.metadataHash,bodyAvailable:true,bodySyncMode:'full',readingProgress:Math.fround(article.readingProgress),readingPositionBytes:article.readingPositionBytes,readingPositionContentHash:article.readingPositionContentHash,readingPositionChangedAt:article.readingPositionChangedAt,isRead:article.isRead};
  article.readingProgress=Math.fround(article.readingProgress);return {article,manifest,encodedBody:decodeChunkData(p.encodedBase64)};
 });return {prepared,requests:row.requests};
}
