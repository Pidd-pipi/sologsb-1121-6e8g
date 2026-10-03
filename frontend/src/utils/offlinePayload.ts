import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { OfflinePayload } from '../types/merge';

export interface ParsedIncoming {
  trees: TreeRecord[];
  regens: RegenShrub[];
  crew?: string;
  exportedAt: number;
  droppedRows: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 解析并校验离线调查包。
 * 优先按样地 id 识别；换机导出 id 不一致时回退按样地号识别并把行重映射到当前样地。
 * 不属于该样地时报错；缺字段的坏行直接剔除计数。
 */
export function parseOfflinePayload(raw: string, plotId: string, plotNo: string): ParsedIncoming {
  let data: OfflinePayload;
  try {
    data = JSON.parse(raw) as OfflinePayload;
  } catch {
    throw new Error('文件不是合法的 JSON，请选择另一组导出的离线调查包');
  }
  if (!data || data.format !== 'gbforestplot-offline' || data.version !== 1) {
    throw new Error('离线包格式无法识别（应为 gbforestplot-offline v1）');
  }
  const idMatch = data.plotId === plotId;
  const noMatch = !!data.plotNo && data.plotNo === plotNo;
  if (!idMatch && !noMatch) {
    throw new Error(`该离线包属于样地「${data.plotNo ?? data.plotId}」，与当前样地「${plotNo}」不一致`);
  }
  let droppedRows = 0;
  const exportedAt = isFiniteNumber(data.exportedAt) ? data.exportedAt : Date.now();

  const trees: TreeRecord[] = (Array.isArray(data.trees) ? data.trees : [])
    .filter((t) => t && typeof t.treeNo === 'string' && t.treeNo.trim())
    .map((t) => {
      if (!isFiniteNumber(t.dbhCm) || !isFiniteNumber(t.heightM) || typeof t.status !== 'string' || !isFiniteNumber(t.round)) {
        droppedRows += 1;
        return null;
      }
      return {
        ...t,
        plotId,
        treeNo: t.treeNo.trim(),
        species: typeof t.species === 'string' ? t.species : '',
        round: Math.trunc(t.round),
        measuredAt: isFiniteNumber(t.measuredAt) ? t.measuredAt : exportedAt,
      } as TreeRecord;
    })
    .filter((t): t is TreeRecord => t !== null);

  const regens: RegenShrub[] = (Array.isArray(data.regens) ? data.regens : [])
    .filter((r) => r && typeof r.species === 'string' && r.species.trim())
    .map((r) => {
      if (!isFiniteNumber(r.heightCm) || !isFiniteNumber(r.count) || !isFiniteNumber(r.round)) {
        droppedRows += 1;
        return null;
      }
      return {
        ...r,
        plotId,
        species: r.species.trim(),
        round: Math.trunc(r.round),
        count: Math.trunc(r.count),
      } as RegenShrub;
    })
    .filter((r): r is RegenShrub => r !== null);

  if (trees.length === 0 && regens.length === 0) {
    throw new Error('离线包内没有可并入的样木或样方记录');
  }
  return { trees, regens, crew: data.crew, exportedAt, droppedRows };
}
