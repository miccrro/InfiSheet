/* Comfy 无限画布 · 前端
   节点模型：text（提示词）/ image（图片）/ wf（工作流）
   连线只允许 text→文本插槽、image→图片插槽 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const world = $('#world');
  const nodesEl = $('#nodes');
  const linksEl = $('#links');
  const STORE_KEY = 'comfy-canvas-v2';

  const state = {
    nodes: [],
    links: [],
    view: { x: 80, y: 60, k: 0.85 },
    seq: 1,
    selected: new Set(),
    linkSel: null,
    projectId: null,
    groups: [],
    workflows: { presets: [], items: [] },   // boot 时从 /api/library 拉取
    name: '未命名画布',
    snap: false,
    linksHidden: false,
    minimapOn: false,
    panMode: false,
    bootAt: Date.now(),
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

  function paintProgress(n, pct) {
    const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .node-progress`);
    if (el) {
      el.classList.add('on');
      const bar = el.querySelector('i');
      if (pct == null) {
        el.classList.add('indet');
      } else {
        el.classList.remove('indet');
        bar.style.width = `${Math.max(2, pct)}%`;
      }
    }
    // 图片中央的「生成中 42%」跟着进度走
    const ov = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .gen-overlay`);
    if (ov) {
      ov.classList.remove('hidden');
      const label = ov.querySelector('.gen-overlay-text');
      if (label) label.textContent = pct == null ? '生成中…' : `生成中 ${pct}%`;
    }
  }

  function setProgress(n, pct) { n.progress = pct; paintProgress(n, pct); }

  function finishProgress(n) {
    paintProgress(n, 100);
    n.progress = null;
    setTimeout(() => {
      const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .node-progress`);
      if (el) { el.classList.remove('on', 'indet'); el.querySelector('i').style.width = '0%'; }
    }, 700);
  }

  function clearProgress(n) {
    n.progress = null;
    const el = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .node-progress`);
    if (el) { el.classList.remove('on', 'indet'); el.querySelector('i').style.width = '0%'; }
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
    // 顶部进度条：生成/运行时显示百分比
    const prog = document.createElement('div');
    prog.className = 'node-progress';
    prog.innerHTML = '<i></i>';
    card.appendChild(prog);
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
          openLightbox(n.dataURL, (n.gen && n.gen.gallery) || null, (n.gen && n.gen.idx) || 0);
        };
        thumb.appendChild(zoom);
        thumb.ondblclick = (ev) => {
          ev.stopPropagation();
          openLightbox(n.dataURL, (n.gen && n.gen.gallery) || null, (n.gen && n.gen.idx) || 0);
        };
        const dim = document.createElement('span');
        dim.className = 'img-dim';
        thumb.appendChild(dim);
        const im = thumb.querySelector('img');
        const fit = () => {
          const w = thumb.clientWidth || 344;
          const ratio = im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : 1;
          const h = Math.round(Math.min(760, Math.max(150, w / ratio)));
          thumb.style.height = `${h}px`;
          if (im.naturalWidth) dim.textContent = `${im.naturalWidth} × ${im.naturalHeight}`;
          scheduleLayout();
        };
        if (im.complete && im.naturalWidth) requestAnimationFrame(fit);
        im.addEventListener('load', fit);
      } else {
        thumb.innerHTML = `
          <div class="thumb-empty">
            <span class="ph-big">${NODE_ICON.image}</span>
            <div class="try">
              <div class="try-label">尝试：</div>
              <button class="try-item" data-try="upload">
                ${icon('upload')}
                <span>上传图片</span>
              </button>
              <button class="try-item" data-try="generate">
                ${icon('magic')}
                <span>文本生图</span>
              </button>
            </div>
          </div>`;
        thumb.querySelector('[data-try="upload"]').onclick = (ev) => { ev.stopPropagation(); pickImage(n); };
        thumb.querySelector('[data-try="generate"]').onclick = (ev) => {
          ev.stopPropagation();
          const panel = card.parentElement.querySelector('.gen-prompt');
          if (panel) panel.focus();
        };
      }
      // 图片上的生成中遮罩：显示「生成中 42%」，进度由 websocket 的百分比驱动
      const overlay = document.createElement('div');
      overlay.className = 'gen-overlay hidden';
      overlay.innerHTML = '<span class="gen-overlay-text">生成中…</span>';
      thumb.appendChild(overlay);
      body.appendChild(thumb);

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
      card.appendChild(buildGenPanel(n));
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

  function workflowOptions() {
    const w = state.workflows || { presets: [], items: [] };
    return [
      ...w.presets.map((p) => ({ id: `preset:${p.file}`, label: p.title || p.name })),
      ...w.items.map((p) => ({ id: `lib:${p.name}`, label: `库 · ${p.name}` })),
    ];
  }

  // 生成器下拉只用内置预设：库工作流是「我的存档」，容易和模板混在一起
  function presetOptions() {
    const w = state.workflows || { presets: [], items: [] };
    return w.presets.map((p) => ({ id: `preset:${p.file}`, label: p.title || p.name }));
  }
  function defaultWorkflowId() {
    const list = presetOptions();
    let saved = '';
    try { saved = localStorage.getItem('comfy-canvas-default-wf') || ''; } catch { /* 隐私模式 */ }
    if (saved && list.some((o) => o.id === saved)) return saved;
    return list.length ? list[0].id : '';
  }

  // 工作流库变了（新增/删除/导入）就重新拉一次：
  // 否则首页「快速开始」、生成器下拉、起始页五个入口都要刷新页面才更新
  async function refreshWorkflows() {
    try {
      const lib = await api('/api/library');
      state.workflows = { presets: lib.presets || [], items: lib.items || [] };
    } catch { /* 拉不到就沿用旧值 */ }
    if (!state.nodes.length) renderCapRow();
    return state.workflows;
  }

  async function loadGraphById(id) {
    if (!id) return null;
    if (id.startsWith('preset:')) return (await api(`/presets/${encodeURIComponent(id.slice(7))}`)).graph;
    return (await api(`/api/library/${encodeURIComponent(id.slice(4))}`)).graph;
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
  const DIM_MIN = 64;
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

  function pollPrompt(pid, onTick, onDone) {
    const t0 = Date.now();
    let lostPolls = 0;
    const timer = setInterval(async () => {
      const res = await api(`/api/job?pid=${encodeURIComponent(pid)}`);
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
    wrap.classList.toggle('hidden', refs.length === 0);
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

  function insertAtCaret(el, node) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      el.appendChild(node);
      return;
    }
    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(node);
    r.setStartAfter(node);
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

  function buildGenPanel(n) {
    // 快照恢复出来的 gen 可能只有部分字段（提示词 / 工作流 / 画幅 / 张数 / 组图），这里补齐默认值
    n.gen = {
      prompt: '', wf: defaultWorkflowId(), aspect: '1:1', size: '1k', custom: null,
      batch: 1, seedMode: 'random', seed: null,
      status: '', busy: false, gallery: [], idx: 0, extras: [], ...(n.gen || {}),
    };
    const g = n.gen;
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
    panel.className = `gen-panel${g.wide ? ' wide' : ''}`;
    panel.dataset.panelFor = n.id;
    panel.onpointerdown = (ev) => ev.stopPropagation();

    const ICON = {
      upload: icon('upload'),
      grid: icon('material'),
      mark: icon('magic'),
      clear: icon('clear'),
      expand: icon('expand'),
      wf: icon('wf'),
      arrow: icon('arrowUpBold'),
    };

    // 顶部 chips
    const chips = document.createElement('div');
    chips.className = 'gen-chips';
    const mkChip = (label, icon, fn, title) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.innerHTML = `${icon}<span>${label}</span>`;
      if (title) b.title = title;
      b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      chips.appendChild(b);
      return b;
    };
    mkChip('上传', ICON.upload, () => pickImage(n), '上传本地图片到这个节点');
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
    const grow = document.createElement('span');
    grow.className = 'grow';
    chips.appendChild(grow);
    const expand = document.createElement('button');
    expand.className = 'chip icon-only';
    expand.innerHTML = ICON.expand;
    expand.title = '展开 / 收窄面板';
    expand.onclick = (ev) => {
      ev.stopPropagation();
      g.wide = !g.wide;
      panel.classList.toggle('wide', g.wide);
      queueSave();
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
        const items = list.map(([val, text]) => [text, () => {
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

    const wfBox = mkMenu(ICON.wf, () => presetOptions().map((o) => [o.id, o.label]), g.wf || defaultWorkflowId(),
      (v) => { g.wf = v; queueSave(); commit(); }, '（没有可用工作流）');
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
      const [w, h] = ratioGlyph(g.aspect, 12, 12);
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

  function refreshGenPanel(n) {
    const el = nodesEl.querySelector(`[data-panel-for="${CSS.escape(n.id)}"]`);
    if (!el) return;
    const st = el.querySelector('.gen-status');
    if (st) { st.textContent = n.gen.status || ''; st.title = n.gen.status || ''; }
    const btn = el.querySelector('.gen-run');
    if (btn) {
      btn.disabled = !!n.gen.busy;
      btn.classList.toggle('busy', !!n.gen.busy);
    }
    // 生成中：图片上盖一层「生成中 42%」
    const ov = nodesEl.querySelector(`.node[data-id="${CSS.escape(n.id)}"] .gen-overlay`);
    if (ov) {
      ov.classList.toggle('hidden', !n.gen.busy);
      if (n.gen.busy) {
        const pct = typeof n.progress === 'number' ? n.progress : null;
        const label = ov.querySelector('.gen-overlay-text');
        if (label) label.textContent = pct == null ? '生成中…' : `生成中 ${pct}%`;
      }
    }
  }

  async function generateImage(n) {
    const g = n.gen;
    if (g.busy) return;
    if (!g.wf) { flash('先在面板里选一个工作流'); return; }
    // 上游：文本当提示词；图片当参考图（也可以挂在这条文本节点上，随它一起送进来）
    const inLinks = state.links.filter((l) => l.to === n.id && l.toKey === 'in')
      .map((l) => getNode(l.from)).filter(Boolean);
    const textIn = inLinks.find((x) => x.type === 'text');
    const rawPrompt = (textIn ? (textIn.value || '') : g.prompt) || '';
    if (!rawPrompt.trim()) { flash(textIn ? '左侧文本节点是空的' : '先写提示词'); return; }
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
    g.busy = true; g.status = '准备工作流…'; refreshGenPanel(n);
    try {
      const graph = await loadGraphById(g.wf);
      if (!graph) throw new Error('工作流为空');
      const a = await postJson('/api/analyze', { graph });
      const dims = calcDims(g.aspect, g.size, g.custom);
      // 工作流能吃几张图（Qwen 编辑流是 images.image_1..4）就用几张；一张都不吃就退回纯文本，
      // 这时提示词里的 @ 引用照样摘掉——不能给模型指一张它根本没拿到的图。
      const cap = (a.slots || []).filter((s) => s.kind === 'image').length;
      const use = cap > 0 ? picked.slice(0, cap) : [];
      const prompt = refMarks(rawPrompt, use);   // @[甲] → 图1，和送进去的顺序一一对应
      if (!prompt) throw new Error('提示词里只有 @ 引用，没有文字');
      const built = buildGenGraph(graph, a.slots, dims, Number(g.batch) || 1, prompt, use.map((x) => x.name),
        { mode: g.seedMode, value: g.seed });
      const res = await postJson('/api/run', { graph: built.graph });
      if (!res.ok) throw new Error(JSON.stringify(res.error || {}).slice(0, 180));
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
      g.pid = res.prompt_id;
      g.status = `排队中 · ${dims.width}×${dims.height}${batchNote}${seedNote}${refNote}${pruneNote}${promptNote}${sizeNote}`;
      refreshGenPanel(n);
      setProgress(n, null);
      pollPrompt(res.prompt_id,
        (label, secs, p) => {
          g.status = `${label}${p == null ? '' : ' ' + p + '%'} · ${dims.width}×${dims.height}${batchNote}${seedNote}${refNote}${pruneNote}${promptNote}${sizeNote} · ${secs}s`;
          setProgress(n, p);
          refreshGenPanel(n);
        },
        async (arts, err, secs) => {
          g.busy = false;
          if (err) { clearProgress(n); g.status = `出错：${err}`; refreshGenPanel(n); return; }
          const imgs = arts.filter((x) => x.kind === 'image');
          if (!imgs.length) { clearProgress(n); g.status = `完成 · ${secs}s（无图片，检查工作流是否有保存节点）`; refreshGenPanel(n); return; }
          g.gallery = imgs.map((x) => ({ url: artifactURL(x), filename: x.filename, subfolder: x.subfolder, type: x.type }));
          g.idx = 0;
          n.dataURL = g.gallery[0].url;
          n.uploaded = null;
          g.status = `完成 · ${secs}s · ${imgs.length} 张`;
          // 面板上选了 4 张、图里只回来 1 张：这不是"多图生成坏了"，而是**图提交上去了、
          // 工作流自己把批量抹平了**（二次采样链、ImageBatch、单张后处理之类）。不吭声的话
          // 用户只会反复重试；说清楚，才知道该去改工作流还是改面板。
          const short = batchShortfall(built.batch && built.batch.value, imgs.length);
          if (short) {
            g.status = `完成 · ${secs}s · ${short.note}`;
            flash(`提交了 ${short.want} 张，只回来 ${short.got} 张：工作流里某个节点把批量并成了一路`);
          }
          finishProgress(n);
          rerenderNode(n.id, true);
          queueSave();
        });
    } catch (err) {
      g.busy = false;
      clearProgress(n);
      g.status = `失败：${err.message}`;
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
        cell.onclick = () => openLightbox(item.url, list, i);
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

  function autosaveOn() { return globalFlag('comfy-canvas-autosave', true); }

  function applyGlobalViewPrefs() {
    state.snap = globalFlag('comfy-canvas-snap', !!state.snap);
    state.linksHidden = !globalFlag('comfy-canvas-links', !state.linksHidden);
    state.minimapOn = globalFlag('comfy-canvas-minimap', !!state.minimapOn);
  }

  // ---------- 画布背景 ----------
  const CANVAS_BG_KEY = 'comfy-canvas-bg';
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
  function openSettingsSheet() {
    closeSettingsSheet();
    const box = document.createElement('div');
    box.id = 'appSettings';
    box.innerHTML = `
      <div class="sheet">
        <header><strong>全局设置</strong><button type="button" class="x" title="关闭">×</button></header>
        <div class="set-body">
          <div class="set-group">工作流</div>
          <label>默认工作流（新建图片节点 / 工作流节点时使用）
            <select id="setDefaultWf"></select>
          </label>
          <div class="set-actions">
            <button type="button" class="prime" id="setOpenLib">打开工作流库</button>
            <button type="button" id="setImportWf">导入工作流 JSON…</button>
          </div>
          <div class="set-sep"></div>
          <div class="set-group">预设 / 工作流库</div>
          <div class="set-actions">
            <button type="button" id="setAddPreset">新增预设…</button>
            <button type="button" id="setManagePreset">管理预设</button>
            <button type="button" id="setManageLibrary">管理库工作流</button>
          </div>
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
    const sel = box.querySelector('#setDefaultWf');
    presetOptions().forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      if (o.id === defaultWorkflowId()) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => {
      try { localStorage.setItem('comfy-canvas-default-wf', sel.value); } catch { /* ignore */ }
      flash('默认工作流已保存');
    };
    const snap = box.querySelector('#setSnap');
    const links = box.querySelector('#setLinks');
    const mini = box.querySelector('#setMinimap');
    const auto = box.querySelector('#setAutosave');
    snap.checked = !!state.snap;
    links.checked = !state.linksHidden;
    mini.checked = !!state.minimapOn;
    auto.checked = autosaveOn();
    snap.onchange = () => { state.snap = snap.checked; setGlobalFlag('comfy-canvas-snap', snap.checked); queueSave(); };
    links.onchange = () => {
      state.linksHidden = !links.checked;
      setGlobalFlag('comfy-canvas-links', links.checked);
      renderLinks(); queueSave();
    };
    mini.onchange = () => {
      state.minimapOn = mini.checked;
      setGlobalFlag('comfy-canvas-minimap', mini.checked);
      const mm = document.getElementById('minimap');
      if (mm) mm.classList.toggle('hidden', !state.minimapOn);
      setViewTool('minimap', state.minimapOn);
      renderMinimap(); queueSave();
    };
    auto.onchange = () => {
      setGlobalFlag('comfy-canvas-autosave', auto.checked);
      if (auto.checked) saveToServer();   // 重新打开时立刻补一次保存
      flash(auto.checked ? '已开启自动保存' : '已关闭自动保存（仍存本机）');
    };
    box.querySelector('.x').onclick = closeSettingsSheet;
    box.querySelector('#setOpenLib').onclick = () => { closeSettingsSheet(); showCanvas(); openModal(); };
    box.querySelector('#setImportWf').onclick = () => { closeSettingsSheet(); importWorkflowFile(); };
    box.querySelector('#setAddPreset').onclick = () => { closeSettingsSheet(); importPresetFile(); };
    box.querySelector('#setManagePreset').onclick = () => { closeSettingsSheet(); openModal(); switchModalTab('preset'); };
    box.querySelector('#setManageLibrary').onclick = () => { closeSettingsSheet(); openModal(); switchModalTab('library'); };
    box.querySelector('#setFit').onclick = () => { closeSettingsSheet(); fitView(); };
    box.querySelector('#setExport').onclick = () => { closeSettingsSheet(); exportCanvas(); };
    box.querySelector('#setImport').onclick = () => { closeSettingsSheet(); importCanvas(); };
    box.querySelector('#setHistory').onclick = () => { closeSettingsSheet(); openCanvasHistory(); };
    box.onclick = (ev) => { if (ev.target === box) closeSettingsSheet(); };
    document.body.appendChild(box);
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
      img.ondblclick = (ev) => { ev.stopPropagation(); openLightbox(url); };
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
  function groupBoxFor(gid) {
    const host = groupsEl();
    let box = host.querySelector(`.group[data-gid="${CSS.escape(gid)}"]`);
    if (box) return box;
    box = document.createElement('div');
    box.className = 'group';
    box.dataset.gid = gid;

    const head = document.createElement('div');
    head.className = 'group-head';
    const name = document.createElement('span');
    name.className = 'gname';
    name.title = '点击选中整组，拖动可整体移动';
    const run = document.createElement('button');
    run.textContent = '执行';
    const un = document.createElement('button');
    un.textContent = '解组';
    head.append(name, run, un);
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
      const name = box.querySelector('.gname');
      if (name) name.textContent = `${g.name} · ${members.length} 节点`;
    });
    [...host.children].forEach((el) => {
      if (!alive.has(el.dataset.gid)) el.remove();
    });
  }

  function createGroup(ids) {
    const list = [...ids].filter((id) => getNode(id));
    if (list.length < 2) { flash('先选中至少两个节点（Shift 点选），再按 Ctrl+G 打组'); return; }
    state.groups.push({ id: uid('g'), name: `分组 ${state.groups.length + 1}`, nodeIds: list });
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
    if (state.linksHidden) { linksEl.innerHTML = ''; return; }
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
  }

  function selectOnly(id) {
    state.selected = id ? new Set([id]) : new Set();
    paintSelection();
  }

  function toggleSelect(id) {
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    paintSelection();
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
    n.uploaded = res.image;
    n.subfolder = res.subfolder || '';
    // 上传成功后改用服务端地址显示：base64 不再进存档（几张图就能撑爆 localStorage 配额）
    n.dataURL = artifactURL({ filename: res.image, subfolder: n.subfolder, type: res.type || 'input' });
    queueSave();
    rerenderNode(n.id, true);
    return n.uploaded;
  }

  /* ---------------- 运行 ---------------- */
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
    rerenderNode(n.id);
    setProgress(n, null);
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
    n.timer = setInterval(async () => {
      if (n.status === 'done' || n.status === 'error') { clearInterval(n.timer); n.timer = null; return; }
      const res = await api(`/api/job?pid=${encodeURIComponent(n.pid)}`);
      if (!res.ok) {
        n.status = 'error'; n.statusText = res.error || '查询失败';
        clearInterval(n.timer); n.timer = null; rerenderNode(n.id); return;
      }
      const secs = Math.round((Date.now() - started) / 1000);
      if (res.status === 'queued' || res.status === 'running') {
        n.lostPolls = 0;
        n.status = res.status;
        n.statusText = `${res.status === 'queued' ? '排队中' : '生成中'} · ${secs}s`;
        setProgress(n, res.progress ?? null);
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
      } else if ((res.artifacts || []).length) {
        n.status = 'done'; n.artifacts = res.artifacts;
        n.statusText = `完成 · ${secs}s · ${res.artifacts.length} 个产物`;
      } else {
        n.status = 'done'; n.statusText = `完成 · ${secs}s（无产物，请确认工作流含保存节点）`;
      }
      syncOutputs(n);
      rerenderNode(n.id);
      queueSave();
    }, 1500);
  }

  async function cancelJob(n) {
    await postJson('/api/cancel', { pid: n.pid, interrupt: true });
    n.status = 'idle'; n.statusText = '已请求中断';
    if (n.timer) { clearInterval(n.timer); n.timer = null; }
    clearProgress(n);
    rerenderNode(n.id);
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

  let lbList = null;      // 大图预览里能翻的那一组
  let lbIdx = 0;
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
  }
  function openLightbox(url, list, idx) {
    lbList = Array.isArray(list) && list.length ? list : null;
    lbIdx = lbList ? Math.min(Math.max(0, idx | 0), lbList.length - 1) : 0;
    if (!lbList) $('#lightboxImg').src = url;
    paintLightbox();
    $('#lightbox').classList.remove('hidden');
  }
  function stepLightbox(delta) {
    if (!lbList || lbList.length < 2) return;
    lbIdx = ((lbIdx + delta) % lbList.length + lbList.length) % lbList.length;
    paintLightbox();
  }
  $('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');
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
    a.download = `${(state.name || 'comfy-canvas').replace(/[\\/:*?"<>|]/g, '_')}-${Date.now()}.json`;
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
      nodes: state.nodes.map((n) => ({
        id: n.id, type: n.type, title: n.title, x: n.x, y: n.y, w: n.w, h: n.h,
        value: n.value, dataURL: n.dataURL, uploaded: n.uploaded, filename: n.filename,
        graph: n.graph, slots: n.slots, outputs: n.outputs, values: n.values,
        nodeCount: n.nodeCount, unknownTypes: n.unknownTypes,
        artifacts: n.artifacts, status: 'idle', statusText: n.statusText,
        // 生成器的提示词 / 工作流 / 画幅 / 张数 / 组图要跟着画布存下来，
        // 否则刷新后图片节点只剩一张图，参数和多图切换全丢（运行态 busy/status 不存）
        gen: n.gen ? {
          prompt: n.gen.prompt, wf: n.gen.wf, aspect: n.gen.aspect, size: n.gen.size,
          custom: n.gen.custom || null,   // 自定义宽高：size==='custom' 时用它，切回档位也留着
          batch: n.gen.batch, wide: !!n.gen.wide, gallery: n.gen.gallery, idx: n.gen.idx || 0,
          // 种子：seedMode=random 时每次生成换一个，fixed 时钉住（复现某一张靠它）
          seedMode: n.gen.seedMode || 'random', seed: n.gen.seed == null ? null : n.gen.seed,
          extras: n.gen.extras || [],   // @ 引用来的图（只存节点 id，图本身还是走 /api/view）
        } : null,
      })),
    };
  }

  function load(data) {
    if (!data || !Array.isArray(data.nodes)) return false;
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
    applyView(); renderAll();
    syncChrome();
    if (beforeLinks > state.links.length) flash(`已按新结构清理 ${beforeLinks - state.links.length} 条旧连线`);
    return true;
  }

  let lastSavedSnap = '';

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
        body: JSON.stringify({ canvas: JSON.parse(snap) }),
      });
      if (!res.ok) throw new Error(res.error || '保存失败');
      if (res.stale) { setSaveState('有新版本，未覆盖'); return; }
      lastSavedSnap = snap;
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      setSaveState('已保存 ' + hh + ':' + mm);
    } catch {
      setSaveState('保存失败');
    }
  }

  function queueSave() {
    if (!state.hydrated) return;
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

  async function openModal() {
    $('#modal').classList.remove('hidden');
    await refreshWorkflows();                 // 打开时重新拉库，别显示开局时的旧列表
    renderPresets(state.workflows.presets);
    renderLibrary(state.workflows.items);
    renderHistory();
  }

  function renderPresets(list) {
    const pane = $('#pane-preset');
    pane.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'pane-bar';
    const addBtn = document.createElement('button');
    addBtn.className = 'primary';
    addBtn.textContent = '＋ 新增预设';
    addBtn.onclick = () => addPresetMenu(addBtn);
    const tipEl = document.createElement('span');
    tipEl.className = 'tip';
    tipEl.textContent = '预设存到 comfy-canvas/presets/，重开也还在';
    bar.append(addBtn, tipEl);
    pane.appendChild(bar);
    const box = document.createElement('div');
    box.className = 'list';
    if (!list.length) box.innerHTML = '<p class="tip">presets 目录为空。</p>';
    list.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="info"><b>${esc(p.title || p.name)}</b><span>${p.nodes} 个节点 · presets/${esc(p.file)}</span></div><button class="primary">使用</button>`;
      const delBtn = document.createElement('button');
      delBtn.className = 'del';
      delBtn.textContent = '删除';
      delBtn.title = '删除这个预设';
      delBtn.onclick = (ev) => { ev.stopPropagation(); deletePreset(p.file, p.title || p.name); };
      card.appendChild(delBtn);
      card.onclick = async () => {
        const res = await api(`/presets/${encodeURIComponent(p.file)}`);
        await useGraph(res.graph, p.title || p.name);
      };
      box.appendChild(card);
    });
    pane.appendChild(box);
  }

  function addPresetMenu(anchor) {
    openPopMenu(anchor, [
      ['从 JSON 文件导入…', () => { flash('选择一份工作流 JSON（API 或界面格式）'); importPresetFile(); }],
      ['把当前默认工作流存为预设', () => saveDefaultAsPreset()],
    ], '新增内置预设');
  }

  async function savePreset(title, graph, note) {
    if (!title) return null;
    const res = await api('/api/presets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, note: note || '', graph }),
    });
    if (!res.ok) {
      flash(/接口不存在|404/.test(res.error || '') ? '服务端太旧：重启 python server.py 后重试' : (res.error || '保存预设失败'));
      return null;
    }
    await refreshWorkflows();
    openModal();
    flash('已新增预设：' + title);
    return res;
  }

  function importPresetFile() {
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
      const graph = extractApiGraph(data) || (data && data.graph) || (data && Array.isArray(data.nodes) ? data : null);
      if (!graph) { flash('没有识别到工作流（API 图或界面格式都行）'); return; }
      const defTitle = (data.title || data.name || f.name.replace(/\.json$/i, '')).slice(0, 40);
      const title = prompt('预设名称', defTitle);
      if (!title) return;
      await savePreset(title, graph, data.note || '');
    };
    inp.click();
  }

  async function saveDefaultAsPreset() {
    const id = defaultWorkflowId();
    if (!id) { flash('还没有默认工作流，先导入一个'); return; }
    const graph = await loadGraphById(id);
    if (!graph) { flash('读取默认工作流失败'); return; }
    const opt = presetOptions().find((o) => o.id === id);
    const title = prompt('预设名称', (opt && opt.label) || '新预设');
    if (!title) return;
    await savePreset(title, graph, '');
  }

  async function deletePreset(file, title) {
    if (!confirm('删除预设「' + (title || file) + '」？此操作不可恢复。')) return;
    const res = await api('/api/presets/' + encodeURIComponent(file), { method: 'DELETE' });
    if (!res.ok) { flash(res.error || '删除失败'); return; }
    try {
      if (localStorage.getItem('comfy-canvas-default-wf') === 'preset:' + file) {
        localStorage.removeItem('comfy-canvas-default-wf');
      }
    } catch { /* noop */ }
    await refreshWorkflows();
    // 正在用这个预设的图片节点回落到第一个可用预设
    state.nodes.forEach((nd) => {
      if (nd.gen && nd.gen.wf === 'preset:' + file) {
        nd.gen.wf = defaultWorkflowId();
        rerenderNode(nd.id, true);
      }
    });
    openModal();
    flash('已删除预设：' + (title || file));
  }

  function renderLibrary(items) {
    const pane = $('#pane-library');
    pane.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'list';
    if (!items.length) box.innerHTML = '<p class="tip">还没有保存过工作流。在画布上的工作流节点里点「存入工作流库」。</p>';
    items.forEach((it) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="info"><b>${esc(it.name)}</b><span>${it.nodes} 个节点 · ${esc(it.saved_at || '')}</span></div><button class="del">删除</button>`;
      card.onclick = async (ev) => {
        if (ev.target.classList.contains('del')) {
          ev.stopPropagation();
          await api(`/api/library/${encodeURIComponent(it.name)}`, { method: 'DELETE' });
          openModal(); return;
        }
        const res = await api(`/api/library/${encodeURIComponent(it.name)}`);
        await useGraph(res.graph, it.name);
      };
      box.appendChild(card);
    });
    pane.appendChild(box);
  }

  async function renderHistory() {
    const pane = $('#pane-history');
    pane.innerHTML = '<p class="tip">读取中…</p>';
    const res = await api('/api/history?limit=15');
    const list = (res.entries || []).filter((e) => e.has_graph);
    pane.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'list';
    if (!list.length) {
      box.innerHTML = '<p class="tip">ComfyUI 里还没有带 API 图的运行记录。先在 ComfyUI 里跑一次任意工作流，这里就能抓到它的 API 图。</p>';
    }
    list.forEach((e) => {
      const card = document.createElement('div');
      card.className = 'card';
      const thumb = (e.artifacts || []).find((a) => a.kind === 'image');
      card.innerHTML = `<div class="info"><b>${esc(e.prompt_id.slice(0, 12))}</b><span>${e.node_count} 个节点 · ${e.artifacts.length} 个产物</span></div>`;
      if (thumb) {
        const img = document.createElement('img');
        img.src = artifactURL(thumb);
        img.style.cssText = 'width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid #2e333d';
        card.appendChild(img);
      }
      card.onclick = async () => {
        // 列表里已经带了 API 图（history_summary 一并返回），不用再拉一次全量
        if (e.graph) await useGraph(e.graph, `历史 ${e.prompt_id.slice(0, 8)}`);
        else flash('该记录没有 API 图');
      };
      box.appendChild(card);
    });
    pane.appendChild(box);
  }

  async function useGraph(graph, title) {
    if (!graph) { flash('该记录没有 API 图'); return; }
    $('#modal').classList.add('hidden');
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
    if (act === 'add-workflow') { showCanvas(); openModal(); switchModalTab('paste'); return; }
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
    addMenu.innerHTML = '';
    const items = [
      ['提示词', () => addTextNode(p.x - 140, p.y - 60)],
      ['图片', () => addImageNode(p.x - 125, p.y - 60)],
      ['工作流…', () => openModal()],
      ['导入工作流…', () => { openModal(); switchModalTab('paste'); }],
      ['图片输出', () => addOutNode(p.x - 150, p.y - 60)],
    ];
    items.forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { closeAddMenu(); fn(); };
      addMenu.appendChild(b);
    });
    const r = stage.getBoundingClientRect();
    addMenu.classList.remove('hidden');        // 先显示才能量到真实尺寸
    const mw = addMenu.offsetWidth;
    const mh = addMenu.offsetHeight;
    const margin = 8;
    let left = clientX - r.left;
    let top = clientY - r.top;
    if (left + mw > r.width - margin) left = r.width - mw - margin;
    if (left < margin) left = margin;
    if (openAbove || top + mh > r.height - margin) top = top - mh - 8;   // 放不下（或从工具条点开）就翻到上面
    if (top < margin) top = margin;
    addMenu.style.left = left + 'px';
    addMenu.style.top = top + 'px';
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

  async function addImageFromFile(file, x, y) {
    const n = addImageNode(x, y, { title: '图片' }, true);
    n.filename = file.name;
    n.dataURL = await readDataURL(file);
    rerenderNode(n.id);
    try { await ensureUploaded(n); } catch (err) { flash(err.message); }
    commit();
    return n;
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
      await addImageFromFile(f, p.x + i * 30, p.y + i * 30);
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
        $('#lightbox').classList.add('hidden');
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
    }
  });

  $('#modalClose').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').addEventListener('click', (ev) => {
    if (ev.target.id === 'modal') $('#modal').classList.add('hidden');
  });
  document.querySelectorAll('#modalTabs .tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('#modalTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      ['preset', 'library', 'history', 'paste'].forEach((name) => {
        $(`#pane-${name}`).classList.toggle('hidden', name !== tab.dataset.tab);
      });
    };
  });
  $('#pasteGo').onclick = async () => {
    const raw = $('#pasteBox').value.trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const graph = parsed.graph || parsed;
      await useGraph(graph, `粘贴 ${Object.keys(graph).length} 节点`);
    } catch (e) { flash(`JSON 解析失败：${e.message}`); }
  };
  $('#filePick').onchange = async () => {
    const f = $('#filePick').files && $('#filePick').files[0];
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      await useGraph(parsed.graph || parsed, f.name.replace(/\.json$/i, ''));
    } catch (e) { flash(`文件解析失败：${e.message}`); }
  };

  /* ---------------- 健康检查 ---------------- */
  async function health() {
    const res = await api('/api/health');
    // 旧服务端没有新接口：提示重启，否则「新增预设」会静默 404
    if (!Array.isArray(res.features) || !res.features.includes('presets')) {
      if (!health._warned) {
        health._warned = true;
        flash('服务端是旧版本：重启 python server.py 后「新增预设」才可用');
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
  function scheduleLayout() {
    if (layoutPending) return;
    layoutPending = true;
    requestAnimationFrame(() => {
      layoutPending = false;
      renderLinks();
      renderGroups();
      renderMinimap();
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
      if (anchor && anchor.contains(t)) return;           // 点锚点：交给按钮自己开关
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
        document.title = `${inp.value || 'Comfy 无限画布'}`;
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
    document.title = state.name || 'Comfy 无限画布';
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
    await refreshWorkflows();               // 每次回首页都对一次库，避免显示过期卡片
    const quick = document.getElementById('quickStart');
    if (quick) {
      quick.innerHTML = '';
      const presets = (state.workflows && state.workflows.presets) || [];
      const items = (state.workflows && state.workflows.items) || [];
      const cards = [{ id: '', title: '空白画布', desc: '从零开始，自己搭节点' }]
        .concat(presets.map((p) => ({ id: `preset:${p.file}`, title: p.title || p.name, desc: `${p.nodes} 个节点 · 内置预设` })))
        .concat(items.map((p) => ({ id: `lib:${p.name}`, title: p.name, desc: `${p.nodes} 个节点 · 我的工作流库` })));
      cards.forEach((c) => {
        const b = document.createElement('button');
        b.className = 'quick-card';
        b.innerHTML = `<b>${esc(c.title)}</b><span>${esc(c.desc)}</span>`;
        b.onclick = () => startNewCanvas(c.id || null);
        quick.appendChild(b);
      });
    }

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
    try { localStorage.setItem('comfy-canvas-project', res.id); } catch { /* noop */ }
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
    try { localStorage.setItem('comfy-canvas-project', id); } catch { /* noop */ }
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
      try { localStorage.removeItem('comfy-canvas-project'); } catch { /* noop */ }
    }
    initHome();
  }
  /* ---------------- 启动 ---------------- */
  (async function boot() {
    await refreshWorkflows();
    let restored = false;
    const savedPid = (() => { try { return localStorage.getItem('comfy-canvas-project'); } catch { return null; } })();
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
    if (state.projectId) { try { localStorage.setItem('comfy-canvas-project', state.projectId); } catch { /* noop */ } }
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
        if (what === 'help') { showCanvas(); flash('拖空白平移 · 滚轮缩放 · 双击空白建节点 · Shift 框选 · Ctrl+G 打组'); }
        if (what === 'workflows') { showCanvas(); openModal(); }
      };
    });

    window.addEventListener('resize', () => scheduleMinimap());
    initViewTools();
    initProjectBar();
    initHelpSheet();
    syncChrome();

    // 路由：#canvas 直接进编辑器，否则停在首页
    applyCanvasBg();
  if (location.hash === '#canvas') showCanvas();
    else showHome();

    health(); setInterval(health, 10000);
    window.addEventListener('beforeunload', () => {
      if (!state.hydrated || !state.nodes.length) return;   // 没初始化完 / 空画布不覆盖存档
      try { localStorage.setItem(STORE_KEY, JSON.stringify(serialize())); } catch { /* noop */ }
      const url = state.projectId ? '/api/projects/' + encodeURIComponent(state.projectId) : '/api/canvas';
      fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvas: serialize() }), keepalive: true,
      }).catch(() => {});
    });
  })();
})();
