import type {Article} from '../ui/service.ts';
const images=[['1015','湖边山景'],['1025','野外动物'],['1035','海岸线'],['1043','城市街景'],['1050','林间道路'],['1062','日落天空']].map(([id,alt])=>({url:`https://picsum.photos/id/${id}/800/600`,alt:`测试图片：${alt}`}));
export function buildLargeList():Article[]{return Array.from({length:10000},(_,i)=>({id:`debug-perf-${i}`,channelId:'debug-perf',title:`性能测试条目 ${i+1}${i%12===0?'（图片）':''}`,excerpt:i%12===0?'这是一条带图的性能测试摘要内容。':'这是用于滚动性能测试的摘要内容。',content:'',read:i%3===0,imageUrl:i%12===0?images[(i/12)%images.length].url:undefined}));}
export function buildLargeArticle():Article{
 const paragraph=('这是一段用于性能测试的文本内容，用来模拟超长正文。'+'为了压测排版与滚动性能，会重复生成多个段落。\n').repeat(4);
 let content='',i=0,n=0;while(content.length<100000){content+=`<p>${paragraph}</p>`;if(++i%4===0){const image=images[n++%images.length];content+=`<p><img src="${image.url}" alt="${image.alt}" /></p>`;}}
 return {id:'debug-perf-article',title:'性能测试：这是一个用于阅读页标题断行与圆表安全区验证的超长文章标题，包含 RSS 2026、English words、数字 1234567890 与多段信息',content,rawContent:content,imageUrl:images[0].url,excerpt:'用于性能测试的超长正文。'};
}
