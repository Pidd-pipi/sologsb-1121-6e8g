import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import type { ResolvedMerge } from '../types/merge';
import { newId } from './id';

export const DB_NAME = 'gbforestplot';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbforestplot:db-version';

/** 一次离线合并确认后的撤销快照（仅保留最近一次，可撤销一次） */
export interface MergeBackup {
  id: string;
  plotId: string;
  createdAt: number;
  /** 被覆盖或折叠删除的样木原行（撤销时整体还原） */
  treesBefore: TreeRecord[];
  /** 合并时新增的样木（撤销时删除） */
  treesInserted: TreeRecord[];
  /** 被株数更新或折叠删除的样方原行 */
  regensBefore: RegenShrub[];
  /** 合并时新增的样方行 */
  regensInserted: RegenShrub[];
  /** 被置为待重算的比对行原快照（撤销时还原 stale 标记） */
  rechecksTouched: RecheckDiff[];
  affectedRounds: number[];
}

class ForestPlotDB extends Dexie {
  plots!: Table<Plot, string>;
  trees!: Table<TreeRecord, string>;
  regens!: Table<RegenShrub, string>;
  rechecks!: Table<RecheckDiff, string>;
  mergeBackups!: Table<MergeBackup, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, createdAt',
      trees: 'id, plotId, treeNo, species, round, status',
      regens: 'id, plotId, layer, species, round',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo',
    });
    this.version(2)
      .stores({
        plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
        trees: 'id, plotId, treeNo, species, round, status, measuredAt',
        regens: 'id, plotId, layer, species, round, heightCm',
        rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('plots')
          .toCollection()
          .modify((row: any) => {
            if (row.locked === undefined) row.locked = false;
            if (row.surveyRound === undefined) row.surveyRound = 1;
          });
        await tx
          .table('trees')
          .toCollection()
          .modify((row: any) => {
            if (row.round === undefined) row.round = 1;
            if (row.measuredAt === undefined) row.measuredAt = Date.now();
          });
      });
    this.version(3).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
      trees: 'id, plotId, treeNo, species, round, status, measuredAt',
      regens: 'id, plotId, layer, species, round, heightCm',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt, stale',
      mergeBackups: 'id, plotId, createdAt',
    });
  }
}

export const db = new ForestPlotDB();

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 保存比对结果：先清掉同样地同期次对的旧结果（含待重算行），再整批写入 */
export async function replaceRecheckDiffs(diffs: RecheckDiff[]): Promise<void> {
  if (diffs.length === 0) return;
  const { plotId, baseRound, targetRound } = diffs[0];
  await db.transaction('rw', db.rechecks, async () => {
    const stale = await db.rechecks
      .where('plotId')
      .equals(plotId)
      .filter((d) => d.baseRound === baseRound && d.targetRound === targetRound)
      .primaryKeys();
    await db.rechecks.bulkDelete(stale);
    await db.rechecks.bulkPut(diffs);
  });
}

export async function loadRecheckDiffs(plotId: string): Promise<RecheckDiff[]> {
  const rows = await db.rechecks.where('plotId').equals(plotId).toArray();
  return rows.sort(
    (a, b) => a.baseRound - b.baseRound || a.targetRound - b.targetRound || a.treeNo.localeCompare(b.treeNo),
  );
}

/** 取出最近一次合并快照（仅保留一次撤销机会） */
export async function loadLatestMergeBackup(plotId?: string): Promise<MergeBackup | undefined> {
  const rows = await db.mergeBackups.orderBy('createdAt').reverse().toArray();
  return plotId ? rows.find((b) => b.plotId === plotId) : rows[0];
}

/**
 * 确认离线合并：单事务落库变更集，把基准变化期次的逐株比对置为待重算，
 * 同时写入撤销快照（覆盖上一次快照）。返回本次插入样木的最终记录。
 */
export async function commitMerge(resolved: ResolvedMerge, plotId: string): Promise<MergeBackup> {
  const now = Date.now();

  // 新增记录重新分配本机 id，避免与传入包 id 撞车
  const treesInserted: TreeRecord[] = resolved.treesToInsert.map((t) => ({
    ...t,
    id: newId('tree'),
    plotId,
  }));
  const regensInserted: RegenShrub[] = resolved.regensToInsert.map((r) => ({
    ...r,
    id: newId('regen'),
    plotId,
  }));

  const backup: MergeBackup = {
    id: newId('merge'),
    plotId,
    createdAt: now,
    treesBefore: [],
    treesInserted,
    regensBefore: [],
    regensInserted,
    rechecksTouched: [],
    affectedRounds: resolved.affectedRounds,
  };

  await db.transaction(
    'rw',
    db.trees,
    db.regens,
    db.rechecks,
    db.mergeBackups,
    async () => {
      // 1) 冲突中选择传入方：覆盖本机行
      await Promise.all(
        resolved.incomingWinners.map(async ({ localId, winner }) => {
          const before = await db.trees.get(localId);
          if (before) backup.treesBefore.push(before);
          await db.trees.put({ ...winner, id: localId, plotId });
        }),
      );

      // 2) 单边新增
      if (treesInserted.length > 0) await db.trees.bulkPut(treesInserted);

      // 3) 折叠本机重复样木行
      if (resolved.treesToDelete.length > 0) {
        await Promise.all(
          resolved.treesToDelete.map(async (tree) => {
            const before = await db.trees.get(tree.id);
            if (before) backup.treesBefore.push(before);
          }),
        );
        await db.trees.bulkDelete(resolved.treesToDelete.map((t) => t.id));
      }

      // 4) 样方：株数归并更新
      await Promise.all(
        resolved.regenUpdates.map(async ({ id, count }) => {
          const before = await db.regens.get(id);
          if (before) backup.regensBefore.push(before);
          await db.regens.update(id, { count });
        }),
      );

      // 5) 样方：折叠重复行 + 新增归并行
      if (resolved.regensToDelete.length > 0) {
        await Promise.all(
          resolved.regensToDelete.map(async (row) => {
            const before = await db.regens.get(row.id);
            if (before) backup.regensBefore.push(before);
          }),
        );
        await db.regens.bulkDelete(resolved.regensToDelete.map((r) => r.id));
      }
      if (regensInserted.length > 0) await db.regens.bulkPut(regensInserted);

      // 6) 逐株比对：基准期次受影响的标记待重算（保留旧值供参考，确认前不再汇总展示）
      if (resolved.affectedRounds.length > 0) {
        const rechecks = await db.rechecks.where('plotId').equals(plotId).toArray();
        rechecks.forEach((d) => {
          if (!d.stale && (resolved.affectedRounds.includes(d.baseRound) || resolved.affectedRounds.includes(d.targetRound))) {
            backup.rechecksTouched.push({ ...d });
          }
        });
        if (backup.rechecksTouched.length > 0) {
          await db.rechecks.bulkPut(backup.rechecksTouched.map((d) => ({ ...d, stale: true })));
        }
      }

      // 7) 仅保留一次撤销机会：清空旧快照后写入
      await db.mergeBackups.clear();
      await db.mergeBackups.put(backup);
    },
  );

  return backup;
}

/** 撤销最近一次离线合并（只能撤销一次，撤销后快照即失效） */
export async function undoMerge(backup: MergeBackup): Promise<void> {
  await db.transaction('rw', db.trees, db.regens, db.rechecks, db.mergeBackups, async () => {
    await db.trees.bulkDelete(backup.treesInserted.map((t) => t.id));
    await db.regens.bulkDelete(backup.regensInserted.map((r) => r.id));
    if (backup.treesBefore.length > 0) await db.trees.bulkPut(backup.treesBefore);
    if (backup.regensBefore.length > 0) await db.regens.bulkPut(backup.regensBefore);
    if (backup.rechecksTouched.length > 0) {
      // 仅还原当时被合并动作置为待重算的行，不覆盖调查员之后的重算结果
      const current = await db.rechecks.bulkGet(backup.rechecksTouched.map((d) => d.id));
      const restore = backup.rechecksTouched.filter((original, i) => current[i]?.stale === true);
      if (restore.length > 0) await db.rechecks.bulkPut(restore);
    }
    await db.mergeBackups.delete(backup.id);
  });
}

/** 首次进入灌入示范样地与两期样木数据 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.plots.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const plotId = newId('plot');
  const plot2Id = newId('plot');

  const plots: Plot[] = [
    {
      id: plotId,
      plotNo: 'FP-4102',
      locality: '黑龙江凉水林场 12 林班',
      lng: 128.8934,
      lat: 47.1832,
      shape: '方形',
      area: 600,
      elevation: 412,
      slope: 8,
      aspect: '东南',
      forestType: '针阔混交林',
      canopyDensity: 0.72,
      dominantSpecies: '红松 + 紫椴',
      surveyRound: 2,
      surveyedAt: now - 6 * day,
      crew: '调查一组（顾青、李慕）',
      locked: true,
      createdAt: now - 400 * day,
    },
    {
      id: plot2Id,
      plotNo: 'FP-4115',
      locality: '黑龙江凉水林场 15 林班',
      lng: 128.9012,
      lat: 47.1901,
      shape: '圆形',
      area: 500,
      elevation: 388,
      slope: 14,
      aspect: '西南',
      forestType: '阔叶林',
      canopyDensity: 0.65,
      dominantSpecies: '蒙古栎',
      surveyRound: 1,
      surveyedAt: now - 3 * day,
      crew: '调查二组（周砚）',
      locked: false,
      createdAt: now - 120 * day,
    },
  ];

  type Seed = [string, string, number, number, number, number, TreeRecord['status']];
  const seeds: Seed[] = [
    ['1', '红松', 34.2, 18.6, 7.4, 5.2, '活立木'],
    ['2', '紫椴', 26.8, 15.2, 5.1, 4.4, '活立木'],
    ['3', '红松', 41.5, 21.3, 9.2, 6.1, '活立木'],
    ['4', '蒙古栎', 18.4, 11.5, 3.6, 3.2, '活立木'],
    ['5', '色木槭', 12.6, 9.4, 2.8, 2.6, '活立木'],
  ];

  const trees: TreeRecord[] = [];
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw, status]) => {
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: dbh,
      heightM: h,
      underBranchH: ubh,
      crownWidth: cw,
      status,
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 1,
      measuredAt: now - 370 * day,
    });
  });
  // 第 2 期：树号 1/2/3/5 复测（胸径增大），树号 4 被采伐 → 复查比对可标记缺失
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw], index) => {
    if (treeNo === '4') return;
    const growth = [1.8, 1.4, 2.2, 0.9][index > 3 ? 3 : index];
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: Math.round((dbh + growth) * 10) / 10,
      heightM: Math.round((h + growth * 0.6) * 10) / 10,
      underBranchH: ubh,
      crownWidth: cw,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 2,
      measuredAt: now - 6 * day,
    });
  });
  // 第 2 期新增进界木
  trees.push({
    id: newId('tree'),
    plotId,
    treeNo: '6',
    species: '色木槭',
    dbhCm: 6.2,
    heightM: 6.1,
    underBranchH: 1.8,
    crownWidth: 1.9,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 1,
    remark: '样地东南 3m 进界木',
    round: 2,
    measuredAt: now - 6 * day,
  });
  trees.push({
    id: newId('tree'),
    plotId: plot2Id,
    treeNo: '1',
    species: '蒙古栎',
    dbhCm: 22.4,
    heightM: 13.2,
    underBranchH: 4.2,
    crownWidth: 4.1,
    status: '活立木',
    origin: '天然',
    healthClass: '亚健康',
    tiltDeg: 6,
    remark: '样地西侧',
    round: 1,
    measuredAt: now - 3 * day,
  });

  const regens: RegenShrub[] = [
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '红松',
      heightCm: 32,
      count: 18,
      ageGroup: '3 年生',
      distribution: '团状',
      browseDamage: '轻度',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '紫椴',
      heightCm: 55,
      count: 9,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '灌木',
      species: '毛榛子',
      heightCm: 120,
      count: 26,
      ageGroup: '多年生',
      distribution: '团状',
      browseDamage: '中度',
      round: 2,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '草本',
      species: '苔草',
      heightCm: 22,
      count: 140,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    },
  ];

  await db.transaction('rw', db.plots, db.trees, db.regens, db.rechecks, async () => {
    await db.plots.bulkPut(plots);
    await db.trees.bulkPut(trees);
    await db.regens.bulkPut(regens);
  });
}
