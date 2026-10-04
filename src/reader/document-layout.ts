import {contentAnchorAt, offsetForContentAnchor, type ContentAnchor, type ContentLayout} from "./content-layout.ts";

/** Text/media coordinates stay independent of the scrolling title and actions. */
export interface DocumentAnchor extends ContentAnchor {
  section?: "header" | "footer";
  sectionOffset?: number;
}

export function documentAnchorAt(body:ContentLayout, offset:number, headerHeight:number):DocumentAnchor {
  const position=Math.max(0,offset),header=Math.max(0,headerHeight);
  if(position<header) return {character:0,fraction:0,section:"header",sectionOffset:position};
  if(position>=header+body.height) return {character:body.textLength,fraction:0,section:"footer",sectionOffset:position-header-body.height};
  return contentAnchorAt(body,position-header);
}

export function offsetForDocumentAnchor(body:ContentLayout, anchor:DocumentAnchor, headerHeight:number, maximum:number):number {
  const header=Math.max(0,headerHeight),extra=Math.max(0,anchor.sectionOffset??0);
  const position=anchor.section==="header"?Math.min(header,extra)
    :anchor.section==="footer"?header+body.height+extra
    :header+offsetForContentAnchor(body,anchor,Infinity);
  return Math.max(0,Math.min(Math.max(0,maximum),position));
}
