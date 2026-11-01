/* InfiSheet · 无限画布 · 前端
   节点模型：text（提示词）/ image（图片）/ wf（工作流）
   连线只允许 text→文本插槽、image→图片插槽 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const world = $('#world');
  const nodesEl = $('#nodes');
  const linksEl = $('#links');
  const STORE_KEY = 'infisheet-v2';

  const state = {
    nodes: [],
    links: [],
    view: { x: 80, y: 60, k: 0.85 },
    seq: 1,
    selected: new Set(),
    linkSel: null,
    projectId: null,
    rev: 0,            // 服务端给的存档版本号：保存时回传，落后就说明有人（MCP）改过
    groups: [],
    workflows: { presets: [], items: [], categories: [] },   // boot 时从 /api/library 拉取
    name: '未命名画布',
    snap: false,
    linksHidden: false,
    minimapOn: false,
    dockSide: 'bottom',    // 底部工具条停在哪：bottom / left / right / top
    panMode: false,
    bootAt: Date.now(),
    jobs: [],      // 生成队列（运行态，不进存档也不进撤销栈），见「生成队列」一节
    mcpSeen: false,    // 「MCP 已连接」这盏灯是不是已经提示过（同一次会话只弹一次）
    hydrated: false,   // 启动恢复完成前，禁止把状态回写（避免空画布覆盖已存内容）
  };

  let drag = null;      // {mode:'pan'|'node'|'link', ...}
  let saveTimer = null;
  let linkTemp = null;

  /* ---------------- 撤销 / 重做（快照式） ---------------- */
  // 名字不能叫 history：模块作用域里会遮住 window.history，路由改写 hash 时会炸
  const undoStack = { stack: [], idx: -1, limit: 40, applying: false };

  function snapshotState() {
    const data = serialize();
    // 视图/显示偏好不进历史：撤销不该把你甩回上一个缩放位置
    delete data.view;
    delete data.snap;
    delete data.linksHidden;
    delete data.minimapOn;
    return JSON.stringify(data);
  }

  function commit() {
    if (undoStack.applying) return;
    const snap = snapshotState();
    if (undoStack.stack[undoStack.idx] === snap) return;
    undoStack.stack.length = undoStack.idx + 1;   // 撤销后再操作，丢掉重做分支
    undoStack.stack.push(snap);
    if (undoStack.stack.length > undoStack.limit) undoStack.stack.shift();
    undoStack.idx = undoStack.stack.length - 1;
  }

  function seedHistory() {
    undoStack.stack = [snapshotState()];
    undoStack.idx = 0;
  }

  function applySnapshot(snap) {
    undoStack.applying = true;
    try { load(JSON.parse(snap)); } finally { undoStack.applying = false; }
    queueSave();
  }

  function undo() {
    if (undoStack.idx <= 0) { flash('没有可撤销的操作'); return; }
    undoStack.idx -= 1;
    applySnapshot(undoStack.stack[undoStack.idx]);
    flash(`已撤销（还可退 ${undoStack.idx} 步）`);
  }

  function redo() {
    if (undoStack.idx >= undoStack.stack.length - 1) { flash('没有可重做的操作'); return; }
    undoStack.idx += 1;
    applySnapshot(undoStack.stack[undoStack.idx]);
    flash(`已重做（还可进 ${undoStack.stack.length - 1 - undoStack.idx} 步）`);
  }

  /* ---------------- 复制 / 粘贴节点 ---------------- */
  let clipboard = null;
  let pointerWorld = null;
  // 扩图会话（框 + 参数条 + 重贴面板的钩子）。放在这里是为了让 applyView 能直接用：
  // 面板虽然跟着节点走（世界坐标），但「别顶出屏幕」这件事是屏幕坐标的，平移缩放之后得重算。
  let opSession = null;

  function cloneNode(src, id) {
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = id;
    copy.status = 'idle';
    copy.statusText = '';
    copy.pid = null;
    copy.timer = null;       // 运行态不复制，避免两个节点轮询同一个任务
    copy.progress = null;
    if (copy.gen) { copy.gen.busy = false; copy.gen.pid = null; }
    return copy;
  }

  // 新节点的 id 前缀按类型走，方便在小地图/调试里一眼看出这是哪类节点
  function nextNodeId(type) {
    const p = type === 'text' ? 't' : type === 'image' ? 'i' : type === 'wf' ? 'w' : type === 'out' ? 'o' : 'n';
    return uid(p);
  }

  /**
   * 把 ids 里的节点就地复制一份（可带位移），**组内的连线一起复制**，指到组外的连线不复制。
   * 返回副本数组；默认把选中切换成副本。
   * 与 pasteClipboard 的区别：这个吃的是画布上活着的节点，粘贴吃的是剪贴板快照。
   */
  function duplicateNodes(ids, { dx = 0, dy = 0, select = true } = {}) {
    const src = state.nodes.filter((n) => ids.has(n.id));
    if (!src.length) return [];
    const map = new Map();
    src.forEach((n) => {
      const copy = cloneNode(n, nextNodeId(n.type));
      copy.x = Math.round(n.x + dx);
      copy.y = Math.round(n.y + dy);
      map.set(n.id, copy);
      state.nodes.push(copy);
    });
    state.links
      .filter((l) => ids.has(l.from) && ids.has(l.to))
      .forEach((l) => state.links.push({ id: uid('l'), from: map.get(l.from).id, to: map.get(l.to).id, toKey: l.toKey }));
    const copies = [...map.values()];
    if (select) state.selected = new Set(copies.map((c) => c.id));
    return copies;
  }

  function copySelection() {
    const ids = new Set(state.selected);
    if (!ids.size) { flash('先选中要复制的节点'); return false; }
    clipboard = {
      nodes: state.nodes.filter((n) => ids.has(n.id)).map((n) => JSON.parse(JSON.stringify(n))),
      links: state.links.filter((l) => ids.has(l.from) && ids.has(l.to)).map((l) => ({ ...l })),
    };
    flash(`已复制 ${clipboard.nodes.length} 个节点`);
    return true;
  }

  function pasteClipboard(mode) {
    if (!clipboard || !clipboard.nodes.length) { flash('剪贴板是空的'); return; }
    const minX = Math.min(...clipboard.nodes.map((n) => n.x));
    const minY = Math.min(...clipboard.nodes.map((n) => n.y));
    let ox = minX + 40, oy = minY + 40;
    if (mode !== 'duplicate' && pointerWorld) { ox = Math.round(pointerWorld.x); oy = Math.round(pointerWorld.y); }
    const map = new Map();
    clipboard.nodes.forEach((src) => {
      const id = nextNodeId(src.type);
      map.set(src.id, id);
      const copy = cloneNode(src, id);
      copy.x = Math.round(src.x - minX + ox);
      copy.y = Math.round(src.y - minY + oy);
      state.nodes.push(copy);
    });
    clipboard.links.forEach((l) => {
      if (!map.has(l.from) || !map.has(l.to)) return;
      state.links.push({ id: uid('l'), from: map.get(l.from), to: map.get(l.to), toKey: l.toKey });
    });
    state.selected = new Set(map.values());
    renderAll(); paintSelection(); queueSave(); commit();
    flash(`已粘贴 ${map.size} 个节点`);
  }

  function duplicateSelection() {
    if (!copySelection()) return;
    pasteClipboard('duplicate');
  }

  // 「这一轮是不是还在跑」——遮罩/进度条的显隐只认它。
  // busy 之外还留一个 finishing：完成的那一刻 busy 已经落了，但 100% 要在图上停 700ms 再走。
  function overlayVisible(n) {
    const g = n.gen || {};
    return !!g.busy || !!g.finishing;
  }

  function paintProgress(n, pct) {
    const shown = overlayVisible(n);
    // 工作流节点顶部那条进度条（图片节点没有，见 buildNode）
    const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .node-progress`);
    if (el) {
      const bar = el.querySelector('i');
      el.classList.toggle('on', shown);
      if (!shown) {
        el.classList.remove('indet');
        bar.style.width = '0%';
      } else if (pct == null) {
        el.classList.add('indet');
      } else {
        el.classList.remove('indet');
        bar.style.width = `${Math.max(2, pct)}%`;
      }
    }
    // 图片中央的「生成中 42%」跟着进度走
    const ov = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .gen-overlay`);
    if (ov) {
      ov.classList.toggle('hidden', !shown);
      if (shown) {
        const label = ov.querySelector('.gen-overlay-text');
        if (label) label.textContent = genOverlayText(n, pct);
      }
    }
  }

  // 运行中：**只有数字才作数**。null / undefined 表示「这一拍没拿到新数字」——
  // 服务端可能只是暂时没有步数可报（排队中、ws 还没到第一个采样器、history 先落库但
  // 还没 completed）。上一次的 12% 仍然有效，擦了的话画面就会变成
  // 「生成中 12% → 生成中… → 生成中 30%」，用户看到的就是「百分比有几率消失」。
  function setProgress(n, pct) {
    if (typeof pct === 'number') n.progress = pct;
    paintProgress(n, n.progress);
  }

  // 新一轮开始才清零：这是唯一该把数字扔掉的时候
  function resetProgress(n) {
    n.progress = null;
    if (n.gen) n.gen.finishing = false;
    paintProgress(n, null);
  }

  function finishProgress(n) {
    n.progress = 100;
    if (n.gen) n.gen.finishing = true;      // busy 已经落了，靠它把 100% 再撑 700ms
    paintProgress(n, 100);
    setTimeout(() => {
      if (n.gen) n.gen.finishing = false;
      n.progress = null;
      paintProgress(n, null);
    }, 700);
  }

  function clearProgress(n) {
    n.progress = null;
    if (n.gen) n.gen.finishing = false;
    // 以前这里只重置顶部那条 bar：图片节点没有 bar，等于什么都没做，遮罩会留在图上
    paintProgress(n, null);
  }

  /* ---------------- 工具 ---------------- */
  const uid = (p) => `${p}${state.seq++}`;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  // 画布缩放范围：15% ~ 800%（800% 用来抠像素级对齐、看 1px 的边）
  const ZOOM_MIN = 0.15;
  const ZOOM_MAX = 8;
  const getNode = (id) => state.nodes.find((n) => n.id === id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 焦点在输入控件 / 富文本里时，全局快捷键（Delete、空格平移、F 适配…）都要放行
  const FIELD_SEL = 'input, textarea, select, [contenteditable="true"]';
  const isFieldTarget = (t) => !!(t && typeof t.matches === 'function' && t.matches(FIELD_SEL));

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text.slice(0, 300) }; }
    if (!res.ok && data && !data.error) data.error = `HTTP ${res.status}`;
    return data;
  }
  const postJson = (path, body) => api(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  /* ---------------- 视图 ---------------- */
  function applyView() {
    const { x, y, k } = state.view;
    const zb = document.getElementById('zoomBtn');
    if (zb) zb.textContent = `${Math.round(k * 100)}%`;
    scheduleMinimap();
    world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    // 生成器面板不吃画布的缩放：把 1/k 递给 CSS，面板自己反着缩回去，形状/字号恒定。
    // 和 positionAlignBar / positionLinkDel 是同一个路数——屏幕坐标的东西就归屏幕管。
    world.style.setProperty('--gp-k', String(1 / (k || 1)));
    positionAlignBar();                    // 工具条是屏幕坐标，视图一动就得重新贴回选区
    positionLinkDel();                     // 连线的删除键同理：世界一动，屏幕坐标就得跟着重算
    positionImgTools();                    // 图片工具条挂在节点上方，平移/缩放同样要跟着走
    // 扩图时面板贴在画布外框上：外框是世界坐标，但「别顶出屏幕」是屏幕坐标，视图一动就得重算
    if (opSession && opSession.place) opSession.place();
    // 点阵跟着缩放，但两头都要收：15% 时 4px 一格会糊成一片、800% 时 224px 一格又稀得像噪点
    const cell = clamp(28 * k, 16, 112);
    stage.style.backgroundSize = `${cell}px ${cell}px`;
    stage.style.backgroundPosition = `${x}px ${y}px`;
  }

  function screenToWorld(sx, sy, rect) {
    const r = rect || stage.getBoundingClientRect();
    return {
      x: (sx - r.left - state.view.x) / state.view.k,
      y: (sy - r.top - state.view.y) / state.view.k,
    };
  }

  function centerOfView() {
    const r = stage.getBoundingClientRect();
    return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    nodesEl.innerHTML = '';
    state.nodes.forEach((n) => nodesEl.appendChild(buildNode(n)));
    reindexAllPorts();
    renderLinks();
    renderGroups();
    updateCanvasEmpty();
    paintSelection();      // 节点是重建的，选中态得重新盖回去（否则对齐/批量操作后高亮凭空消失）
    scheduleMinimap();
  }

  function nodeWidth(n) {
    if (n && n.w) return n.w;
    if (n && n.type === 'wf') return 360;
    if (n && n.type === 'image') return 380;
    if (n && n.type === 'out') return 300;
    return 280;
  }

  // 图标统一走 IconPark（static/icons.js 里的 icon()）
  const NODE_ICON = {
    text: icon('text'),
    image: icon('image'),
    wf: icon('wf'),
    out: icon('out'),
  };

  function buildNode(n) {
    const el = document.createElement('div');
    el.className = `node ${n.type}`;
    el.dataset.id = n.id;
    el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    // 扩图边框的拖动监听挂在 window 上：节点一重建就得把旧的摘掉，
    // 否则旧监听还在改同一个节点的 pad，拖一下动两倍
    closeOpSession(n.id);
    const linkedInputs = new Set(state.links.filter((l) => l.to === n.id).map((l) => l.toKey));
    const inCount = state.links.filter((l) => l.to === n.id && l.toKey === 'in').length;
    const inPortTitle = inCount > 1 ? `已连 ${inCount} 张 · 点击断开全部` : '点击断开连线';
    const hasOutLink = state.links.some((l) => l.from === n.id);
    const outPortOf = (id) => {
      const p = makePort(id, 'out');
      if (hasOutLink) p.classList.add('linked');
      return p;
    };

    // 标题在卡片外面（无背景），对齐参考图
    const title = document.createElement('div');
    title.className = 'node-title';
    title.innerHTML = `<span class="n-icon">${NODE_ICON[n.type] || ''}</span><span class="n-name">${esc(n.title)}</span>`;
    // 图片节点：像素尺寸和名字放同一行（以前它浮在图片右上角，正好压在画面内容上）
    let dimEl = null;
    if (n.type === 'image') {
      dimEl = document.createElement('span');
      dimEl.className = 'n-dim';
      title.appendChild(dimEl);
      // 纯图片节点：只放图，不摆生成面板（加载图片进来的就是这种）。想要生成时点这颗药丸。
      if (n.plain) {
        const gb = document.createElement('button');
        gb.type = 'button';
        gb.className = 'n-genon';
        gb.title = '这个节点只放图。点一下给它加上生成面板（拿它当参考图去生成）';
        gb.textContent = '生成';
        gb.onclick = (ev) => {
          ev.stopPropagation();
          delete n.plain;
          selectOnly(n.id);
          rerenderNode(n.id);
          queueSave();
          commit();
          flash('已打开生成面板');
        };
        title.appendChild(gb);
      }
      // 这张图有遮罩就挂一颗药丸：不点开也能知道「它带着一块要重绘的区域」。
      // 遮罩按图片身份存，切 gallery 换一张时药丸跟着变（没涂过的那张不显示）。
      const mdoc = maskDocOf(n);
      if (mdoc && mdoc.strokes && mdoc.strokes.length) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'n-mask';
        pill.textContent = `遮罩 ${mdoc.cover == null ? maskCover(mdoc) : mdoc.cover}%`;
        pill.title = '点一下继续涂这块遮罩';
        // pointerdown 必须拦：它先于 click 冒泡到 #stage，画布会当场开始拖节点，
        // rerenderNode 把药丸这个 DOM 换掉之后 click 就再也不会触发了（菜单那节踩过同一个坑）
        pill.onpointerdown = (ev) => ev.stopPropagation();
        pill.onclick = (ev) => { ev.stopPropagation(); openMaskEditor(n); };
        title.appendChild(pill);
      }
    }
    if (n.type === 'wf') {
      const runBtn = document.createElement('button');
      runBtn.className = 'n-run primary';
      runBtn.textContent = '运行';
      runBtn.onclick = (ev) => { ev.stopPropagation(); runWorkflow(n); };
      title.appendChild(runBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'n-del';
    delBtn.textContent = '✕';
    delBtn.title = '删除节点';
    delBtn.onclick = (ev) => { ev.stopPropagation(); removeNode(n.id); };
    title.appendChild(delBtn);
    el.appendChild(title);

    const card = document.createElement('div');
    card.className = 'node-card';
    const body = document.createElement('div');
    body.className = 'node-body';
    card.appendChild(body);
    if (n.w) el.style.width = `${n.w}px`;

    // 图片节点不再支持拖拽缩放：尺寸固定，避免缩放手柄和连线/面板抢事件
    if (n.type !== 'image') {
      const handle = document.createElement('div');
      handle.className = 'node-resize';
      handle.title = '拖动调整大小';
      handle.onpointerdown = (ev) => { ev.preventDefault(); ev.stopPropagation(); startResize(ev, n); };
      card.appendChild(handle);
    }
    // 顶部进度条：生成/运行时显示百分比。
    // 只有**工作流节点**需要它：那是它运行时唯一的反馈（没有中央遮罩可用）。
    // 图片节点不要——卡片顶就是画面顶，怎么摆都会压着图片，而画面中央那块「生成中 42%」
    // 已经把同样的信息盖在图上了；文本节点更用不上（它不会跑）。用户要求直接去掉。
    if (n.type === 'wf') {
      const prog = document.createElement('div');
      prog.className = 'node-progress';
      prog.innerHTML = '<i></i>';
      card.appendChild(prog);
    }
    el.appendChild(card);

    if (n.type === 'text') {
      const ta = document.createElement('textarea');
      ta.value = n.value || '';
      ta.placeholder = '写提示词…';
      const autoGrow = () => {
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(420, Math.max(88, ta.scrollHeight + 2))}px`;
      };
      ta.oninput = () => {
        n.value = ta.value;
        autoGrow();
        scheduleLayout();          // 打字时每帧重排一次连线，别每个字符都全量测一遍
        queueSave();
      };
      body.appendChild(ta);
      requestAnimationFrame(() => { autoGrow(); scheduleLayout(); });
      // 文本节点也能接一张图：作为参考图，随提示词一起送进下游图片节点
      const textIn = makeTypedPort(n, 'in', 'any', linkedInputs.has('in'), '接图片（参考图，随提示词一起送入；可连多张）', inPortTitle);
      textIn.onpointerdown = (ev) => { ev.stopPropagation(); startPortDrag(ev, n.id, 'in'); };
      card.appendChild(textIn);
      const textOut = outPortOf(n.id);
      textOut.dataset.kind = 'text';
      card.appendChild(textOut);
    } else if (n.type === 'image') {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (n.dataURL) {
        thumb.innerHTML = `<img src="${n.dataURL}" alt="" draggable="false" />`;
        // 阻止浏览器把图片当原生拖拽对象：否则按住图拖出的是 ghost，而不是移动节点
        thumb.addEventListener('dragstart', (ev) => ev.preventDefault());
        // 单击不再弹大图；悬停出现「查看大图」，双击图片也进大图（自适应窗口）
        const zoom = document.createElement('button');
        zoom.className = 'img-zoom';
        zoom.title = '查看大图（双击图片也可以）';
        zoom.innerHTML = icon('zoom');
        zoom.onclick = (ev) => {
          ev.stopPropagation();
          openLightbox(n.dataURL, (n.gen && n.gen.gallery) || null, (n.gen && n.gen.idx) || 0, nodeImageInfo(n));
        };
        thumb.appendChild(zoom);
        // 遮罩预览：涂过哪块直接画在图上，不点开编辑器也看得见。
        // 框的比例就是图片比例、图片又铺满框，所以 canvas 直接 100%×100% 就对齐，
        // 不需要再算 offset（上一版挂在节点缩略图上错位，就是因为中间多了几层换算）。
        const md = maskDocOf(n);
        let maskOv = null;
        if (md && md.strokes && md.strokes.length) {
          maskOv = document.createElement('canvas');
          maskOv.className = 'mask-ov';
          maskOv.width = md.w;
          maskOv.height = md.h;
          maskOv.title = `遮罩 ${md.cover == null ? maskCover(md) : md.cover}% · 点标题上的药丸继续涂`;
          paintStrokes(maskOv.getContext('2d'), md, false);
          thumb.appendChild(maskOv);
        }
        thumb.ondblclick = (ev) => {
          ev.stopPropagation();
          openLightbox(n.dataURL, (n.gen && n.gen.gallery) || null, (n.gen && n.gen.idx) || 0, nodeImageInfo(n));
        };
        const im = thumb.querySelector('img');
        // 框跟着图片的真实比例走。以前是「按 clientWidth 算一个 px 高度写上去」，而 CSS 里还留着
        // min-height:200 兜底 —— 2:1 的图算出来 190px，被 min-height 顶到 200，object-fit:contain
        // 就在上下各补一条黑边（用户红框圈出来的就是这两条）。现在不写高度了：img 用 height:auto，
        // 框天然等于图片高度，多一条边都没有。只有极端的竖长图会被 max-height 截住。
        const fit = () => {
          thumb.classList.remove('is-empty');
          // 扩图模式：--ar 和尺寸标签都归边框管（它按「扩完之后」的画布算），
          // 这里再按原图写一次就会把框拉回去
          if (!outpaintOn(n)) {
            if (im.naturalWidth) dimEl && (dimEl.textContent = `${im.naturalWidth} × ${im.naturalHeight}`);
            // 把比例交给框：框用 aspect-ratio 自己算出高，图片就成了「刚好装下」，
            // object-fit 没空间可补 —— 横图不上下留边、竖图不左右留边。
            if (im.naturalWidth && im.naturalHeight) {
              thumb.style.setProperty('--ar', (im.naturalWidth / im.naturalHeight).toFixed(4));
            }
          }
          // 遮罩和图片尺寸对不上（这张图被换过内容）就不画预览：拉伸的预览比没有更误导，
          // 编辑器打开时会把对不上的笔画丢掉，重涂一次就恢复正常。
          if (maskOv && im.naturalWidth &&
              (maskOv.width !== im.naturalWidth || maskOv.height !== im.naturalHeight)) maskOv.remove();
          scheduleLayout();
        };
        if (im.complete && im.naturalWidth) requestAnimationFrame(fit);
        im.addEventListener('load', fit);
      } else {
        thumb.classList.add('is-empty');
        thumb.innerHTML = `
          <div class="thumb-empty">
            <span class="ph-big">${NODE_ICON.image}</span>
            <div class="try">
              <div class="try-label">尝试：</div>
              <button class="try-item" data-try="upload">
                ${icon('upload')}
                <span>上传图片</span>
              </button>
              ${n.plain ? '' : `<button class="try-item" data-try="generate">
                ${icon('magic')}
                <span>文本生图</span>
              </button>`}
            </div>
          </div>`;
        thumb.querySelector('[data-try="upload"]').onclick = (ev) => { ev.stopPropagation(); pickImage(n); };
        const tryGen = thumb.querySelector('[data-try="generate"]');
        if (tryGen) tryGen.onclick = (ev) => {
          ev.stopPropagation();
          const panel = card.parentElement.querySelector('.gen-prompt');
          if (panel) panel.focus();
        };
      }
      // 图片上的生成中遮罩：显示「生成中 42%」，进度由 websocket 的百分比驱动
      const overlay = document.createElement('div');
      overlay.className = 'gen-overlay hidden';
      overlay.innerHTML = '<span class="gen-overlay-text">生成中…</span>';
      // 重画节点（改尺寸、换图、撤销、切张数…）每次都会新建这层遮罩，默认是「隐藏 + 生成中…」。
      // 不在这儿按当前状态补一次的话，生成到一半碰一下任何会让节点重画的按钮，图上那个
      // 42% 就没了（要等下一拍轮询才回来）——这也是「百分比会消失」的一个来源。
      if (overlayVisible(n)) {
        overlay.classList.remove('hidden');
        overlay.querySelector('.gen-overlay-text').textContent = genOverlayText(n);
      }
      thumb.appendChild(overlay);
      body.appendChild(thumb);
      // 扩图模式的边框在下面「挂生成面板」那一步一起建：参数条要并进面板，
      // 得等面板先存在（见 buildOutpaintFrame 的第三个参数）。

      // 多图切换：以前只有 7px 小圆点，用户根本发现不了「还有 3 张」——
      // 「生成多张只显示一张，其余无法显示」就是这么来的。现在给三件套：
      // 左下角计数（1 / 4）、悬停浮出的左右箭头、下面一排圆点；选中节点时 ←/→ 也能翻。
      const gal = n.gen && n.gen.gallery;
      if (gal && gal.length > 1) {
        const count = document.createElement('span');
        count.className = 'img-count';
        count.textContent = `${(n.gen.idx || 0) + 1} / ${gal.length}`;
        count.title = '这是第几张（共 ' + gal.length + ' 张）· ←/→ 翻页';
        thumb.appendChild(count);
        const nav = document.createElement('div');
        nav.className = 'img-nav';
        [['prev', -1, '‹', '上一张（←）'], ['next', 1, '›', '下一张（→）']].forEach(([cls, d, ch, tip]) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `nav-btn ${cls}`;
          b.textContent = ch;
          b.title = tip;
          b.onclick = (ev) => { ev.stopPropagation(); stepGallery(n, d); };
          nav.appendChild(b);
        });
        thumb.appendChild(nav);
        const dots = document.createElement('div');
        dots.className = 'dots';
        gal.forEach((item, i) => {
          const d = document.createElement('button');
          d.className = `dot-i${i === (n.gen.idx || 0) ? ' on' : ''}`;
          d.title = `${i + 1}/${gal.length} · ${item.filename}`;
          d.onclick = (ev) => { ev.stopPropagation(); setGallery(n, i); };
          dots.appendChild(d);
        });
        body.appendChild(dots);
      }
      // 生成历史入口：只在这个节点真生成过时出现，空节点上不摆没用的按钮。
      // 位置和左下角的「1 / 4」对称——左下管「这一批里的第几张」，右下管「第几次生成」。
      const runs = runsOf(n);
      if (runs.length) {
        const hist = document.createElement('button');
        hist.type = 'button';
        hist.className = 'img-hist';
        hist.textContent = `${runs.length} 次`;
        hist.title = '生成历史：看回任意一次，或从那次派生';
        hist.onclick = (ev) => { ev.stopPropagation(); openRunList(hist, n); };
        thumb.appendChild(hist);
      }
      // 挂在 .node 上而不是 .node-card：标题行在卡片外面（在 flow 里占高度），
      // 挂卡片上的话「面板放上方」会压住标题——bottom:100% 相对整个节点才对。
      // 纯图片节点（n.plain）不挂：它就是一张图，下面不该拖着一个「提示词 + 工作流 + 生成」。
      if (!n.plain) {
        const panel = buildGenPanel(n);
        el.appendChild(panel);
        // 扩图模式：八个锚点长在图上，参数条**并进这个面板**。
        // 两样都在节点里，节点一平移/缩放它们就跟着走——早先是屏幕坐标的浮条，
        // 用户的原话是「无法跟随」：节点在右边、条却钉在屏幕左下角。
        if (outpaintOn(n)) buildOutpaintFrame(n, thumb, panel);
      }
      // 单口，但什么都能接：文本当提示词，图片当参考图（每侧仍然只有一个点）
      const imgIn = makeTypedPort(n, 'in', 'any', linkedInputs.has('in'), '接文本（提示词）或图片（参考图）；可以连多张图', inPortTitle);
      imgIn.onpointerdown = (ev) => { ev.stopPropagation(); startPortDrag(ev, n.id, 'in'); };
      card.appendChild(imgIn);
      const imgOut = outPortOf(n.id);
      imgOut.dataset.kind = 'image';
      card.appendChild(imgOut);
    } else if (n.type === 'wf') {
      body.appendChild(buildWfBody(n, linkedInputs));
      const wfIn = makeTypedPort(n, 'in', 'any', linkedInputs.size > 0, '拖动可反向接线；点一下打开设置');
      wfIn.onpointerdown = (ev) => startWfInputDrag(ev, n);
      card.appendChild(wfIn);
      const outPort = outPortOf(n.id);
      outPort.dataset.kind = 'media';
      outPort.title = '结果输出：连到「图片输出」节点';
      card.appendChild(outPort);
    } else if (n.type === 'out') {
      body.appendChild(buildOutBody(n));
      const inPort = document.createElement('div');
      inPort.className = 'port in';
      inPort.dataset.port = `${n.id}:in`;
      inPort.dataset.kind = 'media';
      inPort.title = linkedInputs.has('in') ? '拖动可重新接线 / 松手不断开则移除' : '接收工作流节点的结果输出';
      if (linkedInputs.has('in')) inPort.classList.add('linked');
      inPort.onpointerdown = (ev) => { ev.stopPropagation(); startPortDrag(ev, n.id, 'in'); };
      card.appendChild(inPort);
    }

    el.onpointerdown = (ev) => {
      if (state.panMode) return;
      if (ev.target.closest('button, input, textarea, select, .port, [contenteditable]')) return;
      if (ev.shiftKey) toggleSelect(n.id);
      else if (!state.selected.has(n.id)) selectOnly(n.id);
      const moving = state.selected.has(n.id) ? state.nodes.filter((x) => state.selected.has(x.id)) : [n];
      // Alt + 左键：拖副本（Shift 是加选，两者语义冲突，所以 Shift 在场时不认 Alt）
      if (ev.altKey && ev.button === 0 && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        startAltCopyDrag(ev, moving);
        return;
      }
      startNodeDrag(ev, moving);
    };
    return el;
  }


  // 右下角手柄：拖拽改节点大小（宽度通用；图片节点同时改高度）
  function startResize(ev, n) {
    const rect0 = stage.getBoundingClientRect();   // 手势内复用：pointermove 里读布局会强制重排
    const start = screenToWorld(ev.clientX, ev.clientY, rect0);
    const w0 = nodeWidth(n);
    const el0 = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`);
    if (!el0) return;
    const thumb0 = el0.querySelector('.thumb');
    const h0 = n.h || (thumb0 ? thumb0.clientHeight : 0);
    const minW = n.type === 'image' ? 260 : 200;
    el0.classList.add('resizing');
    document.body.classList.add('resizing');
    const move = (e) => {
      const p = screenToWorld(e.clientX, e.clientY, rect0);
      n.w = clamp(Math.round(w0 + (p.x - start.x)), minW, 760);
      if (thumb0 && h0) n.h = clamp(Math.round(h0 + (p.y - start.y)), 140, 900);
      applyNodeSize(n, el0);
      scheduleLayout();                            // 连线/分组/小地图每帧最多算一次
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el0.classList.remove('resizing');
      document.body.classList.remove('resizing');
      renderLinks(); renderGroups(); renderMinimap();   // 收手时精确对齐一次
      queueSave(); commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function applyNodeSize(n, el0) {
    const el = el0 || nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`);
    if (!el) return;
    if (n.w) el.style.width = `${n.w}px`;
    const thumb = el.querySelector('.thumb');
    if (thumb && n.h) thumb.style.height = `${n.h}px`;
  }

  function setLinkHint(on) {
    const b = document.getElementById('queueBadge');
    if (!b) return;
    if (on) {
      b.textContent = '拖到目标节点即可连线（圆点或卡片任意处） · 拖到空白处松手可新建节点';
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  }

  function makePort(nodeId, dir) {
    const p = document.createElement('div');
    p.className = `port ${dir}`;
    p.dataset.port = `${nodeId}:${dir}`;
    if (dir === 'out') {
      p.onpointerdown = (ev) => { ev.stopPropagation(); startLink(ev, nodeId); };
    }
    return p;
  }

  // 图片节点的输入口：类型写在 dataset.kind 上，已连线时点一下就断开
  function makeTypedPort(n, key, kind, linked, title, linkedTitle) {
    const p = document.createElement('div');
    p.className = `port in ${key}`;
    p.dataset.port = `${n.id}:${key}`;
    p.dataset.kind = kind;
    p.title = linked ? (linkedTitle || '点击断开连线') : title;
    if (linked) {
      p.classList.add('linked');
      p.onclick = (ev) => { ev.stopPropagation(); removeLink(n.id, key); };
    }
    return p;
  }

  // ---------- 图片节点的生成器面板（选中节点后浮在下方）----------
  // 画幅按「横 / 方 / 竖」混排：写「3:2」总比在文本框里敲数字快，而且能一眼比出胖瘦。
  // 顺序照参考图摆（1:1 打头，横竖成对），弹层里就是 5 列 × 3 行的网格。
  const ASPECTS = ['1:1', '1:2', '2:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21'];
  // 清晰度按「长边像素」算：1K=1024 / 2K=2048 / 4K=4096，和相机、显示器说 4K 的口径一致。
  // 旧档位（preview/standard/hd，按短边算）在 OLD_SIZE 里迁过来，见 buildGenPanel。
  const SIZES = [['1k', '1K', 1024], ['2k', '2K', 2048], ['4k', '4K', 4096]];
  const OLD_SIZE = { preview: '1k', standard: '1k', hd: '2k' };   // 高清 2K：16:9 下 ~2MP，最接近原来那张图的大小

  // 生成器下拉只用内置预设：库工作流是「我的存档」，容易和模板混在一起
  // takes_image 由服务端扫图得出（server.py: graph_takes）：
  // 挑工作流必须看能力，不能看名字里的「图像编辑」——Moss_图像编辑 其实是纯文生图。
  // 分类由服务端扫图给出（server.py: graph_category）：文生图 / 图生图 / 高清 / 视频 / 音频。
  // 前端所有「该用哪个工作流」的判断都只认这个，不再按名字猜。
  const CAT_ORDER = ['txt2img', 'img2img', 'upscale', 'video', 'audio', 'other'];
  const CAT_LABEL = {
    txt2img: '文生图', img2img: '图生图 / 编辑', upscale: '高清放大',
    video: '视频', audio: '音频', other: '其他',
  };

  // ---- 分类：用户自己的那一套 ----
  // CAT_ORDER / CAT_LABEL 是**能力**分类（服务端扫图推断，决定高清 / 扩图该挑谁），
  // 不能随手改；用户能在设置里改名 / 新增 / 删除的是上面那层**组织**分类，
  // 存在服务端 data/workflow_categories.json，跟着工作流一起跨设备。
  // 每个工作流的 `group` 指向某个分类 id；没设过就等于它的能力分类。
  function wfCategories() {
    const list = (state.workflows && state.workflows.categories) || [];
    return list.length ? list : CAT_ORDER.map((id) => ({ id, name: CAT_LABEL[id] }));
  }

  function catName(id) {
    const hit = wfCategories().find((c) => c.id === id);
    return hit ? hit.name : (CAT_LABEL[id] || id || '其他');
  }

  // 预设 + 工作流库**合成一份**：设置里的默认工作流、节点上的工作流选择器、
  // 自动挑工作流，看到的都该是同一个列表。以前只有预设能选，自己存进库的工作流
  // 就永远进不了这些下拉——用户的感受就是「工作流被固定死了」。
  function presetOptions() {
    const w = state.workflows || { presets: [], items: [] };
    const norm = (it, id, source) => ({
      id,
      label: it.title || it.name,
      image: !!it.takes_image,
      // 遮罩能力由服务端扫图给出，不看名字：
      // alphaMask = 有人在消费 LoadImage 的 MASK 输出（烘 alpha 路线，唯一主路径）
      alphaMask: !!it.takes_alpha_mask,
      category: it.category || 'other',
      group: it.group || it.category || 'other',
      catLabel: catName(it.group || it.category || 'other'),
      source,
      nodes: it.nodes || 0,
      // 删除时要用真实文件名（presets/ 下的 xxx.api.json）或库名，id 里带着前缀不能直接用。
      // 以前这里没给 file，deleteWfItem 拿到的永远是 undefined，删预设必然 400「预设名非法」。
      file: source === 'preset' ? it.file : it.name,
    });
    return (w.presets || []).map((p) => norm(p, `preset:${p.file}`, 'preset'))
      .concat((w.items || []).map((it) => norm(it, `lib:${it.name}`, 'lib')));
  }

  // 按用途挑工作流。need 可以是类别，也可以是按优先级排的数组。
  // 挑不到同类就退到第一个可用预设——宁可给个可能不对的，也别返回空让节点跑不起来。
  function pickWorkflow(need) {
    const list = presetOptions();
    const wants = Array.isArray(need) ? need : [need];
    let saved = '';
    try { saved = localStorage.getItem('infisheet-default-wf') || ''; } catch { /* 隐私模式 */ }
    // 靠遮罩驱动的（局部重绘）不进自动挑选：它的 mask 来自图片的 alpha 通道，
    // 一张普通参考图喂进去 alpha 全是不透明 → mask 全 0 → 什么都不重绘，出图跟原图逐位相同。
    // 只有用户在遮罩编辑器里明确要重绘时，才由 ensureMaskWorkflow 显式选它。
    const auto = list.filter((o) => !o.alphaMask);
    for (const want of wants) {
      // 设置里指定的「默认工作流」只要同类就优先用——否则那个设置就成了摆设
      const mine = saved ? list.find((o) => o.id === saved) : null;
      if (mine && mine.category === want) return saved;
      const hit = auto.find((o) => o.category === want);
      if (hit) return hit.id;
    }
    return (auto[0] || list[0] || {}).id || '';
  }
  function defaultWorkflowId() {
    const list = presetOptions();
    let saved = '';
    try { saved = localStorage.getItem('infisheet-default-wf') || ''; } catch { /* 隐私模式 */ }
    if (saved && list.some((o) => o.id === saved)) return saved;
    // 同上：兜底别落到局部重绘上，否则新建的图片节点一生成就是「原图原样回来」
    const auto = list.filter((o) => !o.alphaMask);
    return (auto[0] || list[0] || {}).id || '';
  }

  // 工作流库变了（新增/删除/导入）就重新拉一次：
  // 否则首页「快速开始」、生成器下拉、起始页五个入口都要刷新页面才更新
  async function refreshWorkflows() {
    try {
      const lib = await api('/api/library');
      state.workflows = {
        presets: lib.presets || [],
        items: lib.items || [],
        categories: lib.categories || [],
      };
    } catch { /* 拉不到就沿用旧值 */ }
    if (!state.nodes.length) renderCapRow();
    return state.workflows;
  }

  async function loadGraphById(id) {
    if (!id) return null;
    if (id.startsWith('preset:')) return (await api(`/presets/${encodeURIComponent(id.slice(7))}`)).graph;
    if (id.startsWith('lib:')) return (await api(`/api/library/${encodeURIComponent(id.slice(4))}`)).graph;
    return (await api(`/api/library/${encodeURIComponent(id.slice(4))}`)).graph;
  }

  // 分类表整体存回服务端：改名 / 新增 / 删除 / 排序都走这一条
  async function saveCategories(list) {
    const res = await api('/api/wf/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: list }),
    });
    if (!res.ok) { flash(res.error || '保存分类失败'); return false; }
    state.workflows.categories = res.categories || [];
    return true;
  }

  // 改一个工作流的标题 / 分类（id 形如 preset:xxx.json 或 lib:名字）
  async function saveWfMeta(id, patch) {
    const res = await api('/api/wf/meta', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    });
    if (!res.ok) { flash(res.error || '保存失败'); return false; }
    await refreshWorkflows();
    return true;
  }

  // 清晰度档只存一个「长边像素」，两处要用（算画布尺寸、弹层里的小字），别再各写一份字典
  function sizePx(size) {
    const hit = SIZES.find((s) => s[0] === size);
    return hit ? hit[2] : 1024;
  }

  function sizeLabel(size) {
    const hit = SIZES.find((s) => s[0] === size);
    return hit ? hit[1] : '1K';
  }

  // 比例小图标：把 a:b 缩进 maxW × maxH 的框里。胶囊里那一枚、弹层里每个卡片都用它，
  // 极端的比例（1:2 / 21:9）也不会缩成一条看不见的线。
  function ratioGlyph(aspect, maxW, maxH) {
    const [a, b] = String(aspect).split(':').map(Number);
    if (!a || !b) return [maxW, maxH];
    let w = maxW;
    let h = (maxW * b) / a;
    if (h > maxH) { h = maxH; w = (maxH * a) / b; }
    return [Math.max(3, Math.round(w)), Math.max(3, Math.round(h))];
  }

  // 长边定在清晰度档上，短边按比例缩：1:1 就是 1024²，16:9 的 2K 是 2048×1152。
  // 反过来（短边固定）在宽画幅下会把 4K 撑到 7280×4096，本地显存先炸。
  // 自定义尺寸直接用它给的宽高（对齐 16 的倍数——latent 是 8 倍下采样，再往上凑一档更稳）。
  // 下限给到 16 而不是 64：扩图烘出来的画布就是**像素真相**（32×32 的图标扩完还是三十几），
  // 面板要是把它抬到 64，图和「设置里写的尺寸」又对不上了——那正是这次要修的 bug。
  const DIM_MIN = 16;
  const DIM_MAX = 8192;

  function snapDim(v) {
    const n = Math.round(Number(v) / 16) * 16;
    return Math.min(DIM_MAX, Math.max(DIM_MIN, n || DIM_MIN));
  }

  function calcDims(aspect, size, custom) {
    if (size === 'custom' && custom && custom.w && custom.h) {
      return { width: snapDim(custom.w), height: snapDim(custom.h) };
    }
    const long = sizePx(size);
    const [a, b] = aspect.split(':').map(Number);
    const step = 16;
    const longSide = Math.round(long / step) * step;
    const shortSide = Math.round((long * Math.min(a, b)) / Math.max(a, b) / step) * step;
    return a >= b ? { width: longSide, height: shortSide } : { width: shortSide, height: longSide };
  }

  // 从自定义宽高反推最简比例，画幅网格才能跟着亮对那一格（1280×720 → 16:9）
  function aspectOf(w, h) {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const g = gcd(Math.round(w), Math.round(h)) || 1;
    return `${Math.round(w) / g}:${Math.round(h) / g}`;
  }

  // 自定义尺寸下点画幅：长边不动，另一条边按新比例重算（1280×720 点 9:16 → 720×1280）
  function fitCustom(aspect, c) {
    const [a, b] = aspect.split(':').map(Number);
    const longSide = snapDim(Math.max(c.w, c.h));
    const shortSide = snapDim((longSide * Math.min(a, b)) / Math.max(a, b));
    return a >= b ? { w: longSide, h: shortSide } : { w: shortSide, h: longSide };
  }

  // 工作流里"自带"的图片不能跟着跑：导出者本地的 023.jpg、他上次跑出来的 xxx_00483_.png，
  // 都留在 LoadImage 里。用户既看不见也改不了，生成时却实打实参与条件——「残留图干扰生成」。
  // 同时这里也是**绑参考图**的地方：图片插槽可能只有一个（普通 LoadImage），也可能是一组
  // （Qwen-Image-Edit 的 images.image_1..4，一个编码器吃多张）。画布上给了几张就按顺序填几张，
  // 这样提示词里的「图1 / 图2」和实际送进去的图才对得上；剩下的槽位从下游断开，
  // 画布一张没给就原样不动（必填组不能拆空，否则工作流直接报错）。
  function bindRefImages(g, slots, images) {
    const list = (Array.isArray(images) ? images : [images]).filter(Boolean);
    const imgSlots = (slots || []).filter((x) => x.kind === 'image');
    if (!imgSlots.length || !list.length) return { bound: [], pruned: [] };
    const setSlot = (key, value) => {
      const i = key.lastIndexOf('.');
      const nid = key.slice(0, i), input = key.slice(i + 1);
      if (g[nid] && g[nid].inputs) g[nid].inputs[input] = value;
    };
    const consumers = {};   // 源节点 id → [{ nid, name }]
    Object.entries(g).forEach(([nid, nd]) => {
      Object.entries((nd && nd.inputs) || {}).forEach(([name, v]) => {
        if (Array.isArray(v) && v.length === 2 && typeof v[1] === 'number') {
          (consumers[String(v[0])] = consumers[String(v[0])] || []).push({ nid, name });
        }
      });
    });
    const groups = new Map();   // "下游节点::输入前缀" → [{ slot, nid, name }]
    imgSlots.forEach((s) => {
      (consumers[String(s.node)] || []).forEach((c) => {
        const gk = `${c.nid}::${c.name.replace(/\d+$/, '')}`;   // images.image_2 → images.image_
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push({ slot: s, nid: c.nid, name: c.name });
      });
    });
    // 主组＝第一个图片插槽所在的那组（没有下游、或组里只有一张，就按单图处理）
    let main = null;
    groups.forEach((items) => {
      if (!main && items.some((it) => it.slot.key === imgSlots[0].key)) main = items;
    });
    const pruned = [];
    const orphans = new Set();
    if (!main || main.length < 2) {
      setSlot(imgSlots[0].key, list[0]);
      return { bound: [imgSlots[0].key], pruned };
    }
    // 按 images.image_N 里的 N 排序：第 1 张写进 image_1，提示词里的「图1」才指得对。
    // 不排序的话会把画布第 1 张塞进 image_3，模型看到的是另一张。
    const orderOf = (it) => { const m = /(\d+)$/.exec(it.name); return m ? Number(m[1]) : 0; };
    const sorted = main.slice().sort((a, b) => orderOf(a) - orderOf(b));
    sorted.forEach((it, i) => {
      if (i < list.length) { setSlot(it.slot.key, list[i]); return; }
      const nd = g[it.nid];
      if (!nd || !nd.inputs || !(it.name in nd.inputs)) return;
      delete nd.inputs[it.name];
      orphans.add(String(it.slot.node));
      if (it.slot.value) pruned.push(String(it.slot.value));
    });
    // 光断线不够：ComfyUI 会校验整张图里的每个节点，孤儿 LoadImage 里那个本地文件名
    // 只要不在 input/ 目录，整次生成就被 400 驳回。所以没人引用的 LoadImage 直接摘掉。
    orphans.forEach((id) => {
      const nd = g[id];
      if (!nd || nd.class_type !== 'LoadImage') return;
      const stillUsed = Object.entries(g).some(([nid, other]) => nid !== id
        && Object.values((other && other.inputs) || {}).some((v) => Array.isArray(v) && String(v[0]) === id));
      if (!stillUsed) delete g[id];
    });
    return { bound: sorted.slice(0, Math.min(list.length, sorted.length)).map((it) => it.slot.key), pruned };
  }

  // 尺寸该写到哪里？「名字里带 width 的字面量插槽」这条路只对文生图工作流成立。
  // 图生图 / 风格类工作流普遍是 EmptyLatentImage.width ← ResolutionSelector（连线），
  // 连线值在 analyze 里被跳过，于是面板上选的尺寸一个像素都没写进去——「指定尺寸和出图不一致」。
  // 真正的落点应该是「KSampler 的 latent_image 往上第一个同时有 width/height 输入的节点」：
  // 那个节点的宽高就是出图尺寸，把连线换成字面量即可（ComfyUI 的输入本来就能二选一）。
  function dimsTarget(g) {
    const ks = Object.entries(g).find(([, nd]) => nd && typeof nd.class_type === 'string'
      && /KSampler/i.test(nd.class_type) && nd.inputs && Array.isArray(nd.inputs.latent_image));
    if (!ks) return null;
    const seen = new Set();
    const queue = [String(ks[1].inputs.latent_image[0])];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const nd = g[id];
      if (!nd || !nd.inputs) continue;
      if ('width' in nd.inputs && 'height' in nd.inputs) return id;
      Object.values(nd.inputs).forEach((v) => {
        if (Array.isArray(v) && v.length === 2 && typeof v[1] === 'number') queue.push(String(v[0]));
      });
    }
    return null;
  }

  // 提示词到底该写进哪个节点？不能再取「排序第一个 text 插槽」了——
  // 1hew_MultiStringJoin / StringConcatenate 的 input / separator / delimiter 也是 STRING，
  // 而且节点 id 更小排得更前，于是提示词被写进一个**空转的填充参数**（string_1/string_2 全是连线，
  // input 根本没参与拼接）。用户在面板里写的那句话一个字都没进模型，出图完全由工作流自带的
  // 残留文本决定——「加载工作流会出现数据残留」，这是最要命的那个。
  // 落点只能从 KSampler.positive 往回找：链上最上游的「内容型字面量文本」才是人写的那句话。
  function promptPlan(g, slots) {
    // 拼接器的填充位 / 分隔符：名字就不像人话，永远不当落点
    const JOIN_PARAM = /^(input|inputs|separator|delimiter|sep|prefix|suffix|filter_\w+|\w+_sep)$/i;
    // 系统提示 / 扩写模板：属于工作流的机关，不该被用户那句话顶掉
    const SYSTEMISH = /(you are an?[^.]{0,60}(expert|assistant|model|engineer)|your task is|follow these rules|think step by step)/i;
    const isNeg = (s) => {
      const n = String(s.input).toLowerCase();
      return n.includes('negative') || n.startsWith('neg');
    };
    const texts = (slots || []).filter((x) => x.kind === 'text');

    // 每个节点离 KSampler.positive 有几跳（只沿 inputs 里的连线往上走）
    const depth = new Map();
    const ks = Object.entries(g || {}).find(([, nd]) => nd && typeof nd.class_type === 'string'
      && /KSampler/i.test(nd.class_type) && nd.inputs && Array.isArray(nd.inputs.positive));
    if (ks) {
      const stack = [[String(ks[1].inputs.positive[0]), 0]];
      while (stack.length) {
        const [id, d] = stack.pop();
        if (depth.has(id) && depth.get(id) <= d) continue;
        depth.set(id, d);
        const nd = g[id];
        Object.values((nd && nd.inputs) || {}).forEach((v) => {
          if (Array.isArray(v) && v.length === 2 && typeof v[1] === 'number') stack.push([String(v[0]), d + 1]);
        });
      }
    }

    const cands = texts.filter((s) => !isNeg(s) && depth.has(String(s.node))
      && !JOIN_PARAM.test(String(s.input)));
    // 有「内容型」的就别碰系统提示；一条都没有才退回全部候选
    const content = cands.filter((s) => !SYSTEMISH.test(String(s.value || '')));
    const pool = (content.length ? content : cands).slice()
      .sort((a, b) => depth.get(String(b.node)) - depth.get(String(a.node)));
    let target = pool[0] || null;
    // 兜底：链上一个字面量文本都没有（提示词全靠连线/纯负面词工作流）时，
    // 退回「第一个不像拼接参数的 text 插槽」，最后才退回 texts[0]
    const fallback = texts.find((s) => !isNeg(s) && !JOIN_PARAM.test(String(s.input))) || texts[0] || null;
    // 老逻辑是直接取 texts[0]。差得越远，越该在状态里报一句「提示词写哪去了」
    const oldPick = texts[0] || null;
    const corrected = !!(target && oldPick && target.key !== oldPick.key);
    if (!target) target = fallback;
    return {
      target, oldPick, corrected,
      negative: texts.find(isNeg) || null,
      onChain: cands.length,
    };
  }

  // 种子：同一个 seed 配同一段提示词，出来永远是同一张图。生成器里那个 seed 又来自工作流
  // 导出时冻结的值，于是用户怎么点「生成」都是同一张——「继续生成」等于没生成。
  // 所以每次提交都换一个随机种子；想复现某一张时切「固定」，填回状态栏报的那个数即可。
  function planSeed(seedOpt) {
    if (seedOpt && seedOpt.mode === 'fixed') {
      const v = Math.floor(Number(seedOpt.value));
      // 固定档填了非法值（负数、NaN）就落到 0，而不是偷偷随机：
      // 「固定」这个词得说到做到，否则用户以为钉住了，其实每次都不一样。
      // （清空本来就等价于 0——Number(null) 是 0，不是 NaN）
      if (Number.isFinite(v) && v >= 0) return { value: v, fixed: true };
      return { value: 0, fixed: true };
    }
    // 2^32：ComfyUI 的 seed 上限远大于它，4.29e9 的抽卡空间够用，又稳稳落在 JS 安全整数内
    return { value: Math.floor(Math.random() * 4294967296), fixed: false };
  }

  // 面板上选了 N 张、图里只回来 M 张：这是工作流自己把批量抹平了（二次采样链、ImageBatch、
  // 只吃单张的后处理），不是提交失败。要能在界面上说清楚，否则用户只会反复重试。
  function batchShortfall(want, got) {
    const w = Math.floor(Number(want)) || 1;
    const g = Math.floor(Number(got)) || 0;
    if (w <= 1 || g <= 0 || g >= w) return null;
    return { want: w, got: g, note: `只回来 ${g} 张（提交了 ${w} 张）` };
  }

  // 把提示词 / 画幅 / 张数 / 种子写进 API 图
  function buildGenGraph(graph, slots, dims, batch, prompt, refImages, seedOpt) {
    const out = JSON.parse(JSON.stringify(graph));
    const setVal = (key, value) => {
      const i = key.lastIndexOf('.');
      const nid = key.slice(0, i), input = key.slice(i + 1);
      if (out[nid] && out[nid].inputs) out[nid].inputs[input] = value;
    };
    const plan = promptPlan(out, slots);
    if (plan.target) setVal(plan.target.key, prompt);
    // 负面词保持工作流原样：以前用「第二个 text 插槽」兜，排序一抖就把正向文案写进负面词，
    // 而且那句 setVal(..., value || '') 还会把 analyze 时的快照值回写一遍（残留数据的另一条来路）。
    // 种子全写同一个值：一个工作流里常有 seed 与 noise_seed 两处（采样器 + 二次采样），
    // 只换一处的话画面还是会被另一处钉死。
    const seed = planSeed(seedOpt);
    const seedKeys = (slots || []).filter((x) => x.kind === 'seed');
    seedKeys.forEach((x) => setVal(x.key, seed.value));
    // 参考图：给了几张就按顺序绑几张（多图编辑器一组 images.image_1..N），顺手摘掉工作流自带的残留图
    const refs = bindRefImages(out, slots, refImages);
    // 先钉出图节点；钉不到才退回「按插槽名写」，最后仍写不进就让调用方把话说清楚
    let sized = false;
    // 「张数」有没有真的落进图里：有些工作流（自定义导入的、视频流）根本没有 batch 插槽，
    // 面板上选 4 张却只出 1 张，界面上却不吭声——用户只会觉得「多图生成坏了」。
    let batched = false;
    const target = dimsTarget(out);
    if (target) {
      const ins = out[target].inputs;
      // 被字面量顶掉的连线源头（ResolutionSelector 这类）之后没人再引用，
      // 留着只是提交图里的一坨死节点——顺手摘干净，但只在真的没人用的时候
      const dropped = [ins.width, ins.height]
        .filter((v) => Array.isArray(v) && v.length === 2 && typeof v[1] === 'number')
        .map((v) => String(v[0]));
      ins.width = dims.width;
      ins.height = dims.height;
      if ('batch_size' in ins) { ins.batch_size = batch; batched = true; }
      sized = true;
      dropped.forEach((id) => {
        if (!out[id] || id === target) return;
        const stillUsed = Object.entries(out).some(([nid, nd]) => nid !== id
          && Object.values((nd && nd.inputs) || {}).some((v) => Array.isArray(v) && String(v[0]) === id));
        if (!stillUsed) delete out[id];
      });
    }
    (slots || []).forEach((x) => {
      if (x.kind !== 'number') return;   // seed 上面已经统一写过，这里只管宽高与张数
      const name = String(x.input).toLowerCase();
      if (name.includes('width')) { if (!sized) setVal(x.key, dims.width); }
      else if (name.includes('height')) { if (!sized) setVal(x.key, dims.height); }
      else if (name.includes('batch')) {
        // 出图节点上已经有 batch_size 就别再写第二遍（同名插槽可能挂在别的节点上）
        if (!(sized && target === String(x.node))) { setVal(x.key, batch); batched = true; }
      }
    });
    return {
      graph: out, pruned: refs.pruned, sized,
      // 张数是否真的写进了图里：false 时前端必须明说「这张工作流不吃多张」
      batch: { value: batch, applied: batched },
      // 实际绑进去的参考图（有几张、绑在哪些插槽）——状态栏和「参考 2 张」都靠它
      refs: { count: refs.bound.length, keys: refs.bound },
      // 本次用的种子：调用方要把它记到节点上（「设置」里能看到、切「固定」能复现）
      seed: seedKeys.length ? { value: seed.value, fixed: seed.fixed, keys: seedKeys.map((s) => s.key) } : null,
      // 提示词落在哪 （title 给人看，input 给排查用）
      prompt: plan.target ? {
        key: plan.target.key, node: plan.target.node, input: plan.target.input,
        title: plan.target.node_title || plan.target.class_type || plan.target.node,
        corrected: plan.corrected,
      } : null,
    };
  }

  // 出错信息分类：ComfyUI 的报错是一大坨字符串，直接甩给用户等于没说。
  // 分四类，每类给一句「下一步该干什么」——用户才知道是改尺寸、补模型，还是等一等。
  function classifyGenError(msg) {
    const s = String(msg || '');
    if (/out of memory|OutOfMemory|OOM|allocation on device|CUDA error/i.test(s)) {
      return { kind: 'oom', title: '显存不足', hint: '尺寸调小一档再试（4K→2K，或短边减半）', retry: false };
    }
    if (/not found|No such file|ckpt_name|CheckpointLoader|failed to load|Cannot load/i.test(s)) {
      return { kind: 'model', title: '模型或文件缺失', hint: '检查工作流里的模型名和本机 models 目录是否对得上', retry: false };
    }
    if (/node_errors|invalid prompt|Required input is missing|Return type mismatch|Prompt has no outputs/i.test(s)) {
      return { kind: 'workflow', title: '工作流有错', hint: '看报错里的节点 id，回 ComfyUI 检查那个节点', retry: false };
    }
    if (/任务记录已丢失|查询失败|Failed to fetch|network|NetworkError|timeout|超时/i.test(s)) {
      return { kind: 'network', title: '连接或超时', hint: '会自动重试一次；再失败就看 ComfyUI 是否还在跑', retry: true };
    }
    return { kind: 'unknown', title: '生成失败', hint: '', retry: false };
  }

  function pollPrompt(pid, onTick, onDone) {
    const t0 = Date.now();
    let lostPolls = 0;
    // 取消之后，那一两次「已经在飞」的请求回来照样会走完 then —— 不挡的话它会把
    // 「已取消」刷成「生成中」，甚至按中断报错。停机后一律不许再回调。
    let stopped = false;
    const timer = setInterval(async () => {
      const res = await api(`/api/job?pid=${encodeURIComponent(pid)}`);
      if (stopped) return;
      const secs = Math.round((Date.now() - t0) / 1000);
      if (!res.ok) { clearInterval(timer); onDone([], res.error || '查询失败', secs); return; }
      if (res.status === 'queued' || res.status === 'running') {
        lostPolls = 0;
        onTick(res.status === 'queued' ? '排队中' : '生成中', secs, res.progress ?? null);
        return;
      }
      if (res.status === 'unknown') {
        lostPolls += 1;
        if (lostPolls <= 4) { onTick('等待任务', secs); return; }
        clearInterval(timer);
        onDone([], '任务记录已丢失（ComfyUI 可能已重启）', secs);
        return;
      }
      clearInterval(timer);
      onDone(res.artifacts || [], res.error, secs);
    }, 1500);
    // 返回「停止轮询」的句柄（对象，不是函数）：队列面板取消任务时用它把前端这侧掐掉
    return { stop() { stopped = true; clearInterval(timer); } };
  }

  /* ---------------- 参考图：连线来的 + @ 引用的 ---------------- */
  // 图片节点的输入口只有一个，所以「多张参考图」只活在面板里，不活在连线上：
  //   * link —— 画布上真的连进本节点的图（画布上看得见，删线就没了）
  //   * text —— 挂在左侧文本节点上的图（「提示词 + 参考图」打成一个包的那种）
  //   * at   —— 提示词里 @ 引用来的图，只给这个节点当参考，不画线（免得一提图就把画布搅乱）
  // 提交时按这个顺序取第一张能用的：工作流通常只有一个图片插槽，多出来的只做提示，不静默改图。
  function refsOf(n) {
    const out = [];
    const seen = new Set();
    const push = (node, via) => {
      if (!node || node.type !== 'image' || node.id === n.id || seen.has(node.id)) return;
      if (!node.dataURL) return;
      seen.add(node.id);
      out.push({ node, via });
    };
    const into = state.links.filter((l) => l.to === n.id && l.toKey === 'in')
      .map((l) => getNode(l.from)).filter(Boolean);
    into.filter((x) => x.type === 'image').forEach((x) => push(x, 'link'));
    into.filter((x) => x.type === 'text').forEach((t) => {
      state.links.filter((l) => l.to === t.id && l.toKey === 'in')
        .map((l) => getNode(l.from)).forEach((x) => push(x, 'text'));
    });
    ((n.gen && n.gen.extras) || []).forEach((id) => push(getNode(id), 'at'));
    return out;
  }

  // @[名字] 是给人看的引用标记，进 ComfyUI 之前必须处理掉，否则会当成提示词的一部分发给模型。
  // 但**不能直接删**：「把 @[甲] 的人物放进 @[乙] 的场景」删完会变成「把 的人物放进 的场景」，
  // 模型既不知道在说哪张图，连句子都不通顺了——这就是「@ 的图片识别不准」。
  // 正确做法是换成工作流里那套指代：图1 / 图2（和 images.image_1、image_2 一一对应）。
  // refs: [{ label }]，顺序就是它们被绑进工作流的顺序（第 1 张 = 图1）。
  // 没有被送进工作流的引用仍然删掉——不能给模型指一张它根本没拿到的图。
  // 正则写在函数里（不提出去当常量）：这个函数要能被测试单独抠出来跑。
  function refMarks(text, refs) {
    const idx = new Map();
    (refs || []).forEach((r, i) => { if (!idx.has(r.label)) idx.set(r.label, i + 1); });
    return String(text || '')
      .replace(/@\[([^\]\n]{0,40})\]/g, (_, name) => (idx.has(name) ? `图${idx.get(name)}` : ''))
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  const REF_VIA_LABEL = { link: '连线', text: '经文本节点', at: '@ 引用' };

  function renderRefs(n) {
    const wrap = nodesEl.querySelector(`[data-refs-for="${CSS.escape(n.id)}"]`);
    if (!wrap) return;
    const refs = refsOf(n);
    // 套了风格也在这排里占一格：风格和参考图都是「这次真正会送进去的东西」，
    // 图能看见、风格只是一颗写着名字的按钮，心里没底。缩略图 + ✕ 跟参考图一个手感。
    const styleRef = (n.gen && n.gen.style && n.gen.style.cn) ? n.gen.style : null;
    wrap.classList.toggle('hidden', refs.length === 0 && !styleRef);
    wrap.innerHTML = '';
    refs.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = `gen-ref via-${r.via}${i === 0 ? ' primary' : ''}`;
      // 别写死「工作流只有一个图片插槽」：多图编辑器（Qwen 编辑流的 images.image_1..4）能吃好几张。
      // 到底用几张要看工作流，这里只交代顺序——第 N 张就是提示词里的「图N」。
      const why = i === 0 ? ' · 提示词里的「图1」' : ` · 提示词里的「图${i + 1}」，工作流吃不下的靠后几张不会用`;
      item.title = `${i + 1}. ${r.node.title || '图片'}（${REF_VIA_LABEL[r.via]}）${why}`;
      // 多张时左下角标序号（对齐参考图里的 1 / 2），单张就不必了
      const num = refs.length > 1 ? `<span class="gen-ref-n">${i + 1}</span>` : '';
      item.innerHTML = `<img src="${esc(r.node.dataURL)}" alt="" draggable="false" />${num}<button class="gen-ref-x" title="取消这张参考图">✕</button>`;
      item.querySelector('.gen-ref-x').onclick = (ev) => {
        ev.stopPropagation();
        // 连线来的只摘掉「这一条」，别的一起端掉就太狠了
        if (r.via === 'link') {
          const link = state.links.find((l) => l.to === n.id && l.toKey === 'in' && l.from === r.node.id);
          if (link) removeLinkById(link.id);
          else removeLink(n.id, 'in');
          return;
        }
        if (r.via === 'at') {
          n.gen.extras = (n.gen.extras || []).filter((id) => id !== r.node.id);
          // 缩略图取消了，正文里那枚胶囊也得摘掉，否则「看不见的参考图」还留在提示词里
          const token = `@[${refLabelFn(n)(r.node)}]`;
          if (String(n.gen.prompt || '').includes(token)) {
            n.gen.prompt = n.gen.prompt.split(token).join('').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '');
            const ed = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .gen-prompt`);
            if (ed) { fillPrompt(ed, n.gen.prompt, n); ed.dispatchEvent(new Event('input', { bubbles: true })); }
          }
          queueSave(); renderRefs(n);
          return;
        }
        flash('这张图挂在左侧文本节点上，要断开文本节点那根线才能取消');
      };
      wrap.appendChild(item);
    });

    if (styleRef) {
      const item = document.createElement('div');
      item.className = 'gen-ref gen-ref-style';
      item.title = `已套用风格：${styleRef.cn}（点一下换风格）`;
      item.innerHTML = `<img src="${esc(styleThumbByRef(styleRef))}" alt="" draggable="false" />
        <span class="gen-ref-tag">风格</span>
        <button class="gen-ref-x" title="取消风格">✕</button>`;
      // 点格子 = 换个风格（锚在同一行那颗风格按钮上，省得再算位置）
      item.onclick = () => {
        const chip = document.querySelector(`[data-panel-for="${CSS.escape(n.id)}"] .gen-style`);
        openStyleMenu(chip || item, n);
      };
      item.querySelector('.gen-ref-x').onclick = (ev) => {
        ev.stopPropagation();
        n.gen.style = null;
        paintStyleChip(document.querySelector(`[data-panel-for="${CSS.escape(n.id)}"] .gen-style`), null);
        renderRefs(n);
        queueSave(); commit();
      };
      wrap.appendChild(item);
    }
  }

  /* ---------------- 提示词编辑器（contenteditable） ---------------- */
  // 纯 textarea 里塞不进图片，所以提示词改用 contenteditable：
  // @ 引用渲染成「缩略图 + 名字」的内联胶囊，contentEditable=false（Backspace 一下整个删掉）。
  // 对外仍然用 `@[名字]` 这套纯文本表示——存档、提交、refMarks 全都不用改。
  const CHIP_SEL = '.gen-chip';

  function promptText(el) {
    let out = '';
    const walk = (node) => {
      node.childNodes.forEach((c) => {
        if (c.nodeType === 3) { out += c.nodeValue; return; }
        if (c.nodeType !== 1) return;
        if (c.classList && c.classList.contains('gen-chip')) { out += c.dataset.token || ''; return; }
        if (c.tagName === 'BR') { out += '\n'; return; }
        // contenteditable 里回车可能插 <div>，序列化时补成换行
        if (/^(DIV|P)$/.test(c.tagName) && out && !out.endsWith('\n')) out += '\n';
        walk(c);
      });
    };
    walk(el);
    return out.replace(/\u00a0/g, ' ');   // 不换行空格换回普通空格
  }

  // token 里可能带重名序号（`@[图片 #2]`）：按序号去候选图里取，别一股脑返回第一张同名的
  function nodeByTitle(name, owner) {
    const m = /^([\s\S]*) #(\d+)$/.exec(name);
    const base = m ? m[1] : name;
    const pool = state.nodes.filter((x) => x.type === 'image'
      && x.id !== (owner && owner.id) && x.dataURL && (x.title || '图片') === base);
    if (m) return pool[Number(m[2]) - 1] || pool[0] || null;
    return pool[0] || null;
  }

  // 这枚胶囊是「图几」？提交时 @[甲] 会被换成「图1」，用户得能对上号——
  // 编号就是它在参考图列表里的位置（连线 → 经文本 → @ 引用，同一套顺序）。
  function refIndexOf(owner, name) {
    if (!owner) return 0;
    const labelOf = refLabelFn(owner);
    return refsOf(owner).findIndex((r) => labelOf(r.node) === name) + 1;
  }

  function makeChip(name, owner) {
    const src = nodeByTitle(name, owner);
    const chip = document.createElement('span');
    chip.className = 'gen-chip';
    chip.contentEditable = 'false';
    chip.dataset.token = `@[${name}]`;
    chip.dataset.name = name;
    if (src) chip.dataset.node = src.id;
    const idx = refIndexOf(owner, name);
    chip.title = `参考图：${name}${idx ? ` · 提交时写作「图${idx}」` : ''}`;
    chip.innerHTML = (src && src.dataURL ? `<img src="${esc(src.dataURL)}" alt="" draggable="false" />` : '')
      + `<span class="gen-chip-name">${esc(name)}</span>`;
    return chip;
  }

  function fillPrompt(el, text, owner) {
    el.innerHTML = '';
    String(text || '').split(/(@\[[^\]\n]{0,40}\])/g).forEach((p) => {
      if (!p) return;
      const m = /^@\[([^\]\n]{0,40})\]$/.exec(p);
      if (m) { el.appendChild(makeChip(m[1], owner)); return; }
      el.appendChild(document.createTextNode(p));   // white-space:pre-wrap 下 \n 就是换行
    });
  }

  function caretAfterToken(el, token) {
    const sel = window.getSelection();
    if (!sel) return;
    const chip = [...el.querySelectorAll(CHIP_SEL)].find((c) => c.dataset.token === token);
    const r = document.createRange();
    if (chip && chip.parentNode) {
      r.setStartAfter(chip);
      const next = chip.nextSibling;   // 胶囊后面那个空格算"已经打过的"，光标放到它后面
      if (next && next.nodeType === 3 && next.nodeValue.startsWith(' ')) r.setStart(next, 1);
    } else {
      r.selectNodeContents(el);
    }
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // 光标前 / 后的纯文本（胶囊算成 @[名字]）
  function promptSides(el) {
    const sel = window.getSelection();
    const box = (frag) => {
      const d = document.createElement('div');
      d.appendChild(frag);
      return promptText(d);
    };
    if (!sel || !sel.rangeCount) return { before: promptText(el), after: '' };
    const r = sel.getRangeAt(0);
    if (!el.contains(r.commonAncestorContainer)) return { before: promptText(el), after: '' };
    const b = document.createRange();
    b.selectNodeContents(el);
    b.setEnd(r.endContainer, r.endOffset);
    const a = document.createRange();
    a.selectNodeContents(el);
    a.setStart(r.endContainer, r.endOffset);
    return { before: box(b.cloneContents()), after: box(a.cloneContents()) };
  }

  /* ---------------- 提示词里的 @ ---------------- */
  let refMenu = null;   // { el, n, query, before, after }

  function closeRefMenu() {
    if (!refMenu) return;
    refMenu = null;
    closePopMenu();
  }

  // 候选分两池：
  //  · linked —— 已经连进来的图（连线 / 经文本节点），这是参考图的**唯一**来源
  //  · canvas —— 画布上其它图片，属于「全局素材」，要切到「全部素材」才看得见
  // 没连线时不在菜单里甩一堆图（那会让人以为凭空多了参考图），但全局入口一直留在那儿。
  function refPools(n, filter) {
    const k = String(filter || '').toLowerCase();
    const hit = (x) => !k || String(x.title || '').toLowerCase().includes(k);
    const linked = refsOf(n).filter((r) => r.via !== 'at');
    const ids = new Set(linked.map((r) => r.node.id));
    const canvas = state.nodes
      .filter((x) => x.type === 'image' && x.id !== n.id && x.dataURL && !ids.has(x.id))
      .map((node) => ({ node, via: 'canvas' }));
    return { linked: linked.filter((r) => hit(r.node)), canvas: canvas.filter((r) => hit(r.node)) };
  }

  // 好几个节点都叫默认的「图片」时根本分不清：重名的按画布顺序补 #1 #2。
  // 编号只在「画布上的候选图」里排，不把目标节点和空图算进去，两个标签页看到的号也一致。
  function refLabelFn(n) {
    const pool = state.nodes.filter((x) => x.type === 'image' && x.id !== n.id && x.dataURL);
    const counts = {};
    pool.forEach((x) => { const k = x.title || '图片'; counts[k] = (counts[k] || 0) + 1; });
    const seen = {};
    const map = {};
    pool.forEach((x) => {
      const k = x.title || '图片';
      if ((counts[k] || 0) < 2) return;
      seen[k] = (seen[k] || 0) + 1;
      map[x.id] = `${k} #${seen[k]}`;
    });
    return (node) => map[node.id] || node.title || '图片';
  }

  const REF_VIA_SHORT = { link: '连线', text: '经文本', at: '@', canvas: '画布' };
  const REF_SEARCH_ICON = '<svg class="oi" viewBox="0 0 48 48" fill="none" aria-hidden="true">'
    + '<path d="M37 37L31.5 31.5" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
    + '<circle cx="21" cy="21" r="13" stroke="currentColor" stroke-width="4"/></svg>';

  // 光标矩形：菜单贴着正在打的那个 @ 弹出来，而不是挂在整块编辑区底下（会掉出面板外）
  function caretRect(el, fallback) {
    const lastRect = (range) => {
      const list = range.getClientRects();
      return list.length ? list[list.length - 1] : null;
    };
    const asPoint = (x) => ({ left: x.right, right: x.right, top: x.top, bottom: x.bottom, width: 0, height: x.height });
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (el.contains(r.commonAncestorContainer)) {
        const own = lastRect(r);
        if (own && (own.width || own.height)) return own;
        // 折叠光标常常一个 rect 都量不出来：借光标前的那个字符 / 子节点推位置，纯测量不动 DOM
        const at = r.cloneRange();
        at.collapse(true);
        const node = at.startContainer;
        if (node.nodeType === 3 && at.startOffset > 0) {
          const p = document.createRange();
          p.setStart(node, at.startOffset - 1);
          p.setEnd(node, at.startOffset);
          const x = lastRect(p);
          if (x) return asPoint(x);
        }
        if (node.nodeType === 1) {
          const child = node.childNodes[at.startOffset - 1];
          if (child) {
            const p = document.createRange();
            p.selectNodeContents(child);
            const x = lastRect(p);
            if (x) return asPoint(x);
          }
        }
      }
    }
    return fallback.getBoundingClientRect();
  }

  function placeMenuNear(menu, rect) {
    const m = menu.getBoundingClientRect();
    const gap = 8, edge = 8;
    let left = rect.left - 10;
    let top = rect.bottom + gap;
    if (top + m.height > window.innerHeight - edge) top = Math.max(edge, rect.top - m.height - gap);
    left = Math.min(Math.max(edge, left), window.innerWidth - m.width - edge);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function openRefMenu(el, n, q, sides) {
    const before = sides.before;
    // 每次输入都会重新进来：文本没变就别重建菜单（否则刚悬停上去就被刷掉），
    // 但光标可能换行了，位置要跟着走
    if (refMenu && refMenu.el === el && refMenu.before === before && refMenu.query === q) {
      const m = document.getElementById('refMenu');
      if (m) placeMenuNear(m, caretRect(el, el));
      return;
    }
    const tab = refMenu && refMenu.el === el ? refMenu.tab : 'linked';
    closePopMenu();          // 必须先关旧菜单再记状态：closePopMenu 里会把 refMenu 清空
    refMenu = { el, n, query: q, before, after: sides.after, tab, filter: q || '' };
    const menu = document.createElement('div');
    menu.className = 'popmenu refmenu';
    menu.id = 'refMenu';
    menu.appendChild(buildRefSearch());
    menu.appendChild(buildRefTabs());
    const list = document.createElement('div');
    list.className = 'rm-list';
    menu.appendChild(list);
    document.body.appendChild(menu);
    paintRefList();
    placeMenuNear(menu, caretRect(el, el));
    // @ 菜单以前只认 Esc / 继续打字 / 点菜单项，点到画布空白处就一直挂在那儿不动。
    // 同一个关闭逻辑还顺带保证「点空白只收菜单，不会把节点一起取消选中」。
    armPopClose(el);
  }

  function buildRefSearch() {
    const box = document.createElement('div');
    box.className = 'rm-search';
    box.innerHTML = `${REF_SEARCH_ICON}<input type="text" placeholder="搜索素材" spellcheck="false" />`;
    const input = box.querySelector('input');
    input.oninput = () => { if (refMenu) { refMenu.filter = input.value; paintRefList(); } };
    input.onkeydown = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeRefMenu(); return; }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const first = document.querySelector('#refMenu .rm-item');
        if (first) first.click();
      }
    };
    return box;
  }

  function buildRefTabs() {
    const wrap = document.createElement('div');
    wrap.className = 'rm-tabs';
    [['linked', '已关联'], ['all', '全部素材']].forEach(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rm-tab';
      b.dataset.tab = key;
      b.innerHTML = `<span>${label}</span><i class="rm-tab-n">0</i>`;
      b.onclick = () => {
        if (!refMenu) return;
        refMenu.tab = key;
        paintRefList();
      };
      wrap.appendChild(b);
    });
    return wrap;
  }

  function paintRefList() {
    const menu = document.getElementById('refMenu');
    if (!menu || !refMenu) return;
    const { n, tab, filter } = refMenu;
    const pools = refPools(n, filter);
    const total = pools.linked.length + pools.canvas.length;
    menu.querySelectorAll('.rm-tab').forEach((b) => {
      const key = b.dataset.tab;
      b.querySelector('.rm-tab-n').textContent = String(key === 'linked' ? pools.linked.length : total);
      b.classList.toggle('on', key === tab);
    });
    const list = menu.querySelector('.rm-list');
    list.innerHTML = '';
    const items = tab === 'linked' ? pools.linked : [...pools.linked, ...pools.canvas];
    if (!items.length) {
      const anyImg = state.nodes.some((x) => x.type === 'image' && x.id !== n.id && x.dataURL);
      const empty = document.createElement('div');
      empty.className = 'rm-empty';
      empty.textContent = filter ? '没有匹配的素材'
        : tab === 'linked' ? (anyImg ? '还没有连进来的图片' : '画布上还没有其它图片')
          : '画布上还没有其它图片';
      list.appendChild(empty);
      // 「已关联」空着时把全局入口摆在脸上——但仍是用户自己点进来，不自动摊开一堆图
      if (!filter && tab === 'linked' && anyImg) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'rm-item rm-browse';
        go.innerHTML = `<span class="rm-name">浏览画布全部素材</span><span class="rm-meta">${total}</span>`;
        go.onclick = () => { if (refMenu) { refMenu.tab = 'all'; paintRefList(); } };
        list.appendChild(go);
      }
      return;
    }
    const label = refLabelFn(n);
    items.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rm-item';
      b.innerHTML = `<img src="${esc(r.node.dataURL)}" alt="" draggable="false" />`
        + `<span class="rm-name">${esc(label(r.node))}</span>`
        + `<span class="rm-meta via-${r.via}">${REF_VIA_SHORT[r.via] || ''}</span>`;
      b.onclick = () => pickRef(r.node);
      list.appendChild(b);
    });
  }

  function pickRef(src) {
    const ctx = refMenu;
    closeRefMenu();
    if (!ctx) return;
    const { el, n, before, after, query } = ctx;
    // 点菜单时编辑器已经失焦，所以用打开时记下的前后文，不依赖实时 selection
    const headText = before.slice(0, Math.max(0, before.length - query.length - 1));
    // token 用「显示出来的那个名字」：重名的图会带 #2 序号，否则胶囊会指回第一张同名图
    const token = `@[${refLabelFn(n)(src)}]`;
    fillPrompt(el, `${headText}${token} ${after}`, n);
    el.focus();
    caretAfterToken(el, token);
    n.gen.extras = [...new Set([...(n.gen.extras || []), src.id])];
    el.dispatchEvent(new Event('input', { bubbles: true }));   // 复用 oninput：同步存档 + 高度 + 缩略图
    renderRefs(n);
  }

  // 光标前的 `@xxx` → 打开引用菜单。不能要求 `@` 前面是空格——中文文案里大家就是「文案@」接着打；
  // 只排除紧跟 `[` 的情况（那是胶囊的 `@[名字]` token，不是新起的引用）
  const AT_RE = /@([^\s@\[]{0,20})$/;

  function detectAtMention(el, n) {
    const sides = promptSides(el);
    const m = AT_RE.exec(sides.before);
    if (!m) { closeRefMenu(); return; }
    openRefMenu(el, n, m[1], sides);
  }

  function buildRefsStrip(n, panel) {
    const wrap = document.createElement('div');
    wrap.className = 'gen-refs hidden';
    wrap.dataset.refsFor = n.id;
    panel.appendChild(wrap);
    // 此刻面板还没挂到 #nodes 上，按 id 找不到自己；等挂完这一帧再填内容
    requestAnimationFrame(() => renderRefs(n));
    return wrap;
  }

  // 底部原来并排放着「画幅 / 尺寸 / 张数」三个下拉：一行里挤四个控件，每个窄到只能显示两个字，
  // 想选 3:2 得先点开、再在文字列表里找。收成一枚胶囊（16:9 · 标准 · 1 张）+ 一个分组弹层：
  // 比例做成图形网格（胖瘦一眼可比），清晰度带上短边像素，底部实时显示最终出图尺寸。
  function openGenOpts(anchor, g, sync) {
    closePopMenu();
    const menu = document.createElement('div');
    menu.className = 'popmenu gen-opts';

    const sec = (title) => {
      const box = document.createElement('div');
      box.className = 'go-sec';
      const h = document.createElement('div');
      h.className = 'go-title';
      h.textContent = title;
      box.appendChild(h);
      menu.appendChild(box);
      return box;
    };

    const foot = document.createElement('div');
    foot.className = 'go-foot';

    // 两个自定义宽高输入框，paint 时同步成「当前生效尺寸」，随手改写就切到自定义档
    const cW = document.createElement('input');
    const cH = document.createElement('input');
    [cW, cH].forEach((el, i) => {
      el.type = 'number';
      el.className = 'go-num';
      el.min = DIM_MIN;
      el.max = DIM_MAX;
      el.step = 16;
      el.dataset.dim = i ? 'h' : 'w';
      el.title = i ? `高度（${DIM_MIN}~${DIM_MAX}，自动对齐 16 的倍数）` : `宽度（${DIM_MIN}~${DIM_MAX}，自动对齐 16 的倍数）`;
      el.setAttribute('aria-label', i ? '自定义高度' : '自定义宽度');
    });

    const paint = (syncInputs = true) => {
      menu.querySelectorAll('.go-ratio').forEach((b) => b.classList.toggle('on', b.dataset.a === g.aspect));
      menu.querySelectorAll('.go-seg button').forEach((b) => {
        const on = b.dataset.s != null ? b.dataset.s === g.size : Number(b.dataset.b) === Number(g.batch);
        b.classList.toggle('on', on);
      });
      const d = calcDims(g.aspect, g.size, g.custom);
      const mp = (d.width * d.height) / 1e6;
      cBox.classList.toggle('on', g.size === 'custom');
      // 种子：随机档把输入框灰掉（它还显示着上次用的数，切「固定」就能直接复现）
      const seedFixed = (g.seedMode || 'random') === 'fixed';
      menu.querySelectorAll('button[data-seed]').forEach((b) => {
        b.classList.toggle('on', (b.dataset.seed === 'fixed') === seedFixed);
      });
      seedRow.classList.toggle('on', seedFixed);
      seedInp.disabled = !seedFixed;
      if (document.activeElement !== seedInp) seedInp.value = g.seed == null ? '' : String(g.seed);
      // 正在输入的框别被回写，否则打「12」会被补成「1024」再跳一次光标
      if (syncInputs) {
        if (document.activeElement !== cW) cW.value = d.width;
        if (document.activeElement !== cH) cH.value = d.height;
      }
      // 4K 一张 10~17MP，本地出图会从「一分半」变成「十几分钟」，先把话说在前面
      foot.textContent = `${g.aspect} · ${d.width} × ${d.height} · ${mp.toFixed(1)}MP`
        + (mp > 4 ? ' · 本地偏慢' : '')
        + (seedFixed ? '' : ' · 种子随机');
    };
    // 弹层不关：连着调「比例 + 清晰度」时，关一次就得重新点开一次
    const pick = (patch) => {
      Object.assign(g, patch);
      queueSave(); commit(); paint(); sync();
    };

    const aBox = sec('画幅');
    const grid = document.createElement('div');
    grid.className = 'go-ratios';
    ASPECTS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'go-ratio';
      b.dataset.a = a;
      const [w, h] = ratioGlyph(a, 22, 15);
      const glyph = document.createElement('i');
      glyph.style.width = `${w}px`;
      glyph.style.height = `${h}px`;
      const lab = document.createElement('span');
      lab.textContent = a;
      b.append(glyph, lab);
      b.onclick = () => {
        // 自定义档下点画幅：尺寸跟着比例重算（长边不动），否则「比例」和「像素」会互相打架
        if (g.size === 'custom' && g.custom) {
          g.custom = fitCustom(a, g.custom);
          pick({ aspect: a, custom: g.custom });
        } else {
          pick({ aspect: a });
        }
      };
      grid.appendChild(b);
    });
    aBox.appendChild(grid);

    const sBox = sec('清晰度');
    const seg = document.createElement('div');
    seg.className = 'go-seg';
    SIZES.forEach(([v, label, px]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'go-opt';
      b.dataset.s = v;
      const name = document.createElement('span');
      name.textContent = label;
      const hint = document.createElement('em');
      hint.textContent = px;          // 长边像素：和 1K/2K/4K 同一个口径，改档位就是在改这个数
      b.append(name, hint);
      b.onclick = () => pick({ size: v });
      seg.appendChild(b);
    });
    sBox.appendChild(seg);

    // 自定义：两个输入框直接写宽高。改一个数字就切到「自定义」档，
    // 画幅按宽高反推（1280×720 → 16:9），网格里那一格跟着亮。
    const cBox = document.createElement('div');
    cBox.className = 'go-custom';
    const cTag = document.createElement('span');
    cTag.className = 'go-custom-tag';
    cTag.textContent = '自定义';
    const times = document.createElement('i');
    times.className = 'go-times';
    times.textContent = '×';
    cBox.append(cTag, cW, times, cH);
    sBox.appendChild(cBox);

    const readCustom = () => {
      const w = Number(cW.value);
      const h = Number(cH.value);
      return w >= 1 && h >= 1 ? { w, h } : null;
    };
    const onType = (ev) => {
      const c = readCustom();
      if (!c) return;
      // 先对齐到 16 再反推比例，否则 1001×720 会算出个「1001:720」这种假比例
      const w = snapDim(c.w);
      const h = snapDim(c.h);
      g.custom = { w, h };
      g.size = 'custom';
      g.aspect = aspectOf(w, h);
      queueSave();
      // 只有真正改完（change/失焦）才提交一步撤销，逐字符敲进去不该刷一屏历史
      if (ev && ev.type === 'change') commit();
      paint(false);          // 别回写正在输入的那个框
      sync();
    };
    cW.oninput = onType;
    cH.oninput = onType;
    cW.onchange = () => { onType(); paint(); };   // 失焦时把值对齐到 16 的倍数
    cH.onchange = () => { onType(); paint(); };
    [cW, cH].forEach((el) => {
      // 数字框里滚轮改值很容易误伤，而且会把画布缩放吃掉
      el.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
    });

    const bBox = sec('张数');
    const bSeg = document.createElement('div');
    bSeg.className = 'go-seg';
    [1, 2, 4].forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'go-opt';
      b.dataset.b = String(v);
      b.textContent = `${v} 张`;
      b.onclick = () => pick({ batch: v });
      bSeg.appendChild(b);
    });
    bBox.appendChild(bSeg);

    // 种子：默认每次随机，否则同一个提示词怎么点都出同一张（工作流里那个 seed 是导出时冻结的）。
    // 想复现某一张就切「固定」——框里默认填着上次用过的那个数。
    const dBox = sec('种子');
    const dSeg = document.createElement('div');
    dSeg.className = 'go-seg two';
    [['random', '随机'], ['fixed', '固定']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'go-opt';
      b.dataset.seed = v;
      b.textContent = label;
      b.onclick = () => pick({ seedMode: v });
      dSeg.appendChild(b);
    });
    const seedRow = document.createElement('div');
    seedRow.className = 'go-custom';
    const seedInp = document.createElement('input');
    seedInp.type = 'number';
    seedInp.className = 'go-num';
    seedInp.min = 0;
    seedInp.step = 1;
    seedInp.placeholder = '留空 = 0';
    seedInp.title = '固定种子：填回状态栏里报的那个数，就能复现同一张（留空按 0 算）';
    seedInp.setAttribute('aria-label', '固定种子');
    seedInp.oninput = () => {
      const v = Math.floor(Number(seedInp.value));
      g.seed = seedInp.value !== '' && Number.isFinite(v) && v >= 0 ? v : null;
      g.seedMode = 'fixed';
      queueSave();
      paint(false);
      sync();
    };
    seedInp.onchange = () => { commit(); paint(); };
    seedInp.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
    const seedTag = document.createElement('span');
    seedTag.className = 'go-custom-tag';
    seedTag.textContent = '种子';
    seedRow.append(seedTag, seedInp);
    dBox.append(dSeg, seedRow);

    menu.appendChild(foot);
    document.body.appendChild(menu);
    paint();
    placePopMenu(menu, anchor);
    popAnchor = anchor;
    armPopClose(anchor);
  }

  // 底部工具条停在哪：底部居中 / 左下 / 右下 / 顶部居中。
  // 位置写在 #dockWrap 的 data-dock 上，CSS 四条规则各管一处——和生成器面板同一套思路。
  const DOCK_SIDES = [['bottom', '底部居中'], ['left', '左侧居中'], ['right', '右侧居中'], ['top', '顶部居中']];
  function applyDockSide() {
    const wrap = $('#dockWrap');
    if (wrap) wrap.dataset.dock = state.dockSide;
  }
  function setDockSide(side) {
    if (!DOCK_SIDES.some(([k]) => k === side)) return;
    state.dockSide = side;
    try { localStorage.setItem('infisheet-dock-side', side); } catch { /* noop */ }
    applyDockSide();
  }
  function openDockMenu(anchor) {
    closePopMenu();
    const menu = document.createElement('div');
    menu.className = 'popmenu dock-menu';
    menu.onpointerdown = (ev) => ev.stopPropagation();
    const head = document.createElement('div');
    head.className = 'popmenu-title';
    head.textContent = '工具条位置';
    menu.appendChild(head);
    DOCK_SIDES.forEach(([key, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.dock = key;
      b.textContent = label;
      b.classList.toggle('active', state.dockSide === key);
      b.onclick = (ev) => { ev.stopPropagation(); setDockSide(key); closePopMenu(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    placePopMenu(menu, anchor);
    popAnchor = anchor;
    armPopClose(anchor);
  }

  /* ---------------- 风格（Krea2 的 397 个预设） ----------------
   * 素材在 static/styles/（tools/import_styles.py 从素材包导入，只做一次）。
   * index.json 只有分类清单，点开某个分类才拉那一份 —— 397 条提示词加起来 400KB，
   * 不该为了一个按钮在首屏全下下来。
   * 每条风格是一句**模板**：`Style: … Influenced by: … Subject:{prompt}`，
   * 生成时把用户提示词填进 {prompt}，拼好的整句才是真正发给模型的东西。
   */
  const STYLE_BASE = 'styles/';
  let styleCats = null;      // [{id,label,file,count,cover}]
  const stylePacks = {};     // catId → 条目数组（拉过就留着，来回切分类不重下）
  let styleCat = 'anime';    // 上次看的分类：动漫放第一个，用户最常用
  let styleQuery = '';       // 搜索词：非空时跨全部分类找
  let styleSeq = 0;          // 搜索是异步的，回包顺序不保证 —— 只认最后一次

  async function loadStyleIndex() {
    if (styleCats) return styleCats;
    const res = await fetch(`${STYLE_BASE}index.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`风格库读取失败 ${res.status}`);
    styleCats = await res.json();
    return styleCats;
  }

  async function loadStylePack(id) {
    if (stylePacks[id]) return stylePacks[id];
    const cat = (await loadStyleIndex()).find((c) => c.id === id);
    if (!cat) throw new Error('没有这个风格分类');
    const res = await fetch(`${STYLE_BASE}${cat.file}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`读不到「${cat.label}」`);
    stylePacks[id] = await res.json();
    return stylePacks[id];
  }

  // 节点上只存 {cat, i, cn}，不存整条提示词：
  // ① 存进画布存档会把 400 字英文重复一遍；② 风格提示词改了就跟着一起旧。
  async function styleOf(ref) {
    if (!ref || typeof ref !== 'object' || !ref.cat) return null;
    const pack = await loadStylePack(ref.cat).catch(() => null);
    const entry = pack && pack[ref.i];
    return entry ? { ...entry, cat: ref.cat, i: ref.i } : null;
  }

  // 把风格模板套到用户提示词上。模板里没有 {prompt} 就串在前面 ——
  // 丢主体比丢风格严重，别为了「干净」把用户的词扔了。
  function applyStylePrompt(text, entry) {
    const tpl = String((entry && entry.prompt) || '').trim();
    if (!tpl) return String(text || '');
    const subject = String(text || '').trim();
    if (!tpl.includes('{prompt}')) return subject ? `${tpl} ${subject}` : tpl;
    if (!subject) {
      // 只选了风格、没写主体：把「Subject:」这半句一起摘掉，
      // 否则请求里留一个悬空的冒号（模型会把下一句当成主体名）
      return tpl.replace(/[,，;；:]?\s*Subject\s*:\s*\{prompt\}/gi, '')
        .replace(/\{prompt\}/g, '').replace(/[\s,，]+$/, '').trim();
    }
    return tpl.replace(/\{prompt\}/g, subject).trim();
  }

  // 缩略图文件名就是 `<分类>-<序号>.jpg`，序号从 1 开始，而存档里的指针 i 是从 0 开始的
  // （见 tools/import_styles.py 的 `for i, s in enumerate(items, 1)`）。差一位就是另一张图。
  function styleThumbByRef(ref) {
    if (!ref || !ref.cat || !Number.isFinite(Number(ref.i))) return '';
    return `${STYLE_BASE}thumbs/${ref.cat}-${String(Number(ref.i) + 1).padStart(3, '0')}.jpg`;
  }

  // 「风格」这颗按钮：没套用是调色盘 + 文字，套用后直接换成那张风格的缩略图。
  // 光看名字（尤其「动漫风格」「动漫风格 2」这种）分不出画风，缩略图一眼就认得。
  function paintStyleChip(btn, ref) {
    if (!btn) return;
    const on = !!(ref && ref.cn);
    const thumb = on ? styleThumbByRef(ref) : '';
    const ico = btn.querySelector('.gs-ico');
    const name = btn.querySelector('.gs-name');
    if (name) name.textContent = on ? ref.cn : '风格';
    if (ico) ico.innerHTML = thumb ? `<img src="${esc(thumb)}" alt="" draggable="false" />` : icon('palette');
    btn.classList.toggle('on', on);
    btn.classList.toggle('has-thumb', !!thumb);
    btn.title = on ? `已套用风格：${ref.cn}（点一下换掉）`
      : '给这次生成套一个风格：397 个预设（动漫 / 摄影 / 绘画 …）';
  }

  function styleThumbURL(rel) {
    return `${STYLE_BASE}${String(rel || '').replace(/^\.\//, '')}`;
  }

  function openStyleMenu(anchor, n) {
    // 同一个按钮再点一次：收起（自己开的窗口自己关，别在用户脸上反复开关）
    if (popAnchor === anchor && document.querySelector('.style-pop')) { closePopMenu(); return; }
    closePopMenu();
    const pop = document.createElement('div');
    pop.className = 'popmenu style-pop';
    pop.onpointerdown = (ev) => ev.stopPropagation();
    pop.innerHTML = `
      <div class="sp-head">
        <strong>风格</strong><span class="sp-n"></span>
        <button type="button" class="sp-x" title="关闭">×</button>
      </div>
      <input class="sp-q" placeholder="搜索：吉卜力 / watercolor / 赛博朋克…" spellcheck="false" />
      <div class="sp-tabs"></div>
      <div class="sp-body"><div class="sp-grid"></div></div>
      <div class="sp-foot"></div>`;
    document.body.appendChild(pop);
    // 高度得按「按钮上下还剩多少地方」先算好，不能写死：
    // 写死 540 的话，按钮在中部时上下都放不下，placePopMenu 会把它顶到视口顶部，
    // 结果整块压在按钮和生成面板上（e2e 抓到过）。滚动交给 .sp-body。
    const ar = anchor.getBoundingClientRect();
    const gap = 6, edge = 8;
    const spaceBelow = window.innerHeight - ar.bottom - gap - edge;
    const spaceAbove = ar.top - gap - edge;
    const useBelow = spaceBelow >= Math.min(540, spaceAbove);
    pop.style.height = `${Math.max(240, Math.min(540, useBelow ? spaceBelow : spaceAbove))}px`;
    placePopMenu(pop, anchor);
    popAnchor = anchor;        // 顺序别换：placePopMenu 要用 anchor，armPopClose 要认它
    armPopClose(anchor);
    // 每次打开从「上次那个分类的第一页」开始：搜索词留着的话，输入框是空的、列表却是筛过的，
    // 看着像列表丢了东西。分类记住，搜索不记。
    styleQuery = '';
    styleSeq++;

    const tabsEl = pop.querySelector('.sp-tabs');
    const gridEl = pop.querySelector('.sp-grid');
    const countEl = pop.querySelector('.sp-n');
    const qEl = pop.querySelector('.sp-q');
    const footEl = pop.querySelector('.sp-foot');
    const cur = () => (n.gen && n.gen.style) || null;

    const commitStyle = (next) => {
      n.gen.style = next;
      paintStyleChip(anchor, next);
      // 参考图那排也要跟着长/收一格：风格缩略图和参考图并排放，才是「这次真送进去的东西」
      // 的全貌。commit() 只推进撤销栈，不重建面板，所以这里得自己叫一次。
      renderRefs(n);
      queueSave();
      commit();
      closePopMenu();
      flash(next ? `风格：${next.cn}` : '已取消风格');
    };

    const paintTabs = () => {
      tabsEl.innerHTML = '';
      (styleCats || []).forEach((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${c.label} ${c.count}`;
        b.classList.toggle('on', !styleQuery.trim() && c.id === styleCat);
        b.onclick = () => {
          styleCat = c.id;
          styleQuery = '';
          qEl.value = '';
          paintTabs();
          paintGrid();
        };
        tabsEl.appendChild(b);
      });
    };

    const paintFoot = () => {
      footEl.innerHTML = '';
      const r = cur();
      if (r && r.cn) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sp-clear';
        b.textContent = `不用风格（当前：${r.cn}）`;
        b.onclick = () => commitStyle(null);
        footEl.appendChild(b);
      }
      const tip = document.createElement('p');
      tip.className = 'sp-tip-line';
      tip.textContent = '风格会拼在提示词前面：Style: … Subject: 你的提示词';
      footEl.appendChild(tip);
    };

    const render = (list, note) => {
      countEl.textContent = note || `${list.length} 个`;
      gridEl.innerHTML = '';
      if (!list.length) {
        gridEl.innerHTML = '<p class="sp-tip">没有匹配的风格</p>';
        return;
      }
      const frag = document.createDocumentFragment();
      list.forEach((e) => {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'sp-cell';
        cell.title = `${e.name_cn || e.name}\n${e.name}\n\n${String(e.prompt || '').slice(0, 220)}…`;
        const box = document.createElement('div');
        box.className = 'sp-img';     // 固定高度，靠 CSS 撑，不用 aspect-ratio（见 style.css 注释）
        if (e.thumb) {
          const img = document.createElement('img');
          img.src = styleThumbURL(e.thumb);
          img.alt = '';
          img.loading = 'lazy';
          box.appendChild(img);
        }
        cell.appendChild(box);
        const lab = document.createElement('span');
        lab.className = 'sp-name';
        lab.textContent = e.name_cn || e.name;
        cell.appendChild(lab);
        const r = cur();
        if (r && r.cat === e.cat && r.i === e.i) cell.classList.add('on');
        cell.onclick = (ev) => {
          ev.stopPropagation();
          commitStyle({ cat: e.cat, i: e.i, cn: e.name_cn || e.name });
        };
        frag.appendChild(cell);
      });
      gridEl.appendChild(frag);
    };

    async function paintGrid() {
      const q = styleQuery.trim().toLowerCase();
      const mine = ++styleSeq;
      gridEl.innerHTML = '<p class="sp-tip">读取中…</p>';
      try {
        if (q) {
          const cats = await loadStyleIndex();
          const all = [];
          for (const c of cats) {
            const pack = await loadStylePack(c.id).catch(() => []);
            pack.forEach((e, i) => all.push({ ...e, cat: c.id, i, catLabel: c.label }));
          }
          if (mine !== styleSeq) return;       // 又敲了一个字，这批结果作废
          const hit = all.filter((e) => `${e.name_cn} ${e.name} ${e.catLabel}`.toLowerCase().includes(q));
          render(hit, `找到 ${hit.length} 个`);
        } else {
          const pack = await loadStylePack(styleCat);
          if (mine !== styleSeq) return;
          render(pack.map((e, i) => ({ ...e, cat: styleCat, i })), null);
        }
      } catch (err) {
        if (mine !== styleSeq) return;
        gridEl.innerHTML = `<p class="sp-tip">${err.message}</p>`;
      }
    }

    qEl.oninput = () => { styleQuery = qEl.value; paintTabs(); paintGrid(); };
    qEl.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') closePopMenu();
      // 回车 = 直接套用第一个结果：搜的就是想要的，别逼着再挪一次鼠标
      if (ev.key === 'Enter') {
        const first = gridEl.querySelector('.sp-cell');
        if (first) first.click();
      }
    };
    pop.querySelector('.sp-x').onclick = (ev) => { ev.stopPropagation(); closePopMenu(); };

    paintFoot();
    loadStyleIndex().then(() => { paintTabs(); return paintGrid(); })
      .catch((err) => { gridEl.innerHTML = `<p class="sp-tip">${err.message}</p>`; });
  }

  /* ---------------- 面板放大编辑区（独立窗口） ---------------- */
  // 展开键放大的不是那块输入框，是**整个面板**：上排按钮、参考图、提示词、底栏原样搬进
  // 一个居中的大窗口（用户截的绿框是那颗键，红框是整块面板）。不复制 DOM —— 直接把面板
  // 元素挪进去，事件、状态、双向同步全都天然成立；关窗再放回节点里，画布上那块就回来了。
  let bigEditor = null;      // { mask, node, panel, home }

  function closeBigEditor(keepFocus) {
    if (!bigEditor) return;
    const {
      mask, node, panel, home, onInput,
    } = bigEditor;
    bigEditor = null;
    if (panel && onInput) panel.removeEventListener('input', onInput);
    // 放回节点里。节点可能在这期间被重建过（rerenderNode），家没了就直接扔掉这块面板，
    // 否则它会以「无主浮层」的形式留在窗口里
    if (panel) {
      panel.classList.remove('in-big');
      if (home && home.isConnected) home.appendChild(panel);
      else panel.remove();
    }
    mask.remove();
    if (node) {
      queueSave();
      commit();
      if (keepFocus) closeRefMenu();
    }
  }

  function openBigEditor(n) {
    // 同一颗按钮再点一次＝收起（自己开的窗口自己关）
    if (bigEditor && bigEditor.node === n) { closeBigEditor(); return; }
    closeBigEditor();
    const panel = document.querySelector(`.gen-panel[data-panel-for="${CSS.escape(n.id)}"]`);
    if (!panel) return;
    const mask = document.createElement('div');
    mask.className = 'be-mask';
    mask.innerHTML = `
      <div class="be-box" role="dialog" aria-modal="true" aria-label="放大编辑面板">
        <div class="be-head">
          <span class="be-ico">${icon('image')}</span>
          <span class="be-title">${esc(n.title || '图片')}</span>
          <span class="be-dim"></span>
          <span class="be-count"></span>
          <button type="button" class="be-x" title="关闭（Esc）">×</button>
        </div>
        <div class="be-body"></div>
        <div class="be-foot">
          <span class="be-tip">这是同一块面板，改动实时写回画布 · Esc 关闭</span>
          <button type="button" class="be-done">完成</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const home = panel.parentElement;
    const body = mask.querySelector('.be-body');
    const ta = panel.querySelector('.gen-prompt');
    const count = mask.querySelector('.be-count');
    const dim = mask.querySelector('.be-dim');
    body.appendChild(panel);
    panel.classList.add('in-big');
    // 头部补一个「2048 × 1024」：大窗里看不到节点标题行，尺寸得跟着过来
    if (dim && n.dataURL) {
      const probe = new Image();
      probe.onload = () => { dim.textContent = `${probe.naturalWidth} × ${probe.naturalHeight}`; };
      probe.src = n.dataURL;
    }
    // 字数跟着面板里的提示词走（面板自己会在 input 上 absorb，这里只是把数字搬过来）
    const paintCount = () => { if (count) count.textContent = `${promptText(ta).length} 字`; };
    paintCount();
    const onInput = () => paintCount();
    panel.addEventListener('input', onInput);
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      if (refMenu) { closeRefMenu(); return; }   // Esc 先关 @ 菜单，再关窗口
      closeBigEditor(true);
    };
    mask.addEventListener('keydown', onKey);
    mask.addEventListener('pointerdown', (ev) => { if (ev.target === mask) closeBigEditor(); });
    mask.querySelector('.be-x').onclick = () => closeBigEditor();
    mask.querySelector('.be-done').onclick = () => closeBigEditor();
    bigEditor = {
      mask, node: n, panel, home, onInput,
    };
    // 打开就把光标放到末尾：多数人是「接着改」，不是从头写
    requestAnimationFrame(() => {
      ta.focus();
      const r = document.createRange();
      r.selectNodeContents(ta);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    });
  }

  function buildGenPanel(n) {
    // 快照恢复出来的 gen 可能只有部分字段（提示词 / 工作流 / 画幅 / 张数 / 组图），这里补齐默认值。
    // **两件事必须同时做到**：
    // 1. 原地补（不换对象）——正在跑的那次 generateImage 在开头就把 n.gen 存成了局部变量 g，
    //    换对象之后它的状态与轮询句柄全写进一个没人读的旧对象：面板停在「完成 · 26s」，
    //    队列面板的取消也停不掉这次轮询（真机测出来的）。
    // 2. 只补**缺的**字段（`=== undefined`）——用 Object.assign(n.gen, defaults) 会把已有的
    //    gallery / prompt 一起冲掉，多图节点会当场变成空图（e2e 抓到的）。
    const g = n.gen || (n.gen = {});
    const DEFAULTS = {
      prompt: '', wf: pickWorkflow('txt2img'), aspect: '1:1', size: '1k', custom: null,
      batch: 1, seedMode: 'random', seed: null,
      status: '', busy: false, gallery: [], idx: 0, extras: [],
      style: null,   // {cat, i, cn}：只存指针，提示词在 static/styles/ 里按需读
    };
    Object.keys(DEFAULTS).forEach((k) => { if (g[k] === undefined) g[k] = DEFAULTS[k]; });
    // 旧存档里的 preview/standard/hd 换成 1K/2K/4K（口径也从「短边」改成了「长边」）。
    // 'custom' 不在 SIZES 里但它是合法档位：漏判会把用户自己填的宽高悄悄顶回 1K——
    // 「我明明填了 512×512，出来却是 1024×1024」就是这么来的。宽高不全才回落。
    if (g.size === 'custom') {
      // 宽高不全（旧存档 / 手改坏了）才回落，否则 'custom' 会被下面那条当成非法档位
      if (!(g.custom && g.custom.w > 0 && g.custom.h > 0)) g.size = '1k';
    } else if (!SIZES.some((s) => s[0] === g.size)) g.size = OLD_SIZE[g.size] || '1k';
    // 存档里的工作流可能已被删掉/改名：回落到第一个可用工作流，避免点生成才报错
    if (!presetOptions().some((o) => o.id === g.wf)) g.wf = defaultWorkflowId();
    const panel = document.createElement('div');
    // 不再有「加宽面板」这一档：那颗按钮改成开独立放大编辑区了，宽度固定在左右各外扩 20px
    panel.className = 'gen-panel';
    panel.dataset.panelFor = n.id;
    panel.dataset.side = 'bottom';          // 面板固定贴在节点下方（位置按钮已删除）
    panel.onpointerdown = (ev) => ev.stopPropagation();

    const ICON = {
      upload: icon('upload'),
      plus: icon('plus'),
      grid: icon('material'),
      mark: icon('magic'),
      clear: icon('clear'),
      expand: icon('expand'),
      palette: icon('palette'),
      wf: icon('wf'),
      arrow: icon('arrowUpBold'),
    };

    // 顶部 chips
    const chips = document.createElement('div');
    chips.className = 'gen-chips';
    // 动作按钮单独包一层：面板只有 364px 宽，五个按钮横着排不下（「风格」选中后还要
    // 显示中文名），以前是 nowrap + overflow 可见，最后两个按钮直接画到面板外面去了。
    // 换行只发生在这层，两端的「位置」和「展开」保持不动。
    const actions = document.createElement('div');
    actions.className = 'gen-chips-main';
    chips.appendChild(actions);
    const mkChip = (label, icon, fn, title) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.innerHTML = `${icon}<span>${label}</span>`;
      if (title) b.title = title;
      b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      // 点按钮不抢焦点。两个好处：
      // 1. 光标留在提示词框里，选完风格 / 清空之后能接着打字（原来点一下就丢了光标）；
      // 2. 不会挂上 `button:focus-visible` 那圈蓝色方框 —— 用户截图里那颗「多出来的框」
      //    就是它。键盘用户 Tab 过来照样有焦点圈，那才是该看见圈的时候。
      b.addEventListener('pointerdown', (ev) => ev.preventDefault());
      actions.appendChild(b);
      return b;
    };
    mkChip('上传', ICON.plus, () => pickImage(n), '上传本地图片到这个节点');
    mkChip('画布素材', ICON.grid, () => {
      const src = state.nodes.find((x) => x.type === 'image' && x.id !== n.id && x.dataURL);
      if (!src) { flash('画布上还没有其他图片可用'); return; }
      n.dataURL = src.dataURL;
      n.uploaded = null;
      rerenderNode(n.id);
      queueSave();
      flash('已取用画布上的图片');
    }, '把画布上已有的图片取过来');
    mkChip('清空', ICON.clear, () => {
      g.prompt = '';
      const ta = panel.querySelector('.gen-prompt');
      if (ta) { fillPrompt(ta, '', n); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      queueSave(); commit();
    }, '清空下面的提示词');
    // 风格：放在「清空」后面（对齐参考图里那一格）。选了就把 Style 模板拼到提示词前面，
    // 按钮直接显示中文风格名，一眼能看出这张图带着什么风格在跑。
    const styleBtn = mkChip('风格', ICON.palette, () => openStyleMenu(styleBtn, n), '给这次生成套一个风格');
    styleBtn.classList.add('gen-style');
    // 图标与名字分成两个 span：paintStyleChip 要把左边那颗换成风格的缩略图
    styleBtn.innerHTML = `<span class="gs-ico">${ICON.palette}</span><span class="gs-name">风格</span>`;
    paintStyleChip(styleBtn, g.style);
    // 展开：不再「把面板加宽 60px」（那点宽度解决不了长提示词），改成单开一块放大的编辑区
    const expand = document.createElement('button');
    expand.className = 'chip icon-only';
    expand.innerHTML = ICON.expand;
    expand.title = '把整个面板放到大窗口里编辑';
    expand.onclick = (ev) => {
      ev.stopPropagation();
      openBigEditor(n);
    };
    chips.appendChild(expand);
    panel.appendChild(chips);

    // 大输入框
    const upstreamText = state.links.filter((l) => l.to === n.id && l.toKey === 'in')
      .map((l) => getNode(l.from)).find((x) => x && x.type === 'text');
    // 参考图缩略图：连线进来的 / @ 引用的，都摆在提示词上方（对齐参考图里那排缩略图）
    buildRefsStrip(n, panel);
    // 提示词用 contenteditable：`@[名字]` 要渲染成内联缩略图胶囊，textarea 做不到。
    // 对外仍是纯文本（promptText 把胶囊还原成 @[名字]），存档 / 提交 / refMarks 都不变。
    const ta = document.createElement('div');
    ta.className = 'gen-prompt';
    ta.contentEditable = 'true';
    ta.spellcheck = false;
    ta.setAttribute('role', 'textbox');
    ta.setAttribute('aria-multiline', 'true');
    ta.dataset.ph = upstreamText
      ? '（提示词来自左侧文本节点，这里再写内容不会覆盖它）'
      : '可直接文字生图，或上传图片后输入指令对图片进行编辑，如：将背景改为雪夜；输入 @ 可引用画布上的图片';
    fillPrompt(ta, g.prompt || '', n);
    // 提示词超出可视高度时给底部加渐隐：否则最后一行被硬切一半，很像「排版坏了」
    const syncPromptOverflow = () => {
      ta.classList.toggle('has-more', ta.scrollHeight - ta.scrollTop - ta.clientHeight > 4);
      // contenteditable 没有 ::placeholder，退回 :empty + ::before；空内容时清掉浏览器留下的 <br>
      const empty = !promptText(ta).length;
      if (empty && ta.innerHTML && !ta.contains(document.activeElement)) ta.innerHTML = '';
      ta.classList.toggle('is-empty', empty);
    };
    const absorb = () => {
      g.prompt = promptText(ta);
      // 把胶囊删掉 = 取消这张参考图：缩略图要跟着消失，别留一张「看不见的参考图」
      if (g.extras && g.extras.length) {
        const label = refLabelFn(n);
        const keep = g.extras.filter((id) => {
          const src = getNode(id);
          return !src || g.prompt.includes(`@[${label(src)}]`);
        });
        if (keep.length !== g.extras.length) { g.extras = keep; renderRefs(n); }
      }
      queueSave();
      syncPromptOverflow();
    };
    ta.oninput = () => {
      absorb();
      detectAtMention(ta, n);      // 输入 @ 时弹出画布图片列表
    };
    ta.onkeydown = (ev) => {
      // 回车统一插 <br>：默认行为会包一层 <div>，正文里混满块级元素后光标和选区都不听话
      if (ev.key === 'Enter' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        closeRefMenu();
        document.execCommand('insertLineBreak');
        absorb();
        return;
      }
      if (ev.key === 'Escape' && refMenu) { ev.preventDefault(); ev.stopPropagation(); closeRefMenu(); return; }
      if (ev.key === 'Backspace' || ev.key === 'Delete') closeRefMenu();
    };
    // 只收纯文本：带格式的 HTML 粘进来会插一堆 <span style=…>，胶囊会被冲散
    ta.addEventListener('paste', (ev) => {
      const dt = ev.clipboardData || window.clipboardData;
      const txt = dt ? dt.getData('text/plain') : '';
      if (txt == null) return;
      ev.preventDefault();
      document.execCommand('insertText', false, txt);
      absorb();
    });
    ta.addEventListener('focus', () => { if (refMenu && refMenu.el !== ta) closeRefMenu(); });
    // 失焦只存档，不关 @ 菜单：点菜单项必然先触发 blur，这里关掉就把要点的那个按钮删了
    ta.onblur = () => commit();
    ta.addEventListener('scroll', syncPromptOverflow, { passive: true });
    panel.appendChild(ta);
    requestAnimationFrame(syncPromptOverflow);
    // 面板默认 display:none（选中才显示），建的时候量不到高度：尺寸一变就重新判断
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncPromptOverflow).observe(ta);

    // 底部控制栏
    const bar = document.createElement('div');
    bar.className = 'gen-bar';

    // 原生 select 在 #world 的 transform 里弹层会被裁/错位，统一换自绘菜单
    const mkMenu = (iconSvg, optsIn, cur, onPick, placeholder, extras) => {
      const resolve = () => (typeof optsIn === 'function' ? optsIn() : optsIn);
      const box = document.createElement('label');
      box.className = 'gensel';
      if (iconSvg) {
        const i = document.createElement('span');
        i.className = 'gensel-icon';
        i.innerHTML = iconSvg;
        box.appendChild(i);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gm-btn';
      const txt = document.createElement('span');
      const caret = document.createElement('i');
      caret.className = 'gm-caret';
      btn.append(txt, caret);
      let current = cur;
      const setLabel = (v) => {
        const list = resolve();
        const hit = list.find(([val]) => String(val) === String(v));
        txt.textContent = hit ? hit[1] : (list[0] ? list[0][1] : (placeholder || '（空）'));
        btn.title = txt.textContent;
      };
      setLabel(current);
      btn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const list = resolve();          // 每次打开都取最新列表：新加的预设/库工作流立刻出现
        if (!list.length && !(extras && extras.length)) return;
        const items = list.map(([val, text, menuText]) => [menuText || text, () => {
          current = val;
          setLabel(val);
          onPick(val);
        }, String(val) === String(current) ? 'active' : '']);
        (extras || []).forEach(([label, fn]) => items.push([label, fn, 'add']));
        openPopMenu(btn, items);
      };
      box.appendChild(btn);
      return box;
    };

    const wfBox = mkMenu(ICON.wf,
      () => presetOptions().map((o) => [o.id, o.label, `${o.catLabel} · ${o.label}`]),
      g.wf || defaultWorkflowId(),
      (v) => { g.wf = v; g.wfAuto = false; queueSave(); commit(); },   // 手选过就别再自动换
      '（没有可用工作流）');
    wfBox.classList.add('wfsel');
    bar.appendChild(wfBox);   // 工作流放在最左，后面接画幅 / 尺寸 / 张数（同一行）

    // 参数胶囊：画幅 · 清晰度 · 张数 全在这一颗里，点开是分组弹层
    const optBox = document.createElement('div');
    optBox.className = 'gensel optsel';
    const optBtn = document.createElement('button');
    optBtn.type = 'button';
    optBtn.className = 'gm-btn';
    const optGlyph = document.createElement('i');
    optGlyph.className = 'go-glyph';
    const optSum = document.createElement('span');
    optSum.className = 'go-sum';
    const optCaret = document.createElement('i');
    optCaret.className = 'gm-caret';
    optBtn.append(optGlyph, optSum, optCaret);
    optBox.appendChild(optBtn);

    const syncOpts = () => {
      const d = calcDims(g.aspect, g.size, g.custom);
      // 自定义尺寸（扩图拖出来的就是这个）时，方块要按**实际宽高**画：
      // 还挂 g.aspect 的话会出现「写着 1344×1200、旁边却是个 1:1 的方疙瘩」。
      const [w, h] = ratioGlyph(g.size === 'custom' ? `${d.width}:${d.height}` : g.aspect, 12, 12);
      optGlyph.style.width = `${w}px`;
      optGlyph.style.height = `${h}px`;
      // 自定义时直接报像素：这时候「1K/2K/4K」已经说明不了什么了
      optSum.textContent = g.size === 'custom'
        ? `${d.width}×${d.height} · ${g.batch}张`
        : `${g.aspect} · ${sizeLabel(g.size)} · ${g.batch}张`;
      optBtn.title = `画幅 / 清晰度 / 张数 / 种子（当前 ${g.aspect} · ${d.width}×${d.height} · ${g.batch} 张`
        + (g.seedMode === 'fixed' ? ` · 固定种子 ${g.seed == null ? '未填' : g.seed}` : ' · 每次随机种子') + '）';
    };
    syncOpts();
    // 扩图拖锚点时要在不重建面板的前提下刷新这颗胶囊（重建立刻丢焦点/丢拖动）
    panel._syncOpts = syncOpts;
    optBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (popAnchor === optBtn) { closePopMenu(); return; }   // 再点一次收起
      openGenOpts(optBtn, g, syncOpts);
    };
    bar.appendChild(optBox);
    const status = document.createElement('span');
    status.className = 'gen-status';
    status.textContent = g.status || '';
    bar.appendChild(status);

    const run = document.createElement('button');
    run.className = 'gen-run';
    run.innerHTML = ICON.arrow;
    run.title = '生成（Enter 也可）';
    run.disabled = !!g.busy;
    if (g.busy) run.classList.add('busy');
    run.onclick = (ev) => { ev.stopPropagation(); generateImage(n); };
    bar.appendChild(run);

    panel.appendChild(bar);

    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); generateImage(n); }
    });

    return panel;
  }

  // 图片中央那行字：排队时明说排队，有百分比就报数字。
  // 以前查不到进度一律写「生成中…」——队列里排着的时候也这么说，看着像卡住了。
  // 0% 也不报：2048² 上采样器的第一步要跑七八秒，这期间一直挂着「0%」像卡死，
  // 而进度条自己已经从 2% 起画了，眼睛能看出它动过。
  // 写成 function 声明不是为了好看：e2e 的 pickFn 只认 `function name(`，箭头函数抠不出来。
  function pctText(p) {
    return typeof p === 'number' && p > 0 ? ` ${p}%` : '';
  }

  function genOverlayText(n, pctOverride) {
    // 传进来的不是数字（null/undefined）就退回节点上记着的那个：调用方「这一拍没新数字」
    // 不代表画面上该把已知的百分比抹掉。
    const pct = typeof pctOverride === 'number'
      ? pctOverride
      : (typeof n.progress === 'number' ? n.progress : null);
    if (typeof pct === 'number' && pct > 0) return `生成中 ${pct}%`;
    const phase = n.gen && n.gen.job ? n.gen.job.phase : '';
    return phase === 'queued' ? '排队中…' : '生成中…';
  }

  // 只刷新面板上的尺寸胶囊（画幅 / 清晰度 / 张数那一颗），不重建整个面板：
  // 扩图拖锚点时每帧都要改尺寸，重建面板会当场把拖动打断、把提示词的光标掀掉。
  function syncGenOpts(n) {
    const el = document.querySelector(`[data-panel-for="${CSS.escape(n.id)}"]`);
    if (el && typeof el._syncOpts === 'function') el._syncOpts();
  }

  function refreshGenPanel(n) {
    const el = document.querySelector(`[data-panel-for="${CSS.escape(n.id)}"]`);
    if (!el) return;
    const st = el.querySelector('.gen-status');
    if (st) { st.textContent = n.gen.status || ''; st.title = n.gen.status || ''; }
    const btn = el.querySelector('.gen-run');
    if (btn) {
      btn.disabled = !!n.gen.busy;
      btn.classList.toggle('busy', !!n.gen.busy);
    }
    // 生成中：图片上盖一层「生成中 42%」。显隐和 paintProgress 用**同一个**判据，
    // 否则两边一打架就会出现「迟到的 tick 把遮罩重新点亮」或「完成的 100% 被提前收掉」。
    const ov = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .gen-overlay`);
    if (ov) {
      const shown = overlayVisible(n);
      ov.classList.toggle('hidden', !shown);
      if (shown) {
        const label = ov.querySelector('.gen-overlay-text');
        if (label) label.textContent = genOverlayText(n);
      }
    }
  }

  async function generateImage(n) {
    // 纯图片节点没有 gen，也就没有生成面板；走到这里说明有人在没面板的情况下点了生成
    // （以前这里会直接 g.busy 崩在空指针上）。给它一句话，别让它以为点了没反应。
    if (!n.gen) { flash('这个节点只放图：点标题上的「生成」把面板打开再生成'); return; }
    const g = n.gen;
    if (g.busy) return;
    // 自动重试复用同一条队列记录：否则每重试一次就多一行，用户会以为提交了好几遍
    const keepJob = g.jobReuse && g.job ? g.job : null;
    g.jobReuse = false;
    g.retried = 0;          // 手动发起的一次生成，重置「已自动重试」标记
    if (!g.wf) { flash('先在面板里选一个工作流'); return; }
    // 扩图：先把边框烘成像素 + 遮罩，再走后面那条完全不懂扩图的生成流程。
    // 必须排在「取参考图 / 算遮罩」前面——它换的正是这两样东西。
    if (outpaintOn(n)) await bakeOutpaint(n);
    // 上游：文本当提示词；图片当参考图（也可以挂在这条文本节点上，随它一起送进来）
    const inLinks = state.links.filter((l) => l.to === n.id && l.toKey === 'in')
      .map((l) => getNode(l.from)).filter(Boolean);
    const textIn = inLinks.find((x) => x.type === 'text');
    const rawPrompt = (textIn ? (textIn.value || '') : g.prompt) || '';
    // 风格：把模板套在提示词外层（Style: … Subject: 你的词）。这里必须 await ——
    // 风格提示词不在节点上、而是要按需从 styles/ 读，读不到就照常生成（不能因为风格库挂了就不出图）。
    let styleEntry = null;
    if (g.style && g.style.cat) {
      styleEntry = await styleOf(g.style).catch(() => null);
      if (!styleEntry) flash(`风格「${g.style.cn || g.style.cat}」读不到了，这次按无风格生成`);
    }
    const promptText = styleEntry ? applyStylePrompt(rawPrompt, styleEntry) : rawPrompt;
    // 只选了风格、没写提示词也能出图（模板本身就是完整的提示词）
    if (!promptText.trim()) { flash(textIn ? '左侧文本节点是空的' : '先写提示词'); return; }
    // 参考图全上传（能传几张算几张）。以前只传第一张：用户 @ 了两张，第二张根本进不去，
    // 提示词里还留着指代——「@ 的图识别不准」有一半是这里。
    const refs = refsOf(n);
    const labelOf = refLabelFn(n);
    const picked = [];
    for (const r of refs) {
      try {
        const name = await ensureUploaded(r.node);
        if (name) picked.push({ node: r.node, name, label: labelOf(r.node) });
      } catch { /* 这张传不上去就跳过，别把整次生成拖垮 */ }
    }
    // 节点自己的图也当参考图（图就摆在这个节点上，没有连线的那种）
    if (!picked.length && n.dataURL) {
      try {
        const name = await ensureUploaded(n);
        if (name) picked.push({ node: n, name, label: labelOf(n) });
      } catch { /* 纯文生图 */ }
    }
    // 遮罩：涂过就必须让这张图进模型，否则等于白涂。
    // 它是 unshift 进 picked 的第一张——工作流的第一个 image 插槽拿到它，
    // 而它本身就是「原图 + alpha」，所以图和遮罩天然配对，不存在两个文件错位的可能。
    const mdoc = maskDocOf(n);
    const needMask = !!(mdoc && mdoc.strokes.length && n.dataURL);
    if (!reconcileWorkflow(n, picked, needMask)) return;
    if (needMask) {
      try {
        const name = await uploadMaskedImage(n, mdoc);
        if (name) picked.unshift({ node: n, name, label: labelOf(n) });
      } catch (err) {
        flash(`遮罩上传失败：${err.message}`);
        return;
      }
    }
    // 自动挑的工作流按「有没有参考图」纠正一次：有图走图生图，没图走文生图。
    // 这段逻辑已经挪进 reconcileWorkflow（上面调用），因为它必须先和遮罩对齐——
    // 分两处判断时，遮罩那边切到「局部重绘」，这边又按分类切回去，最后涂了等于没涂。
    g.busy = true; g.status = '准备工作流…'; refreshGenPanel(n);
    // 队列条目在这里就建：上传参考图、分析工作流、构建图都有可能失败，
    // 那些失败同样要能在队列里看到（否则「点了生成没反应」查无实据）。
    g.job = keepJob || newJob(n, 'image', { wf: g.wf, title: rawPrompt });
    patchJob(g.job, { phase: 'running', note: '准备中' });
    try {
      const graph = await loadGraphById(g.wf);
      if (!graph) throw new Error('工作流为空');
      const a = await postJson('/api/analyze', { graph });
      // 分析这一步也要几十毫秒到几秒：取消可能就发生在这里
      if (g.job && g.job.phase === 'canceled') { g.busy = false; return; }
      const dims = calcDims(g.aspect, g.size, g.custom);
      // 工作流能吃几张图（Qwen 编辑流是 images.image_1..4）就用几张；一张都不吃就退回纯文本，
      // 这时提示词里的 @ 引用照样摘掉——不能给模型指一张它根本没拿到的图。
      const cap = (a.slots || []).filter((s) => s.kind === 'image').length;
      const use = cap > 0 ? picked.slice(0, cap) : [];
      const prompt = refMarks(promptText, use);   // @[甲] → 图1，和送进去的顺序一一对应
      if (!prompt) throw new Error('提示词里只有 @ 引用，没有文字');
      const built = buildGenGraph(graph, a.slots, dims, Number(g.batch) || 1, prompt, use.map((x) => x.name),
        { mode: g.seedMode, value: g.seed });
      const res = await postJson('/api/run', { graph: built.graph });
      if (!res.ok) throw new Error(JSON.stringify(res.error || {}).slice(0, 180));
      // 取消发生在「提交请求已经发出」这段缝里：图确实进了 ComfyUI 队列，得再撤一次，
      // 否则用户点了取消，画布上过一会儿还是冒出一张图。
      if (g.job && g.job.phase === 'canceled') {
        await postJson('/api/queue/cancel', { prompt_id: res.prompt_id }).catch(() => {});
        g.busy = false;
        return;
      }
      // 把这次真正用到的种子记到生成器上：切「固定」时直接复用它就能复现这一张。
      // 注意别再往 n.values 里塞——那是**工作流节点**的插槽值表，图片节点根本没有这个字段，
      // 写了就是 `Cannot set properties of undefined`：图已经在队列里跑了，面板却报「失败」。
      if (built.seed && built.seed.keys.length) {
        g.seed = built.seed.value;
        queueSave();
      }
      // 参考图用了几张要说清楚：工作流只吃 1 张时，第 2 张起白给了
      const refNote = built.refs.count > 1 ? ` · 参考 ${built.refs.count} 张`
        : !built.refs.count && picked.length ? ' · 参考图未使用（工作流没有图片插槽）'
          : picked.length > built.refs.count ? ` · 参考 1/${picked.length}（工作流只吃 1 张）`
            : '';
      // 工作流自带的多余参考图被摘掉了，得说清楚——否则用户会以为模型"自己"变干净了
      if (built.pruned && built.pruned.length) {
        const uniq = [...new Set(built.pruned)];
        flash(`已忽略工作流自带的 ${built.pruned.length} 张图：${uniq.slice(0, 2).join('、')}${uniq.length > 2 ? ' 等' : ''}`);
      }
      const pruneNote = built.pruned && built.pruned.length ? ` · 忽略自带图 ${built.pruned.length}` : '';
      // 提示词以前会被写进拼接器的空转参数（用户写的话一个字都没进模型，出来的全是
      // 工作流自带文本）——这种事在界面上是看不出来的，所以落点纠正过就报一句。
      // 状态栏窄且会截断，完整内容在 title 里（refreshGenPanel 每帧同步）。
      const promptNote = built.prompt && built.prompt.corrected ? ` · 提示词→${built.prompt.node}` : '';
      // 种子必须报出来：想复现某一张就切「固定」把它填回去，不然这个数没处找
      const seedNote = built.seed ? ` · 种子 ${built.seed.value}` : '';
      // 有些工作流根本没有宽高输入（视频模型、固定尺寸的二次采样链）：别让人以为面板上那个数生效了
      const sizeNote = built.sized ? '' : ' · 尺寸由工作流决定';
      // 张数同理：选了 4 张却没有批量插槽时必须说出来，否则「只出 1 张」会被当成多图生成坏了
      const batchNote = built.batch && built.batch.value > 1
        ? (built.batch.applied ? ` · ${built.batch.value} 张` : ' · 张数不生效（这张工作流没有批量插槽）')
        : '';
      // 风格：拼进提示词的英文模板在画布上是看不见的，不说一句用户会以为「我明明选了风格」
      const styleNote = styleEntry ? ` · 风格 ${(g.style && g.style.cn) || styleEntry.name_cn || ''}` : '';
      g.pid = res.prompt_id;
      g.status = `排队中 · ${dims.width}×${dims.height}${batchNote}${seedNote}${refNote}${pruneNote}${promptNote}${sizeNote}${styleNote}`;
      // 队列条目补上「多大、跑到哪一步」：条目在建的时候还不知道工作流吃不吃尺寸
      patchJob(g.job, {
        phase: 'queued', pid: res.prompt_id, progress: null, note: '',
        wf: wfLabel(g.wf), dims: `${dims.width}×${dims.height}`,
      });
      refreshGenPanel(n);
      resetProgress(n);            // 新一轮开始，把上一次的数字清掉
      // 轮询句柄挂在**任务**上（不是节点或 gen 上）：任务对象的身份是稳定的，
      // 面板重建、gen 被拷贝都不会让它丢，取消时一定能停掉这一次轮询。
      g.job.poll = pollPrompt(res.prompt_id,
        (label, secs, p) => {
          // 「这一拍没数字」不等于「没有百分比」：排队中、ws 还没到第一个采样器、换采样器
          // 的那一瞬间，服务端都会短暂报不出数，可上一次的 42% 仍然成立。状态行必须用
          // 「最新已知」的那个数去拼，否则它会在「生成中 42% · …」和「生成中 · …」之间
          // 来回跳——用户看到的就是「百分比会消失」（遮罩那边早就做了同样的沿用，
          // 只有这一行和队列条目还在用当拍的 p，所以只消失半秒又回来）。
          const pct = typeof p === 'number' ? p : (typeof n.progress === 'number' ? n.progress : null);
          g.status = `${label}${pctText(pct)} · ${dims.width}×${dims.height}${batchNote}${seedNote}${refNote}${pruneNote}${promptNote}${sizeNote}${styleNote} · ${secs}s`;
          setProgress(n, p);
          patchJob(g.job, { phase: label === '排队中' ? 'queued' : 'running', progress: pct, secs });
          refreshGenPanel(n);
        },
        async (arts, err, secs) => {
          g.busy = false;
          if (err) {
            clearProgress(n);
            const c = classifyGenError(err);
            // 连接/超时类自动重试一次：ComfyUI 卡一下、代理抖一下，重试往往就好了；
            // 显存/模型/工作流这三类重试一百次也一样，只报原因。
            if (c.retry && !g.retried) {
              g.retried = 1;
              g.jobReuse = true;          // 同一条队列记录继续用它
              g.status = `${c.title} · 自动重试一次…`;
              patchJob(g.job, { phase: 'queued', note: '自动重试一次' });
              refreshGenPanel(n);
              setTimeout(() => { generateImage(n); }, 800);
              return;
            }
            g.retried = 0;
            g.status = `${c.title}：${err}${c.hint ? ' · ' + c.hint : ''}`;
            finishJob(g.job, 'error', c.title);
            refreshGenPanel(n);
            return;
          }
          g.retried = 0;
          const imgs = arts.filter((x) => x.kind === 'image');
          if (!imgs.length) {
            clearProgress(n);
            g.status = `完成 · ${secs}s（无图片，检查工作流是否有保存节点）`;
            finishJob(g.job, 'done', '无图片');
            refreshGenPanel(n);
            return;
          }
          // 先把**上一批图**结算成一条历史（老存档没有 runs 时靠这一步迁移），再覆盖 gallery。
          // 反过来做的话，迁移会把这次刚出的图当成「更早的一次」，和下面 pushRun 那条重复——
          // 一次生成就在角标上写成「2 次」（实测踩到过：历史里两条指向同一个 krea2_0002x.png）。
          runsOf(n);
          g.gallery = imgs.map((x) => ({ url: artifactURL(x), filename: x.filename, subfolder: x.subfolder, type: x.type }));
          g.idx = 0;
          n.dataURL = g.gallery[0].url;
          n.uploaded = null;
          // 每生成一次留一条历史。以前 gallery 是覆盖式的，试到第 5 版就再也回不到第 4 版；
          // 这里记的是「这次用的什么参数、出了哪几张」，gallery 仍然是「当前显示的那一批」。
          pushRun(n, {
            at: Date.now(), prompt: rawPrompt || '', seed: built.seed ? built.seed.value : null,
            w: dims.width, h: dims.height, batch: Number(g.batch) || 1, wf: g.wf || '',
            // 风格记成和节点上一样的 {cat,i,cn}：派生 / 复现时能原样套回去，
            // 光记一个中文名就只能看了
            style: g.style ? { ...g.style } : null,
            items: g.gallery.slice(),
          });
          g.status = `完成 · ${secs}s · ${imgs.length} 张`;
          // 面板上选了 4 张、图里只回来 1 张：这不是"多图生成坏了"，而是**图提交上去了、
          // 工作流自己把批量抹平了**（二次采样链、ImageBatch、单张后处理之类）。不吭声的话
          // 用户只会反复重试；说清楚，才知道该去改工作流还是改面板。
          const short = batchShortfall(built.batch && built.batch.value, imgs.length);
          if (short) {
            g.status = `完成 · ${secs}s · ${short.note}`;
            flash(`提交了 ${short.want} 张，只回来 ${short.got} 张：工作流里某个节点把批量并成了一路`);
          }
          finishJob(g.job, 'done', `${imgs.length} 张`);
          finishProgress(n);
          rerenderNode(n.id, true);
          queueSave();
        });
    } catch (err) {
      g.busy = false;
      clearProgress(n);
      g.status = `失败：${err.message}`;
      // 还没提交到 ComfyUI 就失败（分析/构建阶段）：队列里留一条失败记录，
      // 否则「点了生成、什么都没发生」在队列面板上查不到任何痕迹。
      finishJob(g.job, 'error', err.message.slice(0, 40));
      refreshGenPanel(n);
    }
  }

  function buildOutBody(n) {
    const wrap = document.createElement('div');
    const arts = n.artifacts || [];
    if (arts.length) {
      const grid = document.createElement('div');
      grid.className = 'results';
      arts.forEach((a) => grid.appendChild(buildArtifact(n, a)));
      wrap.appendChild(grid);
      const info = document.createElement('div');
      info.className = 'empty';
      info.style.marginTop = '7px';
      info.textContent = `${arts.length} 个结果 · ${n.statusText || ''}`;
      wrap.appendChild(info);
    } else {
      const ph = document.createElement('div');
      ph.className = 'out-empty';
      ph.textContent = n.linked ? '等待生成…' : '把工作流节点右侧的圆点连到这里';
      wrap.appendChild(ph);
    }
    return wrap;
  }

  // ---------- 工作流设置抽屉：参数不铺在节点上，集中在这里改 ----------
  let slotSheetNode = null;

  function closeSlotSheet() {
    slotSheetNode = null;
    const el = document.getElementById('slotSheet');
    if (el) el.remove();
  }

  // ---------- 历史画布 ----------
  function closeCanvasHistory() {
    const el = document.getElementById('canvasHistory');
    if (el) el.remove();
  }

  function fmtHistTime(it) {
    const ms = it.savedAt && it.savedAt > 1e12 ? it.savedAt : (it.mtime || 0) * 1000;
    if (!ms) return '未知时间';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function openCanvasHistory() {
    closeCanvasHistory();
    const box = document.createElement('div');
    box.id = 'canvasHistory';
    box.innerHTML = '<div class="sheet"><header><strong>历史画布</strong><button type="button" class="x" title="关闭">×</button></header><div class="hist-body">加载中…</div></div>';
    box.querySelector('.x').onclick = closeCanvasHistory;
    box.onclick = (ev) => { if (ev.target === box) closeCanvasHistory(); };
    document.body.appendChild(box);
    const body = box.querySelector('.hist-body');
    let res = null;
    try { res = await api('/api/canvas/history'); } catch { /* 离线 */ }
    const items = (res && res.items) || [];
    body.innerHTML = '';
    if (!items.length) {
      body.innerHTML = '<p class="tip">还没有历史快照。继续编辑一会儿，自动保存会按分钟留档。</p>';
      return;
    }
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'hist-row';
      row.innerHTML = '<div class="meta"><b>' + esc(it.name || '未命名画布') + '</b><span>' + fmtHistTime(it) + ' · ' + it.nodes + ' 节点 · ' + it.links + ' 连线</span></div>';
      const btn = document.createElement('button');
      btn.textContent = '恢复';
      btn.onclick = async () => {
        if (!confirm('恢复到 ' + fmtHistTime(it) + ' 的快照？当前进度会先自动保存。')) return;
        await saveToServer();
        try {
          const r = await api('/api/canvas/history/' + encodeURIComponent(it.file));
          if (!r.ok || !r.canvas) throw new Error(r.error || '读取失败');
          load(r.canvas); commit(); queueSave(); closeCanvasHistory();
          flash('已恢复到所选快照');
        } catch (e) { flash('恢复失败：' + e.message); }
      };
      row.appendChild(btn);
      body.appendChild(row);
    });
  }
  /* ---------------- 资产管理 ----------------
   * 「用过的图」以前散在三处：画布节点上、生成器节点的 gallery 里、ComfyUI 的 output/ 里。
   * 换个画布就再也找不回来。这里把它们汇到一块：当前画布上的图 + ComfyUI 历史里
   * 的生成结果 + 历史上传过的素材（LoadImage 引用过的）。
   * 只做索引，不复制文件——本地一个 4096 的 png 就 10MB 起，复制等于把磁盘翻倍。
   */
  let assetItems = null;          // null=还没拉过；数组=已加载
  let assetTab = 'all';
  let assetQuery = '';

  function closeAssetSheet() {
    const el = document.getElementById('assetPane');
    if (el) el.remove();
  }

  // 当前画布上的图：节点的图 + 生成器节点的整组结果（其余几张也要能找回来）
  function canvasAssets() {
    const out = [];
    const seen = new Set();
    state.nodes.forEach((n) => {
      if (n.type !== 'image') return;
      const put = (url, filename) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        out.push({ url, filename: filename || n.title || '画布图片', source: 'canvas', subfolder: '', type: '', node: n.id });
      };
      ((n.gen && n.gen.gallery) || []).forEach((g) => put(g.url, g.filename));
      put(n.dataURL, n.title);
    });
    return out;
  }

  async function loadAssets(force) {
    if (assetItems && !force) return assetItems;
    const res = await api('/api/assets?limit=400' + (force ? '&refresh=1' : '')).catch(() => null);
    const remote = (res && res.items) || [];
    assetItems = [...canvasAssets(), ...remote];
    return assetItems;
  }

  function assetFiltered() {
    const q = assetQuery.trim().toLowerCase();
    return (assetItems || []).filter((it) => {
      if (assetTab !== 'all' && it.source !== assetTab) return false;
      if (q && !String(it.filename || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function putAssetOnCanvas(item) {
    const c = centerOfView();
    const title = String(item.filename || '图片').replace(/\.[a-z0-9]{1,5}$/i, '') || '图片';
    const node = addImageNode(
      Math.round(c.x - 170 + (Math.random() - 0.5) * 60),
      Math.round(c.y - 130 + (Math.random() - 0.5) * 60),
      // 上传素材本来就在 ComfyUI 的 input/ 里：直接记名字，别为了同一张图再传一遍。
      // 生成结果在 output/ 里，不能当成已上传——ComfyUI 的 LoadImage 只认 input/。
      { dataURL: item.url, title, uploaded: item.source === 'input' ? item.filename : null },
    );
    if (item.source === 'input') node.subfolder = item.subfolder || '';
    flash(`已放入画布：${title}`);
  }

  async function openAssetSheet() {
    if (document.getElementById('assetPane')) { closeAssetSheet(); return; }
    const box = document.createElement('div');
    box.id = 'assetPane';
    box.innerHTML = `
      <aside class="asset-pane" role="dialog" aria-label="资产">
        <header>
          <strong>资产</strong>
          <span class="asset-n"></span>
          <button type="button" class="x" title="关闭（Esc）">×</button>
        </header>
        <div class="asset-bar">
          <input class="asset-q" placeholder="搜索文件名…" spellcheck="false" />
          <div class="asset-tabs">
            <button type="button" data-k="all" class="on">全部</button>
            <button type="button" data-k="output">生成</button>
            <button type="button" data-k="canvas">画布</button>
            <button type="button" data-k="input">上传</button>
          </div>
          <button type="button" class="asset-reload" title="重新读取 ComfyUI 的历史">刷新</button>
        </div>
        <div class="asset-grid"><p class="asset-tip">读取中…</p></div>
        <p class="asset-hint">单击看大图（可翻页） · 双击或点右上「＋」放入画布</p>
      </aside>`;
    document.body.appendChild(box);
    box.querySelector('.x').onclick = closeAssetSheet;

    const grid = box.querySelector('.asset-grid');
    const nEl = box.querySelector('.asset-n');
    const q = box.querySelector('.asset-q');

    const paint = () => {
      const list = assetFiltered();
      const total = (assetItems || []).length;
      nEl.textContent = list.length === total ? `${total} 项` : `${list.length} / ${total} 项`;
      grid.innerHTML = '';
      if (!list.length) {
        grid.innerHTML = `<p class="asset-tip">${assetQuery ? '没有匹配的文件' : '还没有资产：生成一张图、或上传一张图就会出现在这里'}</p>`;
        return;
      }
      list.forEach((item, i) => {
        // 用 div 而不是 button：格子尺寸靠 CSS 的 height:0 + padding-bottom:100% 撑正方形，
        // button 在 Chromium 里是表单控件（内部强制 flow-root），这套撑高法不可靠。
        const cell = document.createElement('div');
        cell.className = 'asset-cell';
        cell.setAttribute('role', 'button');
        cell.tabIndex = 0;
        cell.title = `${item.filename}\n${item.source === 'canvas' ? '画布上的图' : item.source === 'input' ? '上传素材（ComfyUI input/）' : '生成结果（ComfyUI output/）'}`;
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = '';
        img.loading = 'lazy';
        const name = document.createElement('span');
        name.className = 'asset-name';
        name.textContent = item.filename || '（未命名）';
        const badge = document.createElement('span');
        badge.className = `asset-badge ${item.source}`;
        badge.textContent = item.source === 'canvas' ? '画布' : item.source === 'input' ? '上传' : '生成';
        const add = document.createElement('span');
        add.className = 'asset-add';
        add.title = '放入画布';
        add.textContent = '＋';
        add.onclick = (ev) => { ev.stopPropagation(); putAssetOnCanvas(item); };
        cell.append(img, badge, name, add);
        // 单击看大图（列表就是当前筛选结果，翻页能一直翻下去）
        cell.onclick = () => openLightbox(item.url, list, i, assetImageInfo(item));
        cell.ondblclick = (ev) => { ev.stopPropagation(); putAssetOnCanvas(item); };
        cell.onkeydown = (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); putAssetOnCanvas(item); }
        };
        grid.appendChild(cell);
      });
    };

    const reload = async (force) => {
      grid.innerHTML = '<p class="asset-tip">读取中…</p>';
      await loadAssets(force);
      paint();
    };

    q.oninput = () => { assetQuery = q.value; paint(); };
    q.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeAssetSheet(); } };
    box.querySelectorAll('.asset-tabs button').forEach((b) => {
      b.onclick = () => {
        assetTab = b.dataset.k;
        box.querySelectorAll('.asset-tabs button').forEach((x) => x.classList.toggle('on', x === b));
        paint();
      };
    });
    box.querySelector('.asset-reload').onclick = () => reload(true);

    await reload(false);
  }

  // ---------- 全局设置：默认工作流 / 工作流库 ----------
  function closeSettingsSheet() {
    const el = document.getElementById('appSettings');
    if (el) el.remove();
  }

  function globalFlag(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v === '1';
    } catch { return fallback; }
  }

  function setGlobalFlag(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* noop */ }
  }

  function autosaveOn() { return globalFlag('infisheet-autosave', true); }

  function applyGlobalViewPrefs() {
    state.snap = globalFlag('infisheet-snap', !!state.snap);
    state.linksHidden = !globalFlag('infisheet-links', !state.linksHidden);
    state.minimapOn = globalFlag('infisheet-minimap', !!state.minimapOn);
    let dock = 'bottom';
    try { dock = localStorage.getItem('infisheet-dock-side') || 'bottom'; } catch { /* noop */ }
    state.dockSide = ['bottom', 'left', 'right', 'top'].includes(dock) ? dock : 'bottom';
    applyDockSide();
  }

  // ---------- 画布背景 ----------
  const CANVAS_BG_KEY = 'infisheet-bg';
  const CANVAS_BGS = [
    { id: 'graphite', name: '石墨', bg: '#1a1a1a', line: '#474747',
      glowA: 'transparent', glowB: 'transparent', vignette: 'transparent' },
    { id: 'ink', name: '墨黑', bg: '#141414', line: '#3d3d3d',
      glowA: 'transparent', glowB: 'transparent', vignette: 'transparent' },
    { id: 'slate', name: '雾蓝', bg: '#101a26', line: '#3d4a5e',
      glowA: 'transparent', glowB: 'transparent', vignette: 'transparent' },
    { id: 'warm', name: '暖灰', bg: '#191512', line: '#4a3f33',
      glowA: 'transparent', glowB: 'transparent', vignette: 'transparent' },
    { id: 'paper', name: '纸白', bg: '#e9eaee', line: '#c3c7cf',
      glowA: 'transparent', glowB: 'transparent', vignette: 'transparent' },
  ];

  // 旧版本的深色底映射到新预设，避免升级后停在旧配色
  const LEGACY_BG = {
    '#0a0c11': 'graphite', '#0b0d12': 'graphite', '#0f1115': 'graphite',
    '#07080b': 'ink',
    '#0d1520': 'slate', '#101722': 'slate',
    '#12100d': 'warm', '#15120f': 'warm',
  };

  function loadCanvasBg() {
    try {
      const raw = JSON.parse(localStorage.getItem(CANVAS_BG_KEY) || 'null');
      if (raw && typeof raw.bg === 'string') {
        const pattern = raw.pattern || 'dots';
        const legacy = LEGACY_BG[String(raw.bg).toLowerCase()];
        const preset = CANVAS_BGS.find((p) => p.id === legacy)
          || CANVAS_BGS.find((p) => p.bg.toLowerCase() === String(raw.bg).toLowerCase());
        // 用当前预设的线色重算，别沿用旧版本存下的低对比度值
        if (preset) return { ...preset, pattern };
        return { ...customCanvasBg(raw.bg), pattern };
      }
    } catch (err) { /* 忽略损坏的本地值 */ }
    return { ...CANVAS_BGS[0], pattern: 'dots' };
  }

  function isLightColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150;
  }

  function customCanvasBg(hex) {
    const light = isLightColor(hex);
    return {
      id: 'custom', name: '自定义', bg: hex,
      line: light ? '#c3c7cf' : '#474747',
      glowA: light ? 'rgba(90,120,255,.08)' : 'rgba(96,132,255,.12)',
      glowB: light ? 'rgba(120,90,255,.05)' : 'rgba(150,100,255,.08)',
      vignette: light ? 'rgba(20,24,34,.06)' : 'rgba(0,0,0,.5)',
    };
  }

  function applyCanvasBg(pref) {
    const el = $('#stage');
    if (!el) return;
    const p = pref || loadCanvasBg();
    el.style.setProperty('--canvas-bg', p.bg);
    el.style.setProperty('--canvas-line', p.line || '#474747');
    el.style.setProperty('--canvas-dot', p.line || '#474747');
    el.style.setProperty('--canvas-glow-a', p.glowA || 'transparent');
    el.style.setProperty('--canvas-glow-b', p.glowB || 'transparent');
    el.style.setProperty('--canvas-vignette', p.vignette || 'rgba(0,0,0,.5)');
    el.dataset.pattern = p.pattern || 'dots';
    el.dataset.tone = isLightColor(p.bg) ? 'light' : 'dark';
  }

  function saveCanvasBg(patch) {
    const next = { ...loadCanvasBg(), ...patch };
    try { localStorage.setItem(CANVAS_BG_KEY, JSON.stringify(next)); } catch (err) { /* 忽略配额 */ }
    applyCanvasBg(next);
    return next;
  }
  /* ---------------- 关闭服务 ---------------- */
  // 后端是本机的一个 python 进程。关掉它之后**所有**标签页和 MCP 客户端都会断，
  // 所以：设置里二次确认 + 关完盖一层说明，别让用户对着一堆静默失败的按钮猜。
  async function stopServer() {
    closeSettingsSheet();
    const box = document.getElementById('serverDown');
    const txt = document.getElementById('serverDownText');
    if (box) box.classList.remove('hidden');
    if (txt) txt.textContent = '正在关闭…';
    state.serverDown = true;      // 先把轮询停掉，否则接下来那几发 fetch 会把控制台刷红
    let r = null;
    try { r = await postJson('/api/shutdown', {}); } catch { r = null; }
    if (!r || r.ok === false) {
      state.serverDown = false;
      if (box) box.classList.add('hidden');
      flash(`没关掉：${(r && r.error) || '请求没有响应'}（也许服务已经停了）`);
      return;
    }
    // 等它真的退：health 连不上就是关了（进程退出时会把 8788 一起放掉）
    for (let i = 0; i < 25; i++) {
      await new Promise((res) => setTimeout(res, 200));
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) break;
      } catch { break; }
    }
    if (txt) txt.textContent = '服务已关闭。';
  }

  // ---------- 设置里的「工作流」区 ----------
  // 早先这里是六个按钮挤成两组：
  //   默认工作流 ｜ [打开工作流库] [导入工作流 JSON…]
  //   预设 / 工作流库 ｜ [新增预设…] [管理预设] [管理库工作流]
  // 其中三对是同一件事（打开库 == 管理库、新增预设 ≈ 导入 JSON、管理预设 == 打开库的预设页），
  // 而且那个下拉里**只有内置预设**——自己存进工作流库的永远选不到，用户的原话就是
  // 「工作流被固定死了」。现在合成一处：一个下拉 + 一份列表 + 一排分类。
  function renderSetWorkflows(box) {
    const sel = box.querySelector('#setDefaultWf');
    const listEl = box.querySelector('#setWfList');
    const catsEl = box.querySelector('#setCats');
    if (!sel || !listEl || !catsEl) return;
    const opts = presetOptions();
    const cats = wfCategories();
    const cur = defaultWorkflowId();

    // ---- 默认工作流：按**用户分类**分组，预设和库都在里面 ----
    sel.innerHTML = '';
    const bucket = (c) => opts.filter((o) => o.group === c.id);
    cats.forEach((c) => {
      const group = bucket(c);
      if (!group.length) return;
      const g = document.createElement('optgroup');
      g.label = c.name;
      group.forEach((o) => {
        const op = document.createElement('option');
        op.value = o.id;
        op.textContent = o.label;
        if (o.id === cur) op.selected = true;
        g.appendChild(op);
      });
      sel.appendChild(g);
    });
    // 分类被删掉、group 指向不存在的 id：兜到「其他」，别让工作流在下拉里消失
    const orphans = opts.filter((o) => !cats.some((c) => c.id === o.group));
    if (orphans.length) {
      const g = document.createElement('optgroup');
      g.label = '其他';
      orphans.forEach((o) => {
        const op = document.createElement('option');
        op.value = o.id;
        op.textContent = o.label;
        if (o.id === cur) op.selected = true;
        g.appendChild(op);
      });
      sel.appendChild(g);
    }
    if (!opts.length) {
      const op = document.createElement('option');
      op.value = '';
      op.textContent = '（还没有工作流）';
      sel.appendChild(op);
    }
    sel.onchange = () => {
      if (!sel.value) return;
      try { localStorage.setItem('infisheet-default-wf', sel.value); } catch { /* ignore */ }
      flash('默认工作流已保存');
      renderSetWorkflows(box);
    };

    // ---- 列表：名字（点一下改名）/ 分类 / 默认 / 删除 ----
    listEl.innerHTML = '';
    if (!opts.length) {
      const p = document.createElement('p');
      p.className = 'tip';
      p.textContent = '还没有工作流。点上面的「导入工作流…」加一个。';
      listEl.appendChild(p);
    }
    opts.forEach((o) => {
      const row = document.createElement('div');
      row.className = 'wf-item' + (o.id === cur ? ' is-default' : '');
      row.dataset.id = o.id;

      const name = document.createElement('b');
      name.textContent = o.label;
      name.title = `${o.label} · ${o.nodes} 个节点（点一下改名）`;
      name.onclick = () => renameWfItem(o);

      const cat = document.createElement('button');
      cat.type = 'button';
      cat.className = 'wf-cat';
      cat.textContent = o.catLabel;
      cat.title = '换分类';
      cat.onclick = () => {
        const items = wfCategories().map((c) => [
          (c.id === o.group ? '✓ ' : '') + c.name,
          () => moveWfItem(o, c.id),
        ]);
        items.push(['＋ 新分类…', async () => { const id = await addCategory(); if (id) moveWfItem(o, id); }]);
        openPopMenu(cat, items, '换分类');
      };

      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'wf-star';
      star.textContent = o.id === cur ? '★' : '☆';
      star.title = o.id === cur ? '当前默认' : '设为默认工作流';
      star.onclick = () => {
        try { localStorage.setItem('infisheet-default-wf', o.id); } catch { /* ignore */ }
        flash(`默认工作流：${o.label}`);
        renderSetWorkflows(box);
      };

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'wf-del';
      del.textContent = '×';
      del.title = '删除这个工作流';
      del.onclick = () => deleteWfItem(o);

      row.append(name, cat, star, del);
      listEl.appendChild(row);
    });

    // ---- 分类：点一下改名 / 删除 ----
    catsEl.innerHTML = '';
    cats.forEach((c) => {
      const n = opts.filter((o) => o.group === c.id).length;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wf-chip';
      const s = document.createElement('span');
      s.textContent = c.name;
      b.appendChild(s);
      if (n) {                       // 空的分类不显示那个 0，一排 0 只会让人分心
        const em = document.createElement('em');
        em.textContent = String(n);
        b.appendChild(em);
      }
      b.title = `${c.name} · ${n} 个工作流`;
      b.onclick = () => openPopMenu(b, [
        ['重命名分类…', () => renameCategory(c)],
        ['删除分类', () => deleteCategory(c), 'danger'],
      ], c.name);
      catsEl.appendChild(b);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'wf-chip add';
    add.textContent = '＋ 新分类';
    add.onclick = () => addCategory();
    catsEl.appendChild(add);
  }

  // 设置面板开着的时候局部刷新（不重建整个面板，滚动位置不会跳回顶上）
  function refreshSetWf() {
    const box = document.getElementById('appSettings');
    if (box) renderSetWorkflows(box);
  }

  async function renameWfItem(o) {
    const name = prompt('工作流名称', o.label);
    if (name == null) return;
    const v = name.trim().slice(0, 40);
    if (!v || v === o.label) return;
    if (await saveWfMeta(o.id, { title: v })) { refreshSetWf(); flash('已改名：' + v); }
  }

  async function moveWfItem(o, catId) {
    if (catId === o.group) return;
    if (await saveWfMeta(o.id, { group: catId })) {
      refreshSetWf();
      flash(`已移到「${catName(catId)}」`);
    }
  }

  async function deleteWfItem(o) {
    const extra = o.source === 'preset' ? '\n（这是内置预设，删掉要重新导入）' : '';
    if (!confirm(`删除工作流「${o.label}」？${extra}`)) return;
    const url = o.source === 'preset'
      ? '/api/presets/' + encodeURIComponent(o.file)
      : '/api/library/' + encodeURIComponent(o.file);
    const res = await api(url, { method: 'DELETE' });
    if (!res.ok) { flash(res.error || '删除失败'); return; }
    try {
      if (localStorage.getItem('infisheet-default-wf') === o.id) localStorage.removeItem('infisheet-default-wf');
    } catch { /* noop */ }
    // 正在用它的节点回落到一个还能用的工作流（别留个删掉的 id 在节点上，生成时才报错）
    state.nodes.forEach((nd) => {
      if (nd.gen && nd.gen.wf === o.id) {
        nd.gen.wf = pickWorkflow('txt2img');
        rerenderNode(nd.id, true);
      }
    });
    await refreshWorkflows();
    refreshSetWf();
    flash('已删除：' + o.label);
  }

  // 新建分类：返回新 id（导入 / 换分类时可以接着用），取消返回 null
  async function addCategory() {
    const name = prompt('新分类名称（例如「我的常用」）');
    if (name == null) return null;
    const v = name.trim().slice(0, 20);
    if (!v) return null;
    const list = wfCategories();
    if (list.some((c) => c.name === v)) { flash('已经有同名分类了'); return null; }
    const id = 'c' + Date.now().toString(36);
    if (!await saveCategories(list.concat([{ id, name: v }]))) return null;
    await refreshWorkflows();
    refreshSetWf();
    flash('已新增分类：' + v);
    return id;
  }

  async function renameCategory(c) {
    const name = prompt('分类名称', c.name);
    if (name == null) return;
    const v = name.trim().slice(0, 20);
    if (!v || v === c.name) return;
    const next = wfCategories().map((x) => (x.id === c.id ? { ...x, name: v } : x));
    if (await saveCategories(next)) { await refreshWorkflows(); refreshSetWf(); flash('已改名：' + v); }
  }

  async function deleteCategory(c) {
    const list = wfCategories();
    if (list.length <= 1) { flash('至少得留一个分类'); return; }
    const used = presetOptions().filter((o) => o.group === c.id);
    const tip = used.length ? `\n它下面的 ${used.length} 个工作流会移到「其他」。` : '';
    if (!confirm(`删除分类「${c.name}」？${tip}`)) return;
    // 先把工作流挪走再删分类：反过来的话中途失败会留下一堆指向空分类的孤儿
    for (const o of used) await saveWfMeta(o.id, { group: 'other' });
    if (await saveCategories(list.filter((x) => x.id !== c.id))) {
      await refreshWorkflows();
      refreshSetWf();
      flash('已删除分类：' + c.name);
    }
  }

  // 设置里那个「导入工作流…」：统一存进**工作流库**（我的工作流），
  // 和随程序分发的内置预设分开。存完就能在默认工作流下拉 / 节点的选择器里选到。
  function importWorkflowToLibrary() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      let data = null;
      try { data = JSON.parse(await f.text()); } catch { flash('不是有效的 JSON 文件'); return; }
      if (data && data.version === 2 && Array.isArray(data.nodes)
        && data.nodes.some((nd) => nd && ['text', 'image', 'wf', 'out'].includes(nd.type))) {
        flash('这是画布存档，不是工作流：请选 API / 界面格式的工作流 JSON');
        return;
      }
      const graph = extractApiGraph(data) || (data && data.graph)
        || (data && Array.isArray(data.nodes) ? data : null);
      if (!graph) { flash('没有识别到工作流（API 图或界面格式都行）'); return; }
      const defTitle = String(data.title || data.name || f.name.replace(/\.json$/i, '')).slice(0, 40);
      const title = prompt('工作流名称', defTitle);
      if (title == null) return;
      const name = title.trim().slice(0, 40) || defTitle;
      const res = await api(`/api/library/${encodeURIComponent(name)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph, title: name }),
      });
      if (!res.ok) { flash(res.error || '导入失败'); return; }
      await refreshWorkflows();
      refreshSetWf();
      flash(`已导入「${name}」——在列表里能换分类、设默认`);
    };
    inp.click();
  }

  // ComfyUI 地址编辑器：设置面板和首页页脚的小弹层**共用这一份**。
  // 两处各写一遍的话，「连不上」的文案、以及「存住了但连不上」和「没存住」的区分，
  // 迟早会有一边先走样。传进来的就是几个 DOM 元素，逻辑不关心它们在哪个容器里。
  function bindComfyEditor({ input, hint, save, reset, onSaved }) {
    const paint = (info, note) => {
      const src = info.source ? ` · 来源：${info.source}` : '';
      const tail = note ? ` · ${note}` : '';
      if (info.reachable) {
        const dev = (info.devices || [])[0] || {};
        const bits = [`已连接 ${info.version || ''}`.trim()];
        if (info.ms != null) bits.push(`${info.ms}ms`);
        if (dev.name) bits.push(dev.name);
        hint.className = 'set-tip ok';
        hint.textContent = bits.join(' · ') + src + tail;
      } else {
        // 地址就在上面那个输入框里，这里只留「为什么连不上」，别重复一遍 URL
        const why = String(info.error || '没有响应').split(info.url || '\u0000').join('').trim();
        hint.className = 'set-tip bad';
        hint.textContent = `连不上：${why || '没有响应'}${src}${tail}`;
      }
      input.value = info.url || '';
      if (onSaved) onSaved(info);
    };
    const read = async () => {
      const r = await api('/api/comfy');
      if (!r || r.ok === false) {
        hint.className = 'set-tip bad';
        hint.textContent = `读不到当前地址：${(r && r.error) || '接口不存在'}（服务端是旧版本？重启 python server.py）`;
        return;
      }
      paint(r);
    };
    const commit = async () => {
      const label = save.textContent;
      save.disabled = true;
      save.textContent = '测试中…';
      try {
        const r = await postJson('/api/comfy', { url: input.value });
        if (r && r.ok) {
          // 存住是存住、连不连得上是两件事：连不上也要如实说，别让人以为没保存
          paint(r, r.saved ? '已保存' : '已恢复默认');
          flash(r.reachable ? 'ComfyUI 已连上' : '地址已保存，但暂时连不上');
          health();
        } else {
          hint.className = 'set-tip bad';
          hint.textContent = (r && r.error) || '保存失败';
        }
      } catch (e) {
        hint.className = 'set-tip bad';
        hint.textContent = `保存失败：${e.message || e}`;
      } finally {
        save.disabled = false;
        save.textContent = label;
      }
    };
    read();
    save.onclick = commit;
    if (reset) reset.onclick = () => { input.value = ''; commit(); };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    };
    return { read, commit };
  }

  function openSettingsSheet(focus) {
    closeSettingsSheet();
    const box = document.createElement('div');
    box.id = 'appSettings';
    box.innerHTML = `
      <div class="sheet">
        <header><strong>全局设置</strong><button type="button" class="x" title="关闭">×</button></header>
        <div class="set-body">
          <div class="set-group">工作流</div>
          <label>默认工作流
            <select id="setDefaultWf"></select>
          </label>
          <p class="set-tip" id="setWfTip">按分类自动挑；这里选的那个只要同类就优先用它。</p>
          <div class="set-actions">
            <button type="button" class="prime" id="setImportWf">导入工作流…</button>
            <button type="button" id="setOpenLib">浏览资产库…</button>
          </div>
          <p class="set-tip">工作流只在这一页管：导入 / 改名 / 换分类 / 设默认 / 删除。
            资产库（顶栏「工作流库」）只负责挑一个加到画布，那边没有管理按钮。</p>
          <div class="wf-list" id="setWfList"></div>
          <div class="set-group">分类</div>
          <div class="wf-cats" id="setCats"></div>
          <p class="set-tip">点分类可以改名 / 删除；点右边那一栏能给工作流换分类。分类只影响这里的归类，不影响生成时自动挑。</p>
          <div class="set-sep"></div>
          <div class="set-group">背景</div>
          <div class="set-bg">
            <div class="bg-swatches" id="setBgSwatches"></div>
            <div class="set-actions">
              <label class="bg-custom">自定义 <input type="color" id="setBgColor" /></label>
              <button type="button" data-pattern="dots">点阵</button>
              <button type="button" data-pattern="lines">网格</button>
              <button type="button" data-pattern="none">纯色</button>
            </div>
          </div>          <div class="set-group">画布</div>
          <label class="set-row"><input type="checkbox" id="setSnap" /> 网格吸附</label>
          <label class="set-row"><input type="checkbox" id="setLinks" /> 显示连线</label>
          <label class="set-row"><input type="checkbox" id="setMinimap" /> 显示小地图</label>
          <label class="set-row"><input type="checkbox" id="setAutosave" /> 自动保存（关闭后只存本机）</label>
          <div class="set-sep"></div>
          <div class="set-group">快捷键</div>
          <p class="set-tip">Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Ctrl+C/V 复制粘贴 · Ctrl+D 副本 · Ctrl+S 保存 · Ctrl+K 设置 · F 适配视图 · N 添加节点</p>
          <div class="set-sep"></div>
          <div class="set-group">数据</div>
          <div class="set-actions">
            <button type="button" id="setFit">适配视图</button>
            <button type="button" id="setExport">导出画布 JSON</button>
            <button type="button" id="setImport">导入画布 JSON</button>
            <button type="button" id="setHistory">历史画布…</button>
          </div>
          <div class="set-sep"></div>
          <div class="set-group">ComfyUI 连接</div>
          <label class="set-comfy">地址
            <input type="text" id="setComfyUrl" spellcheck="false" autocomplete="off"
                   placeholder="http://127.0.0.1:8188" />
          </label>
          <p class="set-tip" id="setComfyHint">正在读取…</p>
          <div class="set-actions">
            <button type="button" class="prime" id="setComfySave">保存并测试</button>
            <button type="button" id="setComfyReset">恢复默认</button>
          </div>
          <div class="set-sep"></div>
          <div class="set-group">服务</div>
          <p class="set-tip">本地服务 <b>${location.host}</b>（ComfyUI 由它代理）。关掉之后所有标签页都会断连，
            要重新运行项目里的启动脚本（启动.bat / 启动.command / start.sh）才能再开。</p>
          <div class="set-actions" id="setSrvActions">
            <button type="button" class="danger" id="setShutdown">关闭服务…</button>
          </div>
        </div>
      </div>`;
    // 背景：色板 / 自定义颜色 / 纹理
    const bgNow = loadCanvasBg();
    const swWrap = box.querySelector('#setBgSwatches');
    const markBg = () => {
      const cur = loadCanvasBg();
      [...swWrap.children].forEach((b) => {
        const preset = CANVAS_BGS.find((p) => p.id === b.dataset.bg);
        b.classList.toggle('active', !!preset && preset.bg.toLowerCase() === String(cur.bg).toLowerCase());
      });
      [...box.querySelectorAll('[data-pattern]')].forEach((b) => {
        b.classList.toggle('active', (cur.pattern || 'dots') === b.dataset.pattern);
      });
      const ci = box.querySelector('#setBgColor');
      if (/^#[0-9a-f]{6}$/i.test(String(cur.bg))) ci.value = cur.bg;
    };
    CANVAS_BGS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bg-swatch'; b.title = p.name;
      b.dataset.bg = p.id;
      b.style.setProperty('--sw', p.bg);
      b.onclick = () => { saveCanvasBg({ ...p, pattern: loadCanvasBg().pattern }); markBg(); };
      swWrap.appendChild(b);
    });
    box.querySelector('#setBgColor').oninput = (ev) => {
      saveCanvasBg({ ...customCanvasBg(ev.target.value), pattern: loadCanvasBg().pattern });
      markBg();
    };
    box.querySelectorAll('[data-pattern]').forEach((b) => {
      b.onclick = () => { saveCanvasBg({ pattern: b.dataset.pattern }); markBg(); };
    });
    markBg();
    renderSetWorkflows(box);
    // 先用手里那份渲染，再悄悄拉一次最新的：别让面板空着等网络，
    // 也别让「刚在资产库里导入的工作流」在设置里看不到
    refreshWorkflows().then(() => { if (document.body.contains(box)) renderSetWorkflows(box); });
    const snap = box.querySelector('#setSnap');
    const links = box.querySelector('#setLinks');
    const mini = box.querySelector('#setMinimap');
    const auto = box.querySelector('#setAutosave');
    snap.checked = !!state.snap;
    links.checked = !state.linksHidden;
    mini.checked = !!state.minimapOn;
    auto.checked = autosaveOn();
    snap.onchange = () => { state.snap = snap.checked; setGlobalFlag('infisheet-snap', snap.checked); queueSave(); };
    links.onchange = () => {
      state.linksHidden = !links.checked;
      setGlobalFlag('infisheet-links', links.checked);
      renderLinks(); queueSave();
    };
    mini.onchange = () => {
      state.minimapOn = mini.checked;
      setGlobalFlag('infisheet-minimap', mini.checked);
      const mm = document.getElementById('minimap');
      if (mm) mm.classList.toggle('hidden', !state.minimapOn);
      setViewTool('minimap', state.minimapOn);
      renderMinimap(); queueSave();
    };
    auto.onchange = () => {
      setGlobalFlag('infisheet-autosave', auto.checked);
      if (auto.checked) saveToServer();   // 重新打开时立刻补一次保存
      flash(auto.checked ? '已开启自动保存' : '已关闭自动保存（仍存本机）');
    };
    box.querySelector('.x').onclick = closeSettingsSheet;
    box.querySelector('#setOpenLib').onclick = () => { closeSettingsSheet(); showCanvas(); openModal(); };
    box.querySelector('#setImportWf').onclick = () => importWorkflowToLibrary();
    box.querySelector('#setFit').onclick = () => { closeSettingsSheet(); fitView(); };
    box.querySelector('#setExport').onclick = () => { closeSettingsSheet(); exportCanvas(); };
    box.querySelector('#setImport').onclick = () => { closeSettingsSheet(); importCanvas(); };
    box.querySelector('#setHistory').onclick = () => { closeSettingsSheet(); openCanvasHistory(); };
    const shut = box.querySelector('#setShutdown');
    if (shut) {
      shut.onclick = () => {
        const wrap = box.querySelector('#setSrvActions');
        wrap.className = 'set-srv-confirm';
        wrap.innerHTML = '<span>确定关闭？正在跑的生成会中断。</span>'
          + '<button type="button" id="setSrvCancel">取消</button>'
          + '<button type="button" class="danger" id="setSrvGo">确定关闭</button>';
        wrap.querySelector('#setSrvCancel').onclick = () => openSettingsSheet();
        wrap.querySelector('#setSrvGo').onclick = () => stopServer();
      };
    }
    // ---- ComfyUI 地址：换电脑 / 换端口 / 另一台机器都从这里改 ----
    // 为什么放在设置里而不是启动参数：另一台机器上跑 ComfyUI 是很常见的用法，
    // 而「改脚本再重启」对不写代码的人等于没有这个功能。
    const comfyInput = box.querySelector('#setComfyUrl');
    bindComfyEditor({
      input: comfyInput,
      hint: box.querySelector('#setComfyHint'),
      save: box.querySelector('#setComfySave'),
      reset: box.querySelector('#setComfyReset'),
    });
    box.onclick = (ev) => { if (ev.target === box) closeSettingsSheet(); };
    document.body.appendChild(box);
    if (focus === 'comfy') {
      comfyInput.focus();
      comfyInput.select();
      comfyInput.scrollIntoView({ block: 'center' });
    }
  }
  function openSlotSheet(n) {
    if (!n) return;
    closeSlotSheet();
    slotSheetNode = n.id;
    const box = document.createElement('div');
    box.id = 'slotSheet';
    const sheet = document.createElement('div');
    sheet.className = 'sheet';

    const head = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = `${n.title || '工作流'} · 设置`;
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = '关闭';
    x.onclick = closeSlotSheet;
    head.append(title, x);
    sheet.appendChild(head);

    const body = document.createElement('div');
    body.className = 'slot-body';
    const linked = new Set(state.links.filter((l) => l.to === n.id).map((l) => l.toKey));
    const slots = n.slots || [];
    const groups = [
      ['输入（可连线）', slots.filter((s) => s.kind === 'text' || s.kind === 'image')],
      ['参数', slots.filter((s) => s.kind !== 'text' && s.kind !== 'image')],
    ];
    if (!slots.length) body.innerHTML = '<div class="empty">该工作流没有可编辑参数。</div>';
    groups.forEach(([label, list]) => {
      if (!list.length) return;
      const h = document.createElement('div');
      h.className = 'slot-group';
      h.textContent = label;
      body.appendChild(h);
      list.forEach((s) => body.appendChild(buildSlot(n, s, linked.has(s.key))));
    });
    sheet.appendChild(body);
    box.appendChild(sheet);
    box.onclick = (ev) => { if (ev.target === box) closeSlotSheet(); };
    document.body.appendChild(box);
  }

  function buildWfBody(n, linkedInputs) {    const wrap = document.createElement('div');

    if (n.unknownTypes && n.unknownTypes.length) {
      const warn = document.createElement('div');
      warn.className = 'wf-status error';
      warn.style.marginBottom = '8px';
      warn.textContent = `含无法识别的节点（${n.unknownTypes.slice(0, 3).join(', ')}），请确认它是「导出(API)」得到的工作流。`;
      wrap.appendChild(warn);
    }

    // 参数不铺在节点上：节点只显示规模与连线数，具体参数去「设置」里改
    const meta = document.createElement('div');
    meta.className = 'wf-meta';
    meta.textContent = `${(n.slots || []).length} 个参数 · ${linkedInputs.size} 条输入`;
    wrap.appendChild(meta);
    if (!n.slots || !n.slots.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '该工作流没有可编辑参数。';
      wrap.appendChild(empty);
    }

    const foot = document.createElement('div');
    foot.className = 'wf-foot';
    const status = document.createElement('div');
    status.className = `wf-status ${n.status === 'error' ? 'error' : n.status === 'done' ? 'done' : n.status === 'running' || n.status === 'queued' ? 'running' : ''}`;
    status.textContent = n.statusText || `共 ${n.nodeCount || 0} 个节点`;
    foot.appendChild(status);
    if (n.status === 'running' || n.status === 'queued') {
      const stop = document.createElement('button');
      stop.textContent = '中断';
      stop.onclick = (ev) => { ev.stopPropagation(); cancelJob(n); };
      foot.appendChild(stop);
    }
    const saveLib = document.createElement('button');
    saveLib.textContent = '存入工作流库';
    saveLib.onclick = async (ev) => { ev.stopPropagation(); await saveToLibrary(n); };
    foot.appendChild(saveLib);
    const setBtn = document.createElement('button');
    setBtn.textContent = '设置';
    setBtn.onclick = (ev) => { ev.stopPropagation(); openSlotSheet(n); };
    foot.appendChild(setBtn);
    wrap.appendChild(foot);

    // 结果已连到「图片输出」节点时，工作流节点内不再重复展示，保持画布整洁
    const hasOutLink = state.links.some((l) => l.from === n.id && (getNode(l.to) || {}).type === 'out');
    if (!hasOutLink && n.artifacts && n.artifacts.length) {
      const grid = document.createElement('div');
      grid.className = 'results';
      n.artifacts.forEach((a) => grid.appendChild(buildArtifact(n, a)));
      wrap.appendChild(grid);
    }
    return wrap;
  }

  function buildSlot(n, slot, linked) {
    const row = document.createElement('div');
    row.className = `slot${linked ? ' linked' : ''}${slot.kind === 'text' ? ' wide' : ''}`;

    const lab = document.createElement('div');
    lab.className = 'lab';
    lab.innerHTML = `<span class="name">${esc(slot.node_title)} · ${esc(slot.input)}</span>`
      + `<span class="badge">${slot.kind}</span>`
      + (linked ? `<span class="linkmark" title="点击断开连线">⛓ 已连线</span>` : '');
    const mark = lab.querySelector('.linkmark');
    if (mark) mark.onclick = () => { removeLink(n.id, slot.key); if (slotSheetNode === n.id) openSlotSheet(getNode(n.id)); };
    row.appendChild(lab);

    if (slot.kind === 'text') {
      const ta = document.createElement('textarea');
      if (linked) {
        ta.value = '';
        ta.placeholder = '（文本由左侧提示词节点连线提供）';
      } else {
        ta.value = n.values[slot.key] ?? '';
        ta.oninput = () => { n.values[slot.key] = ta.value; queueSave(); };
        ta.onblur = () => commit();
      }
      row.appendChild(ta);
    } else if (slot.kind === 'number' || slot.kind === 'seed') {
      const box = document.createElement('div');
      box.className = 'seedrow';
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.value = n.values[slot.key] ?? 0;
      if (slot.min !== undefined) inp.min = slot.min;
      if (slot.max !== undefined) inp.max = slot.max;
      if (slot.step !== undefined) inp.step = slot.step;
      inp.oninput = () => { n.values[slot.key] = Number(inp.value); queueSave(); };
      inp.onchange = () => commit();
      box.appendChild(inp);
      if (slot.kind === 'seed') {
        const rnd = document.createElement('button');
        rnd.textContent = '🎲';
        rnd.onclick = () => {
          const v = Math.floor(Math.random() * 2 ** 31);
          inp.value = v; n.values[slot.key] = v; queueSave(); commit();
        };
        box.appendChild(rnd);
      }
      row.appendChild(box);
    } else if (slot.kind === 'select') {
      const sel = document.createElement('select');
      (slot.options || []).forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (String(n.values[slot.key]) === opt) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => { n.values[slot.key] = sel.value; queueSave(); commit(); };
      row.appendChild(sel);
    } else if (slot.kind === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = Boolean(n.values[slot.key]);
      cb.onchange = () => { n.values[slot.key] = cb.checked; queueSave(); commit(); };
      row.appendChild(cb);
    } else if (slot.kind === 'image') {
      const box = document.createElement('div');
      box.className = 'seedrow';
      const sel = document.createElement('select');
      (slot.options || ['']).forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt || '（未选择）';
        if (String(n.values[slot.key]) === opt) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => { n.values[slot.key] = sel.value; queueSave(); commit(); };
      box.appendChild(sel);
      row.appendChild(box);
    }
    return row;
  }

  function buildArtifact(n, a) {
    const box = document.createElement('div');
    box.className = 'art';
    const url = `/api/view?filename=${encodeURIComponent(a.filename)}&subfolder=${encodeURIComponent(a.subfolder || '')}&type=${encodeURIComponent(a.type || 'output')}`;
    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = url; img.loading = 'lazy';
      img.draggable = false;
      img.addEventListener('dragstart', (ev) => ev.preventDefault());
      img.ondblclick = (ev) => { ev.stopPropagation(); openLightbox(url, null, 0, artifactImageInfo(a, n)); };
      box.appendChild(img);
    } else if (a.kind === 'video') {
      const v = document.createElement('video');
      v.src = url; v.controls = true; v.preload = 'metadata';
      box.appendChild(v);
    } else {
      const link = document.createElement('a');
      link.href = url; link.textContent = a.filename; link.target = '_blank';
      link.style.cssText = 'display:block;padding:6px;font-size:11px;color:#9aa3b2';
      box.appendChild(link);
    }
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = '钉到画布';
    pin.onclick = (ev) => { ev.stopPropagation(); pinArtifact(n, a, url); };
    box.appendChild(pin);
    return box;
  }

  const groupsEl = () => document.getElementById('groups');

  function nodeBox(n) {
    const el = nodesEl.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
    return {
      x: n.x, y: n.y,
      w: el ? el.offsetWidth : nodeWidth(n),
      h: el ? el.offsetHeight : 180,
    };
  }

  // 组框复用：拖动时每帧都要更新几何，整块重建 DOM（含按钮与事件）会明显掉帧
  // 编组配色：只用来区分「哪个组是哪个」，所以取低饱和的线 + 极淡的底
  const GROUP_COLORS = [
    { id: 'blue', label: '蓝', chip: '#6ea8fe', line: 'rgba(110, 168, 254, 0.55)', fill: 'rgba(110, 168, 254, 0.05)' },
    { id: 'violet', label: '紫', chip: '#a78bfa', line: 'rgba(167, 139, 250, 0.55)', fill: 'rgba(167, 139, 250, 0.05)' },
    { id: 'green', label: '绿', chip: '#34d399', line: 'rgba(52, 211, 153, 0.55)', fill: 'rgba(52, 211, 153, 0.05)' },
    { id: 'amber', label: '橙', chip: '#fbbf24', line: 'rgba(251, 191, 36, 0.55)', fill: 'rgba(251, 191, 36, 0.05)' },
    { id: 'pink', label: '粉', chip: '#f472b6', line: 'rgba(244, 114, 182, 0.55)', fill: 'rgba(244, 114, 182, 0.05)' },
    { id: 'slate', label: '灰', chip: '#9aa3af', line: 'rgba(154, 163, 175, 0.55)', fill: 'rgba(154, 163, 175, 0.05)' },
  ];
  function groupColor(g) {
    return GROUP_COLORS.find((c) => c.id === (g && g.color)) || GROUP_COLORS[0];
  }

  // 组名就地编辑：不换元素（换成 input 的话 renderGroups 找不到 .gname 会重建整个头），
  // 直接给 span 挂 contenteditable，结束时把 contentEditable 关掉、让 renderGroups 重写文案。
  function startRenameGroup(span, g) {
    if (span.dataset.editing) return;
    span.dataset.editing = '1';
    span.textContent = g.name;              // 编辑时只显示名字，不带「· N 节点」
    span.contentEditable = 'true';
    span.classList.add('editing');
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = (save) => {
      if (!span.dataset.editing) return;
      delete span.dataset.editing;
      span.contentEditable = 'false';
      span.classList.remove('editing');
      const v = (span.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (save && v) g.name = v;
      renderGroups();                        // 恢复成「名字 · N 节点」
      if (save && v) { queueSave(); commit(); }
    };
    span.onblur = () => finish(true);
    span.onkeydown = (ev) => {
      ev.stopPropagation();                  // 别让画布快捷键（Delete 删节点等）截走
      // 直接收尾，别指望 blur()：元素没拿到焦点时 blur 不触发，名字就白改了
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    };
  }

  function groupBoxFor(gid) {
    const host = groupsEl();
    let box = host.querySelector(`.group[data-gid="${CSS.escape(gid)}"]`);
    if (box) return box;
    box = document.createElement('div');
    box.className = 'group';
    box.dataset.gid = gid;

    const head = document.createElement('div');
    head.className = 'group-head';
    const chip = document.createElement('button');
    chip.className = 'gcolor';
    chip.title = '换个颜色';
    const name = document.createElement('span');
    name.className = 'gname';
    name.title = '点击选中整组，拖动可整体移动，双击改名';
    const run = document.createElement('button');
    run.textContent = '执行';
    const un = document.createElement('button');
    un.textContent = '解组';
    head.append(chip, name, run, un);
    box.appendChild(head);
    host.appendChild(box);

    // 事件里按 gid 现查分组：画布重新载入后组对象会换新，别闭包住旧对象
    const current = () => state.groups.find((x) => x.id === gid);
    name.onclick = (ev) => {
      ev.stopPropagation();
      const g = current();
      if (!g) return;
      selectOnly(null);
      g.nodeIds.forEach((id) => state.selected.add(id));
      paintSelection();
    };
    // 双击组名改名字：编辑时就地变成可输入，回车/失焦保存，Esc 放弃
    name.ondblclick = (ev) => {
      ev.stopPropagation();
      const g = current();
      if (g) startRenameGroup(name, g);
    };
    run.onclick = (ev) => {
      ev.stopPropagation();
      const g = current();
      if (g) runGroup(g);
    };
    un.onclick = (ev) => {
      ev.stopPropagation();
      ungroup(gid);
    };
    head.onpointerdown = (ev) => {
      if (ev.target.closest('button')) return;
      ev.stopPropagation();
      const g = current();
      if (!g) return;
      startNodeDrag(ev, g.nodeIds.map(getNode).filter(Boolean));
    };
    // 整个组框都能拖：以前只有顶部那条标题能拖，热区太窄（标题还在框外面）。
    // 组框在节点下面（#groups 在 #nodes 之前），所以点节点仍然是操作节点，
    // 点组框里的空白才落到这里——正好是「按住组内任意空处拖整组」。
    box.onpointerdown = (ev) => {
      if (ev.target.closest('button, .gname')) return;
      ev.stopPropagation();
      const g = current();
      if (!g) return;
      startNodeDrag(ev, g.nodeIds.map(getNode).filter(Boolean));
    };
    chip.onclick = (ev) => {
      ev.stopPropagation();
      openGroupColorMenu(chip, gid);
    };
    return box;
  }

  function renderGroups() {
    const host = groupsEl();
    if (!host) return;
    const alive = new Set();
    state.groups.forEach((g) => {
      const members = g.nodeIds.map(getNode).filter(Boolean);
      if (!members.length) return;
      alive.add(g.id);
      const boxes = members.map(nodeBox);
      const x = Math.min(...boxes.map((b) => b.x)) - 26;
      const y = Math.min(...boxes.map((b) => b.y)) - 44;
      const x2 = Math.max(...boxes.map((b) => b.x + b.w)) + 26;
      const y2 = Math.max(...boxes.map((b) => b.y + b.h)) + 26;

      const box = groupBoxFor(g.id);
      box.style.cssText = `left:${x}px;top:${y}px;width:${x2 - x}px;height:${y2 - y}px`;
      const c = groupColor(g);
      box.style.setProperty('--gc-line', c.line);
      box.style.setProperty('--gc-fill', c.fill);
      box.style.setProperty('--gc-chip', c.chip);
      box.dataset.color = c.id;
      const name = box.querySelector('.gname');
      if (name) name.textContent = `${g.name} · ${members.length} 节点`;
    });
    [...host.children].forEach((el) => {
      if (!alive.has(el.dataset.gid)) el.remove();
    });
  }

  function openGroupColorMenu(anchor, gid) {
    closePopMenu();
    const menu = document.createElement('div');
    menu.className = 'popmenu group-colors';
    menu.onpointerdown = (ev) => ev.stopPropagation();
    const head = document.createElement('div');
    head.className = 'popmenu-title';
    head.textContent = '分组颜色';
    menu.appendChild(head);
    const row = document.createElement('div');
    row.className = 'gc-row';
    GROUP_COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gc-chip';
      b.style.background = c.chip;
      b.title = c.label;
      b.setAttribute('aria-label', c.label);
      b.onclick = (ev) => {
        ev.stopPropagation();
        const g = state.groups.find((x) => x.id === gid);
        if (g) { g.color = c.id; renderGroups(); queueSave(); commit(); }
        closePopMenu();
      };
      row.appendChild(b);
    });
    menu.appendChild(row);
    document.body.appendChild(menu);
    placePopMenu(menu, anchor);
    popAnchor = anchor;
    armPopClose(anchor);
  }

  function createGroup(ids) {
    const list = [...ids].filter((id) => getNode(id));
    if (list.length < 2) { flash('先选中至少两个节点（Shift 点选），再按 Ctrl+G 打组'); return; }
    state.groups.push({
      id: uid('g'), name: `分组 ${state.groups.length + 1}`, nodeIds: list,
      color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length].id,
    });
    renderGroups();
    queueSave(); commit();
    flash('已打组：组标题上可整组执行、解组');
  }

  function ungroup(gid) {
    state.groups = state.groups.filter((g) => g.id !== gid);
    renderGroups();
    queueSave(); commit();
  }

  async function runGroup(g) {
    const targets = g.nodeIds.map(getNode).filter((n) => n && n.type === 'wf');
    if (!targets.length) { flash('这个分组里没有工作流节点'); return; }
    for (const n of targets) await runWorkflow(n);   // 顺序提交，ComfyUI 自己排队
    flash(`已提交 ${targets.length} 个工作流`);
  }

  function renderLinks() {
    if (state.linksHidden) { linksEl.innerHTML = ''; positionLinkDel(); return; }
    const paths = [];
    state.links.forEach((l) => {
      const a = portCenter(l.from, 'out');
      const b = portCenter(l.to, l.toKey);
      if (!a || !b) return;
      const d = linkPath(a, b);
      paths.push(`<path class="link-line${state.linkSel === l.id ? ' sel' : ''}" d="${d}" data-link="${l.id}" />`);
      paths.push(`<path class="link-hit" d="${d}" data-link="${l.id}" />`);
    });
    if (linkTemp) paths.push(`<path class="temp" d="${linkPath(linkTemp.a, linkTemp.b)}" />`);
    linksEl.innerHTML = paths.join('');
    positionLinkDel();
  }

  // 连线中点的「删除」按钮（屏幕坐标浮层，大小不跟缩放走）。
  // 位置**不能**用两端坐标取平均：反向连线（目标在源左边）会「吊」下来一截，
  // 等高时贝塞尔还会退化，平均点落在曲线外面，按钮看着像飘在空白上。
  // 按真实路径取「一半长度处」的那一点，任何形状都对得上。
  function positionLinkDel() {
    // 也**不能**在脚本顶部 const：index.html 里 app.js 的 <script> 排在 #linkDel 前面，
    // 顶部取会拿到 null（对齐浮条 #alignBar 也是同一个原因才懒查）。
    const btn = $('#linkDel');
    if (!btn) return;
    const id = state.linkSel;
    const path = id && !state.linksHidden
      ? linksEl.querySelector(`.link-line[data-link="${CSS.escape(id)}"]`)
      : null;
    if (!path) { btn.classList.add('hidden'); return; }
    const pt = path.getPointAtLength(path.getTotalLength() / 2);   // SVG 用户坐标（= 世界坐标）
    const m = path.getScreenCTM();
    if (!m) { btn.classList.add('hidden'); return; }
    // getScreenCTM 已经把 #world 的 translate/scale 算进去了，出来就是视口坐标
    btn.style.left = `${Math.round(m.a * pt.x + m.c * pt.y + m.e)}px`;
    btn.style.top = `${Math.round(m.b * pt.x + m.d * pt.y + m.f)}px`;
    btn.classList.remove('hidden');
  }

  // 端口元素索引："nodeId:portKey" → 元素。连线重绘一次要查 2×连线数 个端口，
  // 每次都 querySelectorAll('.port') 是 O(端口×连线)，拖动时直接卡。
  const portCache = new Map();

  function indexPorts(root) {
    root.querySelectorAll('.port').forEach((el) => {
      if (el.dataset.port) portCache.set(el.dataset.port, el);
    });
  }

  function reindexAllPorts() {
    portCache.clear();
    indexPorts(nodesEl);
  }

  function reindexNodePorts(id) {
    for (const key of [...portCache.keys()]) {
      if (key.startsWith(`${id}:`)) portCache.delete(key);
    }
    const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
    if (el) indexPorts(el);
  }

  function dropNodePorts(id) {
    for (const key of [...portCache.keys()]) {
      if (key.startsWith(`${id}:`)) portCache.delete(key);
    }
  }

  function portCenter(nodeId, key) {
    const owner = getNode(nodeId);
    if (owner && owner.type === 'wf' && key !== 'out') key = 'in';   // 工作流只有一个输入口
    const wanted = `${nodeId}:${key}`;
    let el = portCache.get(wanted);
    if (!el) {
      el = nodesEl.querySelector(`[data-port="${CSS.escape(wanted)}"]`);
      if (el) portCache.set(wanted, el);
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const isSlot = key !== 'out' && key !== 'in';
    if (isSlot) {
      // 插槽端口在卡片内缩了一点，连线终点对齐到卡片左边缘，视觉上才是"边到边"
      const card = el.closest('.node-card');
      if (card) {
        const cr = card.getBoundingClientRect();
        return screenToWorld(cr.left, y);
      }
    }
    return screenToWorld(r.left + r.width / 2, y);
  }

  // 连线路径：两端等高时画一条水平直线（居中），高差明显时走圆角折线
  // 连线：三次贝塞尔，首尾都是**水平切线**——从输出口平着出来、从左边平着进入口。
  // 以前的「横 → 竖 → 横」折线在高差大时会拐一个生硬的直角，而且多个来源汇到同一个口
  // 时全叠在同一条竖线上（看起来像一根线分叉）；贝塞尔靠曲率自然分开，也和参考的形态一致。
  function linkPath(a, b) {
    const dx = b.x - a.x;
    const adx = Math.abs(dx);
    // 控制点水平伸出量：太短会变成"直角"，太长会绕圈。
    // 只按横向间距算的话，遇到「左右挨得近、上下差很多」的情况会拐出一个很小的半径，
    // 所以让竖向高差也参与一点（|dy|*0.22），肩部会圆一些。
    const ady = Math.abs(b.y - a.y);
    const reach = adx < 4 ? 0 : Math.max(10, Math.min(200, Math.max(adx * 0.5, ady * 0.22)));
    let c1x = a.x + reach;
    let c2x = b.x - reach;
    let c1y = a.y;
    let c2y = b.y;
    if (dx < 0) {
      // 反向连接（目标在源左边）：两端各自往外甩，否则曲线会穿回两个节点身体里；
      // 等高时贝塞尔会退化成一条直线横穿中间所有节点，所以再加一点垂度让它「吊」下来。
      const k = Math.min(160, 48 + adx * 0.12);
      c1x = a.x + k;
      c2x = b.x - k;
      if (Math.abs(b.y - a.y) < 24) {
        const sag = Math.min(110, 36 + adx * 0.05);
        c1y = a.y + sag;
        c2y = b.y + sag;
      }
    }
    return `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`;
  }

  /* ---------------- 选中 / 拖拽 ---------------- */
  function paintSelection() {
    nodesEl.querySelectorAll('.node').forEach((el) => el.classList.toggle('selected', state.selected.has(el.dataset.id)));
    // 对齐悬浮条只在真的能对齐时出现（选中 2 个以上）
    const bar = $('#alignBar');
    if (bar) {
      const multi = state.selected.size >= 2;
      if (multi) ensureAlignBar();
      bar.classList.toggle('hidden', !multi);
      if (multi) positionAlignBar();      // 显示出来才有尺寸，定位必须在 toggle 之后
    }
    // 图片工具条：单选一张有图的节点时浮在它上方（裁剪 / 高清）
    updateImgTools();
  }

  function selectOnly(id) {
    state.selected = id ? new Set([id]) : new Set();
    paintSelection();
  }

  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    paintSelection();
  }

  /* ---------------- 对齐 / 分布 ---------------- */
  // 选中 2 个以上时，底部多出「对齐」按钮：6 种对齐 + 2 种等距分布。
  // 高度不能只信 n.h（只有手动拉过才有值），直接量 DOM 再除回缩放系数。
  // [模式, 名称, 说明, 图标]
  const ALIGN_ITEMS = [
    ['left', '左对齐', '左边缘对齐到最左', 'alignLeft'],
    ['hcenter', '水平居中', '按整体中线水平居中', 'alignHCenter'],
    ['right', '右对齐', '右边缘对齐到最右', 'alignRight'],
    ['top', '顶对齐', '上边缘对齐到最上', 'alignTop'],
    ['vcenter', '垂直居中', '按整体中线垂直居中', 'alignVCenter'],
    ['bottom', '底对齐', '下边缘对齐到最下', 'alignBottom'],
    ['hdist', '水平等距', '两端不动，中间按相同间距排开', 'distH'],
    ['vdist', '垂直等距', '两端不动，中间按相同间距排开', 'distV'],
  ];

  function alignTargets() {
    return [...state.selected].map((id) => getNode(id)).filter(Boolean);
  }

  function worldSize(n) {
    const el = nodesEl.querySelector(`.node[data-id="${n.id}"]`);
    const k = state.view.k || 1;
    return { w: nodeWidth(n), h: el ? Math.round(el.getBoundingClientRect().height / k) : (n.h || 180) };
  }

  function applyAlign(mode, targets) {
    const list = targets || alignTargets();
    if (list.length < 2) return false;
    const sizes = list.map(worldSize);
    const minX = Math.min(...list.map((n) => n.x));
    const maxX = Math.max(...list.map((n, i) => n.x + sizes[i].w));
    const minY = Math.min(...list.map((n) => n.y));
    const maxY = Math.max(...list.map((n, i) => n.y + sizes[i].h));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    if (mode === 'hdist' || mode === 'vdist') {
      // 两端不动，中间的按「间距相等」重排。间距可能是负的（节点比可用空间还宽）——那就是贴紧。
      const horiz = mode === 'hdist';
      const sorted = list.map((n, i) => ({ n, s: sizes[i] }))
        .sort((a, b) => (horiz ? a.n.x - b.n.x : a.n.y - b.n.y));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = horiz ? (last.n.x + last.s.w) - first.n.x : (last.n.y + last.s.h) - first.n.y;
      const used = sorted.reduce((sum, it) => sum + (horiz ? it.s.w : it.s.h), 0);
      const gap = (span - used) / (sorted.length - 1);
      let cur = horiz ? first.n.x : first.n.y;
      sorted.forEach((it) => {
        if (horiz) it.n.x = Math.round(cur); else it.n.y = Math.round(cur);
        cur += (horiz ? it.s.w : it.s.h) + gap;
      });
    } else {
      list.forEach((n, i) => {
        const { w, h } = sizes[i];
        if (mode === 'left') n.x = minX;
        else if (mode === 'right') n.x = maxX - w;
        else if (mode === 'hcenter') n.x = Math.round(cx - w / 2);
        else if (mode === 'top') n.y = minY;
        else if (mode === 'bottom') n.y = maxY - h;
        else if (mode === 'vcenter') n.y = Math.round(cy - h / 2);
      });
    }
    renderAll();
    queueSave();
    commit();
    return true;
  }

  // 悬浮条：选中 2 个以上就直接浮出来，点一下立刻对齐（不用再点一次菜单）。
  // 按钮只建一次，之后只切显隐——每次选中都重建会让 hover 状态和焦点一起丢。
  let alignBarReady = false;
  function ensureAlignBar() {
    const bar = $('#alignBar');
    if (!bar || alignBarReady) return bar;
    ALIGN_ITEMS.forEach(([mode, label, tip, ico], i) => {
      if (i === 6) {                       // 6 个对齐 / 2 个分布，中间隔一条竖线
        const sep = document.createElement('span');
        sep.className = 'ab-sep';
        bar.appendChild(sep);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ab-btn';
      b.dataset.mode = mode;
      b.title = `${label} · ${tip}`;
      b.setAttribute('aria-label', label);
      b.innerHTML = icon(ico);
      b.onclick = (ev) => { ev.stopPropagation(); applyAlign(mode, alignTargets()); };
      bar.appendChild(b);
    });
    // 点工具条不能把选中清掉：pointerdown 会冒泡到画布，选择一没按钮就跟着消失了
    bar.onpointerdown = (ev) => ev.stopPropagation();
    alignBarReady = true;
    return bar;
  }

  // 跟着选区走：浮在选中节点包围盒的上方居中，上面放不下就翻到下方，再夹在视口内。
  // 固定贴底会挡住画布内容（尤其是底部那一排节点），跟随才是这类工具条的常规做法。
  // 拖动过程中不跟——工具条贴着指针抖，反而碍事；松手再归位。
  function positionAlignBar() {
    const bar = $('#alignBar');
    // 注意别在这里判 drag：选中本身就是在 pointerdown 里发生的，那时 drag 还没清，
    // 一判就把定位整个跳过（工具条会停在 CSS 兜底的位置——底部居中）。
    // 「拖动中不跟随」靠的是调用时机：拖动过程里没人调这个函数。
    if (!bar || bar.classList.contains('hidden')) return;
    const rects = alignTargets()
      .map((n) => nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`))
      .filter(Boolean)
      .map((el) => el.getBoundingClientRect());
    if (!rects.length) return;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const bw = bar.offsetWidth || 280;
    const bh = bar.offsetHeight || 42;
    const gap = 12;
    const margin = 10;
    let x = (left + right) / 2 - bw / 2;
    let y = top - gap - bh;
    if (y < margin) y = bottom + gap;                    // 上方空间不够就翻到选区下面
    x = Math.max(margin, Math.min(x, innerWidth - bw - margin));
    y = Math.max(margin, Math.min(y, innerHeight - bh - margin));
    bar.style.left = `${Math.round(x)}px`;
    bar.style.top = `${Math.round(y)}px`;
    bar.style.bottom = 'auto';
    bar.style.transform = 'none';
  }

  /**
   * Alt + 左键拖动节点 = 拖出一个副本，原节点留在原地。
   * 比 Ctrl+C / Ctrl+V 少两步（不用先复制、不用再粘到鼠标处），也是最顺手的一种「就地拷贝」。
   *
   * 两个细节是刻意的：
   * 1. 不在这里立刻复制 —— Alt 点一下（没拖）不该凭空多出一个藏在底下、看不见的副本。
   *    真拖出 3px 才落副本，然后**用当前这个 move 事件的坐标**接管拖动，
   *    startNodeDrag 自己会按「起点 = 此刻指针」算位移，后续照旧。
   * 2. 副本原位生成（dx=dy=0）再跟着指针走，视觉上就是「原件留在原地、一个新件被拉出来」。
   */
  function startAltCopyDrag(ev, list) {
    const ids = new Set(list.map((n) => n.id));
    const x0 = ev.clientX, y0 = ev.clientY;
    let fired = false;
    const move = (e) => {
      if (fired) return;
      if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 3) return;   // 屏幕像素阈值，别用世界坐标（缩放后会过敏）
      fired = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const copies = duplicateNodes(ids, { dx: 0, dy: 0 });
      if (!copies.length) return;
      renderAll(); paintSelection();
      startNodeDrag(e, copies);
      flash(`已复制 ${copies.length} 个节点 · 拖到位置松手`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startNodeDrag(ev, nodes) {
    const list = Array.isArray(nodes) ? nodes : [nodes];
    const rect0 = stage.getBoundingClientRect();
    const start = screenToWorld(ev.clientX, ev.clientY, rect0);
    const origin = list.map((n) => ({
      n, x: n.x, y: n.y,
      el: nodesEl.querySelector(`[data-id="${CSS.escape(n.id)}"]`),
    }));
    origin.forEach((o) => { if (o.el) o.el.classList.add('dragging'); });
    document.body.classList.add('dragging');
    drag = { mode: 'node' };
    const move = (e) => {
      const p = screenToWorld(e.clientX, e.clientY, rect0);
      const dx = p.x - start.x, dy = p.y - start.y;
      origin.forEach(({ n, x, y, el }) => {
        let nx = x + dx, ny = y + dy;
        if (state.snap) { nx = Math.round(nx / 28) * 28; ny = Math.round(ny / 28) * 28; }
        n.x = nx; n.y = ny;
        if (el) el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      });
      scheduleLayout();                        // 连线/分组/小地图每帧一次，不再每个 pointermove 全量重算
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      origin.forEach((o) => { if (o.el) o.el.classList.remove('dragging'); });
      document.body.classList.remove('dragging');
      drag = null;
      renderLinks(); renderGroups();
      positionAlignBar();                    // 拖完才跟过去，拖动中不追着指针跑
      queueSave(); commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // 连线规则：同类型可连；目标是 any 口（文本/图片/工作流节点）时什么都能接
  function linkAllows(kindWanted, kind) {
    return kind === 'any' || kind === kindWanted;
  }

  // 工作流节点的某个类型的第一个空闲插槽（连线按类型自动落位）
  function wfFreeSlot(node, kind) {
    if (kind !== 'text' && kind !== 'image') return null;
    const used = new Set(state.links.filter((l) => l.to === node.id).map((l) => l.toKey));
    return (node.slots || []).find((s) => s.kind === kind && !used.has(s.key)) || null;
  }

  function markLinkTargets(kindWanted) {
    portCache.forEach((el, key) => {
      const k = key.slice(key.indexOf(':') + 1);
      if (k === 'out') return;
      const node = getNode(key.slice(0, key.indexOf(':')));
      let ok = linkAllows(kindWanted, el.dataset.kind);
      if (ok && node && node.type === 'wf') ok = !!wfFreeSlot(node, kindWanted);
      el.classList.toggle('drop-ok', ok);
    });
  }

  function clearLinkTargets() {
    portCache.forEach((el) => el.classList.remove('drop-ok'));
  }

  function firstCompatiblePort(nodeId, kindWanted) {
    const node = getNode(nodeId);
    if (node && node.type === 'wf') return wfFreeSlot(node, kindWanted) ? 'in' : null;
    for (const [key, el] of portCache) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const k = key.slice(key.indexOf(':') + 1);
      if (k === 'out') continue;
      if (linkAllows(kindWanted, el.dataset.kind)) return k;
    }
    return null;
  }

  function nearestCompatiblePort(sx, sy, kindWanted, maxDist, excludeNode) {
    let best = null, bestD = maxDist;
    portCache.forEach((el, key) => {
      const i = key.indexOf(':');
      const nodeId = key.slice(0, i);
      const k = key.slice(i + 1);
      if (nodeId === excludeNode || k === 'out' || !linkAllows(kindWanted, el.dataset.kind)) return;
      const node = getNode(nodeId);
      if (node && node.type === 'wf' && !wfFreeSlot(node, kindWanted)) return;
      const r = el.getBoundingClientRect();
      const d = Math.hypot(sx - (r.left + r.width / 2), sy - (r.top + r.height / 2));
      if (d < bestD) { bestD = d; best = { to: nodeId, key: node && node.type === 'wf' ? 'in' : k }; }
    });
    return best;
  }

  function startLink(ev, fromId) {
    const src = getNode(fromId);
    const kindWanted = src.type === 'text' ? 'text' : src.type === 'wf' ? 'media' : 'image';
    const rect0 = stage.getBoundingClientRect();
    drag = { mode: 'link', from: fromId, kind: kindWanted };
    stage.classList.add('linking');
    setLinkHint(true);
    markLinkTargets(kindWanted);
    linkTemp = { a: portCenter(fromId, 'out'), b: screenToWorld(ev.clientX, ev.clientY, rect0) };
    renderLinks();
    const move = (e) => {
      if (!linkTemp) return;
      linkTemp.b = screenToWorld(e.clientX, e.clientY, rect0);
      scheduleLayout();
    };
    const finish = () => {
      stage.classList.remove('linking');
      setLinkHint(false);
      clearLinkTargets();
      linkTemp = null;
      drag = null;
      renderLinks();
    };
    const up = (e) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const inPort = target && target.closest ? target.closest('.port.in') : null;

      if (inPort) {
        const [toId, key] = splitPort(inPort.dataset.port);
        if (linkAllows(kindWanted, inPort.dataset.kind)) addLink(fromId, toId, key);
        else flash(`连线类型不匹配：${kindWanted} → ${inPort.dataset.kind}`);
        finish();
        return;
      }

      // 松手在目标节点上：直接接它的第一个兼容插槽（不用精确点中小圆点）
      const nodeEl = target && target.closest ? target.closest('.node') : null;
      if (nodeEl && nodeEl.dataset.id === fromId) {
        flash('松手在别的节点上才能连线');
        finish();
        return;
      }
      if (nodeEl) {
        const key = firstCompatiblePort(nodeEl.dataset.id, kindWanted);
        if (key) { addLink(fromId, nodeEl.dataset.id, key); finish(); return; }
        flash(kindWanted === 'media' ? '这个节点接不了结果：请用「图片输出」节点' : '这个节点没有可接的对应插槽');
        finish();
        return;
      }

      // 没点中：吸附到 26px 内最近的兼容端口
      const near = nearestCompatiblePort(e.clientX, e.clientY, kindWanted, 26, fromId);
      if (near) { addLink(fromId, near.to, near.key); finish(); return; }

      if (!(target && target.closest && target.closest('.node, .group-head, .popmenu'))) {
        // 拖到空白处松手：就地新建并连上
        openLinkMenu(fromId, e.clientX, e.clientY);
      }
      finish();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ---------------- 从输入口拖线：单个插槽 = 摘下来重接；多连的输入口 = 再加一条 ---------------- */
  function startPortDrag(ev, toId, key) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const n = getNode(toId);
    const linked = state.links.filter((l) => l.to === toId && l.toKey === key);
    if (isMultiIn(n, key)) {
      // 一个口上挂着好几条线时，「拖走」没法表达摘哪一条，所以拖 = 再加一条；
      // 原地松手（没移动）= 把这一口的线全断开，撤销可回。
      startReverseLink(ev, toId, key, { clickToClear: linked.length > 0 });
      return;
    }
    if (linked.length) {
      removeLink(toId, key);     // 先摘下来，等于把线的这头拎起来
      startLink(ev, linked[0].from);
      return;
    }
    startReverseLink(ev, toId, key);
  }

  function markSourceTargets(kind) {
    portCache.forEach((el, k) => {
      if (k.slice(k.indexOf(':') + 1) !== 'out') return;
      el.classList.toggle('drop-ok', !kind || kind === 'any' || el.dataset.kind === kind);
    });
  }

  let revCtx = null;   // 反向拖线（输入口 → 输出口）的上下文

  function beginReverseLink(clientX, clientY, toId, key, opts = {}) {
    const dstEl = portCache.get(`${toId}:${key}`) || nodesEl.querySelector(`[data-port="${CSS.escape(`${toId}:${key}`)}"]`);
    const targetKind = dstEl ? dstEl.dataset.kind : 'any';
    const rect0 = stage.getBoundingClientRect();
    revCtx = {
      toId, key, rect0,
      x0: clientX, y0: clientY, moved: false,
      clickToClear: !!opts.clickToClear,
    };
    drag = { mode: 'link-rev' };
    stage.classList.add('linking');
    setLinkHint(true);
    markSourceTargets(targetKind);
    linkTemp = { a: screenToWorld(clientX, clientY, rect0), b: portCenter(toId, key) };
    renderLinks();
  }

  function moveReverseLink(clientX, clientY) {
    if (!linkTemp || !revCtx) return;
    if (!revCtx.moved && Math.hypot(clientX - revCtx.x0, clientY - revCtx.y0) > 4) revCtx.moved = true;
    linkTemp.a = screenToWorld(clientX, clientY, revCtx.rect0);
    scheduleLayout();
  }

  function finishReverseLink(ev) {
    const ctx = revCtx;
    stage.classList.remove('linking');
    setLinkHint(false);
    clearLinkTargets();
    linkTemp = null;
    drag = null;
    revCtx = null;
    renderLinks();
    if (!ctx) return;
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const outPort = target && target.closest ? target.closest('.port.out') : null;
    if (outPort) {
      const fromId = splitPort(outPort.dataset.port)[0];
      addLink(fromId, ctx.toId, ctx.key);
      return;
    }
    // 没拖动就松手 = 点了一下：把这一口上挂着的线全断开
    if (ctx.clickToClear && !ctx.moved) removeLink(ctx.toId, ctx.key);
  }

  function startReverseLink(ev, toId, key, opts = {}) {
    beginReverseLink(ev.clientX, ev.clientY, toId, key, opts);
    const move = (e) => moveReverseLink(e.clientX, e.clientY);
    const up = (e) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      finishReverseLink(e);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // 工作流节点只有一个可视化输入口：拖 = 反向接输出；没拖动就松手 = 打开设置
  function startWfInputDrag(ev, n) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX, startY = ev.clientY;
    let moved = false;
    const move = (e) => {
      if (!moved) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
        moved = true;
        beginReverseLink(startX, startY, n.id, 'in');
      }
      moveReverseLink(e.clientX, e.clientY);
    };
    const up = (e) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) { openSlotSheet(n); return; }
      finishReverseLink(e);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function removeLinkById(id) {
    const l = state.links.find((x) => x.id === id);
    if (!l) { state.linkSel = null; renderLinks(); return; }
    state.links = state.links.filter((x) => x.id !== id);
    state.linkSel = null;
    const dst = getNode(l.to);
    if (dst && dst.type === 'out') dst.linked = false;
    rerenderNode(l.to);
    refreshRefsFor(l.to);
    renderLinks(); queueSave(); commit();
  }
  function splitPort(v) {
    const i = v.indexOf(':');
    return [v.slice(0, i), v.slice(i + 1)];
  }

  // 哪些输入口能接多张：文本 / 图片节点的 `in` 口是「一批参考素材」，可以同时接多张图；
  // 工作流插槽和图片输出口仍然一对一（一个插槽只能有一个来源，多来源在提交图上无法表达）。
  function isMultiIn(n, key) {
    return !!n && (n.type === 'image' || n.type === 'text') && key === 'in';
  }

  // 连线变了要立刻更新参考图缩略图：rerenderNode 在「用户正在这个节点里输入」时会跳过重建，
  // 而拖线进来的时候光标往往还在提示词框里，光等重建会看到一张不动的面板。
  function refreshRefsFor(id) {
    const n = getNode(id);
    if (!n) return;
    if (n.type === 'image' && n.gen) renderRefs(n);
    const port = portCache.get(`${id}:in`);
    if (port) {
      const count = state.links.filter((l) => l.to === id && l.toKey === 'in').length;
      port.classList.toggle('linked', count > 0);
      if (count) port.title = count > 1 ? `已连 ${count} 张 · 点击断开全部` : '点击断开连线';
    }
  }

  function addLink(from, to, key) {
    if (from === to) { flash('不能把节点连到自己'); return; }   // 自己连自己会让提交图出现无用连线
    const a = (portCache.get(`${from}:out`) || {}).dataset;
    const dst = getNode(to);
    if (dst && dst.type === 'wf') {
      const srcKind = a && a.kind;
      if (key === 'in') {
        const free = wfFreeSlot(dst, srcKind);
        if (!free) { flash('没有空闲的对应插槽，先在「设置」里断开一条'); return; }
        key = free.key;
      }
      const slot = (dst.slots || []).find((s) => s.key === key);
      if (!slot || slot.kind !== srcKind) { flash('这个插槽的类型不匹配'); return; }
    } else {
      const b = (portCache.get(`${to}:${key}`) || {}).dataset;
      if (a && b && !linkAllows(a.kind, b.kind)) { flash(`连线类型不匹配：${a.kind} → ${b.kind}`); return; }
    }
    if (isMultiIn(dst, key)) {
      // 同一个来源连两次没意义（两条线会精确重叠，看起来像什么都没发生）
      if (state.links.some((l) => l.to === to && l.toKey === key && l.from === from)) {
        flash('这个节点已经连上它了');
        return;
      }
    } else {
      state.links = state.links.filter((l) => !(l.to === to && l.toKey === key));
    }
    state.links.push({ id: uid('l'), from, to, toKey: key });
    const src = getNode(from);
    if (src && src.type === 'wf' && dst && dst.type === 'out') {
      dst.artifacts = src.artifacts || [];
      dst.statusText = src.statusText || '';
      dst.linked = true;
    }
    rerenderNode(to);
    rerenderNode(from);
    refreshRefsFor(to);
    renderLinks();
    queueSave(); commit();
  }

  function removeLink(toId, key) {
    state.links = state.links.filter((l) => !(l.to === toId && l.toKey === key));
    const dst = getNode(toId);
    if (dst && dst.type === 'out') dst.linked = false;
    rerenderNode(toId);
    refreshRefsFor(toId);
    renderLinks();
    queueSave(); commit();
  }

  function rerenderNode(id, force) {
    const n = getNode(id);
    const el = nodesEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!n || !el) return;
    // 用户正在这个节点里打字时不要重建，否则焦点会丢（force=true 时强制执行，例如产物回来）
    const focused = document.activeElement;
    if (!force && focused && el.contains(focused) && isFieldTarget(focused)) return;
    const fresh = buildNode(n);
    if (state.selected.has(id)) fresh.classList.add('selected');
    el.replaceWith(fresh);
    reindexNodePorts(id);
    renderLinks();
    // 节点被重建后尺寸/图可能变了（生成结果回来、换图），工具条要重新贴一次
    updateImgTools();
  }

  function removeNode(id) {
    const gone = getNode(id);
    if (gone && gone.timer) clearInterval(gone.timer);   // 先停轮询再移除，否则定时器会一直查
    if (slotSheetNode === id) closeSlotSheet();
    state.selected.delete(id);
    state.groups = state.groups
      .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((x) => x !== id) }))
      .filter((g) => g.nodeIds.length > 0);
    state.nodes = state.nodes.filter((n) => n.id !== id);
    state.links = state.links.filter((l) => l.from !== id && l.to !== id);
    const el = nodesEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) el.remove();
    dropNodePorts(id);
    renderLinks(); queueSave(); commit();
  }

  /* ---------------- 节点创建 ---------------- */
  function addTextNode(x, y, value = '') {
    const n = { id: uid('t'), type: 'text', title: '提示词', x, y, value };
    state.nodes.push(n); renderAll(); queueSave(); commit(); return n;
  }

  function addImageNode(x, y, extra = {}, raw = false) {
    const n = { id: uid('i'), type: 'image', title: '图片', x, y, dataURL: null, uploaded: null, gen: null, ...extra };
    // 新节点的工作流是按用途自动挑的（wfAuto）。用户在下拉里手选之后会置 false，
    // 之后生成时就不再被「按参考图自动换」覆盖——他明确选过，就该听他的。
    if (!n.gen) n.gen = { wf: pickWorkflow('txt2img'), wfAuto: true };
    state.nodes.push(n); renderAll(); queueSave(); if (!raw) commit(); return n;
  }

  function addOutNode(x, y, extra = {}, raw = false) {
    const n = { id: uid('o'), type: 'out', title: '图片输出', x, y, artifacts: [], statusText: '', linked: false, ...extra };
    state.nodes.push(n); renderAll(); queueSave(); if (!raw) commit(); return n;
  }

  // 把工作流的结果推给所有连着的输出节点
  function syncOutputs(wf) {
    state.links
      .filter((l) => l.from === wf.id && (getNode(l.to) || {}).type === 'out')
      .forEach((l) => {
        const out = getNode(l.to);
        out.artifacts = (wf.artifacts || []).slice();
        out.statusText = wf.statusText || '';
        out.linked = true;
        rerenderNode(out.id);
      });
  }

  async function addWorkflowNode(graph, title, raw = false) {
    const res = await postJson('/api/analyze', { graph });
    if (!res.ok) { flash(res.error || '工作流分析失败'); return null; }
    const c = centerOfView();
    const n = {
      id: uid('w'), type: 'wf', title: title || `工作流 ${state.seq}`, x: c.x - 180, y: c.y - 120,
      // 界面格式导入时服务端已经把 nodes/links 转成 API 图了，存的必须是那一份：
      // 存原始 UI 数据既跑不了（ComfyUI 只认 class_type），还会把导出者的
      // widgets_values（他上次填的提示词、图片名、种子）整份写进存档。
      graph: res.graph || graph,
      slots: res.slots, outputs: res.outputs, values: {},
      nodeCount: res.node_count, unknownTypes: res.unknown_types || [],
      status: 'idle', statusText: `共 ${res.node_count} 个节点`, artifacts: [],
    };
    (res.slots || []).forEach((s) => { n.values[s.key] = s.value; });
    state.nodes.push(n); renderAll(); queueSave(); if (!raw) commit(); return n;
  }

  // 从 API 图/文件导入工作流：直接 API map、{prompt:{...}}、或包一层的 {graph:{...}} 都认
  function extractApiGraph(data) {
    if (!data || typeof data !== 'object') return null;
    const isApi = (o) => o && typeof o === 'object' && Object.values(o).some((v) => v && typeof v === 'object' && v.class_type);
    if (isApi(data)) return data;
    if (isApi(data.prompt)) return data.prompt;
    if (isApi(data.graph)) return data.graph;
    return null;
  }

  async function addWorkflowAt(graph, title, x, y) {
    const n = await addWorkflowNode(graph, title || '工作流', true);
    if (!n) return null;
    n.x = Math.round(x);
    n.y = Math.round(y);
    renderAll(); queueSave(); commit();
    return n;
  }

  async function addWorkflowFromFile(file, x, y) {
    let data = null;
    try { data = JSON.parse(await file.text()); } catch { flash('不是有效的 JSON 文件'); return null; }
    let graph = extractApiGraph(data);
    if (!graph && !(data && Array.isArray(data.nodes))) {
      flash('没有识别到工作流（需要 API 图，或 ComfyUI 界面格式的 nodes）');
      return null;
    }
    const name = (file.name || '工作流').replace(/\.json$/i, '');
    // 界面格式交给服务端复刻 graphToPrompt 转换（analyze 内部处理）
    const n = await addWorkflowAt(graph || data, name, x, y);
    if (n) flash('已导入工作流：' + name);
    return n;
  }

  function importWorkflowFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const c = centerOfView();
      await addWorkflowFromFile(f, c.x - 180, c.y - 120);
    };
    inp.click();
  }

  async function ensureUploaded(n) {
    if (n.uploaded) return n.uploaded;
    if (!n.dataURL) throw new Error('图片节点还没有图片');
    const blob = await (await fetch(n.dataURL)).blob();
    const fd = new FormData();
    // 文件名带节点 id：两张不同节点拖入同名文件（photo.png）时不会在 ComfyUI input/ 里互相覆盖
    fd.append('image', blob, n.filename ? `${n.id}-${n.filename}` : `canvas-${n.id}.png`);
    fd.append('overwrite', 'true');
    const res = await api('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(res.error || '上传失败');
    const oldKey = imgKeyOf(n);          // 上传前的身份（node:<id>）
    n.uploaded = res.image;
    n.subfolder = res.subfolder || '';
    // 上传成功后改用服务端地址显示：base64 不再进存档（几张图就能撑爆 localStorage 配额）
    n.dataURL = artifactURL({ filename: res.image, subfolder: n.subfolder, type: res.type || 'input' });
    migrateMaskKey(n, oldKey);           // 遮罩跟着换键，否则上传一次就丢
    queueSave();
    rerenderNode(n.id, true);
    return n.uploaded;
  }

  /* ---------------- 运行 ---------------- */
  // 带遮罩上传：把笔画烘进原图的 alpha 通道再传，一个文件两用。
  // 不走 ensureUploaded 的缓存（n.uploaded）——同一张图换个遮罩就是另一个文件，
  // 复用它会把上一次的遮罩带进去。文件名固定成 <节点id>-mask.png + overwrite，
  // 不按时间戳堆一堆垃圾；ComfyUI 每次请求都重新读文件，不按文件名缓存。
  async function uploadMaskedImage(n, doc) {
    const cv = await bakeMaskCanvas(n, doc);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!blob) throw new Error('遮罩编码失败');
    const fd = new FormData();
    fd.append('image', blob, `${n.id}-mask.png`);
    fd.append('overwrite', 'true');
    const res = await api('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(res.error || '遮罩上传失败');
    return res.image;
  }

  // 把一个 dataURL 传进 ComfyUI 的 input/，只回文件名。
  // 参考图走这条：它不像图片节点那样常驻在画布上，没必要为此造一个节点。
  async function uploadImageData(dataURL, filename) {
    const blob = await (await fetch(dataURL)).blob();
    const fd = new FormData();
    fd.append('image', blob, filename);
    fd.append('overwrite', 'true');
    const res = await api('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(res.error || '上传失败');
    return res.image;
  }

  async function runWorkflow(n) {
    if (n.timer) { clearInterval(n.timer); n.timer = null; }
    n.status = 'running'; n.statusText = '构建任务…'; n.artifacts = [];
    syncOutputs(n);
    rerenderNode(n.id);
    let graph;
    try {
      graph = JSON.parse(JSON.stringify(n.graph));
      const links = state.links.filter((l) => l.to === n.id);
      for (const link of links) {
        const src = getNode(link.from);
        if (!src) continue;
        let value;
        if (src.type === 'text') value = src.value || '';
        else if (src.type === 'image') value = await ensureUploaded(src);
        else continue;
        // toKey 形如 "<节点id>.<输入名>"
        const dot = link.toKey.lastIndexOf('.');
        const nodeId = link.toKey.slice(0, dot);
        const inputName = link.toKey.slice(dot + 1);
        if (graph[nodeId] && graph[nodeId].inputs) graph[nodeId].inputs[inputName] = value;
      }
      const linkedKeys = new Set(links.map((l) => l.toKey));
      for (const [key, val] of Object.entries(n.values || {})) {
        if (linkedKeys.has(key)) continue;  // 已连线的插槽以连线值为准
        const dot = key.lastIndexOf('.');
        const nodeId = key.slice(0, dot);
        const inputName = key.slice(dot + 1);
        if (graph[nodeId] && graph[nodeId].inputs) graph[nodeId].inputs[inputName] = val;
      }
    } catch (err) {
      n.status = 'error'; n.statusText = `准备失败：${err.message}`; rerenderNode(n.id); return;
    }

    let res;
    try {
      res = await postJson('/api/run', { graph });
    } catch (err) {
      n.status = 'error'; n.statusText = `提交失败：${err.message}`;
      rerenderNode(n.id); return;
    }
    if (!res.ok) {
      const detail = res.error && res.error.node_errors ? JSON.stringify(res.error.node_errors).slice(0, 400) : JSON.stringify(res.error || {}).slice(0, 400);
      n.status = 'error'; n.statusText = `提交被拒：${detail}`;
      rerenderNode(n.id); return;
    }
    n.pid = res.prompt_id;
    n.status = 'queued'; n.statusText = `排队中 · ${res.prompt_id.slice(0, 8)}`;
    // 工作流节点直接运行也进同一条队列：用户不必分别看「图片节点在跑」和「工作流节点在跑」
    n.job = newJob(n, 'wf', { wf: n.title });
    n.job.pid = res.prompt_id;
    renderQueue();
    rerenderNode(n.id);
    resetProgress(n);            // 新一轮开始，上一次的数字不能留
    pollJob(n);
  }

  function paintWfStatus(n) {
    const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .wf-status`);
    if (!el) return;
    el.textContent = n.statusText || '';
    el.className = 'wf-status'
      + (n.status === 'error' ? ' error' : n.status === 'done' ? ' done' : (n.status === 'running' || n.status === 'queued') ? ' running' : '');
  }

  function pollJob(n) {
    const started = Date.now();
    n.pollOff = false;                 // 上一次可能被取消过，重新运行要复位
    n.timer = setInterval(async () => {
      if (n.status === 'done' || n.status === 'error') { clearInterval(n.timer); n.timer = null; return; }
      const res = await api(`/api/job?pid=${encodeURIComponent(n.pid)}`);
      // 取消之后这次请求才回来：别把 idle/已取消 刷回 running
      if (n.pollOff) { clearInterval(n.timer); n.timer = null; return; }
      if (!res.ok) {
        n.status = 'error'; n.statusText = res.error || '查询失败';
        clearInterval(n.timer); n.timer = null; rerenderNode(n.id);
        finishJob(n.job, 'error', n.statusText);
        return;
      }
      const secs = Math.round((Date.now() - started) / 1000);
      if (res.status === 'queued' || res.status === 'running') {
        n.lostPolls = 0;
        n.status = res.status;
        n.statusText = `${res.status === 'queued' ? '排队中' : '生成中'} · ${secs}s`;
        setProgress(n, res.progress ?? null);
        // 和图片节点同一条规矩：这一拍没数字就沿用上一次的，别把队列条目上的 % 抹掉
        patchJob(n.job, { phase: res.status, progress: n.progress ?? null, secs });
        paintWfStatus(n);          // 轻量更新，避免打断用户输入
        return;
      }
      // 刚提交时 /history 与 /queue 都可能还查不到，先宽限几轮；ComfyUI 重启后会永久丢失记录
      if (res.status === 'unknown') {
        n.lostPolls = (n.lostPolls || 0) + 1;
        if (n.lostPolls <= 4) {
          n.status = 'queued';
          n.statusText = `等待任务 · ${secs}s`;
          paintWfStatus(n);
          return;
        }
        clearInterval(n.timer); n.timer = null;
        n.status = 'error';
        n.statusText = '任务记录已丢失（ComfyUI 可能已重启），请重新运行';
        finishJob(n.job, 'error', '记录丢失');
        rerenderNode(n.id);
        return;
      }
      // 完成但产物暂未落齐时，再宽限几轮，避免误报「无产物」
      if (!res.error && res.completed && !(res.artifacts || []).length) {
        n.emptyPolls = (n.emptyPolls || 0) + 1;
        if (n.emptyPolls <= 3) {
          n.status = 'running';
          n.statusText = `收尾中 · ${secs}s`;
          paintWfStatus(n);
          return;
        }
      }
      n.emptyPolls = 0;
      clearInterval(n.timer); n.timer = null;
      finishProgress(n);
      if (res.error) {
        n.status = 'error'; n.statusText = `执行出错：${res.error}`;
        finishJob(n.job, 'error', String(res.error).slice(0, 30));
      } else if ((res.artifacts || []).length) {
        n.status = 'done'; n.artifacts = res.artifacts;
        n.statusText = `完成 · ${secs}s · ${res.artifacts.length} 个产物`;
        finishJob(n.job, 'done', `${res.artifacts.length} 个产物`);
      } else {
        n.status = 'done'; n.statusText = `完成 · ${secs}s（无产物，请确认工作流含保存节点）`;
        finishJob(n.job, 'done', '无产物');
      }
      syncOutputs(n);
      rerenderNode(n.id);
      queueSave();
    }, 1500);
  }

  async function cancelJob(n) {
    if (n && n.job && JOB_ALIVE.has(n.job.phase)) { await cancelQueuedJob(n.job); return; }
    await postJson('/api/cancel', { pid: n.pid, interrupt: true });
    n.status = 'idle'; n.statusText = '已请求中断';
    if (n.timer) { clearInterval(n.timer); n.timer = null; }
    clearProgress(n);
    rerenderNode(n.id);
  }

  /* ---------------- 生成队列 ---------------- */
  // 画布上每个节点各跑各的 prompt，ComfyUI 那边却只有一条 FIFO 队列——用户看不见它。
  // 8 个图片节点一起出图时，只能一个个点开面板看进度，也不知道「还排着几条」。
  // 这里把所有任务收成一份**运行态**清单（不进存档、不进撤销栈）：排队/生成中/完成/失败，
  // 顶栏一个入口，能逐条取消、能点回节点。
  const JOB_CAP = 24;                                  // 已结束的最多留这么多条
  const JOB_ALIVE = new Set(['queued', 'running']);

  function wfLabel(wf) {
    return String(wf || '').replace(/^preset:/, '').replace(/\.api\.json$/i, '');
  }

  // 图片节点标题基本都叫「图片」，光看标题分不清是哪一个——用提示词前缀当条目标题；
  // 工作流节点本来就有名字，直接用。
  function shortTitle(text, max = 18) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  function jobTitleOf(n, text) {
    const given = shortTitle(text);
    if (given) return given;
    if (!n) return '任务';
    const p = shortTitle((n.gen && n.gen.prompt) || '');
    if (n.type === 'image' && p) return p;
    return n.title || n.type || '任务';
  }

  function pruneJobs() {
    const keep = new Set(state.jobs.filter((j) => JOB_ALIVE.has(j.phase)));
    let room = JOB_CAP;
    state.jobs.forEach((j) => {
      if (keep.has(j)) return;
      if (room-- > 0) keep.add(j);
    });
    state.jobs = state.jobs.filter((j) => keep.has(j));
  }

  function newJob(n, kind, extra = {}) {
    const job = {
      id: `j${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      nodeId: n ? n.id : null,
      title: jobTitleOf(n, extra.title),
      kind,                                  // image（生成器） / wf（工作流节点运行）
      wf: wfLabel(extra.wf),
      dims: extra.dims || '',
      phase: 'queued', pid: null, progress: null,
      startedAt: Date.now(), endedAt: null, secs: 0, note: '',
    };
    state.jobs.unshift(job);
    pruneJobs();
    renderQueue();
    return job;
  }

  function patchJob(job, patch) {
    if (!job) return;
    // 终态不再接受心跳：取消的那一刻可能正好有一次轮询在飞，回来会把「已取消」刷成「生成中」
    if (!JOB_ALIVE.has(job.phase) && patch.phase && JOB_ALIVE.has(patch.phase)) return;
    Object.assign(job, patch);
    renderQueue();
  }

  function finishJob(job, phase, note = '') {
    if (!job) return;
    job.phase = phase;
    job.note = note;
    job.endedAt = Date.now();
    job.secs = Math.max(job.secs || 0, Math.round((job.endedAt - job.startedAt) / 1000));
    renderQueue();
  }

  // 下面两个是纯函数（不对 DOM 做任何事）：e2e 按名字抠出来直接测。
  // 多任务场景在浏览器里造不出来（要真提交给 ComfyUI），只能测这一层。
  function jobPhaseText(job) {
    if (!job) return '';
    if (job.phase === 'queued') return '排队中';
    if (job.phase === 'running') return `生成中${pctText(job.progress)}`;
    if (job.phase === 'done') return '完成';
    if (job.phase === 'error') return '失败';
    if (job.phase === 'canceled') return '已取消';
    return job.phase || '';
  }

  function jobMetaText(job) {
    if (!job) return '';
    const bits = [jobPhaseText(job)];
    if (job.dims) bits.push(job.dims);
    if (job.secs) bits.push(`${job.secs}s`);
    if (job.note) bits.push(job.note);
    if (job.wf) bits.push(job.wf);
    return bits.join(' · ');
  }

  function queueSummary(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    const count = (p) => list.filter((j) => j.phase === p).length;
    const live = count('queued') + count('running');
    if (!list.length) return { live: 0, text: '还没有任务' };
    const parts = [];
    if (live) parts.push(`${live} 个进行中`);
    if (count('done')) parts.push(`${count('done')} 个完成`);
    if (count('error')) parts.push(`${count('error')} 个失败`);
    if (count('canceled')) parts.push(`${count('canceled')} 个取消`);
    return { live, text: parts.join(' · ') };
  }

  function renderQueue() {
    const btn = document.getElementById('queueBtn');
    const badge = document.getElementById('queueCount');
    const sumEl = document.getElementById('queueSummary');
    const listEl = document.getElementById('queueList');
    const panel = document.getElementById('queuePanel');
    const sum = queueSummary(state.jobs);
    if (badge) {
      badge.textContent = String(sum.live);
      badge.classList.toggle('hidden', !sum.live);
    }
    if (btn) btn.classList.toggle('on', sum.live > 0);
    if (sumEl) sumEl.textContent = sum.text;
    // 面板关着就只更新角标：每 1.5 秒一次的任务 tick 不该去重建一个看不见的列表
    if (!listEl || !panel || panel.classList.contains('hidden')) return;
    listEl.innerHTML = '';
    if (!state.jobs.length) {
      const empty = document.createElement('div');
      empty.className = 'q-empty';
      empty.textContent = '还没有任务。图片节点选中后点「生成」，工作流节点点「运行」，都会出现在这里。';
      listEl.appendChild(empty);
      return;
    }
    state.jobs.forEach((job) => listEl.appendChild(buildJobRow(job)));
  }

  function buildJobRow(job) {
    const row = document.createElement('div');
    row.className = 'q-item';
    row.dataset.phase = job.phase;
    row.dataset.job = job.id;
    row.title = jobMetaText(job);

    const dot = document.createElement('span');
    dot.className = 'q-dot';
    const main = document.createElement('div');
    main.className = 'q-main';
    const title = document.createElement('div');
    title.className = 'q-title';
    title.textContent = job.title;
    const meta = document.createElement('div');
    meta.className = 'q-meta';
    meta.textContent = jobMetaText(job);
    main.appendChild(title);
    main.appendChild(meta);
    if (job.phase === 'running' && job.progress != null) {
      const bar = document.createElement('div');
      bar.className = 'q-bar';
      const fill = document.createElement('i');
      fill.style.width = `${clamp(job.progress, 0, 100)}%`;
      bar.appendChild(fill);
      main.appendChild(bar);
    }
    row.appendChild(dot);
    row.appendChild(main);

    if (JOB_ALIVE.has(job.phase)) {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'q-act';
      act.textContent = '取消';
      act.onclick = (ev) => { ev.stopPropagation(); cancelQueuedJob(job).catch(() => {}); };
      row.appendChild(act);
    }
    row.onclick = () => focusJobNode(job.nodeId);
    return row;
  }

  function positionQueuePanel() {
    const panel = document.getElementById('queuePanel');
    const btn = document.getElementById('queueBtn');
    if (!panel || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = panel.offsetWidth || 384;
    const h = panel.offsetHeight || 0;
    const edge = 10;
    const left = Math.min(Math.max(edge, r.right - w), window.innerWidth - w - edge);
    let top = r.bottom + 8;
    if (h && top + h > window.innerHeight - edge) top = Math.max(edge, r.top - h - 8);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function openQueue() {
    const panel = document.getElementById('queuePanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    renderQueue();             // 先填内容才量得到高度
    positionQueuePanel();
    document.getElementById('queueBtn').classList.add('on');
  }

  function closeQueue() {
    const panel = document.getElementById('queuePanel');
    if (panel) panel.classList.add('hidden');
  }

  function toggleQueue() {
    const panel = document.getElementById('queuePanel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) openQueue(); else closeQueue();
  }

  // 点面板外面收起（和 popmenu 一样挂在捕获阶段：画布上很多地方在冒泡早期就 stopPropagation）
  document.addEventListener('pointerdown', (ev) => {
    const panel = document.getElementById('queuePanel');
    if (!panel || panel.classList.contains('hidden')) return;
    if (ev.target.closest && ev.target.closest('#queuePanel, #queueBtn')) return;
    closeQueue();
  }, true);

  // 取消一个任务时，前端这侧必须一起停：轮询实例 + 节点上的 busy 标记。
  // 只发 cancel 请求的话，图片节点的「生成」按钮会一直灰着，看着像卡死；
  // 反过来只停前端不停后端，图过一会儿还是会掉到画布上。
  function stopNodePolling(job) {
    if (!job) return;
    // 先停这一次的轮询实例。句柄挂在任务上——挂在 gen 上会被面板重建拷贝走，
    // 取消时拿到的是一份旧的（停的是上一轮，本轮照跑）。
    if (job.poll) { job.poll.stop(); job.poll = null; }
    const n = getNode(job.nodeId);
    if (!n) return;
    try {
      if (n.timer) { clearInterval(n.timer); n.timer = null; }
      if (n.gen) {
        n.gen.busy = false;
        n.gen.status = '已取消';
        clearProgress(n);
        refreshGenPanel(n);
      }
      if (n.type === 'wf') {
        n.pollOff = true;                 // 让在飞的那次轮询回来时自己收手
        n.status = 'idle';
        n.statusText = '已取消';
        clearProgress(n);
        rerenderNode(n.id);
      }
    } catch { /* 节点可能已经被删了，界面这一侧能停就停，别把取消请求也带走 */ }
  }

  async function cancelQueuedJob(job) {
    if (!job || !JOB_ALIVE.has(job.phase)) return;
    stopNodePolling(job);
    job.phase = 'canceled';
    job.note = '已取消';
    job.endedAt = Date.now();
    job.secs = Math.max(job.secs || 0, Math.round((job.endedAt - job.startedAt) / 1000));
    renderQueue();
    if (!job.pid) return;
    try {
      const res = await postJson('/api/queue/cancel', { prompt_id: job.pid });
      if (!res.ok) job.note = `取消请求失败：${res.error || ''}`;
      else if (!res.removed) job.note = res.reason || '任务已结束';
      else job.note = res.interrupted ? '已中断' : '已从队列移除';
    } catch (err) {
      job.note = `取消请求失败：${err.message}`;
    }
    renderQueue();
  }

  async function cancelAllJobs() {
    const live = state.jobs.filter((j) => JOB_ALIVE.has(j.phase));
    if (!live.length) { flash('没有在跑的任务'); return; }
    await Promise.all(live.map((j) => cancelQueuedJob(j)));
    flash(`已取消 ${live.length} 个任务`);
  }

  function clearFinishedJobs() {
    const before = state.jobs.length;
    state.jobs = state.jobs.filter((j) => JOB_ALIVE.has(j.phase));
    renderQueue();
    flash(before === state.jobs.length ? '没有可清空的记录' : `已清空 ${before - state.jobs.length} 条记录`);
  }

  // 点队列条目 → 选中那个节点并把它挪到视口中央（节点可能已经滚出屏幕了）
  function focusJobNode(id) {
    const n = id ? getNode(id) : null;
    if (!n) { flash('这条任务的节点已经不在画布上了'); return; }
    selectOnly(n.id);
    const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`);
    const r = stage.getBoundingClientRect();
    const w = nodeWidth(n);
    const h = (el && el.offsetHeight) || n.h || 200;
    state.view.x = r.width / 2 - (n.x + w / 2) * state.view.k;
    state.view.y = r.height / 2 - (n.y + h / 2) * state.view.k;
    applyView();
    closeQueue();
  }

  /* ---------------- 产物 ---------------- */
  function artifactURL(a) {
    return `/api/view?filename=${encodeURIComponent(a.filename)}&subfolder=${encodeURIComponent(a.subfolder || '')}&type=${encodeURIComponent(a.type || 'output')}`;
  }

  async function pinArtifact(srcNode, a, url) {
    try {
      const blob = await (await fetch(url)).blob();
      const ext = (a.filename.match(/\.(\w+)$/) || [, 'png'])[1];
      const name = `pinned-${Date.now()}.${ext}`;
      const fd = new FormData();
      fd.append('image', blob, name);
      fd.append('overwrite', 'true');
      const up = await api('/api/upload', { method: 'POST', body: fd });
      if (!up.ok) throw new Error(up.error || '上传失败');
      // 用服务端代理 URL 而不是 blob:（blob URL 只在当前页面有效，存档恢复后会变破图）
      addImageNode(srcNode.x + nodeWidth(srcNode) + 60, srcNode.y, {
        dataURL: url, filename: name, uploaded: up.image, title: '图片（来自生成）',
      });
      flash('已钉到画布，可直接连到图生图工作流');
    } catch (err) {
      flash(`钉图失败：${err.message}`);
    }
  }

  function pickImage(n) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      n.filename = file.name;
      n.uploaded = null;
      if (n.gen) { n.gen.gallery = []; n.gen.idx = 0; n.gen.status = ''; }
      n.dataURL = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(file);
      });
      rerenderNode(n.id);
      try { await ensureUploaded(n); } catch (err) { flash(err.message); }
    };
    inp.click();
  }

  /* ---------------- 多图结果翻阅 ---------------- */
  // 生成器节点一次出好几张时，节点上只能摆一张：另外几张靠这里翻。
  // 三处入口（节点箭头 / 圆点 / ←→ 键 / 大图箭头）共用同一套逻辑，别再各写一份。
  function setGallery(n, i) {
    const gal = n && n.gen && n.gen.gallery;
    if (!gal || !gal.length) return false;
    const k = ((Math.round(i) % gal.length) + gal.length) % gal.length;   // 首尾环回
    if (k === (n.gen.idx || 0) && n.dataURL === gal[k].url) return false;
    n.gen.idx = k;
    n.dataURL = gal[k].url;
    n.uploaded = null;      // 换了图就得重新上传，别把上一张的 ComfyUI 名字带过去
    rerenderNode(n.id);
    queueSave();
    return true;
  }
  function stepGallery(n, delta) {
    const gal = n && n.gen && n.gen.gallery;
    if (!gal || gal.length < 2) return false;
    return setGallery(n, (n.gen.idx || 0) + delta);
  }

  /* ---------------- 生成历史：同一节点每次生成留一条 ---------------- */
  // 以前 gen.gallery 每次生成直接覆盖，「试到第 4 版最好，但已经回不去」是常态。
  // 现在每次生成往 gen.runs 里压一条（新的在前，最多 RUN_CAP 条）。
  // gallery 仍然是「当前显示的那一批」——渲染、翻页、提交全走老路径，这里只多一层记录，
  // 所以下游（参考图、资产抽屉、导出）一个都不用改。
  const RUN_CAP = 30;

  function runsOf(n) {
    const g = n && n.gen;
    if (!g) return [];
    if (!Array.isArray(g.runs)) {
      // 旧存档只有 gallery：合成一条「更早」，否则打开老画布会显示 0 次、点开是空的
      g.runs = g.gallery && g.gallery.length
        ? [{
            at: 0, prompt: g.prompt || '', seed: g.seed == null ? null : g.seed,
            w: null, h: null, batch: g.batch || 1, wf: g.wf || '',
            items: g.gallery.slice(), legacy: true,
          }]
        : [];
    }
    return dedupeRuns(g.runs);
  }

  // 历史里出现两条「同一批图」= 同一次生成被记了两遍，角标就会凭空多一次。
  // 已经写坏的老存档在这里顺手修掉：按「产物文件名」判重，留信息更全的那条
  // （非 legacy、带时间与尺寸的优先）。产物文件名每次生成都是新的，同名即同一批。
  function dedupeRuns(runs) {
    if (!Array.isArray(runs) || runs.length < 2) return runs || [];
    const seen = new Map();
    const out = [];
    for (const r of runs) {
      const key = (r.items || []).map((x) => x.filename || x.url || '').join('|');
      if (!key) { out.push(r); continue; }        // 没产物的记录（失败/占位）不参与判重
      const hit = seen.get(key);
      if (hit === undefined) { seen.set(key, out.length); out.push(r); continue; }
      const a = out[hit];
      const better = a.legacy && !r.legacy ? r : a;   // 真记录顶掉合成的「更早」
      out[hit] = better;
    }
    if (out.length !== runs.length) { runs.length = 0; runs.push(...out); }
    return runs;
  }

  // 只保证数组存在，**不做**「从 gallery 合成一条更早」的迁移——那是显示时才做的事。
  // 追加历史时若也走迁移，就会拿刚写进 gen.gallery 的这批图再造一条「更早」，
  // 和本次那条一模一样：一次生成显示「2 次」，历史里两条同一张图。
  function ensureRuns(n) {
    const g = n && n.gen;
    if (!g) return [];
    if (!Array.isArray(g.runs)) g.runs = [];
    return g.runs;
  }

  function pushRun(n, run) {
    const runs = ensureRuns(n);
    runs.unshift(run);
    if (runs.length > RUN_CAP) runs.length = RUN_CAP;
    return run;
  }

  function runTime(at) {
    if (!at) return '更早的一次';
    const d = new Date(at);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 「看」：把这一批换回节点上。gallery 就是"当前这批"，换掉它下游逻辑自动跟上
  function viewRun(n, i) {
    const run = runsOf(n)[i];
    if (!run || !run.items || !run.items.length) return false;
    n.gen.gallery = run.items.slice();
    n.gen.idx = 0;
    n.dataURL = run.items[0].url;
    n.uploaded = null;
    rerenderNode(n.id, true);
    queueSave();
    return true;
  }

  // 「派生」：把这套参数复制到新节点，原节点不动。
  // 「从这一版接着改」比「原地覆盖重来」安全——想回头随时还能看到原图。
  function deriveRun(n, i) {
    const run = runsOf(n)[i];
    if (!run) return null;
    const gal = (run.items || []).slice();
    const born = addImageNode(n.x + 60, n.y + 60, {
      dataURL: gal.length ? gal[0].url : null,
      gen: {
        prompt: run.prompt || '',
        wf: run.wf || defaultWorkflowId(),
        aspect: (n.gen && n.gen.aspect) || '1:1',
        size: (n.gen && n.gen.size) || '1k',
        custom: (n.gen && n.gen.custom) || null,
        batch: run.batch || 1,
        seedMode: run.seed == null ? 'random' : 'fixed',   // 派生默认钉住那次的种子，才好复现
        seed: run.seed == null ? null : run.seed,
        gallery: gal, idx: 0,
        extras: ((n.gen && n.gen.extras) || []).slice(),
        style: run.style ? { ...run.style } : null,   // 派生出来的节点接着用同一套风格
        runs: [{ ...run, items: gal }],
      },
    });
    flash(run.seed == null ? '已派生：参数已复制（种子随机）' : `已派生：种子固定为 ${run.seed}`);
    return born;
  }

  // 生成历史：宫格（三列缩略图）+ 单击看大图，大图旁边是这张的详细信息。
  // 以前是竖排文字行（时间/提示词/参数 + 看/派生），信息全但看不到图；宫格先把图摆出来，
  // 参数挪进大图的信息卡——「这张长什么样」和「它是什么参数」分开回答。
  function openRunList(anchor, n) {
    closePopMenu();
    const runs = runsOf(n);
    const menu = document.createElement('div');
    menu.className = 'popmenu run-list';
    const head = document.createElement('div');
    head.className = 'popmenu-title';
    head.textContent = `生成历史 · ${runs.length} 次（点缩略图看大图与参数）`;
    menu.appendChild(head);

    const sameItems = (a, b) => !!(a && b) && a.length === b.length && a.every((x, i) => x.url === b[i].url);
    const grid = document.createElement('div');
    grid.className = 'run-grid';
    runs.forEach((run, i) => {
      const items = run.items || [];
      if (!items.length) return;
      const on = sameItems(items, n.gen && n.gen.gallery);
      const cell = document.createElement('div');
      cell.className = 'run-cell' + (on ? ' on' : '');
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.title = `${runTime(run.at)} · ${items.length} 张${run.seed == null ? '' : ' · 种子 ' + run.seed}`;

      const box = document.createElement('div');
      box.className = 'rc-img';
      const img = document.createElement('img');
      img.src = items[0].url;
      img.alt = '';
      img.draggable = false;
      box.appendChild(img);
      if (items.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'rc-n';
        badge.textContent = `${items.length} 张`;
        box.appendChild(badge);
      }
      const time = document.createElement('div');
      time.className = 'rc-time';
      time.textContent = runTime(run.at) + (on ? ' · 当前' : '');

      cell.append(box, time);
      const open = () => {
        closePopMenu();
        openLightbox(items[0].url, items, 0, runInfo(n, i, run));
      };
      cell.onclick = open;
      cell.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      };
      grid.appendChild(cell);
    });
    menu.appendChild(grid);
    document.body.appendChild(menu);
    placePopMenu(menu, anchor);
    popAnchor = anchor;
    armPopClose(anchor);
  }

  // 大图旁边那张信息卡：分辨率取图片真实像素，参数取那一次生成的记录
  function runInfo(n, i, run) {
    return {
      prompt: run.prompt || '',
      rows: [
        ['张数', `${(run.items || []).length} 张`],
        ['种子', run.seed == null ? '随机' : String(run.seed)],
        ['工作流', (run.wf || '').replace(/^preset:/, '') || '—'],
        ['风格', (run.style && run.style.cn) || ''],
        ['时间', runTime(run.at)],
      ],
      // 两个动作都留着：「换回节点」= 把这一批图换成节点当前的图；「派生」= 复制参数到新节点
      actions: [
        { label: '换回节点', fn: () => viewRun(n, i) },
        { label: '派生到新节点', fn: () => deriveRun(n, i) },
      ],
    };
  }

  let lbList = null;      // 大图预览里能翻的那一组
  let lbIdx = 0;
  let lbInfo = null;      // 可选：大图左侧的信息卡（分辨率 / 提示词 / 参数 / 一个动作）
  function paintLightbox() {
    const gal = lbList;
    const img = $('#lightboxImg');
    if (gal && gal.length) {
      const it = gal[lbIdx];
      img.src = it.url || it;
      $('#lightbox').querySelector('.lb-count').textContent = `${lbIdx + 1} / ${gal.length}`;
    } else {
      $('#lightbox').querySelector('.lb-count').textContent = '';
    }
    const multi = !!(gal && gal.length > 1);
    $('#lightbox').querySelector('.lb-prev').classList.toggle('hidden', !multi);
    $('#lightbox').querySelector('.lb-next').classList.toggle('hidden', !multi);
    paintLightboxInfo();
  }
  // 分辨率优先用图片真实像素（工作流可能不按面板尺寸出图），拿不到才回落到记录值
  function paintLightboxInfo() {
    const box = $('#lightboxInfo');
    if (!lbInfo) {
      box.classList.add('hidden');
      box.classList.remove('open');
      $('#lightbox').classList.remove('has-info');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    $('#lightbox').classList.add('has-info');          // 让大图给抽屉让出右边
    if (!box.classList.contains('open')) requestAnimationFrame(() => box.classList.add('open'));
    const img = $('#lightboxImg');
    const real = img.naturalWidth && img.naturalHeight ? `${img.naturalWidth} × ${img.naturalHeight}` : '';
    const rows = (lbInfo.rows || []).filter(([, v]) => v != null && v !== '');
    if (lbList && lbList.length > 1) rows.push(['这一组', `${lbIdx + 1} / ${lbList.length}`]);
    box.innerHTML = `
      <div class="lbi-head"><span>详情</span><button type="button" class="lbi-close" title="关闭（Esc）">✕</button></div>
      <div class="lbi-dim">${esc(real || '尺寸读取中…')}</div>
      ${rows.map(([k, v]) => `<div class="lbi-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('')}
      <div class="lbi-label">提示词</div>
      <div class="lbi-prompt">${esc(lbInfo.prompt || '（没有关联的提示词）')}</div>
      ${(lbInfo.actions || []).length
        ? `<div class="lbi-acts">${lbInfo.actions.map((a, i) => `<button type="button" class="lbi-btn${i ? ' ghost' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`
        : ''}`;
    const closeBtn = box.querySelector('.lbi-close');
    if (closeBtn) closeBtn.onclick = (ev) => { ev.stopPropagation(); hideLightbox(); };
    box.querySelectorAll('.lbi-btn').forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const a = (lbInfo && lbInfo.actions || [])[Number(btn.dataset.i)];
        const fn = a && a.fn;      // 先取出来：hideLightbox 会把 lbInfo 清掉
        hideLightbox();
        if (fn) fn();
      };
    });
  }
  // 这个节点「真正会用」的提示词。连了文本节点的时候，实际送进工作流的是文本节点里的字
  // （面板里写的不生效，那句 placeholder 早就提示过了），可详情以前只读 gen.prompt ——
  // 于是「用提示词节点出的图」在大图详情里永远是「（没有关联的提示词）」。
  // 注意别反过来把值写回 gen.prompt：那样拆掉连线后，面板里会凭空多出一段没写过的词。
  function promptOf(n) {
    const g = (n && n.gen) || {};
    const textIn = state.links
      .filter((l) => l.to === n.id && l.toKey === 'in')
      .map((l) => getNode(l.from))
      .find((x) => x && x.type === 'text' && String(x.value || '').trim());
    if (textIn) return { text: String(textIn.value || '').trim(), from: `文本节点「${textIn.title || '提示词'}」` };
    const own = String(g.prompt || '').trim();
    if (own) return { text: own, from: '' };
    // 面板空、连线也没了（文本节点被删掉或断开）：退回最近一次生成用的那段。
    // 图确实是那段词出出来的，比摆一句「没有关联的提示词」有用。
    const last = String(((g.runs || [])[0] || {}).prompt || '').trim();
    return { text: last, from: last ? '上一次生成' : '' };
  }

  // 三处「放大」共用同一张详情抽屉：能拿到什么就给什么，拿不到的行留空（paint 时会过滤掉）
  function nodeImageInfo(n) {
    const g = (n && n.gen) || {};
    const runs = g.runs || [];
    const p = promptOf(n);
    return {
      prompt: p.text,
      rows: [
        ['来源', g.wf ? '生成' : (n && (n.filename || n.uploaded) ? '上传' : '画布')],
        ['工作流', (g.wf || '').replace(/^preset:/, '')],
        ['风格', (g.style && g.style.cn) || ''],
        ['种子', g.seed == null ? '' : String(g.seed)],
        ['生成次数', runs.length ? `${runs.length} 次` : ''],
        // 紧贴在「提示词」上面一行：读的人一眼知道这段话是从隔壁节点来的，不是面板里写的
        ['提示词来自', p.from],
      ],
    };
  }

  function assetImageInfo(item) {
    const rows = [
      ['来源', item.source === 'canvas' ? '画布上的图' : item.source === 'input' ? '上传素材' : '生成结果'],
      ['文件', item.filename || ''],
    ];
    let prompt = '';
    const n = item.node ? getNode(item.node) : null;     // 画布来源的资产带 node id，能顺出它的提示词
    if (n && n.gen) {
      const p = promptOf(n);
      prompt = p.text;
      if (n.gen.wf) rows.push(['工作流', n.gen.wf.replace(/^preset:/, '')]);
      if (n.gen.style && n.gen.style.cn) rows.push(['风格', n.gen.style.cn]);
      if (n.gen.seed != null) rows.push(['种子', String(n.gen.seed)]);
      if (p.from) rows.push(['提示词来自', p.from]);
    }
    return { prompt, rows };
  }

  function artifactImageInfo(a, n) {
    return {
      prompt: '',
      rows: [
        ['来源', n && n.type === 'out' ? '输出节点' : '工作流产物'],
        ['文件', a.filename || ''],
        ['类型', a.type || 'output'],
      ],
    };
  }

  function hideLightbox() {
    $('#lightbox').classList.add('hidden');
    $('#lightbox').classList.remove('has-info');
    $('#lightboxInfo').classList.remove('open');
    lbInfo = null;
  }
  function openLightbox(url, list, idx, info) {
    lbList = Array.isArray(list) && list.length ? list : null;
    lbIdx = lbList ? Math.min(Math.max(0, idx | 0), lbList.length - 1) : 0;
    lbInfo = info || null;
    if (!lbList) $('#lightboxImg').src = url;
    paintLightbox();
    $('#lightbox').classList.remove('hidden');
  }
  function stepLightbox(delta) {
    if (!lbList || lbList.length < 2) return;
    lbIdx = ((lbIdx + delta) % lbList.length + lbList.length) % lbList.length;
    paintLightbox();
  }
  $('#lightbox').onclick = () => hideLightbox();
  // 信息卡里要能选文字、点按钮，不能顺手把大图关掉
  $('#lightboxInfo').onclick = (ev) => ev.stopPropagation();
  $('#lightboxImg').addEventListener('load', () => paintLightboxInfo());
  $('#lightbox').querySelector('.lb-prev').onclick = (ev) => { ev.stopPropagation(); stepLightbox(-1); };
  $('#lightbox').querySelector('.lb-next').onclick = (ev) => { ev.stopPropagation(); stepLightbox(1); };

  /* ---------------- 快照 ---------------- */
  function clearCanvas() {
    if (!confirm('清空整块画布的节点？（画布本身保留）')) return;
    state.nodes = []; state.links = []; state.selected = new Set(); state.groups = [];
    applyView(); renderAll(); queueSave(); commit();
  }

  function exportCanvas() {
    const blob = new Blob([JSON.stringify(serialize(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.name || 'infisheet').replace(/[\\/:*?"<>|]/g, '_')}-${Date.now()}.json`;
    a.click();
  }

  function importCanvas() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try { load(JSON.parse(await f.text())); commit(); flash('画布已导入'); } catch (e) { flash(`导入失败：${e.message}`); }
    };
    inp.click();
  }

  function serialize() {
    return {
      version: 2,
      savedAt: Date.now(),
      bootAt: state.bootAt,
      seq: state.seq,
      view: state.view,
      name: state.name,
      snap: state.snap,
      linksHidden: state.linksHidden,
      minimapOn: state.minimapOn,
      groups: state.groups,
      links: state.links,
      nodes: state.nodes.map((n) => {
        // 扩图是**临时编辑态**：拖动时 gen.size/custom 被改写成「扩完之后」的尺寸，
        // 可图还是原图。这两项直接存进去，刷新后就变成「尺寸档写着 1344×1200、图是 688×736」，
        // 下次生成按错的尺寸跑 —— 正是这个功能最早要修的那个 bug。存开框前的值。
        const ob = n.gen && n.gen.outpaint && n.gen.opBackup ? n.gen.opBackup : null;
        return {
        id: n.id, type: n.type, title: n.title, x: n.x, y: n.y, w: n.w, h: n.h,
        value: n.value, dataURL: n.dataURL, uploaded: n.uploaded, filename: n.filename,
        graph: n.graph, slots: n.slots, outputs: n.outputs, values: n.values,
        nodeCount: n.nodeCount, unknownTypes: n.unknownTypes,
        artifacts: n.artifacts, status: 'idle', statusText: n.statusText,
        // 纯图片节点：只放一张图，不挂下面的生成面板。丢了它刷新后图片下面
        // 会突然长出一整块提示词 / 工作流 / 生成，节点高度也跟着变，画布布局就乱了
        plain: n.plain || undefined,
        // 生成器的提示词 / 工作流 / 画幅 / 张数 / 组图要跟着画布存下来，
        // 否则刷新后图片节点只剩一张图，参数和多图切换全丢（运行态 busy/status 不存）
        gen: n.gen ? {
          prompt: n.gen.prompt, wf: n.gen.wf,
          aspect: ob ? ob.aspect : n.gen.aspect, size: ob ? ob.size : n.gen.size,
          // 工作流是不是「按参考图自动挑的」：不存的话刷新后一律变 undefined，
          // 用户手选过的选择就丢了，下次生成会被自动改回去（遮罩也是靠它钉住的）
          wfAuto: n.gen.wfAuto !== false,
          custom: (ob ? ob.custom : n.gen.custom) || null,   // 自定义宽高：size==='custom' 时用它，切回档位也留着
          batch: n.gen.batch, gallery: n.gen.gallery, idx: n.gen.idx || 0,
          // 生成历史：每次一条（时间/提示词/种子/尺寸/产物）。上限见 RUN_CAP，别让存档无限长
          runs: n.gen.runs || [],
          // 种子：seedMode=random 时每次生成换一个，fixed 时钉住（复现某一张靠它）
          seedMode: n.gen.seedMode || 'random', seed: n.gen.seed == null ? null : n.gen.seed,
          extras: n.gen.extras || [],   // @ 引用来的图（只存节点 id，图本身还是走 /api/view）
          // 风格只存指针 {cat,i,cn}，不存那句四百字的英文模板：模板在 static/styles/ 里，
          // 存副本的话改了风格库，老画布还按旧句子出图，对不上号
          style: n.gen.style || null,
        } : null,
        // 遮罩：按「图片身份」索引的笔画列表（不是位图，也不是节点级字段）。
        // 只存矢量笔画，10 笔约 2KB；重开时精确重放，不做「从 PNG 反推」那种有损还原。
        masks: n.masks && Object.keys(n.masks).length ? n.masks : undefined,
        };
      }),
    };
  }

  function load(data) {
    if (!data || !Array.isArray(data.nodes)) return false;
    closeBigEditor();       // 换画布/撤销时别让放大编辑区挂在一个已经不存在的节点上
    assetItems = null;      // 换了画布，「画布上的图」这一半就变了，下次打开资产面板重算
    const beforeLinks = (data.links || []).length;
    state.nodes = data.nodes.map((n) => ({ ...n, status: 'idle', timer: null }));
    // 旧存档迁移：图片节点曾有过 in / ref 两种"参考图"连线，现在统一成「节点自己的图片」
    state.links = (data.links || []).map((l) => {
      const src = state.nodes.find((x) => x.id === l.from);
      const dst = state.nodes.find((x) => x.id === l.to);
      if (!src || !dst) return null;
      if (dst.type === 'image' && (l.toKey === 'prompt' || l.toKey === 'ref' || l.toKey === 'in')) {
        return { ...l, toKey: 'in' };   // 图片节点统一成一个 any 输入口
      }
      if (dst.type === 'wf') {
        const slot = (dst.slots || []).find((s) => s.key === l.toKey);
        if (slot && slot.kind !== 'text' && slot.kind !== 'image') return null;   // 数值类插槽不再有端口
      }
      return l;
    }).filter(Boolean);
    state.groups = data.groups || [];
    // 存档里的缩放也过一遍范围：老存档/手改过的文件可能带着 260% 以外的值
    state.view = data.view
      ? { ...data.view, k: clamp(Number(data.view.k) || 1, ZOOM_MIN, ZOOM_MAX) }
      : state.view;
    state.name = data.name || '未命名画布';
    state.snap = !!data.snap;
    state.linksHidden = !!data.linksHidden;
    state.minimapOn = !!data.minimapOn;
    state.seq = data.seq || state.nodes.length + 1;
    // 版本号跟着存档走：MCP 那边每写一次都 +1，这里落后就代表画布被别人改过。
    // 撤销栈里的快照没有 rev（它是画布内容的快照，不是服务端那一头的版本），
    // 撤销时保留当前 rev —— 否则一次 Ctrl+Z 会把 baseRev 打回 0，之后所有保存都被判「过期」。
    if (data.rev !== undefined) state.rev = Number(data.rev) || 0;
    else if (!undoStack.applying) state.rev = 0;
    dirty = false;
    applyView(); renderAll();
    syncChrome();
    if (beforeLinks > state.links.length) flash(`已按新结构清理 ${beforeLinks - state.links.length} 条旧连线`);
    return true;
  }

  let lastSavedSnap = '';
  // 「本地有还没写进服务端的改动」。和 lastSavedSnap 不同，这个标记不会被 savedAt 搅乱：
  // 外部同步只在它为 false 时自动进行，避免把用户正在打的字冲掉。
  let dirty = false;
  let staleWarnAt = 0;
  const revPoll = { on: false };

  function setSaveState(text) {
    const el = document.getElementById('saveState');
    if (el) el.textContent = text;
  }

  function flushSave() {
    clearTimeout(saveTimer);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(serialize())); } catch { /* 超配额忽略 */ }
    saveToServer();
    flash('已保存');
  }

  async function saveToServer() {
    if (!state.hydrated) return;
    const snap = JSON.stringify(serialize());
    if (snap === lastSavedSnap) return;
    setSaveState('保存中…');
    try {
      const url = state.projectId ? '/api/projects/' + encodeURIComponent(state.projectId) : '/api/canvas';
      const res = await api(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // baseRev：我是从哪一版改的。服务端对不上就拒绝（画布可能刚被 MCP 改过），
        // 不带上这个字段的话，一次保存就会把 AI 刚才那一串操作静默抹掉。
        body: JSON.stringify({ canvas: JSON.parse(snap), baseRev: state.projectId ? state.rev : undefined }),
      });
      if (!res.ok) throw new Error(res.error || '保存失败');
      if (res.stale) {
        if (res.lastWriter === 'mcp') {
          // 对方是 MCP：它代表用户主动让 AI 做的操作，这里直接跟上，别把画布卡死在旧版本。
          // 本地那份会先进撤销栈（见 pullExternal），按 Ctrl+Z 就能拿回来。
          await pullExternal();
          return;
        }
        // 另一个标签页/旧会话：只提示，不抢——它可能正在等人继续操作
        if (Date.now() - staleWarnAt > 60000) {
          staleWarnAt = Date.now();
          flash('画布在别处被改过：这次改动没保存');
        }
        setSaveState('有新版本，未覆盖');
        return;
      }
      if (res.rev) state.rev = res.rev;
      dirty = false;
      lastSavedSnap = snap;
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      setSaveState('已保存 ' + hh + ':' + mm);
    } catch {
      setSaveState('保存失败');
    }
  }

  // 把服务端最新那版拉下来替换内存里的画布。
  // 不做节点级合并：两边的意图搅在一起，谁也说不清结果归谁。
  // 但**本地那份先压进撤销栈**——「同步」不该等于「把用户刚打的字吃掉」，
  // 按一下 Ctrl+Z 就能回到自己那一版（撤销快照不带 rev，回来之后照样能存）。
  async function pullExternal() {
    if (!state.projectId) return false;
    const res = await api('/api/projects/' + encodeURIComponent(state.projectId)).catch(() => null);
    if (!res || !res.ok || !res.canvas) return false;
    const hadLocal = dirty;
    commit();
    // 外部那版已经盖到内存里了，**排队中的那次保存必须撤掉**：
    // 它是「同步之前」排的，600ms 后照样会 fire，把刚拉下来的这一版又写回去一遍。
    // 内容虽然一样，rev 却白涨一格——「同步之后浏览器不该再写」这条就守不住了。
    clearTimeout(saveTimer);
    dirty = false;
    load(res.canvas);
    lastSavedSnap = '';
    setSaveState('已同步外部改动');
    flash(hadLocal
      ? '画布已被 MCP 更新：你的改动在撤销栈里（Ctrl+Z 可退回）'
      : '画布已被 MCP 更新，已同步');
    return true;
  }

  // 每 4 秒对一次版本号：MCP 在后台建节点、出图，浏览器里能跟着长出来。
  // 不做「标签页看不见就不轮询」：headless / 后台窗口根本不触发，同步会整条哑掉。
  // 有未保存改动时也照样跟上——但不能悄悄丢，所以 pullExternal 会先把本地压进撤销栈。
  async function pollProjectRev() {
    if (state.serverDown) return;                 // 服务已经被关掉：别再往一个空端口发请求
    if (!state.hydrated || !state.projectId || revPoll.on) return;
    revPoll.on = true;
    try {
      const meta = await api(`/api/projects/${encodeURIComponent(state.projectId)}?meta=1`).catch(() => null);
      if (!meta || !meta.ok || !meta.rev || meta.rev === state.rev) return;
      await pullExternal();
    } finally {
      revPoll.on = false;
    }
  }

  function queueSave() {
    if (!state.hydrated) return;
    dirty = true;
    setSaveState('未保存…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(serialize())); } catch { /* 超配额忽略 */ }
      if (autosaveOn()) saveToServer();
      else setSaveState('自动保存已关闭');
    }, 600);
  }

  /* ---------------- 顶栏 / 弹窗 ---------------- */
  function flash(msg) {
    const badge = $('#queueBadge');
    badge.textContent = msg;
    badge.classList.remove('hidden');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => badge.classList.add('hidden'), 3200);
  }

  function fitView() {
    if (!state.nodes.length) { state.view = { x: 80, y: 60, k: 0.85 }; applyView(); return; }
    const r = stage.getBoundingClientRect();
    const boxes = state.nodes.map(nodeBox);      // 用实测宽高，别再拿固定 520 估算高度
    const minX = Math.min(...boxes.map((b) => b.x)) - 40;
    const minY = Math.min(...boxes.map((b) => b.y)) - 60;
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 40;
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 40;
    // 「适配」只负责装下，不带放大到 800%——上限压到 1.2，免得一两个节点被撑满整屏
    const k = clamp(Math.min(r.width / (maxX - minX), r.height / (maxY - minY)), ZOOM_MIN, 1.2);
    state.view = { k, x: -minX * k + (r.width - (maxX - minX) * k) / 2, y: -minY * k + 30 };
    applyView(); queueSave();
  }

  async function saveToLibrary(n) {
    const name = prompt('工作流名称', n.title || 'workflow');
    if (!name) return;
    const res = await api(`/api/library/${encodeURIComponent(name)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graph: n.graph }),
    });
    flash(res.ok ? `已存入工作流库：${name}` : (res.error || '保存失败'));
    if (res.ok) await refreshWorkflows();     // 存完立刻出现在下拉/首页/快速开始里
  }

  // 资产库：只浏览 + 挑一个加到画布。导入 / 改名 / 换分类 / 设默认 / 删除全在
  // 全局设置的工作流区——那套入口预设和库工作流都能管，弹窗里再摆一份就是重复。
  let wfQuery = '';
  async function openModal() {
    $('#modal').classList.remove('hidden');
    wfQuery = '';                             // 每次打开都从完整列表开始，别留着上次的搜索词
    await refreshWorkflows();                 // 打开时重新拉库，别显示开局时的旧列表
    renderWorkflows();
    // 运行记录要打 ComfyUI 的 /history：离线时是 502。以前一开弹窗就拉，控制台先红一条，
    // 而用户多半只是想看看工作流。改成点开那个标签页才拉（见下面的 tab 点击）。
  }

  // 弹窗里每页顶上的一句话。这里不再摆「新增 / 删除」按钮：那几件事在全局设置的
  // 工作流区已经有一套（导入、改名、换分类、设默认、删除，预设和库工作流都能管），
  // 两处各摆一份只会让人不知道点哪个。
  function modalHint(text) {
    const bar = document.createElement('div');
    bar.className = 'pane-bar';
    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.textContent = text;
    bar.appendChild(tip);
    return bar;
  }

  // 资产库里的工作流：**一份列表**，预设和库合成（和设置里那份同一个数据源 presetOptions），
  // 每张卡标「内置 / 我的」。以前分「内置预设」「我的工作流库」两页——同一批东西渲染两遍，
  // 而"预设 vs 库"本来就是实现细节（随包分发的 presets/ 目录 vs 你自己的 data/library/），
  // 用户不该为了找一个工作流在两页之间来回切。
  function renderWorkflows() {
    const pane = $('#pane-wf');
    pane.innerHTML = '';
    pane.appendChild(modalHint('挑一个加到画布。改名 / 换分类 / 设默认 / 删除在「设置 → 工作流」。'));

    const search = document.createElement('div');
    search.className = 'wf-search';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.spellcheck = false;
    inp.autocomplete = 'off';
    inp.placeholder = '搜名字或分类…';
    inp.value = wfQuery;
    search.appendChild(inp);
    const list = document.createElement('div');
    list.className = 'list';
    pane.append(search, list);

    const addCard = (o, showCat) => {
      const card = document.createElement('div');
      card.className = 'card';
      // 分组视图里不再重复分类名（组头已经写了）；搜索结果是扁平的，才需要它
      card.innerHTML = `<div class="info"><b>${esc(o.label)}<em class="src">${o.source === 'preset' ? '内置' : '我的'}</em></b>`
        + `<span>${o.nodes} 个节点${showCat ? ' · ' + esc(o.catLabel) : ''}</span></div>`
        + '<button class="primary">加到画布</button>';
      card.onclick = async () => {
        const graph = await loadGraphById(o.id);
        if (!graph) { flash('读不到这份工作流'); return; }
        await useGraph(graph, o.label);
      };
      list.appendChild(card);
    };

    const paint = () => {
      const all = presetOptions();
      const q = wfQuery.trim().toLowerCase();
      const hits = q ? all.filter((o) => `${o.label} ${o.catLabel}`.toLowerCase().includes(q)) : all;
      list.innerHTML = '';
      if (!all.length) {
        list.innerHTML = '<p class="tip">还没有工作流。在「设置 → 工作流」里点「导入工作流…」加一个。</p>';
        return;
      }
      if (!hits.length) {
        list.innerHTML = `<p class="tip">没有匹配「${esc(wfQuery.trim())}」的工作流。</p>`;
        return;
      }
      // 搜索结果是扁平的：几条命中摊在几个分类标题下反而更难扫
      if (q) { hits.forEach((o) => addCard(o, true)); return; }
      // 不搜索时按**用户分类**分组（设置里能改名 / 新增 / 删除的那套）。
      // 早先这里按服务端推断的能力分类分组，用户改了自己的分类，这里却纹丝不动。
      const groups = new Map();
      hits.forEach((o) => {
        if (!groups.has(o.group)) groups.set(o.group, []);
        groups.get(o.group).push(o);
      });
      const catIds = wfCategories().map((c) => c.id);
      const order = catIds.filter((c) => groups.has(c))
        .concat([...groups.keys()].filter((c) => !catIds.includes(c)));
      order.forEach((cat) => {
        const items = groups.get(cat) || [];
        const head = document.createElement('div');
        head.className = 'preset-group';
        head.innerHTML = `<span>${esc(catName(cat))}</span><em>${items.length}</em>`;
        list.appendChild(head);
        items.forEach((o) => addCard(o, false));
      });
    };

    inp.oninput = () => { wfQuery = inp.value; paint(); };
    paint();
  }

  // 从一次运行记录里挖出人看得懂的东西：提示词 + 采样参数 + 尺寸。
  // /history 只给 API 图和产物，提示词得自己从图里找：
  // 先踢掉被 KSampler.negative 引用的节点（那是负面词），再踢掉 LLM 扩写节点的系统提示，
  // 剩下的取最长的那个当正向提示词——正向词通常比负面词长，比系统提示更像人写的。
  function historyMeta(e) {
    const graph = (e && e.graph) || {};
    const nodes = Object.entries(graph).map(([id, n]) => ({ id, ...(n || {}) }));
    const inp = (n) => (n && n.inputs) || {};

    const negative = new Set();
    nodes.forEach((n) => {
      const neg = inp(n).negative;
      if (Array.isArray(neg)) negative.add(String(neg[0]));
    });

    const texts = [];
    nodes.forEach((n) => {
      if (negative.has(n.id)) return;
      const inputs = inp(n);
      ['text', 'prompt', 'string'].forEach((k) => {
        const v = inputs[k];
        if (typeof v !== 'string') return;
        const t = v.trim();
        if (t.length < 2) return;
        if (/^You are an expert/i.test(t)) return;     // LLM 扩写节点的系统提示，不是人写的
        texts.push(t);
      });
    });
    texts.sort((a, b) => b.length - a.length);

    const sampler = nodes.find((n) => /KSampler/i.test(n.class_type || '')) || null;
    const si = inp(sampler);
    const latent = nodes.find((n) => {
      const x = inp(n);
      return Number.isFinite(x.width) && Number.isFinite(x.height);
    });
    const li = inp(latent);
    const seed = si.seed != null ? si.seed : si.noise_seed;
    const arts = (e && e.artifacts) || [];

    return {
      prompt: texts[0] || '',
      rows: [
        ['节点', `${nodes.length} 个`],
        ['产物', `${arts.length} 个`],
        ['采样', sampler ? `${si.steps == null ? '?' : si.steps} 步 · CFG ${si.cfg == null ? '?' : si.cfg} · ${si.sampler_name || '?'}` : '—'],
        ['种子', seed == null ? '—' : String(seed)],
        ['尺寸', li.width ? `${li.width} × ${li.height}` : '—'],
      ],
    };
  }

  // 运行记录：宫格（一格 = 一次运行，封面取第一张产物），单击看大图 + 详情。
  // 没有产物的记录也要在：它们照样能导入工作流，所以给个占位块，点了直接导入。
  function openHistory(e, imgs) {
    const meta = historyMeta(e);
    const importIt = () => useGraph(e.graph, `历史 ${e.prompt_id.slice(0, 8)}`);
    if (!imgs.length) { importIt(); return; }        // 没图可看，直接导入
    openLightbox(artifactURL(imgs[0]), imgs.map((a) => ({ url: artifactURL(a) })), 0, {
      prompt: meta.prompt,
      rows: meta.rows,
      actions: [{ label: '用这个工作流', fn: importIt }],
    });
  }

  async function renderHistory() {
    const pane = $('#pane-history');
    pane.innerHTML = '<p class="tip">读取中…</p>';
    const res = await api('/api/history?limit=15');
    const list = (res.entries || []).filter((e) => e.has_graph);
    pane.innerHTML = '';
    if (!list.length) {
      pane.innerHTML = '<p class="tip">ComfyUI 里还没有带 API 图的运行记录。先在 ComfyUI 里跑一次任意工作流，这里就能抓到它的 API 图。</p>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'hist-grid';
    list.forEach((e) => {
      const imgs = (e.artifacts || []).filter((a) => a.kind === 'image');
      const cell = document.createElement('div');
      cell.className = 'run-cell';
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.title = `${e.prompt_id.slice(0, 12)} · ${e.node_count} 个节点 · ${(e.artifacts || []).length} 个产物`;

      const box = document.createElement('div');
      box.className = 'rc-img';
      if (imgs.length) {
        const img = document.createElement('img');
        img.src = artifactURL(imgs[0]);
        img.alt = '';
        img.draggable = false;
        box.appendChild(img);
        if (imgs.length > 1) {
          const badge = document.createElement('span');
          badge.className = 'rc-n';
          badge.textContent = `${imgs.length} 图`;
          box.appendChild(badge);
        }
      } else {
        const ph = document.createElement('div');
        ph.className = 'rc-empty';
        ph.innerHTML = `${icon('layers')}<span>${e.node_count} 个节点</span><span>无产物</span>`;
        box.appendChild(ph);
      }
      const meta = document.createElement('div');
      meta.className = 'rc-time';
      meta.textContent = imgs.length ? `${imgs.length} 图 · ${e.node_count} 节点` : `${e.node_count} 节点`;

      cell.append(box, meta);
      cell.onclick = () => openHistory(e, imgs);
      cell.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openHistory(e, imgs); }
      };
      grid.appendChild(cell);
    });
    pane.appendChild(grid);
  }

  async function useGraph(graph, title) {
    if (!graph) { flash('该记录没有 API 图'); return; }
    $('#modal').classList.add('hidden');
    // 资产库可以从首页打开（挑一个不用先进画布），但挑完是要往画布上落节点的
    showCanvas();
    const n = await addWorkflowNode(graph, title);
    if (n) flash(`已添加工作流节点：${title}`);
  }

  /* ---------------- 事件绑定 ---------------- */
  // 顶栏与底部工具条共用一套动作；原来只给 #bar 绑了监听，
  // 顶栏的「首页 / 工作流 / 故事板」三个按钮点了没反应。
  function handleAct(act, btn) {
    if (act === 'add-menu') {
      const r = btn.getBoundingClientRect();
      openAddMenu(r.left + r.width / 2, r.top, true);
      return;
    }
    if (act === 'home') { showHome(); return; }
    if (act === 'workflows' || act === 'add-wf') { showCanvas(); openModal(); return; }
    if (act === 'storyboard') { showCanvas(); addScriptNode(); return; }
    if (act === 'settings') { openSettingsSheet(); return; }
    if (act === 'assets') { showCanvas(); openAssetSheet(); return; }
    if (act === 'tutorial') { document.getElementById('helpSheet').classList.toggle('hidden'); return; }
    if (act === 'history') { showCanvas(); openModal(); switchModalTab('history'); return; }
    if (act === 'pan-mode') { setTool(true); return; }
    if (act === 'select-mode') { setTool(false); return; }
    if (act === 'help') { flash('拖空白框选 · 空格/中键平移 · 滚轮缩放 · 双击空白建节点 · Ctrl+G 打组 · F 适配视图'); return; }
    if (act === 'all-tools') {
      openPopMenu(btn, [
        ['撤销（Ctrl+Z）', () => undo()],
        ['重做（Ctrl+Shift+Z）', () => redo()],
        ['复制（Ctrl+C）', () => copySelection()],
        ['粘贴（Ctrl+V）', () => pasteClipboard()],
        ['创建副本（Ctrl+D）', () => duplicateSelection()],
        ['打组（Ctrl+G）', () => createGroup(state.selected)],
        ['适配视图', () => fitView()],
        ['导出画布 JSON', () => exportCanvas()],
        ['导入画布 JSON', () => importCanvas()],
        ['导入工作流 JSON…', () => importWorkflowFile()],
        ['历史画布…', () => openCanvasHistory()],
        ['工具条位置…', () => { closePopMenu(); openDockMenu(btn); }],
        ['清空画布节点', () => clearCanvas(), 'danger'],
      ]);
    }
  }

  function bindActions(host) {
    if (!host) return;
    host.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      handleAct(btn.dataset.act, btn);
    });
  }
  bindActions($('#dockWrap'));   // orb 已拆到 #bar 外面，改绑外层容器
  bindActions($('#topBar'));

  // 生成队列：入口在顶栏状态条里，面板是 body 直接子节点（见 index.html 的注释）
  const queueBtnEl = document.getElementById('queueBtn');
  if (queueBtnEl) queueBtnEl.addEventListener('click', (ev) => { ev.stopPropagation(); toggleQueue(); });
  const queueAllEl = document.getElementById('queueCancelAll');
  if (queueAllEl) queueAllEl.addEventListener('click', () => cancelAllJobs());
  const queueClearEl = document.getElementById('queueClear');
  if (queueClearEl) queueClearEl.addEventListener('click', () => clearFinishedJobs());
  renderQueue();

  stage.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.group-head')) return;
    const onNode = ev.target.closest('.node, .port');
    const wantPan = state.panMode || spaceDown || ev.button === 1;
    if (onNode && !wantPan) return;          // 点在节点上：交给节点自己拖动

    if (wantPan) {                            // 平移：移动模式 / 空格+拖 / 中键拖
      const startPan = { x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y };
      stage.classList.add('panning');
      const move = (e) => {
        state.view.x = startPan.vx + (e.clientX - startPan.x);
        state.view.y = startPan.vy + (e.clientY - startPan.y);
        applyView();
      };
      const up = () => {
        stage.classList.remove('panning');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        queueSave();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    if (state.linkSel) { state.linkSel = null; renderLinks(); }
    // 默认：拖空白 = 框选（按住 Shift 为加选）；右键/侧键不参与，避免右键拖出个选框
    if (ev.button !== 0) return;
    startMarquee(ev);
  });

  // 点连线选中，Delete / Backspace 删除
  linksEl.addEventListener('pointerdown', (ev) => {
    const hit = ev.target.closest('[data-link]');
    if (!hit) return;
    ev.stopPropagation();
    ev.preventDefault();
    state.linkSel = state.linkSel === hit.dataset.link ? null : hit.dataset.link;
    renderLinks();
  });

  // 连线中点那颗删除键。它挂在 <body> 上（不在 #stage 里）——stage 的 pointerdown 会
  // 「点空白就清掉 linkSel」，按钮要是在 stage 里面，按下的一瞬间按钮就先被隐藏了，
  // click 根本走不到。也用事件委托：app.js 的 <script> 排在 #linkDel 前面，直接绑会拿到 null。
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest || !ev.target.closest('#linkDel')) return;
    ev.stopPropagation();
    if (state.linkSel) removeLinkById(state.linkSel);
  });

  // 框选：拖出矩形，松手时选中与其相交的节点
  function startMarquee(ev) {
    const additive = ev.shiftKey;
    if (!additive) selectOnly(null);
    const base = additive ? new Set(state.selected) : new Set();
    const box = document.createElement('div');
    box.className = 'rubber';
    stage.appendChild(box);
    stage.classList.add('marquee');
    const rect0 = stage.getBoundingClientRect();
    const start = { x: ev.clientX - rect0.left, y: ev.clientY - rect0.top };   // 屏幕坐标（相对画布）
    let moved = false;
    const move = (e) => {
      const cx = e.clientX - rect0.left, cy = e.clientY - rect0.top;
      if (Math.abs(cx - start.x) + Math.abs(cy - start.y) > 3) moved = true;
      box.style.cssText = `left:${Math.min(start.x, cx)}px;top:${Math.min(start.y, cy)}px;`
        + `width:${Math.abs(cx - start.x)}px;height:${Math.abs(cy - start.y)}px`;
    };
    const up = (e) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      stage.classList.remove('marquee');
      box.remove();
      if (!moved) return;                    // 只是点了一下空白：清空选择即可，不算框选
      const a = screenToWorld(ev.clientX, ev.clientY);
      const b = screenToWorld(e.clientX, e.clientY);
      const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      state.selected = new Set(base);
      state.nodes.forEach((n) => {
        const nb = nodeBox(n);
        const hit = nb.x < r.x + r.w && nb.x + nb.w > r.x && nb.y < r.y + r.h && nb.y + nb.h > r.y;
        if (hit) state.selected.add(n.id);
      });
      paintSelection();
      if (state.selected.size > 1) flash(`已框选 ${state.selected.size} 个节点`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- 双击空白：新建节点菜单 ----
  const addMenu = document.getElementById('addMenu');

  function closeAddMenu() { if (addMenu) addMenu.classList.add('hidden'); }

  function openAddMenu(clientX, clientY, openAbove) {
    if (!addMenu) return;
    const p = screenToWorld(clientX, clientY);
    // 分两组：能直接落到画布上的节点 / 需要先选工作流的入口。
    // 每项前面一枚图标（和节点标题上的图标同一套 IconPark），扫一眼就知道点哪个。
    const groups = [
      ['新建节点', [
        ['text', '提示词', () => addTextNode(p.x - 140, p.y - 60)],
        ['image', '图片', () => addImageNode(p.x - 125, p.y - 60)],
        // 「加载图片…」和「图片」是两件事：前者选完就带着图，后者是空白节点等拖文件进来。
        ['upload', '加载图片…', () => pickImageFiles(p.x - 125, p.y - 60)],
        ['out', '图片输出', () => addOutNode(p.x - 150, p.y - 60)],
      ]],
      ['工作流', [
        ['wf', '打开工作流…', () => openModal()],
        ['book', '从 JSON 导入…', () => importWorkflowFile()],
      ]],
    ];
    addMenu.innerHTML = '';
    groups.forEach(([title, list], gi) => {
      if (gi) {
        const sep = document.createElement('div');
        sep.className = 'am-sep';
        addMenu.appendChild(sep);
      }
      const h = document.createElement('div');
      h.className = 'am-title';
      h.textContent = title;
      addMenu.appendChild(h);
      list.forEach(([ic, label, fn]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'am-item';
        // 图标单独一层：文字和图标各自有尺寸，换字体/换图标都不会把行高带歪。
        // textContent 仍然只有文案（e2e 按文案找按钮）。
        b.innerHTML = `<span class="am-ico" aria-hidden="true">${icon(ic)}</span>`
          + `<span class="am-label">${esc(label)}</span>`;
        b.onclick = () => { closeAddMenu(); fn(); };
        addMenu.appendChild(b);
      });
    });
    // 键盘：↓↑ 在项之间走，Enter 直接建，Esc 关。菜单本身可聚焦（tabindex=-1 不抢 Tab 键），
    // 但**不**自动高亮第一项——鼠标用户不该看到一条凭空出现的选中态。
    if (!addMenu.dataset.kb) {
      addMenu.dataset.kb = '1';
      addMenu.tabIndex = -1;
      addMenu.addEventListener('keydown', (ev) => {
        const btns = [...addMenu.querySelectorAll('.am-item')];
        if (!btns.length) return;
        const at = btns.indexOf(document.activeElement);
        if (ev.key === 'Escape') { ev.preventDefault(); closeAddMenu(); return; }
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          const d = ev.key === 'ArrowDown' ? 1 : -1;
          const next = at < 0 ? (d > 0 ? 0 : btns.length - 1) : (at + d + btns.length) % btns.length;
          btns[next].focus();
        }
      });
    }
    const r = stage.getBoundingClientRect();
    addMenu.classList.remove('hidden');        // 先显示才能量到真实尺寸
    const mw = addMenu.offsetWidth;
    const mh = addMenu.offsetHeight;
    const margin = 8;
    const gap = 6;                             // 离光标留一点缝：否则第一项正好压在手底下
    const mx = clientX - r.left, my = clientY - r.top;
    let left = mx + gap;
    if (left + mw > r.width - margin) left = mx - mw - gap;    // 右边放不下就翻到左侧
    if (left < margin) left = margin;
    let top = my + gap;
    if (openAbove || top + mh > r.height - margin) top = my - mh - gap;   // 下面放不下（或从工具条点开）就翻到上面
    if (top < margin) top = margin;
    addMenu.style.left = left + 'px';
    addMenu.style.top = top + 'px';
    addMenu.focus({ preventScroll: true });
  }

  stage.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('.node, .group-head, #addMenu')) return;
    openAddMenu(ev.clientX, ev.clientY);
  });
  // 记住指针位置：Ctrl+V 粘贴到鼠标处
  stage.addEventListener('pointermove', (ev) => { pointerWorld = screenToWorld(ev.clientX, ev.clientY); });
  document.addEventListener('pointerdown', (ev) => {
    if (addMenu && !ev.target.closest('#addMenu')) closeAddMenu();
  });

  // ---- 拖文件进画布 → 图片节点（自动上传进 ComfyUI input/）----
  function readDataURL(file) {
    return new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(file);
    });
  }

  async function addImageFromFile(file, x, y, opts = {}) {
    const n = addImageNode(x, y, { title: '图片', ...opts }, true);
    n.filename = file.name;
    n.dataURL = await readDataURL(file);
    rerenderNode(n.id);
    try { await ensureUploaded(n); } catch (err) { flash(err.message); }
    commit();
    return n;
  }

  // 「加载图片…」：从磁盘挑（支持多选）直接变成图片节点，选完就带着图。
  // 和「图片」（空白节点，等拖文件进来）分开，是因为多数人双击画布就是想放一张图。
  // 复用同一个 input：每次都新建的话，选过的文件会一直挂在内存里；清 value 是为了
  // 能把同一张图再选一次（不清空不触发 change）。
  function pickImageFiles(x, y) {
    let inp = document.getElementById('imgPicker');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'imgPicker';
      inp.accept = 'image/*';
      inp.multiple = true;
      // 留在文档里但要能点开系统选择框：挪出视口 + 透明（display:none 的 input 在部分环境点不开）
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.onchange = async () => {
      const files = [...(inp.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) { flash('只能加载图片文件（PNG / JPG / WEBP）'); return; }
      for (let i = 0; i < files.length; i++) {
        // plain: 加载进来的就是一张图，节点下面不拖生成面板（要生成点标题上的「生成」药丸）
        await addImageFromFile(files[i], x + i * 30, y + i * 30, { plain: true });
      }
      flash(files.length > 1 ? `已加载 ${files.length} 张图片` : `已加载「${files[0].name}」`);
    };
    inp.click();
  }

  stage.addEventListener('dragover', (ev) => { ev.preventDefault(); });
  stage.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const files = [...(ev.dataTransfer?.files || [])];
    const images = files.filter((f) => f.type.startsWith('image/'));
    const jsons = files.filter((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
    if (!images.length && !jsons.length) { flash('拖入图片，或 API 格式的 .json 工作流'); return; }
    const p = screenToWorld(ev.clientX, ev.clientY);
    let i = 0;
    for (const f of jsons) {
      await addWorkflowFromFile(f, p.x + i * 40, p.y + i * 40);
      i += 1;
    }
    for (const f of images) {
      // 和「加载图片…」同一个口径：拖进来的图就是一张图，节点下面不拖生成面板
      // （想要生成点标题上的「生成」药丸）。两条入口给的节点必须长得一样，否则
      // 「我拖进来的怎么没有面板 / 选菜单的怎么有」这种事迟早会被问一次。
      await addImageFromFile(f, p.x + i * 30, p.y + i * 30, { plain: true });
      i += 1;
    }
    if (images.length) flash('已加入 ' + images.length + ' 张图片');
  });

  stage.addEventListener('wheel', (ev) => {
    // 光标在输入框 / 富文本框里时，滚轮交给它自己滚（否则长提示词根本滚不动）
    if (isFieldTarget(ev.target)) return;
    ev.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const { x, y, k } = state.view;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const nk = clamp(k * factor, ZOOM_MIN, ZOOM_MAX);
    // 边滚边把缩放菜单收起来，否则它会一直挂在那儿挡着
    const zm = document.getElementById('zoomMenu');
    if (zm && !zm.classList.contains('hidden')) zm.classList.add('hidden');
    state.view = {
      k: nk,
      x: mx - (mx - x) * (nk / k),
      y: my - (my - y) * (nk / k),
    };
    applyView(); queueSave();   // 连线在 #world 坐标系里，平移/缩放无需重算
  }, { passive: false });

  let spaceDown = false;
  document.addEventListener('keydown', (ev) => {
    const homeEl = document.getElementById('home');
    if (homeEl && !homeEl.classList.contains('hidden')) return;
    if (ev.code !== 'Space') return;
    const t = ev.target;
    const typing = isFieldTarget(t);
    // 焦点在按钮/链接上时，空格应该「按下它」，而不是被当成平移修饰键吞掉
    const activatable = t && typeof t.closest === 'function'
      && t.closest('button, a, [role="button"], summary');
    if (typing || activatable) return;
    if (!spaceDown) { spaceDown = true; stage.classList.add('space-pan'); }
    ev.preventDefault();
  });
  document.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') { spaceDown = false; stage.classList.remove('space-pan'); }
  });

  // 按住 Alt = 下一手「拖出来的是副本」。只切光标（不弹提示）：Alt 自己也参与 Alt+F 适配视图，
  // 每次按都闪一条提示会很吵；光标变 copy 已经足够说明「这一拖会复制」。
  let altDown = false;
  function paintAltCursor() {
    document.body.classList.toggle('alt-down', altDown);
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Alt' && !altDown) { altDown = true; paintAltCursor(); }
  });
  document.addEventListener('keyup', (ev) => {
    if (ev.key === 'Alt') { altDown = false; paintAltCursor(); }
  });
  // Alt+Tab 切走时 keyup 收不到，回来光标会一直卡在 copy 上
  window.addEventListener('blur', () => { if (altDown) { altDown = false; paintAltCursor(); } });

  document.addEventListener('keydown', (ev) => {
    const homeEl = document.getElementById('home');
    if (homeEl && !homeEl.classList.contains('hidden')) return;
    const tag = ev.target;
    if (isFieldTarget(tag)) return;
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
      if (k === 'y') { ev.preventDefault(); redo(); return; }
      if (k === 'c') { if (copySelection()) ev.preventDefault(); return; }
      if (k === 'v') { ev.preventDefault(); pasteClipboard(); return; }
      if (k === 'd') { ev.preventDefault(); duplicateSelection(); return; }
      if (k === 's') { ev.preventDefault(); flushSave(); return; }
      if (k === 'k') { ev.preventDefault(); openSettingsSheet(); return; }
    }
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); fitView(); return; }
      if (ev.key === 'n' || ev.key === 'N') {
        ev.preventDefault();
        const sr = stage.getBoundingClientRect();
        openAddMenu(sr.left + sr.width / 2, sr.top + sr.height / 2);
        return;
      }
    }
    // 多图结果翻阅：大图里优先，其次是「只选中一个图片节点」时直接翻页。
    // 这两处以前只能靠 7px 的小圆点，基本等于没有入口。
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      const d = ev.key === 'ArrowRight' ? 1 : -1;
      if (!$('#lightbox').classList.contains('hidden') && lbList) {
        ev.preventDefault();
        stepLightbox(d);
        return;
      }
      if (state.selected.size === 1) {
        const only = getNode([...state.selected][0]);
        if (only && only.gen && only.gen.gallery && only.gen.gallery.length > 1) {
          ev.preventDefault();
          stepGallery(only, d);
          return;
        }
      }
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (state.linkSel) { ev.preventDefault(); removeLinkById(state.linkSel); return; }
      if (state.selected.size) {
        ev.preventDefault();
        [...state.selected].forEach((id) => removeNode(id));
        state.selected = new Set();
      }
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'g' || ev.key === 'G')) {
      ev.preventDefault();
      createGroup(state.selected);
    }
    if (ev.altKey && ev.shiftKey && (ev.key === 'f' || ev.key === 'F')) {
      ev.preventDefault(); fitView(); return;
    }
    // 只有「单按 F」才适配视图；Ctrl/⌘+F 留给浏览器查找
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === 'f' || ev.key === 'F')) fitView();
    if (ev.key === 'Escape') {
      // 逐层关：大图盖在资产面板/画布上面，Esc 只该关最上面那层。
      // 一起关掉的话，用户从资产里点开大图、看完按 Esc，整个资产面板也跟着没了。
      if (!$('#lightbox').classList.contains('hidden')) {
        ev.preventDefault();
        hideLightbox();
        return;
      }
      $('#modal').classList.add('hidden');
      closeSlotSheet();
      closeSettingsSheet();
      closeCanvasHistory();
      closeAssetSheet();
      closeAddMenu();
      closePopMenu();     // 里面的 refMenu = null 也会顺手收掉 @ 引用菜单
      const zm = document.getElementById('zoomMenu');
      if (zm) zm.classList.add('hidden');
      const hs = document.getElementById('helpSheet');
      if (hs) hs.classList.add('hidden');
      // 扩图边框：Esc 收起（不烘，什么都不改）
      const opn = imgToolNode();
      if (opn && outpaintOn(opn)) closeOutpaint(opn);
    }
  });

  $('#modalClose').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').addEventListener('click', (ev) => {
    if (ev.target.id === 'modal') $('#modal').classList.add('hidden');
  });
  document.querySelectorAll('#modalTabs .tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('#modalTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      ['wf', 'history'].forEach((name) => {
        $(`#pane-${name}`).classList.toggle('hidden', name !== tab.dataset.tab);
      });
      // 只有真的要看运行记录时才去问 ComfyUI（离线时这一步会 502，没必要在开弹窗时就撞上）
      if (tab.dataset.tab === 'history') renderHistory();
    };
  });

  /* ---------------- MCP 接入灯 ---------------- */
  // 服务端每收到一次 MCP 的 initialize 就记一笔（mcp_server._CONN），health 顺手带回来。
  // 这里只做一件事：把「有没有 AI 接进来」翻译成一盏灯 + 一句人话。
  // 灯亮 = 有客户端完成了握手，此刻它能直接建节点 / 改参数 / 出图；进程重启会归零，
  // 客户端会自己重连，灯自然会再亮——比留一个可能是假的状态更诚实。
  function popMcpChip(chip) {
    chip.classList.remove('pop');
    void chip.offsetWidth;      // 强制重排，动画才肯重播
    chip.classList.add('pop');
  }

  function updateMcpChip(res) {
    const seg = document.getElementById('mcpSeg');
    if (!seg) return;
    // 老服务端没有 /mcp：这条指示没意义，藏掉比分不清「离线」还是「不支持」强
    if (!Array.isArray(res.features) || !res.features.includes('mcp')) {
      seg.classList.add('hidden');
      return;
    }
    const chip = document.getElementById('mcpChip');
    const dot = document.getElementById('mcpDot');
    const text = document.getElementById('mcpText');
    if (!chip || !dot || !text) return;
    seg.classList.remove('hidden');
    // 老服务端有 feature、没有状态字段：不隐藏（用户会以为没做），而是如实说「重启才准」
    const m = res.mcp && typeof res.mcp === 'object' ? res.mcp : null;
    if (!m) {
      dot.className = 'dot';
      chip.classList.remove('on');
      chip.classList.add('pending');
      text.textContent = 'MCP 待接入';
      chip.title = '服务端还是 MCP 之前的版本，读不到接入状态\n重启 python server.py 后这里显示真实状态';
      state.mcpSeen = false;
      return;
    }
    // alive 是服务端租约算出来的「此刻还在不在」：老服务端没有这个字段，
    // 没有就按「已连接」处理——不能因为读不到新字段就把一盏好好的灯灭掉。
    const alive = m.alive !== false;
    if (m.connected && alive) {
      const app = (m.client || '').trim();
      // 「MCP 客户端」是服务端在没有握手时的泛称，不是名字——别把它当应用名显示
      const named = !!app && app !== 'MCP 客户端' && app !== '未命名客户端';
      const who = named ? `${app}${m.clientVersion ? ' ' + m.clientVersion : ''}` : '未知应用';
      const when = m.at ? new Date(m.at * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      const sid = m.session ? m.session.slice(0, 8) : '';
      dot.className = 'dot ok';
      chip.classList.remove('pending');
      chip.classList.add('on');
      // 名字放在灯里：用户要的就是「哪个应用接的」，不该只藏在 tooltip 里
      text.textContent = named ? `MCP 已连接 · ${app}` : 'MCP 已连接';
      chip.title = [
        named ? `${who} 正通过 MCP 接入这块画布` : '某个 MCP 客户端正通过 MCP 接入这块画布',
        `${when ? `连上于 ${when} · ` : ''}已调用 ${m.calls || 0} 次工具`
          + `${m.protocol ? ` · 协议 ${m.protocol}` : ''}${sid ? ` · 会话 ${sid}` : ''}`,
        // 没有协议号 = 这个进程没收到过握手（服务重启后客户端接着老会用）
        ...(m.protocol ? [] : [named
          ? '本进程没收到握手：名字由 stdio 桥转述（服务重启后续接的会话）'
          : '本进程没收到握手：多半是服务重启后的续接会话，客户端名未知']),
        // 名字是「拉起桥的那个应用」：说清楚，免得用户以为客户端自报名就是这个
        ...(m.clientSource === 'host'
          ? ['这个名字取自拉起 MCP 桥的应用——客户端自报的是服务器别名，没有采用']
          : []),
        `端点：${location.origin}/mcp`,
        'AI 现在可以直接建节点、改参数、跑生成，画布会自己同步过来',
        '点一下看怎么接入（MCP 安装）',
      ].join('\n');
      // 只在「刚连上」时提示一次：刷新页面看到一盏早就亮着的灯，不该再弹一遍
      if (!state.mcpSeen) {
        if (m.age == null || m.age < 120) {
          popMcpChip(chip);
          flash(named
            ? `MCP 已连接：${who} 现在可以直接操作这块画布`
            : 'MCP 已连接：AI 现在可以直接操作这块画布');
        }
        state.mcpSeen = true;
      }
    } else if (m.connected) {
      // 连过、但现在没心跳了：stdio 桥没了（客户端关窗 / 崩溃 / 被强杀）。
      // 这不是「待接入」——那会让人以为从来没连上过，而实际是刚掉线。
      const app = (m.client || '').trim();
      const named = !!app && app !== 'MCP 客户端' && app !== '未命名客户端';
      const when = m.at ? new Date(m.at * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      dot.className = 'dot';
      chip.classList.remove('on');
      chip.classList.add('pending');
      text.textContent = named ? `MCP 已断开 · ${app}` : 'MCP 已断开';
      chip.title = [
        `${named ? app : '上次那个客户端'} 已经不在线了：桥的心跳停了 ${Math.round(m.stale || 0)}s，超过租约 ${Math.round(m.lease || 0)}s`,
        `${when ? `上次连上于 ${when} · ` : ''}已调用 ${m.calls || 0} 次工具`,
        '服务端还在，客户端重新接上会自己变绿，不用刷新页面',
        `端点：${location.origin}/mcp`,
        '点一下看怎么接入（MCP 安装）',
      ].join('\n');
      // 断线后再连上要能重新弹一次「已连接」，所以这里把「见过」清掉
      state.mcpSeen = false;
    } else {
      dot.className = 'dot';
      chip.classList.remove('on');
      chip.classList.add('pending');
      text.textContent = 'MCP 待接入';
      chip.title = [
        '这块画布已开放 MCP 端点，还没有 AI 客户端接进来',
        `端点：${location.origin}/mcp`,
        '在 AI 客户端的连接器里添加并信任后，这里会自动点亮',
        '点一下看怎么接入（MCP 安装）',
      ].join('\n');
      state.mcpSeen = false;
    }
  }

  /* ---------------- MCP 接入面板（安装入口） ---------------- */
  // 顶栏那盏灯不只是状态：MCP 的门槛全在第一步——用户得知道有这个端点、要写一行 stdio 命令、
  // 路径还不能写错。所以点灯就打开「怎么接」的说明，配置直接给成可复制的 JSON，必要时替他写进文件。
  let mcpSetupData = null;
  let mcpSetupClient = 'workbuddy';

  async function copyText(text) {
    // 127.0.0.1 在部分内核里不算 secure context，clipboard API 会直接抛；
    // 兜底用老办法（临时 textarea + execCommand），否则「复制」按钮点了没反应最伤人。
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 落到兜底 */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  function mcpSetupNote(text, kind = '') {
    const el = document.getElementById('mcpSetupNote');
    if (!el) return;
    el.textContent = text;
    el.className = `mcp-note${kind ? ' ' + kind : ''}`;
  }

  function paintMcpSetupStatus(m) {
    const box = document.getElementById('mcpSetupStatus');
    const dot = document.getElementById('mcpSetupDot');
    const txt = document.getElementById('mcpSetupState');
    if (!box || !dot || !txt) return;
    const info = m && typeof m === 'object' ? m : null;
    if (info && info.connected && info.alive !== false) {
      const app = (info.client || '').trim();
      const named = !!app && app !== 'MCP 客户端' && app !== '未命名客户端';
      box.classList.add('on');
      dot.className = 'dot ok';
      txt.innerHTML = `已接入${named ? ' · <b>' + esc(app) + '</b>' : ''}　已调用 ${info.calls || 0} 次工具`;
      return;
    }
    box.classList.remove('on');
    if (info && info.connected) {
      dot.className = 'dot';
      txt.textContent = `刚才那个客户端已经断开（心跳停了 ${Math.round(info.stale || 0)}s），重新接上会自动变绿`;
      return;
    }
    dot.className = 'dot';
    txt.textContent = '还没有客户端接进来。按下面的配置接一个，接上之后这里会自动变绿。';
  }

  function renderMcpSetupTabs() {
    const host = document.getElementById('mcpSetupTabs');
    if (!host || !mcpSetupData) return;
    host.innerHTML = '';
    (mcpSetupData.clients || []).forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mcp-tab';
      b.dataset.client = c.id;
      b.textContent = c.label;
      b.onclick = () => selectMcpSetupClient(c.id);
      host.appendChild(b);
    });
  }

  function selectMcpSetupClient(id) {
    if (!mcpSetupData) return;
    const list = mcpSetupData.clients || [];
    const c = list.find((x) => x.id === id) || list[0];
    if (!c) return;
    mcpSetupClient = c.id;
    document.querySelectorAll('#mcpSetupTabs .mcp-tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.client === c.id);
    });
    const pathEl = document.getElementById('mcpSetupPath');
    if (pathEl) {
      pathEl.textContent = c.path;
      pathEl.title = c.path;
    }
    const flag = document.getElementById('mcpSetupExists');
    if (flag) {
      flag.textContent = c.exists ? '已存在 · 会合并并先备份' : '还没有 · 会新建';
      flag.className = `mcp-flag${c.exists ? ' ok' : ''}`;
    }
    const json = document.getElementById('mcpSetupJson');
    if (json) json.textContent = JSON.stringify(c.config, null, 2);
    mcpSetupNote('');
  }

  async function openMcpSetup() {
    const el = document.getElementById('mcpSetup');
    if (!el) return;
    el.classList.remove('hidden');
    mcpSetupNote('正在读取配置…');
    try {
      const [setup, health] = await Promise.all([api('/api/mcp/setup'), api('/api/health')]);
      if (!setup || setup.ok === false) throw new Error((setup && setup.error) || '服务端没有 /api/mcp/setup');
      mcpSetupData = setup;
      const ep = document.getElementById('mcpSetupEndpoint');
      if (ep) { ep.textContent = setup.endpoint; ep.title = setup.endpoint; }
      paintMcpSetupStatus(health && health.mcp);
      renderMcpSetupTabs();
      selectMcpSetupClient(mcpSetupClient);
    } catch (e) {
      mcpSetupNote(`读不到接入信息：${e.message}（服务端是旧版本？重启 python server.py 再试）`, 'err');
    }
  }

  function closeMcpSetup() {
    const el = document.getElementById('mcpSetup');
    if (el) el.classList.add('hidden');
  }

  function initServerDown() {
    const btn = document.getElementById('serverDownReload');
    // 服务关掉后刷新也没用（后端没了），但用户重启服务后按一下就能回来
    if (btn) btn.onclick = () => location.reload();
  }

  // 顶栏那一段 ComfyUI 状态本身就是入口：连不上时点它直接跳到设置里的地址输入框。
  // 只在「连不上」时才把光标送进去——正常在线时用户点开多半只是想看一眼设置。
  // 首页页脚那颗「ComfyUI 地址」：点开就地改。
  // 以前它是个外链，而改地址得先跳进画布再开全局设置——为改一个端口把人从首页踹走，
  // 回到首页还得再点一次「最近项目」。这里换成锚在页脚上的小弹层，改完当场测。
  function openComfyPop(anchor) {
    if (popAnchor && popAnchor === anchor) { closePopMenu(); return; }
    closePopMenu();
    const menu = document.createElement('div');
    menu.className = 'popmenu comfy-pop';
    const title = document.createElement('div');
    title.className = 'popmenu-title';
    title.textContent = 'ComfyUI 地址';
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'http://127.0.0.1:8188';
    const hint = document.createElement('p');
    hint.className = 'set-tip';
    hint.textContent = '正在读取…';
    const row = document.createElement('div');
    row.className = 'comfy-pop-row';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = '保存并测试';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '恢复默认';
    const open = document.createElement('a');
    open.className = 'comfy-pop-open';
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.textContent = '在浏览器打开 ComfyUI ↗';
    row.append(save, reset);
    menu.append(title, input, hint, row, open);
    document.body.appendChild(menu);
    placePopMenu(menu, anchor);
    popAnchor = anchor;
    armPopClose(anchor);
    bindComfyEditor({
      input, hint, save, reset,
      onSaved: (info) => {
        const url = info.url || '';
        const el = document.getElementById('homeComfyUrl');
        if (el) el.textContent = url.replace(/^https?:\/\//, '') || '未设置';
        open.href = url;
        open.classList.toggle('hidden', !url);
      },
    });
    input.focus();
    input.select();
  }

  // 页脚那行地址跟着服务端的真实配置走（换了端口、换到另一台机器上都会变）
  async function refreshHomeComfy() {
    const el = document.getElementById('homeComfyUrl');
    if (!el) return;
    const r = await api('/api/comfy');
    if (r && r.url) el.textContent = String(r.url).replace(/^https?:\/\//, '');
  }

  function initComfyChip() {
    const chip = document.getElementById('comfyChip');
    if (!chip) return;
    const open = () => openSettingsSheet(state.comfyOnline ? undefined : 'comfy');
    chip.onclick = open;
    chip.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    };
  }

  function initMcpSetup() {
    const chip = document.getElementById('mcpChip');
    if (chip) {
      chip.onclick = () => openMcpSetup();
      chip.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openMcpSetup(); }
      };
    }
    const close = document.getElementById('mcpSetupClose');
    if (close) close.onclick = closeMcpSetup;
    const box = document.getElementById('mcpSetup');
    if (box) box.onclick = (ev) => { if (ev.target === box) closeMcpSetup(); };
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && box && !box.classList.contains('hidden')) closeMcpSetup();
    });

    const epBtn = document.querySelector('#mcpSetup [data-copy="endpoint"]');
    if (epBtn) {
      epBtn.onclick = async () => {
        const text = (document.getElementById('mcpSetupEndpoint') || {}).textContent || '';
        const ok = await copyText(text);
        mcpSetupNote(ok ? '端点已复制' : '复制失败，手动选一下吧', ok ? 'ok' : 'err');
      };
    }
    const copyBtn = document.getElementById('mcpSetupCopy');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const text = (document.getElementById('mcpSetupJson') || {}).textContent || '';
        mcpSetupNote((await copyText(text)) ? '配置已复制，粘到文件里就能用' : '复制失败，手动选一下吧', 'ok');
      };
    }
    const writeBtn = document.getElementById('mcpSetupWrite');
    if (writeBtn) {
      writeBtn.onclick = async () => {
        const id = mcpSetupClient;
        const label = (document.querySelector(`#mcpSetupTabs .mcp-tab[data-client="${id}"]`) || {}).textContent || id;
        writeBtn.disabled = true;
        mcpSetupNote('正在写入…');
        try {
          const r = await postJson('/api/mcp/install', { client: id });
          if (!r || r.ok === false) throw new Error((r && r.error) || '写入失败');
          const tail = r.backup ? `（原文件已备份到 ${r.backup.split(/[\\/]/).pop()}）` : '（新建）';
          mcpSetupNote(`已写入 ${label}：${r.path} ${tail}`, 'ok');
          flash(r.backup ? `已合并进 ${label} 的配置，原文件已备份` : `已写入 ${label} 的配置`);
        } catch (e) {
          mcpSetupNote(`没写进去：${e.message}`, 'err');
        } finally {
          writeBtn.disabled = false;
        }
      };
    }
  }

  /* ---------------- 健康检查 ---------------- */
  async function health() {
    if (state.serverDown) return;
    const res = await api('/api/health');
    // 记一下 ComfyUI 在不在：有些"顺手校验"只在线时才做得成，
    // 离线去问只会白挨一个 502，还在控制台里留一条红字。
    state.comfyOnline = !!res.comfy;
    // 旧服务端没有新接口：提示重启，否则资产库里的内置预设会静默空着
    if (!Array.isArray(res.features) || !res.features.includes('presets')) {
      if (!health._warned) {
        health._warned = true;
        flash('服务端是旧版本：重启 python server.py 后内置预设才会出现在资产库里');
      }
    }
    const dot = $('#healthDot'), text = $('#healthText');
    const hdot = document.getElementById('homeDot');
    const htext = document.getElementById('homeStatus');
    if (res.comfy) {
      const dev = (res.devices || [])[0] || {};
      // 顶栏只放「版本 + 队列」，显卡型号塞进 title，避免状态条拉得过长
      const label = `ComfyUI ${res.version || ''} · 队列 ${res.running}/${res.pending}`;
      dot.className = 'dot ok';
      text.textContent = label;
      text.title = `${dev.name || ''}${dev.vram_total ? ' · ' + Math.round(dev.vram_total / 1024 / 1024 / 1024) + 'GB' : ''}`;
      if (hdot) hdot.className = 'dot ok';
      if (htext) htext.textContent = label;
    } else {
      const label = `ComfyUI 未连接：${(res.error || '').slice(0, 60)}`;
      dot.className = 'dot bad';
      text.textContent = label;
      if (hdot) hdot.className = 'dot bad';
      if (htext) htext.textContent = label;
    }
    updateMcpChip(res);
  }

  /* ---------------- 小地图与视图工具 ---------------- */
  let mm = null;

  let mmPending = false;

  // 按帧合并：拖动时 pointermove 很密，一帧最多重绘一次
  function scheduleMinimap() {
    if (mmPending) return;
    mmPending = true;
    requestAnimationFrame(() => { mmPending = false; renderMinimap(); });
  }

  // 拖动 / 改大小期间，连线、分组、小地图都按帧合并，避免每个 pointermove 都做一遍全量测量
  let layoutPending = false;
  // 屏幕坐标的浮条（图片工具条 / 连线删除键）贴的是节点在**屏幕**上的位置。
  // 平移缩放走 applyView()，那里已经重贴过；但拖节点只改 transform、不经过 applyView ——
  // 所以以前拖着节点走，工具条会钉在原地，松手才「瞬移」过去。这里跟布局同一个节拍补上。
  function followScreenBars() {
    positionImgTools();
    positionLinkDel();
  }

  // 只重贴浮条、不动连线/小地图：扩图拖锚点时节点本身没变，变的是它上面那块画布外框。
  // 单独一个节拍，免得为了挪一条工具条把整张画布重画一遍。
  let barsPending = false;
  function scheduleFollowBars() {
    if (barsPending) return;
    barsPending = true;
    requestAnimationFrame(() => { barsPending = false; followScreenBars(); });
  }

  function scheduleLayout() {
    if (layoutPending) return;
    layoutPending = true;
    requestAnimationFrame(() => {
      layoutPending = false;
      renderLinks();
      renderGroups();
      renderMinimap();
      followScreenBars();
    });
  }

  function renderMinimap() {
    const cv = document.getElementById('minimap');
    if (!cv || cv.classList.contains('hidden')) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!state.nodes.length) return;
    const boxes = state.nodes.map((n) => nodeBox(n));
    const r = stage.getBoundingClientRect();
    const vwWorld = r.width / state.view.k;
    const vhWorld = r.height / state.view.k;
    const vxWorld = -state.view.x / state.view.k;
    const vyWorld = -state.view.y / state.view.k;
    // 视野也要算进包围盒，否则白框会跑到小地图外面
    const minX = Math.min(...boxes.map((b) => b.x), vxWorld);
    const minY = Math.min(...boxes.map((b) => b.y), vyWorld);
    const maxX = Math.max(...boxes.map((b) => b.x + b.w), vxWorld + vwWorld);
    const maxY = Math.max(...boxes.map((b) => b.y + b.h), vyWorld + vhWorld);
    const pad = 60;
    const sw = maxX - minX + pad * 2, sh = maxY - minY + pad * 2;
    const k = Math.min(W / sw, H / sh);
    const ox = -minX * k - pad * k + (W - sw * k) / 2;
    const oy = -minY * k - pad * k + (H - sh * k) / 2;
    mm = { k, ox, oy };
    const COLOR = {
      wf: ['rgba(110,168,254,0.45)', 'rgba(110,168,254,0.85)'],
      image: ['rgba(52,211,153,0.4)', 'rgba(52,211,153,0.8)'],
      out: ['rgba(167,139,250,0.4)', 'rgba(167,139,250,0.8)'],
      text: ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.4)'],
    };
    state.nodes.forEach((n, i) => {
      const b = boxes[i];
      const [fill, stroke] = COLOR[n.type] || COLOR.text;
      const w = Math.max(3, b.w * k), h = Math.max(3, b.h * k);
      ctx.beginPath();
      ctx.roundRect(b.x * k + ox, b.y * k + oy, w, h, 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
    });
    const vx = vxWorld * k + ox;
    const vy = vyWorld * k + oy;
    const vw = vwWorld * k;
    const vh = vhWorld * k;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fillRect(vx, vy, vw, vh);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vx + 0.5, vy + 0.5, Math.max(1, vw - 1), Math.max(1, vh - 1));
  }

  function setViewTool(name, on) {
    const btn = document.querySelector(`#viewTools [data-vt="${name}"]`);
    if (btn) btn.classList.toggle('active', !!on);
  }

  function zoomTo(k) {
    const st = stage.getBoundingClientRect();
    const cx = st.width / 2, cy = st.height / 2;
    const wx = (cx - state.view.x) / state.view.k;
    const wy = (cy - state.view.y) / state.view.k;
    const nk = clamp(k, ZOOM_MIN, ZOOM_MAX);   // 菜单里的预设也走这里，别让 800% 之外的值漏进来
    state.view.k = nk;
    state.view.x = cx - wx * nk;
    state.view.y = cy - wy * nk;
    applyView(); queueSave();   // 连线在 #world 坐标系里，平移/缩放无需重算
  }

  function initViewTools() {
    const tools = document.getElementById('viewTools');
    if (tools) {
      tools.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.vt');
        if (!btn) return;
        const key = btn.dataset.vt;
        if (key === 'fit') { fitView(); return; }
        if (key === 'minimap') {
          state.minimapOn = !state.minimapOn;
          document.getElementById('minimap').classList.toggle('hidden', !state.minimapOn);
          setViewTool('minimap', state.minimapOn);
          renderMinimap(); queueSave(); return;
        }
        if (key === 'links') {
          state.linksHidden = !state.linksHidden;
          setViewTool('links', state.linksHidden);
          renderLinks(); queueSave(); return;
        }
        if (key === 'snap') {
          state.snap = !state.snap;
          setViewTool('snap', state.snap);
          queueSave(); flash(state.snap ? '网格吸附：开' : '网格吸附：关'); return;
        }
      });
    }
    const zb = document.getElementById('zoomBtn');
    const zm = document.getElementById('zoomMenu');
    if (zb && zm) {
      zb.onclick = (ev) => { ev.stopPropagation(); zm.classList.toggle('hidden'); };
      zm.onclick = (ev) => {
        const b = ev.target.closest('button[data-zoom]');
        if (!b) return;
        zm.classList.add('hidden');
        if (b.dataset.zoom === 'fit') fitView();
        else zoomTo(Number(b.dataset.zoom));
      };
      document.addEventListener('click', (ev) => {
        if (!ev.target.closest('#zoomMenu, #zoomBtn')) zm.classList.add('hidden');
      });
    }
    const mmEl = document.getElementById('minimap');
    if (mmEl) {
      mmEl.onclick = (ev) => {
        if (!mm) return;
        const r = mmEl.getBoundingClientRect();
        const wx = (ev.clientX - r.left - mm.ox) / mm.k;
        const wy = (ev.clientY - r.top - mm.oy) / mm.k;
        const st = stage.getBoundingClientRect();
        state.view.x = st.width / 2 - wx * state.view.k;
        state.view.y = st.height / 2 - wy * state.view.k;
        applyView(); queueSave();   // 连线在 #world 坐标系里，平移/缩放无需重算
      };
    }
  }

  // 从端口拖出来松手在空白处：列出可以接上的节点类型
  function openLinkMenu(fromId, clientX, clientY) {
    const src = getNode(fromId);
    if (!src) return;
    const items = [];
    if (src.type === 'text' || src.type === 'image') {
      items.push(['工作流（自动接上）', () => createLinkedNode(fromId, 'wf', clientX, clientY)]);
    }
    if (src.type === 'wf') {
      items.push(['图片输出', () => createLinkedNode(fromId, 'out', clientX, clientY)]);
    }
    items.push(['文本节点', () => createLinkedNode(fromId, 'text', clientX, clientY)]);
    items.push(['图片节点', () => createLinkedNode(fromId, 'image', clientX, clientY)]);
    openPopMenu({ x: clientX, y: clientY }, items, '接一个节点');
  }

  async function createLinkedNode(fromId, kind, clientX, clientY) {
    const p = screenToWorld(clientX, clientY);
    const src = getNode(fromId);
    if (kind === 'text') { addTextNode(p.x - 60, p.y - 40); return; }
    if (kind === 'image') { addImageNode(p.x - 60, p.y - 60); return; }
    if (kind === 'out') {
      const out = addOutNode(p.x - 40, p.y - 50, { linked: true }, true);
      state.links.push({ id: uid('l'), from: fromId, to: out.id, toKey: 'in' });
      renderAll(); queueSave(); commit();
      flash('已新建图片输出并接上');
      return;
    }
    if (kind === 'wf') {
      const wfId = defaultWorkflowId();
      if (!wfId) { flash('工作流库是空的，先导入一个工作流'); return; }
      const graph = await loadGraphById(wfId);
      const node = await addWorkflowNode(graph, '工作流', true);
      if (!node) return;
      node.x = p.x - 90;
      node.y = p.y - 80;
      const wantKind = src && src.type === 'image' ? 'image' : 'text';
      const slot = (node.slots || []).find((x) => x.kind === wantKind);
      if (slot) {
        state.links.push({ id: uid('l'), from: fromId, to: node.id, toKey: slot.key });
        renderAll(); queueSave(); commit();
        flash('已新建工作流并接上');
      } else {
        renderAll(); queueSave(); commit();
        flash(wantKind === 'image' ? '这个工作流没有图片插槽，节点已建但未连线' : '这个工作流没有文本插槽，节点已建但未连线');
      }
    }
  }

  /* ---------------- 项目栏与弹出菜单 ---------------- */
  let popCloseHandler = null;
  let popAnchor = null;      // 当前菜单挂在哪个按钮上（同一个按钮再点一次＝收起）

  function closePopMenu() {
    document.querySelectorAll('.popmenu').forEach((m) => m.remove());
    refMenu = null;   // 自绘的 @ 引用菜单也走这套关闭逻辑，别留下悬空引用
    popAnchor = null;
    if (popCloseHandler) {
      document.removeEventListener('pointerdown', popCloseHandler, true);
      popCloseHandler = null;
    }
  }

  // 点菜单外面就收起来。两个都是踩过的坑：
  // 1. 必须挂在**捕获阶段**：.gen-panel 和 #stage 都会在冒泡早期 stopPropagation，
  //    挂冒泡的话「点面板里的提示词区」这种点击根本收不到，菜单关不掉；
  // 2. 点在**空白画布**上只收菜单，不再把这次点击交给画布：否则「选完参数顺手点一下空白」
  //    会连节点一起取消选中，整个生成器面板跟着消失——用户会以为参数丢了。
  function armPopClose(anchor) {
    if (popCloseHandler) document.removeEventListener('pointerdown', popCloseHandler, true);
    popCloseHandler = (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('.popmenu')) return;                  // 点菜单自己：什么都不做
      // 锚点不一定是元素：连线拖到空白处弹出的「接一个节点」用的是 {x, y} 坐标对象，
      // 它没有 contains，直接调用会抛 TypeError —— 监听器当场中断，菜单永远关不掉
      // （用户报的「拖完不选，点空白也不消失」就是这个）。
      if (anchor && typeof anchor.contains === 'function' && anchor.contains(t)) return;
      closePopMenu();
      if (t.closest('#stage') && !t.closest('.node, .port')) ev.stopPropagation();
    };
    // 延后一拍再挂：打开菜单的那次 pointerdown 还在冒泡，别当场把自己关掉
    setTimeout(() => document.addEventListener('pointerdown', popCloseHandler, true), 0);
  }

  // 先把菜单量出来再定位：底部工具条的按钮贴着屏幕下沿，菜单要向上翻，否则会被切掉。
  // 抽出来是为了让「@ 引用菜单」这类自绘菜单也能复用同一套边界处理。
  function placePopMenu(menu, anchor) {
    const m = menu.getBoundingClientRect();
    const gap = 6, edge = 8;
    let left, top;
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const r = anchor.getBoundingClientRect();
      left = r.left + r.width / 2 - m.width / 2;
      top = r.bottom + gap;
      if (top + m.height > window.innerHeight - edge) top = r.top - m.height - gap;
    } else {
      left = anchor.x + 10;
      top = anchor.y + 10;
      if (left + m.width > window.innerWidth - edge) left = anchor.x - m.width - 10;
      if (top + m.height > window.innerHeight - edge) top = anchor.y - m.height - 10;
    }
    left = Math.min(Math.max(edge, left), window.innerWidth - m.width - edge);
    top = Math.min(Math.max(edge, top), window.innerHeight - m.height - edge);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function openPopMenu(anchor, items, title) {
    // 同一个按钮再点一次：收起，而不是「关掉又立刻打开」（看起来像点不动）
    if (popAnchor && popAnchor === anchor) { closePopMenu(); return; }
    closePopMenu();
    const menu = document.createElement('div');
    menu.className = 'popmenu';
    if (title) {
      const h = document.createElement('div');
      h.className = 'popmenu-title';
      h.textContent = title;
      menu.appendChild(h);
    }
    items.forEach(([label, fn, cls]) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = () => { closePopMenu(); fn(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    placePopMenu(menu, anchor);
    popAnchor = anchor;
    armPopClose(anchor);
  }

  function initProjectBar() {
    const inp = document.getElementById('projectName');
    if (inp) {
      inp.value = state.name || '未命名画布';
      inp.oninput = () => {
        state.name = inp.value;
        document.title = `${inp.value || 'InfiSheet · 无限画布'}`;
        queueSave();
      };
      inp.onblur = () => {
        if (!inp.value.trim()) { inp.value = '未命名画布'; state.name = inp.value; queueSave(); }
      };
    }
    const btn = document.getElementById('canvasMenuBtn');
    if (btn) {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        openPopMenu(btn, [
          ['重命名画布', () => { const el = document.getElementById('projectName'); el.focus(); el.select(); }],
          ['新建画布', () => startNewCanvas(null)],
          ['删除当前项目', () => { if (state.projectId) deleteProject(state.projectId); else flash('当前没有项目'); }, 'danger'],
        ]);
      };
    }
  }

  // 当前工具：false = 框选（默认），true = 移动
  function setTool(pan) {
    state.panMode = !!pan;
    const selBtn = document.querySelector('#bar [data-act="select-mode"]');
    const panBtn = document.querySelector('#bar [data-act="pan-mode"]');
    if (selBtn) selBtn.classList.toggle('active', !state.panMode);
    if (panBtn) panBtn.classList.toggle('active', state.panMode);
    stage.style.cursor = state.panMode ? 'grab' : '';
    flash(state.panMode ? '移动工具：拖任意位置平移画布' : '框选工具：拖空白处框选节点');
    queueSave();
  }

  function syncChrome() {
    const inp = document.getElementById('projectName');
    if (inp) inp.value = state.name || '未命名画布';
    const mmEl = document.getElementById('minimap');
    if (mmEl) mmEl.classList.toggle('hidden', !state.minimapOn);
    setViewTool('minimap', state.minimapOn);
    setViewTool('links', state.linksHidden);
    setViewTool('snap', state.snap);
    const panBtn = document.querySelector('#bar [data-act="pan-mode"]');
    const selBtn = document.querySelector('#bar [data-act="select-mode"]');
    if (panBtn) panBtn.classList.toggle('active', state.panMode);
    if (selBtn) selBtn.classList.toggle('active', !state.panMode);
    document.title = state.name || 'InfiSheet · 无限画布';
  }

  function initHelpSheet() {
    const sheet = document.getElementById('helpSheet');
    const close = document.getElementById('helpClose');
    if (close) close.onclick = () => sheet.classList.add('hidden');
    if (sheet) sheet.onclick = (ev) => { if (ev.target === sheet) sheet.classList.add('hidden'); };
  }

  function switchModalTab(name) {
    const tab = document.querySelector(`#modalTabs .tab[data-tab="${name}"]`);
    if (tab) tab.click();
  }

  /* ---------------- 首页 ---------------- */
  async function showHome() {
    const home = document.getElementById('home');
    if (!home) return;
    if (state.hydrated) await saveToServer();   // 退出编辑器先落盘，再刷新列表
    home.classList.remove('hidden');
    await initHome();
    if (location.hash !== '#home') history.replaceState(null, '', '#home');
  }

  function showCanvas() {
    const home = document.getElementById('home');
    if (home) home.classList.add('hidden');
    applyView();
    renderAll();                      // 已含 renderLinks
    if (location.hash !== '#canvas') history.replaceState(null, '', '#canvas');
  }

  const CAP_ICONS = {
    image: icon('image'),
    video: icon('video'),
    audio: icon('music'),
    script: icon('script'),
    clip: icon('clip'),
  };

  function pickWorkflowByKind(kind) {
    const w = state.workflows || { presets: [], items: [] };
    const all = [
      ...w.presets.map((p) => ({ id: `preset:${p.file}`, title: p.title || p.name, kinds: p.kinds || [] })),
      ...w.items.map((p) => ({ id: `lib:${p.name}`, title: p.name, kinds: p.kinds || [] })),
    ];
    return all.find((x) => (x.kinds || []).includes(kind)) || null;
  }

  // 五个能力入口：按「工作流实际能产出什么」决定可用与否
  function renderCapRow() {
    const host = document.getElementById('capRow');
    if (!host) return;
    const defs = [
      { key: 'image', label: '图片生成' },
      { key: 'video', label: '视频生成' },
      { key: 'audio', label: '音频生成' },
      { key: 'script', label: '剧本生成' },
      { key: 'clip', label: '智能剪辑' },
    ];
    host.innerHTML = '';
    defs.forEach((d) => {
      const btn = document.createElement('button');
      btn.className = 'cap-btn';
      btn.innerHTML = `<span class="cap-ico">${CAP_ICONS[d.key] || ''}</span><span class="cap-label">${d.label}</span>`;
      if (d.key === 'script') {
        btn.onclick = () => addScriptNode();
        btn.title = '放入一个提示词节点，用来写剧本 / 分镜';
      } else if (d.key === 'clip') {
        btn.disabled = true;
        btn.title = '本地画布暂无剪辑能力：用视频工作流的产物 + 外部剪辑软件';
      } else {
        const wf = pickWorkflowByKind(d.key);
        if (wf) {
          btn.onclick = () => addWorkflowStarter(wf.id);
          btn.title = `放入「${wf.title}」工作流`;
        } else {
          btn.disabled = true;
          btn.title = `还没有能产出 ${d.label.replace('生成', '')} 的工作流：先在 ComfyUI 跑一次，再从「工作流库 → 运行记录」导入`;
        }
      }
      host.appendChild(btn);
    });
  }

  // 空画布起始页的显隐（有节点就收起）
  function updateCanvasEmpty() {
    const el = document.getElementById('canvasEmpty');
    if (!el) return;
    const empty = state.nodes.length === 0;
    el.classList.toggle('hidden', !empty);
    if (empty) renderCapRow();
  }

  function addScriptNode() {
    const c = centerOfView();
    addTextNode(c.x - 140, c.y - 90, '【剧本】\n标题：\n一句话梗概：\n角色：\n\n镜头 1（0-3s）：\n镜头 2（3-6s）：\n镜头 3（6-9s）：');
    fitView();
    queueSave();
    flash('已放入提示词节点：写剧本 / 分镜');
  }

  // 把「提示词 → 工作流 → 图片输出」这一套放进当前画布
  async function addWorkflowStarter(workflowId) {
    try {
      const graph = await loadGraphById(workflowId);
      if (!graph) throw new Error('工作流为空');
      const label = workflowId.startsWith('preset:') ? '工作流' : workflowId.slice(4);
      const node = await addWorkflowNode(graph, label);
      if (!node) return;
      const textSlot = (node.slots || []).find((x) => x.kind === 'text');
      if (textSlot) {
        const t = addTextNode(node.x - 330, node.y + 90);
        state.links.push({ id: uid('l'), from: t.id, to: node.id, toKey: textSlot.key });
      }
      const out = addOutNode(node.x + 400, node.y + 100, { linked: true });
      state.links.push({ id: uid('l'), from: node.id, to: out.id, toKey: 'in' });
      renderAll();
      fitView();
      queueSave();
      flash('已放入工作流：在左侧提示词节点里写内容');
    } catch (err) {
      flash(`工作流载入失败：${err.message}`);
    }
  }

  async function initHome() {
    // 首页只剩「新建画布」+「最近项目」：以前这里还有一排「快速开始」卡片，直接从预设开画布。
    // 但那条路和「新建画布 → 生成面板里选工作流」是同一件事，而且没有预设时只留一个空标题，
    // 所以整排删掉了（工作流的选择统一收在生成面板里）。工作流列表由 boot() 和设置面板各自刷新。
    // 页脚那行 ComfyUI 地址跟着服务端的真实配置走：在设置里改过端口，回首页要看到新的
    refreshHomeComfy();
    const row = document.getElementById('recentRow');
    const list = document.getElementById('recentList');
    if (row && list) {
      let items = [];
      try { items = ((await api('/api/projects')).items) || []; } catch { /* 离线 */ }
      list.innerHTML = '';
      row.hidden = !items.length;
      items.forEach((it) => {
        const card = document.createElement('div');
        card.className = 'proj-card' + (it.id === state.projectId ? ' current' : '');
        const open = document.createElement('button');
        open.className = 'pm';
        const when = it.savedAt ? new Date(it.savedAt).toLocaleString('zh-CN', { hour12: false }) : '';
        open.innerHTML = '<b>' + esc(it.name || '未命名画布') + '</b><span>' + it.nodes + ' 节点 · ' + it.links + ' 连线' + (when ? ' · ' + esc(when) : '') + '</span>';
        open.onclick = () => openProject(it.id);
        const del = document.createElement('button');
        del.className = 'pdel';
        del.title = '删除这个项目';
        del.textContent = '×';
        del.onclick = (ev) => { ev.stopPropagation(); deleteProject(it.id); };
        card.appendChild(open);
        card.appendChild(del);
        list.appendChild(card);
      });
    }
  }

  async function createProject(name) {
    const res = await api('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || '未命名画布' }),
    });
    if (!res.ok || !res.id) { flash(res.error || '新建项目失败'); return null; }
    state.projectId = res.id;
    try { localStorage.setItem('infisheet-project', res.id); } catch { /* noop */ }
    return res;
  }

  async function startNewCanvas(workflowId) {
    await saveToServer();                       // 旧项目先落盘，再开新项目
    const res = await createProject('未命名画布');
    if (!res) return;
    state.nodes = []; state.links = []; state.groups = []; state.selected = new Set();
    state.seq = 1; state.view = { x: 140, y: 120, k: 0.85 };
    load(res.canvas || { nodes: [], links: [], groups: [], view: state.view });
    state.hydrated = true;
    applyView(); renderAll(); renderLinks();
    seedHistory(); lastSavedSnap = '';
    showCanvas();
    if (workflowId) await addWorkflowStarter(workflowId);
    else fitView();
    queueSave();                                // 新建后立刻保存一次（退出前也不会丢）
    flash(workflowId ? '已新建项目，并放入工作流' : '已新建项目，双击空白处开始');
  }

  async function openProject(id) {
    if (!id) return;
    if (id === state.projectId) { showCanvas(); return; }
    await saveToServer();
    const r = await api('/api/projects/' + encodeURIComponent(id));
    if (!r.ok || !r.canvas) { flash(r.error || '打开项目失败'); return; }
    state.projectId = id;
    try { localStorage.setItem('infisheet-project', id); } catch { /* noop */ }
    load(r.canvas);
    state.hydrated = true;
    applyView(); renderAll(); renderLinks();
    seedHistory(); lastSavedSnap = JSON.stringify(serialize()); setSaveState('已保存');
    showCanvas();
    flash('已打开：' + (r.canvas.name || '未命名画布'));
  }

  async function deleteProject(id) {
    if (!confirm('删除这个项目？存档会从本机移除，无法恢复。')) return;
    try { await api('/api/projects/' + encodeURIComponent(id), { method: 'DELETE' }); } catch { /* noop */ }
    if (state.projectId === id) {
      state.projectId = null;
      clearTimeout(saveTimer);
      lastSavedSnap = JSON.stringify(serialize());   // 别让排队中的自动保存把删掉的项目又写回去
      try { localStorage.removeItem('infisheet-project'); } catch { /* noop */ }
    }
    initHome();
  }
  /* ---------------- 图片工具条：裁剪 / 高清 ---------------- */
  // 图片节点选中时，在节点标题上方浮出一排后续操作。位置按**屏幕坐标**算（和 #alignBar、
  // #linkDel 同一个路数）：放进 #world 会跟着画布缩放，200% 时工具条比图还大、25% 时点不着。
  // 十颗按钮分四段：本地变换（不进模型）/ 涂抹类（靠遮罩驱动）/ 整图编辑（整张交给模型）/
  // 导出（把结果拿走，和模型无关）。分隔线就按这个分段画，用户一眼能看出
  // 「哪些是立刻出结果、哪些要跑工作流、哪个只是存文件」。
  const IMG_TOOLS = [
    ['crop', '裁剪', 'crop', '拖一个框，裁出一张新的图片节点'],
    ['rotate', '旋转', 'rotate', '旋转 90° / 180°，或水平 / 垂直翻转'],
    ['color', '调色', 'palette', '亮度 / 对比度 / 饱和度 / 色温，实时预览'],
    ['mask', '遮罩', 'brush', '涂出要重绘的区域，只改涂过的地方'],
    ['erase', '擦除', 'eraser', '涂掉不想要的东西，让模型用周围内容补全'],
    ['detext', '去字', 'text', '涂掉画面里的文字水印，用背景纹理补全'],
    ['outpaint', '扩图', 'expand', '把画布向外扩大，让模型补全画外内容'],
    ['cutout', '抠图', 'magic', '去掉背景，只保留主体'],
    ['upscale', '高清', 'zoom', '放大到更高分辨率并补充细节'],
    ['download', '下载', 'download', '把这张图存到本地（原图分辨率，不压缩）'],
  ];
  // 分隔线插在「哪一颗之前」：本地改像素 ｜ 靠遮罩 ｜ 整张交给模型 ｜ 导出。
  // 下载单独成一段：它不动像素、不跑工作流，混在「高清 / 抠图」里会让人以为也要排队生成。
  const IMG_TOOL_BREAKS = new Set(['mask', 'outpaint', 'download']);
  const EDIT_LABEL = { upscale: '高清', cutout: '抠图', erase: '擦除', detext: '去字' };
  // 这些工具都是「拿这张图当参考，让编辑工作流改一版」：提示词先给出可用的骨架，
  // 【】里的内容由用户替换。空着提示词点生成只会得到一张几乎一样的图，所以必须带模板。
  const EDIT_TPL = {
    upscale: '以这张图为参考，输出分辨率更高、细节更精细的版本：补充皮肤、发丝、材质与织物的纹理，'
      + '构图、人物、光线与色调保持完全一致。',
    cutout: '把背景去掉，只保留主体：主体轮廓完整、边缘干净不生硬，不要裁掉肢体和细节；'
      + '输出纯白背景（#FFFFFF），主体位置和比例保持原样。',
    erase: '把涂过的区域里的东西去掉，用周围的背景、材质和光线自然补全，不要留下痕迹。',
    detext: '把涂过区域里的文字、水印和标识去掉，用背景纹理和光影自然补全，保持画面干净、不留痕迹。',
  };
  // 每类工具该挑哪一类工作流。'mask' = 吃遮罩的那张（涂了才有效）。
  const EDIT_WF = { upscale: 'upscale', cutout: 'img2img', erase: 'mask', detext: 'mask' };
  // 抠图有专门的抠像工作流时优先用它（名字命中即可）；没有就退回普通图像编辑
  const CUTOUT_HINTS = ['rembg', 'removebg', '抠图', '抠像', 'matting', 'birefnet', 'inspyrenet', 'segment'];

  let imgToolsEl = null;

  // 只有「单选 + 有图」的图片节点才有后续操作可做
  function imgToolNode() {
    if (state.selected.size !== 1) return null;
    const n = getNode([...state.selected][0]);
    return n && n.type === 'image' && n.dataURL ? n : null;
  }

  function ensureImgTools() {
    if (imgToolsEl && imgToolsEl.isConnected) return imgToolsEl;
    const bar = document.createElement('div');
    bar.id = 'imgTools';
    bar.className = 'hidden';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '图片工具');
    // 点工具条不能把节点选丢了，也不能顺手把画布拖走
    bar.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    IMG_TOOLS.forEach(([kind, label, ico, tip]) => {
      if (IMG_TOOL_BREAKS.has(kind)) {
        const sep = document.createElement('span');
        sep.className = 'it-sep';
        bar.appendChild(sep);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'it-btn';
      b.dataset.tool = kind;
      b.title = tip;
      b.setAttribute('aria-label', `${label}：${tip}`);
      b.innerHTML = `${icon(ico)}<span>${label}</span>`;
      b.onclick = (ev) => { ev.stopPropagation(); runImgTool(kind, b); };
      bar.appendChild(b);
    });
    document.body.appendChild(bar);
    imgToolsEl = bar;
    return bar;
  }

  function positionImgTools() {
    const bar = imgToolsEl;
    const n = imgToolNode();
    // 收着的时候不用算：每帧跟布局（拖节点、拖画布）都会走到这里，别白量一遍 DOM
    if (!bar || !n || bar.classList.contains('hidden')) return;
    // 宽度不能拿 nodeWidth(n) 算：那是个「没量过就给 380」的估值，而图片节点实际宽度
    // 跟着图片比例走（竖图只有两百多），估出来会偏到一边去。直接量 DOM。
    const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"]`);
    if (!el) return;
    const nb = el.getBoundingClientRect();
    // 扩图时参照物是**画布外框**（`.op-stage`），不是节点：画布会往外长，节点只是其中一块，
    // 贴着节点摆的话工具条会落在框里面、还压着节点标题。跟着外框上沿居中，它才和那圈蓝框是一套。
    // 外框还没量出宽（刚挂上、draw 还没跑）就退回节点，别拿一个 0 宽的框去居中。
    const opStage = el.querySelector('.op-stage');
    const stageBox = opStage ? opStage.getBoundingClientRect() : null;
    const ref = stageBox && stageBox.width > 1 ? stageBox : nb;
    const w = bar.offsetWidth || 300;
    const h = bar.offsetHeight || 34;
    const minL = 10, maxL = Math.max(10, window.innerWidth - w - 10);
    // 整条带文字之后有 ~645px 宽，横向难免盖到旁边节点的标题上——那不只是难看：
    // 盖住的那块点下去命中的是工具条（实测点标题点出了「旋转」菜单），用户会以为
    // 「这个节点点不中」。所以下面按「先挑横向位置、再挑纵向位置」的顺序找空位。
    //
    // 横向：默认居中对齐这个节点；居中会被视口夹住时（节点贴着屏幕左/右边缘）改成和
    // 节点左/右边缘对齐，让整条朝画布空白的那一侧展开。这几个候选位置都算「贴着自己」。
    const want = ref.left + ref.width / 2 - w / 2;
    const lefts = [clamp(want, minL, maxL)];
    if (Math.abs(lefts[0] - want) > 1) {
      lefts.push(clamp(ref.left, minL, maxL), clamp(ref.right - w, minL, maxL));
    }
    const topBar = document.getElementById('topBar');
    const floor = (topBar ? topBar.offsetHeight : 44) + 6;
    const title = el.querySelector('.node-title');
    // 给定横向位置，纵向怎么摆：贴在标题上方；压到别人就把整条往上抬，
    // 抬一次可能又撞上更高处的一条，所以循环到不再重叠（最多 3 次，正常一次就结束）。
    const solve = (left) => {
      let y = Math.max(8, ref.top - h - 8);
      let place = 'above';
      for (let i = 0; i < 3; i++) {
        const hit = otherTitleTops(n.id, left, left + w, y, y + h);
        if (hit == null) break;
        const next = Math.max(floor, Math.min(y, hit - h - 6));
        if (next === y) break;      // 已经顶到上限，再抬不动了
        y = next;
      }
      if (otherTitleTops(n.id, left, left + w, y, y + h) == null) return { left, y, place, clear: true };
      // 抬到顶栏底下还是压着人（节点本来就贴着屏幕上方）→ 改为压在自己这张图的上沿。
      // 翻到节点下方试过：图片节点下面紧跟着生成面板，那条会盖住「上传 / 素材库 / 清空 / 风格」，
      // 还是「点了没反应」。压在自己图上则谁也挡不着——这张图本来就是选中的那张，
      // 点它只会重新选中它，不丢任何操作。
      y = Math.min((title ? title.getBoundingClientRect().bottom : nb.top + 28) + 6, window.innerHeight - h - 8);
      place = 'over';
      return { left, y, place, clear: otherTitleTops(n.id, left, left + w, y, y + h) == null };
    };
    // 按候选顺序试，取第一个真的不压别人标题的；都不行就用第一个（宁可压在自己图上）
    let best = null;
    for (const left of lefts) {
      const s = solve(left);
      if (!best) best = s;
      if (s.clear) { best = s; break; }
    }
    bar.dataset.place = best.place;       // 测试和排查用：这次是贴在上面还是压在自己图上
    bar.style.left = `${Math.round(best.left)}px`;
    bar.style.top = `${Math.round(best.y)}px`;
  }

  // 工具条横向范围内，其它节点标题的最高一条顶边；没有重叠返回 null。
  // 只量标题，不量整个节点：盖住图片本身无所谓（工具条本来就浮在画布上），盖住标题才会挡点击。
  function otherTitleTops(selfId, l, r, t, b) {
    let best = null;
    nodesEl.querySelectorAll('.node').forEach((el) => {
      if (el.dataset.id === selfId) return;
      const title = el.querySelector('.node-title');
      if (!title) return;
      const q = title.getBoundingClientRect();
      if (q.right < l || q.left > r || q.bottom < t || q.top > b) return;
      if (best == null || q.top < best) best = q.top;
    });
    return best;
  }

  function updateImgTools() {
    const n = imgToolNode();
    const bar = ensureImgTools();
    // 扩图不再占一层浮层（边框就在节点上），所以它不参与「让位」的判断
    const show = !!n && !cropSession && !bigEditor && !imgPanel;
    bar.classList.toggle('hidden', !show);
    if (show) {
      // 只有「这台机器上压根没有吃遮罩的工作流」才禁用；工作流不对会在点的时候自动切。
      // 遮罩 / 擦除 / 去字 三个都靠遮罩驱动，一起禁用——不然点进去涂完发现不生效。
      const ok = maskCapable();
      const why = ok
        ? ''
        : '没有能吃遮罩的工作流（缺「Krea2 · 局部重绘」）';
      bar.querySelectorAll('[data-tool="mask"],[data-tool="erase"],[data-tool="detext"]').forEach((btn) => {
        btn.disabled = !ok;
        btn.title = ok ? IMG_TOOLS.find((t) => t[0] === btn.dataset.tool)[3] : why;
      });
      // 「扩图」是个开关：开着的时候按钮亮着，再点一次收起
      const ob = bar.querySelector('[data-tool="outpaint"]');
      if (ob) ob.classList.toggle('on', outpaintOn(n));
      positionImgTools();
    }
  }

  function runImgTool(kind, btn) {
    const n = imgToolNode();
    // 工具条是「选中才有」的浮层，但它可能因为选择被别处清掉而残留一下。
    // 这时候点上去什么都不发生，用户只会以为功能坏了——顺手把状态刷新回去。
    if (!n) { updateImgTools(); flash('先选中一张有图的节点'); return; }
    if (kind === 'crop') { openCrop(n); return; }
    if (kind === 'rotate') { openRotateMenu(n, btn); return; }
    if (kind === 'color') { openColorPanel(n); return; }
    if (kind === 'outpaint') { toggleOutpaint(n); return; }
    if (kind === 'mask') { openMaskEditor(n); return; }
    if (kind === 'erase' || kind === 'detext') { openMaskEditor(n, { intent: kind }); return; }
    if (kind === 'download') { downloadImage(n); return; }
    createEditNode(n, kind);      // upscale / cutout
  }

  // 下载 = 把这张图原样存到本地。**不经过 canvas 重编码**：canvas 只能出 PNG，
  // 而用户贴进来的 JPEG 存成 PNG 会大好几倍；这里直接拿原字节，扩展名跟着 MIME 走。
  // 文件名取节点标题（清掉路径非法字符），比「未命名-1730...png」有用得多。
  async function downloadImage(n) {
    const src = n && n.dataURL;
    if (!src) { flash('这张图还没加载完，稍等一下再试'); return; }
    const base = String(n.title || 'image').replace(/[\\/:*?"<>|]/g, '_').trim() || 'image';
    let href = src, revoke = false, ext = 'png';
    if (/^data:image\//i.test(src)) {
      ext = (src.slice(11).split(';')[0] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '');
    }
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error(String(r.status));
      const b = await r.blob();
      const sub = String(b.type || '').split('/')[1];
      if (sub) ext = sub.replace('jpeg', 'jpg').replace(/\+.*/, '');
      href = URL.createObjectURL(b);
      revoke = true;
    } catch {
      // 跨域图 / 服务端断线：退回让浏览器自己存原地址（data: 也能直接存）。
      // 不 flash 报错——用户要的是文件，多数情况下原地址这条路是通的。
    }
    const a = document.createElement('a');
    a.href = href;
    a.download = `${base}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 4000);
    flash(`已下载 ${base}.${ext}`);
  }

  // 图像编辑类工具的落地方式：**新建**一个节点，而不是改用户手上这张。
  // 新节点带着这张图（自己就是参考图，生成时会自动上传）、切到能吃图的工作流、
  // 提示词预填模板，用户改掉【】里的内容再点生成即可。原图不会被碰。
  //
  // 挑工作流只看服务端扫出来的分类（server.py: graph_category），不看名字：
  // 按名字匹配时选中过 Moss_图像编辑 —— 那是个纯文生图流程，参考图根本没进图，
  // 高清出来的是一张全新的画。
  function createEditNode(src, kind, maskDoc) {
    const prompt = EDIT_TPL[kind] || '';
    // 挑工作流看用途：高清要「放大」那一类；抠图有专门抠像工作流就用它，没有就退回图像编辑；
    // 擦除 / 去字必须吃遮罩，挑成普通图生图等于把涂的区域当空气。
    const want = EDIT_WF[kind] || 'img2img';
    const hint = kind === 'cutout' ? pickWorkflowByHint(CUTOUT_HINTS) : '';
    const wf = hint || (want === 'mask'
      ? ((presetOptions().find((o) => o.alphaMask) || {}).id || '')
      : pickWorkflow(want));
    const gen = { wf, wfAuto: !hint, prompt };   // 名字命中的专用工作流钉住，别被自动纠正换掉
    const n = addImageNode(src.x + nodeWidth(src) + 60, src.y, {
      dataURL: src.dataURL,
      uploaded: src.uploaded || null,
      subfolder: src.subfolder || '',
      filename: src.filename || null,
      title: `${EDIT_LABEL[kind] || '编辑'} · ${src.title}`,
      gen,
    });
    selectOnly(n.id);
    // 遮罩必须赶在**聚焦提示词之前**塞进去：rerenderNode 遇到「焦点在节点里的输入框」
    // 会直接跳过重建（保护打字焦点），而下面刚把光标放进新节点的提示词框——
    // 那时候再搬遮罩，DOM 不会刷新，节点上既没有药丸也没有预览，看着像没搬过去。
    if (maskDoc) carryMask(src, n, maskDoc);
    const ta = document.querySelector(`[data-panel-for="${CSS.escape(n.id)}"] .gen-prompt`);
    if (ta) {
      ta.focus();
      const r = document.createRange();
      r.selectNodeContents(ta);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    flash(`${EDIT_LABEL[kind]}：改掉提示词里【】的内容，再点生成`);
    return n;
  }

  // 按名字找一个「专用」工作流（比如抠像）。找不到就返回空串，由调用方退回通用选择。
  function pickWorkflowByHint(hints) {
    const hit = presetOptions().find((o) => {
      const s = `${o.id} ${o.label}`.toLowerCase();
      return hints.some((h) => s.includes(h));
    });
    return hit ? hit.id : '';
  }

  // 遮罩跟着图走：把 src 上这块遮罩复制给新节点。
  // 键必须按**新节点自己的图片身份**算——上传过的图键相同（本来就该共享同一块遮罩），
  // 没上传过的图键是 node:<id>，不显式搬过去新节点就看不到笔画。
  function carryMask(from, to, doc) {
    // doc 由调用方直接给：它才是编辑器里那份**确定**的笔画。
    // 从 from.masks 反查要依赖「键在两次调用之间没变」，而键会跟着上传 / 换图变，没必要赌。
    const md = doc || maskDocOf(from);
    const k = to && imgKeyOf(to);
    if (!md || !k) return false;
    to.masks = { ...(to.masks || {}) };
    to.masks[k] = {
      w: md.w, h: md.h, cover: md.cover,
      strokes: md.strokes.map((s) => ({
        ...s,
        ...(s.pts ? { pts: s.pts.map((p) => p.slice()) } : {}),
        ...(s.rect ? { rect: s.rect.slice() } : {}),
      })),
    };
    queueSave();
    rerenderNode(to.id);   // 药丸和遮罩预览要立刻出来，别等下一次重绘
    return true;
  }

  /* ---------------- 本地图像变换 / 调色 / 扩图 ---------------- */
  // 旋转和调色只是重画一遍像素，不需要工作流：**新建**一个节点，原图不动。
  // 扩图虽然要模型补画外内容，但「把画布撑大」这一步也是本地的，只是顺手把补出来的四条边
  // 写成矩形遮罩，交给局部重绘去填。
  let imgPanel = null;      // 调色 / 扩图共用的弹层，同时只开一个

  function canvasOf(w, h) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    return cv;
  }

  function rotateCanvas(img, deg, flip) {
    const swap = Math.abs(deg) % 180 === 90;
    const w = swap ? img.naturalHeight : img.naturalWidth;
    const h = swap ? img.naturalWidth : img.naturalHeight;
    const cv = canvasOf(w, h);
    const ctx = cv.getContext('2d');
    // 绕中心转：先挪到中心、再转、再把图画到「中心为原点」的位置上
    ctx.translate(w / 2, h / 2);
    ctx.rotate((deg * Math.PI) / 180);
    if (flip === 'h') ctx.scale(-1, 1);
    if (flip === 'v') ctx.scale(1, -1);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return cv;
  }

  function openRotateMenu(n, btn) {
    if (!btn) return;
    openPopMenu(btn, [
      ['右转 90°', () => applyRotate(n, 90)],
      ['左转 90°', () => applyRotate(n, -90)],
      ['旋转 180°', () => applyRotate(n, 180)],
      ['水平翻转', () => applyRotate(n, 0, 'h')],
      ['垂直翻转', () => applyRotate(n, 0, 'v')],
    ], '旋转');
  }

  async function applyRotate(src, deg, flip = '') {
    let img;
    try { img = await loadImageEl(src.dataURL); } catch { flash('图片加载失败，没法旋转'); return; }
    const cv = rotateCanvas(img, deg, flip);
    const n = addImageNode(src.x + nodeWidth(src) + 60, src.y, {
      dataURL: cv.toDataURL('image/png'),
      title: `旋转 · ${src.title}`,
    });
    selectOnly(n.id);
    flash(`已生成 ${cv.width} × ${cv.height} 的新节点（原图没动）`);
  }

  /* ---------------- 调色 ---------------- */
  // 预览（CSS filter）和落地（ctx.filter）必须用**同一个** filter 串，
  // 否则「看着调好了、应用出来不一样」是必然的。
  const COLOR_PRESETS = [
    ['原图', { bright: 0, contrast: 0, satur: 0, warm: 0 }],
    ['明亮', { bright: 16, contrast: 6, satur: 6, warm: 0 }],
    ['柔和', { bright: 6, contrast: -12, satur: -8, warm: 6 }],
    ['冷调', { bright: 2, contrast: 4, satur: 2, warm: -32 }],
    ['暖调', { bright: 4, contrast: 2, satur: 6, warm: 32 }],
    ['黑白', { bright: 0, contrast: 8, satur: -100, warm: 0 }],
    ['胶片', { bright: -4, contrast: 14, satur: -14, warm: 12 }],
  ];

  function colorFilter(v) {
    const f = [
      `brightness(${(1 + v.bright / 100).toFixed(3)})`,
      `contrast(${(1 + v.contrast / 100).toFixed(3)})`,
      `saturate(${(1 + v.satur / 100).toFixed(3)})`,
    ];
    // 色温没有原生滤镜：暖是「加一点 sepia 再压回去」，冷直接往蓝边转
    const t = v.warm / 100;
    if (t > 0) f.push(`sepia(${(t * 0.34).toFixed(3)})`, 'hue-rotate(-8deg)', `saturate(${(1 + t * 0.25).toFixed(3)})`);
    else if (t < 0) f.push('hue-rotate(8deg)', `saturate(${(1 - t * 0.15).toFixed(3)})`);
    return f.join(' ');
  }

  function closeImgPanel() {
    if (!imgPanel) return;
    const p = imgPanel;
    imgPanel = null;
    try { p.ac.abort(); } catch { /* 已经关过 */ }
    if (p.onClose) p.onClose();
    p.root.remove();
    updateImgTools();
  }

  function openImgPanel(title, bodyHtml, opt = {}) {
    closeImgPanel();
    const root = document.createElement('div');
    root.id = 'imgPanel';
    root.innerHTML = `
      <div class="sheet ip-sheet" style="width:${opt.width || 380}px">
        <header><strong>${title}</strong><button type="button" class="x" title="关闭">×</button></header>
        <div class="ip-body">${bodyHtml}</div>
        <footer class="ip-foot">
          <button type="button" class="ip-cancel">取消</button>
          <button type="button" class="prime ip-apply">${opt.applyText || '应用'}</button>
        </footer>
      </div>`;
    const ac = new AbortController();
    const panel = { root, ac, onClose: opt.onClose || null };
    imgPanel = panel;
    // 点空白处 = 取消（和裁剪浮层一致）
    root.addEventListener('pointerdown', (ev) => {
      if (ev.target === root) { closeImgPanel(); return; }
      ev.stopPropagation();
    });
    root.querySelector('.x').onclick = () => closeImgPanel();
    root.querySelector('.ip-cancel').onclick = () => closeImgPanel();
    root.querySelector('.ip-apply').onclick = () => opt.onApply && opt.onApply(root);
    document.body.appendChild(root);
    updateImgTools();
    if (opt.onInput) opt.onInput(root, ac);
    return panel;
  }

  function openColorPanel(n) {
    const target = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .thumb img`);
    const v = { bright: 0, contrast: 0, satur: 0, warm: 0 };
    const rows = [['bright', '亮度'], ['contrast', '对比度'], ['satur', '饱和度'], ['warm', '色温']];
    const body = `
      ${rows.map(([k, label]) => `<label class="ip-row"><span>${label}</span>
        <input type="range" min="-100" max="100" step="1" value="0" data-k="${k}">
        <b data-v="${k}">0</b></label>`).join('')}
      <div class="ip-presets">
        ${COLOR_PRESETS.map(([name], i) => `<button type="button" data-preset="${i}">${name}</button>`).join('')}
      </div>
      <p class="ip-tip">调的是这张图的副本，原图不动。</p>`;
    openImgPanel('调色', body, {
      onClose: () => { if (target) target.style.filter = ''; },
      onInput(root) {
        const paint = () => { if (target) target.style.filter = colorFilter(v); };
        root.querySelectorAll('.ip-body input[type="range"]').forEach((el) => {
          el.oninput = () => {
            v[el.dataset.k] = Number(el.value);
            root.querySelector(`[data-v="${el.dataset.k}"]`).textContent = el.value;
            root.querySelectorAll('[data-preset]').forEach((x) => x.classList.remove('on'));
            paint();
          };
        });
        root.querySelectorAll('[data-preset]').forEach((b) => {
          b.onclick = () => {
            Object.assign(v, COLOR_PRESETS[Number(b.dataset.preset)][1]);
            root.querySelectorAll('.ip-body input[type="range"]').forEach((el) => {
              el.value = v[el.dataset.k];
              root.querySelector(`[data-v="${el.dataset.k}"]`).textContent = v[el.dataset.k];
            });
            root.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('on', x === b));
            paint();
          };
        });
        paint();
      },
      onApply: async () => {
        let img;
        try { img = await loadImageEl(n.dataURL); } catch { flash('图片加载失败，没法调色'); return; }
        const cv = canvasOf(img.naturalWidth, img.naturalHeight);
        const ctx = cv.getContext('2d');
        ctx.filter = colorFilter(v);
        ctx.drawImage(img, 0, 0);
        closeImgPanel();
        const nn = addImageNode(n.x + nodeWidth(n) + 60, n.y, {
          dataURL: cv.toDataURL('image/png'),
          title: `调色 · ${n.title}`,
        });
        selectOnly(nn.id);
        flash(`调色完成（${cv.width} × ${cv.height}），原图没动`);
      },
    });
  }

  /* ---------------- 扩图 ---------------- */
  // 扩图 = 把画布撑大 + 把新长出来的四条边标成遮罩，交给局部重绘去补。
  // 关键点：新图的边是**透明**的，ComfyUI 的 LoadImage 会把它算成 mask=255（该重绘），
  // 所以就算遮罩笔画丢了，模型也只会画边、不会动中间——两层保险。
  //
  // 边框挂在节点自己身上（gen.outpaint），不再有独立弹层：
  //   · 点「扩图」→ 图片上直接长出八个锚点，拖哪边扩哪边
  //   · 边框只是**状态**，拖动时不烧像素（不编码、不重渲染），松手也只改读数
  //   · 点生成时才烘（bakeOutpaint）：撑画布 → 平移原有笔画 → 补四条带子 → 走局部重绘
  // 这样「面板里的尺寸档」和「图」永远是同一份数据：面板直接写自定义 nw×nh，
  // 不会再出现图上 688×736、面板还停在 1:1 · 1K、按 1024×1024 生成的那种尺寸错位。
  const OP_RATIOS = [['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16]];
  const OP_PAD_PCT = 20;
  const OP_MAX_SIDE = 4096;
  const OP_PROMPT = '把画面补全到新的画幅：扩出来的边缘按周围的构图、光线和材质自然延展，'
    + '主体位置、风格与色调保持不变，接缝处不要出现明显边界或重复元素。';

  // 写成 function 而不是箭头常量：e2e 里按函数名把实现抠出来跑（见 tests/e2e/run.mjs）。
  // 步长 16 而不是 8：生成面板的「自定义尺寸」走 snapDim，也是 16 的倍数。
  // 两边步长不一致时 696 这种尺寸会被面板舍成 688——图和面板上的设置又对不上了。
  function snapSide(x) {
    return Math.max(16, Math.round(x / 16) * 16);
  }

  // 把一根轴上的两边凑成整数，且「两边之和」正好等于 snapSide 之后要长出来的量。
  // 这样 outpaintFrame 不用再分零头：比例档扩出来是对称的，拖锚点时被拖的那一边也落得准。
  function fitPad(a, c, base) {
    const total = Math.max(0, snapSide(base + a + c) - base);
    const sum = a + c;
    if (!(total > 0) || !(sum > 0)) return [0, 0];
    const A = Math.round((a / sum) * total);
    return [A, total - A];
  }

  // 画布尺寸的唯一真源是**四边各扩多少**（pad，原图像素，非负）。
  // 比例档、滑杆、拖锚点只是往 pad 里写值的三个快捷方式，三条路走同一份数据，
  // 才不会出现「拖完再点比例，两边各算各的」。
  function outpaintPad(w, h, ratio, padPct) {
    let l = 0, t = 0, r = 0, b = 0;
    if (ratio) {
      // 目标比例：宽的往高里补、高的往宽里补，补出来的量平均分到两侧
      if (w / h > ratio) t = b = (w / ratio - h) / 2;
      else l = r = (ratio * h - w) / 2;
    } else {
      const p = padPct / 100;
      l = r = w * p;
      t = b = h * p;
    }
    const [L, R] = fitPad(l, r, w);
    const [T, B] = fitPad(t, b, h);
    return { l: L, t: T, r: R, b: B };
  }

  // pad → 新画布（nw × nh）+ 原图在画布里的左上角（ox / oy）。
  // ox/oy 取整：遮罩笔画要写进存档、还要按面积算覆盖率，留一串 204.00000000000006
  // 只会让「带子面积 + 原图面积 = 画布面积」这种校验永远对不上。
  function outpaintFrame(w, h, pad) {
    const l = Math.max(0, pad.l || 0), r = Math.max(0, pad.r || 0);
    const t = Math.max(0, pad.t || 0), b = Math.max(0, pad.b || 0);
    // 画布不可能比原图还小（snapSide 是四舍五入，98 这种尺寸会被舍到 96）。
    // 不能再写 `w + 16` 兜底：那多出来的一格会全落到**没被拖的那一边**
    // （拖左边 5px，右边凭空长 11px）。拖得不够一格就是没反应，这是取整的必然。
    // 一根轴一边都没扩（l+r=0）时按**原图尺寸**算，不要走 snapSide：原图 700 宽会被
    // 舍成 704，明明一格没扩、读数却写着「700 → 704」，看着像白扩了 4px。
    const nw = l + r > 0 ? Math.max(w, snapSide(w + l + r)) : w;
    const nh = t + b > 0 ? Math.max(h, snapSide(h + t + b)) : h;
    // ox/oy **钉在被拖的那一边**（左/上），snap 的零头全落到右/下。
    // 早先是「零头两边平分」，结果拖右边时画布一跳档，左边也跟着挪了一两像素——
    // 明明只动了一条边，图却整体位移，手感很怪。比例档那边由 fitPad 保证对称，不吃这个亏。
    const ox = Math.max(0, Math.min(nw - w, Math.round(l)));
    const oy = Math.max(0, Math.min(nh - h, Math.round(t)));
    return { nw, nh, ox, oy };
  }

  // 兼容「给比例 / 百分比」的老口径：返回 [nw, nh]
  function outpaintSize(w, h, ratio, padPct) {
    const f = outpaintFrame(w, h, outpaintPad(w, h, ratio, padPct));
    return [f.nw, f.nh];
  }

  // 四条新边（矩形笔画，原图像素）。四条边各自独立判断——四边各扩可以不一样，
  // 不能写成「oy>0 就上下各来一条」，那样只扩了下边时会漏掉一条带子。
  function outpaintBands(w, h, nw, nh, ox, oy) {
    const bands = [];
    if (ox > 0) bands.push([0, 0, ox, nh]);
    if (nw - ox - w > 0) bands.push([ox + w, 0, nw - ox - w, nh]);
    if (oy > 0) bands.push([ox, 0, w, oy]);
    if (nh - oy - h > 0) bands.push([ox, oy + h, w, nh - oy - h]);
    return bands.filter((b) => b[2] > 0 && b[3] > 0);
  }

  // 边框状态：{l,t,r,b,w,h}。w/h 是**原图**尺寸，开框时记下来——
  // 拖拽时不能临时去读 img.naturalWidth，渲染那一刻图可能还没解码。
  function outpaintOf(n) {
    const p = n && n.gen && n.gen.outpaint;
    if (!p) return null;
    return {
      l: Math.max(0, Number(p.l) || 0), t: Math.max(0, Number(p.t) || 0),
      r: Math.max(0, Number(p.r) || 0), b: Math.max(0, Number(p.b) || 0),
      w: Number(p.w) || 0, h: Number(p.h) || 0,
    };
  }

  function outpaintOn(n) { return !!outpaintOf(n); }

  // 边框和面板的尺寸档是同一份数据：pad 一变就把 size 写成 custom。
  // 漏了这一步就是用户截图里的那个 bug——图上 688×736，面板还停在 1:1 · 1K，
  // 点生成按 1024×1024 跑，出来的图尺寸当然不对。
  function syncOutpaintDims(n) {
    const op = outpaintOf(n);
    if (!op || !n.gen) return null;
    const f = outpaintFrame(op.w, op.h, op);
    n.gen.size = 'custom';
    n.gen.custom = { w: f.nw, h: f.nh };
    return f;
  }

  function setOutpaintPad(n, pad) {
    const op = outpaintOf(n);
    if (!op) return null;
    n.gen.outpaint = { l: pad.l, t: pad.t, r: pad.r, b: pad.b, w: op.w, h: op.h };
    const f = syncOutpaintDims(n);
    queueSave();
    return f;
  }

  // 「自定义尺寸…」：填的是**最终画布**的宽高（不是每边扩多少），差出来的量居中分到四边。
  // 和拖锚点是同一份数据（pad），所以填完还能接着拖。
  function setOutpaintToSize(n, nw, nh) {
    const op = outpaintOf(n);
    if (!op) return null;
    const W = Math.max(op.w, Math.min(OP_MAX_SIDE, snapSide(nw)));
    const H = Math.max(op.h, Math.min(OP_MAX_SIDE, snapSide(nh)));
    const l = Math.round((W - op.w) / 2);
    const t = Math.round((H - op.h) / 2);
    return setOutpaintPad(n, { l, t, r: W - op.w - l, b: H - op.h - t });
  }

  // 「分辨率」：按当前画布比例整体缩放到目标长边。四边 pad 一起乘同一个系数，
  // 所以拖出来的不对称形状（左边多留那种）能原样保住，只变大小。
  function scaleOutpaintTo(n, long) {
    const op = outpaintOf(n);
    if (!op) return null;
    const f = outpaintFrame(op.w, op.h, op);
    const s = long / Math.max(f.nw, f.nh);
    if (!(s > 0)) return null;
    return setOutpaintPad(n, {
      l: Math.round(op.l * s), t: Math.round(op.t * s),
      r: Math.round(op.r * s), b: Math.round(op.b * s),
    });
  }

  // 自定义尺寸的小弹层（openPopMenu 只能放按钮，塞不下输入框，这里单独拼一个）
  function openDimMenu(anchor, n, after) {
    const op = outpaintOf(n);
    if (!op) return;
    const f = outpaintFrame(op.w, op.h, op);
    closePopMenu();
    const menu = document.createElement('div');
    menu.className = 'popmenu of-dim';
    const title = document.createElement('div');
    title.className = 'popmenu-title';
    title.textContent = `画布尺寸（原图 ${op.w} × ${op.h}，自动对齐 16 的倍数）`;
    menu.appendChild(title);
    const row = document.createElement('div');
    row.className = 'go-custom';
    const mk = (val, label) => {
      const el = document.createElement('input');
      el.type = 'number';
      el.className = 'go-num';
      el.min = DIM_MIN;
      el.max = OP_MAX_SIDE;
      el.step = 16;
      el.value = val;
      el.setAttribute('aria-label', label);
      // 数字框里滚轮改值很容易误伤，而且会把画布缩放吃掉
      el.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
      return el;
    };
    const wInp = mk(f.nw, '画布宽度');
    const hInp = mk(f.nh, '画布高度');
    const times = document.createElement('i');
    times.className = 'go-times';
    times.textContent = '×';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'go-ok';
    ok.textContent = '应用';
    row.append(wInp, times, hInp, ok);
    menu.appendChild(row);
    const apply = () => {
      const w = Number(wInp.value), h = Number(hInp.value);
      if (!(w > 0 && h > 0)) { flash('宽高都要填正数'); return; }
      setOutpaintToSize(n, w, h);
      closePopMenu();
      after();
    };
    ok.onclick = apply;
    [wInp, hInp].forEach((el) => {
      el.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } };
    });
    document.body.appendChild(menu);
    placePopMenu(menu, anchor);
    popAnchor = anchor;
    armPopClose(anchor);
    wInp.focus();
    wInp.select();
  }

  // 点「扩图」= 开关。开着再点一次就收起（不烘、不改图、把尺寸档还回去）。
  function toggleOutpaint(n) {
    if (outpaintOn(n)) { closeOutpaint(n); return; }
    const im = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .thumb img`);
    const w = im && im.naturalWidth, h = im && im.naturalHeight;
    if (!w || !h) { flash('这张图还没加载完，稍等一下再试'); return; }
    // 纯图片节点（加载图片进来的那种）没有生成面板，参数条就没地方挂。
    // 扩图本来就得靠生成面板跑局部重绘，顺手把面板打开——和标题上那颗「生成」药丸一个效果。
    if (n.plain) { delete n.plain; }
    // 收起时要还原用户的尺寸档，别因为我们开过一次框就永久变成「自定义」
    n.gen.opBackup = {
      size: n.gen.size,
      custom: n.gen.custom ? { ...n.gen.custom } : null,
      aspect: n.gen.aspect,
    };
    n.gen.outpaint = { l: 0, t: 0, r: 0, b: 0, w, h };
    syncOutpaintDims(n);
    // 扩图要的是「能吃图」：吃遮罩的只补新边，只吃图的整张重画。只有纯文生图才必须换掉
    ensureOutpaintWorkflow(n);
    // 提示词只在空着的时候填模板，别覆盖用户自己写的
    if (!String(n.gen.prompt || '').trim()) {
      n.gen.prompt = OP_PROMPT;
      n.gen.opPromptSet = true;
      const ta = document.querySelector(`[data-panel-for="${CSS.escape(n.id)}"] .gen-prompt`);
      if (ta) ta.value = OP_PROMPT;
    }
    rerenderNode(n.id, true);
    // 这里不再抬视图：参数条并进了生成面板（在节点里、跟着节点走），
    // 画布往下长多少都不会把出口顶出视口，也就没有理由替用户动他的画布位置。
    queueSave();
    flash('拖边框上的八个锚点决定往哪边扩、扩多少，然后点生成');
  }

  function closeOutpaint(n) {
    if (!n || !n.gen || !n.gen.outpaint) return;
    delete n.gen.outpaint;
    // 模板是我们填的、用户一个字没改 → 收起来时还回去，别在他的节点上留一段莫名其妙的话
    if (n.gen.opPromptSet && String(n.gen.prompt || '') === OP_PROMPT) {
      n.gen.prompt = '';
      const ta = document.querySelector(`[data-panel-for="${CSS.escape(n.id)}"] .gen-prompt`);
      if (ta) ta.value = '';
    }
    delete n.gen.opPromptSet;
    const bak = n.gen.opBackup;
    if (bak) {
      n.gen.size = bak.size;
      n.gen.custom = bak.custom;
      n.gen.aspect = bak.aspect;
      delete n.gen.opBackup;
    }
    rerenderNode(n.id, true);
    queueSave();
  }

  // 把一个笔画整体平移。扩图只挪位置、不缩放，所以纯平移就是精确的。
  function shiftStroke(dx, dy) {
    return (s) => (s.tool === 'rect'
      ? { ...s, rect: [(Number(s.rect && s.rect[0]) || 0) + dx, (Number(s.rect && s.rect[1]) || 0) + dy,
        Number(s.rect && s.rect[2]) || 0, Number(s.rect && s.rect[3]) || 0] }
      : { ...s, pts: (s.pts || []).map(([x, y]) => [x + dx, y + dy]) });
  }

  // 把边框烘成像素 + 遮罩。放在生成的最前面：图、遮罩、尺寸档三样一起变成
  // 「扩完之后」的样子，后面那条生成流程完全不用知道扩图这回事。
  async function bakeOutpaint(n) {
    const op = outpaintOf(n);
    if (!op || !n.dataURL || !n.gen) return false;
    if (!op.l && !op.t && !op.r && !op.b) { closeOutpaint(n); return false; }
    const img = await loadImageEl(n.dataURL);
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) { closeOutpaint(n); return false; }
    const f = outpaintFrame(W, H, op);
    if (f.nw <= W && f.nh <= H) { closeOutpaint(n); return false; }
    const cv = document.createElement('canvas');
    cv.width = f.nw;
    cv.height = f.nh;
    cv.getContext('2d').drawImage(img, f.ox, f.oy);
    // 原有笔画整体平移，再补上新长出来的四条带子
    const old = maskDocOf(n);
    const strokes = ((old && old.strokes) || []).map(shiftStroke(f.ox, f.oy));
    // 新边要不要写成遮罩笔画，看用户选的工作流**吃不吃遮罩**：
    //   吃遮罩（局部重绘）→ 写，只重绘这几圈，最准；
    //   只吃图不吃遮罩（图生图 / 图像编辑）→ 不写，新边留透明，ComfyUI 的 LoadImage
    //   会把它算成黑边，模型整张重画一遍。两条路都能扩，只是精度不同。
    // 早先这里无条件写遮罩，于是「不吃遮罩的工作流」全被 reconcileWorkflow 换掉，
    // 用户看到的就是「我选的工作流一点生成就跳回默认那个」。
    const wfNow = presetOptions().find((o) => o.id === (n.gen && n.gen.wf));
    if (!wfNow || wfNow.alphaMask) {
      outpaintBands(W, H, f.nw, f.nh, f.ox, f.oy)
        .forEach((r) => strokes.push({ tool: 'rect', rect: r }));
    }
    const doc = { w: f.nw, h: f.nh, strokes };
    // 换图：上传缓存必须清掉，否则 ensureUploaded 会把扩图前那个文件当成参考图，
    // 遮罩又按新尺寸烘进旧图，两头错位。
    n.dataURL = cv.toDataURL('image/png');
    n.uploaded = null;
    n.subfolder = '';
    n.filename = null;
    n.masks = {};
    delete n.gen.outpaint;
    delete n.gen.opPromptSet;
    delete n.gen.opBackup;
    n.gen.size = 'custom';
    n.gen.custom = { w: f.nw, h: f.nh };
    putMaskDoc(n, doc);        // 按新身份写回（node:<id>），覆盖率也一起算好
    rerenderNode(n.id, true);
    queueSave();
    commit();                  // 撑画布是一次真正的改动，撤销要能退回去
    flash(`已扩到 ${f.nw} × ${f.nh}，正在让模型补画外内容`);
    return true;
  }

  // 边框的事件（拖锚点、比例档、完成）挂在 window 上，节点一重建就得摘掉，
  // 否则旧监听会接着改同一个节点的 pad，拖一下动两倍。
  // `opSession` 本身声明在文件上方的模块状态里（applyView 也要用）。
  function closeOpSession(id) {
    if (!opSession) return;
    if (id && opSession.id !== id) return;
    try { opSession.ac.abort(); } catch { /* 已经 abort 过 */ }
    // 参数条在面板里，节点一重建就跟着没了；但「只收起不重建」那条路上它还在，手动摘一下
    if (opSession.bar && opSession.bar.isConnected) opSession.bar.remove();
    opSession = null;
  }

  // 节点上的扩图边框：舞台铺满缩略图，原图按 ox/oy 摆进去，四条新边标蓝，
  // 八个锚点在最外圈。锚点直接复用裁剪那套 .crop-sel .ch（形状、光标都一致）。
  // panel = 这个节点的生成面板，参数条要并进去（不是屏幕浮层）。
  function buildOutpaintFrame(n, thumb, panel) {
    const op0 = outpaintOf(n);
    if (!op0 || !op0.w || !op0.h) return;
    closeOpSession(n.id);
    const ac = new AbortController();
    opSession = { id: n.id, ac };
    thumb.classList.add('op-mode');

    const stage = document.createElement('div');
    stage.className = 'op-stage';
    const im = document.createElement('img');
    im.src = n.dataURL || '';
    im.alt = '';
    im.draggable = false;
    stage.appendChild(im);
    const bands = document.createElement('div');
    bands.className = 'op-bands';
    stage.appendChild(bands);
    const orig = document.createElement('div');
    orig.className = 'op-orig';
    stage.appendChild(orig);
    const sel = document.createElement('div');
    sel.className = 'crop-sel op-sel';
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((a) => {
      const c = document.createElement('i');
      c.className = `ch ${a}`;
      c.dataset.anchor = a;
      sel.appendChild(c);
    });
    // 锚点层挂在缩略图上、不是舞台上：舞台要 overflow:hidden 才保得住圆角，
    // 而锚点故意露在框外 6px（和裁剪一样），挂在里面会被剪掉一半。
    thumb.appendChild(stage);
    thumb.appendChild(sel);

    // ---- 扩图模式下，整个生成面板就只剩这一条 ----
    // 早先是屏幕坐标的浮条（`position: fixed` + 挂 body）：不会被顶出视口，但**跟不住节点**——
    // 节点在画布右边、条却钉在屏幕左下角，用户的原话是「无法跟随」。
    // 现在是面板里的一条：面板挂在 `.node` 上（绝对定位 + 抵消画布缩放），节点动它就动。
    //
    // 这一条把扩图要用的东西全装下了，两行：**上面是提示词，下面是参数 + 生成**。
    // 顺序是照着「写什么 → 怎么跑 → 发出去」排的：先看到自己在写什么，再是选项和那颗按钮。
    // 面板里原来的「上传 / 画布素材 / 清空 / 风格」、大提示词框、底下那排按钮全部让位
    // （`.gen-panel.op-on`）——扩图时这些要么用不上，要么和这条重复。
    const bar = document.createElement('div');
    bar.className = 'op-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '扩图参数');
    bar.innerHTML = '<div class="of-row of-prompt">'
      + '<textarea class="of-input" rows="2" spellcheck="false"'
      + ' placeholder="提示词：描述扩出来的地方要补什么（Enter 生成，Shift+Enter 换行）"></textarea>'
      + '</div>'
      + '<div class="of-row of-params">'
      + '<button type="button" class="of-btn" data-of="wf"></button>'
      + '<button type="button" class="of-btn" data-of="size"></button>'
      + '<button type="button" class="of-btn" data-of="res"></button>'
      + '<button type="button" class="of-btn" data-of="batch"></button>'
      + '<span class="of-read"></span>'
      + '<button type="button" class="of-btn ghost" data-of="cancel">取消</button>'
      + '</div>';
    const genBar = panel.querySelector('.gen-bar');
    if (genBar) panel.insertBefore(bar, genBar);
    else panel.appendChild(bar);
    panel.classList.add('op-on');
    bar.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    if (opSession) opSession.bar = bar;

    // 提示词：多行，改的是 n.gen.prompt 本身（收起来之后大提示词框读到的是同一个值）。
    // 扩图模板本来就有两行字，单行输入框把它截成「…主体」那种看不全的样子——用户截图里
    // 那半句话就是这个原因。所以这里用 textarea + 按内容长高（到 6 行封顶，再多自己滚）。
    const promptInp = bar.querySelector('.of-input');
    const OF_MAX_H = 132;                 // ≈ 6 行；再长就滚动，别把面板撑到屏幕外
    const fitPrompt = () => {
      // 先清掉高度让浏览器按内容量（`height:auto`）。量到 0 说明还没挂进 DOM——
      // buildGenPanel 是在节点插进 #nodes **之前**跑的，这时候 scrollHeight 恒为 0，
      // 直接写 height 会把框压成一条线。这种情况交回 CSS（rows=2）兜着。
      promptInp.style.height = '';
      const sh = promptInp.scrollHeight;
      if (!sh) return;
      promptInp.style.height = `${Math.min(sh, OF_MAX_H)}px`;
      placePanel();      // 面板跟着长高，得重贴一次（否则长出来的那截会掉到屏幕外面）
    };
    const syncPrompt = () => {
      const v = String(n.gen.prompt || '');
      if (promptInp.value !== v) promptInp.value = v;
      promptInp.title = v;
      fitPrompt();
    };
    syncPrompt();
    // 挂进 DOM 之后重量一次：上面那次是在离屏状态跑的，量不到 scrollHeight
    requestAnimationFrame(fitPrompt);
    promptInp.addEventListener('input', () => {
      n.gen.prompt = promptInp.value;
      promptInp.title = promptInp.value;
      delete n.gen.opPromptSet;     // 用户改过就别再当成「我们填的模板」收回去
      fitPrompt();
      queueSave();
    });
    promptInp.addEventListener('keydown', (ev) => {
      // Enter 生成、Shift+Enter 换行：多行框里这两个键最容易点错，先把约定写死在这里
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); generateImage(n); }
      ev.stopPropagation();          // 别让画布的快捷键（Delete / 空格平移）吃到输入
    });

    // 状态文字和生成按钮**搬**到参数行末尾（不是复制一个）：`refreshGenPanel` 靠
    // `.gen-run` / `.gen-status` 这两个选择器在面板里找它们，搬家后照样找得到。
    const paramRow = bar.querySelector('.of-params');
    [panel.querySelector('.gen-status'), panel.querySelector('.gen-run')].forEach((el2) => {
      if (el2) paramRow.appendChild(el2);
    });

    const readout = bar.querySelector('.of-read');
    const btnOf = (k) => bar.querySelector(`[data-of="${k}"]`);

    // 尺寸档按「当前 pad 等于哪一档」反推：拖过锚点之后没有一档成立，就报「自定义」
    const sizeTag = (op) => {
      // 四边都是 0 就是一格没扩：这时候说「自定义」会让人以为动过什么
      if (!op.l && !op.t && !op.r && !op.b) return '原图';
      const near = (a, b2) => ['l', 't', 'r', 'b'].every((k) => Math.abs((a[k] || 0) - (b2[k] || 0)) <= 1.5);
      const hit = OP_RATIOS.find(([, r]) => near(op, outpaintPad(op.w, op.h, r, OP_PAD_PCT)));
      if (hit) return hit[0];
      if (near(op, outpaintPad(op.w, op.h, 0, OP_PAD_PCT))) return `四周 +${OP_PAD_PCT}%`;
      return '自定义';
    };

    // 分辨率：按画布长边反推最近的档（1024 / 2048 / 4096），对不上就报实际像素
    const resTag = (f) => {
      const long = Math.max(f.nw, f.nh);
      const hit = SIZES.find(([, , px]) => Math.abs(px - long) <= 24);
      return hit ? hit[1] : `${long}px`;
    };

    const syncBar = () => {
      const op = outpaintOf(n);
      if (!op) return;
      const f = outpaintFrame(op.w, op.h, op);
      const wf = presetOptions().find((o) => o.id === n.gen.wf);
      btnOf('wf').innerHTML = `${icon('wf')}<span>${wf ? wf.label : '选工作流'}</span><i class="of-caret"></i>`;
      btnOf('wf').title = wf ? `${wf.catLabel} · ${wf.label}` : '还没有可用工作流';
      btnOf('size').innerHTML = `<span>${sizeTag(op)}</span><i class="of-caret"></i>`;
      btnOf('size').title = `画布尺寸：${op.w} × ${op.h} → ${f.nw} × ${f.nh}（拖边框上的八个锚点也能改）`;
      btnOf('res').innerHTML = `<span>${resTag(f)}</span><i class="of-caret"></i>`;
      btnOf('res').title = '输出分辨率：按当前画布比例缩放到目标长边';
      btnOf('batch').innerHTML = `<span>${n.gen.batch || 1} 张</span><i class="of-caret"></i>`;
      readout.textContent = `${op.w} × ${op.h} → ${f.nw} × ${f.nh}`;
      // 一行放不下时这串数字会被省略号截断，全文放 title 里
      readout.title = `原图 ${op.w} × ${op.h} → 画布 ${f.nw} × ${f.nh}`;
    };

    const openWfMenu = () => {
      // 扩图只列**吃图**的工作流：纯文生图喂不进图，选了也只会重新生成一张。
      // 前缀标出它走哪条路——「遮罩」只重绘新长出来的边（最准），「整图」整张重画一遍。
      const list = presetOptions().filter((o) => o.image);
      if (!list.length) {
        flash('还没有能吃图的工作流：扩图要么用局部重绘（吃遮罩），要么用图生图 / 图像编辑');
        return;
      }
      openPopMenu(btnOf('wf'), list.map((o) => [
        `${o.alphaMask ? '遮罩' : '整图'} · ${o.label}`,
        () => {
          n.gen.wf = o.id;
          n.gen.wfAuto = false;      // 手选过就别再被「按参考图自动换」覆盖
          queueSave();
          commit();
          syncBar();
          syncGenOpts(n);
        },
        o.id === n.gen.wf ? 'active' : ''],
      ), '工作流（只列吃图的）');
    };

    const openSizeMenu = () => {
      const op = outpaintOf(n);
      if (!op) return;
      // 第一项是「原图」：四边归零，回到一格没扩的状态（相当于把拖出来的都收回去）。
      // 没有这一项的话，拖歪了只能一格一格拖回来，或者收起扩图重来。
      const items = [['原图（不扩）', () => {
        setOutpaintPad(n, { l: 0, t: 0, r: 0, b: 0 });
        draw();
        syncBar();
        syncGenOpts(n);
      }]];
      OP_RATIOS.forEach(([label, r]) => {
        items.push([label, () => {
          setOutpaintPad(n, outpaintPad(op.w, op.h, r, OP_PAD_PCT));
          draw();
          syncBar();
          syncGenOpts(n);
        }]);
      });
      items.push([`四周 +${OP_PAD_PCT}%`, () => {
        setOutpaintPad(n, outpaintPad(op.w, op.h, 0, OP_PAD_PCT));
        draw();
        syncBar();
        syncGenOpts(n);
      }]);
      items.push(['自定义尺寸…', () => openDimMenu(btnOf('size'), n, () => {
        draw();
        syncBar();
        syncGenOpts(n);
      })]);
      openPopMenu(btnOf('size'), items, '尺寸');
    };

    const openResMenu = () => {
      const op = outpaintOf(n);
      if (!op) return;
      const items = SIZES.map(([, label, px]) => [label, () => {
        scaleOutpaintTo(n, px);
        draw();
        syncBar();
        syncGenOpts(n);
      }]);
      openPopMenu(btnOf('res'), items, '分辨率（按当前比例缩放到目标长边）');
    };

    const openBatchMenu = () => {
      openPopMenu(btnOf('batch'), [1, 2, 4].map((v) => [`${v} 张`, () => {
        n.gen.batch = v;
        queueSave();
        commit();
        syncBar();
        syncGenOpts(n);
      }, Number(n.gen.batch) === v ? 'active' : '']), '数量');
    };

    bar.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-of]');
      if (!b) return;
      ev.stopPropagation();
      if (b.dataset.of === 'cancel') { closeOutpaint(n); return; }
      if (b.dataset.of === 'wf') openWfMenu();
      else if (b.dataset.of === 'size') openSizeMenu();
      else if (b.dataset.of === 'res') openResMenu();
      else if (b.dataset.of === 'batch') openBatchMenu();
    }, { signal: ac.signal });
    const el = thumb.closest('.node');
    const dimEl = el && el.querySelector('.n-dim');
    // 缩略图始终按**原图**比例：它是原图的画框，不是新画布的画框。
    // 跟着画布改 --ar 会让节点高度一跳（380×407 塌成 380×208），而且原图被迫缩小——
    // 那正是「图片大小固定不变」的观感来源。
    thumb.style.setProperty('--ar', (op0.w / op0.h).toFixed(4));
    // 画布要溢出缩略图，得压在邻居上面，不然「长出去」的那半边被别的节点挡住
    if (el) el.classList.add('op-raised');
    // 别叫 state：模块级已经有一个 state（视图缩放 state.view.k 在里面），
    // 同名局部变量会把它整个遮住 —— 下面乘 state.view.k 那行就成了 undefined → 1，
    // 拖动换算少乘一次视图缩放，拖 100px 只扩 89px（这个 bug 就是这么来的）。
    let dragK = 1;

    // 面板跟工具条一个逻辑：**贴着画布外框**，不是贴着缩略图。
    // 横向对着外框中线（只往右拖时会偏出去），纵向退到外框下沿外面——
    // 否则外框往下长多少，面板就压住多少新扩出来的地方（用户截图里那条黄框就是这样）。
    // 两个偏移都按屏幕像素给（外面还套着一层画布缩放，面板自己又被 --gp-k 反缩回去）。
    //
    // 单独抽出来是因为它有两类调用方：draw()（pad 变了）和 applyView()（平移/缩放）。
    // 「别顶出屏幕」是屏幕坐标的事，视图一动就得重算——面板本身是世界坐标的。
    // 用函数声明（不是 const 箭头）：fitPrompt 在面板还没挂进 DOM 时就会调到它，
    // 那时 `el` 还没赋值，靠第一行的 isConnected 提前返回（声明提升，const 会撞 TDZ）。
    function placePanel() {
      const op = outpaintOf(n);
      if (!op || !panel.isConnected) return;
      const f = outpaintFrame(op.w, op.h, op);
      const tw = thumb.clientWidth;
      if (!tw) return;
      const k = tw / op.w;
      const vk = (state.view && state.view.k) || 1;
      // 面板的 `top: 100%` 是**节点盒子**的底，缩略图底下还留着一截边距——
      // 不减掉这一截，面板会被白白推开 20px，跟工具条那 8px 的贴边对不上。
      const slack = el
        ? (el.getBoundingClientRect().bottom - thumb.getBoundingClientRect().bottom) / vk
        : 0;
      const wantPb = (f.nh - f.oy - op.h) * k - slack;          // 外框底边超出缩略图多少（世界像素）
      const wantDx = (f.nw / 2 - f.ox - op.w / 2) * k;          // 外框中线相对缩略图中线的偏移
      panel.style.setProperty('--op-pb', `${wantPb}px`);
      panel.style.setProperty('--op-dx', `${wantDx}px`);
      // 外框比屏幕还高/还宽时，「贴着外框」就是把面板顶出屏幕——「生成」就点不着了。
      // 顶到视口边缘就停住（下面给工具条留 64px、上面给顶栏留 8px）：宁可压住一点画面，
      // 也不能让按钮跑出屏幕。和工具条「居中 → 被夹住就贴边」是同一套退让。
      const r = panel.getBoundingClientRect();
      let dy = 0;
      const overY = r.bottom - (window.innerHeight - 64);
      if (overY > 0) dy = -overY;
      if (r.top + dy < 8) dy = 8 - r.top;
      if (dy) panel.style.setProperty('--op-pb', `${wantPb + dy / vk}px`);
      const overL = 12 - r.left;
      const overR = r.right - (window.innerWidth - 12);
      if (overL > 0) panel.style.setProperty('--op-dx', `${wantDx + overL / vk}px`);
      else if (overR > 0) panel.style.setProperty('--op-dx', `${wantDx - overR / vk}px`);
    }
    if (opSession) opSession.place = placePanel;

    const draw = () => {
      const op = outpaintOf(n);
      if (!op) return;
      const f = outpaintFrame(op.w, op.h, op);
      const tw = thumb.clientWidth;
      if (!tw) return;
      // 缩略图是**原图的画框**（--ar 是 op.w/op.h），所以原图铺满它：k = tw / op.w。
      // 画布比原图大多少，就按同一个 k 往右/下**真的长出去**多少。
      // 早先反着来（画布塞满缩略图、原图往里缩），拖右边时看到的只是「图被压扁、框没变宽」，
      // 用户的原话就是「图片大小固定不变」——扩出来的部分根本没长出来。
      // k **恒定**：屏幕位移 ↔ 原图像素是 1:1 线性，拖多少就扩多少。
      // 这里绝不能再掺「画布别出视口」的约束——一掺进去 k 就随 pad 变，
      // 原图跟着缩小（实测拖到 4 倍时从 339px 掉到 152px），
      // 而且同一段鼠标位移换算出的像素数跟着变，越拖越快，手感直接崩。
      // 画布溢出视口就让溢出，用户自己平移/缩放画布即可。
      const k = tw / op.w;
      // 拖动换算要的是**屏幕像素 / 原图像素**，不是 CSS 比例：
      // style 里写的是 CSS 像素，外面还套着一层画布视图缩放（`#nodes { transform: scale }`），
      // 拿 CSS 比例去除，拖 100px 只会扩 93px（视图 93% 时），缩到 50% 就只扩一半。
      // 这个数只在 pointermove 里用，别拿它去写样式。
      dragK = k * (state.view && state.view.k ? state.view.k : 1);
      // 画布（= 舞台）相对缩略图的偏移就是 -ox·k / -oy·k：原图的位置一点不动
      stage.style.left = `${-f.ox * k}px`;
      stage.style.top = `${-f.oy * k}px`;
      stage.style.width = `${f.nw * k}px`;
      stage.style.height = `${f.nh * k}px`;
      sel.style.left = stage.style.left;
      sel.style.top = stage.style.top;
      sel.style.width = stage.style.width;
      sel.style.height = stage.style.height;
      im.style.left = `${f.ox * k}px`;
      im.style.top = `${f.oy * k}px`;
      im.style.width = `${op.w * k}px`;
      im.style.height = `${op.h * k}px`;
      orig.style.left = `${(f.ox / f.nw) * 100}%`;
      orig.style.top = `${(f.oy / f.nh) * 100}%`;
      orig.style.width = `${(op.w / f.nw) * 100}%`;
      orig.style.height = `${(op.h / f.nh) * 100}%`;
      bands.innerHTML = '';
      outpaintBands(op.w, op.h, f.nw, f.nh, f.ox, f.oy).forEach(([x, y, w, h]) => {
        const i = document.createElement('i');
        i.style.left = `${(x / f.nw) * 100}%`;
        i.style.top = `${(y / f.nh) * 100}%`;
        i.style.width = `${(w / f.nw) * 100}%`;
        i.style.height = `${(h / f.nh) * 100}%`;
        bands.appendChild(i);
      });
      if (dimEl) dimEl.textContent = `${f.nw} × ${f.nh}`;
      syncBar();
      // 面板贴着这块外框（细节见 placePanel）
      placePanel();
      // 工具条贴的是这块外框：外框一变宽/一挪位，它得跟着重新居中。
      // 早先只有「换节点 / 平移画布」会重贴，拖锚点不会——拖完之后整条就落在框上方偏左，
      // 用户截图里那个「悬在框外面」的样子就是这么来的。
      scheduleFollowBars();
    };

    // 锚点：增量除以 k。不用绝对坐标——拖动中途 pad 变了，缩略图的宽高和 k 也跟着变，
    // 绝对坐标会自己跟自己对不上。
    let drag = null;
    sel.addEventListener('pointerdown', (ev) => {
      const a = ev.target.dataset && ev.target.dataset.anchor;
      if (!a) return;
      ev.preventDefault();
      ev.stopPropagation();
      drag = { a, x: ev.clientX, y: ev.clientY };
    }, { signal: ac.signal });
    window.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const op = outpaintOf(n);
      if (!op) return;
      const k = dragK || 1;
      const dx = (ev.clientX - drag.x) / k, dy = (ev.clientY - drag.y) / k;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      let { l, t, r, b } = op;
      if (drag.a.includes('w')) l = Math.max(0, l - dx);
      if (drag.a.includes('e')) r = Math.max(0, r + dx);
      if (drag.a.includes('n')) t = Math.max(0, t - dy);
      if (drag.a.includes('s')) b = Math.max(0, b + dy);
      // 上限只削正在拖的那一边：整块一起缩会让没拖的边也跟着动，手感很怪
      if (l + r > OP_MAX_SIDE - op.w) {
        if (drag.a.includes('w')) l = Math.max(0, OP_MAX_SIDE - op.w - r);
        else if (drag.a.includes('e')) r = Math.max(0, OP_MAX_SIDE - op.w - l);
      }
      if (t + b > OP_MAX_SIDE - op.h) {
        if (drag.a.includes('n')) t = Math.max(0, OP_MAX_SIDE - op.h - b);
        else if (drag.a.includes('s')) b = Math.max(0, OP_MAX_SIDE - op.h - t);
      }
      setOutpaintPad(n, { l, t, r, b });
      draw();
      syncGenOpts(n);       // 面板里那颗尺寸胶囊当场跟着变，别等生成才发现对不上
    }, { signal: ac.signal });
    const endDrag = () => { drag = null; };
    window.addEventListener('pointerup', endDrag, { signal: ac.signal });
    window.addEventListener('pointercancel', endDrag, { signal: ac.signal });
    window.addEventListener('resize', draw, { signal: ac.signal });

    // 图可能还没解码：先排一帧，等 load 回来再画一次
    im.addEventListener('load', draw);
    requestAnimationFrame(draw);
  }

  /* ---------------- 遮罩编辑器 ---------------- */
  // 唯一真源是「笔画列表」，不是位图：
  //   · 位图由重放重建 → 重开是精确还原（旧实现从导出的 PNG 反推蓝色，羽化/抗锯齿后必然走样）
  //   · 10 笔约 2KB，存档无压力
  //   · 预览与提交共用同一份数据，只是渲染参数不同（预览蓝色半透明 / 烘 alpha 时全黑不透明）
  //
  // 归属：遮罩属于「某一张图」，不属于节点。键由图片身份算出，切 gallery / 切 run 自动跟着走。
  // 旧实现挂在 n.gen.mask 上，切到第二张图时遮罩还是第一张的——这是它最硬的逻辑错误。
  const MASK_PREVIEW_COLOR = '#3aa0ff';
  const MASK_SOLID = '#000';
  const MASK_SIZE = { min: 8, max: 200, def: 48 };

  // 画笔颜色 / 透明度只影响「看得见」，不进 alpha：烘进图里的只有「涂过 / 没涂过」。
  // 所以它是本地偏好（localStorage），不写进画布存档——换台机器看同一块遮罩不必长得一样。
  const MASK_STYLE_KEY = 'infisheet-mask-style';
  const MASK_COLORS = ['#3aa0ff', '#ff5c8a', '#ffd23f', '#5ce1a0', '#b07bff'];

  function maskStyle() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(MASK_STYLE_KEY) || 'null'); } catch { /* 隐私模式 */ }
    const color = v && /^#[0-9a-f]{6}$/i.test(String(v.color || '')) ? v.color : MASK_PREVIEW_COLOR;
    const opacity = v && Number.isFinite(Number(v.opacity)) ? clamp(Number(v.opacity), 0.1, 1) : 0.55;
    return { color, opacity };
  }
  function setMaskStyle(patch) {
    const next = { ...maskStyle(), ...patch };
    try { localStorage.setItem(MASK_STYLE_KEY, JSON.stringify(next)); } catch { /* 超配额忽略 */ }
    return next;
  }
  // #rrggbb + 透明度 → canvas 能用的 rgba()
  function maskPaint(style) {
    const s = style || maskStyle();
    const n = parseInt(s.color.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${s.opacity})`;
  }

  // 图片身份的算法只有一个要求：**同一张图在上传前后必须算出同一个键**。
  // 之前用 dataURL 兜底，上传把 dataURL 从 base64 换成 /api/view 之后键就变了，
  // 遮罩当场「消失」——涂了半天跑出来一张原图，而且没有任何报错。
  // 所以顺序是：gallery 文件名 → 上传文件名 → 节点兜底；上传成功时把旧键迁到新键。
  function imgKeyOf(n) {
    if (!n || n.type !== 'image') return '';
    const g = n.gen || {};
    const it = (g.gallery || [])[g.idx || 0];
    if (it && it.filename) return `${it.type || 'output'}:${it.subfolder || ''}/${it.filename}`;
    if (n.filename) return `input:${n.subfolder || ''}/${n.filename}`;
    if (n.uploaded) return `input:${n.uploaded}`;
    return `node:${n.id}`;
  }

  // 上传把「节点兜底键」换成「上传文件名键」，遮罩得跟着搬过去
  function migrateMaskKey(n, oldKey) {
    const newKey = imgKeyOf(n);
    if (!oldKey || oldKey === newKey || !n.masks || !n.masks[oldKey]) return;
    n.masks[newKey] = n.masks[oldKey];
    delete n.masks[oldKey];
  }

  function maskDocOf(n) {
    const k = imgKeyOf(n);
    return k && n.masks ? n.masks[k] || null : null;
  }

  // 能不能涂遮罩：只看这台机器上有没有吃遮罩的工作流。
  // 不看当前选的是哪张——点遮罩时如果不对就当场切过去（ensureMaskWorkflow）。
  // 之前按「当前工作流吃不吃」来禁用按钮，结果老存档（wf 是文生图、wfAuto 还丢了）
  // 一进来按钮就是灰的，用户只会认为功能坏了。
  function maskCapable() {
    return presetOptions().some((o) => o.alphaMask);
  }

  // 工作流被自动换掉之后，把面板上那颗按钮的字同步过去。
  // 不刷的话只有 3 秒的 flash 说了一句，按钮还写着旧名字——用户会以为没生效，
  // 下次点生成又是同一轮「怎么又给我改了」。
  function paintWfChip(n) {
    const box = document.querySelector(`[data-panel-for="${CSS.escape(n.id)}"] .wfsel`);
    const span = box && box.querySelector('.gm-btn span');
    if (!span) return;
    const hit = presetOptions().find((o) => o.id === n.gen.wf);
    span.textContent = hit ? hit.label : (n.gen.wf || '（空）');
    const btn = box.querySelector('.gm-btn');
    if (btn) btn.title = span.textContent;
  }

  // 工作流必须和「有没有遮罩」对上，两个方向都要对：
  //   有遮罩 + 工作流不吃遮罩 → mask 根本没进图，涂了白涂（上一版就是这么坏的）
  //   没遮罩 + 工作流吃遮罩   → 普通图 alpha 全不透明 → mask 全 0 → 什么都不改，
  //                            出来跟原图逐位相同，最容易被当成「生成坏了」
  // 返回 false 表示这次不该跑（要么没救了，要么得让用户自己决定），调用方直接中止。
  function reconcileWorkflow(n, picked, needMask) {
    const g = n.gen;
    const opts = presetOptions();
    const cur = opts.find((o) => o.id === g.wf);
    const auto = g.wfAuto !== false;      // 没存过 wfAuto 的老存档按「自动」处理
    const want = picked.length ? 'img2img' : 'txt2img';
    if (needMask) {
      if (cur && cur.alphaMask) return true;
      const hit = opts.find((o) => o.alphaMask);
      if (!hit) {
        flash('没有能吃遮罩的工作流（缺「Krea2 · 局部重绘」），遮罩不会生效');
        return false;
      }
      g.wf = hit.id;
      paintWfChip(n);
      flash(`这张图有遮罩，只能用吃遮罩的工作流，已切到「${hit.label}」`);
      queueSave();
      return true;
    }
    if (cur && cur.alphaMask) {
      // 手选过就让他自己决定：静默换掉会变成「我选的又被改了」
      if (!auto) {
        flash(`「${cur.label}」要靠遮罩才有效：这张图没涂，跑出来会和原图一样`);
        return false;
      }
      const better = pickWorkflow(want);
      if (better && better !== g.wf) {
        const hit = opts.find((o) => o.id === better);
        g.wf = better;
        paintWfChip(n);
        flash(`这张图没涂遮罩，自动切回「${hit ? hit.label : better}」`);
        queueSave();
      }
      return true;
    }
    // 自动挑的按「有没有参考图」纠正一次；手选过的照他的来，别再偷偷换掉。
    // 高清 / 视频 / 音频不碰（各有专门入口，按图多图少去改只会把功能改坏）。
    if (auto && (!cur || cur.category === 'txt2img' || cur.category === 'img2img')) {
      const cat = cur ? cur.category : '';
      if (cat !== want) {
        const better = pickWorkflow(want);
        const hit = opts.find((o) => o.id === better);
        if (better && better !== g.wf) {
          g.wf = better;
          paintWfChip(n);
          flash(`按${picked.length ? '参考图' : '纯文生图'}自动切到「${hit ? hit.label : better}」`);
          queueSave();
        }
      }
    }
    return true;
  }

  // 扩图对工作流的唯一硬要求是「**吃图**」：
  //   吃遮罩（局部重绘）→ 只重绘新长出来的那几圈，最准；
  //   只吃图不吃遮罩（图生图 / 图像编辑）→ 整张重画一遍，新边透明→黑边，靠模型补；
  //   完全不吃图（纯文生图）→ 喂进去的图会被默默丢掉，出来是一张全新的图，必须换掉。
  // 早先这里直接调 ensureMaskWorkflow（要求吃遮罩），于是用户选了别的工作流，
  // 一点生成就被静默换成局部重绘——看起来就是「我选的根本不生效」。
  function ensureOutpaintWorkflow(n) {
    const g = n && n.gen;
    if (!g) return null;
    const opts = presetOptions();
    const cur = opts.find((o) => o.id === g.wf);
    if (cur && cur.image) return cur;
    const hit = opts.find((o) => o.alphaMask) || opts.find((o) => o.image);
    if (!hit) return null;
    const from = cur ? cur.label : '当前工作流';
    g.wf = hit.id;
    paintWfChip(n);
    queueSave();
    flash(`「${from}」不吃图，扩图用不上它，已换成「${hit.label}」`);
    return hit;
  }

  // 当前工作流吃不了遮罩就切到能吃的那张，并说清楚换成了什么（不静默换）
  function ensureMaskWorkflow(n) {
    const g = n && n.gen;
    if (!g) return null;
    const opts = presetOptions();
    const cur = opts.find((o) => o.id === g.wf);
    if (cur && cur.alphaMask) return cur;
    const hit = opts.find((o) => o.alphaMask);
    if (!hit) return null;
    const from = cur ? cur.label : '当前工作流';
    g.wf = hit.id;
    paintWfChip(n);   // 面板上的按钮立刻改成新名字，别只靠那 3 秒的提示
    // 不钉 wfAuto：工作流是「按有没有遮罩」推导出来的，不是用户手选。
    // 钉住的话，清掉遮罩之后节点会永远卡在局部重绘上，跑出来跟原图一模一样。
    queueSave();
    flash(`「${from}」不吃遮罩，已换成「${hit.label}」`);
    return hit;
  }

  function putMaskDoc(n, doc) {
    const k = imgKeyOf(n);
    if (!k) return;
    if (!n.masks) n.masks = {};
    if (doc && doc.strokes.length) {
      doc.cover = maskCover(doc);   // 缓存：renderAll 每次都会读它，别在渲染里现算
      n.masks[k] = doc;
    } else {
      delete n.masks[k];
    }
    queueSave();
    rerenderNode(n.id);
  }

  // 颜色 / 透明度是全局偏好：改完之后画布上所有遮罩预览都得跟着换。
  // 不整块 rerenderNode——那会把节点的选中态、面板里的光标一起掀掉。
  function repaintMaskOverlays() {
    state.nodes.forEach((n) => {
      if (n.type !== 'image') return;
      const cv = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .thumb .mask-ov`);
      const md = cv && maskDocOf(n);
      if (!md) return;
      paintStrokes(cv.getContext('2d'), md, false);
    });
  }

  // solid=false：半透明预览（画在浮层和节点缩略图上给人看，颜色/透明度跟着本地偏好走）
  // solid=true ：全黑不透明（烘 alpha 与统计覆盖率用——destination-out 只看 alpha）
  function paintStrokes(ctx, doc, solid, style) {
    ctx.clearRect(0, 0, doc.w, doc.h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const ink = solid ? MASK_SOLID : maskPaint(style);
    for (const s of doc.strokes || []) {
      // 矩形遮罩：MCP 的 set_mask 用它（AI 涂不了笔，但能圈一块区域）。
      // 和笔画共用同一份数据，所以浏览器打开时能看到 AI 圈的那块，也能接着改。
      if (s.tool === 'rect') {
        const r = s.rect || [];
        if (!(r[2] > 0 && r[3] > 0)) continue;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = ink;
        ctx.fillRect(r[0], r[1], r[2], r[3]);
        continue;
      }
      // 橡皮走 destination-out，颜色无关、只看 alpha，所以必须用不透明色：
      // 拿 55% 的蓝去擦只能擦掉 55%，越擦越花
      ctx.strokeStyle = s.tool === 'eraser' || solid ? MASK_SOLID : ink;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
      ctx.lineWidth = s.size;
      const pts = s.pts || [];
      if (!pts.length) continue;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], s.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // 覆盖率缩到 200 宽再数 alpha：2000×3000 的原图直接 getImageData 是 24MB，
  // 每落一笔都算一次会明显卡手。
  function maskCover(doc) {
    if (!doc || !doc.strokes || !doc.strokes.length) return 0;
    const w = Math.min(200, doc.w);
    const h = Math.max(1, Math.round((doc.h / doc.w) * w));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.scale(w / doc.w, w / doc.w);
    paintStrokes(ctx, doc, true);
    const d = ctx.getImageData(0, 0, w, h).data;
    let on = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) on++;
    return Math.round((on / (w * h)) * 100);
  }

  function loadImageEl(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片加载失败'));
      im.src = src;
    });
  }

  // 把遮罩烘进原图的 alpha 通道：涂过的地方 alpha=0（透明），其余 255。
  // 实测 ComfyUI 的 LoadImage 是 mask = 1 - alpha，所以「透明 = 重绘」。
  // 好处：图和遮罩是同一个文件，不存在两个文件配对错位的可能。
  async function bakeMaskCanvas(n, doc) {
    const img = await loadImageEl(n.dataURL);
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if (doc && doc.strokes && doc.strokes.length) {
      const m = document.createElement('canvas');
      m.width = cv.width;
      m.height = cv.height;
      const mc = m.getContext('2d');
      mc.scale(cv.width / doc.w, cv.height / doc.h);
      paintStrokes(mc, doc, true);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(m, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    return cv;
  }

  let maskSession = null;

  // 擦除 / 去字 = 「涂完直接生成一个新节点」，跟单纯涂遮罩的差别只在提示词和落地方式。
  // 共用同一个编辑器：笔画数据、撤销、橡皮这些没必要写两遍。
  const MASK_INTENT = {
    erase: { label: '擦除', hint: '涂掉要去掉的东西 · 滚轮调笔刷 · [ ] 调粗细 · Ctrl+Z 撤销 · Esc 取消' },
    detext: { label: '去字', hint: '涂掉文字 / 水印 · 滚轮调笔刷 · [ ] 调粗细 · Ctrl+Z 撤销 · Esc 取消' },
  };

  function openMaskEditor(n, opts = {}) {
    if (!n || n.type !== 'image' || !n.dataURL) { flash('这个节点还没有图片，先出一张再涂'); return; }
    const intent = opts.intent && MASK_INTENT[opts.intent] ? opts.intent : '';
    if (intent) {
      // 擦除 / 去字落在一个**新节点**上，源节点的工作流不该被动
      if (!maskCapable()) { flash('没有能吃遮罩的工作流（缺「Krea2 · 局部重绘」），涂了也不会生效'); return; }
    } else if (!ensureMaskWorkflow(n)) {
      // 进编辑器之前先把工作流对齐：涂了却因为工作流不吃遮罩而不生效，是最难查的一类问题
      flash('没有能吃遮罩的工作流（缺「Krea2 · 局部重绘」），涂了也不会生效');
      return;
    }
    if (maskSession) closeMaskEditor();
    loadImageEl(n.dataURL)
      .then((img) => buildMaskEditor(n, img, { intent }))
      .catch(() => flash('图片加载失败，没法涂遮罩'));
  }

  function closeMaskEditor() {
    if (!maskSession) return;
    try { maskSession.ac.abort(); } catch { /* 已经 abort 过 */ }
    maskSession.root.remove();
    maskSession = null;
  }

  function buildMaskEditor(n, img, opts = {}) {
    const intent = opts.intent || '';
    const mode = intent ? MASK_INTENT[intent].label : '遮罩';
    const W = img.naturalWidth || 1024;
    const H = img.naturalHeight || 1024;
    const saved = maskDocOf(n);
    // 尺寸对不上（换过图）就丢弃旧笔画：坐标空间变了，留着必然错位。
    // 擦除 / 去字是**一次性指令**：涂的是「这次要处理哪儿」，结果落在新节点上，
    // 所以永远从空白开始，也不回写源节点——否则同一块遮罩会跟着源图留到下一次操作，
    // 下次开编辑器就是一片已经涂满的区域。
    const doc = !intent && saved && saved.w === W && saved.h === H
      ? { w: W, h: H, strokes: saved.strokes.map((s) => ({ ...s, pts: s.pts.map((p) => p.slice()) })) }
      : { w: W, h: H, strokes: [] };

    const root = document.createElement('div');
    root.id = 'maskEditor';
    const style = maskStyle();
    const alphaPct = Math.round(style.opacity * 100);
    root.innerHTML = `
      <div class="me-bar">
        <span class="me-title">${esc(n.title)} · ${mode}</span>
        <div class="me-tools">
          <button type="button" class="me-btn" data-tool="brush" aria-pressed="true">画笔</button>
          <button type="button" class="me-btn" data-tool="eraser" aria-pressed="false">橡皮</button>
          <button type="button" class="me-btn" data-act="undo" title="撤销上一笔（Ctrl+Z）">撤销</button>
          <button type="button" class="me-btn" data-act="clear" title="清空全部笔画">清除</button>
        </div>
        <label class="me-size">粗细 <input type="range" min="${MASK_SIZE.min}" max="${MASK_SIZE.max}"
          step="1" value="${MASK_SIZE.def}"><b>${MASK_SIZE.def}</b></label>
        <div class="me-paint">
          <span class="me-lbl">颜色</span>
          <div class="me-colors">
            ${MASK_COLORS.map((c) => `<button type="button" class="me-sw${c.toLowerCase() === style.color.toLowerCase() ? ' on' : ''}"
              data-color="${c}" style="--sw:${c}" title="${c}"></button>`).join('')}
            <label class="me-custom" title="自定义颜色"><input type="color" value="${style.color}"></label>
          </div>
          <span class="me-lbl">透明度</span>
          <input type="range" class="me-alpha" min="10" max="100" step="5" value="${alphaPct}">
          <b class="me-alpha-v">${alphaPct}%</b>
        </div>
        <span class="me-spacer"></span>
        <span class="me-cover">遮罩 0%</span>
        <button type="button" class="me-btn" data-act="cancel">取消</button>
        <button type="button" class="me-apply" data-act="apply">应用</button>
      </div>
      <div class="me-stage">
        <div class="me-frame">
          <img class="me-img" alt="">
          <canvas class="me-cv"></canvas>
          <span class="me-hint">${intent ? MASK_INTENT[intent].hint : '涂出要重绘的区域 · 滚轮调笔刷 · [ ] 调粗细 · Ctrl+Z 撤销 · Esc 取消'}</span>
        </div>
      </div>`;

    const stage = root.querySelector('.me-stage');
    const frame = root.querySelector('.me-frame');
    const cv = root.querySelector('.me-cv');
    const coverEl = root.querySelector('.me-cover');
    const applyBtn = root.querySelector('[data-act="apply"]');
    const undoBtn = root.querySelector('[data-act="undo"]');
    const sizeEl = root.querySelector('.me-size input');
    const sizeNum = root.querySelector('.me-size b');

    root.querySelector('.me-img').src = n.dataURL;
    cv.width = doc.w;
    cv.height = doc.h;
    const ctx = cv.getContext('2d');

    const ac = new AbortController();
    const sess = { n, doc, cv, ctx, root, frame, stage, ac, tool: 'brush', size: MASK_SIZE.def, stroke: null };
    maskSession = sess;

    const redraw = () => paintStrokes(ctx, doc, false);
    const refresh = () => {
      const pct = maskCover(doc);
      coverEl.textContent = `遮罩 ${pct}%`;
      applyBtn.disabled = false;
      undoBtn.disabled = !doc.strokes.length;
    };

    // 显示尺寸按 contain 算一次写进 frame；落笔只在这一层换算
    const fit = () => {
      const aw = stage.clientWidth - 36;
      const ah = stage.clientHeight - 36;
      const k = Math.min(aw / doc.w, ah / doc.h, 1);
      frame.style.width = `${Math.max(80, Math.round(doc.w * k))}px`;
      frame.style.height = `${Math.max(80, Math.round(doc.h * k))}px`;
    };
    requestAnimationFrame(fit);
    window.addEventListener('resize', fit, { signal: ac.signal });

    const toDoc = (ev) => {
      const r = cv.getBoundingClientRect();
      const k = doc.w / r.width;
      return [
        Math.round(clamp((ev.clientX - r.left) * k, 0, doc.w)),
        Math.round(clamp((ev.clientY - r.top) * k, 0, doc.h)),
      ];
    };

    const endStroke = () => {
      if (!sess.stroke) return;
      sess.stroke = null;
      refresh();
    };

    cv.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();          // 不让画布顺手开始拖节点/平移
      if (ev.button !== 0) return;
      const s = { tool: sess.tool, size: sess.size, pts: [toDoc(ev)] };
      doc.strokes.push(s);
      sess.stroke = s;
      redraw();
    }, { signal: ac.signal });

    // 走笔挂在 window 上：挂在 canvas 上一快就划出边界，后面的 move 全丢，
    // 画出来是一串孤立的圆点而不是线（旧实现踩过这个坑）
    window.addEventListener('pointermove', (ev) => {
      if (!sess.stroke) return;
      const p = toDoc(ev);
      const pts = sess.stroke.pts;
      const last = pts[pts.length - 1];
      if (last && Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) < 1) return;
      pts.push(p);
      redraw();
    }, { signal: ac.signal });
    window.addEventListener('pointerup', endStroke, { signal: ac.signal });
    window.addEventListener('pointercancel', endStroke, { signal: ac.signal });

    root.querySelectorAll('[data-tool]').forEach((b) => {
      b.onclick = () => {
        sess.tool = b.dataset.tool;
        root.querySelectorAll('[data-tool]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        cv.style.cursor = sess.tool === 'eraser' ? 'cell' : 'crosshair';
      };
    });

    const setSize = (v) => {
      sess.size = Math.round(clamp(v, MASK_SIZE.min, MASK_SIZE.max));
      sizeEl.value = sess.size;
      sizeNum.textContent = sess.size;
    };
    sizeEl.oninput = () => setSize(Number(sizeEl.value));

    // 颜色 / 透明度：只改「看起来」，不动笔画数据（烘进 alpha 的只有涂过与否）。
    // 改完立刻重画本层，并同步画布上所有节点的遮罩预览——否则关掉编辑器才发现颜色没变。
    const swatches = [...root.querySelectorAll('.me-sw')];
    const colorEl = root.querySelector('.me-custom input');
    const alphaEl = root.querySelector('.me-alpha');
    const alphaNum = root.querySelector('.me-alpha-v');
    const paintSwatches = (color) => {
      const low = String(color).toLowerCase();
      swatches.forEach((b) => b.classList.toggle('on', b.dataset.color.toLowerCase() === low));
      colorEl.value = color;
    };
    const applyStyle = (patch) => {
      const next = setMaskStyle(patch);
      if (patch.color) paintSwatches(next.color);
      if (patch.opacity != null) {
        const pct = Math.round(next.opacity * 100);
        alphaEl.value = pct;
        alphaNum.textContent = `${pct}%`;
      }
      redraw();
      repaintMaskOverlays();
    };
    swatches.forEach((b) => { b.onclick = () => applyStyle({ color: b.dataset.color }); });
    colorEl.oninput = () => applyStyle({ color: colorEl.value });
    alphaEl.oninput = () => applyStyle({ opacity: Number(alphaEl.value) / 100 });

    root.querySelector('[data-act="undo"]').onclick = () => {
      doc.strokes.pop();
      redraw();
      refresh();
    };
    root.querySelector('[data-act="clear"]').onclick = () => {
      if (!doc.strokes.length) return;
      doc.strokes.length = 0;
      redraw();
      refresh();
    };
    root.querySelector('[data-act="cancel"]').onclick = () => closeMaskEditor();
    applyBtn.onclick = () => {
      if (intent && !doc.strokes.length) { flash(`${mode}需要先涂出要处理的区域`); return; }
      if (intent) {
        // 新建一个节点：原图不动，涂过的区域跟着搬过去，提示词按 intent 预填。
        // 不回写源节点的遮罩——这块区域属于「这一次操作」，不属于那张图。
        closeMaskEditor();
        createEditNode(n, intent, doc);
        flash(`${mode}：区域已带过去，点生成即可（也可以先改提示词）`);
        return;
      }
      putMaskDoc(n, doc);
      closeMaskEditor();
      flash(doc.strokes.length ? `遮罩已保存（${maskCover(doc)}%）` : '已清掉遮罩');
    };

    // 滚轮调笔刷：在遮罩里滚轮不该去缩放画布
    root.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      setSize(sess.size + (ev.deltaY < 0 ? 4 : -4));
    }, { passive: false, signal: ac.signal });

    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); closeMaskEditor(); return; }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        doc.strokes.pop();
        redraw();
        refresh();
        return;
      }
      if (ev.key === '[') { ev.preventDefault(); setSize(sess.size - 4); }
      if (ev.key === ']') { ev.preventDefault(); setSize(sess.size + 4); }
    }, { signal: ac.signal });

    document.body.appendChild(root);
    redraw();
    refresh();
  }

  /* ---------------- 裁剪浮层 ---------------- */
  // 八个锚点的几何：四角钉住对角，四边中点只动一条边（另一个方向一动不动）；
  // 锁了比例时，动宽就以宽为准反算高 —— 角按对边固定，边按中线对称。
  // 抽成纯函数是因为「拖拽」本身要真实指针，测起来又慢又容易被亚像素吃了。
  function dragCropSel(start, anchor, px, py, ratio, W, H) {
    const MIN = 24;
    const hasW = anchor.includes('w'), hasE = anchor.includes('e');
    const hasN = anchor.includes('n'), hasS = anchor.includes('s');
    const isCorner = (hasW || hasE) && (hasN || hasS);
    const ax = hasW ? start.x + start.w : start.x;   // 钉住不动的竖边
    const ay = hasN ? start.y + start.h : start.y;   // 钉住不动的横边
    let x = start.x, y = start.y, w = start.w, h = start.h;
    if (hasW) { w = clamp(ax - px, MIN, Math.max(MIN, ax)); x = ax - w; }
    else if (hasE) { w = clamp(px - ax, MIN, Math.max(MIN, W - ax)); x = ax; }
    if (hasN) { h = clamp(ay - py, MIN, Math.max(MIN, ay)); y = ay - h; }
    else if (hasS) { h = clamp(py - ay, MIN, Math.max(MIN, H - ay)); y = ay; }
    if (ratio) {
      if (hasW || hasE) {
        const h2 = w / ratio;
        y = isCorner ? (py < ay ? ay - h2 : ay) : start.y + start.h / 2 - h2 / 2;
        h = h2;
      } else {
        const w2 = h * ratio;
        w = w2;
        x = start.x + start.w / 2 - w2 / 2;
      }
    }
    // 收进画面：夹完再按比例修一次，别让「拖出图外」把比例拉歪
    w = clamp(w, MIN, W); h = clamp(h, MIN, H);
    if (ratio) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
    x = clamp(x, 0, Math.max(0, W - w));
    y = clamp(y, 0, Math.max(0, H - h));
    return { x, y, w, h };
  }

  // 只做「按框裁一块」，不做旋转/透视。选区存的是**显示像素**，落盘前按
  // naturalWidth / clientWidth 换回原图像素——否则 4K 原图会被裁成 800px。
  let cropSession = null;
  const CROP_RATIOS = [['自由', 0], ['1:1', 1], ['4:5', 0.8], ['3:4', 0.75], ['16:9', 16 / 9], ['9:16', 9 / 16]];

  function openCrop(n) {
    closeCrop();
    const mask = document.createElement('div');
    mask.id = 'cropMask';
    mask.innerHTML = `
      <div class="crop-box" role="dialog" aria-label="裁剪">
        <div class="crop-head">
          <strong>裁剪</strong>
          <div class="crop-ratios">${CROP_RATIOS.map(([label, r], i) => (
            `<button type="button" class="crop-ratio${i === 0 ? ' on' : ''}" data-ratio="${r}">${label}</button>`
          )).join('')}</div>
        </div>
        <div class="crop-stage">
          <img alt="" draggable="false" />
          <div class="crop-dim hidden"><i></i><i></i><i></i><i></i></div>
          <div class="crop-sel hidden"><i class="ch nw"></i><i class="ch n"></i><i class="ch ne"></i><i class="ch e"></i><i class="ch se"></i><i class="ch s"></i><i class="ch sw"></i><i class="ch w"></i></div>
        </div>
        <div class="crop-foot">
          <span class="crop-size">载入中…</span>
          <span class="crop-gap"></span>
          <button type="button" class="crop-btn" data-act="cancel">取消</button>
          <button type="button" class="crop-btn primary" data-act="apply">裁出来</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const box = mask.querySelector('.crop-box');
    const img = mask.querySelector('img');
    const stageEl = mask.querySelector('.crop-stage');
    const dimEl = mask.querySelector('.crop-dim');
    const selEl = mask.querySelector('.crop-sel');
    const sizeEl = mask.querySelector('.crop-size');
    cropSession = { node: n, mask, sel: null, ratio: 0, drag: null, abort: new AbortController() };

    const draw = () => {
      const s = cropSession && cropSession.sel;
      if (!s) return;
      selEl.style.left = `${s.x}px`;
      selEl.style.top = `${s.y}px`;
      selEl.style.width = `${s.w}px`;
      selEl.style.height = `${s.h}px`;
      // 选区外压暗：四块暗条拼出「洞」，而不是给选区加 9999px 的 box-shadow。
      // 那个阴影是 positioned 元素，绘制顺序晚于静态内容，会连标题、比例按钮、取消 / 裁出来
      // 一起压暗约一半——按钮明明能点，看着却像禁用的。四块条只是图片上的一层，天然被图片裁住。
      // （试过 clip-path polygon 挖洞：CSS 的 polygon 是单条闭合路径，内外环会连出一条斜边，
      //   图上会多出一条亮楔子。四块矩形没这个问题。）
      //
      // 宽度/高度必须靠 right:0 / bottom:0 锚定，不能自己算。
      // 图片按 max-height 缩放后是 933.3 × 524.9 这种小数尺寸，而 img.clientWidth/clientHeight
      // 取整（933 / 525）：算出来的暗条比图片短不到 1px，右边缘和下边缘各留一条亮线。
      const [top, bottom, left, right] = dimEl.children;
      top.style.cssText = `left:0; right:0; top:0; height:${s.y}px`;
      bottom.style.cssText = `left:0; right:0; bottom:0; top:${s.y + s.h}px`;
      left.style.cssText = `left:0; top:${s.y}px; width:${s.x}px; height:${s.h}px`;
      right.style.cssText = `right:0; top:${s.y}px; left:${s.x + s.w}px; height:${s.h}px`;
      const scale = img.naturalWidth / (img.clientWidth || 1);
      sizeEl.textContent = `裁出 ${Math.round(s.w * scale)} × ${Math.round(s.h * scale)}`;
    };

    const clampSel = () => {
      const s = cropSession.sel;
      const W = img.clientWidth, H = img.clientHeight;
      s.w = clamp(s.w, 24, W); s.h = clamp(s.h, 24, H);
      // 锁了比例就不能让宽高各自被夹：夹完再按比例收一次，否则拉出图外会变成另一个比例
      if (cropSession.ratio) {
        if (s.w / s.h > cropSession.ratio) s.w = s.h * cropSession.ratio;
        else s.h = s.w / cropSession.ratio;
      }
      s.x = clamp(s.x, 0, W - s.w); s.y = clamp(s.y, 0, H - s.h);
    };

    // 换比例：按新比例在图片里摆一个尽量大的居中框
    const applyRatio = (ratio) => {
      cropSession.ratio = ratio;
      const W = img.clientWidth, H = img.clientHeight;
      let w = W * 0.8, h = H * 0.8;
      if (ratio) {
        if (w / h > ratio) w = h * ratio; else h = w / ratio;
        if (w > W) { w = W; h = w / ratio; }
        if (h > H) { h = H; w = h * ratio; }
      }
      cropSession.sel = { x: (W - w) / 2, y: (H - h) / 2, w, h };
      draw();
    };

    img.onload = () => {
      if (!cropSession) return;
      selEl.classList.remove('hidden');
      dimEl.classList.remove('hidden');
      applyRatio(0);
    };
    img.src = n.dataURL;

    mask.onpointerdown = (ev) => { if (ev.target === mask) closeCrop(); };
    mask.querySelector('[data-act="cancel"]').onclick = () => closeCrop();
    mask.querySelector('[data-act="apply"]').onclick = () => applyCrop();
    mask.querySelectorAll('.crop-ratio').forEach((b) => {
      b.onclick = () => {
        mask.querySelectorAll('.crop-ratio').forEach((x) => x.classList.toggle('on', x === b));
        applyRatio(Number(b.dataset.ratio) || 0);
      };
    });

    // 拖动 / 拉角
    selEl.addEventListener('pointerdown', (ev) => {
      if (!cropSession || !cropSession.sel) return;
      ev.preventDefault();
      ev.stopPropagation();
      // 八个锚点：四角（nw/ne/sw/se）+ 四边中点（n/e/s/w）。空字符串＝拖整块。
      const anchor = ev.target.classList.contains('ch') ? ev.target.className.replace('ch', '').trim() : '';
      const r = stageEl.getBoundingClientRect();
      cropSession.drag = {
        anchor,
        px: ev.clientX - r.left,
        py: ev.clientY - r.top,
        start: { ...cropSession.sel },
      };
    });
    // 拖动挂在 window 上而不是选区自己身上：指针一快就跑到选区外面，
    // 只监听选区就会「拖两下就断」。用 AbortController 一次性摘干净。
    window.addEventListener('pointermove', (ev) => {
      const d = cropSession && cropSession.drag;
      if (!d) return;
      const r = stageEl.getBoundingClientRect();
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      const s0 = d.start;
      const k = d.anchor;
      if (!k) {
        cropSession.sel = { ...s0, x: s0.x + (px - d.px), y: s0.y + (py - d.py) };
        clampSel(); draw(); return;
      }
      cropSession.sel = dragCropSel(s0, k, px, py, cropSession.ratio, img.clientWidth, img.clientHeight);
      draw();
    }, { signal: cropSession.abort.signal });
    const endDrag = () => { if (cropSession) cropSession.drag = null; };
    window.addEventListener('pointerup', endDrag, { signal: cropSession.abort.signal });
    window.addEventListener('pointercancel', endDrag, { signal: cropSession.abort.signal });

    img.addEventListener('load', () => setTimeout(draw, 0));
    // 遮罩吃掉滚轮：别让背后的画布一边裁剪一边缩放
    mask.addEventListener('wheel', (ev) => ev.preventDefault(), { passive: false });
  }

  function closeCrop() {
    if (!cropSession) return;
    if (cropSession.abort) cropSession.abort.abort();
    cropSession.mask.remove();
    cropSession = null;
    updateImgTools();
  }

  function applyCrop() {
    const s = cropSession && cropSession.sel;
    if (!s) return;
    const { node: src, mask } = cropSession;
    const img = mask.querySelector('img');
    // 图没解码出来（没加载完、坏图、没有固有尺寸的 SVG）时 naturalWidth 是 0：
    // 拿它做比例会算出 0×0 的空图，直接说清楚比画一张破图好。
    if (!img.naturalWidth || !img.naturalHeight || !img.clientWidth) {
      flash('这张图还没加载完，稍等一下再裁');
      return;
    }
    const scale = img.naturalWidth / img.clientWidth;
    const sx = Math.round(s.x * scale), sy = Math.round(s.y * scale);
    const sw = Math.max(1, Math.round(s.w * scale)), sh = Math.max(1, Math.round(s.h * scale));
    const cv = document.createElement('canvas');
    cv.width = sw; cv.height = sh;
    cv.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const url = cv.toDataURL('image/png');
    closeCrop();
    const n = addImageNode(src.x + nodeWidth(src) + 60, src.y, {
      dataURL: url,
      title: `裁剪 ${sw} × ${sh}`,
    });
    selectOnly(n.id);
    flash(`已裁出 ${sw} × ${sh}，可接着连进工作流`);
  }

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    await refreshWorkflows();
    let restored = false;
    const savedPid = (() => { try { return localStorage.getItem('infisheet-project'); } catch { return null; } })();
    if (savedPid) {
      try {
        const r = await api('/api/projects/' + encodeURIComponent(savedPid));
        if (r.ok && r.canvas) { state.projectId = savedPid; restored = load(r.canvas); }
      } catch { /* 忽略 */ }
    }
    if (!restored) {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) restored = load(JSON.parse(raw));
      } catch { /* 忽略损坏快照 */ }
    }
    if (!restored) {
      try {
        const list = await api('/api/projects');
        const first = (list.items || [])[0];
        if (first) {
          const r = await api('/api/projects/' + encodeURIComponent(first.id));
          if (r.ok && r.canvas) { state.projectId = first.id; restored = load(r.canvas); }
        }
      } catch { /* 忽略 */ }
    }
    if (!restored) {
      const server = await api('/api/canvas');
      if (server.canvas) restored = load(server.canvas);
    }
    if (state.projectId) { try { localStorage.setItem('infisheet-project', state.projectId); } catch { /* noop */ } }
    applyView(); renderAll();
    applyGlobalViewPrefs();
    renderLinks();
    const mmBoot = document.getElementById('minimap');
    if (mmBoot) mmBoot.classList.toggle('hidden', !state.minimapOn);
    setViewTool('minimap', state.minimapOn);
    renderMinimap();
    state.hydrated = true;
    seedHistory();   // 启动后的画布作为撤销栈底
    lastSavedSnap = JSON.stringify(serialize());

    // 首页交互
    const newBtn = document.getElementById('newCanvas');
    if (newBtn) newBtn.onclick = () => startNewCanvas(null);
    document.querySelectorAll('[data-home-act]').forEach((b) => {
      b.onclick = () => {
        const what = b.dataset.homeAct;
        // 三件事都**就地**办完，不往画布里跳：
        // 地址是锚在页脚上的小弹层，快捷键是浮层，工作流库是盖在首页上的弹窗。
        if (what === 'comfy') { openComfyPop(b); return; }
        if (what === 'help') { document.getElementById('helpSheet').classList.toggle('hidden'); return; }
        if (what === 'workflows') { openModal(); return; }
      };
    });

    window.addEventListener('resize', () => scheduleMinimap());
    initViewTools();
    initProjectBar();
    initHelpSheet();
    initMcpSetup();
    initComfyChip();
    initServerDown();
    syncChrome();

    // 路由：#canvas 直接进编辑器，否则停在首页
    applyCanvasBg();
  if (location.hash === '#canvas') showCanvas();
    else showHome();

    health(); setInterval(health, 10000);
    setInterval(pollProjectRev, 4000);
    window.addEventListener('beforeunload', () => {
      if (!state.hydrated || !state.nodes.length) return;   // 没初始化完 / 空画布不覆盖存档
      try { localStorage.setItem(STORE_KEY, JSON.stringify(serialize())); } catch { /* noop */ }
      const url = state.projectId ? '/api/projects/' + encodeURIComponent(state.projectId) : '/api/canvas';
      fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // keepalive 这一发同样要带 baseRev：否则「关标签页」就是一次绕过版本检查的强制覆盖
        body: JSON.stringify({ canvas: serialize(), baseRev: state.projectId ? state.rev : undefined }),
        keepalive: true,
      }).catch(() => {});
    });
  })();
})();
