import {expect,test} from "bun:test";
import {visibleImageTiles,imageTileRegion} from "../src/ui/image-tiles.ts";
import {previewMaxScale,previewRange} from "../src/ui/image-preview.ts";
test("zoom selects original pixels and pans select the corresponding region",()=>{
 const g={width:233,height:233,imageWidth:4096,imageHeight:2048,density:2};
 const fit=visibleImageTiles(g,{scale:1,x:0,y:0});
 expect(fit.length).toBe(45);
 expect(fit.every(tile=>tile.sampleSize===1)).toBe(true);
 expect(fit.reduce((pixels,tile)=>pixels+tile.width*tile.height,0)).toBe(4096*2048);
 const zoomed=visibleImageTiles(g,{scale:8,x:0,y:0});expect(zoomed.every(t=>t.sampleSize===1)).toBe(true);expect(zoomed.map(t=>t.x)).toEqual([1530,2040,1530,2040]);
 const edge=previewRange(g,8);expect(visibleImageTiles(g,{scale:8,x:edge.x,y:edge.y}).some(t=>t.x===0&&t.y===0)).toBe(true);
});
test("modest fullscreen images retain original pixels at fit scale",()=>{
 const g={width:233,height:233,imageWidth:1031,imageHeight:513,density:2};
 const tiles=visibleImageTiles(g,{scale:1,x:0,y:0});
 expect(tiles.length).toBe(6);
 expect(tiles.every(tile=>tile.sampleSize===1)).toBe(true);
 expect(tiles.reduce((pixels,tile)=>pixels+tile.width*tile.height,0)).toBe(1031*513);
 for(const tile of tiles){const region=imageTileRegion(tile,g.imageWidth,g.imageHeight);expect(region.width).toBeLessThanOrEqual(512);expect(region.height).toBeLessThanOrEqual(512);expect(region.x+region.offsetX).toBe(tile.x);expect(region.y+region.offsetY).toBe(tile.y);}
});
test("linear-sampling borders stay within the decoder texture limit",()=>{
 const g={width:233,height:233,imageWidth:1536,imageHeight:1536,density:2};
 const tiles=visibleImageTiles(g,{scale:1,x:0,y:0});
 expect(tiles.length).toBe(16);
 for(const tile of tiles){const region=imageTileRegion(tile,g.imageWidth,g.imageHeight);expect(tile.sampleSize).toBe(1);expect(region.width).toBeLessThanOrEqual(512);expect(region.height).toBeLessThanOrEqual(512);expect(region.x+region.offsetX).toBe(tile.x);expect(region.y+region.offsetY).toBe(tile.y);}
});
test("a moderate odd-sized image keeps source pixels instead of a fourth-size decoder level",()=>{
 const g={width:233,height:233,imageWidth:2053,imageHeight:1027,density:2};
 const tiles=visibleImageTiles(g,{scale:1,x:0,y:0});
 expect(tiles.length).toBe(15);
 expect(tiles.every(tile=>tile.sampleSize===1)).toBe(true);
 expect(tiles.reduce((pixels,tile)=>pixels+tile.width*tile.height,0)).toBe(2053*1027);
});
test("a 4096 by 3072 image retains source pixels in bounded fit tiles",()=>{
 const g={width:233,height:233,imageWidth:4096,imageHeight:3072,density:2};
 const tiles=visibleImageTiles(g,{scale:1,x:0,y:0});
 expect(tiles.length).toBe(63);
 expect(tiles.every(tile=>tile.sampleSize===1)).toBe(true);
 expect(tiles.reduce((pixels,tile)=>pixels+tile.width*tile.height,0)).toBe(4096*3072);
 for(const tile of tiles){const region=imageTileRegion(tile,g.imageWidth,g.imageHeight);expect(region.width).toBeLessThanOrEqual(512);expect(region.height).toBeLessThanOrEqual(512);}
});
test("watch zoom levels keep a bounded tile set inside each source",()=>{
 for(const [imageWidth,imageHeight,maximumTiles] of [[1031,513,9],[2053,1027,15],[4096,2048,45],[4096,3072,63],[16000,1000,9],[1000,16000,9],[466,466,9]]){
  const g={width:233,height:233,imageWidth,imageHeight,density:2};
  for(let step=0;step<100;step++){const scale=.5+(previewMaxScale(g)-.5)*step/99,range=previewRange(g,scale);for(const pos of [-1,0,.43,1]){const tiles=visibleImageTiles(g,{scale,x:range.x*pos,y:range.y*pos});expect(tiles.length).toBeLessThanOrEqual(maximumTiles);for(const t of tiles){expect(t.x+t.width<=imageWidth&&t.y+t.height<=imageHeight).toBe(true);expect(imageTileRegion(t,imageWidth,imageHeight).width<=512*t.sampleSize&&imageTileRegion(t,imageWidth,imageHeight).height<=512*t.sampleSize).toBe(true);}}}
 }
});
