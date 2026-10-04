import {mount} from "@pocketjs/framework/solid";
import {getDisplayMetrics} from "@podjs/framework/watch";
import {SavedItemsScreen} from "../../src/ui/SavedItemsScreen.tsx";
const metrics=getDisplayMetrics();
mount(()=><SavedItemsScreen width={metrics.logicalWidth} height={metrics.logicalHeight} active={true} type="favorite" items={[{key:"rss:1",kind:"rss",title:"同步验证：第一篇文章",summary:"正文可以离线阅读。",channelTitle:"科技频道",savedAt:1790280000000,sortOrder:0,articleId:"1"}]} loading={false} undoVisible={false} onOpen={()=>{}} onRemove={()=>{}} onUndo={()=>{}} onReorder={()=>{}} onError={()=>{}}/>);
