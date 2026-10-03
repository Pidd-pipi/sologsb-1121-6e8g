import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useRegenStore } from '../stores/regenStore';
import { useTreeStore } from '../stores/treeStore';
import { useMergeStore } from '../stores/mergeStore';
import { useTreeStats } from '../hooks/useTreeStats';
import RoundTag from '../components/common/RoundTag';
import PlotCard from '../components/common/PlotCard';
import { loadRecheckDiffs } from '../utils/db';
import { canopyFromCrown, formHeight, heightClassStats } from '../utils/forestCalc';
import { growthRate, type RecheckDiff } from '../types/recheck';
import type { TreeRecord } from '../types/tree';

type Columns = NonNullable<TableProps<TreeRecord>['columns']>;

interface SpeciesRow {
  key: string;
  species: string;
  count: number;
  meanDbh: number;
  meanHeight: number;
}

/** /summary/:plotId 林分因子汇总，可导出调查记录文本 */
export default function PlotSummary() {
  const { plotId = '' } = useParams();
  const plot = usePlotStore((s) => s.items.find((p) => p.id === plotId));
  const trees = useTreeStore((s) => s.items);
  const regens = useRegenStore((s) => s.items);
  const mergePending = useMergeStore((s) => (plotId ? s.pending[plotId] !== undefined : false));
  const stats = useTreeStats(plotId);

  const [diffs, setDiffs] = useState<RecheckDiff[]>([]);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!plotId) return;
    void loadRecheckDiffs(plotId).then(setDiffs);
  }, [plotId, trees, regens]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const plotRegens = useMemo(
    () => regens.filter((r) => r.plotId === plotId && r.round === (plot?.surveyRound ?? 1)),
    [regens, plotId, plot?.surveyRound],
  );

  /**
   * 最近一期逐株比对的生长量汇总。
   * 合并预演确认前一律不展示旧生长量；确认后基准变化的比对已被置为待重算，同样不展示。
   */
  const growth = useMemo(() => {
    if (mergePending || diffs.length === 0) return undefined;
    const targetRound = Math.max(...diffs.map((d) => d.targetRound));
    const valid = diffs.filter((d) => d.targetRound === targetRound && !d.stale);
    if (valid.length === 0) return undefined;
    const withBase = valid.filter((d) => d.baseDbhCm);
    const avgDbhGrowth =
      withBase.length === 0
        ? 0
        : Math.round((withBase.reduce((s, d) => s + d.dbhGrowth, 0) / withBase.length) * 100) / 100;
    const avgHeightGrowth =
      withBase.length === 0
        ? 0
        : Math.round((withBase.reduce((s, d) => s + d.heightGrowth, 0) / withBase.length) * 100) / 100;
    const avgRate =
      withBase.length === 0
        ? 0
        : Math.round((withBase.reduce((s, d) => s + growthRate(d), 0) / withBase.length) * 100) / 100;
    return { baseRound: withBase[0]?.baseRound, targetRound, count: withBase.length, avgDbhGrowth, avgHeightGrowth, avgRate };
  }, [diffs, mergePending]);

  const staleGrowthCount = useMemo(() => diffs.filter((d) => d.stale).length, [diffs]);

  const speciesRows = useMemo(() => {
    const map = new Map<string, { species: string; count: number; dbh: number; height: number }>();
    stats.trees
      .filter((t) => t.status === '活立木')
      .forEach((t) => {
        const row = map.get(t.species) ?? { species: t.species, count: 0, dbh: 0, height: 0 };
        row.count += 1;
        row.dbh += t.dbhCm;
        row.height += t.heightM;
        map.set(t.species, row);
      });
    return Array.from(map.values()).map((r) => ({
      key: r.species,
      species: r.species,
      count: r.count,
      meanDbh: Math.round((r.dbh / r.count) * 100) / 100,
      meanHeight: Math.round((r.height / r.count) * 100) / 100,
    }));
  }, [stats.trees]);

  const speciesColumns: NonNullable<TableProps<SpeciesRow>['columns']> = [
    { title: '树种', dataIndex: 'species' },
    { title: '株数', dataIndex: 'count', width: 100 },
    { title: '平均胸径 cm', dataIndex: 'meanDbh', width: 140 },
    { title: '平均树高 m', dataIndex: 'meanHeight', width: 140 },
    {
      title: '形高',
      width: 120,
      render: (_: unknown, row: SpeciesRow) =>
        formHeight({ dbhCm: row.meanDbh, heightM: row.meanHeight } as TreeRecord),
    },
  ];

  const report = useMemo(() => {
    if (!plot) return '';
    const lines: string[] = [];
    lines.push('森林样地调查记录');
    lines.push(`样地号：${plot.plotNo}`);
    lines.push(`地点：${plot.locality}（${plot.lng}, ${plot.lat}）`);
    lines.push(`形状/面积：${plot.shape} / ${plot.area} m²`);
    lines.push(`海拔：${plot.elevation} m；坡度 ${plot.slope}°；坡向 ${plot.aspect}`);
    lines.push(`林型：${plot.forestType}；优势树种：${plot.dominantSpecies}`);
    lines.push(`复查期次：第 ${plot.surveyRound} 期；调查时间：${new Date(plot.surveyedAt).toLocaleDateString('zh-CN')}`);
    lines.push(`调查组：${plot.crew}`);
    lines.push('');
    lines.push(`每公顷株数：${stats.perHa} 株/hm²`);
    lines.push(`平均胸径：${stats.meanDbh} cm`);
    lines.push(`平均树高：${stats.meanHeight} m`);
    lines.push(`断面积合计：${stats.basalArea} m²（${stats.basalAreaPerHa} m²/hm²）`);
    lines.push(`郁闭度（录入）：${plot.canopyDensity}；按冠幅折算：${canopyFromCrown(stats.trees, plot)}`);
    lines.push(`更新苗密度：${stats.regenPerHa} 株/hm²；灌木密度：${stats.shrubPerHa} 株/hm²`);
    lines.push('');
    if (mergePending) {
      lines.push('生长量：存在尚未确认的离线合并预演，确认前不展示旧生长量；请完成合并后重新生成逐株比对。');
    } else if (growth) {
      lines.push(
        `生长量（第 ${growth.baseRound} 期 → 第 ${growth.targetRound} 期，保留木 ${growth.count} 株）：` +
          `平均胸径生长 ${growth.avgDbhGrowth} cm，平均树高生长 ${growth.avgHeightGrowth} m，平均生长率 ${growth.avgRate}%`,
      );
    }
    lines.push('');
    lines.push('径阶分布：' + stats.diameterDist.map((d) => `${d.label}cm=${d.count}`).join('，'));
    lines.push('高度级株数：' + heightClassStats(plotRegens).map((h) => `${h.label}=${h.count}`).join('，'));
    lines.push('');
    lines.push('分树种统计：');
    speciesRows.forEach((r) => {
      lines.push(`  ${r.species}：${r.count} 株，平均胸径 ${r.meanDbh} cm，平均树高 ${r.meanHeight} m`);
    });
    lines.push('');
    lines.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
    return lines.join('\n');
  }, [plot, stats, plotRegens, speciesRows, growth, mergePending]);

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
          林分因子汇总 · {plot.plotNo}
        </Typography.Title>
        <RoundTag round={plot.surveyRound} locked={plot.locked} />
        <Tag color="green">{plot.forestType}</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/plots/${plot.id}/trees`}>样木录入</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/regen`}>更新与灌木</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/merge`}>离线合并</Link>
        </Button>
        <Button type="link">
          <Link to={`/plots/${plot.id}/recheck`}>复查比对</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {mergePending ? (
        <Alert
          type="info"
          showIcon
          message="该样地存在尚未确认的离线合并预演：林分因子按当前已录数据实时计算，但旧生长量已暂缓展示，确认合并后请重新生成逐株比对。"
          action={
            <Button size="small" type="primary">
              <Link to={`/plots/${plot.id}/merge`}>回到合并预演</Link>
            </Button>
          }
        />
      ) : staleGrowthCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${staleGrowthCount} 条逐株比对因离线合并改变了基准样木而标记为「待重算」，其旧生长量不再计入本页汇总。`}
          action={
            <Button size="small" type="primary">
              <Link to={`/plots/${plot.id}/recheck`}>前往重算比对</Link>
            </Button>
          }
        />
      ) : null}

      <Row gutter={12}>
        <Col span={8}>
          <PlotCard plot={plot} treeCount={stats.count} />
        </Col>
        <Col span={16}>
          <Row gutter={[12, 12]}>
            <Col span={8}>
              <Card size="small">
                <Statistic title="每公顷株数" value={stats.perHa} suffix="株/hm²" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="平均胸径" value={stats.meanDbh} precision={2} suffix="cm" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="平均树高" value={stats.meanHeight} precision={2} suffix="m" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="断面积合计" value={stats.basalArea} precision={4} suffix="m²" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="每公顷断面积" value={stats.basalAreaPerHa} precision={3} suffix="m²/hm²" />
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Statistic title="郁闭度（冠幅折算）" value={canopyFromCrown(stats.trees, plot)} precision={3} />
              </Card>
            </Col>
            <Col span={12}>
              <Card size="small">
                <Statistic title="更新苗密度" value={stats.regenPerHa} suffix="株/hm²" />
              </Card>
            </Col>
            <Col span={12}>
              <Card size="small">
                <Statistic title="灌木密度" value={stats.shrubPerHa} suffix="株/hm²" />
              </Card>
            </Col>
          </Row>
        </Col>
      </Row>

      <Card size="small" title="最近一期生长量（逐株比对）">
        {mergePending ? (
          <Alert
            type="info"
            showIcon
            message="合并预演尚未确认，旧生长量暂缓显示"
            description="请到「离线合并」页裁定冲突并确认（或取消预演）；确认后基准变化的比对会标记待重算。"
          />
        ) : growth ? (
          <Row gutter={12}>
            <Col span={6}>
              <Statistic title="保留木株数" value={growth.count} suffix="株" />
            </Col>
            <Col span={6}>
              <Statistic title="平均胸径生长量" value={growth.avgDbhGrowth} precision={2} suffix="cm" />
            </Col>
            <Col span={6}>
              <Statistic title="平均树高生长量" value={growth.avgHeightGrowth} precision={2} suffix="m" />
            </Col>
            <Col span={6}>
              <Statistic title="平均保留木生长率" value={growth.avgRate} precision={2} suffix="%" />
            </Col>
          </Row>
        ) : (
          <Alert
            type="warning"
            showIcon
            message={
              staleGrowthCount > 0
                ? '保存的比对基准已变、标记为待重算，本页不显示旧生长量'
                : '尚无有效的逐株比对结果'
            }
            description={
              staleGrowthCount > 0 ? (
                <Link to={`/plots/${plot.id}/recheck`}>前往复查比对页按当前样木重新生成</Link>
              ) : (
                <Link to={`/plots/${plot.id}/recheck`}>前往复查比对页生成并保存</Link>
              )
            }
          />
        )}
      </Card>

      <Card size="small" title="径阶分布与高度级">
        <Space direction="vertical" size={6}>
          <div>
            {stats.diameterDist.map((d) => (
              <Tag key={d.label} color={d.count > 0 ? 'green' : 'default'}>
                {d.label} cm · {d.count} 株
              </Tag>
            ))}
          </div>
          <div>
            {heightClassStats(plotRegens).map((h) => (
              <Tag key={h.label} color={h.count > 0 ? 'cyan' : 'default'}>
                {h.label} · {h.count} 株
              </Tag>
            ))}
          </div>
          <Descriptions size="small" column={3}>
            <Descriptions.Item label="活立木">{stats.aliveCount} 株</Descriptions.Item>
            <Descriptions.Item label="样木记录">{stats.count} 条</Descriptions.Item>
            <Descriptions.Item label="样方记录">{plotRegens.length} 条</Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>

      <Card size="small" title="分树种统计">
        <Table<SpeciesRow>
          rowKey="key"
          size="small"
          columns={speciesColumns}
          dataSource={speciesRows}
          pagination={false}
          locale={{ emptyText: '暂无活立木数据' }}
        />
      </Card>

      <Card
        size="small"
        title="调查记录文本"
        extra={
          <Space>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(report);
                  setToast('调查记录已复制到剪贴板');
                } catch {
                  setToast('浏览器未授权剪贴板，请手动复制下方文本');
                }
              }}
            >
              复制
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<DownloadOutlined />}
              onClick={() => {
                const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `调查记录_${plot.plotNo}.txt`;
                a.click();
                URL.revokeObjectURL(url);
                setToast('调查记录已导出为 txt');
              }}
            >
              导出
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{report}</pre>
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}
