import type {RouteEntry} from '../ui/routes/types.ts';
const screens:Record<string,string>={home:'HomeFeedListActivity',profile:'ProfileActivity',articles:'FeedActivity',reader:'DetailActivity',saved:'SavedItemsActivity','watch-later':'SavedItemsActivity',search:'RssSearchActivity',settings:'SettingsActivity','settings-advanced':'AdvancedSettingsActivity',notes:'NotesActivity','note-detail':'NoteDetailActivity','note-actions':'NoteActionsActivity','add-rss':'AddRssActivity','remote-input':'ServerActivity','log-upload':'LogUploadActivity','bluetooth-connection':'BluetoothConnectionActivity','phone-connection-unavailable':'PhoneConnectionUnavailableActivity','tts-config':'TtsSettingsActivity','reader-preview':'ReaderPresetPreviewActivity','phone-connection':'PhoneConnectionActivity','account-status':'AccountStatusActivity','cloud-sync':'CloudSyncActivity','speech-playback':'ReadAloudPlaybackActivity','settings-reader-presets':'ReaderPresetActivity','settings-llm-usage':'LlmTokenUsageActivity','settings-llm-preset':'LlmPromptPresetActivity','channel-detail':'ChannelDetailActivity','channel-settings':'ChannelSettingsActivity','channel-share':'ShareQrActivity','reader-image':'ImagePreviewActivity','reader-scroll-controls':'AutoScrollControlActivity','rss-actions':'ItemActionsActivity','rss-share':'ShareQrActivity'};
const bili:Record<string,string>={entry:'BiliEntryActivity',feed:'BiliListActivity','channel-info':'BiliChannelInfoActivity',login:'BiliLoginActivity',search:'BiliSearchActivity',results:'BiliSearchActivity',history:'BiliListActivity','watch-later':'BiliListActivity',favorites:'BiliListActivity','favorite-folder':'BiliListActivity',detail:'BiliDetailActivity',comments:'BiliCommentActivity',replies:'BiliReplyDetailActivity',actions:'BiliVideoActionsActivity',share:'ShareQrActivity',settings:'BiliSettingsActivity',player:'BiliPlayerActivity'};
const douyin:Record<string,string>={entry:'DouyinEntryActivity',feed:'DouyinEntryActivity','channel-info':'DouyinChannelInfoActivity',login:'DouyinLoginActivity',detail:'DouyinDetailActivity',history:'DouyinHistoryActivity',actions:'DouyinVideoActionsActivity',share:'ShareQrActivity',settings:'DouyinSettingsActivity',player:'DouyinPlayerActivity'};
const information:Record<string,string>={about:'AboutActivity',collaborators:'CollaboratorsActivity','contact-developer':'ContactDeveloperActivity','join-group':'JoinGroupActivity',beian:'BeianActivity','log-upload-privacy':'LogUploadPrivacyActivity'};
/** Only known native Activity equivalents; no URLs, titles or generated route IDs. */
export function telemetryScreen(entry:RouteEntry):string|undefined {
  if(entry.page==='bili')return bili[entry.biliRoute?.name??'entry'];
  if(entry.page==='douyin')return douyin[entry.douyinRoute?.name??'entry'];
  if(entry.page==='video'&&entry.playback?.immersive)return undefined;
  if(entry.page==='video'&&entry.rssDouyinRecovery)return 'RssPlayerActivity';
  if(entry.page==='video')return entry.playback?.platform==='bili'?'BiliPlayerActivity':entry.playback?.platform==='douyin'?'DouyinPlayerActivity':'RssPlayerActivity';
  if(entry.page==='information')return information[entry.informationPage??'info']??'InfoActivity';
  if(entry.page==='recommendations')return entry.recommendationGroup?'RssRecommendGroupActivity':'RssRecommendActivity';
  if(entry.page==='settings-auto-scroll')return 'AutoScrollControlActivity';
  if(entry.page==='settings-speech')return 'TtsSettingsActivity';
  return screens[entry.page];
}

/** Search results and immersive/feed pages are internal native navigation. */
export function telemetryScreenOwner(entries:RouteEntry[]):RouteEntry|undefined {
  const top=entries.at(-1);
  if(top?.page==='bili'&&top.biliRoute?.name==='results')return [...entries].reverse().find(entry=>entry.page==='bili'&&entry.biliRoute?.name==='search')??top;
  if(top?.page==='douyin'&&top.douyinRoute?.name==='feed')return [...entries].reverse().find(entry=>entry.page==='douyin'&&entry.douyinRoute?.name==='entry')??top;
  if(top?.page==='video'&&top.playback?.immersive)return telemetryScreenOwner(entries.slice(0,-1));
  return [...entries].reverse().find(entry=>telemetryScreen(entry)!==undefined);
}
