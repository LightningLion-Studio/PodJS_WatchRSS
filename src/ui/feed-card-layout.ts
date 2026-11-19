import {measuredLines} from '../reader/measured-text.ts';
import type {Article} from './service.ts';

type Measure=(size:number)=>(text:string)=>number;
interface CardLayout {image:boolean;padding:number;firstIndent:number;title:string[];summary:string[];cardHeight:number;top:number;}
const layouts=new WeakMap<Article,{width:number;read?:boolean;title:string;excerpt?:string;image:boolean;measure:Measure;layout:CardLayout}>();
export function feedCardLayout(article:Article,width:number,measure:Measure):CardLayout {
  const image=!!article.imageUrl,entry=layouts.get(article);
  if(entry&&entry.width===width&&entry.read===article.read&&entry.title===article.title&&entry.excerpt===article.excerpt&&entry.image===image&&entry.measure===measure)return entry.layout;
  const padding=image?8:9,firstIndent=article.read?0:7+measure(14)(' '),available=width-36-padding*2;
  const title=measuredLines(article.title,available,measure(14),2,firstIndent);
  const summary=measuredLines(article.excerpt||'暂无摘要',available,measure(9),2);
  const textHeight=title.length*18+2+summary.length*9.9;
  const cardHeight=image?Math.max(100,textHeight+padding*2):textHeight+padding*2;
  const layout={image,padding,firstIndent,title,summary,cardHeight,top:image?cardHeight-padding-textHeight:padding};
  layouts.set(article,{width,read:article.read,title:article.title,excerpt:article.excerpt,image,measure,layout});
  return layout;
}
