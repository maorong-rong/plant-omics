# 部署（服务端常驻）

> **状态：物料齐、未在真实服务器验证。** 本目录的 systemd 单元、Nginx 配置、引导脚本都是按仓内
> 代码的实际行为写的（环境变量、`/healthz`、`/mcp` 路径、无状态特性），但**没有在目标服务器上跑过**。
> 上线前按「五、验证清单」逐条实测，并把结果记进 `记录/`；未实测不得对外宣称"已部署可用"。

## 一、形态

```
客户端（Claude Code / Codex / DSH 等）
        │  HTTPS + Bearer token
        ▼
      Nginx（443，终止 TLS）
        │  http://127.0.0.1:8787
        ▼
  plantomics-hub.service（Node，Streamable HTTP，/mcp + /healthz）
```

- **无状态**：每条请求独立 `server + transport`，可水平扩容，**不需要会话亲和**。
- **默认只听回环**；对外由 Nginx 反代。直连裸机（容器）才绑 `0.0.0.0`，那时**必须**配 token。
- 服务端有 **Host 白名单**：对外域名不写进 `PLANTOMICS_HUB_ALLOWED_HOSTS` 会 403。

## 二、环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PLANTOMICS_HUB_HOST` | `127.0.0.1` | 监听地址。回环以外**必须**配 token，否则启动即报错 |
| `PLANTOMICS_HUB_PORT` | `8787`（或平台注入的 `PORT`） | 端口 |
| `PLANTOMICS_HUB_TOKEN` | 无 | 静态 Bearer token，**≥16 字符**；短 token 会被拒绝 |
| `PLANTOMICS_HUB_SERVER_NAME` | `plantomics-hub` | 自报名字（字母/数字/下划线/连字符，1–32） |
| `PLANTOMICS_HUB_LOG` | `info` | `quiet` 只打错误 |
| `PLANTOMICS_HUB_ALLOWED_HOSTS` | 无 | 允许的 Host 头，逗号分隔，只写主机名 |
| `PLANTOMICS_SOURCES` | 全部 | 只启用部分源（逗号/分号/空白分隔），与 MCP 出口同一语义 |

模板见 `deploy/plantomics-hub.env.example`，落地路径 `/etc/plantomics-hub.env`（`chmod 600`，root 所有）。

## 三、安装服务

前置：Ubuntu 22.04+/Debian 12+（或同族），Node **≥ 20**（推荐 22），`git`/`rsync`/`curl`，root 权限。

```bash
# 1) 取源码（示例：公开仓）
git clone https://github.com/maorong-rong/plant-omics.git /srv/plant-omics
cd /srv/plant-omics

# 2) 一把梭：建用户 → 同步到 /opt/plantomics-hub → npm ci + build → 装单元 → 生成 env → 启动 → 自检
sudo bash deploy/bootstrap.sh /srv/plant-omics --host example.org
```

脚本**幂等**：已有 `/etc/plantomics-hub.env` 不会覆盖；目录不删；重复执行安全。
它**不**自动签证书、不改防火墙。

手工安装（不想用脚本时）：

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin plantomics
sudo mkdir -p /opt/plantomics-hub && sudo chown plantomics: /opt/plantomics-hub
sudo -u plantomics npm ci --no-audit --no-fund && sudo -u plantomics npm run build
sudo install -m 0644 deploy/plantomics-hub.service /etc/systemd/system/
sudo install -m 0600 -o root -g root deploy/plantomics-hub.env.example /etc/plantomics-hub.env   # 再改里面的值
sudo systemctl daemon-reload && sudo systemctl enable --now plantomics-hub
```

## 四、Nginx 与证书

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/plantomics-hub.conf
sudo sed -i 's/example.org/你的域名/g' /etc/nginx/sites-available/plantomics-hub.conf
sudo ln -sf /etc/nginx/sites-available/plantomics-hub.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名            # 证书路径与 nginx.conf 里的两行保持一致
```

为什么要这些设置（写在 `deploy/nginx.conf` 注释里，同样重要）：

- **`proxy_buffering off`**：MCP 长连接/流式回包被代理攒住时会看起来"卡死"；
- **`proxy_read_timeout 3600s`**：单次工具调用含重试最长约 45 s，空闲长连接也要给足；
- **`Host` 原样透传**：服务端白名单靠它判断，改写成别的值会 403；
- 8787 **不要对外**放行，只开 80/443。

## 五、验证清单（未跑过就不算部署成功）

```bash
# 1) 进程与端口
systemctl is-active plantomics-hub
ss -lntp | grep 8787

# 2) 健康检查（服务自身；返回 status/version/package/sources/tools 等，不含工具清单）
curl -fsS http://127.0.0.1:8787/healthz

# 3) 经 Nginx + TLS 的健康检查
curl -fsS https://你的域名/healthz

# 4) MCP 握手（带 token；不带 token 应 401）
curl -sS -X POST https://你的域名/mcp \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 5) 工具清单数量应与 stats 一致（当前 8 源 37 工具；子集头只影响本次请求）
```

服务器侧观察：`journalctl -u plantomics-hub -f`。

## 六、升级与回滚

- **升级**：拉新代码 → `sudo -u plantomics npm ci && sudo -u plantomics npm run build` →
  `sudo systemctl restart plantomics-hub` → 重跑「五、验证清单」。**不要**在旧 `dist` 上直接 restart
  （构建未做等于没升级）。
- **回滚**：`git checkout <上一个提交>` → 重新 `npm ci && npm run build` → `restart`。
  服务无状态，回滚不需要迁移数据；客户端只需重连。
- 服务端版本形如 `0.1.0+svc.N.g<sha>`，`/healthz` 会报出来——**用它确认"升的是哪一版"**，
  不要凭 git 分支猜。

## 七、安全边界

- token 只放 `/etc/plantomics-hub.env`（600）与客户端配置，**不进仓库、不进日志**；
- 服务端错误文本不带上游原文（2026-10-30 起），但**工具输出里的上游文本仍按数据处理**，不执行；
- 该服务只做"把别人的公开数据问出来"，**不做鉴权隔离**：按连接选源（`x-plantomics-sources`）
  是上下文预算手段，**不是权限控制**；需要多租户隔离请在上层反向代理做。
- 本目录不含任何凭据；`deploy/plantomics-hub.env.example` 里的 token 是占位符。

## 八、容器（可选）

仓根有 `Dockerfile`（多阶段构建，运行时只装 production 依赖）。容器内必须
`PLANTOMICS_HUB_HOST=0.0.0.0` 且配 token；`HEALTHCHECK` 可打 `/healthz`。
镜像构建与运行**在本机未验证**（本机无 Docker），状态与本节开头一致。

## 九、未验证项（如实列出）

1. 三条物料均未在目标服务器执行过（本机 Windows，无 systemd/Nginx）；
2. `deploy/bootstrap.sh` 未做 `shellcheck`；
3. Nginx 配置未 `nginx -t`；
4. 证书签发流程（certbot）未实跑；
5. 高并发下的连接数与内存未压测；服务无状态但 Node 进程为单进程，
   需要更高吞吐时用 Nginx `upstream` 多实例 + 多个端口（未写）。
