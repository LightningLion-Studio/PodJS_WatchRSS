import {rectInsideCircle,safeTopBlock,type QrRect} from '@podjs/framework/watch-ui';
import {measuredLines,type TextMeasurer} from '../../reader/measured-text.ts';

export interface DouyinEntryState {
 auth:'unknown'|'logged-in'|'logged-out';
 hasItems:boolean;
 busy:boolean;
 slow:boolean;
 error:string;
}
/** One status slot: a failure always replaces loading and navigation instructions. */
export function douyinEntrySubtitle(state:DouyinEntryState):string {
 if(state.error)return state.error;
 if(state.auth==='unknown'&&!state.hasItems)return '正在读取登录状态…';
 if(state.auth==='logged-out')return '需要登录，请重新登录';
 if(state.busy&&state.slow)return '内容加载较慢，请稍候';
 if(state.busy&&!state.hasItems)return '刷新中...';
 return state.hasItems?'下拉刷新，向上进入短视频流':'暂无内容，下拉刷新或点箭头重试';
}
export const entrySubtitleLine=(text:string,width:number,measure:TextMeasurer)=>measuredLines(text.replace(/\s*\n\s*/g,' '),width,measure,1)[0]??'';

/** 233 logical units = 466px at density 2. The caller scales this entire composition,
 * including fonts and the notice. All bounds include backgrounds and touch targets. */
export function douyinEntryLayout(titleWidth:number,noticeHeight:(width:number)=>number,showNotice=true){
 const circle={cx:116.5,cy:116.5,radius:116.5},gap=8;
 const heights=new Map<number,number>();
 const heightForWidth=(width:number)=>{let value=heights.get(width);if(value===undefined){value=noticeHeight(width);heights.set(width,value);}return value;};
 const centered=(width:number,y:number,height:number):QrRect=>({x:(233-width)/2,y,width,height});
 // Shorter chords can wrap the notice. Move the heading up only if the full column needs room.
 for(let top=18;top>=8;top--){
  const title=centered(titleWidth+7+19.2,top,26);
  if(!rectInsideCircle(title,circle))continue;
  const subtitle=safeTopBlock(233,233,()=>14,{minTop:top+28,maxWidth:197,margin:1});
  if(!subtitle)continue;
  const notice=safeTopBlock(233,233,heightForWidth,{minTop:subtitle.y+subtitle.height+8,maxWidth:197,minWidth:180,margin:1});
  if(!notice)continue;
  const retry=centered(103,showNotice?notice.y+notice.height+gap:notice.y,36);
  const arrowY=Math.max(175,retry.y+retry.height+gap);
  // Keep the original visual circles. The transparent target must also fit inside the circle.
  const arrow=[72,64,56,50].map(width=>centered(width,arrowY,50)).find(rect=>rectInsideCircle(rect,circle));
  if(arrow&&rectInsideCircle(retry,circle))return {title,subtitle,notice:showNotice?notice:undefined,retry,arrow,gap};
 }
 throw new Error('Douyin entry column does not fit the round viewport');
}
export const entryRectStyle=(rect:QrRect)=>({insetL:rect.x,insetT:rect.y,width:rect.width,height:rect.height});
