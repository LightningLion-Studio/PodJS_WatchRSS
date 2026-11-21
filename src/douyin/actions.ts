import type { DouyinClient } from './client.ts';
import type { DouyinItem } from './types.ts';
import { douyinActionItem } from './action-item.ts';

type Client = Pick<DouyinClient, 'fetchDetail' | 'getSavedState' | 'toggleSaved'>;
export type DouyinActionDone = 'favorite' | 'watchLater' | 'share';
export interface DouyinActionsState { item?: DouyinItem; favorite: boolean; watchLater: boolean; message: string; busy: boolean }
export class DouyinActionsController {
  state: DouyinActionsState;
  private disposed = false;
  private revision = 0;
  constructor(private client: Client, private id: string, supplied?: DouyinItem,
    private changed: (state: DouyinActionsState) => void = () => {}, private onDone?: (kind: DouyinActionDone) => void) {
    this.state = { item: douyinActionItem(supplied, id), favorite: false, watchLater: false, message: '正在读取状态...', busy: false };
  }
  private publish(patch: Partial<DouyinActionsState>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; this.changed(this.state); } }
  async load() {
    const revision = this.revision;
    const saved = this.client.getSavedState(this.id).then(state => {
      if (revision === this.revision) this.publish(this.state.item ? { ...state, message: '' } : state);
    }).catch(error => {
      if (revision === this.revision) this.publish({ message: String(error) });
    });
    if (this.state.item) return saved;

    await Promise.all([saved, this.client.fetchDetail(this.id).then(detail => {
      if (detail.ok && detail.data.kind === 'video' && detail.data.item.awemeId === this.id) this.publish({ item: detail.data.item, message: '' });
      else this.publish({ message: detail.ok ? '图文内容暂不支持加入本地收藏' : detail.message });
    }).catch(error => this.publish({ message: String(error) }))]);
  }
  async toggle(kind: 'favorite' | 'watchLater') {
    if (this.disposed || this.state.busy || !this.state.item) return;
    this.revision++;
    this.publish({ busy: true });
    try {
      const saved = await this.client.toggleSaved(this.state.item, kind);
      if (this.disposed) return;
      this.publish({ [kind]: saved, message: saved ? kind === 'favorite' ? '已收藏' : '已加入稍后再看' : kind === 'favorite' ? '已取消收藏' : '已从稍后再看移除' });
      this.onDone?.(kind);
    } catch (error) { this.publish({ message: String(error) }); }
    finally { this.publish({ busy: false }); }
  }
  shared() { if (!this.disposed) this.onDone?.('share'); }
  dispose() { this.disposed = true; }
}
