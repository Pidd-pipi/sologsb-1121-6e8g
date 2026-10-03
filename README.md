# sologsb-1121 森林样地调查记录台（gbforestplot）

面向森林资源调查员的固定样地工作台：为样地建档，逐株记录胸径、树高、枝下高与检尺位置，登记更新幼苗与灌木层，并在复查期与上一期数据逐株比对生长量、计算林分因子。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21821**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1121/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── router/index.tsx
        ├── types/{plot,tree,regen,recheck,merge}.ts
        ├── stores/{plot,tree,regen,merge}Store.ts
        ├── components/common/{PlotCard,TreeTable,GrowthDiffTable,RoundTag}.tsx
        ├── hooks/{usePlotFilter,useTreeStats}.ts
        ├── pages/{PlotList,TreeEntry,RegenView,RecheckView,PlotSummary,OfflineMerge}.tsx
        └── utils/{db,forestCalc,id,mergeLogic,offlineMerge}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plots` | 样地台账：按地点/林型/复查期次/郁闭度区间筛选，显示面积、优势树种、已录样木数，可锁定往期 | Plot |
| `/plots/:id/trees` | 样木录入与清单：径阶分组快速录入、行内改胸径、树种联想、胸径异常提示 | TreeRecord |
| `/plots/:id/regen` | 更新苗与灌木样方记录，按高度级与株数分组合计 | RegenShrub |
| `/plots/:id/recheck` | 复查比对：逐株两期胸径/树高与生长量，标记缺失与状态变化，保存比对结果 | RecheckDiff、TreeRecord |
| `/plots/:id/merge` | 离线合并：导出/导入离线包、冲突预演与逐株选定、样方株数归并、确认后可撤销一次 | TreeRecord、RegenShrub、MergeCheckpoint |
| `/summary/:plotId` | 林分因子汇总：每公顷株数、平均胸径、断面积、郁闭度、更新密度，可导出调查记录文本 | Plot、TreeRecord、RegenShrub |

`/` 重定向到 `/plots`，未匹配路由同样兜底到 `/plots`。

## 数据存储说明

- 数据库名 `gbforestplot`，当前结构版本 **v3**（`localStorage['gbforestplot:db-version']` 记录）。
- 五张表：`plots`（样地）、`trees`（样木，按期次分行）、`regens`（更新苗与灌木样方）、`rechecks`（复查逐株比对，含待重算标记）、`mergeCheckpoints`（离线合并撤销快照，每样地仅留最近一条）。
- v1 → v2 迁移：为老样地补 `locked`、`surveyRound`，为老样木补 `round`、`measuredAt`，并新增索引。
- v2 → v3 迁移：`rechecks` 增加 `stale` 索引，新增 `mergeCheckpoints` 表。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范样地、11 条样木（含第 1/2 两期，便于直接做复查比对）与 4 条样方记录。

## 功能要点

- **径阶归组**：按「6/8/12/16/20/24/28/32+」cm 径阶自动归组，表格内联展示各径阶株数。
- **胸径异常提示**：数值超出 0~200 cm 或与本树种同期均值偏离 >60% 时标黄并给出提示。
- **复查比对**：任选上下两期生成逐株差值表，标记「本期未复测（疑似采伐或倒伏）」与「本期新增进界木」，生长率为负或缺失行高亮，并计算保留木生长率。
- **离线合并（两组同地离线记录）**：本组导出 `.json` 离线包、他组导入后先预演不写库；同一树号同期、胸径/树高/状态任一不同进入冲突清单由调查员逐株选定（默认保留本机，可一键全选），单边新增直接并入；样方按「层位 + 种类 + 高度 + 期次」归并株数（同键累加、异键新增）。确认在单事务内落库，旧逐株比对凡基准/本期样木已变的标为「待重算」，确认前及重算前汇总页与比对页不显示旧生长量；每样地保留最近一次合并快照，可撤销一次（再合并覆盖旧快照）。
- **林分因子**：每公顷株数、平均胸径/树高、断面积与每公顷断面积、冠幅折算郁闭度、更新苗/灌木密度。
- **导出**：复查比对结果写入本地档案库；林分汇总可复制或导出调查记录 txt。
