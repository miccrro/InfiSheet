#!/usr/bin/env node
/**
 * 轻量自检：不装 linter 也能跑 —— 对每个 JS/ESM 文件做一次语法检查，
 * 再用 py_compile 编译一遍 Python。CI 和本地 pre-commit 都能用。
 *
 *   npm run check
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'data', '.tmp', 'dist'].includes(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const jsExt = new Set(['.js', '.mjs', '.cjs']);
const pyExt = new Set(['.py']);

const files = walk(ROOT).filter((f) => jsExt.has(path.extname(f)) || pyExt.has(path.extname(f)));
const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

let failed = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const isPy = pyExt.has(path.extname(file));
  const args = isPy ? ['-X', 'utf8', '-m', 'py_compile', file] : ['--check', file];
  const bin = isPy ? py : process.execPath;
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) {
    console.log('ok    ' + rel);
  } else {
    failed += 1;
    console.log('FAIL  ' + rel + '\n' + (r.stderr || '').trim());
  }
}

console.log(`\n检查 ${files.length} 个文件，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
