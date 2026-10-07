import {expect,test} from 'bun:test';
import {__pumpPodEvents} from '@podjs/framework/watch';
import {requestFeedText,SITE_FEED_USER_AGENT} from '../src/rss/site-challenge.ts';
const commands:any[]=[],events:any[]=[];
(globalThis as any).pod={capabilities:()=>JSON.stringify(['system.browser.challenge']),emit:(s:string)=>commands.push(JSON.parse(s)),takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined};
const turn=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const reply=async(value:any)=>{events.push({t:'service.result',id:commands.at(-1).id,ok:true,value});__pumpPodEvents();await turn();};
test('production app adapter uses one desktop UA for browser and both HTTP attempts without changing the subscribed URL',async()=>{
  const url='https://36kr.com/feed',loads:any[]=[];
  const request=requestFeedText(url,(cookie,userAgent)=>{loads.push({cookie,userAgent});return {result:Promise.resolve(cookie?'<rss/>':'<!DOCTYPE html><html><script>document.cookie="_wafchallengeid=x";location.reload()</script>安全检测</html>'),cancel(){}};});
  await turn();expect(commands.at(-1)).toMatchObject({method:'browser.challengeCookies',args:{url,userAgent:SITE_FEED_USER_AGENT,cookieNames:['_waftokenid']}});await reply({cookie:'',origin:'https://36kr.com'});
  expect(commands.at(-1)).toMatchObject({method:'browser.acquireChallengeCookies',args:{url,userAgent:SITE_FEED_USER_AGENT,cookieNames:['_waftokenid']}});await reply({cookie:'_waftokenid=fixture',origin:'https://36kr.com'});
  expect(await request.result).toBe('<rss/>');expect(loads).toEqual([{cookie:'',userAgent:SITE_FEED_USER_AGENT},{cookie:'_waftokenid=fixture',userAgent:SITE_FEED_USER_AGENT}]);
});
