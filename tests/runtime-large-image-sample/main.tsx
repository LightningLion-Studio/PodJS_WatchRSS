import {mount} from '@pocketjs/framework/solid';
import {View} from '@pocketjs/framework/components';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {TiledImage} from '../../src/ui/TiledImage.tsx';

const metrics=getDisplayMetrics();
mount(()=><View class="absolute inset-0 bg-black"><TiledImage
  url="large-image.jpg" filePath="large-image.jpg"
  geometry={{width:metrics.logicalWidth,height:metrics.logicalHeight,imageWidth:1031,imageHeight:513,density:metrics.density}}
  state={{scale:1,x:0,y:0}}
  onSize={(width,height)=>kv.set('large-image-sample-result',{state:'loaded',width,height})}
  onError={error=>kv.set('large-image-sample-result',{state:'failed',error:String(error)})}
/></View>);
