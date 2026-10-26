// 起一个隔离的 server.py 实例：随机端口 + 临时 data 目录，跑完就地清理。
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(E2E_DIR, '../..'); // comfy-canvas/
export const TMP = path.join(ROOT, 'tests', '.tmp');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function makeDataDir() {
  fs.mkdirSync(TMP, { recursive: true });
  const dir = path.join(TMP, 'data-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

export function seedProject(dataDir, fixtureName = 'canvas-basic.json', id = '20260101-000000-e2e1') {
  const src = path.join(E2E_DIR, 'fixtures', fixtureName);
  fs.copyFileSync(src, path.join(dataDir, 'projects', `${id}.json`));
  return id;
}

export async function startServer({ port, dataDir }) {
  const proc = spawn(PY, ['-X', 'utf8', 'server.py', '--port', String(port), '--data', dataDir, '--no-browser'], {
    cwd: ROOT,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (b) => { stderr += b.toString(); });
  proc.stdout.on('data', () => {});
  const base = `http://127.0.0.1:${port}/`;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try {
      const r = await fetch(base + 'api/health', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { proc, base, stop: () => stopServer(proc) };
    } catch { /* 还没起来 */ }
    if (proc.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  stopServer(proc);
  throw new Error(`server 没起来（exit=${proc.exitCode}）\n${stderr.slice(-800)}`);
}

export async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill();
  const t0 = Date.now();
  while (proc.exitCode === null && Date.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (proc.exitCode === null) {
    try { proc.kill('SIGKILL'); } catch { /* 已经没了 */ }
  }
}

export function rmDir(dir) {
  // Windows 上 Chrome 退出后句柄释放有延迟，一次性删除经常 EBUSY；
  // maxRetries 只对 EBUSY/EPERM 这类瞬时错误重试，正是这里要的。
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
    return true;
  } catch {
    return false; // 实在删不掉就留给 .gitignore 兜着
  }
}
