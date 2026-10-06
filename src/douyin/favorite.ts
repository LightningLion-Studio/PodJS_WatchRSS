import type { DouyinClient } from './client.ts';
import type { DouyinItem } from './types.ts';

/** The detail star reads/writes the same client saved store as the actions page.
 * In production this is DouyinSavedStore -> douyinExternalItem -> ExternalSavedStore (SQL).
 * UI state is published only after the durable mutation succeeds. */
export class DouyinFavoriteController {
  state = { favorite: false, busy: false, message: '' };
  private revision = 0;
  private disposed = false;
  constructor(private client: Pick<DouyinClient, 'getSavedState' | 'toggleSaved'>, private id: string,
    private changed: (state: DouyinFavoriteController['state']) => void = () => {}) {}
  private publish(patch: Partial<DouyinFavoriteController['state']>) {
    if (!this.disposed) { this.state = { ...this.state, ...patch }; this.changed(this.state); }
  }
  async refresh() {
    if (this.disposed || this.state.busy) return;
    const revision = ++this.revision;
    try { const saved = await this.client.getSavedState(this.id); if (revision === this.revision) this.publish({ favorite: saved.favorite }); }
    catch (error) { if (revision === this.revision) this.publish({ message: String(error) }); }
  }
  async toggle(item: DouyinItem) {
    if (this.disposed || this.state.busy || item.awemeId !== this.id) return;
    this.revision++; this.publish({ busy: true });
    try {
      const favorite = await this.client.toggleSaved(item, 'favorite');
      this.publish({ favorite, message: favorite ? '已收藏' : '已取消收藏' });
    } catch (error) { this.publish({ message: String(error) }); }
    finally { this.publish({ busy: false }); }
  }
  dispose() { this.disposed = true; this.revision++; }
}
