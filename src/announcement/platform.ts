import {DisclosureSession,type DisclosureStorage} from '@podjs/framework/disclosure';
export type ThirdPartyPlatform='哔哩哔哩'|'抖音';
export const INITIAL_DISCLOSURE_KEY='watchrss.transparency.initial_app_disclosure_v1';
export const initialDisclosure={title:'使用前说明',paragraphs:[
 '本 App 由第三方开发者及社区用户贡献，与哔哩哔哩无合作关系，哔哩哔哩是上海宽娱数码科技有限公司的商标。',
 '本 App 不是哔哩哔哩的替代品，建议能使用官方客户端时尽量使用官方客户端。',
 '本 App 均使用来源于网络的公开信息进行开发。',
 '本 App 中和 B 站相关的功能完全免费。',
 '本 App 中所呈现的 B 站内容来自哔哩哔哩官方。'],confirm:'我已了解',dismissible:false} as const;
export function platformDisclosure(platform:ThirdPartyPlatform){return {title:'使用前说明',paragraphs:[
 `本 App 与${platform}及其关联公司或子公司不存在任何关联，也未获其授权、维护、赞助或认可。`,
 `这是独立且非官方的软件，使用风险由您自行承担。平台账号、内容和平台规则由${platform}独立管理。`],confirm:'知道了，继续',dismissible:false} as const;}
export function platformNotice(platform:ThirdPartyPlatform,compact=false){return {title:'腕上RSS提供的第三方平台功能',paragraphs:[
 `这是腕上RSS连接${platform}的精选功能，不是${platform}官方客户端。`,
 ...(!compact?[`平台账号、平台会员和内容规则由${platform}独立管理；当前支持范围不因¥6手机版设备授权而改变。`]:[])],compact};}
export const platformScope={title:'当前支持范围',paragraphs:[
 '已提供：精选频道浏览、搜索、视频播放、收藏与稍后再看。',
 '平台账号相关操作受账号权限、接口和内容规则影响；当前未提供的官方客户端能力，不等于付费后解锁。',
 '只有明确标注‘需要手机版设备授权’的功能才与¥6有关；其余平台功能与这笔付款无关。']};
export const accessBoundary={title:'手机版设备授权包',paragraphs:[
 '¥6主要用于小说、备忘录和手机与手表协同，不是哔哩哔哩或抖音会员，也不会提升播放速度或清晰度。',
 'WatchRSS云会员与平台会员分别由WatchRSS和对应平台管理。']};
export type PlatformNoticeTarget={page:'oobe'|'home'}|{page:'bili'|'douyin';name:string}|{page:'video';platform:'bili'|'douyin'|'rss'}|{page:'account-status'};
/** Modal route descriptor only: lead owns rendering, including dialog priority.
 * Create once per Activity/route, retain while returning from child pages. */
export function createPlatformNoticeRoute(storage:DisclosureStorage,target:PlatformNoticeTarget){
 const platform:ThirdPartyPlatform|undefined=target.page==='bili'||target.page==='video'&&target.platform==='bili'?'哔哩哔哩':target.page==='douyin'||target.page==='video'&&target.platform==='douyin'?'抖音':undefined;
 const entry=(target.page==='bili'||target.page==='douyin')&&target.name==='entry';
 const initial=entry||target.page==='home'||target.page==='oobe';
 const session=initial?new DisclosureSession(storage,INITIAL_DISCLOSURE_KEY,entry):undefined;
 const notice=platform?platformNotice(platform,true):undefined;
 const notices=target.page==='account-status'?[platformNotice('哔哩哔哩',true),platformNotice('抖音',true)]:notice?[notice]:[];
 return {kind:'platform-notice' as const,target,notice,notices,
  scope:(target.page==='bili'||target.page==='douyin')&&target.name==='channel-info'?platformScope:undefined,
  access:target.page==='account-status'?accessBoundary:undefined,
  pending(homeNoticeVisible=false){const pending=session?.pending(target.page==='home'&&homeNoticeVisible);return pending==='initial'?initialDisclosure:pending==='platform'&&platform?platformDisclosure(platform):undefined;},
  acknowledge(){session?.acknowledge();},dismiss(){return false;}};
}
