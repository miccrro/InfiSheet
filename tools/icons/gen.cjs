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
  // 对齐 / 分布：悬浮条用
  alignLeft: 'AlignLeft',
  alignHCenter: 'AlignHorizontalCenterTwo',
  alignRight: 'AlignRight',
  alignTop: 'AlignTop',
  alignVCenter: 'AlignVerticalCenterTwo',
  alignBottom: 'AlignBottom',
  distH: 'DistributeHorizontally',
  distV: 'DistributeVertically',
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
  palette: 'ColorFilter',   // 风格库：色环，比调色板更像「画风」
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

// IconPark 没有对应组件、手写的路径（同样的 48×48 / stroke-width 4 / currentColor 口径）。
// 放在这里是为了「重新生成图标时不被冲掉」——直接改 static/icons.js 会被下一次 gen 覆盖。
const EXTRA = {
  // 裁剪：经典的两笔「裁切框」——一根竖线到底再向右，一根横线到头再向下。
  // 图标集里的 select 是四角锚点的选区框，用在「裁剪」上更像「框选」，容易被当成选框工具
  crop: '<path d="M12 4v32h32" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M4 12h32v32" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  // 旋转：一段带缺口的圆 + 左上角的箭头
  rotate: '<path d="M24 8a16 16 0 1 1-11.3 4.7" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
    + '<path d="M12 4v10h10" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  // 画笔：斜握的笔杆 + 笔尖
  brush: '<path d="M40 8 26 22" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>'
    + '<path d="M25 23l-6 15 15-6z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
  // 橡皮：斜放的橡皮块 + 桌面线
  eraser: '<rect x="11" y="19" width="28" height="15" rx="3" transform="rotate(-40 25 26.5)" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>'
    + '<path d="M12 41h26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
};
Object.assign(out, EXTRA);

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
fs.writeFileSync(target, js);console.log(`icons: ${Object.keys(out).length} 个 → ${path.relative(process.cwd(), target)} (${js.length} bytes)`);
