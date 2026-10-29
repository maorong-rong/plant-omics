/**
 * 包版本常量（单一来源）。
 *
 * 为什么单独一个文件：`SERVER_INFO.version` 与 `SERVICE_IDENTITY` 都要用它，
 * 而 `src/mcp/server.ts` 与 `src/sources/index.ts` 之间本来就有导入关系；
 * 谁再去 import 谁都会形成环，环在 ESM 里表现为"初始化时读到 undefined"。
 * 放在这里没有任何 import，谁都能安全引用。
 *
 * 必须与 `package.json` 的 `version` 一致——`test/core.test.ts` 有断言盯着。
 */
export const PACKAGE_VERSION = '0.1.0';
