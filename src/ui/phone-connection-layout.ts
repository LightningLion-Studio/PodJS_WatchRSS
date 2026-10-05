import {watchUiLines} from './text-layout.ts';
/** BluetoothConnectionActivity.kt / PhoneConnectionUnavailableActivity.kt;
 * Type.kt: titleMedium 21/26, bodyMedium 14/17, bodySmall 12/14.
 * Material3 Button: 24 horizontal inset, 40 visual / 48 touch height. */
export const PHONE_PAGE={padding:18,gap:8,titleSize:21,titleLine:26,bodySize:14,bodyLine:17,smallSize:12,smallLine:14,foreground:'#f5f5f5',secondary:'#b6b6b6',primary:'#ff6026',onPrimary:'#000000',buttonHeight:40,touchHeight:48,progressSize:40,progressStroke:4} as const;
export type PhoneTextKind='title'|'body'|'small';
export function phonePageText(text:string,kind:PhoneTextKind,width:number,measure:(text:string,slot:number)=>number){
 const slot=kind==='title'?23:kind==='body'?1:0;
 const lineHeight=kind==='title'?26:kind==='body'?17:14;
 const lines=watchUiLines(text,{width:Math.max(1,width),measure:value=>measure(value,slot)});
 return {text:lines.join('\n'),height:lines.length*lineHeight,slot,lineHeight,color:kind==='small'?PHONE_PAGE.secondary:PHONE_PAGE.foreground};
}
