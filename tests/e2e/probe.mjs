#!/usr/bin/env node
/**
 * 通用探针：把任意 body 模块跑在一个已在运行的实例上，输出 JSON。
 * body 模块默认导出 async (page, { out, shots }) => {}。
 *
 *   npm run dev                                   # 另开一个终端起服务
 *   node tests/e2e/probe.mjs <body.mjs>
 *
 * BASE 环境变量指定地址（默认 http://127.0.0.1:8788/）。
 */
import path from 'node:path';
import { TMP, freePort } from './lib/server.mjs';
import { launchChrome, newPage, stopChrome } from './cdp.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788/';
const shots = path.join(TMP, 'shots');
const bodyPath = process.argv[2];
if (!bodyPath) {
  console.error('用法：node tests/e2e/probe.mjs <body.mjs>');
  process.exit(2);
}

const mod = await import('file://' + path.resolve(bodyPath));
const ctx = await launchChrome({ port: await freePort(), profile: path.join(TMP, 'chrome-profile') });
const page = await newPage(ctx.port);
const out = {};
try {
  await page.clearStorage(new URL(BASE).origin);
  await page.goto(BASE);
  await new Promise((r) => setTimeout(r, 1200));
  await mod.default(page, { out, shots, base: BASE });
} catch (e) {
  out.fatal = String((e && e.stack) || e);
} finally {
  out.errors = page.errors.slice();
  out.console = page.consoleLines.slice(-30);
  await page.close();
  await stopChrome(ctx);
}
console.log(JSON.stringify(out, null, 2));
