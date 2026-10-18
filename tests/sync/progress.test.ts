import {test,expect} from 'bun:test';
import {updateLibraryProgress,updateLibraryBytes,libraryProgressSnapshot,syncFailureReason,subscribeLibraryProgress} from '../../src/sync/progress.ts';
test('watch progress ignores probes, counts real transfer and reports missing final application confirmation',()=>{
 updateLibraryProgress({phase:'complete',applied:false});expect(libraryProgressSnapshot().phase).toBe('request');
 const values:any[]=[];const stop=subscribeLibraryProgress(v=>values.push(v));
 updateLibraryProgress({phase:'cursor'});updateLibraryBytes({direction:'read',bytes:400});updateLibraryProgress({phase:'receiving',receivedArticles:32});
 expect(libraryProgressSnapshot()).toMatchObject({phase:'receiving',bytes:400,receivedArticles:32});
 updateLibraryProgress({phase:'complete',applied:false});expect(libraryProgressSnapshot()).toMatchObject({phase:'error',message:'手机未确认应用结果，已接收文章保留；请重新同步'});
 updateLibraryProgress({phase:'complete',applied:true});expect(libraryProgressSnapshot().phase).toBe('error');
 updateLibraryProgress({phase:'cursor'});updateLibraryProgress({phase:'complete',applied:true});expect(libraryProgressSnapshot().phase).toBe('complete');
 stop();expect(values.length).toBeGreaterThan(3);
});
test('failure text conveys actionable categories without exposing raw authentication or payload details',()=>{
 expect(syncFailureReason(Error('permission missing'))).toContain('权限');expect(syncFailureReason(Error('hash mismatch private article id'))).toContain('校验');expect(syncFailureReason(Error('timed out'))).toContain('超时');expect(syncFailureReason(Error('bad secret=abcdef'))).not.toContain('abcdef');
});
