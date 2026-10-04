import { expect,test } from "bun:test";
import { biliVideoTarget,buildArticleBlocks,douyinVideoTarget } from "../src/reader/media.ts";

test("reader appends image/video enclosures after text and avoids exact duplicate blocks",()=>{
  expect(buildArticleBlocks("<p>正文</p>",{enclosureImageUrl:"https://img.test/cover",videoUrl:"https://video.test/a.mp4"})).toEqual([{type:"text",text:"正文",style:"body"},{type:"image",url:"https://img.test/cover"},{type:"video",url:"https://video.test/a.mp4"}]);
  const blocks=buildArticleBlocks('<img src="https://img.test/cover"><video src="https://video.test/a.mp4"></video>',{enclosureImageUrl:"https://img.test/cover",videoUrl:"https://video.test/a.mp4"});
  expect(blocks.filter(b=>b.type==='image')).toHaveLength(1);expect(blocks.filter(b=>b.type==='video')).toHaveLength(1);
  expect(buildArticleBlocks('',{videoUrl:"https://video.test/a.mp4"})).toEqual([{type:'video',url:'https://video.test/a.mp4'}]);
});
test("article links add provider playback blocks only for supported host forms",()=>{
  expect(buildArticleBlocks('',{link:'https://www.bilibili.com/video/bv1abc?cid=42',enclosureImageUrl:'https://img.test/a'}).at(-1)).toEqual({type:'video',url:'https://www.bilibili.com/video/BV1abc?cid=42',poster:'https://img.test/a'});
  expect(buildArticleBlocks('',{link:'https://www.douyin.com/video/123'})).toEqual([{type:'video',url:'https://www.douyin.com/video/123'}]);
  expect(buildArticleBlocks('',{link:'https://example.test/article'})).toEqual([]);
  expect(buildArticleBlocks('',{link:'https://www.douyin.com/video/123',videoUrl:'https://cdn.test/video.mp4'})).toEqual([{type:'video',url:'https://cdn.test/video.mp4'}]);
});
test("provider targets preserve ids/cid and reject lookalike hosts",()=>{
  expect(biliVideoTarget('av123')).toEqual({aid:123});expect(biliVideoTarget('bv1abc')).toEqual({bvid:'BV1abc'});
  expect(biliVideoTarget('https://player.bilibili.com/player.html?bvid=BV1abc&cid=42')).toEqual({bvid:'BV1abc',cid:42});
  expect(biliVideoTarget('https://notbilibili.com/video/BV1abc')).toBeNull();
  expect(douyinVideoTarget('https://www.iesdouyin.com/share?aweme_id=123')).toEqual({awemeId:'123',webUrl:'https://www.douyin.com/video/123'});
  expect(douyinVideoTarget('https://douyin.com.example.test/video/123')).toBeNull();
});
