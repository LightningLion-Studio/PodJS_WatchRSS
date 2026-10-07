import {balancedTitleMeasurements,balancedTitleLines,normalizeCjkTitle,type TextMeasurer} from "@podjs/framework/text-lines";
export {measuredLines,type TextMeasurer} from "@podjs/framework/text-lines";
export {normalizeCjkTitle as normalizeWatchTitle} from "@podjs/framework/text-lines";
// Native title formatting profile belongs to the application.
export function watchTitleMeasurements(title:string,width:number,firstWidth=150,otherWidth=190,protectedSuffix?:string,minPrefixCharsBeforeSuffix=0):Generator<string,string[],number> {
 return balancedTitleMeasurements(title,width,firstWidth,otherWidth,protectedSuffix,minPrefixCharsBeforeSuffix,normalizeCjkTitle);
}
export function watchTitleLines(title:string,width:number,measure:TextMeasurer,firstWidth=150,otherWidth=190,protectedSuffix?:string,minPrefixCharsBeforeSuffix=0):string[] {
 return balancedTitleLines(title,width,measure,firstWidth,otherWidth,protectedSuffix,minPrefixCharsBeforeSuffix,normalizeCjkTitle);
}
