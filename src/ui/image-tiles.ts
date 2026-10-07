import {visibleImageTiles as tiles,type ImageTileOptions} from '@podjs/framework/image-tiles';
import type {PreviewGeometry,PreviewState} from './image-preview';
export {imageTileRegion,type ImageTile,type ImageTileRegion} from '@podjs/framework/image-tiles';
export const imageTileOptions:ImageTileOptions={fullResolution:g=>(g.imageWidth<=3072&&g.imageHeight<=3072&&g.imageWidth*g.imageHeight<=2_500_000)||(g.imageWidth<=4096&&g.imageHeight<=4096&&g.imageWidth*g.imageHeight<=12_582_912)};
export function visibleImageTiles(g:PreviewGeometry,state:PreviewState){return tiles(g,state,imageTileOptions);}
