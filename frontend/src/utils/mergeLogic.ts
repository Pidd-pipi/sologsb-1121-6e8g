import type { RegenShrub } from '../types/regen';
import type { TreeRecord } from '../types/tree';
import type {
  MergePreview,
  OfflineBundle,
  RegenMergeRow,
  TreeConflict,
  TreeConflictField,
} from '../types/merge';
import { BUNDLE_FORMAT, BUNDLE_VERSION } from '../types/merge';

export function treeKey(round: number, treeNo: string): string {
  return `${round}#${treeNo}`;
}

export function regenKey(round: number, layer: string, species: string, heightCm: number): string {
  return `${round}#${layer}#${species}#${heightCm}`;
}

/** 关键字段（决定是否进冲突清单） */
const KEY_FIELDS: TreeConflictField[] = ['dbhCm', 'heightM', 'status'];

const OTHER_FIELDS: { key: keyof TreeRecord; label: string }[] = [
  { key: 'species', label: '树种' },
  { key: 'underBranchH', label: '枝下高' },
  { key: 'crownWidth', label: '冠幅' },
  { key: 'origin', label: '起源' },
  { key: 'healthClass', label: '健康等级' },
  { key: 'tiltDeg', label: '倾斜度' },
  { key: 'remark', label: '位置描述' },
];

function describeOtherDiffs(local: TreeRecord, incoming: TreeRecord): string[] {
  const diffs: string[] = [];
  OTHER_FIELDS.forEach(({ key, label }) => {
    const lv = local[key];
    const iv = incoming[key];
    if (typeof lv === 'number' && typeof iv === 'number') {
      if (lv !== iv) diffs.push(`${label}：${lv} → ${iv}`);
    } else if (String(lv ?? '') !== String(iv ?? '')) {
      diffs.push(`${label}：${lv || '空'} → ${iv || '空'}`);
    }
  });
  return diffs;
}

/** 解析并校验离线包文件内容 */
export function parseOfflineBundle(text: string): OfflineBundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON，请确认是另一台设备导出的 .json 离线包');
  }
  if (!data || typeof data !== 'object') throw new Error('离线包内容为空或结构不正确');
  const b = data as Partial<OfflineBundle>;
  if (b.format !== BUNDLE_FORMAT) {
    throw new Error(`离线包标识不匹配（期望 ${BUNDLE_FORMAT}），请确认文件来源`);
  }
  if (typeof b.version !== 'number' || b.version > BUNDLE_VERSION) {
    throw new Error('离线包版本较新，请先升级本应用后再导入');
  }
  if (!b.plot || typeof b.plot !== 'object') throw new Error('离线包缺少样地信息');
  if (!Array.isArray(b.trees) || !Array.isArray(b.regens)) throw new Error('离线包缺少样木或样方数据');
  return b as OfflineBundle;
}

/**
 * 生成合并预演（纯函数，不落库）。
 * - 同一树号同期：胸径、树高或状态不同 → 冲突；完全一致 → 保留本机（仅提示其他字段差异）
 * - 单边新增 → 直接并入
 * - 样方按 层位 + 种类 + 高度 + 期次 归并株数
 */
export function buildMergePreview(localTrees: TreeRecord[], localRegens: RegenShrub[], bundle: OfflineBundle): MergePreview {
  const treeConflicts: TreeConflict[] = [];
  const treeAdds: MergePreview['treeAdds'] = [];
  const treeIdentical: MergePreview['treeIdentical'] = [];
  const duplicateTreeKeys: string[] = [];

  // 本机按 期次+树号 建索引
  const localTreeMap = new Map<string, TreeRecord>();
  localTrees.forEach((t) => {
    localTreeMap.set(treeKey(t.round, t.treeNo), t);
  });

  // 导入包同树号同期若有重复，保留最后一条（模拟「以最后补录为准」）
  const incomingTreeMap = new Map<string, TreeRecord>();
  bundle.trees.forEach((t) => {
    const key = treeKey(t.round, t.treeNo);
    if (incomingTreeMap.has(key)) duplicateTreeKeys.push(key);
    incomingTreeMap.set(key, t);
  });

  const affectedRoundsSet = new Set<number>();

  incomingTreeMap.forEach((incoming, key) => {
    const local = localTreeMap.get(key);
    if (!local) {
      treeAdds.push({ key, tree: incoming });
      affectedRoundsSet.add(incoming.round);
      return;
    }
    const differingFields = KEY_FIELDS.filter((f) => local[f] !== incoming[f]);
    const otherDiffs = describeOtherDiffs(local, incoming);
    if (differingFields.length > 0) {
      treeConflicts.push({
        key,
        treeNo: incoming.treeNo,
        round: incoming.round,
        local,
        incoming,
        differingFields,
        otherDiffs,
      });
      affectedRoundsSet.add(incoming.round);
    } else {
      treeIdentical.push({ key, local, incoming, otherDiffs });
    }
  });

  // 样方归并：本机与导入包分别按 期次+层位+种类+高度 聚合
  const localRegenMap = new Map<string, RegenShrub>();
  localRegens.forEach((r) => {
    localRegenMap.set(regenKey(r.round, r.layer, r.species, r.heightCm), r);
  });

  const incomingRegenGroup = new Map<string, RegenShrub[]>();
  bundle.regens.forEach((r) => {
    const key = regenKey(r.round, r.layer, r.species, r.heightCm);
    const list = incomingRegenGroup.get(key) ?? [];
    list.push(r);
    incomingRegenGroup.set(key, list);
  });

  const regenRows: RegenMergeRow[] = [];
  incomingRegenGroup.forEach((list, key) => {
    const local = localRegenMap.get(key);
    const incomingCount = list.reduce((s, r) => s + r.count, 0);
    const mergedCount = (local?.count ?? 0) + incomingCount;
    const first = list[0];
    regenRows.push({
      key,
      layer: first.layer,
      species: first.species,
      heightCm: first.heightCm,
      round: first.round,
      local,
      incoming: list,
      incomingCount,
      mergedCount,
      action: local ? 'accumulate' : 'insert',
    });
    if (!local || local.count !== mergedCount) affectedRoundsSet.add(first.round);
  });

  return {
    treeConflicts: treeConflicts.sort(
      (a, b) => a.round - b.round || a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }),
    ),
    treeAdds: treeAdds.sort(
      (a, b) =>
        a.tree.round - b.tree.round ||
        a.tree.treeNo.localeCompare(b.tree.treeNo, 'zh-Hans-CN', { numeric: true }),
    ),
    treeIdentical: treeIdentical.sort(
      (a, b) =>
        a.incoming.round - b.incoming.round ||
        a.incoming.treeNo.localeCompare(b.incoming.treeNo, 'zh-Hans-CN', { numeric: true }),
    ),
    regenRows: regenRows.sort(
      (a, b) =>
        a.round - b.round ||
        a.layer.localeCompare(b.layer) ||
        a.species.localeCompare(b.species, 'zh-Hans-CN') ||
        a.heightCm - b.heightCm,
    ),
    incomingTreeCount: bundle.trees.length,
    incomingRegenCount: bundle.regens.length,
    duplicateTreeKeys: Array.from(new Set(duplicateTreeKeys)),
    affectedRounds: Array.from(affectedRoundsSet).sort((a, b) => a - b),
  };
}

/** 组内归并一份「本设备数据」离线包（导出侧使用，不做跨设备比对） */
export function buildExportBundle(
  plot: { plotNo: string; locality: string; surveyRound: number; crew: string },
  trees: TreeRecord[],
  regens: RegenShrub[],
  crew: string,
): OfflineBundle {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    crew: crew.trim() || plot.crew || '未署名调查组',
    plot: {
      plotNo: plot.plotNo,
      locality: plot.locality,
      surveyRound: plot.surveyRound,
      crew: plot.crew,
    },
    trees,
    regens,
  };
}
