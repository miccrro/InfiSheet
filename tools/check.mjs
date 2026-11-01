#!/usr/bin/env node
/**
 * 轻量自检：不装 linter 也能跑 —— 对每个 JS/ESM 文件做一次语法检查，
 * 再用 py_compile 编译一遍 Python。CI 和本地 pre-commit 都能用。
 *
 *   npm run check
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
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

// 启动脚本的执行位：macOS 双击 .command 要求文件本身可执行。这个位丢过一次——
// 仓库里的 .command / .sh 是 100644，clone 或下载下来双击只有一句 permission denied。
// Windows 上 core.filemode 是关的，重新 add 很容易再丢，所以在 CI 里钉住。
// zip 分发包没有 .git，查不到就跳过；没装 git 也一样跳过。
if (existsSync(path.join(ROOT, '.git'))) {
  for (const name of ['启动.command', 'start.sh']) {
    const r = spawnSync('git', ['ls-files', '-s', '--', name], { cwd: ROOT, encoding: 'utf8' });
    const mode = (r.stdout || '').trim().split(/\s+/)[0] || '';
    if (r.error || r.status !== 0) {
      console.log(`skip  ${name} 执行位（git 不可用）`);
    } else if (!mode) {
      console.log(`skip  ${name} 执行位（没被 git 跟踪）`);
    } else if (mode === '100755') {
      console.log(`ok    ${name} 执行位 100755`);
    } else {
      failed += 1;
      console.log(`FAIL  ${name} 执行位是 ${mode}，macOS 双击会报 permission denied\n` +
        `      git update-index --chmod=+x ${name}`);
    }
  }
}

console.log(`\n检查 ${files.length} 个文件，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
