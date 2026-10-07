/** Same token as the old correspondence-page regex. All candidate IDs before
 * one closing '>' share the same token attempt; scan that group only once.
 * A failed/malformed page can otherwise rescan the remaining HTML per ID. */
export function correspondenceCsrf(html:string):string|undefined {
  const id=/id=["']1-name["']/g;
  const token=/\s*([^<\s]+)\s*</y;
  while(id.exec(html)){
    const close=html.indexOf('>',id.lastIndex);
    if(close<0)return;
    token.lastIndex=close+1;
    const match=token.exec(html);
    if(match)return match[1];
    id.lastIndex=close+1;
  }
}
