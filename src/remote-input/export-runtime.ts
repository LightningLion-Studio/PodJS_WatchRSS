import {kv} from '@podjs/framework/watch';
import {getSavedLinksForSync} from '../services.ts';
import {biliClient} from '../media-services.ts';
import {readBiliPlaybackProgress} from '../bili/playback.ts';
import type {HttpExportSource} from './exports.ts';

export const httpExportSource:HttpExportSource={
 readSavedLinks:getSavedLinksForSync,
 history:cursor=>biliClient.history({cursor}),
 playbackProgress:()=>readBiliPlaybackProgress({get:async key=>kv.get<string>(key)}),
};
