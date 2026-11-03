# 部署与运维（`datamcp.moilab.net`）

> **状态：已在真实服务器验证（2026-10-31）。** 更新脚本练过两次真实执行（一次同 commit 重放、一次注入门禁失败走回滚）。
> 过程记录与服务器实测快照属内部资料，不随公开快照发布；本文只写"怎么操作"。
> 未验证的项列在最后一节，别当已验证用。
>
> **线上配置以服务器为准**：端口、权限、systemd unit 与 nginx 原文都在服务器上实测核对过，
> 本文不复述它们的逐字内容——复述就会变成第二份真相，迟早与机器不一致。

## 一、形态（实测）

```
客户端（Claude Code / Codex / DSH）
        │  → HTTPS + Bearer token（2026-10-31 起 https://datamcp.moilab.net 可用）
        ▼
      Nginx（80 只做 301 跳转；443 TLS，Let's Encrypt 证书）
        │  http://127.0.0.1:8787
        ▼
  plantomics-hub.service（Node，root 运行，Streamable HTTP：/mcp + /healthz）
```

- 服务**只听回环 8787**，`/mcp` 不带 token 返 **401**（已实测）；`/healthz` 免鉴权且不泄露工具清单。
- `location /` 托管 `/srv/plantomics-hub/site` 落地页 —— 服务器上该目录**不在服务器仓库里**，内容等同 `e473b9a:site/`（见 §三）。
- ⚠ **硬限制（审查口径，2026-10-31 立）**：TLS 未上之前不对外发布带 token 的调用地址（Bearer 头会明文过网）。现在 TLS 已上，**只对外发布 `https://` 地址，不发布 `http://` 或裸 IP**；`http://` 会 301 跳转，但中途那一段请求头仍是明文。


## 二、路径（与早期文档不同的地方，以本节为准）

| 用途 | 实际路径 | 备注 |
|---|---|---|
| 代码 | `/srv/plantomics-hub` | git 仓，origin 为 GitHub 公开仓，分支 `main`，31 提交，非浅克隆 |
| 构建产物 | `/srv/plantomics-hub/dist` | `.gitignore` 忽略；`dist/service/build-info.json` 记 `sourceRev` |
| 落地页 | `/srv/plantomics-hub/site` | **不在 git**，`scp` 上传；目录须 **755**、文件 **644** |
| 环境变量 | `/etc/plantomics-hub/env` | `600 root:root`，`EnvironmentFile=` 引用 |
| systemd 单元 | `/etc/systemd/system/plantomics-hub.service` | 以 **root** 运行（待加固） |
| Nginx 站点 | `/etc/nginx/sites-available/datamcp` | 单文件，`sites-enabled/datamcp` 软链 |
| 部署日志 | `/var/log/plantomics-hub/update-*.log` | 保留最近 10 份 |

> 早期 `deploy/README.md` 写的 `/opt/plantomics-hub` + `plantomics` 系统用户**在服务器上都不存在**，那是未落地的设想。

## 三、脚本（三个，装在 `/usr/local/sbin/`，仓库里是源）

| 脚本 | 作用 |
|---|---|
| `deploy/update.sh` | 锁 commit → `npm ci` + `npm run build` → 重启 → 门禁 → 不过就回滚 |
| `deploy/check.sh` | 巡检：服务、`/healthz`、版本一致性、静态资源、端口、资源、证书、DNS |
| `deploy/enable-https.sh` | DNS 就绪后一键签发 + 强制 https + 续期定时器 + 实测 |

**装到服务器**（仓库副本改动后必做，否则跑的还是旧脚本）：

```bash
sudo install -m 0755 deploy/update.sh /usr/local/sbin/plantomics-update.sh
sudo install -m 0755 deploy/check.sh /usr/local/sbin/plantomics-check.sh
sudo install -m 0755 deploy/enable-https.sh /usr/local/sbin/plantomics-enable-https.sh
sudo mv /usr/local/sbin/update.sh /usr/local/sbin/plantomics-update.sh   # 首次
sudo mv /usr/local/sbin/check.sh  /usr/local/sbin/plantomics-check.sh
```

> 为什么装到 `/usr/local/sbin` 而不是直接在 `/srv/plantomics-hub/deploy/` 里跑：
> 脚本一旦入库，`git checkout` 会被同名未跟踪文件挡住；装到仓库外就没有这个冲突。
> 代价是两份副本，所以 `update.sh` 启动时会打印**自己文件的 sha256**，据此确认跑的是哪一版。

## 四、更新一版（唯一入口）

```bash
# 1) 先看要上哪一版（在仓库里定，不在服务器上"拉最新"）
git -C /srv/plantomics-hub fetch origin
git -C /srv/plantomics-hub log --oneline origin/main -5

# 2) 干跑：只校验 commit 与工作区，不动服务
sudo bash /usr/local/sbin/plantomics-update.sh --commit <sha> --dry-run

# 3) 真跑
sudo bash /usr/local/sbin/plantomics-update.sh --commit <sha>
```

门禁是**三件事同时成立**，缺一不算成功：

1. `/healthz` 的 `status` = `ok`（直连 8787 与经 Nginx 都查）；
2. `sources` / `tools` 等于 `--expect-sources` / `--expect-tools`（默认 8 / 37）；
3. `version` 里的 `g<short-sha>` 就是这次要上的 commit —— 防止"构建失败但旧进程还在跑"被误判成成功。

**不过就自动回滚**到本次执行前的 HEAD，重新 `npm ci` + `build` + `restart`，并且回滚后**同样要过门禁**；
回滚也失败 → 退出码 `3`，日志里带最近 40 行服务日志，等人介入。

实测数字（同 commit 重放）：**全流程 21.9 s**，其中 `npm ci` 6 s、`tsc` 构建约 12 s、`restart` 到 `/healthz` 可查约 3 s。
**没有原子切换**：`systemctl restart` 期间服务不可用，别写"零停机"。

回滚到任意历史版本就是再跑一次 update，把 commit 换成目标：

```bash
sudo bash /usr/local/sbin/plantomics-update.sh --commit <上一个sha>
```

### 演练门禁与回滚（不改变线上版本）

```bash
sudo bash /usr/local/sbin/plantomics-update.sh --commit <当前sha> --self-test-fail-gate
```

它强制跳过目标门禁、走完整回滚分支（checkout + 构建 + 重启 + 回滚门禁），用来证明回滚链路没坏。
实测耗时 39.8 s（两次构建），结束时服务停在原版本。

## 五、HTTPS（2026-10-31 19:37 CST 已签发并生效）

```bash
sudo bash /usr/local/sbin/plantomics-enable-https.sh --email <邮箱> --dry-run   # staging 预演，不占配额
sudo bash /usr/local/sbin/plantomics-enable-https.sh --email <邮箱>             # 正式签发
```

它会：`certbot --nginx --redirect`（80→443）、启用 `certbot.timer`、
写 `/etc/letsencrypt/renewal-hooks/deploy/10-reload-nginx.sh`（续期后自动 reload nginx）、
最后实测 https 的 `/healthz`、跳转、静态资源并打印证书到期时间。
脚本开头**强制校验 DNS**：没指本机直接 `exit 4`（避免白白消耗失败配额）。

实测结果：`issuer=Let's Encrypt CN=YE1`，`notAfter=Jan 29 10:45:03 2027 GMT`，`certbot.timer` enabled+active，
`certbot renew --dry-run` = `all simulated renewals succeeded`，外网 `https://datamcp.moilab.net/healthz` → 200、`ssl_verify_result=0`。

**两个实遇到的坑，改脚本前必须知道**：

1. **`--keep-until-expiring` 会留下 staging 证书。** 先跑 `--dry-run`（staging）之后再正式签发，certbot 认为"还没到期"，
   于是 443 上继续跑**不受信任的 staging 证书**（`INVALID: TEST_CERT`）。正式签发必须 `--force-renewal`。
2. **这台机器到生产端点 `acme-v02.api.letsencrypt.org` 丢包严重**：同一请求三次 0.76 s / 14.2 s / 25 s 超时，
   certbot 默认 45 s 读超时因此偶发 `ReadTimeout`（首次正式签发就失败了一次，重试成功）。
   续期同理——靠 `certbot.timer` 每日两次重试 + 证书提前 30 天续，巡检按"剩 < 21 天"报警兜底。

⚠️ `certbot --nginx` 会改 `/etc/nginx/sites-available/datamcp`（脚本已自动备份为 `datamcp.bak-<时间>`），
并在**每次续期**时再改写。仓库 `deploy/nginx.conf` 是镜像，续期后要重新抄回。
另：80 块现在只有 `Host = datamcp.moilab.net` 才 301，其它 Host（含裸 IP、`127.0.0.1`）拿 `return 404`——
所以巡检脚本改走 `https + --resolve 回环`，不要再用 `http://127.0.0.1/healthz`。

## 六、日常巡检

```bash
sudo bash /usr/local/sbin/plantomics-check.sh          # 完整报告，退出码 0/1
sudo bash /usr/local/sbin/plantomics-check.sh --quiet  # 只在有问题时输出，适合 cron
```

八组检查：systemd（含重启次数、开机自启）、`/healthz` 双路径 + 数字、**运行版本 vs 仓库 HEAD**、
**静态资源字节数**（防"200 但返回 index.html"）、端口与 ufw、磁盘/内存/journal、证书剩余天数 + `certbot.timer` 是否 enabled+active、域名解析。

**已知放宽项不写死在脚本里**：`deploy/waivers.conf` → `/etc/plantomics-hub/waivers.conf`，每行 `id|说明|负责人|起始日期|到期日期`。
巡检时若某项失败且清单里有**未到期**条目 → 记 ⚠（日志带"已放宽 N 天，至 …，剩 … 天"），不计失败；
条目**过期**或压根没登记 → 记 ✗ 并让 `check.sh` 非零退出；问题修好后自动变 ✓ 并提示可删除该条目。
现在清单里只有一条 `ufw-inactive`（等本涛授权，至 2026-12-31）。

**为什么检查静态资源字节数**：2026-10-31 发现 `site/{assets,data,scripts}` 权限是 `700 root`，
`www-data` 读不到 → `try_files` 全部落到 `/index.html` 兜底 → 每个资源都返回 **200 + HTML**，
浏览器里样式全丢、源卡片永远"正在读取构建期数据…"。只看状态码的监控完全看不见这类故障。

## 七、安全边界（运维侧待办，未做的不写"已做"）

- ✅ **DNS 已切** `datamcp.moilab.net` → 已解析到本机（具体地址见服务器配置，此处脱敏，2026-10-31），HTTPS 已签发
- 🔴 **`site/` 仍靠 `scp` 通道**：内容虽已核对等于 `e473b9a:site/`，但服务器仓库没有该目录、没有脚本化发布，随时可能再漂移
- 🟠 **ufw 未启用**：22/80/443 全网开放（授权范围，先报后做；启用时只放 22/80/443，8787 保持回环，并用 `at now + 5 minutes 'ufw disable'` 留退路）
- 🟠 **服务以 root 运行**：待加系统用户 + `User=` + `NoNewPrivileges`/`ProtectSystem`（env 保持 `600 root:root`，别为换用户放宽到 644）
- 🟠 **无备份**：最小方案 = `site/` + `/etc/plantomics-hub/` + nginx/systemd 配置 + `/etc/letsencrypt/` 每日归档
- 🟡 `LOG` 键无效：代码只读 `PLANTOMICS_HUB_LOG`（`quiet`/`info`）；`PORT` 是**设计内兼容键**（`config.ts:51`），可保留
- 🟡 Nginx 缺 `default_server`（未知 Host 会命中站点）与安全响应头；`try_files` 兜底会把 404 变成 200
- token 只在 `/etc/plantomics-hub/env`，**不进仓库、不进文档、不进聊天**

## 八、未验证项（如实列出）

1. **续期没跑过真实周期**：`certbot renew --dry-run` 通过、timer 已 enabled，但真正的到期自动续期要等 2027-01 前那几周才第一次发生；且本机到生产 ACME 端点丢包，续期有偶发失败风险（靠每日两次重试 + 巡检告警兜底，**尚未验证连败两天的情形**）。
2. **回滚到"另一个 commit"未实跑**：演练时前后 commit 相同，验证的是回滚机制本身，不是"旧版本能否正常构建"。
   真正的跨版本回滚要等第一次有意义的更新才能验。
3. **未压测**：单 Node 进程，2 核 2 GB，并发与内存表现未知。
4. **云安全组无法在机内验证**：ufw inactive、nft 规则集为空，入站是否真放行只有本涛侧能确认。
5. `bootstrap.sh` 仍是早期未验证物料（`/opt/plantomics-hub` 那套），当前服务器**不是**用它装的，别拿来重建。
