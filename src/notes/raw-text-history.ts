import {TextHistory} from "@podjs/framework/editing";
export class RawTextHistory extends TextHistory {
 constructor(initial:string,now=Date.now,capacity=200,groupDelayMs=500){super(initial,now,capacity,groupDelayMs);}
}
