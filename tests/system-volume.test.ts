import {expect,test} from 'bun:test';
import native from './fixtures/system-volume-native.json';
import {systemVolumePercent} from '../src/ui/video-player.ts';
test('overlay percentage matches native system index/max, independently of mute and ExoPlayer gain',()=>{
 for(const state of native.cases){expect(systemVolumePercent(state.volumeIndex,state.volumeMax)).toBe(state.percent);expect(state.volume).toBe(state.volumeIndex/state.volumeMax);if(state.volumeIndex===0)expect(state.muted).toBe(true);}
 expect(systemVolumePercent(1,16)).toBe(6);expect(systemVolumePercent(0,0)).toBe(0);
});
