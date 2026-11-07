# 文案修正 + MCP JSON 示例：改动前后证据（2026-11-07）

同一场景、同一视口、同一主题，只切基准与改动后的站点：

| 项 | 值 |
|---|---|
| Before | `main` @ `e1f4255` |
| After | 本 PR 分支（same working tree, `site/index.html` / `site/assets/app.js` / `site/assets/style.css` / `site/market.html`） |
| 视口 | 1440 px 宽（整页图缩到 1000 px 宽便于查看） |
| 主题 | light（`?theme=light`） |
| 数据 | 本地同源 `GET /catalog` 反代到同一份运行中的服务（10 源 / 41 工具），前后一致 |

| 文件 | 内容 |
|---|---|
| `before-full.jpg` / `after-full.jpg` | 整页：首屏、能力卡、源市场摘要、接入段、边界 |
| `before-install.jpg` / `after-install.jpg` | `#install` 接入段：两档说明、版本口径、子集用法、新增的 JSON 请求/响应 |
| `before-market.jpg` / `after-market.jpg` | `market.html`：订阅语义说明 |

截图用无头 Chromium 的 CDP 以 1440px 布局视口整页截取；文本改动清单与检查命令见 PR 描述。
