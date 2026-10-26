#!/usr/bin/env node
/**
 * 截图走查（人工看效果用）：起隔离 server + headless Chrome，把主要界面截到 tests/.tmp/shots/。
 * 不做断言，适合改完 UI 后快速出几张图对比。
 *
 *   npm run shots
 */
import path from 'node:path';
import { launchChrome, newPage, stopChrome } from './cdp.mjs';
import { TMP, freePort, makeDataDir, seedProject, startServer, rmDir } from './lib/server.mjs';

const shots = path.join(TMP, 'shots');
const dataDir = makeDataDir();
seedProject(dataDir);
const server = await startServer({ port: await freePort(), dataDir });
let ctx = null;
let page = null;

try {
  ctx = await launchChrome({ port: await freePort(), profile: path.join(TMP, 'chrome-profile') });
  page = await newPage(ctx.port);
  await page.clearStorage(new URL(server.base).origin);
  await page.goto(server.base);
  await page.waitFor(`document.getElementById('home') && !document.getElementById('home').classList.contains('hidden')`, 12000);
  await page.screenshot(path.join(shots, '01-home.png'));

  await page.evaluate(`document.querySelector('#recentList .proj-card .pm').click()`);
  await page.waitFor(`document.querySelectorAll('#nodes .node').length > 0`, 12000);
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot(path.join(shots, '02-canvas.png'));

  // 选中图片节点 → 生成器面板
  await page.evaluate(`(() => {
    const card = document.querySelector('#nodes .node.image .node-card');
    const b = card.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 24, clientY: b.top + 24, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    card.dispatchEvent(new PointerEvent('pointerdown', o));
    card.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot(path.join(shots, '03-gen-panel.png'), { selector: '.gen-panel', scale: 2 });

  await page.click('#projectBar [data-act="settings"]', { settle: 500 });
  await page.screenshot(path.join(shots, '04-settings.png'));
  await page.key('Escape', { code: 'Escape', keyCode: 27 });

  await page.click('#bar [data-act="add-wf"]', { settle: 800 });
  await page.screenshot(path.join(shots, '05-workflows.png'));
  await page.key('Escape', { code: 'Escape', keyCode: 27 });

  await page.screenshot(path.join(shots, '06-dock.png'), { selector: '#dockWrap', scale: 3 });
  console.log('截图目录：' + shots);
} catch (e) {
  console.error('走查失败：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  if (page) await page.close();
  if (ctx) await stopChrome(ctx);
  await server.stop();
  rmDir(dataDir);
  rmDir(path.join(TMP, 'chrome-profile'));
}
