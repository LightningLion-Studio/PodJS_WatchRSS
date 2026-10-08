import {TemporaryOriginalHintStore} from '../settings/temporary-original-hints.ts';
import {hostOperation} from '@podjs/framework/services';
import {createMemo,createSignal,onCleanup,onMount,type Accessor,type JSX} from "solid-js";
import {isImportedContentUrl} from "../core/imported-content.ts";
import type {Article,AppServices} from "./service.ts";
/** Per-open override of the channel default; fetched HTML remains separately cached. */
export function ArticleSource(props:{article:Article;services:AppServices;children:(article:Accessor<Article>,source:{canRead:Accessor<boolean>;enabled:Accessor<boolean>;notice:Accessor<string>;toggle:()=>void})=>JSX.Element}){
 const [enabled,setEnabled]=createSignal(props.article.useOriginalContent??false),[original,setOriginal]=createSignal<Article>(),[loading,setLoading]=createSignal(false),[failure,setFailure]=createSignal("");
 const canRead=()=>!!props.article.link?.trim()&&!isImportedContentUrl(props.article.link);let closed=false;
 async function load(){if(original()||loading())return;setLoading(true);setFailure("");try{const value=await props.services.getOriginalArticle(props.article.id);if(!closed)setOriginal(value);}catch(error){if(!closed)setFailure(String(error));}finally{if(!closed)setLoading(false);}}
 const displayed=createMemo(()=>enabled()&&original()?original()!:props.article);
 const notice=()=>enabled()&&!original()?(failure()?"原文加载失败，正在显示RSS内容":loading()?"原文加载中，正在显示RSS内容":""):"";
 const toggle=()=>{if(!canRead())return;const next=!enabled();setEnabled(next);if(next)void load().then(()=>{
  if(!closed&&!props.article.useOriginalContent&&new TemporaryOriginalHintStore().record(Number(props.article.channelId)))
   void hostOperation('ui.toast',{message:'点击频道标题，可在频道设置中开启原文阅读模式'}).result.catch(()=>{});
 }).catch(()=>{});};
 onMount(()=>{if(enabled()&&canRead())void load();});onCleanup(()=>{closed=true;});
 return <>{props.children(displayed,{canRead,enabled,notice,toggle})}</>;
}
