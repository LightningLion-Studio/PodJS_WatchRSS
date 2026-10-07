import {isScriptCookieChallenge, isInteractiveSiteChallenge, requestWithSiteChallenge} from '@podjs/framework/site-challenge';
import type {HostOperation, SiteChallengeOptions} from '@podjs/framework/services';
// Mobile UAs redirect the public feeds to m.36kr.com after the challenge.
export const SITE_FEED_USER_AGENT='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Public 36kr feeds only. Subscription addresses are never rewritten. */
export function feedSiteChallenge(url:string):SiteChallengeOptions|undefined {
  if(!/^https:\/\/36kr\.com(?::443)?\/(?:feed|feed-article|feed-newsflash|feed-moment)(?:\?[^#]*)?$/i.test(url))return;
  return {url,userAgent:SITE_FEED_USER_AGENT,cookieNames:['_waftokenid'],timeoutMs:60000};
}
export function requestFeedText(url:string,load:(cookie:string,userAgent?:string)=>HostOperation<string>):HostOperation<string> {
  const options=feedSiteChallenge(url);
  return options?requestWithSiteChallenge(options,cookie=>load(cookie,options.userAgent),body=>isInteractiveSiteChallenge(body)?"interactive":isScriptCookieChallenge(body)):load('');
}
