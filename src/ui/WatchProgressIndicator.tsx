import {mergeProps} from "solid-js";
import {WatchProgressIndicator as FrameworkProgress, type WatchProgressIndicatorProps} from "@podjs/framework/watch-ui";
export type {WatchProgressIndicatorProps};

/** WatchRSS theme and localized label; animation and rendering live in PodJS. */
export function WatchProgressIndicator(props: WatchProgressIndicatorProps) {
  return FrameworkProgress(mergeProps(props, {
    get color() { return props.color ?? "#ff6026"; },
    get accessibilityLabel() { return props.accessibilityLabel ?? "正在加载"; },
  }));
}
