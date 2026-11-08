import { Text, View } from '@pocketjs/framework/components';
import { measuredLines } from '../reader/measured-text.ts';
import { getOps } from '@pocketjs/framework/host';
import { ScrollEntries } from './ScrollEntries.tsx';

/** Native DetailScreen's explicit confirmation before opening the original webpage. */
export function OriginalWebConfirm(props: { width: number; height: number; onConfirm: () => void; onCancel: () => void }) {
  const message = '原文网页阅读仍在内测，可能出现排版异常或兼容性问题，确定继续吗？';
  const lines = () => measuredLines(message, props.width - 48, text => getOps().measureText(text, 0));
  const button = (label: string, action: () => void) => ({ height: 40, render: () => <View onPress={action} focusable accessibilityRole="button" accessibilityLabel={label} class="absolute inset-0 rounded-[20] bg-[#23272a] items-center justify-center active:scale-96"><Text class="text-white">{label}</Text></View> });
  return <View class="absolute inset-0 bg-black" onPress={() => {}}>
    <ScrollEntries height={props.height} entries={[
      { height: 30, render: () => <Text class="text-center text-white">内测功能</Text> },
      { height: lines().length * 18, render: () => <Text class="text-[#b6b6b6]" style={{ lineHeight: 18 }}>{lines().join('\n')}</Text> },
      button('确定', props.onConfirm), button('取消', props.onCancel),
    ]} />
  </View>;
}
