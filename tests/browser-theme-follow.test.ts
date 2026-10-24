import {expect,test} from 'bun:test';
import {followBrowserTheme} from '../src/browser/theme-follow';
test('live browser follows changed preset/scheduled boundary, serializes updates and releases idle timer after close',async()=>{
 let dark=true,listener=()=>{},tick=()=>{},cancelled=0,unsubscribed=0;const calls:boolean[]=[];let showing=true;
 const stop=followBrowserTheme({read:()=>({dark}),subscribe:f=>{listener=f;return()=>{unsubscribed++;};},schedule:f=>{tick=f;return()=>{cancelled++;};},update:async t=>{calls.push(t.dark);return {updated:showing};}});
 await Promise.resolve();listener();await Promise.resolve();expect(calls).toEqual([true]);
 dark=false;listener();await Promise.resolve();expect(calls).toEqual([true,false]);
 dark=true;tick();await Promise.resolve();expect(calls).toEqual([true,false,true]);
 showing=false;dark=false;tick();await Promise.resolve();expect(unsubscribed).toBe(1);expect(cancelled).toBeGreaterThan(0);stop();expect(unsubscribed).toBe(1);
});
test('failed host update stops observer instead of endlessly retrying',async()=>{
 let unsubscribed=0;followBrowserTheme({read:()=>({dark:true}),subscribe:()=>()=>{unsubscribed++;},schedule:()=>()=>{},update:async()=>{throw Error('disposed');}});await Promise.resolve();expect(unsubscribed).toBe(1);
});
