import {expect,test} from 'bun:test';
const scenarios=['4','8','delayed','timeout','reader-timeout-warning','reader-background-timeout-warning','lifecycle','bluetooth','bluetooth-modal','bluetooth-note-close','bluetooth-inline','bluetooth-search-modal','bluetooth-transition','bluetooth-cancel','note-actions','bluetooth-rss-save','bluetooth-note-restore',
 'bluetooth-note-body','bluetooth-note-empty','bluetooth-note-leave','bluetooth-note-download','bluetooth-note-load',
 'bluetooth-note-action-confirm','bluetooth-note-action-delete','bluetooth-note-action-pin','bluetooth-note-action-move',
 'bluetooth-note-action-pin-leave','bluetooth-note-action-delete-leave','bluetooth-note-action-move-leave','bluetooth-note-action-pin-leave-cancel',
 'bluetooth-revalidation','bluetooth-background-replacement',
 'bluetooth-rss-action-confirm','bluetooth-rss-action-delete','bluetooth-rss-action-unread','bluetooth-rss-action-later',
 'bluetooth-rss-action-qr','bluetooth-rss-action-system','bluetooth-rss-action-leave','bluetooth-rss-action-cancel',
 'bluetooth-video-pan','bluetooth-feed-open','bluetooth-feed-open-slow','bluetooth-feed-open-slow-fail','bluetooth-feed-open-slow-back','bluetooth-feed-open-slow-background','bluetooth-feed-open-slow-account','bluetooth-feed-open-with-warning','bluetooth-feed-actions','bluetooth-feed-actions-leave','bluetooth-feed-reload','bluetooth-feed-stalled-reload-leave','bluetooth-search-restore',
 'bluetooth-home-disclosure','bluetooth-safe-home','bluetooth-safe-articles','bluetooth-safe-notes','bluetooth-safe-settings','bluetooth-safe-settings-background-read','bluetooth-safe-settings-account-query',
 'bluetooth-idle-input','bluetooth-list-pull','bluetooth-list-fling','bluetooth-swipe-menu',
 'bluetooth-share-query','bluetooth-feed-restored-stall','bluetooth-feed-open-slow-cloud-init',
 'bluetooth-feed-open-slow-background-retry','bluetooth-feed-open-slow-account-retry','bluetooth-feed-open-slow-rebound','bluetooth-feed-open-slow-reenter','bluetooth-feed-open-slow-retry','bluetooth-feed-open-slow-destroy',
 'bluetooth-feed-open-with-warning-dragging','bluetooth-feed-open-with-warning-settling','bluetooth-feed-open-with-warning-after-swipe',
 'bluetooth-feed-open-with-warning-continue','bluetooth-feed-open-with-warning-error','bluetooth-feed-open-with-warning-stale-continue',
 'reader-timeout-late','reader-timeout-late-reject'];
function routeTest(name:string,scenario:string,env:Record<string,string>={}){
 test(`K18 real route regression: ${name}`,()=>{
  const result=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/rapid-back.isolated.ts'],{
   cwd:import.meta.dir+'/..',
   env:{...process.env,RAPID_BACK_CASE:scenario,...env},
   stdout:'pipe',stderr:'pipe',
  });
  expect(result.exitCode,result.stdout.toString()+result.stderr.toString()).toBe(0);
 });
}
for(const scenario of scenarios)routeTest(scenario,scenario);
for(const failure of ['WRITE_FAILED','CANCELLED']){
 for(const scenario of [
  'bluetooth-note-action-delete-leave','bluetooth-note-action-move-leave','bluetooth-note-action-pin-leave',
  'bluetooth-rss-action-delete','bluetooth-rss-action-later','bluetooth-rss-action-leave','bluetooth-rss-action-unread',
 ])routeTest(`${scenario} ${failure}`,scenario,{REVIEW_WRITE_FAILURE:failure});
 routeTest(`note editor ${failure}`,'bluetooth-modal',{REVIEW_HOLD_DRAFT:'1',REVIEW_WRITE_FAILURE:failure});
}
routeTest('note editor pending write','bluetooth-modal',{REVIEW_HOLD_DRAFT:'1'});
routeTest('note editor empty draft','bluetooth-modal',{REVIEW_EMPTY_DRAFT:'1'});
for(const count of [59,60,61])routeTest(`reader host occupancy ${count}`,'timeout',{REVIEW_HOST_PENDING:String(count)});
for(const scenario of ['bluetooth-novel-background','bluetooth-feed-open-slow-modal-takeover']){
 routeTest(scenario,scenario);
 routeTest(`${scenario} without warning`,scenario,{REVIEW_BLUETOOTH_CONTROL:'1'});
}
