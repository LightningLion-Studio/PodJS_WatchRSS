import {WatchConfirmDialog} from "@podjs/framework/watch-ui";
import {getOps} from "@pocketjs/framework/host";
import {measuredLines} from "../reader/measured-text.ts";

export function DeleteConfirmDialog(props:{width:number;height:number;title:string;message:string;busy:boolean;onConfirm:()=>void;onCancel:()=>void}) {
 return <WatchConfirmDialog {...props}
  measureLines={message=>measuredLines(message,193,text=>getOps().measureText(text,22),20)}
  cancel={{icon:"../assets/icons/close.svg",label:"取消删除",class:"absolute rounded-[9999] bg-[#23272a]"}}
  confirm={{icon:"../assets/icons/delete-forever.svg",label:"确认删除",class:"absolute rounded-[9999] bg-[#e54d4d]"}}/>;
}
