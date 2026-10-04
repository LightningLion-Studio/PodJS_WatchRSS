import {mount} from "@pocketjs/framework/solid";
import {Text,View} from "@pocketjs/framework/components";
import {getDisplayMetrics} from "@podjs/framework/watch";
import {RssSearchScreen} from "../../src/ui/RssSearchScreen.tsx";
import {searchSnippet} from "../../src/rss/search-snippet.ts";

const metrics=getDisplayMetrics(),keyword="同步";
const descriptions=["手机同步后保留收藏状态，正文可以离线阅读。","这段摘要说明同步进度和断线续传。"];
const results=[
  {id:"1",channelId:"1",title:"同步验证：第一篇文章",content:"正文",searchSnippet:searchSnippet(keyword,descriptions[0],"正文",null)},
  {id:"2",channelId:"1",title:"第二篇文章",content:"正文",searchSnippet:searchSnippet(keyword,descriptions[1],"正文",null)}
];
// The production app already uses slot 0 elsewhere. Include it explicitly in
// this isolated fixture so dynamic highlighted-line rendering uses the same atlas.
mount(()=><View class="relative w-full h-full"><Text class="absolute top-[0] left-[0] text-sm" style={{opacity:0}}>字</Text><Text class="absolute top-[0] left-[0] text-[9px]" style={{opacity:0}}>字</Text><RssSearchScreen width={metrics.logicalWidth} height={metrics.logicalHeight} active={true} keyword={keyword} results={results} loading={false} onInput={()=>{}} onKeywordChange={()=>{}} onOpen={()=>{}}/></View>);
