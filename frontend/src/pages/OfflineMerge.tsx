import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Popconfirm,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
  type TableProps,
  message,
} from 'antd';
import {
  CloudUploadOutlined,
  DownloadOutlined,
  ImportOutlined,
  MergeCellsOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import { useMergeStore } from '../stores/mergeStore';
import RoundTag from '../components/common/RoundTag';
import { loadRecheckDiffs } from '../utils/db';
import { buildExportBundle, buildMergePreview, parseOfflineBundle } from '../utils/mergeLogic';
import { applyMerge, previewStaleRechecks, undoMerge } from '../utils/offlineMerge';
import type { RecheckDiff } from '../types/recheck';
import type {
  ConflictResolution,
  MergePreview,
  OfflineBundle,
  RegenMergeRow,
  TreeConflict,
  TreeMergeAdd,
} from '../types/merge';

type ConflictColumns = NonNullable<TableProps<TreeConflict>['columns']>;
type AddColumns = NonNullable<TableProps<TreeMergeAdd>['columns']>;
type RegenColumns = NonNullable<TableProps<RegenMergeRow>['columns']>;

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN');
}

/** /plots/:id/merge 离线合并：导出本组离线包、导入他组离线包、预演、冲突选定、确认（可撤销一次） */
export default function OfflineMerge() {
  const { id = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === id));
  const trees = useTreeStore((s) => s.items);
  const regens = useRegenStore((s) => s.items);
  const loadCheckpoints = useMergeStore((s) => s.load);
  const checkpoint = useMergeStore((s) => s.items.find((c) => c.plotId === id));

  const [crewName, setCrewName] = useState(plot?.crew ?? '');
  const [bundle, setBundle] = useState<OfflineBundle | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [importError, setImportError] = useState('');
  const [resolutions, setResolutions] = useState<Record<string, ConflictResolution>>({});
  const [rechecks, setRechecks] = useState<RecheckDiff[]>([]);
  const [resultMsg, setResultMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const resetKeyRef = useRef(0);

  useEffect(() => {
    if (plot) setCrewName((prev) => prev || plot.crew);
  }, [plot?.id]);

  useEffect(() => {
    if (!id) return;
    void loadRecheckDiffs(id).then(setRechecks);
  }, [id, checkpoint?.id]);

  const localTrees = useMemo(() => trees.filter((t) => t.plotId === id), [trees, id]);
  const localRegens = useMemo(() => regens.filter((r) => r.plotId === id), [regens, id]);

  const resetImport = () => {
    setBundle(null);
    setPreview(null);
    setResolutions({});
    setFileName('');
    setImportError('');
    resetKeyRef.current += 1;
  };

  const handleFile = async (file: File) => {
    setImportError('');
    setResultMsg('');
    try {
      const parsed = parseOfflineBundle(await file.text());
      if (plot && parsed.plot.plotNo !== plot.plotNo) {
        throw new Error(
          `离线包属于样地「${parsed.plot.plotNo}」，与当前样地「${plot.plotNo}」不是同一块固定样地，不能合并`,
        );
      }
      const nextPreview = buildMergePreview(localTrees, localRegens, parsed);
      const defaults: Record<string, ConflictResolution> = {};
      nextPreview.treeConflicts.forEach((c) => {
        defaults[c.key] = 'local';
      });
      setBundle(parsed);
      setPreview(nextPreview);
      setResolutions(defaults);
      setFileName(file.name);
    } catch (err) {
      resetImport();
      setImportError(err instanceof Error ? err.message : '离线包读取失败');
    }
    return false;
  };

  const stalePreviewRows = useMemo(
    () => (preview ? previewStaleRechecks(rechecks, preview, resolutions) : []),
    [rechecks, preview, resolutions],
  );

  const incomingChoiceCount = useMemo(
    () => Object.values(resolutions).filter((v) => v === 'incoming').length,
    [resolutions],
  );

  const handleExport = () => {
    if (!plot) return;
    const data = buildExportBundle(
      { plotNo: plot.plotNo, locality: plot.locality, surveyRound: plot.surveyRound, crew: plot.crew },
      localTrees,
      localRegens,
      crewName,
    );
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(`离线包_${plot.plotNo}_${data.crew}_${stamp}.json`, data);
    message.success(`已导出本组离线包（${localTrees.length} 株样木、${localRegens.length} 条样方）`);
  };

  const handleConfirm = async () => {
    if (!plot || !preview || !bundle) return;
    setBusy(true);
    try {
      const sourceLabel = `${bundle.crew} · ${fmtDate(bundle.exportedAt)} 导出`;
      const r = await applyMerge({ plotId: plot.id, preview, resolutions, sourceLabel, bundle });
      await loadCheckpoints();
      setResultMsg(
        `合并完成：新增样木 ${r.treeInserted} 株、采用他组覆盖 ${r.treeUpdated} 株、新增样方 ${r.regenInserted} 组、株数累加 ${r.regenUpdated} 组，${r.recheckStale} 条旧逐株比对已标待重算。`,
      );
      resetImport();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '合并失败');
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    if (!plot) return;
    setBusy(true);
    try {
      const cp = await undoMerge(plot.id);
      await loadCheckpoints();
      setResultMsg(`已撤销「${cp.sourceLabel}」的合并：新增数据已移除、覆盖与待重算标记已还原。`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '撤销失败');
    } finally {
      setBusy(false);
    }
  };

  const setAll = (choice: ConflictResolution) => {
    if (!preview) return;
    const next: Record<string, ConflictResolution> = {};
    preview.treeConflicts.forEach((c) => {
      next[c.key] = choice;
    });
    setResolutions(next);
  };

  const conflictColumns: ConflictColumns = [
    {
      title: '期次',
      width: 80,
      render: (_, row) => `第 ${row.round} 期`,
    },
    { title: '树号', dataIndex: 'treeNo', width: 70 },
    {
      title: '分歧项',
      width: 150,
      render: (_, row) => (
        <Space size={4} wrap>
          {row.differingFields.map((f) => (
            <Tag key={f} color="red">
              {f === 'dbhCm' ? '胸径' : f === 'heightM' ? '树高' : '状态'}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '本机记录',
      width: 210,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>胸径 {row.local.dbhCm} cm</span>
          <span>树高 {row.local.heightM} m</span>
          <span>
            状态 <Tag color="orange">{row.local.status}</Tag>
          </span>
        </Space>
      ),
    },
    {
      title: '导入组记录',
      width: 210,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>胸径 {row.incoming.dbhCm} cm</span>
          <span>树高 {row.incoming.heightM} m</span>
          <span>
            状态 <Tag color="orange">{row.incoming.status}</Tag>
          </span>
        </Space>
      ),
    },
    {
      title: '选定',
      width: 230,
      fixed: 'right',
      render: (_, row) => (
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          size="small"
          value={resolutions[row.key] ?? 'local'}
          onChange={(e) => setResolutions((prev) => ({ ...prev, [row.key]: e.target.value as ConflictResolution }))}
          options={[
            { value: 'local', label: '保留本机' },
            { value: 'incoming', label: '采用导入组' },
          ]}
        />
      ),
    },
  ];

  const addColumns: AddColumns = [
    { title: '期次', width: 90, render: (_, r) => `第 ${r.tree.round} 期` },
    { title: '树号', dataIndex: ['tree', 'treeNo'], width: 80 },
    { title: '树种', dataIndex: ['tree', 'species'], width: 120 },
    { title: '胸径 cm', dataIndex: ['tree', 'dbhCm'], width: 100 },
    { title: '树高 m', dataIndex: ['tree', 'heightM'], width: 90 },
    { title: '状态', dataIndex: ['tree', 'status'], width: 100 },
    {
      title: '并入方式',
      width: 120,
      render: () => (
        <Tag color="green" icon={<MergeCellsOutlined />}>
          单边新增 · 直接并入
        </Tag>
      ),
    },
  ];

  const regenColumns: RegenColumns = [
    { title: '期次', width: 80, render: (_, r) => `第 ${r.round} 期` },
    {
      title: '层位',
      dataIndex: 'layer',
      width: 100,
      render: (v: string) => <Tag color={v === '更新苗' ? 'green' : v === '灌木' ? 'blue' : 'default'}>{v}</Tag>,
    },
    { title: '种类', dataIndex: 'species', width: 130 },
    { title: '高度 cm', dataIndex: 'heightCm', width: 100 },
    { title: '本机株数', dataIndex: ['local', 'count'], width: 100, render: (v?: number) => v ?? <Tag>无</Tag> },
    { title: '导入株数', dataIndex: 'incomingCount', width: 100 },
    {
      title: '归并后株数',
      dataIndex: 'mergedCount',
      width: 120,
      render: (v: number) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: '归并方式',
      width: 140,
      render: (_, r) =>
        r.action === 'insert' ? <Tag color="green">新增样方组</Tag> : <Tag color="blue">同键株数累加</Tag>,
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

  const nothingToMerge =
    preview &&
    preview.treeConflicts.length === 0 &&
    preview.treeAdds.length === 0 &&
    preview.regenRows.length === 0;

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          离线合并 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={plot.surveyRound} locked={plot.locked} />
        <Tag>样地面积 {plot.area} m²</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/regen`}>更新与灌木</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/recheck`}>复查比对</Link>
        </Button>
        <Button type="link">
          <Link to={`/summary/${plot.id}`}>林分汇总</Link>
        </Button>
      </Space>

      <Alert
        type="info"
        showIcon
        message="两组调查员同一块固定样地离线记录：导入他组整份数据时不会覆盖本组，而是按树号同期比对、样方按层位/种类/高度归并株数。"
        description="确认前可完整预演：单边新增直接并入；胸径、树高或状态不同的进入冲突清单由调查员逐株选定。确认合并后可撤销一次；撤销前，受影响的旧逐株比对标记为待重算，汇总页不再显示旧生长量。"
      />

      {checkpoint ? (
        <Alert
          type="warning"
          showIcon
          message={`存在最近一次合并：${checkpoint.sourceLabel}（${fmtDate(checkpoint.createdAt)}）`}
          description={
            <Space direction="vertical" size={4}>
              <span>
                新增样木 {checkpoint.treeInsertCount} 株、覆盖样木 {checkpoint.treeUpdateCount} 株、新增样方{' '}
                {checkpoint.regenInsertCount} 组、累加样方 {checkpoint.regenUpdateCount} 组、待重算比对{' '}
                {checkpoint.recheckStaleCount} 条。
              </span>
              <span>
                再次确认新的合并将覆盖本条撤销记录（只保留最近一次）。
                <Popconfirm
                  title="撤销最近一次合并？"
                  description="将删除新增数据、还原被覆盖记录并恢复旧比对的生长量。"
                  onConfirm={handleUndo}
                  okText="撤销合并"
                  cancelText="保留"
                  disabled={busy}
                >
                  <Button size="small" danger icon={<UndoOutlined />} style={{ marginLeft: 8 }} loading={busy}>
                    撤销此次合并
                  </Button>
                </Popconfirm>
              </span>
            </Space>
          }
        />
      ) : null}

      {resultMsg ? <Alert type="success" showIcon message={resultMsg} closable onClose={() => setResultMsg('')} /> : null}

      <Row gutter={12}>
        <Col span={10}>
          <Card size="small" title={<Space><DownloadOutlined />导出本组离线包</Space>}>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              <Typography.Text type="secondary">
                把本机该样地全部期次的 {localTrees.length} 株样木、{localRegens.length} 条样方打包，供另一台设备导入合并。
              </Typography.Text>
              <Space>
                本组署名
                <input
                  value={crewName}
                  onChange={(e) => setCrewName(e.target.value)}
                  placeholder="如 调查二组（周砚）"
                  style={{ width: 240, height: 32, borderRadius: 6, border: '1px solid #d9d9d9', padding: '0 11px' }}
                />
              </Space>
              <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport}>
                导出 .json 离线包
              </Button>
            </Space>
          </Card>
        </Col>
        <Col span={14}>
          <Card size="small" title={<Space><CloudUploadOutlined />导入他组离线包</Space>}>
            <Upload.Dragger
              key={resetKeyRef.current}
              accept=".json,application/json"
              maxCount={1}
              showUploadList={false}
              beforeUpload={handleFile}
            >
              <p className="ant-upload-drag-icon">
                <ImportOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽他组导出的 .json 离线包到此处</p>
              <p className="ant-upload-hint">导入后先预演，不会立即写入本机数据</p>
            </Upload.Dragger>
            {importError ? <Alert style={{ marginTop: 10 }} type="error" showIcon message={importError} /> : null}
            {bundle ? (
              <Alert
                style={{ marginTop: 10 }}
                type="success"
                showIcon
                message={`已载入 ${fileName}`}
                description={
                  <span>
                    来源：{bundle.crew} · {fmtDate(bundle.exportedAt)}；样地「{bundle.plot.plotNo}」
                    {bundle.plot.locality ? `（${bundle.plot.locality}）` : ''}；含 {preview?.incomingTreeCount} 株样木、
                    {preview?.incomingRegenCount} 条样方
                    {preview && preview.duplicateTreeKeys.length > 0 ? (
                      <Tag color="orange" style={{ marginLeft: 6 }}>
                        包内同树号同期重复 {preview.duplicateTreeKeys.length} 处，已按最后补录为准
                      </Tag>
                    ) : null}
                  </span>
                }
              />
            ) : null}
          </Card>
        </Col>
      </Row>

      {preview ? (
        nothingToMerge ? (
          <Alert type="success" showIcon message="导入包与本机记录完全一致，没有需要并入或裁决的内容。" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Row gutter={12}>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="冲突待选定" value={preview.treeConflicts.length} suffix="株" valueStyle={{ color: '#cf1322' }} />
                </Card>
              </Col>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="单边新增样木" value={preview.treeAdds.length} suffix="株" valueStyle={{ color: '#389e0d' }} />
                </Card>
              </Col>
              <Col span={4}>
                <Card size="small">
                  <Statistic title="样方归并组" value={preview.regenRows.length} suffix="组" />
                </Card>
              </Col>
              <Col span={5}>
                <Card size="small">
                  <Statistic
                    title="旧比对将标待重算"
                    value={stalePreviewRows.length}
                    suffix="条"
                    valueStyle={{ color: '#d48806' }}
                  />
                </Card>
              </Col>
              <Col span={7}>
                <Card size="small">
                  <Statistic title="当前已选采用导入组" value={incomingChoiceCount} suffix={`/ ${preview.treeConflicts.length} 株`} />
                </Card>
              </Col>
            </Row>

            {preview.treeConflicts.length > 0 ? (
              <Card
                size="small"
                title="冲突清单：同一树号同期，胸径 / 树高 / 状态存在分歧"
                extra={
                  <Space>
                    <Button size="small" onClick={() => setAll('local')}>
                      全部保留本机
                    </Button>
                    <Button size="small" onClick={() => setAll('incoming')}>
                      全部采用导入组
                    </Button>
                  </Space>
                }
              >
                <Table<TreeConflict>
                  rowKey="key"
                  size="small"
                  columns={conflictColumns}
                  dataSource={preview.treeConflicts}
                  pagination={false}
                  scroll={{ x: 1100 }}
                  expandable={{
                    expandedRowRender: (row) =>
                      row.otherDiffs.length > 0 ? (
                        <Space wrap>
                          <Typography.Text type="secondary">其他属性差异（随所选一方保留）：</Typography.Text>
                          {row.otherDiffs.map((d) => (
                            <Tag key={d}>{d}</Tag>
                          ))}
                        </Space>
                      ) : (
                        <Typography.Text type="secondary">其他属性一致</Typography.Text>
                      ),
                    rowExpandable: (row) => row.otherDiffs.length > 0,
                  }}
                />
              </Card>
            ) : null}

            {preview.treeAdds.length > 0 ? (
              <Card size="small" title={`单边新增样木（${preview.treeAdds.length} 株，直接并入）`}>
                <Table<TreeMergeAdd>
                  rowKey="key"
                  size="small"
                  columns={addColumns}
                  dataSource={preview.treeAdds}
                  pagination={false}
                />
              </Card>
            ) : null}

            {preview.regenRows.length > 0 ? (
              <Card size="small" title={`样方按层位 / 种类 / 高度归并株数（${preview.regenRows.length} 组）`}>
                <Table<RegenMergeRow>
                  rowKey="key"
                  size="small"
                  columns={regenColumns}
                  dataSource={preview.regenRows}
                  pagination={false}
                />
              </Card>
            ) : null}

            {preview.treeIdentical.length > 0 ? (
              <Collapse
                items={[
                  {
                    key: 'identical',
                    label: `同树号同期且关键字段一致（${preview.treeIdentical.length} 株，保留本机，不覆盖）`,
                    children: (
                      <Space wrap>
                        {preview.treeIdentical.map((r) => (
                          <Tag key={r.key}>
                            第 {r.incoming.round} 期 · {r.incoming.treeNo} 号 {r.incoming.species}
                          </Tag>
                        ))}
                      </Space>
                    ),
                  },
                ]}
              />
            ) : null}

            <Alert
              type="warning"
              showIcon
              message="确认后，上述样木/样方将写入本机；凡基准或本期样木发生变化的旧逐株比对会标为待重算，林分汇总页在重算前不再显示旧生长量。"
            />

            <Space>
              <Popconfirm
                title="确认按当前预演合并？"
                description="合并完成后可在本页撤销一次；再合并将覆盖撤销记录。"
                onConfirm={handleConfirm}
                okText="确认合并"
                cancelText="再检查一下"
                disabled={busy}
              >
                <Button type="primary" size="large" icon={<MergeCellsOutlined />} loading={busy}>
                  确认合并
                </Button>
              </Popconfirm>
              <Button size="large" onClick={resetImport} disabled={busy}>
                放弃预演
              </Button>
            </Space>
          </Space>
        )
      ) : null}
    </Space>
  );
}
