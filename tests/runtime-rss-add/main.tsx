import {mount} from "@pocketjs/framework/solid";
import {getDisplayMetrics} from "@podjs/framework/watch";
import {AddRssScreen} from "../../src/ui/AddRssScreen.tsx";

const metrics=getDisplayMetrics();
mount(()=><AddRssScreen width={metrics.logicalWidth} height={metrics.logicalHeight}
  active={true} initialUrl="https://example.com/feed.xml"
  input={async()=>null} onAdded={()=>{}} onExisting={()=>{}}/>);
