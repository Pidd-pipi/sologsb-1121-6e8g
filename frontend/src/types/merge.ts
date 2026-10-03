import type { TreeRecord } from './tree';
import type { RegenShrub } from '../types/regen';

/** 离线调查包文件格式（另一组调查员在同一固定样地离线记录后导出） */
export interface OfflinePayload {
  format: 'gbforestplot-offline';
  version: 1;
  exportedAt: number;
  /** 导出方调查组 */
  crew?: string;
  plotId: string;
  plotNo?: string;
  trees: TreeRecord[];
  regens: RegenShrub[];
}

/** 冲突时调查员可选的一方：本机已有记录 / 离线传入记录 */
export type MergeSide = 'local' | 'incoming';

export const MERGE_SIDE_LABEL: Record<MergeSide, string> = {
  local: '本机记录',
  incoming: '传入记录',
};

/** 样木冲突字段 */
export type TreeConflictField = 'dbhCm' | 'heightM' | 'status';

export const CONFLICT_FIELD_LABEL: Record<TreeConflictField, string> = {
  dbhCm: '胸径 cm',
  heightM: '树高 m',
  status: '状态',
};

/** 同一树号同期两份记录的单个字段差异 */
export interface FieldDelta {
  field: TreeConflictField;
  label: string;
  local: number | string;
  incoming: number | string;
}

/** 样木冲突：同树号同期，胸径 / 树高 / 状态任一不同 */
export interface TreeConflict {
  key: string;
  treeNo: string;
  round: number;
  species: string;
  localId: string;
  incomingId: string;
  local: TreeRecord;
  incoming: TreeRecord;
  deltas: FieldDelta[];
  /** 调查员选定的一方，未定时为空 */
  resolution?: MergeSide;
}

/** 单边新增的并入计划（仅传入方有该树号期次） */
export interface TreeAddPlan {
  tree: TreeRecord;
  side: MergeSide;
}

/**
 * 样方归并计划：同层位 + 种类 + 高度 + 期次的株数相加，
 * 多行折叠到一条，撤销时凭快照恢复。
 */
export interface RegenGroupPlan {
  key: string;
  layer: RegenShrub['layer'];
  species: string;
  heightCm: number;
  round: number;
  /** 本机原有株数（可能由多条重复行合计） */
  localCount: number;
  /** 传入株数合计 */
  incomingCount: number;
  /** 归并后株数 */
  mergedCount: number;
  /** 并入已有行时保留更新的本机行 id；无本机行时确认阶段新增 */
  targetId?: string;
  /** 被折叠删除的本机重复行（撤销快照用） */
  folded: RegenShrub[];
  /** 无本机行时作为新增模板的传入行 */
  incoming?: RegenShrub;
}

/** 可撤销预演结果 */
export interface MergePreview {
  plotId: string;
  crew?: string;
  exportedAt: number;
  treeConflicts: TreeConflict[];
  treeAdds: TreeAddPlan[];
  regenGroups: RegenGroupPlan[];
  /** 本机同树号同期的重复行，确认时折叠（防御性归并） */
  localTreeFolded: TreeRecord[];
  /** 传入包内同树号同期的重复条数（已折叠计为一条） */
  incomingTreeDuplicates: number;
}

/** 调查员对全部冲突的裁定，key 为 TreeConflict.key */
export type ConflictResolutions = Record<string, MergeSide>;

/** 确认阶段实际落库的变更集 */
export interface ResolvedMerge {
  /** 冲突中选择传入方：用传入记录覆盖本机行（保留本机 id） */
  incomingWinners: { localId: string; winner: TreeRecord }[];
  /** 单边新增待插入 */
  treesToInsert: TreeRecord[];
  /** 本机重复行待折叠删除 */
  treesToDelete: TreeRecord[];
  /** 样方已有行株数更新 */
  regenUpdates: { id: string; count: number }[];
  /** 样方重复行待折叠删除 */
  regensToDelete: RegenShrub[];
  /** 样方新增行 */
  regensToInsert: RegenShrub[];
  /** 样木基准发生变化的期次，命中的逐株比对标记待重算 */
  affectedRounds: number[];
}

export function treePairKey(treeNo: string, round: number): string {
  return `${round}#${treeNo}`;
}

export function regenGroupKey(row: Pick<RegenShrub, 'layer' | 'species' | 'heightCm' | 'round'>): string {
  return `${row.round}|${row.layer}|${row.species}|${row.heightCm}`;
}

/** 胸径 / 树高测量值比较（录入精度 0.1，留容差） */
function measuredEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.05;
}

/** 比较同一树号同期的两份样木，列出胸径 / 树高 / 状态差异 */
export function diffTreePair(local: TreeRecord, incoming: TreeRecord): FieldDelta[] {
  const deltas: FieldDelta[] = [];
  if (!measuredEqual(local.dbhCm, incoming.dbhCm)) {
    deltas.push({ field: 'dbhCm', label: CONFLICT_FIELD_LABEL.dbhCm, local: local.dbhCm, incoming: incoming.dbhCm });
  }
  if (!measuredEqual(local.heightM, incoming.heightM)) {
    deltas.push({ field: 'heightM', label: CONFLICT_FIELD_LABEL.heightM, local: local.heightM, incoming: incoming.heightM });
  }
  if (local.status !== incoming.status) {
    deltas.push({ field: 'status', label: CONFLICT_FIELD_LABEL.status, local: local.status, incoming: incoming.status });
  }
  return deltas;
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  rows.forEach((row) => {
    const key = keyOf(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  });
  return map;
}

/**
 * 离线合并预演（纯函数，不落库）：
 * - 同树号同期两份记录，胸径/树高/状态不同 → 冲突清单；
 * - 仅传入方有的树号期次 → 单边新增直接并入；
 * - 样方按 层位+种类+高度+期次 归并株数。
 */
export function buildMergePreview(
  plotId: string,
  localTrees: TreeRecord[],
  localRegens: RegenShrub[],
  incomingTrees: TreeRecord[],
  incomingRegens: RegenShrub[],
  meta: { crew?: string; exportedAt?: number } = {},
): MergePreview {
  const localTreeMap = groupBy(localTrees, (t) => treePairKey(t.treeNo, t.round));
  const incomingTreeMap = groupBy(incomingTrees, (t) => treePairKey(t.treeNo, t.round));

  const treeConflicts: TreeConflict[] = [];
  const treeAdds: TreeAddPlan[] = [];
  const localTreeFolded: TreeRecord[] = [];
  let incomingTreeDuplicates = 0;

  incomingTreeMap.forEach((incomingRows, key) => {
    // 传入包内同树号同期重复：以测量时间最新者为准，余者折叠计数
    const representative = [...incomingRows].sort((a, b) => b.measuredAt - a.measuredAt)[0];
    incomingTreeDuplicates += incomingRows.length - 1;

    const localRows = localTreeMap.get(key);
    if (!localRows || localRows.length === 0) {
      treeAdds.push({ tree: { ...representative, plotId }, side: 'incoming' });
      return;
    }
    const localPrimary = localRows[0];
    if (localRows.length > 1) localTreeFolded.push(...localRows.slice(1));

    const deltas = diffTreePair(localPrimary, representative);
    if (deltas.length > 0) {
      treeConflicts.push({
        key,
        treeNo: localPrimary.treeNo,
        round: localPrimary.round,
        species: representative.species || localPrimary.species,
        localId: localPrimary.id,
        incomingId: representative.id,
        local: localPrimary,
        incoming: representative,
        deltas,
      });
    }
  });

  // 本机同树号同期但传入包没有的树号：防御性折叠重复行
  localTreeMap.forEach((localRows) => {
    if (localRows.length > 1 && !incomingTreeMap.has(treePairKey(localRows[0].treeNo, localRows[0].round))) {
      localTreeFolded.push(...localRows.slice(1));
    }
  });

  // 样方：按 层位|种类|高度|期次 归并，仅处理传入包涉及的组
  const localRegenMap = groupBy(localRegens, regenGroupKey);
  const incomingRegenMap = groupBy(incomingRegens, regenGroupKey);
  const regenGroups: RegenGroupPlan[] = [];

  incomingRegenMap.forEach((rows, key) => {
    const first = rows[0];
    const incomingCount = rows.reduce((sum, r) => sum + r.count, 0);
    const localRows = localRegenMap.get(key) ?? [];
    const localCount = localRows.reduce((sum, r) => sum + r.count, 0);
    const target = localRows[0];
    regenGroups.push({
      key,
      layer: first.layer,
      species: first.species,
      heightCm: first.heightCm,
      round: first.round,
      localCount,
      incomingCount,
      mergedCount: localCount + incomingCount,
      targetId: target?.id,
      folded: localRows.slice(1),
      incoming: target ? undefined : { ...rows[rows.length - 1], plotId, count: incomingCount },
    });
  });

  treeConflicts.sort((a, b) => a.round - b.round || a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
  treeAdds.sort((a, b) => a.tree.round - b.tree.round || a.tree.treeNo.localeCompare(b.tree.treeNo, 'zh-Hans-CN', { numeric: true }));
  regenGroups.sort((a, b) => a.round - b.round || a.layer.localeCompare(b.layer) || a.species.localeCompare(b.species));

  return {
    plotId,
    crew: meta.crew,
    exportedAt: meta.exportedAt ?? Date.now(),
    treeConflicts,
    treeAdds,
    regenGroups,
    localTreeFolded,
    incomingTreeDuplicates,
  };
}

/** 按调查员裁定把预演结果收敛为落库变更集 */
export function finalizeMerge(preview: MergePreview, resolutions: ConflictResolutions): ResolvedMerge {
  const incomingWinners: ResolvedMerge['incomingWinners'] = [];
  const affected = new Set<number>();

  preview.treeConflicts.forEach((conflict) => {
    if (resolutions[conflict.key] === 'incoming') {
      incomingWinners.push({
        localId: conflict.localId,
        winner: { ...conflict.incoming, id: conflict.localId, plotId: preview.plotId },
      });
      affected.add(conflict.round);
    }
  });

  preview.treeAdds.forEach((plan) => {
    if (plan.side === 'incoming') affected.add(plan.tree.round);
  });
  preview.localTreeFolded.forEach((tree) => affected.add(tree.round));

  const regenUpdates: ResolvedMerge['regenUpdates'] = [];
  const regensToDelete: RegenShrub[] = [];
  const regensToInsert: RegenShrub[] = [];

  preview.regenGroups.forEach((group) => {
    regensToDelete.push(...group.folded);
    if (group.targetId) {
      regenUpdates.push({ id: group.targetId, count: group.mergedCount });
    } else if (group.incoming) {
      regensToInsert.push(group.incoming);
    }
  });

  return {
    incomingWinners,
    treesToInsert: preview.treeAdds.filter((p) => p.side === 'incoming').map((p) => p.tree),
    treesToDelete: preview.localTreeFolded,
    regenUpdates,
    regensToDelete,
    regensToInsert,
    affectedRounds: Array.from(affected).sort((a, b) => a - b),
  };
}
