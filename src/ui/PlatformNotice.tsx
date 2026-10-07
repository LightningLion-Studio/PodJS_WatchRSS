import {For,Show,onCleanup} from 'solid-js';
import {FocusScope,Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {watchUiLines} from './text-layout.ts';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';

/** Native ThirdPartyPlatformNotice.kt. Notice: surfaceVariant #23272A at .72, 12dp radius,
 * 10dp horizontal padding; compact 6dp vertical / 2dp rows, title labelSmall 9/11 SemiBold,
 * description bodySmall 12/14 #B6B6B6, all centred. Scope/access cards: same colour at .46,
 * 10x8dp padding, 3dp rows, title bodyMedium 14/17 SemiBold, body labelSmall 9/11. */
type Copy={title:string;paragraphs:readonly string[]};
type DialogList=Pick<import('@pocketjs/framework/virtual-list').VirtualListHandle,'scroller'>;
const ON_SURFACE='#f5f5f5',MUTED='#b6b6b6',PRIMARY='#ff6026';
const NOTICE_BG='#23272ab8',CARD_BG='#23272a75';
const LABEL_SLOT=24,LABEL_BODY_SLOT=19,SMALL_SLOT=0,CARD_TITLE_SLOT=8,BODY_SLOT=1,DIALOG_TITLE_SLOT=10;
const wrap=(text:string,width:number,slot:number)=>watchUiLines(text,{width:Math.max(1,width),measure:value=>getOps().measureText(value,slot)});

/** Stacks wrapped paragraphs: returns each block's top and the bottom edge. */
function stack(start:number,gap:number,blocks:string[][],lineHeight:number) {
 let y=start;const tops=blocks.map((lines,i)=>{if(i)y+=gap;const top=y;y+=lines.length*lineHeight;return top;});
 return {tops,bottom:y};
}

/** Compact persistent relationship label, laid out for the given outer width. */
export function platformNoticeEntry(width:number,notice:Copy):ScrollEntry {
 const inner=width-20,title=wrap(notice.title,inner,LABEL_SLOT),body=notice.paragraphs.map(text=>wrap(text,inner,SMALL_SLOT));
 const {tops,bottom}=stack(6+title.length*11+2,2,body,14);
 return {height:bottom+6,render:()=> <View class="absolute inset-0 rounded-[12]" style={{bgColor:NOTICE_BG}} accessibilityLabel={[notice.title,...notice.paragraphs].join('，')}>
  <Text class="absolute left-[10] right-[10] top-[6] text-[9px] font-bold leading-[11] text-center" style={{textColor:ON_SURFACE}}>{title.join('\n')}</Text>
  <For each={body}>{(lines,i)=> <Text class="absolute left-[10] right-[10] text-xs leading-[14] text-center" style={{insetT:tops[i()],textColor:MUTED}}>{lines.join('\n')}</Text>}</For>
 </View>};
}

/** Scope/access card (ThirdPartyPlatformScopeCard / WatchRssAccessBoundaryCard). */
export function platformCardEntry(width:number,card:Copy):ScrollEntry {
 const inner=width-20,body=card.paragraphs.map(text=>wrap(text,inner,LABEL_BODY_SLOT));
 const {tops,bottom}=stack(8+17+3,3,body,11);
 return {height:bottom+8,render:()=> <View class="absolute inset-0 rounded-[12]" style={{bgColor:CARD_BG}} accessibilityLabel={[card.title,...card.paragraphs].join('，')}>
  <Text class="absolute left-[10] right-[10] top-[8] text-sm font-bold leading-[17]" style={{textColor:ON_SURFACE}}>{card.title}</Text>
  <For each={body}>{(lines,i)=> <Text class="absolute left-[10] right-[10] text-[9px] leading-[11]" style={{insetT:tops[i()],textColor:MUTED}}>{lines.join('\n')}</Text>}</For>
 </View>};
}

/** Blocking first-use / platform confirmation (native AlertDialog with empty onDismiss).
 * Full-screen and pure black on the round display; crown scrolls long copy; Back is swallowed by the owner. */
export function TransparencyDialog(props:{width:number;height:number;copy:Copy&{confirm:string};onConfirm:()=>void;ref?:(list:DialogList|undefined)=>void}) {
 onCleanup(()=>props.ref?.(undefined));
 const inner=()=>props.width-36;
 const entries=():ScrollEntry[]=>{
  const title=wrap(props.copy.title,inner(),DIALOG_TITLE_SLOT);
  const rows:ScrollEntry[]=[{height:title.length*23+6,render:()=> <Text class="absolute left-[0] right-[0] top-[0] text-lg font-bold leading-[23] text-center" style={{textColor:ON_SURFACE}}>{title.join('\n')}</Text>}];
  for(const paragraph of props.copy.paragraphs){
   const lines=wrap(paragraph,inner(),BODY_SLOT);
   rows.push({height:lines.length*20,render:()=> <Text class="absolute left-[0] right-[0] top-[0] text-sm leading-[20]" style={{textColor:ON_SURFACE}}>{lines.join('\n')}</Text>});
  }
  const pill=Math.min(160,inner()-18);
  rows.push({height:48+4,render:()=> <View class="absolute top-[4] h-[48] rounded-[24] items-center justify-center" style={{insetL:(inner()-pill)/2,width:pill,bgColor:PRIMARY}}
   focusable accessibilityRole="button" accessibilityLabel={props.copy.confirm} onPress={props.onConfirm}>
   <Text class="text-[17px] leading-[23] text-[#000000]">{props.copy.confirm}</Text>
  </View>});
  return rows;
 };
 return <FocusScope class="absolute inset-0 z-30 bg-[#000000]" accessibilityLabel={props.copy.title}>
  <ScrollEntries height={props.height} entries={entries()} padding={18} verticalPadding={40} gap={10} accessibilityLabel={props.copy.title} ref={props.ref}/>
 </FocusScope>;
}

/** Owner-side helper: shows whichever disclosure the route still owes, in native order. */
export function PendingDisclosure(props:{width:number;height:number;pending:()=>(Copy&{confirm:string})|undefined;onConfirm:()=>void;ref?:(list:DialogList|undefined)=>void}) {
 return <Show when={props.pending()} keyed>{copy=> <TransparencyDialog width={props.width} height={props.height} copy={copy} onConfirm={props.onConfirm} ref={props.ref}/>}</Show>;
}
