import {mount} from "@pocketjs/framework/solid";
import {getDisplayMetrics} from "@podjs/framework/watch";
import {SavedItemsScreen} from "../../src/ui/SavedItemsScreen.tsx";
const metrics=getDisplayMetrics();
mount(()=><SavedItemsScreen width={metrics.logicalWidth} height={metrics.logicalHeight} active={true} type="favorite" items={[]} loading={false} undoVisible={false} onOpen={()=>{}} onRemove={()=>{}} onUndo={()=>{}} onReorder={()=>{}} onError={()=>{}}/>);
