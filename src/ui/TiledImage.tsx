import {TiledImage as FrameworkTiledImage} from '@podjs/framework/tiled-image';
import {managedCache} from '../cache/host';
import {imageTileOptions} from './image-tiles';
type Props=Omit<Parameters<typeof FrameworkTiledImage>[0],'sourceProvider'|'tileOptions'|'decodeOptions'|'messages'>;
export function TiledImage(props:Props){return <FrameworkTiledImage {...props} sourceProvider={{acquire:url=>managedCache.acquire(url,{},true)}} tileOptions={imageTileOptions} decodeOptions={{applyExif:false,rgb565:true}} messages={{size:'图片纹理尺寸无效',data:'图片数据不完整',upload:'图片纹理创建失败'}}/>;}
