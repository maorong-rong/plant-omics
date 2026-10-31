/**
 * 服务端版本（**独立于包版本**）。
 *
 * 为什么必须拆开：客户端包可以几个月不变，而服务端每加一个源/工具就换代。
 * 两边共用一个号会出现"都叫 0.1.0"的情况——排查时无法判断用户连的是哪一代服务，
 * 我们已经被这个坑过一次。
 *
 * 规则（硬约定）：**源数或工具数一变，`revision` 必须 +1**。
 * 下方 `sources` / `tools` 是声明值，`test/service.test.ts` 会拿真实注册表比对；
 * 忘了改版本号时测试直接红，而不是等到线上才发现两代服务同名。
 */

/** 服务端实现修订号：工具集/源集每变一次 +1 */
export const SERVICE_REVISION = 6;

/** 声明值：当前服务端应有的规模（改工具集时必须同步） */
export const SERVICE_IDENTITY = {
  // svc.6：接上第 8 个源 Ensembl Plants（3 工具），源 7→8、工具 34→37。
  sources: 8,
  tools: 37,
} as const;

/**
 * 对外报告的服务端版本，形如 `0.1.0+svc.1.gabc1234`。
 *
 * - `+svc.N`：第几代服务端（工具集/源集每变一次 +1）
 * - `.g<sha>`：构建来源的 git 短 sha；工作区有改动时带 `-dirty`
 *
 * 两段都在 SemVer 的 build metadata 里（`+` 之后允许点与连字符），
 * **不参与版本比较**，但排查时能直接对上"用户连的是哪一次构建"。
 * 拿不到 sha 时退化成 `0.1.0+svc.1`，不影响启动。
 */
export function serviceVersion(packageVersion: string, sourceRev?: string): string {
  const rev = sourceRev?.trim();
  return rev ? `${packageVersion}+svc.${SERVICE_REVISION}.g${rev}` : `${packageVersion}+svc.${SERVICE_REVISION}`;
}

/** 从构建产物里读 sha（构建期写入 dist/service/build-info.json）；失败返回 undefined。 */
export function readBuildRev(readFile: (path: string) => string, buildInfoPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFile(buildInfoPath)) as { sourceRev?: unknown };
    return typeof parsed.sourceRev === 'string' && parsed.sourceRev.trim() ? parsed.sourceRev.trim() : undefined;
  } catch {
    return undefined;
  }
}
