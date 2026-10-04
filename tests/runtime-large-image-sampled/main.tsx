import {mount} from '@pocketjs/framework/solid';
import {View} from '@pocketjs/framework/components';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {TiledImage} from '../../src/ui/TiledImage.tsx';

const metrics=getDisplayMetrics();
let overviewAt=0;
mount(()=><View class="absolute inset-0 bg-black"><TiledImage
  url="large-sampled.jpg" filePath="large-sampled.jpg"
  geometry={{width:metrics.logicalWidth,height:metrics.logicalHeight,imageWidth:2053,imageHeight:1027,density:metrics.density}}
  state={{scale:1,x:0,y:0}}
  onSize={(width,height)=>{overviewAt=Date.now();kv.set('large-image-sampled-result',{state:'loaded',width,height});}}
  onVisibleTilesReady={()=>kv.set('large-image-sampled-result',{state:'tiles-ready',width:2053,height:1027,overviewToTilesMs:Date.now()-overviewAt})}
  onError={error=>kv.set('large-image-sampled-result',{state:'failed',error:String(error)})}
/></View>);
