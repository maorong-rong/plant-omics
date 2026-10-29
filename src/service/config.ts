/**
 * 服务端配置：只从环境变量读，不读宿主配置。
 *
 * 为什么不复用 DSH 的配置文件：这个进程要能独立部署在任何机器上，
 * 它不该知道 DSH 的 profile 结构；反过来 DSH 也不该依赖它的内部布局。
 */

export interface ServiceConfig {
  readonly host: string;
  readonly port: number;
  /** 静态 Bearer token；undefined = 不鉴权（仅允许回环绑定） */
  readonly token?: string;
  /** MCP 命名空间，决定模型看到的 mcp__<name>__<tool> 前缀 */
  readonly serverName: string;
  readonly logLevel: 'quiet' | 'info';
  /**
   * 额外允许的 Host/Origin 主机名（不含端口）。
   * 走反向代理时 Host 是代理域名，必须显式加进来，否则会被 403。
   */
  readonly allowedHostnames: readonly string[];
}

export class ServiceConfigError extends Error {}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** 主机名只允许字母/数字/点/连字符/下划线，禁止协议与路径（避免配错却以为生效） */
const HOSTNAME_PATTERN = /^[A-Za-z0-9._-]{1,253}$/;

/** 不鉴权时必须绑回环：这是一条硬边界，不是建议。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** `a.com, b.com` / `a.com;b.com` / 空白分隔 */
export function parseHostList(raw: string | undefined): string[] {
  if (!raw) return [];
  const items = raw.split(/[,;\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  for (const item of items) {
    if (!HOSTNAME_PATTERN.test(item)) {
      throw new ServiceConfigError(
        `PLANTOMICS_HUB_ALLOWED_HOSTS 里的主机名不合法：${JSON.stringify(item)}（只写主机名，不要带协议或路径）`,
      );
    }
  }
  return [...new Set(items)];
}

export function parseServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const host = (env.PLANTOMICS_HUB_HOST ?? '127.0.0.1').trim();
  if (!host) throw new ServiceConfigError('PLANTOMICS_HUB_HOST 不能为空');

  // PaaS 平台普遍注入 PORT；我们的专用变量优先，便于本机固定端口
  const rawPort = (env.PLANTOMICS_HUB_PORT ?? env.PORT ?? '8787').trim();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ServiceConfigError(`PLANTOMICS_HUB_PORT / PORT 必须是 0–65535 的整数，收到 ${JSON.stringify(rawPort)}`);
  }

  const serverName = (env.PLANTOMICS_HUB_SERVER_NAME ?? 'plantomics-hub').trim();
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new ServiceConfigError(
      `PLANTOMICS_HUB_SERVER_NAME 只允许字母/数字/下划线/连字符且 1–32 字符，收到 ${JSON.stringify(serverName)}`,
    );
  }

  const rawToken = env.PLANTOMICS_HUB_TOKEN?.trim();
  const token = rawToken ? rawToken : undefined;
  if (token && token.length < 16) {
    throw new ServiceConfigError('PLANTOMICS_HUB_TOKEN 至少 16 字符；短 token 等于没有鉴权');
  }
  if (!token && !LOOPBACK_HOSTS.has(host)) {
    throw new ServiceConfigError(
      `未配置 PLANTOMICS_HUB_TOKEN 时只能绑定回环地址（听到 ${host}）。对外监听必须带 token。`,
    );
  }

  const logLevel = env.PLANTOMICS_HUB_LOG === 'quiet' ? 'quiet' : 'info';
  const allowedHostnames = parseHostList(env.PLANTOMICS_HUB_ALLOWED_HOSTS);
  return { host, port, token, serverName, logLevel, allowedHostnames };
}
