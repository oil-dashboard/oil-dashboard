# Oil Dashboard

可核对来源、合约、基准和观测时间的原油行情与新闻看板。静态页面通过 GitHub Pages 发布，Cloudflare Worker 负责行情与官方 RSS 数据归一。Node.js 22.12 或以上。

正式地址：https://oil-dashboard.github.io/oil-dashboard/

## 本地开发与验证

```sh
npm ci
npm test
npm run check:worker
npm run build
```

分别启动数据层和页面：

```sh
npx wrangler dev --port 8787 --ip 127.0.0.1
npm run preview -- --port 8082 --worker-url http://127.0.0.1:8787
```

访问 http://127.0.0.1:8082/ 。本地页面自动通过同源 `/api/` 代理使用指定 Worker。线上默认使用 `https://oil-proxy.xzregproxy.workers.dev`；需要显式替换时，在加载脚本前设置 `globalThis.OIL_API_BASE`。

测试使用固定时钟和脱敏 fixture，不依赖外网价格。真实上游验收应同时执行 Wrangler 的实际运行时和浏览器流程；仅在 Node 中成功不足以证明 workerd 兼容。

## 行情口径

- 主源为 Yahoo Finance 的 `BZ=F` 和 `CL=F`，在页面明确标记 NYMEX 连续工具。当前活跃月份由来源决定，不再用自然月份加二推算。
- 涨跌额和涨跌幅统一以同一来源、同一精确 symbol 的最近一根已完成日线收盘价为基准；该日线的交易所本地日期必须早于报价所属的交易日。周末、假日或缺少当日已完成日线时，取可用的最近前一根日线。
- 行情接口保留 `reference.type=previous-close` 以兼容当前前端，并用 `reference.basis=daily-close` 标记实际口径；新前端只接受带该标记的基准，旧版 quote 前收缓存不能覆盖新值。
- NYMEX 连续工具按纽约 18:00 时段边界计算交易日；新加坡时区只用于显示。因此同一交易日的新加坡上午和下午使用相同的前一日日线收盘价，不会在 SGT 午夜或中午重置。基准标签显示“较 YYYY-MM-DD 日线收盘”。
- 日线基准缺失、日期不合法或 symbol 不匹配时，不计算涨跌额/涨跌幅，并显示“日线前收暂不可用”；不退回 quote `previousClose`、`chartPreviousClose` 或其他来源的价格，也不显示“待确认”。连续合约换月时，来源 quote 的 `previousClose` 可能与同 symbol 的前一日日线收盘不同；仅作来源差异背景，不作为比较基准。
- 日线收盘价是本看板的比较基准，不宣称为交易所官方结算价。
- 交易日与 SGT 显示时区分开。NYMEX 能源按纽约时段、ICE Brent 按伦敦时段。夏令时由 IANA 时区处理；没有官方完整假日日历时市场状态保留 unknown。
- 1D 历史按完整期货交易时段筛选，包含新加坡早盘。5D、1M 沿用来源连续历史；连续合约换月可能产生跳空。
- 主源失败时 TradingView scanner 只返回精确的 `ICEEUR:BRN1!`、`NYMEX:CL1!` 独立快照。涨跌比较仍须使用该 symbol 自己的已完成日线；没有日线时只显示报价，不显示涨跌。
- TradingView 的 `last_bar_update_time` 只作为 `providerUpdatedAt`，不是精确成交时刻。延迟 600 秒明确标记为 10 分钟延迟，`priceAt` 保持 null，不生成假同步价差。
- 价差要求同源、同币种、实际行情时刻可比；价差历史按两条序列的精确时间戳连接。

## API

| 路径 | 内容 |
|---|---|
| `/api/market?range=1d\|5d\|1mo` | 完整原子报价、同工具历史、前收基准、时间、状态和同步价差 |
| `/api/curve?instrument=brent\|wti` | 三个真实具体合约、月份、到期日与通过时间核对的月差 |
| `/api/calendar` | 官方 EIA 规则及假日例外、已核验 API 刊期、IEA/OPEC 月报日期 |
| `/api/news?topic=market\|geo` | Oilprice 与 Guardian 官方 RSS；原始来源和发布时间 |
| `/api/health` | 协议版本、发布版本、Worker 源码 digest 与能力列表 |

历史 `?url=`、`?twitter=`、`?tvsymbol=` 入口保留兼容。代理只允许明确批准的 HTTPS host，拒绝 credentials、自定义端口和重定向。请求采用 workerd 支持的 `redirect: 'manual'` 并拒绝非成功状态。

## 期限结构与日历

曲线使用同源 TradingView 具体合约和实际 `expiration`。表格的 M1/M2/M3 指最近尚未到期月份，不等同于已经提前换月的连续工具。月差只在报价延迟、来源、币种和源更新时间兼容时出现。

EIA 日历从官方发布日程读取并保留核验时间；断源时使用已核验规则存档。API 年度日程、IEA 和 OPEC 月报日期均附官方来源。未公布精确时间的月报显示日期和“时刻待确认”。前值、预期和实际没有可靠数据时显示 `—`，不能根据计划时点假定数据已发布。静态存档有覆盖范围，越界不编造下一刊期。

## 新闻与缓存

新闻按可核对的相同标题/规范 URL 合并并保留不同来源，避免模糊聚类误把方向相反的报道合成一条。原始新闻发布时间和抓取时间分开。Google RSS 在旧出口返回自动查询拒绝时，不绕过限制；新的默认来源是公开官方 RSS。

Worker 行情短缓存为 45 秒、曲线为 180 秒；断源只在有界期限使用旧快照，并保留原始观测时间。前端保存完整最终快照，读取前验证 symbol、source、基准、数值、时间和范围。旧 HTTP 抓取时间不能把旧价标为实时。

Service Worker 导航网络优先，只缓存精确指纹匹配的静态资产；API、JSON 和跨域动态数据绕过缓存。JavaScript 加载失败不返回 HTML。缓存容量不足不能遮蔽已经成功的网络响应。

## 构建与发布

构建只输出公开文件，拒绝公开目录中的符号链接，排除 `.git`、环境文件、Worker 源码、工作记录和测试。每份 `build-info.json` 包含 Git SHA、构建时间、静态资产摘要、Worker 源码摘要和推文文件状态。

首次或本地 OAuth 过期时，由账号本人完成登录：

```sh
npx wrangler login
npx wrangler whoami
```

先发布与当前页面匹配的 Worker，再发布静态页面：

```sh
npm run deploy:worker
npm run verify:worker
```

部署包装器自动写入 `BUILD_SHA` 和 `WORKER_DIGEST`，不在日志打印凭据。GitHub 的 Worker 自动发布需要仓库 secrets `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。缺失时只验证 bundle，不假装已部署。

Pages 工作流先运行测试、实际 Worker bundle 检查和公共构建，确认制品可见；部署前验证当前 Worker 协议、能力和源码摘要，失败则保留旧站。部署后逐文件核对 SHA256 与 MIME，不能仅靠 HTTP 200 宣布成功。后台仅更新 OOTT 数据时，Worker digest 不变，不要求两边 Git 提交相同。

```sh
npm run verify:deployment -- --base-url https://oil-dashboard.github.io/oil-dashboard/ --expected-sha COMMIT_SHA
```

回退也遵循相同顺序：检出已验证的旧版本，先发布匹配 Worker，再发布其静态制品并重新校验。保留旧提交和构建记录，避免只回退一侧。

## 图表许可

Lightweight Charts 固定为 5.3.0，构建从锁定 npm 依赖生成本地 vendor 文件，保留 Apache-2.0 LICENSE、NOTICE 和可见 TradingView 署名。库只提供渲染，不提供市场数据。
