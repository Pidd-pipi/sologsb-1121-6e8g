import { Table, Tag, Tooltip, Typography, type TableProps } from 'antd';
import { growthRate, isDiffAbnormal, type RecheckDiff } from '../../types/recheck';

export interface GrowthDiffTableProps {
  diffs: RecheckDiff[];
  emptyText?: string;
  /** 待重算行的生长量是否打码（确认合并后、重算前不显示旧值） */
  maskStale?: boolean;
}

type Columns = NonNullable<TableProps<RecheckDiff>['columns']>;

/** 两期逐株差值表，生长量为负或缺失时高亮；基准已变的待重算行不显示旧生长量 */
export default function GrowthDiffTable({ diffs, emptyText = '暂无复查比对结果', maskStale = true }: GrowthDiffTableProps) {
  const sorted = [...diffs].sort((a, b) =>
    a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }),
  );

  const growthText = (value: number) => (
    <Typography.Text type={value < 0 ? 'danger' : value > 0 ? 'success' : undefined}>
      {value > 0 ? `+${value}` : value}
    </Typography.Text>
  );

  const columns: Columns = [
    { title: '树号', dataIndex: 'treeNo', width: 80 },
    { title: '树种', dataIndex: 'species', width: 110 },
    {
      title: '状态',
      width: 100,
      render: (_: unknown, row: RecheckDiff) =>
        row.stale ? (
          <Tooltip title={row.staleReason ?? '基准数据已因离线合并变更'}>
            <Tag color="warning">待重算</Tag>
          </Tooltip>
        ) : null,
    },
    {
      title: '上期胸径 cm',
      dataIndex: 'baseDbhCm',
      width: 120,
      render: (value?: number) => (value === undefined ? <Tag color="red">缺测</Tag> : value),
    },
    {
      title: '本期胸径 cm',
      dataIndex: 'targetDbhCm',
      width: 120,
      render: (value?: number) => (value === undefined ? <Tag color="red">缺测</Tag> : value),
    },
    {
      title: '胸径生长量 cm',
      dataIndex: 'dbhGrowth',
      width: 140,
      render: (value: number, row: RecheckDiff) =>
        maskStale && row.stale ? <Typography.Text type="warning">— 待重算</Typography.Text> : growthText(value),
    },
    {
      title: '树高生长量 m',
      dataIndex: 'heightGrowth',
      width: 140,
      render: (value: number, row: RecheckDiff) =>
        maskStale && row.stale ? <Typography.Text type="warning">— 待重算</Typography.Text> : growthText(value),
    },
    {
      title: '保留木生长率',
      width: 130,
      render: (_: unknown, row: RecheckDiff) => {
        if (maskStale && row.stale) return <Typography.Text type="warning">—</Typography.Text>;
        const rate = growthRate(row);
        return rate === 0 ? '—' : `${rate} %`;
      },
    },
    {
      title: '状态变化',
      dataIndex: 'statusChange',
      width: 170,
      render: (value: string) => (value ? <Tag color="orange">{value}</Tag> : '—'),
    },
    {
      title: '缺失原因',
      dataIndex: 'missingReason',
      width: 160,
      render: (value: string) => (value ? <Tag color="red">{value}</Tag> : '—'),
    },
  ];

  return (
    <div data-testid="growth-diff-table">
      <Table<RecheckDiff>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={sorted}
        pagination={false}
        scroll={{ x: 1300 }}
        locale={{ emptyText }}
        rowClassName={(row) =>
          row.stale ? 'diff-row-stale' : isDiffAbnormal(row) ? 'diff-row-abnormal' : ''
        }
      />
    </div>
  );
}
