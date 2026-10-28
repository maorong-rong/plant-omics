import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 单元测试一律回放 fixture，不联网。联网的事交给 scripts/probe.mjs。
    testTimeout: 10_000,
  },
});
