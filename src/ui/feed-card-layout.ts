import {createKeyedMemo} from '@podjs/framework/keyed-memo';
import {measuredLines} from '../reader/measured-text.ts';
import type {Article} from './service.ts';

type Measure = (size: number) => (text: string) => number;

export interface FeedCardGeometry {
  padding: number;
  firstIndent: number;
  title: string[];
  summary: string;
  height: number;
  top: number;
}

export function createFeedCardLayouts(measure: Measure) {
  const cache = createKeyedMemo<string>();
  const titleWidth = measure(14);
  const summaryWidth = measure(9);
  return {
    unreadIndent: () => 7 + titleWidth(' '),
    get(article: Article, width: number, fontRevision: number, unreadIndent: number): FeedCardGeometry {
      const image = !!article.imageUrl;
      const firstIndent = article.read ? 0 : unreadIndent;
      return cache.get(article.id, [article.title, article.excerpt, image, width, fontRevision, firstIndent], () => {
        const padding = image ? 8 : 9;
        const available = width - 2 * padding;
        const title = measuredLines(article.title, available, titleWidth, 2, firstIndent);
        const summary = measuredLines(article.excerpt || '暂无摘要', available, summaryWidth, 2);
        const textHeight = title.length * 18 + 2 + summary.length * 9.9;
        const height = image ? Math.max(100, textHeight + 2 * padding) : textHeight + 2 * padding;
        return {padding, firstIndent, title, summary: summary.join('\n'), height, top: image ? height - padding - textHeight : padding};
      });
    },
    retain: cache.retain,
    clear: cache.clear,
  };
}
