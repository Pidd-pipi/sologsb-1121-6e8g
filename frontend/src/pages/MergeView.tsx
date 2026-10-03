import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
  type TableProps,
} from 'antd';
import {
  CloudUploadOutlined,
  DownloadOutlined,
  MergeCellsOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import { useMergeStore } from '../stores/mergeStore';
import RoundTag from '../components/common/RoundTag';
import {
  buildMergePreview,
  finalizeMerge,
  MERGE_SIDE_LABEL,
  type ConflictResolutions,
  type MergePreview,
  type MergeSide,
  type OfflinePayload,
  type RegenGroupPlan,
  type TreeConflict,
  type TreeAddPlan,
} from '../types/merge';
import {
  commitMerge,
  loadLatestMergeBackup,
  undoMerge,
  type MergeBackup,
} from '../utils/db';
import { parseOfflinePayload } from '../utils/offlinePayload';

type ConflictColumns = NonNullable<TableProps<TreeConflict>['columns']>;
type AddColumns = NonNullable<TableProps<TreeAddPlan>['columns']>;
type RegenColumns = NonNullable<TableProps<RegenGroupPlan>['columns']>;

/** /plots/:id/merge 离线合并：导入 → 可撤销预演 → 冲突裁定 → 确认（可撤销一次） */
export default function MergeView() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const allTrees = useTreeStore((s) => s.items);
  const allRegens = useRegenStore((s) => s.items);
  const reloadTrees = useTreeStore((s) => s.load);
  const reloadRegens = useRegenStore((s) => s.load);

  const pending = useMergeStore((s) => s.pending[id]);
  const stage = useMergeStore((s) => s.stage);
  const resolveConflict = useMergeStore((s) => s.resolveConflict);
  const setResolutions = useMergeStore((s) => s.setResolutions);
  const clearPending = useMergeStore((s) => s.clear);

  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [backup, setBackup] = useState<MergeBackup | undefined>(undefined);
  const [committedAt, setCommittedAt] = useState<number | undefined>(undefined);
  const [undoing, setUndoing] = useState(false);

  const localTrees = useMemo(() => allTrees.filter((t) => t.plotId === id), [allTrees, id]);
  const localRegens = useMemo(() => allRegens.filter((r) => r.plotId === id), [allRegens, id]);

  const refreshBackup = async () => {
    setBackup(await loadLatestMergeBackup(id));
  };

  useEffect(() => {
    void refreshBackup();
  }, [id]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const preview: MergePreview | undefined = pending?.preview;
  const resolutions: ConflictResolutions = pending?.resolutions ?? {};

  const resolvedCount = preview
    ? preview.treeConflicts.filter((c) => resolutions[c.key] !== undefined).length
    : 0;
  const allResolved = preview ? resolvedCount === preview.treeConflicts.length : false;
  const regenAddedStems = preview ? preview.regenGroups.reduce((sum, g) => sum + g.incomingCount, 0) : 0;
  const affectedRounds = preview ? Array.from(new Set([...preview.treeConflicts.map((c) => c.round), ...preview.treeAdds.map((a) => a.tree.round)])).sort((a, b) => a - b) : [];

  const readFile = async (file: File) => {
    try {
      if (!plot) return;
      const incoming = parseOfflinePayload(await file.text(), plot.id, plot.plotNo);
      const next = buildMergePreview(
        plot.id,
        localTrees,
        localRegens,
        incoming.trees,
        incoming.regens,
        { crew: incoming.crew, exportedAt: incoming.exportedAt },
      );
      stage(next, {});
      setCommittedAt(undefined);
      setError('');
      setToast(
        `已读入离线包（${incoming.trees.length} 株样木、${incoming.regens.length} 条样方），` +
          `发现冲突 ${next.treeConflicts.length} 处、单边新增 ${next.treeAdds.length} 株` +
          (incoming.droppedRows > 0 ? `；另有 ${incoming.droppedRows} 行因字段缺失已跳过` : ''),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '离线包读取失败');
    }
  };

  const exportOfflinePackage = () => {
    if (!plot) return;
    const round = plot.surveyRound;
    const payload: OfflinePayload = {
      format: 'gbforestplot-offline',
      version: 1,
      exportedAt: Date.now(),
      crew: plot.crew,
      plotId: plot.id,
      plotNo: plot.plotNo,
      trees: localTrees.filter((t) => t.round === round),
      regens: localRegens.filter((r) => r.round === round),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `离线调查包_${plot.plotNo}_第${round}期.json`;
    a.click();
    URL.revokeObjectURL(url);
    setToast('已导出本机本期离线调查包，可交给另一组离线使用');
  };

  const cancelPreview = () => {
    clearPending(id);
    setToast('已取消合并预演，本机数据未做任何改动');
  };

  const confirmMerge = async () => {
    if (!preview || !plot) return;
    if (!allResolved) {
      setError(`还有 ${preview.treeConflicts.length - resolvedCount} 处冲突未选定保留方，请逐条裁定`);
      return;
    }
    const resolved = finalizeMerge(preview, resolutions);
    await commitMerge(resolved, plot.id);
    await Promise.all([reloadTrees(), reloadRegens()]);
    setCommittedAt(Date.now());
    clearPending(id);
    await refreshBackup();
    setError('');
    setToast(
      `合并已确认：采用传入记录 ${resolved.incomingWinners.length} 株，单边新增 ${resolved.treesToInsert.length} 株，` +
        `样方归并 ${resolved.regenUpdates.length + resolved.regensToInsert.length} 组；可撤销一次`,
    );
  };

  const undo = async () => {
    if (!backup) return;
    setUndoing(true);
    try {
      await undoMerge(backup);
      await Promise.all([reloadTrees(), reloadRegens()]);
      setBackup(undefined);
      setCommittedAt(undefined);
      setToast('已撤销最近一次离线合并，样木、样方与逐株比对均恢复到合并前');
    } finally {
      setUndoing(false);
    }
  };

  const conflictColumns: ConflictColumns = useMemo(
    () => [
      { title: '树号', dataIndex: 'treeNo', width: 80 },
      { title: '期次', dataIndex: 'round', width: 80, render: (v: number) => `第 ${v} 期` },
      { title: '树种', dataIndex: 'species', width: 110 },
      {
        title: '差异项（本机 → 传入）',
        render: (_: unknown, row: TreeConflict) => (
          <Space size={4} wrap>
            {row.deltas.map((d) => (
              <Tag key={d.field} color="volcano">
                {d.label}：{String(d.local)} → {String(d.incoming)}
              </Tag>
            ))}
          </Space>
        ),
      },
      {
        title: '保留方（调查员选定）',
        width: 280,
        render: (_: unknown, row: TreeConflict) => (
          <Radio.Group
            value={resolutions[row.key]}
            onChange={(e) => resolveConflict(id, row.key, e.target.value as MergeSide)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { value: 'local', label: MERGE_SIDE_LABEL.local },
              { value: 'incoming', label: MERGE_SIDE_LABEL.incoming },
            ]}
          />
        ),
      },
    ],
    [resolutions, resolveConflict, id],
  );

  const addColumns: AddColumns = [
    { title: '树号', dataIndex: ['tree', 'treeNo'], width: 80 },
    { title: '期次', dataIndex: ['tree', 'round'], width: 80, render: (_: unknown, row: TreeAddPlan) => `第 ${row.tree.round} 期` },
    { title: '树种', dataIndex: ['tree', 'species'], width: 120 },
    { title: '胸径 cm', dataIndex: ['tree', 'dbhCm'], width: 100 },
    { title: '树高 m', dataIndex: ['tree', 'heightM'], width: 90 },
    {
      title: '状态',
      dataIndex: ['tree', 'status'],
      width: 100,
      render: (v: string) => <Tag color={v === '活立木' ? 'green' : 'orange'}>{v}</Tag>,
    },
    { title: '并入方式', width: 160, render: () => <Tag color="blue">单边新增 · 直接并入</Tag> },
  ];

  const regenColumns: RegenColumns = [
    { title: '期次', dataIndex: 'round', width: 80, render: (v: number) => `第 ${v} 期` },
    {
      title: '层位',
      dataIndex: 'layer',
      width: 90,
      render: (v: string) => <Tag color={v === '更新苗' ? 'green' : v === '灌木' ? 'blue' : 'default'}>{v}</Tag>,
    },
    { title: '种类', dataIndex: 'species', width: 130 },
    { title: '高度 cm', dataIndex: 'heightCm', width: 100 },
    { title: '本机株数', dataIndex: 'localCount', width: 100 },
    { title: '传入株数', dataIndex: 'incomingCount', width: 100, render: (v: number) => <Tag color="cyan">+{v}</Tag> },
    {
      title: '归并后株数',
      dataIndex: 'mergedCount',
      width: 120,
      render: (v: number) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: '归并方式',
      width: 120,
      render: (_: unknown, row: RegenGroupPlan) => (row.targetId ? <Tag>并入已有行</Tag> : <Tag color="blue">新增一行</Tag>),
    },
  ];

  if (!plot) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该样地" />
        <Link to="/plots">返回样地台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          离线合并 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={plot.surveyRound} locked={plot.locked} />
        <Tag icon={<MergeCellsOutlined />} color="purple">
          两组调查员离线记录合并
        </Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/recheck`}>复查比对</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {preview ? (
        <Alert
          type="info"
          showIcon
          message="合并预演尚未确认：当前仅为预演结果，本机数据未改动；确认前林分汇总页不会显示旧生长量。"
        />
      ) : null}
      {backup && !preview ? (
        <Alert
          type="warning"
          showIcon
          message={
            committedAt
              ? `合并已于 ${new Date(committedAt).toLocaleTimeString('zh-CN')} 确认，仍可撤销一次`
              : `存在 ${new Date(backup.createdAt).toLocaleString('zh-CN')} 的已确认合并，可撤销一次`
          }
          action={
            <Button danger icon={<RollbackOutlined />} loading={undoing} onClick={undo}>
              撤销本次合并
            </Button>
          }
        />
      ) : null}

      <Card size="small" title="导入另一组的离线调查包">
        <Space wrap size={16} align="center">
          <Upload.Dragger
            accept=".json,application/json"
            showUploadList={false}
            style={{ padding: '12px 28px' }}
            beforeUpload={(file) => {
              void readFile(file);
              return false;
            }}
          >
            <Space direction="vertical" size={2}>
              <CloudUploadOutlined style={{ fontSize: 26, color: '#7a9b86' }} />
              <Typography.Text>点击或拖入离线包 JSON</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                按样地号识别，只并入当前样地的样木与样方
              </Typography.Text>
            </Space>
          </Upload.Dragger>
          <Space direction="vertical" size={8}>
            <Typography.Paragraph type="secondary" style={{ margin: 0, maxWidth: 360 }}>
              两组调查员在同一固定样地离线记录，回来后各自导出离线包，在此导入预演：
              <br />
              同树号同期两份记录胸径、树高或状态不同的进入冲突清单，由调查员选定保留方；单边新增直接并入；样方按层位、种类和高度归并株数。
            </Typography.Paragraph>
            <Button icon={<DownloadOutlined />} onClick={exportOfflinePackage}>
              导出本机本期离线包（第 {plot.surveyRound} 期）
            </Button>
          </Space>
        </Space>
      </Card>

      {preview ? (
        <>
          <Row gutter={12}>
            <Col span={5}>
              <Card size="small">
                <Statistic
                  title="样木冲突（已裁定 / 总数）"
                  value={preview.treeConflicts.length === 0 ? 0 : `${resolvedCount} / ${preview.treeConflicts.length}`}
                  suffix={preview.treeConflicts.length === 0 ? '处' : '处'}
                  valueStyle={allResolved ? { color: '#389e0d' } : { color: '#cf1322' }}
                />
              </Card>
            </Col>
            <Col span={5}>
              <Card size="small">
                <Statistic title="单边新增样木" value={preview.treeAdds.length} suffix="株" />
              </Card>
            </Col>
            <Col span={5}>
              <Card size="small">
                <Statistic
                  title="样方归并"
                  value={preview.regenGroups.length}
                  suffix={`组 / +${regenAddedStems} 株`}
                />
              </Card>
            </Col>
            <Col span={5}>
              <Card size="small">
                <Statistic
                  title="受影响期次（比对将待重算）"
                  value={affectedRounds.length === 0 ? '—' : affectedRounds.map((r) => `第${r}期`).join('、')}
                />
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small">
                <Statistic
                  title="重复行折叠"
                  value={preview.localTreeFolded.length + preview.incomingTreeDuplicates}
                  suffix="行"
                />
              </Card>
            </Col>
          </Row>

          <Card size="small" title={`冲突清单（${preview.treeConflicts.length} 处，须逐条选定保留方）`}>
            <Space style={{ marginBottom: 8 }}>
              <Button
                size="small"
                onClick={() => {
                  const next: ConflictResolutions = {};
                  preview.treeConflicts.forEach((c) => {
                    next[c.key] = 'local';
                  });
                  setResolutions(id, next);
                }}
              >
                全部保留本机
              </Button>
              <Button
                size="small"
                onClick={() => {
                  const next: ConflictResolutions = {};
                  preview.treeConflicts.forEach((c) => {
                    next[c.key] = 'incoming';
                  });
                  setResolutions(id, next);
                }}
              >
                全部采用传入
              </Button>
              <Typography.Text type="secondary">裁定后可随时改动，点「确认合并」才会落库</Typography.Text>
            </Space>
            <Table<TreeConflict>
              rowKey="key"
              size="small"
              columns={conflictColumns}
              dataSource={preview.treeConflicts}
              pagination={false}
              locale={{ emptyText: '没有同树号同期但测量值不同的冲突记录' }}
              rowClassName={(row) => (resolutions[row.key] ? 'merge-resolved-row' : 'merge-conflict-row')}
            />
          </Card>

          <Card size="small" title={`单边新增样木（${preview.treeAdds.length} 株，直接并入）`}>
            <Table<TreeAddPlan>
              rowKey={(row) => `${row.tree.round}-${row.tree.treeNo}`}
              size="small"
              columns={addColumns}
              dataSource={preview.treeAdds}
              pagination={false}
              locale={{ emptyText: '传入包没有单边新增样木' }}
            />
          </Card>

          <Card size="small" title={`样方株数归并（按层位、种类、高度；${preview.regenGroups.length} 组）`}>
            <Table<RegenGroupPlan>
              rowKey="key"
              size="small"
              columns={regenColumns}
              dataSource={preview.regenGroups}
              pagination={false}
              locale={{ emptyText: '传入包没有样方记录' }}
            />
          </Card>

          <Card size="small">
            <Space wrap>
              <Button type="primary" size="large" disabled={!allResolved} onClick={confirmMerge}>
                确认合并
              </Button>
              <Button size="large" onClick={cancelPreview}>
                取消预演
              </Button>
              {!allResolved && preview.treeConflicts.length > 0 ? (
                <Typography.Text type="danger">
                  尚有 {preview.treeConflicts.length - resolvedCount} 处冲突未选定，确认前请先裁定
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">
                  确认后样木/样方落库，受影响的逐株比对标记「待重算」，并保留一次撤销机会
                </Typography.Text>
              )}
            </Space>
          </Card>
        </>
      ) : (
        <Card size="small">
          <Typography.Text type="secondary">
            尚未导入离线包。导入后此处展示冲突清单、单边新增与样方归并的可撤销预演。
          </Typography.Text>
        </Card>
      )}
    </Space>
  );
}
