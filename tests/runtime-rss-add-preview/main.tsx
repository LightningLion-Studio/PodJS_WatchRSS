import {mount} from "@pocketjs/framework/solid";
import {getDisplayMetrics} from "@podjs/framework/watch";
import {AddRssScreen} from "../../src/ui/AddRssScreen.tsx";
const metrics=getDisplayMetrics();
mount(()=><AddRssScreen width={metrics.logicalWidth} height={metrics.logicalHeight} active={true} initialUrl="https://example.com/feed.xml" initialPreview={{kind:"ready",token:"fixture",url:"https://example.com/feed.xml",title:"示例频道",description:"每天更新的技术文章"}} input={async()=>null} onAdded={()=>{}} onExisting={()=>{}}/>);
