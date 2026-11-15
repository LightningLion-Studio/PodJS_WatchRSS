import {readFile,writeFile} from 'node:fs/promises';
import {analyzeSavedPlayback,renderSavedPlaybackAnalysis} from './douyin-saved-analysis.ts';
const input=process.argv[2];
if(!input){console.error('用法：bun scripts/douyin-saved-report.ts <app_log.txt> [report.html]');process.exit(2);}
const output=process.argv[3]??'douyin-saved-report.html',log=await readFile(input,'utf8');
const description=(process.argv[4]??'统计范围：输入日志中可关联的本地收藏播放。').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
await writeFile(output,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>抖音本地收藏播放诊断</title><style>body{max-width:1100px;margin:32px auto;padding:20px;font:15px/1.6 system-ui;color:#17212b;background:#f4f6f8}section{padding:24px;background:white;border-radius:16px}table{width:100%;border-collapse:collapse}th,td{padding:10px;text-align:left;border-bottom:1px solid #e5e9ed}.note{color:#667582;font-size:13px}</style><p>${description}</p>${renderSavedPlaybackAnalysis(log)}</html>`);
const s=analyzeSavedPlayback(log);console.log(`已生成 ${output}：${s.local.length} 次本地收藏打开，${s.refreshes} 次刷新，${s.recovered} 次刷新后出帧恢复。`);
