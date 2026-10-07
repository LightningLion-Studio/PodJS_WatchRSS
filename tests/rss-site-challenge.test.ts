import {expect,test} from 'bun:test';
import {feedSiteChallenge,requestFeedText,SITE_FEED_USER_AGENT} from '../src/rss/site-challenge.ts';

test('only exact public 36kr feed addresses enable challenge cookies and keep their URL and UA',()=>{
  for(const path of ['feed','feed-article','feed-newsflash','feed-moment']) {
    const url='https://36kr.com/'+path;
    expect(feedSiteChallenge(url)).toEqual({url,userAgent:SITE_FEED_USER_AGENT,cookieNames:['_waftokenid'],timeoutMs:60000});
  }
  for(const url of ['https://36kr.com.evil/feed','https://36kr.com@evil/feed','https://evil/36kr.com/feed','http://36kr.com/feed','https://36kr.com/feed-extra','https://36kr.com/feed/a','https://36kr.com/','https://sspai.com/feed','https://user@36kr.com/feed'])expect(feedSiteChallenge(url)).toBeUndefined();
});
test('other sources keep their original operation and errors with no browser request',async()=>{
  const operation={result:Promise.resolve('<rss/>'),cancel(){}};let cookie:string|undefined;
  expect(requestFeedText('https://sspai.com/feed',value=>{cookie=value;return operation;})).toBe(operation);
  expect(cookie).toBe('');
  const error=new Error('source failed');await expect(requestFeedText('https://example.com/feed',()=>({result:Promise.reject(error),cancel(){}})).result).rejects.toBe(error);
});

test('production adapter isolated service path',()=>{
  const result=Bun.spawnSync(['bun','--conditions=browser','test','./tests/rss-site-challenge-default.isolated.ts'],{cwd:import.meta.dir+'/..',stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode,Buffer.from(result.stderr).toString()).toBe(0);
});
