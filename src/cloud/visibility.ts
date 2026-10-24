/** Leaving a page does not change application visibility. SCREEN_OFF may arrive
 * before onPause; both must fence foreground work before handing it to the OS. */
export class CloudVisibility {
 private resumed:boolean;private interactive=true;private displayResumed=true;
 constructor(lifecycle:string){this.resumed=lifecycle==='active';}
 lifecycle(value:string){this.resumed=value==='active';return this.active;}
 display(value:{interactive:boolean;resumed:boolean}){this.interactive=value.interactive;this.displayResumed=value.resumed;return this.active;}
 get active(){return this.resumed&&this.interactive&&this.displayResumed;}
}
