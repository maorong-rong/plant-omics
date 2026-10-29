#!/usr/bin/env node
/**
 * 启动 Streamable HTTP 服务（本机回环默认）。
 *
 *   npm run serve                      # 127.0.0.1:8787，不鉴权
 *   PLANTOMICS_HUB_PORT=0 npm run serve # 让系统分配端口，便于测试
 *   PLANTOMICS_HUB_HOST=0.0.0.0 PLANTOMICS_HUB_TOKEN=<≥16字符> npm run serve
 *
 * 变量：PLANTOMICS_HUB_HOST / _PORT / _TOKEN / _SERVER_NAME / _LOG
 *      PLANTOMICS_SOURCES（只启用部分源，沿用 MCP 出口的同一语义）
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const entry = pathToFileURL(join(process.cwd(), 'dist', 'service', 'cli.js')).href;
await import(entry);
