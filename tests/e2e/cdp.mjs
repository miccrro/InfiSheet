// 极简 CDP 驱动：起 headless Chrome → 连页面 → eval / 点 / 拖 / 截图 / 收控制台报错。
// 只依赖 Node 18+ 自带的 fetch 与 WebSocket（Node 22+ 才有全局 WebSocket），不装 playwright。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  const hit = CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } });
  if (!hit) throw new Error('找不到 Chrome，用环境变量 CHROME_PATH 指定可执行文件');
  return hit;
}

export async function launchChrome({ port = 9401, profile, headless = true } = {}) {
  const chrome = findChrome();
  mkdirSync(profile, { recursive: true });
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-breakpad', '--disable-crash-reporter',   // crashpad-handler 会一直占着 profile 目录的句柄
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-features=Translate,BackForwardCache',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1600,1000', '--force-device-scale-factor=1',
    'about:blank',
  ];
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return { proc, port };
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  // 起不来也要把进程树收干净：profile 目录被占住的话，下一次启动会继续超时
  await stopChrome({ proc, port });
  throw new Error('CDP 端点超时：' + port);
}

export async function newPage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let seq = 0;
  const pending = new Map();
  const consoleLines = [];
  const errors = [];
  const waiters = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? a.value : a.description ?? a.type))
        .join(' ');
      consoleLines.push({ type: msg.params.type, text });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push({
        kind: 'exception',
        text: d.text,
        detail: d.exception?.description || '',
        url: d.url || '',
        line: (d.lineNumber ?? -1) + 1,
      });
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') errors.push({ kind: 'log', text: e.text, url: e.url || '', line: e.lineNumber });
    }
    for (const w of waiters) w(msg);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const waitEvent = (method, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待事件超时：' + method)), timeout);
      const fn = (msg) => {
        if (msg.method === method) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(fn), 1);
          resolve(msg.params);
        }
      };
      waiters.push(fn);
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  try { await send('Network.setCacheDisabled', { cacheDisabled: true }); } catch { /* 可选 */ }

  const api = {
    send,
    consoleLines,
    errors,
    async goto(url) {
      const loaded = waitEvent('Page.loadEventFired', 20000);
      await send('Page.navigate', { url });
      await loaded;
    },
    async clearStorage(origin) {
      try {
        await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      } catch { /* 老版本没有这个域也无所谓 */ }
    },
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error('eval 失败: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result.value;
    },
    async waitFor(expression, timeout = 10000, interval = 100) {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < timeout) {
        try {
          last = await api.evaluate(expression);
          if (last) return last;
        } catch (e) { last = String(e.message); }
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error(`waitFor 超时: ${expression} (last=${JSON.stringify(last)})`);
    },
    async center(selector) {
      return api.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    },
    async click(selector, { button = 'left', clickCount = 1, settle = 120 } = {}) {
      const c = await api.center(selector);
      if (!c) throw new Error('点不到元素: ' + selector);
      await api.clickAt(c.x, c.y, { button, clickCount, settle });
    },
    async clickAt(x, y, { button = 'left', clickCount = 1, settle = 120 } = {}) {
      const base = { x: Math.round(x), y: Math.round(y), button, clickCount };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      await new Promise((r) => setTimeout(r, settle));
    },
    async drag(from, to, { steps = 12, settle = 200 } = {}) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x), y: Math.round(from.y) });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: Math.round(from.x), y: Math.round(from.y), button: 'left', clickCount: 1,
      });
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), buttons: 1 });
        await new Promise((r) => setTimeout(r, 12));
      }
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: Math.round(to.x), y: Math.round(to.y), button: 'left', clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, settle));
    },
    async key(key, { code, keyCode, modifiers = 0, text } = {}) {
      const params = {
        key, code: code || key, windowsVirtualKeyCode: keyCode || 0,
        nativeVirtualKeyCode: keyCode || 0, modifiers,
      };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(text ? { text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      await new Promise((r) => setTimeout(r, 120));
    },
    async screenshot(file, { selector = null, scale = 1 } = {}) {
      let clip;
      if (selector) {
        const box = await api.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        })()`);
        if (box) clip = { ...box, scale };
      }
      const r = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: !!clip,
        ...(clip ? { clip } : {}),
      });
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async close() {
      try { await send('Page.close'); } catch { /* noop */ }
      try { ws.close(); } catch { /* noop */ }
    },
  };
  return api;
}

// 让 Chrome 自己关掉。Windows 上 spawn 拿到的 pid 往往只是「启动器」——
// 真正的浏览器进程是它重新 exec 出来的另一个 pid，直接 kill 那个 pid 是空操作，
// 结果每次 e2e 都留下 7 个 chrome 进程 + 一个 48MB 的 profile 目录（还会锁住删不掉）。
async function closeBrowserViaCDP(port) {
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const { webSocketDebuggerUrl } = await res.json();
    if (!webSocketDebuggerUrl) return false;
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise((r) => setTimeout(r, 400));
    try { ws.close(); } catch { /* noop */ }
    return true;
  } catch {
    return false;
  }
}

export async function stopChrome(ctx, { wait = 5000 } = {}) {
  if (!ctx) return;
  await closeBrowserViaCDP(ctx.port);
  try { ctx.proc.kill(); } catch { /* noop */ }
  if (process.platform === 'win32' && ctx.proc.pid) {
    try { spawnSync('taskkill', ['/PID', String(ctx.proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* noop */ }
  }
  const t0 = Date.now();
  while (ctx.proc.exitCode === null && Date.now() - t0 < wait) {
    await new Promise((r) => setTimeout(r, 100));
  }
}
