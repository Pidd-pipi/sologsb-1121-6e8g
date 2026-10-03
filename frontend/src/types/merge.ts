import type { TreeRecord } from './tree';
import type { RegenShrub } from './regen';
import type { RecheckDiff } from './recheck';

/** 离线数据包标识 */
export const BUNDLE_FORMAT = 'gbforestplot-offline';
export const BUNDLE_VERSION = 1;

/** 离线包中的样地摘要（用于核对样地身份，不覆盖本机建档信息） */
export interface OfflineBundlePlot {
  plotNo: string;
  locality: string;
  surveyRound: number;
  crew: string;
}

/** 一组调查员离线带回的数据包 */
export interface OfflineBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: number;
  /** 导出本组 */
  crew: string;
  plot: OfflineBundlePlot;
  trees: TreeRecord[];
  regens: RegenShrub[];
}

/** 触发冲突的三项关键字段：胸径、树高、状态 */
export type TreeConflictField = 'dbhCm' | 'heightM' | 'status';

export const TREE_CONFLICT_FIELD_LABELS: Record<TreeConflictField, string> = {
  dbhCm: '胸径',
  heightM: '树高',
  status: '状态',
};

/** 同一树号同期、胸径/树高/状态存在分歧 */
export interface TreeConflict {
  /** `${round}#${treeNo}` */
  key: string;
  treeNo: string;
  round: number;
  local: TreeRecord;
  incoming: TreeRecord;
  /** 有分歧的关键字段（至少一项） */
  differingFields: TreeConflictField[];
  /** 关键字段一致、但其他属性不同（仅提示，不阻断合并） */
  otherDiffs: string[];
}

/** 单边新增样木（本机没有该树号同期记录） */
export interface TreeMergeAdd {
  key: string;
  tree: TreeRecord;
}

/** 关键字段完全一致，本机记录保留 */
export interface TreeMergeIdentical {
  key: string;
  local: TreeRecord;
  incoming: TreeRecord;
  otherDiffs: string[];
}

/** 样方按层位、种类、高度归并后的一行 */
export interface RegenMergeRow {
  /** `${round}#${layer}#${species}#${heightCm}` */
  key: string;
  layer: RegenShrub['layer'];
  species: string;
  heightCm: number;
  round: number;
  /** 本机同键记录（无则为新增组） */
  local?: RegenShrub;
  /** 导入包中同键的全部记录 */
  incoming: RegenShrub[];
  /** 导入侧株数合计 */
  incomingCount: number;
  /** 归并后株数 */
  mergedCount: number;
  /** insert=本机新增一条；accumulate=株数累加进本机记录 */
  action: 'insert' | 'accumulate';
}

/** 合并预演结果（确认前不落库） */
export interface MergePreview {
  treeConflicts: TreeConflict[];
  treeAdds: TreeMergeAdd[];
  treeIdentical: TreeMergeIdentical[];
  regenRows: RegenMergeRow[];
  incomingTreeCount: number;
  incomingRegenCount: number;
  /** 导入包自身同树号同期重复（取最后一条） */
  duplicateTreeKeys: string[];
  /** 预演后实际会发生变化的期次（用于待重算判定与提示） */
  affectedRounds: number[];
}

/** 调查员对冲突的选定：保留本机 / 采用导入组 */
export type ConflictResolution = 'local' | 'incoming';

/**
 * 合并确认前的撤销快照（一次合并一条，同一新合并覆盖旧的 → 只可撤销一次）。
 * insert 类回滚按 id 删除；update 类回滚整行还原；rechecks 恢复被标待重算前的整行。
 */
export interface MergeCheckpoint {
  id: string;
  plotId: string;
  createdAt: number;
  /** 来源描述，如「调查二组（周砚）· 2026-10-03 导出」 */
  sourceLabel: string;
  treeInserts: string[];
  treeUpdates: TreeRecord[];
  regenInserts: string[];
  regenUpdates: RegenShrub[];
  /** 被标记为待重算的比对行整行备份（撤销时还原） */
  rechecksBefore: RecheckDiff[];
}

export interface CheckpointMeta {
  id: string;
  plotId: string;
  createdAt: number;
  sourceLabel: string;
  treeInsertCount: number;
  treeUpdateCount: number;
  regenInsertCount: number;
  regenUpdateCount: number;
  recheckStaleCount: number;
}

export function checkpointMeta(cp: MergeCheckpoint): CheckpointMeta {
  return {
    id: cp.id,
    plotId: cp.plotId,
    createdAt: cp.createdAt,
    sourceLabel: cp.sourceLabel,
    treeInsertCount: cp.treeInserts.length,
    treeUpdateCount: cp.treeUpdates.length,
    regenInsertCount: cp.regenInserts.length,
    regenUpdateCount: cp.regenUpdates.length,
    recheckStaleCount: cp.rechecksBefore.length,
  };
}
