import config from '../../pod.config.json';

/** Match the native watch's X-WatchRSS-App-Version request header. */
export const watchAppVersionValue=(versionName:string,versionCode:number)=>`watch-${versionName.trim()}+${versionCode}`;
export const watchAppVersion=watchAppVersionValue(config.versionName,config.versionCode);
