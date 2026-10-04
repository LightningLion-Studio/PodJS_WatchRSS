/** Mirrors the native last-visible-item check with an 8 dp bottom tolerance. */
export function readerReachedBottom(contentHeight:number,viewportHeight:number,offset:number,threshold=8):boolean {
  return contentHeight>=viewportHeight-threshold &&
    Math.max(0,contentHeight-viewportHeight)-offset<=threshold;
}

export function shouldAutoRemoveWatchLater(fromWatchLater:boolean,reachedBottom:boolean,isWatchLater:boolean):boolean {
  return fromWatchLater&&reachedBottom&&isWatchLater;
}
