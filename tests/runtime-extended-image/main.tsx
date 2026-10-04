import {mount} from '@pocketjs/framework/solid';
import {View} from '@pocketjs/framework/components';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {TiledImage} from '../../src/ui/TiledImage.tsx';

const metrics=getDisplayMetrics();
let overviewAt=0;
const timings:{decodeMs:number;readMs:number;uploadMs:number;bytes:number}[]=[];
mount(()=><View class="absolute inset-0 bg-black"><TiledImage
  url="extended-image.jpg" filePath="extended-image.jpg"
  geometry={{width:metrics.logicalWidth,height:metrics.logicalHeight,imageWidth:4096,imageHeight:3072,density:metrics.density}}
  state={{scale:1,x:0,y:0}}
  onSize={(width,height)=>{overviewAt=Date.now();kv.set('extended-image-result',{state:'loaded',width,height});}}
  onTileTiming={timing=>timings.push(timing)}
  onVisibleTilesReady={()=>kv.set('extended-image-result',{state:'tiles-ready',width:4096,height:3072,overviewToTilesMs:Date.now()-overviewAt,timings})}
  onError={error=>kv.set('extended-image-result',{state:'failed',error:String(error)})}
/></View>);
