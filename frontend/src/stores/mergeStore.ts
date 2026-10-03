import { create } from 'zustand';
import type { MergePreview, ConflictResolutions } from '../types/merge';

/** 已暂存、待调查员确认的合并预演（确认前汇总页不展示旧生长量） */
export interface PendingMerge {
  preview: MergePreview;
  resolutions: ConflictResolutions;
  stagedAt: number;
}

interface MergeState {
  /** key: plotId */
  pending: Record<string, PendingMerge>;
  stage: (preview: MergePreview, resolutions: ConflictResolutions) => void;
  setResolutions: (plotId: string, resolutions: ConflictResolutions) => void;
  resolveConflict: (plotId: string, key: string, side: MergePreview['treeConflicts'][number]['resolution']) => void;
  clear: (plotId: string) => void;
  get: (plotId: string) => PendingMerge | undefined;
}

export const useMergeStore = create<MergeState>((set, get) => ({
  pending: {},
  stage(preview, resolutions) {
    set({
      pending: {
        ...get().pending,
        [preview.plotId]: { preview, resolutions, stagedAt: Date.now() },
      },
    });
  },
  setResolutions(plotId, resolutions) {
    const current = get().pending[plotId];
    if (!current) return;
    set({ pending: { ...get().pending, [plotId]: { ...current, resolutions } } });
  },
  resolveConflict(plotId, key, side) {
    const current = get().pending[plotId];
    if (!current || !side) return;
    set({
      pending: {
        ...get().pending,
        [plotId]: { ...current, resolutions: { ...current.resolutions, [key]: side } },
      },
    });
  },
  clear(plotId) {
    const next = { ...get().pending };
    delete next[plotId];
    set({ pending: next });
  },
  get(plotId) {
    return get().pending[plotId];
  },
}));
