import {playerFailureCode} from '../media/player-errors.ts';
import {isTransportFailure} from '../network/recovery.ts';
import type {DouyinReloadMode} from './reload-playback.ts';

export type DouyinReloadReason = 'source_expired' | 'not_ready' | 'transport' | 'unknown';

interface DouyinReloadInput {
  cause?: unknown;
  previousReason?: DouyinReloadReason;
  expired?: boolean;
  firstFrame?: boolean;
  saved?: boolean;
  manual?: boolean;
  endpoint?: 'feed' | 'detail';
  retryCurrent?: boolean;
}

export function douyinReloadPlan(input: DouyinReloadInput) {
  const fault = playerFailureCode(input.cause);
  const reason: DouyinReloadReason = input.expired || fault === 'source_expired'
    ? 'source_expired'
    : input.previousReason ?? (fault === 'not_ready' ? 'not_ready' : isTransportFailure(input.cause) ? 'transport' : 'unknown');
  const requireFreshAddress = reason === 'source_expired';
  let mode: DouyinReloadMode = 'feed';
  if (input.endpoint) mode = input.endpoint;
  else if (!input.manual && requireFreshAddress && (!input.firstFrame || input.saved)) mode = 'detail';
  else if (!input.manual && !requireFreshAddress && input.retryCurrent) mode = 'current';
  const reuseSavedSource = mode === 'feed' && input.saved === true && input.manual !== true
    && !requireFreshAddress && (reason === 'not_ready' || reason === 'transport');
  return {reason, mode, requireFreshAddress, reuseSavedSource};
}
