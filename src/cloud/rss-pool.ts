import {WatchCloudClient} from './client';
import {WatchTokenManager} from '../account/token';
import type {WatchAccountStore} from '../account/store';
import type {HttpTransport,RssInventory} from './types';
/** Public cache access needs watch login, not account-key approval or cloud consent. */
export async function resolvePoolFeed(accounts:WatchAccountStore,transport:HttpTransport,url:string,appVersion:string,signal?:{cancelled:boolean}){
 const account=await accounts.read();if(!account)throw Error('请先连接手机并绑定账号以添加公共 RSS');
 const tokens=new WatchTokenManager(accounts,{backendBaseUrl:account.backendBaseUrl,transport,appVersion});
 const current=async()=>{if(signal?.cancelled)throw Error('刷新已取消');const next=await accounts.read();if(!next||next.userId!==account.userId||next.backendBaseUrl!==account.backendBaseUrl)throw Error('账号已变更');};
 const client=new WatchCloudClient({request:async r=>{await current();const response=await transport.request(r);await current();return response;}},{baseUrl:account.backendBaseUrl,accessToken:account.watchDeviceToken,appVersion,refreshToken:account.watchRefreshToken?async (force,rejectedAccessToken)=>{await current();return tokens.freshAccessToken(force,rejectedAccessToken);}:undefined},{sha256:()=>{throw Error('unused_public_pool_hash');}},{require(){}});
 await current();const inventory=await client.resolveRssSource(url);await current();return inventory;
}
const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
/** Reuse the local feed parser/dedup pipeline; this XML never enters personal cloud. */
const enclosure=(url:string|null|undefined,type:string)=>url?'<enclosure url="'+escape(url)+'" type="'+type+'"/>':'';
export function poolFeedXml(source:RssInventory){return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:watchrss="https://watchrss.local/rss-pool"><channel><title>'+escape(source.title)+'</title><description>'+escape(source.description)+'</description>'+(source.imageUrl?'<image><url>'+escape(source.imageUrl)+'</url></image>':'')+source.items.map(a=>'<item>'+(a.dedupKey?'<watchrss:dedup-key>'+escape(a.dedupKey)+'</watchrss:dedup-key>':'')+'<guid>'+escape(a.guid)+'</guid><link>'+escape(a.url)+'</link><title>'+escape(a.title)+'</title><description>'+escape(a.excerpt)+'</description><content:encoded>'+escape(a.contentHtml??a.contentText)+'</content:encoded>'+(a.publishedAt?'<pubDate>'+escape(a.publishedAt)+'</pubDate>':'')+enclosure(a.audioUrl,'audio/mpeg')+enclosure(a.videoUrl,'video/mp4')+enclosure(a.imageUrl,'image/jpeg')+'</item>').join('')+'</channel></rss>';}
