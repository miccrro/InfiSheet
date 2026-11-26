#!/usr/bin/env node
/** Legacy inline images survive a real browser save and reload. */
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, newPage, stopChrome } from './cdp.mjs';
import { TMP, freePort, makeDataDir, startServer, rmDir } from './lib/server.mjs';

const dataDir = makeDataDir();
const projectId = 'media-test';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ setup_done: true }));
const legacyCanvas = {
  version: 2, name: '旧内联图', rev: 0, seq: 2, groups: [], links: [],
  view: { x: 80, y: 80, k: 1 },
  nodes: [{ id: 'i1', type: 'image', title: '旧图', x: 100, y: 100,
    w: 380, h: 380, plain: true, dataURL: png }],
};
fs.writeFileSync(path.join(dataDir, 'projects', `${projectId}.json`), JSON.stringify(legacyCanvas));
fs.writeFileSync(path.join(dataDir, 'projects', 'media-fail.json'), JSON.stringify({
  ...legacyCanvas, name: '坏内联图', nodes: [{ ...legacyCanvas.nodes[0], dataURL: 'data:image/png;base64,AAAA' }],
}));
const server = await startServer({ port: await freePort(), dataDir });
const profile = path.join(TMP, 'media-chrome-' + Date.now());
let chrome = null;
let page = null;
try {
  chrome = await launchChrome({ port: await freePort(), profile, headless: true });
  page = await newPage(chrome.port);
  await page.goto(server.base);
  await page.evaluate(`localStorage.setItem('infisheet-project', '${projectId}')`);
  await page.evaluate(`location.hash = '#canvas'; location.reload()`);
  await page.waitFor(`!!document.querySelector('#nodes .node[data-id="i1"]')`, 10000);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))`);
  await page.waitFor(`document.getElementById('saveState')?.textContent === '已保存'`, 10000);
  const saved = await (await fetch(server.base + `api/projects/${projectId}`)).json();
  const url = saved.canvas?.nodes?.[0]?.dataURL || '';
  if (!url.startsWith('/api/edit-image?h=')) throw new Error(`inline image not persisted: ${url.slice(0, 60)}`);
  const image = await fetch(server.base + url.slice(1));
  if (!image.ok || image.headers.get('content-type') !== 'image/png') {
    throw new Error(`persisted image unavailable: ${image.status}`);
  }
  await page.evaluate(`location.reload()`);
  await page.waitFor(`!!document.querySelector('#nodes .node[data-id="i1"]')`, 10000);
  await page.evaluate(`localStorage.setItem('infisheet-project', 'media-fail'); location.reload()`);
  await page.waitFor(`document.getElementById('projectName')?.value === '坏内联图'`, 10000);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))`);
  await page.waitFor(`document.getElementById('saveState')?.textContent === '保存失败'`, 10000);
  const failed = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'media-fail.json'), 'utf8'));
  if (failed.rev !== 0) throw new Error('failed media was saved as a successful project revision');
  console.log('legacy inline image browser round trip: ok');
} finally {
  if (page) await page.close();
  if (chrome) await stopChrome(chrome);
  if (path.resolve(profile).startsWith(path.resolve(TMP) + path.sep)) rmDir(profile);
  await server.stop();
  rmDir(dataDir);
}
