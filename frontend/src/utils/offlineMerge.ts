import { db, clearCheckpoints, loadLatestCheckpoint } from './db';
import { newId } from './id';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import type { TreeRecord } from '../types/tree';
import type {
  ConflictResolution,
  MergeCheckpoint,
  MergePreview,
  OfflineBundle,
} from '../types/merge';

export interface ApplyMergeInput {
  plotId: string;
  preview: MergePreview;
  /** 冲突树 key（`期次#树号`）→ 调查员选定；缺省按保留本机处理 */
  resolutions: Record<string, ConflictResolution>;
  sourceLabel: string;
  bundle: OfflineBundle;
}

export interface ApplyMergeResult {
  treeInserted: number;
  treeUpdated: number;
  regenInserted: number;
  regenUpdated: number;
  recheckStale: number;
}

/** 按当前选定，计算实际会发生变化的「期次 → 树号」（新增树 + 选定采用导入值的冲突树） */
export function changedTreeNosByRound(
  preview: MergePreview,
  resolutions: Record<string, ConflictResolution>,
): Map<number, Set<string>> {
  const changed = new Map<number, Set<string>>();
  const mark = (round: number, treeNo: string) => {
    const set = changed.get(round) ?? new Set<string>();
    set.add(treeNo);
    changed.set(round, set);
  };
  preview.treeAdds.forEach(({ tree }) => mark(tree.round, tree.treeNo));
  preview.treeConflicts.forEach((c) => {
    if (resolutions[c.key] === 'incoming') mark(c.round, c.treeNo);
  });
  return changed;
}

/** 判定某条逐株比对是否受合并影响（基准或本期样木发生变化） */
export function staleReasonFor(
  recheck: Pick<RecheckDiff, 'baseRound' | 'targetRound' | 'treeNo'>,
  changed: Map<number, Set<string>>,
): string {
  const baseChanged = changed.get(recheck.baseRound)?.has(recheck.treeNo) ?? false;
  const targetChanged = changed.get(recheck.targetRound)?.has(recheck.treeNo) ?? false;
  if (baseChanged && targetChanged) return `第 ${recheck.baseRound}/${recheck.targetRound} 期样木经离线合并变更`;
  if (baseChanged) return `第 ${recheck.baseRound} 期基准样木经离线合并变更`;
  if (targetChanged) return `第 ${recheck.targetRound} 期本期样木经离线合并变更`;
  return '';
}

/** 预演：按当前选定，列出将被标为待重算的旧逐株比对（不写库） */
export function previewStaleRechecks(
  rechecks: RecheckDiff[],
  preview: MergePreview,
  resolutions: Record<string, ConflictResolution>,
): RecheckDiff[] {
  const changed = changedTreeNosByRound(preview, resolutions);
  return rechecks.filter((r) => staleReasonFor(r, changed) !== '');
}

/**
 * 确认合并：单事务写入样木/样方、把受影响的旧逐株比对标为待重算，并保存撤销快照。
 * 同一样地再次确认时旧快照被覆盖 → 只保留最近一次、可撤销一次。
 */
export async function applyMerge(input: ApplyMergeInput): Promise<ApplyMergeResult> {
  const { plotId, preview, resolutions, sourceLabel } = input;

  const treeInserts: TreeRecord[] = [];
  const treeUpdates: TreeRecord[] = [];
  const treeUpdatesBefore: TreeRecord[] = [];
  const regenInserts: RegenShrub[] = [];
  const regenUpdates: RegenShrub[] = [];
  const regenUpdatesBefore: RegenShrub[] = [];
  const changedTreeNos = changedTreeNosByRound(preview, resolutions);

  // 单边新增样木：直接并入（重映射为本机样地 id）
  preview.treeAdds.forEach(({ tree }) => {
    treeInserts.push({ ...tree, id: newId('tree'), plotId });
  });

  // 冲突样木：按调查员选定；采用导入组则整行覆盖到本机记录 id
  preview.treeConflicts.forEach((c) => {
    if (resolutions[c.key] === 'incoming') {
      treeUpdatesBefore.push(c.local);
      treeUpdates.push({ ...c.incoming, id: c.local.id, plotId });
    }
  });

  // 样方：本机无同键 → 新增；有同键 → 株数累加到本机记录
  preview.regenRows.forEach((row) => {
    if (row.action === 'insert' || !row.local) {
      const src = row.incoming[0];
      regenInserts.push({ ...src, id: newId('regen'), plotId, count: row.incomingCount });
    } else {
      regenUpdatesBefore.push(row.local);
      regenUpdates.push({ ...row.local, count: row.mergedCount });
    }
  });

  // 受影响的旧逐株比对：基准或本期变更 → 标待重算
  const existingRechecks = await db.rechecks.where('plotId').equals(plotId).toArray();
  const rechecksToStale = existingRechecks
    .map((row) => ({ row, reason: staleReasonFor(row, changedTreeNos) }))
    .filter((x) => x.reason !== '');
  const recheckUpdates = rechecksToStale.map(({ row, reason }) => ({
    ...row,
    stale: true,
    staleReason: reason,
  }));

  const checkpoint: MergeCheckpoint = {
    id: newId('cp'),
    plotId,
    createdAt: Date.now(),
    sourceLabel,
    treeInserts: treeInserts.map((t) => t.id),
    treeUpdates: treeUpdatesBefore,
    regenInserts: regenInserts.map((r) => r.id),
    regenUpdates: regenUpdatesBefore,
    rechecksBefore: rechecksToStale.map((x) => x.row),
  };

  await db.transaction(
    'rw',
    db.trees,
    db.regens,
    db.rechecks,
    db.mergeCheckpoints,
    async () => {
      if (treeInserts.length) await db.trees.bulkPut(treeInserts);
      if (treeUpdates.length) await db.trees.bulkPut(treeUpdates);
      if (regenInserts.length) await db.regens.bulkPut(regenInserts);
      if (regenUpdates.length) await db.regens.bulkPut(regenUpdates);
      if (recheckUpdates.length) await db.rechecks.bulkPut(recheckUpdates);
      await clearCheckpoints(plotId);
      await db.mergeCheckpoints.put(checkpoint);
    },
  );

  await Promise.all([useTreeStore.getState().load(), useRegenStore.getState().load()]);

  return {
    treeInserted: treeInserts.length,
    treeUpdated: treeUpdates.length,
    regenInserted: regenInserts.length,
    regenUpdated: regenUpdates.length,
    recheckStale: recheckUpdates.length,
  };
}

/** 撤销最近一次合并：删除新增、还原覆盖、恢复待重算比对、移除快照 */
export async function undoMerge(plotId: string): Promise<MergeCheckpoint> {
  const checkpoint = await loadLatestCheckpoint(plotId);
  if (!checkpoint) throw new Error('没有可撤销的合并记录');

  await db.transaction(
    'rw',
    db.trees,
    db.regens,
    db.rechecks,
    db.mergeCheckpoints,
    async () => {
      if (checkpoint.treeInserts.length) await db.trees.bulkDelete(checkpoint.treeInserts);
      if (checkpoint.treeUpdates.length) await db.trees.bulkPut(checkpoint.treeUpdates);
      if (checkpoint.regenInserts.length) await db.regens.bulkDelete(checkpoint.regenInserts);
      if (checkpoint.regenUpdates.length) await db.regens.bulkPut(checkpoint.regenUpdates);
      if (checkpoint.rechecksBefore.length) await db.rechecks.bulkPut(checkpoint.rechecksBefore);
      await db.mergeCheckpoints.delete(checkpoint.id);
    },
  );

  await Promise.all([useTreeStore.getState().load(), useRegenStore.getState().load()]);
  return checkpoint;
}
