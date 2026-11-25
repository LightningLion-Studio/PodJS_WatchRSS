import {expect,test} from 'bun:test';
for(const scenario of ['4','8','delayed','timeout','reader-timeout-warning','reader-background-timeout-warning','lifecycle','bluetooth','bluetooth-modal','bluetooth-note-close','bluetooth-inline','bluetooth-search-modal','bluetooth-transition','bluetooth-cancel','note-actions','bluetooth-rss-save','bluetooth-note-restore',
 'bluetooth-note-body','bluetooth-note-empty','bluetooth-note-leave','bluetooth-note-download','bluetooth-note-load',
 'bluetooth-note-action-confirm','bluetooth-note-action-delete','bluetooth-note-action-pin','bluetooth-note-action-move',
 'bluetooth-note-action-pin-leave','bluetooth-note-action-delete-leave','bluetooth-note-action-move-leave','bluetooth-note-action-pin-leave-cancel',
 'bluetooth-revalidation','bluetooth-background-replacement','bluetooth-note-action-pin-leave-deadline',
 'bluetooth-rss-action-confirm','bluetooth-rss-action-delete','bluetooth-rss-action-unread','bluetooth-rss-action-later',
 'bluetooth-rss-action-qr','bluetooth-rss-action-system','bluetooth-rss-action-leave','bluetooth-rss-action-cancel',
 'bluetooth-video-pan','bluetooth-feed-open','bluetooth-feed-open-slow','bluetooth-feed-open-slow-fail','bluetooth-feed-open-slow-cancel','bluetooth-feed-open-with-warning','bluetooth-feed-actions','bluetooth-feed-reload','bluetooth-search-restore',
 'bluetooth-home-disclosure','bluetooth-safe-home','bluetooth-safe-articles','bluetooth-safe-notes','bluetooth-safe-settings'])test(`K18 real route regression: ${scenario}`,()=>{
 const result=Bun.spawnSync([process.execPath,'--conditions=browser','test','./tests/rapid-back.isolated.ts'],{cwd:import.meta.dir+'/..',env:{...process.env,RAPID_BACK_CASE:scenario},stdout:'pipe',stderr:'pipe'});
 if(result.exitCode)console.error(new TextDecoder().decode(result.stdout),new TextDecoder().decode(result.stderr));
 expect(result.exitCode).toBe(0);
});
