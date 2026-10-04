import {mount} from '@pocketjs/framework/solid';
import {getDisplayMetrics,kv} from '@podjs/framework/watch';
import {ImagePreviewScreen} from '../../src/ui/ImagePreviewScreen.tsx';

const metrics=getDisplayMetrics();
kv.set('image-failure-metrics',metrics);
mount(()=><ImagePreviewScreen url="/missing-local-image-preview.jpg" filePath="missing-local-image-preview.jpg"
  width={metrics.logicalWidth} height={metrics.logicalHeight} density={metrics.density} active={true}
  onExit={()=>{}} onBackGesture={()=>{}}/>);
