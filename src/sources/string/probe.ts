/**
 * STRING 源级探活断言（`npm run probe` 调用）。
 *
 * 与 manifest.probe.path 绑定：`/json/version` 没有查询参数，响应自报上游版本
 * （`string_version` + `stable_address`）。因此这里核验版本对象的身份字段非空、
 * 版本号形态，以及 `stable_address` 与 `string_version` 互相一致；
 * 不断言任何具体版本号——上游升级不应被误报成断言失败。
 */
export function validateProbe(payload: unknown): void {
  if (!Array.isArray(payload)) {
    throw new Error('STRING probe: /json/version 应返回数组（形状变化时探活不应命中）');
  }
  if (payload.length === 0) throw new Error('STRING probe: 返回空数组，未拿到版本信息');
  const first = payload[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    throw new Error('STRING probe: 数组元素不是对象');
  }
  const version = first as Record<string, unknown>;
  const stringVersion = version.string_version;
  if (typeof stringVersion !== 'string' || !/^\d+(?:\.\d+)+$/.test(stringVersion)) {
    throw new Error(`STRING probe: string_version=${String(stringVersion)} 不是点分版本号`);
  }
  const stableAddress = version.stable_address;
  if (typeof stableAddress !== 'string' || !stableAddress.trim()) {
    throw new Error('STRING probe: 缺少身份字段 stable_address（或不是非空字符串）');
  }
  const dashedVersion = stringVersion.replaceAll('.', '-');
  if (!stableAddress.includes(`version-${dashedVersion}`)) {
    throw new Error(
      `STRING probe: stable_address=${stableAddress} 未指向 string_version=${stringVersion} 对应的稳定地址`,
    );
  }
}
