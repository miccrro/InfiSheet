/* 图标：手绘 SF Symbols 风格轮廓图标集（24 栅格，非 IconPark 生成）。
 *
 * 规范（改图标前先看这一段）：
 *   - viewBox 0 0 24 24；描边/填充/圆角只在根 <svg> 上声明一次，path 里不再写属性。
 *     这样 style.css 的 --oi-stroke 才能按渲染尺寸做「光学粗细」补偿，否则 path 上的
 *     stroke-width 会把 CSS 全部压死（旧版就是这么失效的）。
 *   - 描边基准 1.75（24 栅格）；圆头圆角；颜色走 currentColor。
 *   - 光学核心区 3.6–20.4（即四周留 3.6），方形类容器统一 3.5/17/rx2.6。
 *   - 实心元素必须显式写 fill="currentColor" stroke="none"。
 *   - 同一图标只画一种语义：不允许两个 key 指向同一张图（旧版 layers=wf、image=material
 *     就是重复，看的人分不出区别）。
 */
(function () {
  var P = {
  /* ---------- 全局 / 导航 ---------- */
  "home": "<path d=\"M3.6 10.3 12 3.6l8.4 6.7V19a1.7 1.7 0 0 1-1.7 1.7H5.3A1.7 1.7 0 0 1 3.6 19z\"/><path d=\"M9.5 20.7v-5.5h5v5.5\"/>",
  "layers": "<path d=\"M12 3.4 20.6 8 12 12.6 3.4 8z\"/><path d=\"M3.4 12 12 16.6 20.6 12\"/><path d=\"M3.4 16 12 20.6 20.6 16\"/>",
  "film": "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"2.6\"/><path d=\"M8.7 4.5v15\"/><path d=\"M15.3 4.5v15\"/>",
  "plus": "<path d=\"M12 4.9v14.2\"/><path d=\"M4.9 12h14.2\"/>",
  "setting": "<path d=\"M21.24 9.78 21.24 14.22 18.51 13.56 17.71 15.5 20.1 16.96 16.96 20.1 15.5 17.71 13.56 18.51 14.22 21.24 9.78 21.24 10.44 18.51 8.5 17.71 7.04 20.1 3.9 16.96 6.29 15.5 5.49 13.56 2.76 14.22 2.76 9.78 5.49 10.44 6.29 8.5 3.9 7.04 7.04 3.9 8.5 6.29 10.44 5.49 9.78 2.76 14.22 2.76 13.56 5.49 15.5 6.29 16.96 3.9 20.1 7.04 17.71 8.5 18.51 10.44Z\"/><circle cx=\"12\" cy=\"12\" r=\"3.4\"/>",
  // 「框选」那颗：鼠标指针，线框版（和底栏其它图标一样走 stroke，不用实心）。
  // 轮廓只有四个点：尖角 → 尾尖 → 缺口 → 肩部；**左边那条是直线**，中间不能有折点，
  // 多一个点就会在左侧鼓出一个包（试过，很明显）。缺口是凹角，靠它才像指针而不是普通箭头。
  // 描边/圆角全交给根 <svg> 的 stroke-width 和 linejoin——path 里写死会把 --oi-stroke 压死。
  // 四个点按参考图的线框版本重新量过：肩部更高（约 38% 高度）、尾巴更靠中间（约 35% 宽度），
  // 比实心版更"正"，和底栏其它图标摆一起不会往一边倒。
  "select": "<path d=\"M5.21 4.91 9.63 19.25 12.63 14.1 18.95 10.07Z\"/>",
  // 「抓手」那颗：四指 + 拇指的张手。四根手指是四个相邻的 U 形（共用边线），不是四根独立
  // 胶囊——24 栅格里 1.75 的描边会把胶囊内空吃掉（2.8 宽只剩 1.05，20px 下就是一团实线），
  // 相邻共用边线才能在同样的宽度里塞下四指还留出指缝。拇指是手掌轮廓左下角那个凸起，
  // 不是单独一根短线（短线的圆头看着像根刺）。
  "hand": "<path d=\"M16.6 11.1V6.5a1.7 1.7 0 0 0-3.4 0v4.6\"/><path d=\"M13.2 10.3V4.7a1.7 1.7 0 0 0-3.4 0v5.6\"/><path d=\"M9.8 10.7V6.5a1.7 1.7 0 0 0-3.4 0v6.6\"/><path d=\"M16.6 8.3a1.7 1.7 0 1 1 3.4 0v6.0a6.6 6.6 0 0 1-6.6 6.6h-1.4c-2.2 0-3.6-.7-4.8-1.9l-2.7-2.7a1.6 1.6 0 0 1 2.3-2.3l2.6 2.4\"/>",
  "grid4": "<rect x=\"3.5\" y=\"3.5\" width=\"17\" height=\"17\" rx=\"2.6\"/><path d=\"M12 3.5v17\"/><path d=\"M3.5 12h17\"/>",
  "more": "<circle cx=\"5.1\" cy=\"12\" r=\"1.65\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"12\" cy=\"12\" r=\"1.65\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"18.9\" cy=\"12\" r=\"1.65\" fill=\"currentColor\" stroke=\"none\"/>",
  "time": "<circle cx=\"12\" cy=\"12\" r=\"8.4\"/><path d=\"M12 6.9V12l4.3 3.1\"/>",
  "help": "<circle cx=\"12\" cy=\"12\" r=\"8.4\"/><path d=\"M9.4 9.7a2.65 2.65 0 1 1 3.6 2.5c-.7.3-1 .85-1 1.6v.5\"/><circle cx=\"12\" cy=\"17.3\" r=\"1.15\" fill=\"currentColor\" stroke=\"none\"/>",
  "book": "<path d=\"M12 7.3C10.4 5.7 8.3 5 4.9 5v13.5c3.4 0 5.5.7 7.1 2.3 1.6-1.6 3.7-2.3 7.1-2.3V5c-3.4 0-5.5.7-7.1 2.3z\"/><path d=\"M12 7.3v13.5\"/>",

  /* ---------- 画布视图 ---------- */
  "fit": "<path d=\"M3.6 9V5.6a2 2 0 0 1 2-2H9\"/><path d=\"M15 3.6h3.4a2 2 0 0 1 2 2V9\"/><path d=\"M20.4 15v3.4a2 2 0 0 1-2 2H15\"/><path d=\"M9 20.4H5.6a2 2 0 0 1-2-2V15\"/>",
  "map": "<path d=\"M3.6 6.6 9.2 4.5l5.6 2.1 5.6-2.1v13.3l-5.6 2.1-5.6-2.1-5.6 2.1z\"/><path d=\"M9.2 4.5v13.3\"/><path d=\"M14.8 6.6v13.3\"/>",
  "link": "<path d=\"M13.7 7.9l1.9-1.9a3.4 3.4 0 0 1 4.8 4.8l-1.9 1.9\"/><path d=\"M10.3 16.1l-1.9 1.9a3.4 3.4 0 0 1-4.8-4.8l1.9-1.9\"/><path d=\"M8.9 15.1l6.2-6.2\"/>",
  "snap": "<circle cx=\"5.6\" cy=\"5.6\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"12\" cy=\"5.6\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"18.4\" cy=\"5.6\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"5.6\" cy=\"12\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"12\" cy=\"12\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"18.4\" cy=\"12\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"5.6\" cy=\"18.4\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"12\" cy=\"18.4\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"18.4\" cy=\"18.4\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/>",

  /* ---------- 编辑 ---------- */
  // 撤销 / 重做：一段圆弧 + 箭头。两个互为镜像，一眼能看出方向。
  "undo": "<path d=\"M7.4 6.6 3.6 10.4l3.8 3.8\"/><path d=\"M3.6 10.4h10.2a6 6 0 0 1 0 12H11\"/>",
  "redo": "<path d=\"M16.6 6.6l3.8 3.8-3.8 3.8\"/><path d=\"M20.4 10.4H10.2a6 6 0 0 0 0 12H13\"/>",

  /* ---------- 节点类型 ---------- */
  "text": "<path d=\"M5.2 7.1V5.2h13.6v1.9\"/><path d=\"M12 5.2v13.6\"/><path d=\"M9.3 18.8h5.4\"/>",
  "image": "<rect x=\"3.5\" y=\"4.5\" width=\"17\" height=\"15\" rx=\"2.6\"/><circle cx=\"8.6\" cy=\"9.2\" r=\"1.5\"/><path d=\"M5.6 16.8 9.2 13.2 12.6 16.4 14.9 14.1 17.8 17.2\"/>",
  "wf": "<rect x=\"3.4\" y=\"3.8\" width=\"7.8\" height=\"6.6\" rx=\"1.2\"/><rect x=\"12.6\" y=\"13.6\" width=\"7.8\" height=\"6.6\" rx=\"1.2\"/><path d=\"M7.3 10.4v5a1.6 1.6 0 0 0 1.6 1.6h3.7\"/>",
  "out": "<path d=\"M20.4 13.6v4.6a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2V5.6a2 2 0 0 1 2-2h4.6\"/><path d=\"M14.6 3.6h5.8v5.8\"/><path d=\"M20.4 3.6 13.4 10.6\"/>",
  "upload": "<path d=\"M12 13.6V3.7\"/><path d=\"M7.7 8 12 3.7l4.3 4.3\"/><path d=\"M4.4 14.7v3.4a1.9 1.9 0 0 0 1.9 1.9h11.4a1.9 1.9 0 0 0 1.9-1.9v-3.4\"/>",
  "material": "<rect x=\"3.6\" y=\"3.6\" width=\"6.8\" height=\"6.8\" rx=\"1.8\"/><rect x=\"13.6\" y=\"3.6\" width=\"6.8\" height=\"6.8\" rx=\"1.8\"/><rect x=\"3.6\" y=\"13.6\" width=\"6.8\" height=\"6.8\" rx=\"1.8\"/><rect x=\"13.6\" y=\"13.6\" width=\"6.8\" height=\"6.8\" rx=\"1.8\"/>",
  "clear": "<path d=\"M4.6 6.6h14.8\"/><path d=\"M9.6 6.6V4.7a1.1 1.1 0 0 1 1.1-1.1h2.6a1.1 1.1 0 0 1 1.1 1.1v1.9\"/><path d=\"M6.4 6.6l.85 12.3a1.7 1.7 0 0 0 1.7 1.6h6.1a1.7 1.7 0 0 0 1.7-1.6l.85-12.3\"/><path d=\"M10.3 10.4v6.2\"/><path d=\"M13.7 10.4v6.2\"/>",
  "expand": "<path d=\"M14 3.6h6.4V10\"/><path d=\"M20.4 3.6 13.6 10.4\"/><path d=\"M10 20.4H3.6V14\"/><path d=\"M3.6 20.4 10.4 13.6\"/>",
  // 上箭头：生成按钮那颗。以前是 arrowUpBold——一整块实心箭头，是全套图标里唯一一颗
  // 大面积实心的，跟旁边一圈 1.75 描边并排就是「粗一号」那颗；而且 fill 不吃
  // --oi-stroke 的光学补偿，17px 下没法跟着尺寸调粗细，只能一直那么重。
  // 现在和别的图标同一套：描边、圆头、无属性继承根 <svg>。
  "arrowUp": "<path d=\"M12 20.4V3.6\"/><path d=\"M4.8 10.8 12 3.6l7.2 7.2\"/>",
  "close": "<path d=\"M6.6 6.6 17.4 17.4\"/><path d=\"M17.4 6.6 6.6 17.4\"/>",
  "zoom": "<circle cx=\"10.6\" cy=\"10.6\" r=\"6.3\"/><path d=\"M15.4 15.4 20.4 20.4\"/><path d=\"M10.6 7.9v5.4\"/><path d=\"M7.9 10.6h5.4\"/>",
  "search": "<circle cx=\"10.6\" cy=\"10.6\" r=\"6.4\"/><path d=\"M15.5 15.5 20.4 20.4\"/>",

  /* ---------- 能力 / 风格 ---------- */
  "magic": "<path d=\"M4.4 19.6 12.4 11.6\"/><path d=\"M17.8 3.6l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z\" fill=\"currentColor\" stroke=\"none\"/>",
  "palette": "<path d=\"M12 20.4a8.4 8.4 0 1 1 0-16.8c4.64 0 8.4 3.2 8.4 7.2 0 2.3-1.9 3.9-4.2 3.9h-1.5a1.85 1.85 0 0 0-1.4 3.1 1.65 1.65 0 0 1-1.3 2.6z\"/><circle cx=\"8.5\" cy=\"8.1\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"12.7\" cy=\"6.8\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"6.9\" cy=\"12.5\" r=\"1.2\" fill=\"currentColor\" stroke=\"none\"/>",
  "video": "<rect x=\"3.6\" y=\"6.6\" width=\"13\" height=\"10.8\" rx=\"2.4\"/><path d=\"M16.6 11.2 20.4 8.6v6.8l-3.8-2.6\"/>",
  "music": "<path d=\"M9.4 6.6 19 4.7v10.7\"/><path d=\"M9.4 6.6v10.8\"/><circle cx=\"7\" cy=\"17.6\" r=\"2.4\"/><circle cx=\"16.6\" cy=\"15.6\" r=\"2.4\"/>",
  "script": "<path d=\"M6.4 3.6h7.2l4.4 4.4v11.4a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2V5.6a2 2 0 0 1 2-2z\"/><path d=\"M13.4 3.6v4.4h4.6\"/><path d=\"M7.9 12.6h8.2\"/><path d=\"M7.9 16.2h5.6\"/>",
  "clip": "<circle cx=\"6.2\" cy=\"6.6\" r=\"2.5\"/><circle cx=\"6.2\" cy=\"17.4\" r=\"2.5\"/><path d=\"M8.3 8.2 19.4 18.6\"/><path d=\"M8.3 15.8 19.4 5.4\"/>",

  /* ---------- 通用动作 ---------- */
  "check": "<path d=\"M4.9 12.4 9.7 17.2 19.3 6.8\"/>",
  "pointer": "<path d=\"M5.6 3.4 19.2 11.4l-5.7 1.3-2.2 5.9z\"/>",
  "crop": "<path d=\"M7 3.2v13.4a1.3 1.3 0 0 0 1.3 1.3h13.5\"/><path d=\"M3.2 7h13.4a1.3 1.3 0 0 1 1.3 1.3v13.5\"/>",
  "rotate": "<path d=\"M20.5 3.6v5.4h-5.4\"/><path d=\"M18.8 14.2a7.4 7.4 0 1 1-1.9-7.6l3.6 2.4\"/>",
  // 标注那颗：准星（外圈 + 实心圆心）。不用图钉——图钉在 17px 下尾巴会糊成一根刺，
  // 准星一眼就是「点这里」，而且和箭头（指方向）不会看混。
  "mark": "<circle cx=\"12\" cy=\"12\" r=\"7.4\"/><circle cx=\"12\" cy=\"12\" r=\"2.4\" fill=\"currentColor\" stroke=\"none\"/>",
  // 箭头那颗：左下到右上的斜线 + 右上角两条边当箭头。斜着画才和「标注 / 画笔」的斜向一致，
  // 正上正下的 arrowUp 是生成键那颗，两个方向不能撞。
  "arrow": "<path d=\"M5.2 18.8 18.4 5.6\"/><path d=\"M10.6 5.4h8.2v8.2\"/>",
  "brush": "<path d=\"M9.5 14.5 20.4 3.6\"/><path d=\"M9.5 14.5 7 17l-.6 3.1 3.1-.6 2.5-2.5z\"/>",
  "eraser": "<path d=\"M18.6 9.4 14.2 5 5.4 13.8 9.8 18.2z\"/><path d=\"M16.4 7.2 7.6 16\"/><path d=\"M4.5 20.4h15\"/>",
  "download": "<path d=\"M12 3.7v9.9\"/><path d=\"M7.7 9.4 12 13.6l4.3-4.2\"/><path d=\"M4.4 14.7v3.4a1.9 1.9 0 0 0 1.9 1.9h11.4a1.9 1.9 0 0 0 1.9-1.9v-3.4\"/>",

  /* ---------- 对齐 / 分布 ---------- */
  "alignLeft": "<path d=\"M3.9 3.6v16.8\"/><path d=\"M7.6 8.4h12.5\"/><path d=\"M7.6 15.6h7.8\"/>",
  "alignHCenter": "<path d=\"M12 3.6v16.8\"/><path d=\"M4.4 8.4h15.2\"/><path d=\"M7 15.6h10\"/>",
  "alignRight": "<path d=\"M20.1 3.6v16.8\"/><path d=\"M16.4 8.4H3.9\"/><path d=\"M16.4 15.6H8.6\"/>",
  "alignTop": "<path d=\"M3.6 3.9h16.8\"/><path d=\"M8.4 7.6v12.5\"/><path d=\"M15.6 7.6v7.8\"/>",
  "alignVCenter": "<path d=\"M3.6 12h16.8\"/><path d=\"M8.4 4.4v15.2\"/><path d=\"M15.6 7v10\"/>",
  "alignBottom": "<path d=\"M3.6 20.1h16.8\"/><path d=\"M8.4 16.4V3.9\"/><path d=\"M15.6 16.4V8.6\"/>",
  "distH": "<path d=\"M3.6 4.6v14.8\"/><path d=\"M20.4 4.6v14.8\"/><path d=\"M7.6 12h8.8\"/><path d=\"M9.8 9.8 7.6 12l2.2 2.2\"/><path d=\"M14.2 9.8 16.4 12l-2.2 2.2\"/>",
  "distV": "<path d=\"M4.6 3.6h14.8\"/><path d=\"M4.6 20.4h14.8\"/><path d=\"M12 7.6v8.8\"/><path d=\"M9.8 9.8 12 7.6l2.2 2.2\"/><path d=\"M9.8 14.2 12 16.4l2.2-2.2\"/>"
};
  function icon(name, cls) {
    var d = P[name];
    if (!d) return '';
    return '<svg class="oi' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none"' +
      ' stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true">' + d + '</svg>';
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
