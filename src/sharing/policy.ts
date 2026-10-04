import {wireFields} from '../sync/article-batches.ts';
export type ShareOrigin='channel'|'bili-detail'|'detail';
export type ShareInput={origin:ShareOrigin;title:string;link?:string|null};
export function systemShareSupported(environment:{sdkInt:number;wearOs:boolean}|null|undefined):boolean {return !!environment&&environment.sdkInt>=31&&!environment.wearOs;}
/** The two native helpers intentionally differ: detail rejects blank title and retains raw text. */
export function nativeShareText(input:ShareInput):string|null {
 const trimmed=input.origin!=='detail',title=trimmed?wireFields.trim(input.title):input.title,link=trimmed?wireFields.trim(input.link??''):input.link??'';
 if(trimmed){if(!title&&!link)return null;return title&&link?title+'\n'+link:title||link;}
 if(!wireFields.trim(title))return null;return wireFields.trim(link)?title+'\n'+link:title;
}
export function qrShareInput(input:ShareInput):{title:string;link:string}|null {const link=wireFields.trim(input.link??'');return link?{title:wireFields.trim(input.title),link}:null;}
export function biliShareLink(bvid:string|undefined,aid:string|number|undefined):string|null {const bv=wireFields.trim(bvid??'');return bv?'https://www.bilibili.com/video/'+bv:aid===undefined?null:'https://www.bilibili.com/video/av'+aid;}
export function biliActionTitle(title:string|undefined,bvid:string|undefined,aid:string|number|undefined):string {const bv=wireFields.trim(bvid??'');return wireFields.trim(title??'')||(bv?'BV号 '+bv:aid===undefined?'哔哩哔哩视频':'av'+aid);}
export function douyinShareLink(id:string):string|null {const value=wireFields.trim(id);return value?'https://www.douyin.com/video/'+value:null;}
/** Native action rows allow title-only system sharing, but QR sharing requires a nonblank link. */
export function shareActionEnabled(title:string,link:string|null|undefined,useSystem:boolean):boolean {
 return !!wireFields.trim(link??'')||(useSystem&&!!wireFields.trim(title));
}
export type ShareHandler=(input:ShareInput,showQr:()=>void)=>void;
export async function routeShare(input:ShareInput,useSystem:boolean,ports:{text:(text:string)=>Promise<unknown>;qr:()=>void;unavailable?:()=>void}):Promise<'system'|'qr'|'none'>{
 if(useSystem){const text=nativeShareText(input);if(text===null)return 'none';await ports.text(text);return 'system';}
 if(!qrShareInput(input)){ports.unavailable?.();return 'none';}ports.qr();return 'qr';
}

export const CHANNEL_SHARE_QR_HINT='请在扫码后选择分享给RSS阅读器\n或复制链接粘贴到RSS阅读器里';
export function shareQrPresentation(title:string,link:string,topHint?:string){
 return {title:wireFields.trim(title)||'扫码分享',link:wireFields.trim(link),subtitle:wireFields.trim(topHint??'')||wireFields.trim(link)};
}
