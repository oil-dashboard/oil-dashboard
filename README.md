# 🛢️ Oil Dashboard — 油市情报看板

实时油市情报看板，模仿 [skill.capduck.com](https://skill.capduck.com/iran) 的滚动式信息面板。

## 功能

- 📈 **Brent / WTI 实时价格** — 自动刷新，涨跌标色
- 🇮🇷 **伊朗局势实时情报** — Tension 指标 + 事件时间线 + 信源验证
- 📊 **Polymarket 预测市场** — 概率 + 趋势
- 👤 **信源看板** — 白名单分组展示，点击直达 X 主页

## 数据来源

| 数据 | 来源 | 更新频率 |
|------|------|---------|
| 油价 | Yahoo Finance (公开 API) | 每 5 分钟 |
| 伊朗情报 | [skill.capduck.com](https://skill.capduck.com/iran) (公开 API) | 每 5 分钟 |
| Polymarket | [skill.capduck.com/iran/polymarket](https://skill.capduck.com/iran/polymarket) | 每 5 分钟 |

所有数据均来自公开 API，前端直接调用，无需后端。

## 白名单管理

编辑 `sources.json` 即可增删信源，前端自动读取。

```json
{
  "analysts": {
    "title": "📊 Independent Analysts",
    "accounts": [
      { "handle": "@JavierBlas", "org": "Bloomberg", "desc": "能源专栏" }
    ]
  }
}
```

## 部署

项目通过 GitHub Pages 自动部署，访问：

**https://oil-dashboard.github.io/oil-dashboard/**

## 本地开发

```bash
cd oil-dashboard
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

## License

MIT
