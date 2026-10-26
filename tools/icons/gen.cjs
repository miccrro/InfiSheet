#!/usr/bin/env node
/*
 * 生成 static/icons.js —— 图标全部来自 IconPark（https://iconpark.oceanengine.com/official）。
 *
 * 只做一次「把 SVG path 抠出来写死」的事，所以产品运行时不依赖 @icon-park/svg、不联网、不引 CDN。
 * 改了映射表之后跑：  node tools/icons/gen.cjs   （或 npm run icons）
 * 需要先安装开发依赖：  npm install
 */
const fs = require('fs');
const path = require('path');

let ip;
try {
  ip = require('@icon-park/svg');
} catch {
  console.error('缺少 @icon-park/svg，先跑 `npm install`（只在生成图标时需要）');
  process.exit(1);
}

// key（代码里用的短名）→ IconPark 组件名；数组形式是 [组件名, strokeWidth]
const MAP = {
  home: 'Home',
  layers: 'Layers',
  film: 'Film',
  plus: 'Plus',
  setting: 'SettingTwo',
  select: 'Selected',
  hand: 'HandDrag',
  grid4: 'GridFour',
  more: 'More',
  time: 'Time',
  help: 'Help',
  book: 'BookOpen',
  fit: 'FullScreen',
  map: 'MapDraw',
  link: 'LinkOne',
  snap: 'GridNine',
  text: 'Text',
  image: 'Pic',
  wf: 'Layers',
  out: 'PicOne',
  upload: 'Upload',
  material: 'Pic',
  clear: 'Delete',
  expand: 'FullScreen',
  arrowUp: 'ArrowUp',
  arrowUpBold: ['ArrowUp', 6],
  close: 'CloseSmall',
  zoom: 'FullScreenTwo',
  magic: 'MagicWand',
  video: 'Video',
  music: 'Music',
  script: 'Notes',
  clip: 'Scissors',
  check: 'Check',
  pointer: 'MoveOne',
};

const out = {};
for (const [key, spec] of Object.entries(MAP)) {
  const comp = Array.isArray(spec) ? spec[0] : spec;
  const strokeWidth = Array.isArray(spec) ? spec[1] : 4;
  if (typeof ip[comp] !== 'function') throw new Error('IconPark 里没有这个图标: ' + comp);
  let svg = ip[comp]({ size: 48, strokeWidth, theme: 'outline', fill: 'currentColor' });
  svg = svg.replace(/<\?xml[^>]*\?>/, '');
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  out[key] = inner.replace(/\s+/g, ' ').trim();
}

const js = `/* 图标：全部来自 IconPark（https://iconpark.oceanengine.com/official）
 * 由 tools/icons/gen.cjs 生成，别手改。
 * outline 主题、48×48 viewBox、stroke-width 4，颜色走 currentColor —— 产品运行时零依赖、离线可用。 */
(function () {
  var P = ${JSON.stringify(out, null, 2)};
  function icon(name, cls) {
    var d = P[name];
    if (!d) return '';
    return '<svg class="oi' + (cls ? ' ' + cls : '') + '" viewBox="0 0 48 48" fill="none" aria-hidden="true">' + d + '</svg>';
  }
  window.ICON_PATHS = P;
  window.icon = icon;
  window.hydrateIcons = function (root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      if (el.dataset.iconDone) return;
      el.innerHTML = icon(el.dataset.icon);
      el.dataset.iconDone = '1';
    });
  };
  if (document.readyState !== 'loading') window.hydrateIcons();
  else document.addEventListener('DOMContentLoaded', function () { window.hydrateIcons(); });
})();
`;

const target = path.resolve(__dirname, '../../static/icons.js');
fs.writeFileSync(target, js);
console.log(`icons: ${Object.keys(out).length} 个 → ${path.relative(process.cwd(), target)} (${js.length} bytes)`);
