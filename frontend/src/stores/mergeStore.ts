import { create } from 'zustand';
import { listCheckpoints } from '../utils/db';
import type { CheckpointMeta } from '../types/merge';

interface MergeState {
  items: CheckpointMeta[];
  loaded: boolean;
  load: () => Promise<void>;
  byPlot: (plotId: string) => CheckpointMeta | undefined;
}

/** 各样地最近一次合并快照（用于「确认后可撤销一次」入口与提示） */
export const useMergeStore = create<MergeState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await listCheckpoints();
    set({ items: rows, loaded: true });
  },
  byPlot(plotId) {
    return get().items.find((c) => c.plotId === plotId);
  },
}));
