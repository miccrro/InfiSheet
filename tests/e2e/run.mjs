#!/usr/bin/env node
/**
 * e2e 冒烟：起隔离 server → 开 headless Chrome → 按真实交互走一遍关键路径 → 断言。
 * 不依赖 ComfyUI（不出图），也不碰你的 data/。
 *
 *   npm run test:e2e            # 默认 headless
 *   HEADED=1 npm run test:e2e   # 想看着它跑
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, newPage, stopChrome } from './cdp.mjs';
import { E2E_DIR, ROOT, TMP, freePort, makeDataDir, seedProject, startServer, rmDir } from './lib/server.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const headed = process.env.HEADED === '1';
const dataDir = makeDataDir();
const projId = seedProject(dataDir);
const port = await freePort();
// 租约调到 3 秒：下面要验「心跳停了灯自己变灰」，真等 30 秒太慢
const server = await startServer({ port, dataDir, extraArgs: ['--mcp-lease', '3'] });
let chromeCtx = null;
let page = null;

try {
  const health = await (await fetch(server.base + 'api/health')).json();
  check('server 起来且 /api/health 正常', health.ok === true, `comfy=${health.comfy}`);

  // ---- 提交前裁掉工作流自带的残留图 ----
  // 这段是纯 Node：不需要 Chrome，也不需要 ComfyUI。实现从 app.js 里按函数名抠出来跑，
  // 测的是真正上线的那份代码（复制一份到测试里迟早会跟实现跑偏）。
  const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'app.js'), 'utf8');
  function pickFn(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`app.js 里没有 ${name}`);
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      const ch = src[j];
      if (ch === '"' || ch === "'" || ch === '`') {          // 跳过字符串，别把里面的括号数进去
        for (j++; j < src.length && src[j] !== ch; j++) if (src[j] === '\\') j++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error(`${name} 的括号没闭合`);
  }
  const { buildGenGraph, dimsTarget, promptPlan, planSeed, refMarks, batchShortfall } = new Function(
    `${pickFn(appSrc, 'bindRefImages')}\n${pickFn(appSrc, 'dimsTarget')}\n${pickFn(appSrc, 'promptPlan')}\n${pickFn(appSrc, 'planSeed')}\n${pickFn(appSrc, 'batchShortfall')}\n${pickFn(appSrc, 'refMarks')}\n${pickFn(appSrc, 'buildGenGraph')}\nreturn { buildGenGraph, dimsTarget, promptPlan, planSeed, refMarks, batchShortfall, bindRefImages };`)();

  // 生成历史的存档逻辑：上限 30 条、旧档兼容。这两件事在浏览器里造不出来（要真跑 35 次生成），
  // 所以在 Node 里直接验；测的仍然是 app.js 里那份实现。
  const { runsOf, pushRun } = new Function(
    `const RUN_CAP = 30;\n${pickFn(appSrc, 'ensureRuns')}\n${pickFn(appSrc, 'dedupeRuns')}\n${pickFn(appSrc, 'runsOf')}\n${pickFn(appSrc, 'pushRun')}\nreturn { runsOf, pushRun };`)();
  const noGenNode = { id: 'x', type: 'image', gen: null };
  const legacyNode = { id: 'y', type: 'image', gen: { prompt: '旧画布', seed: 5, batch: 2, gallery: [{ url: 'a' }] } };
  const manyNode = { id: 'z', type: 'image', gen: { runs: [] } };
  for (let i = 0; i < 35; i++) pushRun(manyNode, { at: i, prompt: 'p' + i, items: [] });
  check('生成历史：没有 gen 的节点不会炸', runsOf(noGenNode).length === 0);
  check('生成历史：旧存档只有 gallery 时合成一条「更早」（不是显示 0 次）',
    runsOf(legacyNode).length === 1 && runsOf(legacyNode)[0].legacy === true
      && runsOf(legacyNode)[0].items.length === 1);
  check('生成历史：超过 30 条丢最旧的，新的排最前',
    runsOf(manyNode).length === 30 && runsOf(manyNode)[0].prompt === 'p34'
      && runsOf(manyNode)[29].prompt === 'p5', `${runsOf(manyNode).length} 条`);

  // 生成队列的文案层：面板渲染要 DOM，而「3 个任务同时在跑」这种场景在浏览器里造不出来
  // （得真往 ComfyUI 提交），所以把汇总/条目文案做成纯函数，在这里验。
  const { queueSummary, jobPhaseText, jobMetaText } = new Function(
    `${pickFn(appSrc, 'pctText')}\n${pickFn(appSrc, 'jobPhaseText')}\n${pickFn(appSrc, 'jobMetaText')}\n${pickFn(appSrc, 'queueSummary')}\nreturn { queueSummary, jobPhaseText, jobMetaText };`)();
  const qEmpty = queueSummary([]);
  const qMix = queueSummary([{ phase: 'running' }, { phase: 'queued' }, { phase: 'done' }, { phase: 'error' }]);
  check('队列汇总：空表给一句「还没有任务」，混着时按状态分类计数',
    qEmpty.live === 0 && qEmpty.text === '还没有任务'
    && qMix.live === 2 && qMix.text === '2 个进行中 · 1 个完成 · 1 个失败', qMix.text);
  check('队列条目：生成中带百分比，没进度就不编一个数字',
    jobPhaseText({ phase: 'running', progress: 42 }) === '生成中 42%'
    && jobPhaseText({ phase: 'running', progress: null }) === '生成中'
    && jobPhaseText({ phase: 'running', progress: 0 }) === '生成中'   // 0% 还没走完第一步
    && jobPhaseText({ phase: 'canceled' }) === '已取消');
  check('队列条目：尺寸 / 耗时 / 取消原因 / 工作流名都能挂上去',
    jobMetaText({ phase: 'running', progress: 42, dims: '1024×1024', secs: 12, wf: 'krea2-txt2img' })
      === '生成中 42% · 1024×1024 · 12s · krea2-txt2img'
    && jobMetaText({ phase: 'canceled', note: '已中断' }) === '已取消 · 已中断',
    jobMetaText({ phase: 'running', progress: 42, dims: '1024×1024', secs: 12, wf: 'krea2-txt2img' }));

  // 图片中央那层「生成中 42%」：文案层同样是纯函数。三个状态要分得清——
  // 队列里排着、正在跑但还没有步数、拿到步数了。以前三种都写「生成中…」。
  const { genOverlayText } = new Function(
    `${pickFn(appSrc, 'genOverlayText')}\nreturn { genOverlayText };`)();
  const ovQueued = genOverlayText({ progress: null, gen: { job: { phase: 'queued' } } });
  const ovRunning = genOverlayText({ progress: null, gen: { job: { phase: 'running' } } });
  const ovZero = genOverlayText({ progress: 0, gen: { job: { phase: 'running' } } });
  const ovPct = genOverlayText({ progress: 42, gen: { job: { phase: 'running' } } });
  const ovDone = genOverlayText({ progress: 42 }, 100);      // finishProgress 传的是 100，不是旧值
  check('图片上的进度层：排队 / 等步数 / 有百分比 三种文案分开（0% 不报数）',
    ovQueued === '排队中…' && ovRunning === '生成中…' && ovZero === '生成中…'
      && ovPct === '生成中 42%' && ovDone === '生成中 100%',
    `${ovQueued} / ${ovRunning} / ${ovZero} / ${ovPct} / ${ovDone}`);

  // 风格库：模板套提示词是纯字符串处理，浏览器里点一遍看不出「{prompt} 换没换对」
  // （发出去的是 400 字英文，谁也不会去页面上核对），所以在这里直接验实现。
  const { applyStylePrompt } = new Function(
    `${pickFn(appSrc, 'applyStylePrompt')}\nreturn { applyStylePrompt };`)();
  const tplStyle = { prompt: 'Style: soft watercolor shading. Influenced by: Miyazaki. Subject:{prompt}' };
  const s1 = applyStylePrompt('一只猫在屋顶', tplStyle);
  check('风格：{prompt} 被主体替换，风格句在主体前面',
    s1 === 'Style: soft watercolor shading. Influenced by: Miyazaki. Subject:一只猫在屋顶', s1);
  const s2 = applyStylePrompt('', tplStyle);
  check('风格：没写主体时把「Subject:」整段摘掉，不留悬空冒号',
    s2 === 'Style: soft watercolor shading. Influenced by: Miyazaki.', s2);
  const s3 = applyStylePrompt('  多  余  空 格  ', tplStyle);
  check('风格：主体两端空白裁掉，中间的原文一个字不动',
    s3.endsWith('Subject:多  余  空 格'), s3);
  check('风格：模板没有 {prompt} 时串在原文前面（宁可多一句，不能把用户的词吞了）',
    applyStylePrompt('主体', { prompt: 'No placeholder' }) === 'No placeholder 主体'
    && applyStylePrompt('主体', { prompt: '' }) === '主体'
    && applyStylePrompt('主体', null) === '主体');

  // 运行记录的「详情」是纯逻辑：从 /history 的 API 图里挖提示词和采样参数。
  // 这段在 Node 里直接验——CI 没有 ComfyUI，浏览器里造不出历史记录。
  const { historyMeta } = new Function(`${pickFn(appSrc, 'historyMeta')}\nreturn { historyMeta };`)();
  const histEntry = {
    graph: {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, a cat on a windowsill, soft light', clip: ['2', 0] } },
      '2': { class_type: 'CLIPLoader', inputs: {} },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality, blurry', clip: ['2', 0] } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 1024, batch_size: 1 } },
      '5': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, cfg: 4.5, sampler_name: 'euler',
        positive: ['1', 0], negative: ['3', 0], latent_image: ['4', 0] } },
    },
    artifacts: [{ kind: 'image' }, { kind: 'image' }],
  };
  const hm = historyMeta(histEntry);
  const rowOf = (rows, k) => (rows.find(([a]) => a === k) || [])[1];
  check('运行记录详情：提示词取正向那句（负面词被 KSampler.negative 排掉）',
    hm.prompt === 'masterpiece, a cat on a windowsill, soft light', hm.prompt);
  check('运行记录详情：参数取到步数 / CFG / 采样器 / 种子 / 尺寸 / 节点数',
    rowOf(hm.rows, '采样') === '20 步 · CFG 4.5 · euler' && rowOf(hm.rows, '种子') === '42'
      && rowOf(hm.rows, '尺寸') === '768 × 1024' && rowOf(hm.rows, '节点') === '5 个'
      && rowOf(hm.rows, '产物') === '2 个',
    JSON.stringify(hm.rows));

  // Qwen-image-2.1 编辑流的真实结构：4 个 LoadImage 挤在同一个 images.image_N 组里。
  // 后 3 张是导出者本地的 023.jpg，用户看不见却参与条件编码。
  const qwenGraph = {
    '489': { class_type: 'LoadImage', inputs: { image: 'Krea2_turbo_00483_.png' } },
    '502': { class_type: 'LoadImage', inputs: { image: '023.jpg' } },
    '503': { class_type: 'LoadImage', inputs: { image: '023.jpg' } },
    '504': { class_type: 'LoadImage', inputs: { image: '023.jpg' } },
    '487': {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        prompt: '图一的人物戴着图二的耳机听音乐', negative_prompt: '', resolution: 1024,
        'images.image_1': ['489', 0], 'images.image_2': ['502', 0],
        'images.image_3': ['503', 0], 'images.image_4': ['504', 0],
      },
    },
  };
  const imgSlot = (id, value) => ({ kind: 'image', key: `${id}.image`, node: id, input: 'image', value });
  const qwenSlots = [imgSlot('489', 'Krea2_turbo_00483_.png'), imgSlot('502', '023.jpg'),
    imgSlot('503', '023.jpg'), imgSlot('504', '023.jpg'),
    // 服务端排序保证 prompt 排在 negative_prompt 前面，前端才敢无脑取 texts[0]
    { kind: 'text', key: '487.prompt', node: '487', input: 'prompt', value: '图一的人物戴着图二的耳机听音乐' },
    { kind: 'text', key: '487.negative_prompt', node: '487', input: 'negative_prompt', value: '' }];
  const bound = buildGenGraph(qwenGraph, qwenSlots, { width: 1024, height: 1024 }, 1, '把背景换成雪夜', 'canvas-ref.png');
  const keptKeys = Object.keys(bound.graph['487'].inputs).filter((k) => k.startsWith('images.'));
  check('只留画布绑定的那一张，其余残留图从下游断开',
    bound.pruned.length === 3 && keptKeys.join('|') === 'images.image_1' && bound.graph['489'].inputs.image === 'canvas-ref.png',
    `pruned=${bound.pruned.length} kept=${keptKeys.join(',')} image_1=${bound.graph['489'].inputs.image}`);
  check('断开后的孤儿 LoadImage 整颗摘掉（否则本地文件名不在 input/ 就 400）',
    !bound.graph['502'] && !bound.graph['503'] && !bound.graph['504'] && !!bound.graph['489'],
    Object.keys(bound.graph).join(','));
  check('提示词写进正向而不是负面', bound.graph['487'].inputs.prompt === '把背景换成雪夜'
    && bound.graph['487'].inputs.negative_prompt === '', JSON.stringify(bound.graph['487'].inputs.prompt));

  // 裁剪的八个锚点：拖拽几何在 Node 里直接验——真实拖拽要几十次指针事件，
  // 还容易被亚像素吃掉（夹具里的图只有 16×16，1px 都数不出来）。
  const { dragCropSel } = new Function(
    'const clamp = (v, a, b) => Math.min(b, Math.max(a, v));\n'
    + `${pickFn(appSrc, 'dragCropSel')}\nreturn { dragCropSel };`,
  )();
  const box0 = { x: 100, y: 80, w: 400, h: 300 };
  const dE = dragCropSel(box0, 'e', 540, 200, 0, 1000, 800);
  check('拉右边中点 → 只变宽，高和左边界一动不动',
    dE.w === 440 && dE.h === 300 && dE.x === 100 && dE.y === 80, JSON.stringify(dE));
  const dS = dragCropSel(box0, 's', 300, 420, 0, 1000, 800);
  check('拉下边中点 → 只变高，宽和上边界一动不动',
    dS.h === 340 && dS.w === 400 && dS.y === 80 && dS.x === 100, JSON.stringify(dS));
  const dW = dragCropSel(box0, 'w', 60, 200, 0, 1000, 800);
  check('拉左边中点 → 右边钉住，宽变大 x 跟着左移', dW.w === 440 && dW.x === 60 && dW.h === 300, JSON.stringify(dW));
  const dN = dragCropSel(box0, 'n', 300, 40, 0, 1000, 800);
  check('拉上边中点 → 下边钉住，高变大 y 跟着上移', dN.h === 340 && dN.y === 40 && dN.w === 400, JSON.stringify(dN));
  const dNW = dragCropSel(box0, 'nw', 60, 40, 0, 1000, 800);
  check('拉左上角 → 右下角钉死（x+w / y+h 都不变）',
    dNW.x === 60 && dNW.y === 40 && dNW.x + dNW.w === 500 && dNW.y + dNW.h === 380, JSON.stringify(dNW));
  const dE1 = dragCropSel(box0, 'e', 540, 200, 1, 1000, 800);
  check('锁 1:1 拉右边 → 高跟着宽走，竖直方向以中线为轴',
    dE1.w === 440 && dE1.h === 440 && Math.abs((dE1.y + dE1.h / 2) - 230) <= 0.5, JSON.stringify(dE1));
  const dS1 = dragCropSel(box0, 's', 300, 420, 1, 1000, 800);
  check('锁 1:1 拉下边 → 宽跟着高走，水平方向以中线为轴',
    dS1.h === 340 && dS1.w === 340 && Math.abs((dS1.x + dS1.w / 2) - 300) <= 0.5, JSON.stringify(dS1));
  const dOut = dragCropSel(box0, 'e', 5000, 200, 0, 1000, 800);
  check('往图外拖 → 收在图内，不会跑到画面外面去',
    dOut.x + dOut.w <= 1000 && dOut.w === 900, JSON.stringify(dOut));


  const noRef = buildGenGraph(qwenGraph, qwenSlots, { width: 1024, height: 1024 }, 1, 'x', null);
  check('画布没给图就一张都不动（必填组不能拆空）',
    noRef.pruned.length === 0 && Object.keys(noRef.graph).length === 5
    && ['images.image_1', 'images.image_2', 'images.image_3', 'images.image_4']
      .every((k) => k in noRef.graph['487'].inputs), `nodes=${Object.keys(noRef.graph).length}`);

  const single = buildGenGraph({
    '11': { class_type: 'LoadImage', inputs: { image: 'only.png' } },
    '12': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'p', 'images.image_1': ['11', 0] } },
  }, [imgSlot('11', 'only.png')], { width: 512, height: 512 }, 1, 'hello', 'canvas.png');
  check('单图工作流原样保留，只把画布图填进去',
    single.pruned.length === 0 && single.graph['12'].inputs['images.image_1'][0] === '11'
    && single.graph['11'].inputs.image === 'canvas.png', JSON.stringify(single.pruned));

  // ---- 多图：Qwen 编辑流的 images.image_1..4 能吃好几张 ----
  // 画布给了 3 张就按顺序填 image_1/2/3，第 4 个槽断开——顺序错了「图2」就指到别的图上。
  const multi = buildGenGraph(qwenGraph, qwenSlots, { width: 1024, height: 1024 }, 1, '把图1的人物放进图2的场景，参考图3的光',
    ['a.png', 'b.png', 'c.png']);
  check('三张参考图按 image_1..3 顺序落位，第 4 个槽断开',
    multi.graph['489'].inputs.image === 'a.png' && multi.graph['502'].inputs.image === 'b.png'
    && multi.graph['503'].inputs.image === 'c.png' && !('images.image_4' in multi.graph['487'].inputs)
    && !multi.graph['504'] && multi.refs.count === 3,
    `1=${multi.graph['489'].inputs.image} 2=${multi.graph['502'].inputs.image} 3=${multi.graph['503'].inputs.image} n=${multi.refs.count}`);
  check('多图数量超过插槽数时，多出来的直接忽略（不做静默替换）',
    (() => {
      const five = buildGenGraph(qwenGraph, qwenSlots, { width: 1024, height: 1024 }, 1, 'p',
        ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
      return five.refs.count === 4 && five.graph['504'].inputs.image === 'd.png'
        && Object.keys(five.graph['487'].inputs).filter((k) => k.startsWith('images.')).length === 4;
    })(), '五张只吃四张');

  // ---- @[名字] 不能一删了之 ----
  // 删掉会变成「把 的人物放进 的场景」，模型连句意都没了，更别说认图。
  const marks = (text, refs) => refMarks(text, refs.map((label) => ({ label })));
  check('@[甲] / @[乙] 换成「图1」「图2」，句子不断裂',
    marks('把 @[参考图甲] 的人物放进 @[参考图乙] 的场景', ['参考图甲', '参考图乙'])
      === '把 图1 的人物放进 图2 的场景',
    marks('把 @[参考图甲] 的人物放进 @[参考图乙] 的场景', ['参考图甲', '参考图乙']));
  check('紧贴汉字的引用也对得上（@[甲]的人物 → 图1的人物）',
    marks('@[参考图甲]的人物抱着@[参考图乙]', ['参考图甲', '参考图乙']) === '图1的人物抱着图2',
    marks('@[参考图甲]的人物抱着@[参考图乙]', ['参考图甲', '参考图乙']));
  check('没被送进工作流的引用仍然删掉（别让模型找一张它没有的图）',
    marks('把 @[参考图甲] 和 @[参考图丙] 混在一起', ['参考图甲']) === '把 图1 和 混在一起',
    marks('把 @[参考图甲] 和 @[参考图丙] 混在一起', ['参考图甲']));
  check('同一张图被引用两次，仍是同一个编号',
    marks('@[参考图甲] 和 @[参考图甲]', ['参考图甲']) === '图1 和 图1',
    marks('@[参考图甲] 和 @[参考图甲]', ['参考图甲']));

  // ---- generateImage 的接线（纯函数测不到的那一段）----
  // 函数本身是 async + 依赖一堆 DOM/状态，跑不起来；但「只取第一张」「把标记删掉」这两个
  // 回归点都能从源码里读出来——它们正是用户报「@ 图识别不准」的两个根因，必须挡住。
  const genSrc = pickFn(appSrc, 'generateImage');
  check('生成时把参考图全部上传，不再只取第一张',
    !/refsOf\(n\)\s*\[0\]/.test(genSrc) && /slice\(0,\s*cap\)/.test(genSrc)
    // 拼给模型的那句话必须过 refMarks：变量名可能是 rawPrompt（没套风格）或 promptText（套了）
    && /refMarks\((?:promptText|rawPrompt)\b/.test(genSrc),
    /refsOf\(n\)\s*\[0\]/.test(genSrc) ? '还在取 [0]' : 'ok');
  check('@[名字] 改成「图N」而不是整段删掉（全库无 stripRefTokens）',
    !/stripRefTokens/.test(appSrc) && /function refMarks\(/.test(appSrc));

  // 宽高是连线时（图生图 / 风格类工作流都这样），按插槽名一个也找不到，面板上选的尺寸等于白选。
  // dimsTarget 顺着 KSampler.latent_image 往上揪出那个真正决定出图尺寸的节点。
  const linked = {
    '13': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 2, multiple: 8 } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: ['13', 0], height: ['13', 1], batch_size: 1 } },
    '3': { class_type: 'KSampler', inputs: { seed: 1, latent_image: ['5', 0] } },
  };
  const linkedOut = buildGenGraph(linked, [], { width: 1280, height: 720 }, 2, 'p', null);
  check('宽高是连线时也钉得住：连线换成字面量',
    linkedOut.sized === true && linkedOut.graph['5'].inputs.width === 1280
    && linkedOut.graph['5'].inputs.height === 720 && linkedOut.graph['5'].inputs.batch_size === 2,
    JSON.stringify({ sized: linkedOut.sized, w: linkedOut.graph['5'].inputs.width, h: linkedOut.graph['5'].inputs.height }));

  const noSize = buildGenGraph({ '3': { class_type: 'KSampler', inputs: { seed: 1 } } }, [], { width: 768, height: 768 }, 1, 'p', null);
  check('压根没有宽高输入的工作流如实报 sized=false（前端据此提示「尺寸由工作流决定」）',
    noSize.sized === false);

  // 「张数」有没有真的落进图里：面板上选 4 张、工作流却没有批量插槽时，只出 1 张还不吭声，
  // 用户只会觉得「多图生成坏了」。所以 buildGenGraph 必须如实报 applied。
  check('张数写进 latent 的 batch_size，并如实报 applied=true',
    linkedOut.batch && linkedOut.batch.applied === true && linkedOut.batch.value === 2
    && linkedOut.graph['5'].inputs.batch_size === 2, JSON.stringify(linkedOut.batch));
  const noBatch = buildGenGraph({ '3': { class_type: 'KSampler', inputs: { seed: 1 } } }, [], { width: 768, height: 768 }, 4, 'p', null);
  check('工作流没有批量插槽时 applied=false（前端据此提示「张数不生效」）',
    noBatch.batch && noBatch.batch.applied === false && noBatch.batch.value === 4,
    JSON.stringify(noBatch.batch));
  // 'custom' 不在 SIZES 里，回落逻辑一旦漏判就会把用户填的宽高顶回 1K（512×512 出 1024×1024）
  check('存档里的 size=custom 不会被当成非法档位顶回 1K',
    /g\.size === 'custom'/.test(pickFn(appSrc, 'buildGenPanel')));

  // 「选了 4 张只回来 1 张」有两种原因：提交时张数就没写进去，或工作流把批量抹平了。
  // 第二种现在必须说出来，否则用户分不清该改面板还是改工作流。
  check('提交 4 张只回 1 张时如实报「只回来 1 张（提交了 4 张）」',
    (() => { const r = batchShortfall(4, 1); return r && r.want === 4 && r.got === 1 && /只回来 1 张/.test(r.note); })(),
    JSON.stringify(batchShortfall(4, 1)));
  check('张数对得上、只选 1 张、一张都没回来——都不算「少给了」',
    batchShortfall(4, 4) === null && batchShortfall(1, 1) === null && batchShortfall(4, 0) === null);

  // 出错分类：ComfyUI 的报错是一大坨字符串，直接甩给用户等于没说。
  // 四类各给一句「下一步该干什么」，只有连接类值得自动重试。
  const { classifyGenError } = new Function(`${pickFn(appSrc, 'classifyGenError')}\nreturn { classifyGenError };`)();
  const cls = (m) => classifyGenError(m).kind;
  check('出错分类：显存不足单独识别，并提示降尺寸（不重试）',
    cls('CUDA error: out of memory') === 'oom' && classifyGenError('CUDA error: out of memory').retry === false
      && /尺寸/.test(classifyGenError('CUDA error: out of memory').hint),
    JSON.stringify(classifyGenError('CUDA error: out of memory')));
  check('出错分类：模型缺失 / 工作流有错 / 连接超时 各归各类',
    cls("Value not in list: ckpt_name: 'x.safetensors' not in []") === 'model'
      && cls('Prompt has no outputs') === 'workflow'
      && cls('Failed to fetch') === 'network'
      && cls('任务记录已丢失（ComfyUI 可能已重启）') === 'network',
    JSON.stringify([cls("ckpt_name not found"), cls('Prompt has no outputs'), cls('Failed to fetch')]));
  check('出错分类：只有连接类会自动重试一次',
    classifyGenError('timeout').retry === true
      && classifyGenError('node_errors').retry === false
      && classifyGenError('随便什么错').kind === 'unknown');

  // 拿真实预设再过一遍：内置的大多数宽高是连线，这条就是防「面板选了尺寸、提交图上没写」的回归。
  //
  // 分族看的是**图里有没有尺寸来源**（EmptyLatentImage / ResolutionSelector 这类）。
  // 没有尺寸来源的那一族（超分放大）尺寸必须跟着输入图走：它是「把这张图放大」，
  // 钉死 1280×720 反而是错的。
  const presetRows = fs.readdirSync(path.join(ROOT, 'presets')).filter((f) => f.endsWith('.json')).map((f) => {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', f), 'utf8')).graph;
    const t = dimsTarget(g);
    const r = buildGenGraph(g, [], { width: 1280, height: 720 }, 1, 'p', null);
    const takesImage = Object.values(g).some((x) => {
      const ct = (x || {}).class_type;
      return ct === 'LoadImage' || ct === 'LoadImageMask';
    });
    return { f: f.replace(/\.(api\.)?json$/, ''), t, sized: r.sized, noSizeSrc: !t, takesImage,
      w: t ? r.graph[t].inputs.width : 0, h: t ? r.graph[t].inputs.height : 0 };
  });
  // 不写死数量：presets/ 是用户目录，随时会多一个（这轮就多了 Krea2 · 局部重绘、Vosr+2 图像高清化）
  const pinned = presetRows.filter((p) => !p.noSizeSrc);
  const followers = presetRows.filter((p) => p.noSizeSrc);
  check('内置预设全部钉得住尺寸（含从 ResolutionSelector 连线的）',
    presetRows.length >= 4 && pinned.length >= 3
      && pinned.every((p) => p.sized && p.w === 1280 && p.h === 720),
    presetRows.map((p) => `${p.f}→${p.t || '无'}:${p.w}×${p.h}`).join(' | '));
  check('没有尺寸来源的预设不钉尺寸，但必须真吃得下输入图（局部重绘 / 超分都是「尺寸跟着原图走」）',
    followers.length >= 1 && followers.every((p) => !p.sized && p.takesImage),
    followers.map((p) => `${p.f}→${p.t || '无'}·吃图=${p.takesImage}`).join(' | ') || '没有这类预设');

  // ---- 提示词落点：不能取「排序第一个 text 插槽」----
  // Qwen 文生图的真实结构：481 是个 1hew_MultiStringJoin，它的 input / separator 也是 STRING，
  // 且节点 id 更小排在前面。老逻辑把提示词写进 481.input —— 那是拼接器的空转填充位
  // （string_1 / string_2 全是连线），用户写的话一个字都没进模型，
  // 真正参与条件编码的是 482 里导出者留下的一千多字角色卡。「加载工作流数据残留」就是这个。
  const t2i = {
    '480': { class_type: 'easy stylesSelector', inputs: { styles: 'x', select_styles: 'Solo Leveling Art' } },
    '481': {
      class_type: '1hew_MultiStringJoin',
      inputs: { filter_empty_line: false, separator: '\n', input: '', string_1: ['480', 0], string_2: ['482', 0] },
    },
    '482': { class_type: 'PrimitiveStringMultiline', inputs: { value: '你是顾星阑，31岁……（残留 1171 字）' } },
    '483:469': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: ['483:476', 0], negative_prompt: '', clip: ['483:470', 0] } },
    '483:476': { class_type: 'TextGenerateLTX2Prompt', inputs: { prompt: ['481', 0], max_length: 512, clip: ['483:478', 0] } },
    '483:472': { class_type: 'EmptyLatentImage', inputs: { width: ['483:13', 0], height: ['483:13', 1], batch_size: 1 } },
    '483:13': { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '9:16', megapixels: 4, multiple: 8 } },
    '483:474': { class_type: 'KSampler', inputs: { seed: 1, positive: ['483:469', 0], negative: ['483:469', 1], latent_image: ['483:472', 0] } },
  };
  const t2iSlots = [
    { kind: 'text', key: '481.input', node: '481', input: 'input', value: '', node_title: 'MultiStringJoin' },
    { kind: 'text', key: '481.separator', node: '481', input: 'separator', value: '\n', node_title: 'MultiStringJoin' },
    { kind: 'text', key: '482.value', node: '482', input: 'value', value: '你是顾星阑…', node_title: 'PrimitiveStringMultiline' },
    { kind: 'text', key: '483:469.negative_prompt', node: '483:469', input: 'negative_prompt', value: '', node_title: 'TextEncode' },
  ];
  const t2iOut = buildGenGraph(t2i, t2iSlots, { width: 768, height: 1344 }, 1, '雨夜霓虹巷子里的猫', null);
  check('提示词落到正向链最上游的内容节点，不再写进拼接器的 input 空转参数',
    t2iOut.graph['482'].inputs.value === '雨夜霓虹巷子里的猫' && t2iOut.graph['481'].inputs.input === ''
    && t2iOut.graph['481'].inputs.separator === '\n',
    `482=${t2iOut.graph['482'].inputs.value} 481.input=${JSON.stringify(t2iOut.graph['481'].inputs.input)}`);
  check('落点被纠正过要报出来（提示词写哪去了，用户没法自己排查）',
    t2iOut.prompt && t2iOut.prompt.corrected === true && t2iOut.prompt.node === '482',
    JSON.stringify(t2iOut.prompt));

  // 风格类工作流：正向链上还挂着一个 LLM 扩写节点，它的系统提示（"You are an expert prompt engineer…"）
  // 比真正给人写的 61.value 更靠近采样器。按「最近」选会顶掉系统提示，必须按「最上游」选。
  const styleG = {
    '30:6': { class_type: 'CLIPTextEncode', inputs: { text: ['30:28', 0], clip: ['30:11', 0] } },
    '30:28': { class_type: 'ComfySwitchNode', inputs: { switch: ['30:23', 0], on_false: ['30:20', 0], on_true: ['30:27', 0] } },
    '30:27': { class_type: 'StringConcatenate', inputs: { string_a: ['30:20', 0], string_b: 'muted minimalist sketch style', delimiter: ', ' } },
    '30:20': { class_type: 'PreviewAny', inputs: { source: ['30:21', 0] } },
    '30:21': { class_type: 'ComfySwitchNode', inputs: { switch: ['30:24', 0], on_false: ['30:19', 0], on_true: ['30:16', 0] } },
    '30:16': { class_type: 'TextGenerate', inputs: { prompt: ['30:17', 0], clip: ['30:11', 0] } },
    '30:17': { class_type: 'StringConcatenate', inputs: { string_a: ['30:18', 0], string_b: ['30:19', 0], delimiter: '' } },
    '30:18': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'You are an expert prompt engineer. Follow these rules strictly:' } },
    '30:19': { class_type: 'PrimitiveStringMultiline', inputs: { value: ['54', 0] } },
    '54': { class_type: '1hew_MultiStringJoin', inputs: { separator: '\n', input: '', string_3: ['61', 0], string_4: ['62', 0] } },
    '61': { class_type: 'PrimitiveStringMultiline', inputs: { value: '中近景半身胸像的 3D 超写实国风机甲女性角色立绘…（残留 1231 字）' } },
    '62': { class_type: 'CameraPreset', inputs: { 光圈: 'f/2.0' } },
    '30:3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['30:6', 0], negative: ['30:13', 0] } },
  };
  const styleSlots = [
    { kind: 'text', key: '54.input', node: '54', input: 'input', value: '', node_title: 'MultiStringJoin' },
    { kind: 'text', key: '54.separator', node: '54', input: 'separator', value: '\n', node_title: 'MultiStringJoin' },
    { kind: 'text', key: '61.value', node: '61', input: 'value', value: '中近景…', node_title: 'PrimitiveStringMultiline' },
    { kind: 'text', key: '30:17.delimiter', node: '30:17', input: 'delimiter', value: '', node_title: 'StringConcatenate' },
    { kind: 'text', key: '30:18.value', node: '30:18', input: 'value', value: 'You are an expert prompt engineer. Follow these rules strictly:', node_title: 'PrimitiveStringMultiline' },
    { kind: 'text', key: '30:27.delimiter', node: '30:27', input: 'delimiter', value: ', ', node_title: 'StringConcatenate' },
    { kind: 'text', key: '30:27.string_b', node: '30:27', input: 'string_b', value: 'muted minimalist sketch style', node_title: 'StringConcatenate' },
  ];
  const styleOut = buildGenGraph(styleG, styleSlots, { width: 832, height: 1216 }, 1, '雨夜霓虹巷子里的猫', null);
  check('风格工作流：提示词写进给人写的那句，不顶掉 LLM 扩写的系统提示',
    styleOut.graph['61'].inputs.value === '雨夜霓虹巷子里的猫'
    && styleOut.graph['30:18'].inputs.value.startsWith('You are an expert prompt engineer')
    && styleOut.graph['54'].inputs.input === '',
    `61=${styleOut.graph['61'].inputs.value} 30:18=${styleOut.graph['30:18'].inputs.value.slice(0, 20)}`);

  // 简单文生图（krea2）：没有拼接器时行为不能变，correted 必须是 false，否则状态栏会天天多一句
  const plainOut = buildGenGraph({
    '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a cinematic portrait', clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '7': { class_type: 'KSampler', inputs: { seed: 1, positive: ['4', 0], negative: ['5', 0] } },
  }, [
    { kind: 'text', key: '4.text', node: '4', input: 'text', value: 'a cinematic portrait', node_title: 'CLIPTextEncode' },
    { kind: 'text', key: '5.text', node: '5', input: 'text', value: '', node_title: 'CLIPTextEncode' },
  ], { width: 1024, height: 1024 }, 1, 'hello', null);
  check('普通文生图行为不变：正向写 prompt、负向一个字不动、不报纠正',
    plainOut.graph['4'].inputs.text === 'hello' && plainOut.graph['5'].inputs.text === ''
    && plainOut.prompt.corrected === false, JSON.stringify(plainOut.prompt));

  check('被字面量顶掉的 ResolutionSelector 没人再用就摘掉（不留死节点）',
    !t2iOut.graph['483:13'] && t2iOut.graph['483:472'].inputs.width === 768,
    `13=${!!t2iOut.graph['483:13']} w=${t2iOut.graph['483:472'].inputs.width}`);

  // ---- 种子：同一个 seed + 同一段提示词 = 同一张图 ----
  // 工作流里那个 seed 是导出时冻结的，以前每次生成原样提交，于是「继续生成」出来的永远是同一张。
  const seedGraph = {
    '7': { class_type: 'KSampler', inputs: { seed: 20261023, positive: ['4', 0], negative: ['5', 0] } },
    '8': { class_type: 'SomeSampler', inputs: { noise_seed: 42 } },
  };
  const seedSlots = [
    { kind: 'seed', key: '7.seed', node: '7', input: 'seed', value: 20261023 },
    { kind: 'seed', key: '8.noise_seed', node: '8', input: 'noise_seed', value: 42 },
  ];
  const r1 = buildGenGraph(seedGraph, seedSlots, { width: 1024, height: 1024 }, 1, 'p', null);
  const r2 = buildGenGraph(seedGraph, seedSlots, { width: 1024, height: 1024 }, 1, 'p', null);
  check('每次生成都换种子（工作流里那个冻结的 seed 不再原样提交）',
    r1.graph['7'].inputs.seed !== 20261023 && r1.graph['7'].inputs.seed !== r2.graph['7'].inputs.seed,
    `${r1.graph['7'].inputs.seed} / ${r2.graph['7'].inputs.seed}`);
  check('一个工作流里的多处种子（seed 与 noise_seed）写同一个值',
    r1.graph['7'].inputs.seed === r1.graph['8'].inputs.noise_seed
    && r1.seed.keys.length === 2, JSON.stringify(r1.seed));
  check('随机种子是 32 位非负整数（落在 JS 安全整数内）',
    [r1, r2].every((r) => Number.isInteger(r.seed.value) && r.seed.value >= 0 && r.seed.value < 4294967296),
    String(r1.seed.value));
  const fixed1 = buildGenGraph(seedGraph, seedSlots, { width: 1024, height: 1024 }, 1, 'p', null, { mode: 'fixed', value: 12345 });
  const fixed2 = buildGenGraph(seedGraph, seedSlots, { width: 1024, height: 1024 }, 1, 'p', null, { mode: 'fixed', value: 12345 });
  check('固定种子：两次提交完全一致（能复现某一张）',
    fixed1.graph['7'].inputs.seed === 12345 && fixed2.graph['7'].inputs.seed === 12345
    && fixed1.seed.fixed === true && r1.seed.fixed === false,
    `${fixed1.graph['7'].inputs.seed}/${fixed2.graph['7'].inputs.seed}`);
  check('工作流没有种子插槽时不谎报种子',
    buildGenGraph(seedGraph, [], { width: 1024, height: 1024 }, 1, 'p', null).seed === null);
  // 「固定」不能名不副实：填个负数/清空都得钉在 0，绝不能在背后换随机种子
  const odd = buildGenGraph(seedGraph, seedSlots, { width: 1024, height: 1024 }, 1, 'p', null, { mode: 'fixed', value: -5 });
  const emptySeed = buildGenGraph(seedGraph, seedSlots, { width: 1024, height: 1024 }, 1, 'p', null, { mode: 'fixed', value: null });
  check('固定档填了非法值就钉在 0，不改回随机',
    odd.seed.value === 0 && odd.seed.fixed === true && emptySeed.seed.value === 0 && emptySeed.seed.fixed === true,
    `${odd.seed.value}/${emptySeed.seed.value}`);

  // 守卫：图片节点没有 values 字段（那是工作流节点的插槽值表）。生成流程一旦往 n.values 里写，
  // 就是 `Cannot set properties of undefined` —— 图已经在队列里跑了，面板却报「失败」。
  // 这条是端到端探针抓出来的真 bug，静态守一下别再写回去（只认真正下标的写法，注释里提一句不算）。
  check('生成流程不碰图片节点的 values 字段',
    !/n\.values\s*\[/.test(pickFn(appSrc, 'generateImage')), 'generateImage 里出现了 n.values[...]');

  chromeCtx = await launchChrome({
    port: await freePort(),
    profile: path.join(TMP, 'chrome-profile'),
    headless: !headed,
  });
  page = await newPage(chromeCtx.port);
  await page.clearStorage(new URL(server.base).origin);

  await page.goto(server.base);
  await page.waitFor(`document.readyState === 'complete'`, 15000);

  // 启动落点不确定：有项目时会直接进画布，没有才停在首页。等到其中一种稳定状态。
  const boot = await page.waitFor(`(() => {
    const home = document.getElementById('home');
    const homeVisible = home && !home.classList.contains('hidden');
    const cards = document.querySelectorAll('#recentList .proj-card').length;
    const nodes = document.querySelectorAll('#nodes .node').length;
    if (!homeVisible && nodes > 0) return { at: 'canvas', nodes, hash: location.hash };
    if (homeVisible && cards > 0 && location.hash === '#home') return { at: 'home', cards, hash: location.hash };
    return null;
  })()`, 15000);
  check('启动落点明确（首页或画布）', !!boot, JSON.stringify(boot));

  if (boot.at === 'home') {
    const fixtureName = await page.evaluate(`document.querySelector('#recentList .proj-card')?.textContent.trim().slice(0, 20) || ''`);
    check('最近项目里有夹具画布', /e2e 夹具画布/.test(fixtureName), fixtureName);
    await page.evaluate(`document.querySelector('#recentList .proj-card .pm').click()`);
    await page.waitFor(`document.querySelectorAll('#nodes .node').length > 0`, 12000);
  }

  // 图标：全部由 icons.js 填充
  const icons = await page.evaluate(`(() => ({
    rendered: document.querySelectorAll('.oi').length,
    empty: [...document.querySelectorAll('[data-icon]')].filter((el) => !el.querySelector('svg')).length
  }))()`);
  check('IconPark 图标已填充', icons.rendered >= 20 && icons.empty === 0, `oi=${icons.rendered} empty=${icons.empty}`);

  // 画布内容（夹具：文本 + 图片，一条连线）
  const canvas = await page.evaluate(`(() => ({
    nodes: document.querySelectorAll('#nodes .node').length,
    links: document.querySelectorAll('#links .link-line').length,
    hash: location.hash,
    homeHidden: document.getElementById('home').classList.contains('hidden')
  }))()`);
  check('打开画布：5 节点 / 2 连线', canvas.nodes === 5 && canvas.links === 2, JSON.stringify(canvas));
  check('路由切到 #canvas', canvas.hash === '#canvas' && canvas.homeHidden);

  // ---- 工具条停靠：底部居中 / 左侧 / 右侧 / 顶部 ----
  const dockState = () => page.evaluate(`(() => {
    const w = document.querySelector('#dockWrap');
    const bar = document.querySelector('#bar');
    const r = w.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return {
      side: w.dataset.dock,
      left: Math.round(r.left), right: Math.round(innerWidth - r.right),
      top: Math.round(r.top), bottom: Math.round(innerHeight - r.bottom),
      cx: Math.round((r.left + r.right) / 2), cy: Math.round((r.top + r.bottom) / 2),
      vw: innerWidth, vh: innerHeight,
      // 横排 / 竖排：左右停靠时必须是 column，否则横着压掉半个画布
      wrapDir: getComputedStyle(w).flexDirection,
      barDir: getComputedStyle(bar).flexDirection,
      barW: Math.round(b.width), barH: Math.round(b.height),
    };
  })()`);
  const pickDock = async (label) => {
    await page.evaluate(`document.querySelector('#bar [data-act="all-tools"]').click()`);
    await new Promise((r) => setTimeout(r, 250));
    await page.evaluate(`[...document.querySelectorAll('.popmenu button')].find((b) => b.textContent === '工具条位置…').click()`);
    await new Promise((r) => setTimeout(r, 250));
    await page.evaluate(`[...document.querySelectorAll('.dock-menu button')].find((b) => b.textContent === '${label}').click()`);
    await new Promise((r) => setTimeout(r, 300));
  };

  const d0 = await dockState();
  check('工具条默认停在底部居中、横着排',
    d0.side === 'bottom' && Math.abs(d0.cx - d0.vw / 2) <= 2 && d0.bottom < 40
      && d0.barDir === 'row' && d0.barW > d0.barH,
    JSON.stringify(d0));

  await pickDock('左侧居中');
  const d1 = await dockState();
  check('切到左侧居中：贴左边、垂直居中、改成竖排',
    d1.side === 'left' && d1.left <= 20 && Math.abs(d1.cy - d1.vh / 2) <= 2
      && d1.barDir === 'column' && d1.wrapDir === 'column' && d1.barH > d1.barW,
    JSON.stringify(d1));

  await pickDock('右侧居中');
  const d2 = await dockState();
  check('切到右侧居中：贴右边、垂直居中、也是竖排',
    d2.side === 'right' && d2.right <= 20 && Math.abs(d2.cy - d2.vh / 2) <= 2
      && d2.barDir === 'column' && d2.barH > d2.barW,
    JSON.stringify(d2));

  await pickDock('顶部居中');
  const d3 = await dockState();
  check('切到顶部居中：贴顶、水平居中、回到横排',
    d3.side === 'top' && d3.top <= 70 && Math.abs(d3.cx - d3.vw / 2) <= 2
      && d3.barDir === 'row' && d3.barW > d3.barH,
    JSON.stringify(d3));

  await pickDock('底部居中');   // 复位，后面的用例按默认布局继续
  const d4 = await dockState();
  check('切回底部居中并记住选择（localStorage）',
    d4.side === 'bottom' && Math.abs(d4.cx - d4.vw / 2) <= 2
      && (await page.evaluate(`localStorage.getItem('infisheet-dock-side')`)) === 'bottom',
    JSON.stringify(d4));

  // ---- 对齐 / 分布：悬浮条（选中 2 个以上才浮出，图标按钮） ----
  const alignBarState = () => page.evaluate(`(() => {
    const bar = document.querySelector('#alignBar');
    if (!bar) return { missing: true };
    const btns = [...bar.querySelectorAll('.ab-btn')];
    const r = bar.getBoundingClientRect();
    const sel = [...document.querySelectorAll('.node.selected')].map((el) => el.getBoundingClientRect());
    const selTop = sel.length ? Math.min(...sel.map((x) => x.top)) : null;
    const selBottom = sel.length ? Math.max(...sel.map((x) => x.bottom)) : null;
    const selLeft = sel.length ? Math.min(...sel.map((x) => x.left)) : null;
    const selRight = sel.length ? Math.max(...sel.map((x) => x.right)) : null;
    return {
      hidden: bar.classList.contains('hidden'),
      n: btns.length,
      icons: btns.filter((b) => b.querySelector('svg')).length,
      labels: btns.map((b) => b.getAttribute('aria-label')),
      sep: bar.querySelectorAll('.ab-sep').length,
      // 跟随选区：底边到选区顶边的间距、水平是否对准选区中线
      above: selTop == null ? null : Math.round(selTop - r.bottom),
      dx: selLeft == null ? null : Math.round((r.left + r.right) / 2 - (selLeft + selRight) / 2),
      below: selBottom == null ? null : Math.round(r.top - selBottom),
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    };
  })()`);
  const pickNode = (id, shift) => page.evaluate(`(() => {
    const card = document.querySelector('.node[data-id="${id}"] .node-card');
    if (!card) return false;
    const b = card.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 12,
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, shiftKey: ${shift} };
    card.dispatchEvent(new PointerEvent('pointerdown', o));
    card.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    return true;
  })()`);
  const leftsOf = () => page.evaluate(`[...document.querySelectorAll('.node.selected')]
    .map((el) => Math.round(el.getBoundingClientRect().left))`);

  const al0 = await alignBarState();
  await pickNode('t1', false);
  await new Promise((r) => setTimeout(r, 200));
  const al1 = await alignBarState();
  await pickNode('i3', true);
  await pickNode('i4', true);
  await new Promise((r) => setTimeout(r, 250));
  const al2 = await alignBarState();
  const leftBefore = await leftsOf();
  check('对齐悬浮条只在选中 2 个以上时浮出',
    al0.hidden === true && al1.hidden === true && al2.hidden === false && leftBefore.length === 3,
    JSON.stringify({ al0, al1, al2, leftBefore }));

  check('悬浮条是 8 个图标按钮（6 对齐 + 1 分隔 + 2 分布）',
    al2.n === 8 && al2.icons === 8 && al2.sep === 1
      && al2.labels.join('|') === '左对齐|水平居中|右对齐|顶对齐|垂直居中|底对齐|水平等距|垂直等距',
    JSON.stringify(al2));
  check('悬浮条跟着选区走：浮在选区上方、水平对准选区中线、不出视口',
    al2.above !== null && al2.above >= 6 && al2.above <= 26
      && Math.abs(al2.dx) <= 2 && al2.inView,
    JSON.stringify({ above: al2.above, dx: al2.dx, inView: al2.inView }));

  await page.evaluate(`document.querySelector('#alignBar .ab-btn[data-mode="left"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const leftAfter = await leftsOf();
  check('左对齐：三个节点的左边缘落到同一条竖线上',
    leftAfter.length === 3 && new Set(leftAfter).size === 1 && new Set(leftBefore).size > 1,
    JSON.stringify({ leftBefore, leftAfter }));

  // 对齐进了撤销栈：Ctrl+Z 要能整批回退（位置全恢复）
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 400));
  const restored = await leftsOf();
  check('对齐可撤销：Ctrl+Z 后三个节点回到原位',
    restored.length === 3 && restored.join() === leftBefore.join(), JSON.stringify({ leftBefore, restored }));

  // 清掉选择，后面的用例按原来的单选用法继续
  await page.evaluate(`(() => {
    const stage = document.querySelector('#stage');
    const b = stage.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 6, clientY: b.bottom - 6, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', o));
    stage.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));

  // ---- 编组：颜色 + 整框拖动 ----
  await pickNode('t1', false);
  await pickNode('i3', true);
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 400));
  const grp0 = await page.evaluate(`(() => {
    const box = document.querySelector('.group');
    if (!box) return { missing: true };
    const cs = getComputedStyle(box);
    return {
      gid: box.dataset.gid,
      color: box.dataset.color,
      chip: !!box.querySelector('.gcolor'),
      chipBg: getComputedStyle(box.querySelector('.gcolor')).backgroundColor,
      border: cs.borderTopColor,
      cursor: cs.cursor,
      name: (box.querySelector('.gname') || {}).textContent,
    };
  })()`);
  check('Ctrl+G 打组后组框带颜色（默认第一个色）和色块按钮',
    grp0.color === 'blue' && grp0.chip && grp0.chipBg === 'rgb(110, 168, 254)' && grp0.cursor === 'move'
      && /2 节点/.test(grp0.name),
    JSON.stringify(grp0));

  await page.evaluate(`document.querySelector('.group .gcolor').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const gcMenu = await page.evaluate(`(() => {
    const chips = [...document.querySelectorAll('.group-colors .gc-chip')];
    return { n: chips.length, labels: chips.map((c) => c.getAttribute('aria-label')) };
  })()`);
  check('点色块弹出 6 个颜色',
    gcMenu.n === 6 && gcMenu.labels.join('') === '蓝紫绿橙粉灰', JSON.stringify(gcMenu));

  await page.evaluate(`[...document.querySelectorAll('.group-colors .gc-chip')].find((c) => c.getAttribute('aria-label') === '绿').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const afterColor = await page.evaluate(`(() => {
    const box = document.querySelector('.group');
    return { color: box.dataset.color, border: getComputedStyle(box).borderTopColor,
      chipBg: getComputedStyle(box.querySelector('.gcolor')).backgroundColor };
  })()`);
  check('换色后组框描边和色块一起变绿',
    afterColor.color === 'green' && afterColor.border === 'rgba(52, 211, 153, 0.55)'
      && afterColor.chipBg === 'rgb(52, 211, 153)',
    JSON.stringify(afterColor));

  // 双击组名改名
  await page.evaluate(`document.querySelector('.group .gname').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  const editing = await page.evaluate(`(() => {
    const n = document.querySelector('.group .gname');
    return { editable: n.isContentEditable, text: n.textContent, cls: n.className };
  })()`);
  check('双击组名进入编辑态（只显示名字，不带「· N 节点」）',
    editing.editable === true && editing.text === '分组 1' && /editing/.test(editing.cls),
    JSON.stringify(editing));

  await page.evaluate(`(() => {
    const n = document.querySelector('.group .gname');
    n.textContent = '雨夜三连';
    n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const renamed = await page.evaluate(`(async () => {
    const n = document.querySelector('.group .gname');
    const id = localStorage.getItem('infisheet-project');
    const j = await (await fetch('/api/projects/' + id)).json();
    return {
      text: n.textContent, editable: n.isContentEditable,
      saved: (j.canvas.groups || []).map((g) => g.name),
    };
  })()`);
  check('回车保存新名字：组头变成「雨夜三连 · 2 节点」，并写进存档',
    renamed.text === '雨夜三连 · 2 节点' && renamed.editable === false
      && renamed.saved.includes('雨夜三连'),
    JSON.stringify(renamed));

  // 整框可拖：在组框内的空白处（右下角 padding 区）按下拖 60/40
  const dragFrom = await page.evaluate(`[...document.querySelectorAll('.node.selected')]
    .map((el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top)]; })`);
  const dragHit = await page.evaluate(`(() => {
    const box = document.querySelector('.group');
    const r = box.getBoundingClientRect();
    const x = r.left + 8, y = r.top + 8;   // 左上角 padding 区：组框比节点多留 26/44，这里一定是空白
    const el = document.elementFromPoint(x, y);
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x + 60, clientY: y + 40 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x + 60, clientY: y + 40, buttons: 0 }));
    return { hit: el.className, gid: el.dataset ? el.dataset.gid : null };
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const dragTo = await page.evaluate(`[...document.querySelectorAll('.node.selected')]
    .map((el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top)]; })`);
  const moved = dragFrom.length === 2 && dragTo.length === 2
    && dragFrom.every((p, i) => Math.abs(dragTo[i][0] - p[0] - 60) <= 2 && Math.abs(dragTo[i][1] - p[1] - 40) <= 2);
  check('按住组框内的空白也能整组拖动（不再只能拖顶部标题）',
    /\bgroup\b/.test(dragHit.hit || '') && moved,
    JSON.stringify({ hit: dragHit.hit, dragFrom, dragTo }));

  // 拖完撤销回原位，后面的用例按原布局继续
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 350));
  await page.evaluate(`(() => {
    const stage = document.querySelector('#stage');
    const b = stage.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 6, clientY: b.bottom - 6, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', o));
    stage.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));

  // 连线是三次贝塞尔（两端水平切线），不是「横 → 竖 → 横」的折线
  const curve = await page.evaluate(`(() => {
    const d = document.querySelector('#links .link-line').getAttribute('d') || '';
    return { d, cubic: /^M [\\d.-]+ [\\d.-]+ C /.test(d), ortho: /[HVQ]/.test(d) };
  })()`);
  check('连线走三次贝塞尔（不是折线）', curve.cubic && !curve.ortho, curve.d.slice(0, 46));

  // ---- 连线中点上的删除键 ----
  // 位置按**真实路径**取一半长度处（不是两端平均）——反向连线会吊下来一截，
  // 平均点会飘到曲线外面。这里用同一个口径独立算一遍当参照，验的是「贴不贴 curve」。
  const linkProbe = await page.evaluate(`(() => {
    const first = document.querySelector('.link-line');
    if (!first) return { none: true };
    const p = first;
    const pt = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM();
    return {
      n: document.querySelectorAll('.link-line').length,
      id: p.dataset.link,
      x: m.a * pt.x + m.c * pt.y + m.e,
      y: m.b * pt.x + m.d * pt.y + m.f,
      btnHidden: document.getElementById('linkDel').classList.contains('hidden'),
    };
  })()`);
  check('还没点连线时，删除键是收着的', linkProbe.none !== true && linkProbe.btnHidden === true,
    JSON.stringify(linkProbe));

  await page.clickAt(linkProbe.x, linkProbe.y);
  await new Promise((r) => setTimeout(r, 300));
  const ld1 = await page.evaluate(`(() => {
    const b = document.getElementById('linkDel');
    const r = b.getBoundingClientRect();
    return {
      hidden: b.classList.contains('hidden'),
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      sel: [...document.querySelectorAll('.link-line.sel')].map((p) => p.dataset.link),
    };
  })()`);
  check('点中连线 → 中点浮出删除键（22×22，正压在曲线上 ±2px），连线同时高亮',
    ld1.hidden === false && ld1.w === 22 && ld1.h === 22
      && Math.abs(ld1.cx - linkProbe.x) <= 2 && Math.abs(ld1.cy - linkProbe.y) <= 2
      && ld1.sel.length === 1 && ld1.sel[0] === linkProbe.id,
    `${JSON.stringify(ld1)} vs 中点 ${Math.round(linkProbe.x)},${Math.round(linkProbe.y)}`);

  // 缩放后按钮不该变大变小，也不该离位（它挂在 body 上，是屏幕坐标）
  await page.evaluate(`document.getElementById('zoomBtn').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(`document.querySelector('#zoomMenu [data-zoom="2"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const ld2 = await page.evaluate(`(() => {
    const p = document.querySelector('.link-line.sel');
    if (!p) return { gone: true };
    const pt = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM();
    const b = document.getElementById('linkDel').getBoundingClientRect();
    return {
      w: Math.round(b.width),
      dx: Math.round(Math.abs(b.left + b.width / 2 - (m.a * pt.x + m.c * pt.y + m.e))),
      dy: Math.round(Math.abs(b.top + b.height / 2 - (m.b * pt.x + m.d * pt.y + m.f))),
    };
  })()`);
  check('缩放到 200% 后删除键还是 22px，并且仍贴着曲线中点',
    ld2.gone !== true && ld2.w === 22 && ld2.dx <= 2 && ld2.dy <= 2, JSON.stringify(ld2));

  // 点它 = 删掉这条连线
  const btnPos = await page.evaluate(`(() => { const r = document.getElementById('linkDel').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.clickAt(btnPos.x, btnPos.y);
  await new Promise((r) => setTimeout(r, 400));
  const ld3 = await page.evaluate(`(() => ({
    n: document.querySelectorAll('.link-line').length,
    ids: [...document.querySelectorAll('.link-line')].map((p) => p.dataset.link),
    hidden: document.getElementById('linkDel').classList.contains('hidden'),
  }))()`);
  check('点删除键 → 这条连线没了，按钮自己收起',
    ld3.n === linkProbe.n - 1 && !ld3.ids.includes(linkProbe.id) && ld3.hidden === true,
    JSON.stringify(ld3));

  // 删掉一条连线会影响后面「参考图」那些用例，所以立刻撤销回来 ——
  // 顺带把「撤销也能救回误删的连线」这条也验了：这是这个按钮唯一的风险点。
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 400));
  const ld4 = await page.evaluate(`(() => ({
    n: document.querySelectorAll('.link-line').length,
    back: [...document.querySelectorAll('.link-line')].some((p) => p.dataset.link === ${JSON.stringify(linkProbe.id)}),
    hidden: document.getElementById('linkDel').classList.contains('hidden'),
  }))()`);
  check('撤销（Ctrl+Z）能把误删的连线救回来，删除键跟着收起',
    ld4.n === linkProbe.n && ld4.back === true && ld4.hidden === true, JSON.stringify(ld4));

  // 缩放还原：后面那些用例都按 getBoundingClientRect 取坐标，缩放到多少都能点，
  // 但别留在 200%（点空白位置容易压到别的节点上）
  await page.evaluate(`document.getElementById('zoomBtn').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(`document.querySelector('#zoomMenu [data-zoom="fit"]').click()`);
  await new Promise((r) => setTimeout(r, 400));

  // 选中图片节点（CDP 鼠标打在节点上不触发 pointerdown，用合成事件）
  const picked = await page.evaluate(`(() => {
    const card = document.querySelector('#nodes .node.image .node-card');
    if (!card) return false;
    const b = card.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 24, clientY: b.top + 24, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    card.dispatchEvent(new PointerEvent('pointerdown', o));
    card.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    return !!document.querySelector('.node.selected');
  })()`);
  check('点选图片节点', picked);

  // 面板是同步建的，但「底部渐隐」的 has-more 要等一帧（app.js 里是 requestAnimationFrame 里算的，
  // 因为要先有布局才知道 scrollHeight）。以前这里直接读，偶尔会抢在那一帧之前 → 偶发红。
  await page.waitFor(`!!document.querySelector('.gen-panel .gen-prompt')`, 5000);
  await new Promise((r) => setTimeout(r, 180));

  const panel = await page.evaluate(`(() => {
    const p = document.querySelector('.gen-panel');
    if (!p) return null;
    const ta = p.querySelector('.gen-prompt');
    const run = p.querySelector('.gen-run');
    const pill = p.querySelector('.gen-bar .gensel');
    const bar = p.querySelector('.gen-bar');
    const ts = getComputedStyle(ta);
    const rs = getComputedStyle(run);
    return {
      visible: getComputedStyle(p).display !== 'none',
      rows: p.querySelectorAll('.gen-bar').length,
      barChildren: [...bar.children].map((c) => c.className.split(' ')[0]),
      prompt: { minH: ts.minHeight, maxH: ts.maxHeight, border: ts.borderTopWidth, bg: ts.backgroundColor, scrollable: ta.scrollHeight > ta.clientHeight, masked: ta.classList.contains('has-more') },
      run: { h: Math.round(run.getBoundingClientRect().height), bg: rs.backgroundColor, radius: rs.borderRadius },
      pill: { h: Math.round(pill.getBoundingClientRect().height) },
    };
  })()`);
  check('生成器面板出现', panel && panel.visible);
  check('提示词框：无边框、86~168px、透明底',
    panel && panel.prompt.border === '0px' && panel.prompt.minH === '86px' && panel.prompt.maxH === '168px' && panel.prompt.bg === 'rgba(0, 0, 0, 0)',
    JSON.stringify(panel?.prompt));
  check('长提示词出现底部渐隐', panel && panel.prompt.masked === true);

  // ---- 生成器面板：固定版面（600 宽），贴在节点下沿，且不跟画布缩放 ----
  // 位置切换（上/下/左/右那颗按钮）已按截图标注删掉：四个方向里三个都要挪鼠标找、
  // 还容易把面板顶到画布外，留「贴在下沿」一种就够。所以这里断言的是「按钮没了、位置也不再变」。
  const panelGeom = () => page.evaluate(`(() => {
    const node = document.querySelector('.node.selected');
    const p = node && node.querySelector('.gen-panel');
    if (!p || !node) return { missing: true };
    const a = p.getBoundingClientRect(), b = node.getBoundingClientRect();
    const chip = p.querySelector('.gen-chips .chip');
    const cs = chip ? getComputedStyle(chip) : null;
    return {
      side: p.dataset.side,
      below: Math.round(a.top - b.bottom),    // 面板顶 - 节点底
      w: Math.round(a.width),
      h: Math.round(a.height),
      nodeW: Math.round(b.width),
      center: Math.round((a.left + a.width / 2) - (b.left + b.width / 2)),
      zoom: document.getElementById('zoomBtn').textContent.trim(),
      sideBtn: !!p.querySelector('.gen-side'),        // 位置按钮：应该已经不存在
      sideMenu: !!document.querySelector('.side-menu'),
      chipRadius: cs ? cs.borderRadius : '',
      chipColor: cs ? cs.color : '',
      chipBg: cs ? cs.backgroundColor : '',
      chipH: chip ? Math.round(chip.getBoundingClientRect().height) : 0,
    };
  })()`);

  const pg0 = await panelGeom();
  check('面板固定在节点下方、水平居中，位置切换按钮与菜单都已移除',
    pg0.side === 'bottom' && pg0.below >= 6 && Math.abs(pg0.center) <= 2 && !pg0.sideBtn && !pg0.sideMenu,
    JSON.stringify(pg0));
  check('面板是固定 600 宽的版面（不再跟着节点宽度走）',
    Math.abs(pg0.w - 600) <= 1 && pg0.w - pg0.nodeW >= 32, `${pg0.w} vs 节点 ${pg0.nodeW}`);
  check('上排按钮：胶囊形、实心底、浅灰字（对齐参考图那颗「＋ 上传」）',
    pg0.chipRadius === '999px' && pg0.chipColor === 'rgb(204, 211, 222)'
      && pg0.chipH >= 23 && pg0.chipH <= 27,
    `${pg0.chipRadius} / ${pg0.chipColor} / ${pg0.chipH}px`);

  // 固定版面＝换挡不换尺寸：200% 下还是 600×同样的高，缝还是 10px（间距按 1/k 补偿过）
  const setZoom = async (v) => {
    await page.evaluate(`document.getElementById('zoomBtn').click()`);
    await new Promise((r) => setTimeout(r, 120));
    await page.evaluate(`document.querySelector('#zoomMenu button[data-zoom="${v}"]').click()`);
    await new Promise((r) => setTimeout(r, 300));
  };
  await setZoom('2');
  const pg200 = await panelGeom();
  await setZoom('0.5');
  const pg50 = await panelGeom();
  await setZoom('1');
  const pg100 = await panelGeom();
  const sameBox = (x) => x && Math.abs(x.w - pg0.w) <= 1 && Math.abs(x.h - pg0.h) <= 1 && x.below === pg0.below;
  check('画布放大到 200% / 缩到 50%，面板尺寸和位置一丝不变（不吃画布缩放）',
    sameBox(pg200) && sameBox(pg50) && sameBox(pg100),
    `100%=${pg0.w}×${pg0.h}/${pg0.below}px 200%=${pg200.w}×${pg200.h}/${pg200.below}px 50%=${pg50.w}×${pg50.h}/${pg50.below}px`);

  // ---- 放大编辑区：那颗「[ ]」不再加宽面板，而是把**整块面板**搬进一个大窗口 ----
  // 面板贴着视口下沿时真实鼠标会打到下面那条 dock 上，这里用合成 click
  await page.evaluate(`document.querySelector('.node.selected .gen-panel .gen-chips .icon-only').click()`);
  await page.waitFor(`!!document.querySelector('.be-mask .be-body .gen-panel')`, 5000);
  await new Promise((r) => setTimeout(r, 300));
  const be0 = await page.evaluate(`(() => {
    const m = document.querySelector('.be-mask');
    const box = m.querySelector('.be-box').getBoundingClientRect();
    const p = m.querySelector('.be-body .gen-panel');
    const pr = p ? p.getBoundingClientRect() : null;
    const ta = m.querySelector('.be-body .gen-panel .gen-prompt');
    const ex = m.querySelector('.be-body .gen-panel .gen-chips .icon-only');
    return {
      w: Math.round(box.width), h: Math.round(box.height),
      fixed: getComputedStyle(m).position,
      z: +getComputedStyle(m).zIndex,
      panel: pr ? { w: Math.round(pr.width), h: Math.round(pr.height) } : null,
      chips: m.querySelectorAll('.be-body .gen-panel .gen-chips .chip').length,
      refs: !!m.querySelector('.be-body .gen-panel .gen-refs'),
      bar: !!m.querySelector('.be-body .gen-panel .gen-bar'),
      run: !!m.querySelector('.be-body .gen-panel .gen-run'),
      promptH: ta ? Math.round(ta.getBoundingClientRect().height) : 0,
      expandHidden: !!ex && getComputedStyle(ex).display === 'none',
      active: document.activeElement === ta,
      leftInNode: !!document.querySelector('.node.selected .gen-panel'),
      count: m.querySelector('.be-count').textContent,
    };
  })()`);
  check('点展开 → 整个面板（上排按钮 + 缩略图 + 提示词 + 底栏）搬进独立大窗',
    be0.w >= 900 && be0.h >= 500 && be0.fixed === 'fixed' && be0.z >= 70
      && be0.chips >= 4 && be0.refs && be0.bar && be0.run
      && !be0.leftInNode && be0.active,
    JSON.stringify(be0));
  check('大窗里的提示词区吃满剩余高度（不再是面板里那 168px 的小框）',
    be0.panel && be0.promptH > 300 && be0.promptH < be0.panel.h
      && be0.expandHidden,
    `prompt=${be0.promptH} panel=${be0.panel && be0.panel.h}`);

  const beBefore = await page.evaluate(`document.querySelector('.be-body .gen-panel .gen-prompt').textContent.trim()`);
  await page.evaluate(`(() => {
    const t = document.querySelector('.be-body .gen-panel .gen-prompt');
    t.focus();
    const r = document.createRange(); r.selectNodeContents(t); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertText', false, '大面板里敲的字');
    t.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const be1 = await page.evaluate(`(() => ({
    count: document.querySelector('.be-count').textContent,
    len: document.querySelector('.be-body .gen-panel .gen-prompt').textContent.trim().length,
  }))()`);
  check('大窗头部字数跟着面板里的提示词走',
    be1.count === `${be1.len} 字`, `${be1.count} / len=${be1.len}`);

  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await new Promise((r) => setTimeout(r, 300));
  const be2 = await page.evaluate(`({
    mask: !!document.querySelector('.be-mask'),
    backInNode: !!document.querySelector('.node.selected .gen-panel'),
    panel: document.querySelector('.node.selected .gen-panel .gen-prompt').textContent.trim(),
  })`);
  check('Esc 关掉大窗：面板回到节点里，改过的内容还在',
    !be2.mask && be2.backInNode && be2.panel === `${beBefore}大面板里敲的字`,
    JSON.stringify({ mask: be2.mask, back: be2.backInNode, tail: be2.panel.slice(beBefore.length) }));

  // 清掉刚敲的字，后面的用例按空提示词继续
  await page.evaluate(`document.querySelectorAll('.gen-panel .gen-chips .chip')[2].click()`);
  await new Promise((r) => setTimeout(r, 200));
  check('底栏只有一行', panel && panel.rows === 1, panel ? panel.barChildren.join(' / ') : '');
  check('底栏顺序：工作流 → 参数 → 状态 → 生成',
    panel && panel.barChildren.join(',') === 'gensel,gensel,gen-status,gen-run',
    panel ? panel.barChildren.join(',') : '');
  check('生成按钮与胶囊同高、纯白', panel && Math.abs(panel.run.h - panel.pill.h) <= 1 && panel.run.bg === 'rgb(255, 255, 255)' && panel.run.radius === '999px',
    panel ? JSON.stringify(panel.run) + ' pill=' + panel.pill.h : '');

  // 参考图缩略图：夹具里 i3 →（文本节点 t1）→ i2，所以 i2 面板上应出现 i3 的缩略图
  const refs1 = await page.evaluate(`(() => ({
    n: document.querySelectorAll('.gen-panel .gen-ref').length,
    cls: [...document.querySelectorAll('.gen-panel .gen-ref')].map((el) => el.className),
    img: !!document.querySelector('.gen-panel .gen-ref img')
  }))()`);
  check('连线来的参考图显示缩略图', refs1.n === 1 && refs1.img && /via-text/.test(refs1.cls[0] || ''),
    JSON.stringify(refs1));

  // ---- 风格缩略图：按钮那颗换成缩略图，参考图那排也多出一格带 ✕ 的 ----
  // 名字看不出画风（「动漫风格 2」和「动漫风格 3」差别在哪？），缩略图一眼就认得。
  const styleLook = () => page.evaluate(`(() => {
    const p = document.querySelector('.gen-panel');
    const chip = p.querySelector('.gen-style');
    const ico = chip.querySelector('.gs-ico img');
    const st = p.querySelector('.gen-ref-style');
    return {
      label: chip.querySelector('.gs-name').textContent,
      thumb: ico ? ico.getAttribute('src') : '',
      thumbW: ico ? ico.naturalWidth : 0,      // 图真加载出来了才算数，src 对但 404 也是 0
      hasThumbCls: chip.classList.contains('has-thumb'),
      refs: p.querySelectorAll('.gen-ref').length,
      stSrc: st ? st.querySelector('img').getAttribute('src') : '',
      stTag: st ? (st.querySelector('.gen-ref-tag') || {}).textContent : '',
    };
  })()`);

  const st0 = await styleLook();
  check('没套风格：按钮是调色盘图标 + 「风格」两字',
    st0.label === '风格' && !st0.thumb && !st0.hasThumbCls && st0.refs === 1, JSON.stringify(st0));

  await page.evaluate(`document.querySelector('.gen-panel .gen-style').click()`);
  await page.waitFor(`!!document.querySelector('.style-pop .sp-q')`, 8000);
  await page.evaluate(`(() => { const q = document.querySelector('.style-pop .sp-q'); q.value = '吉卜力'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.waitFor(`document.querySelectorAll('.style-pop .sp-cell').length === 1`, 8000);
  await page.evaluate(`document.querySelector('.style-pop .sp-cell').click()`);
  await new Promise((r) => setTimeout(r, 700));
  const st1 = await styleLook();
  // 吉卜力是 anime 分类的第 2 条（i=1），缩略图 = anime-002.jpg —— 差一位就是另一张画
  check('套了风格：按钮左边换成该风格的缩略图，右边显示中文名',
    st1.label === '吉卜力风格' && st1.hasThumbCls
      && st1.thumb === 'styles/thumbs/anime-002.jpg' && st1.thumbW > 0, JSON.stringify(st1));
  check('参考图那排也跟着长出一格风格缩略图（带「风格」角标）',
    st1.refs === 2 && st1.stSrc === 'styles/thumbs/anime-002.jpg' && st1.stTag === '风格',
    JSON.stringify(st1));

  // 清干净：不然后面「点 @ 加一张参考图 → 变两张」的用例会被这一格多算一张
  await page.evaluate(`document.querySelector('.gen-panel .gen-ref-style .gen-ref-x').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const st2 = await styleLook();
  check('点风格格子的 ✕ 能取消，按钮和参考图那排一起复原',
    st2.label === '风格' && !st2.thumb && st2.refs === 1 && !st2.stSrc, JSON.stringify(st2));

  // 提示词里输入 @ → 弹出素材引用菜单。
  // 注意这里**故意不加空格**：「文案@」是中文里最自然的打法，之前要求 @ 前面必须是空格，导致它完全用不了。
  // 编辑器是 contenteditable，没有 .value：直接塞文本节点 + 把光标放到末尾，再派发 input
  const atMenu = await page.evaluate(`(() => {
    const ta = document.querySelector('.gen-panel .gen-prompt');
    ta.focus();
    ta.innerHTML = '';
    ta.appendChild(document.createTextNode('把背景换成雪夜@'));
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(ta);
    r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const menu = document.getElementById('refMenu');
    const tabs = menu ? [...menu.querySelectorAll('.rm-tab')].map((b) => b.textContent.trim().replace(/\\s+/g, '')) : [];
    return {
      open: !!menu,
      tabs,
      on: menu ? (menu.querySelector('.rm-tab.on') || {}).dataset?.tab : '',
      items: menu ? [...menu.querySelectorAll('.rm-item')].map((b) => b.textContent.trim()) : [],
      search: !!(menu && menu.querySelector('.rm-search input'))
    };
  })()`);
  check('文案后面紧跟 @ 也能弹出素材菜单',
    atMenu.open && atMenu.search && atMenu.tabs.join('|') === '已关联1|全部素材3',
    JSON.stringify(atMenu));
  check('默认只列已关联的图（没连过来的不往上摊）',
    atMenu.on === 'linked' && atMenu.items.length === 1 && /参考图甲/.test(atMenu.items[0]),
    JSON.stringify(atMenu.items));

  // 切到「全部素材」才能看见画布上其它图——这是那个「全局选择」，但要用户自己点开
  const atAll = await page.evaluate(`(() => {
    document.querySelector('#refMenu .rm-tab[data-tab="all"]').click();
    const menu = document.getElementById('refMenu');
    return {
      on: (menu.querySelector('.rm-tab.on') || {}).dataset?.tab,
      items: [...menu.querySelectorAll('.rm-item')].map((b) => b.textContent.trim()),
      metas: [...menu.querySelectorAll('.rm-meta')].map((b) => b.textContent.trim())
    };
  })()`);
  check('「全部素材」列出画布上的图并标来源',
    atAll.on === 'all' && atAll.items.length === 3 && atAll.items.some((t) => /参考图乙/.test(t)),
    JSON.stringify(atAll));

  // 选参考图乙（本来没连线）→ 缩略图变两张，提示词里出现内联胶囊 @[参考图乙]
  const atPick = await page.evaluate(`(() => {
    [...document.querySelectorAll('#refMenu .rm-item')].find((b) => /参考图乙/.test(b.textContent)).click();
    const refs = [...document.querySelectorAll('.gen-panel .gen-ref')];
    const ed = document.querySelector('.gen-panel .gen-prompt');
    const chips = [...ed.querySelectorAll('.gen-chip')];
    const c = chips[0];
    return {
      n: refs.length,
      at: refs.filter((el) => el.classList.contains('via-at')).length,
      primary: refs.filter((el) => el.classList.contains('primary')).length,
      chips: chips.length,
      token: c ? c.dataset.token : '',
      label: c ? c.textContent.trim() : '',
      thumb: !!(c && c.querySelector('img')),
      editable: c ? c.isContentEditable : true,
      text: ed.textContent,
      closed: !document.getElementById('refMenu')
    };
  })()`);
  check('@ 选图后多一张缩略图，并在提示词里渲染成内联胶囊',
    atPick.n === 2 && atPick.at === 1 && atPick.primary === 1
    && atPick.chips === 1 && atPick.token === '@[参考图乙]' && atPick.label === '参考图乙'
    && atPick.thumb && atPick.editable === false && atPick.closed,
    JSON.stringify(atPick));
  // 胶囊必须真的进了正文：textContent 里不该再有裸的 `@[`（那说明没渲染成胶囊）
  check('胶囊替代了裸文本，前后文字没被吃掉',
    /把背景换成雪夜/.test(atPick.text) && !atPick.text.includes('@['), atPick.text);

  // 也不该只活在 DOM 里：等自动存档落盘，读项目文件看提示词文本是不是 @[名字]
  await new Promise((r) => setTimeout(r, 800));
  const savedGen = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${projId}.json`), 'utf8'));
      return (j.nodes.find((x) => x.id === 'i2') || {}).gen || {};
    } catch { return {}; }
  })();
  check('提示词文本里存的是 @[名字]（不是只能看的 DOM）',
    /雪夜/.test(savedGen.prompt || '') && /@\[参考图乙\]/.test(savedGen.prompt || ''),
    JSON.stringify(savedGen.prompt));

  // 输入口可以连多个节点：把 i5 的输出拖到 i2 的输入口，参考图变三张、带序号
  const dragIn = await page.evaluate(`(() => {
    const mk = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
      buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true
    });
    const out = document.querySelector('[data-port="i5:out"]');
    const inp = document.querySelector('[data-port="i2:in"]');
    const r1 = out.getBoundingClientRect();
    const r2 = inp.getBoundingClientRect();
    const a = { x: r1.left + r1.width / 2, y: r1.top + r1.height / 2 };
    const b = { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
    out.dispatchEvent(mk('pointerdown', a.x, a.y));
    window.dispatchEvent(mk('pointermove', b.x, b.y));
    window.dispatchEvent(mk('pointerup', b.x, b.y));
    const refs = [...document.querySelectorAll('.gen-panel .gen-ref')];
    return {
      links: document.querySelectorAll('#links .link-line').length,
      n: refs.length,
      viaLink: refs.filter((el) => el.classList.contains('via-link')).length,
      nums: [...document.querySelectorAll('.gen-panel .gen-ref-n')].map((el) => el.textContent).join('')
    };
  })()`);
  check('输入口可以连多个节点', dragIn.links === 3 && dragIn.n === 3 && dragIn.viaLink === 1, JSON.stringify(dragIn));
  check('多张参考图带序号 1/2/3', dragIn.nums === '123', dragIn.nums);

  // 胶囊和缩略图是同一件事的两面：删正文里的胶囊，缩略图要跟着没
  const dropChip = await page.evaluate(`(() => {
    const ed = document.querySelector('.gen-panel .gen-prompt');
    ed.querySelector('.gen-chip').remove();     // 等价于用户 Backspace 掉整个胶囊
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    const refs = [...document.querySelectorAll('.gen-panel .gen-ref')];
    return { refs: refs.length, at: refs.filter((el) => el.classList.contains('via-at')).length, chip: !!ed.querySelector('.gen-chip') };
  })()`);
  check('删掉胶囊 → 对应的参考图缩略图也消失',
    dropChip.refs === 2 && dropChip.at === 0 && !dropChip.chip, JSON.stringify(dropChip));

  // 反过来：点缩略图上的 ✕，正文里的胶囊也要摘掉
  const xChip = await page.evaluate(`(() => {
    const ed = document.querySelector('.gen-panel .gen-prompt');
    ed.focus();
    ed.appendChild(document.createTextNode(' @'));
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(ed); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    // 「已关联」里现在只剩连线来的那几张，要引用别的图得先切到「全部素材」
    document.querySelector('#refMenu .rm-tab[data-tab="all"]').click();
    [...document.querySelectorAll('#refMenu .rm-item')].find((b) => /参考图乙/.test(b.textContent)).click();
    const before = { chip: !!ed.querySelector('.gen-chip'), at: document.querySelectorAll('.gen-ref.via-at').length };
    document.querySelector('.gen-ref.via-at .gen-ref-x').click();
    const now = document.querySelector('.gen-panel .gen-prompt');
    return { before, chip: !!now.querySelector('.gen-chip'), at: document.querySelectorAll('.gen-ref.via-at').length, text: now.textContent };
  })()`);
  check('点缩略图 ✕ → 正文里的胶囊一起摘掉',
    xChip.before.chip && xChip.before.at === 1 && !xChip.chip && xChip.at === 0, JSON.stringify(xChip));

  // 没连线的节点上按 @：不该直接摊一堆图，只给「浏览画布全部素材」这个全局入口
  await page.evaluate(`(() => {
    const card = document.querySelector('.node[data-id="i4"] .node-card');
    const b = card.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 24, clientY: b.top + 24, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    card.dispatchEvent(new PointerEvent('pointerdown', o));
    card.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const noLinkMenu = await page.evaluate(`(() => {
    const ta = document.querySelector('.node[data-id="i4"] .gen-prompt');
    ta.focus();
    ta.innerHTML = '';
    ta.appendChild(document.createTextNode('测试@'));
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(ta); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const menu = document.getElementById('refMenu');
    const tabs = menu ? [...menu.querySelectorAll('.rm-tab')].map((b) => b.textContent.trim().replace(/\\s+/g, '')) : [];
    const browse = menu ? menu.querySelector('.rm-browse') : null;
    return {
      open: !!menu,
      tabs,
      on: menu ? (menu.querySelector('.rm-tab.on') || {}).dataset?.tab : '',
      listed: menu ? menu.querySelectorAll('.rm-item img').length : -1,
      empty: menu ? ((menu.querySelector('.rm-empty') || {}).textContent || '') : '',
      browse: browse ? browse.textContent.trim() : ''
    };
  })()`);
  check('没连线时 @ 不摊图，只给「浏览画布全部素材」入口',
    noLinkMenu.open && noLinkMenu.on === 'linked' && noLinkMenu.listed === 0
    && /还没有连进来的图片/.test(noLinkMenu.empty) && /浏览画布全部素材/.test(noLinkMenu.browse),
    JSON.stringify(noLinkMenu));

  // @ 菜单以前没有「点外面关闭」，点到画布空白处会一直挂在那儿
  const atBlank = await page.evaluate(`(async () => {
    const st = document.getElementById('stage');
    const o = { bubbles: true, cancelable: true, clientX: 30, clientY: 320, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    st.dispatchEvent(new PointerEvent('pointerdown', o));
    await new Promise((r) => setTimeout(r, 120));
    return { menu: !!document.getElementById('refMenu'), selected: !!document.querySelector('.node.selected') };
  })()`);
  check('@ 菜单开着点空白：菜单收起、节点仍选中', !atBlank.menu && atBlank.selected, JSON.stringify(atBlank));

  // 回到 i2（后面的断言都假设选中的是它）
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await page.evaluate(`(() => {
    const card = document.querySelector('.node[data-id="i2"] .node-card');
    const b = card.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 24, clientY: b.top + 24, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    card.dispatchEvent(new PointerEvent('pointerdown', o));
    card.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  // 面板不能被下面的节点盖住：.node 带 transform 是独立 stacking context，
  // 面板自己的 z-index 只在节点内部生效，必须把整个节点抬起来
  const covered = await page.evaluate(`(() => {
    const p = document.querySelector('.gen-panel');
    const r = p.getBoundingClientRect();
    return [[r.left + 40, r.top + 12], [r.left + 40, r.bottom - 12], [r.right - 40, r.bottom - 12]]
      .map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el && el.closest('.gen-panel') ? 'panel' : (el ? (el.className || el.tagName) : 'none');
      });
  })()`);
  check('生成器面板浮在其它节点之上', covered.every((v) => v === 'panel'), JSON.stringify(covered));

  // 参数胶囊：画幅 / 清晰度 / 张数收进一个分组弹层（比例是图形网格，不是文字下拉）
  const opts = await page.evaluate(`(async () => {
    const pill = document.querySelector('.gen-panel .optsel .gm-btn');
    if (!pill) return { open: false };
    const before = pill.textContent.trim();
    pill.click();
    await new Promise((r) => requestAnimationFrame(r));
    const menu = document.querySelector('.gen-opts');
    if (!menu) return { open: false, before };
    const sections = [...menu.querySelectorAll('.go-sec .go-title')].map((t) => t.textContent.trim());
    const ratios = [...menu.querySelectorAll('.go-ratio')].map((b) => b.dataset.a);
    const glyph = menu.querySelector('.go-ratio.on i').getBoundingClientRect();
    const onBefore = menu.querySelector('.go-ratio.on').dataset.a;   // 点之前读，点完就被改掉了
    // 选竖版 + 2K + 2 张：胶囊摘要和底部像素都要跟着变
    menu.querySelector('.go-ratio[data-a="9:16"]').click();
    menu.querySelector('.go-seg button[data-s="2k"]').click();
    menu.querySelector('.gen-opts .go-seg button[data-b="2"]').click();
    const after = pill.textContent.trim();
    const foot = menu.querySelector('.go-foot').textContent.trim();
    // 4K 要先打招呼：一张十几 MP，本地出图会慢一个量级
    const sizeLabels = [...menu.querySelectorAll('.go-seg button[data-s]')]
      .map((b) => b.querySelector('span').textContent + '/' + b.querySelector('em').textContent);
    menu.querySelector('.go-seg button[data-s="4k"]').click();
    const foot4k = menu.querySelector('.go-foot').textContent.trim();
    menu.querySelector('.go-seg button[data-s="2k"]').click();   // 落回 2K，下面要对比存档
    return {
      open: true, before, sections, ratios,
      on: onBefore,
      glyphW: Math.round(glyph.width), glyphH: Math.round(glyph.height),
      sizeOn: menu.querySelector('.go-seg button.on[data-s]').dataset.s,
      batchOn: menu.querySelector('.gen-opts .go-seg button.on[data-b]').dataset.b,
      after, foot, foot4k, sizeLabels,
      cols: getComputedStyle(menu.querySelector('.go-ratios')).gridTemplateColumns.split(' ').length,
    };
  })()`);
  check('参数收成一枚胶囊 + 分组弹层（画幅 / 清晰度 / 张数 / 种子）',
    opts.open && opts.sections.join(',') === '画幅,清晰度,张数,种子' && opts.ratios.length === 13 && opts.cols === 5,
    JSON.stringify({ sections: opts.sections, ratios: opts.ratios?.length, cols: opts.cols }));
  check('比例是图形网格，选中的那格按真实比例变形',
    opts.on === '1:1' && opts.glyphW === opts.glyphH, `1:1 glyph=${opts.glyphW}×${opts.glyphH}`);
  check('清晰度是 1K / 2K / 4K（长边像素）',
    opts.sizeLabels.join('|') === '1K/1024|2K/2048|4K/4096', JSON.stringify(opts.sizeLabels));
  check('旧存档的 preview 迁到 1K（口径从短边换成长边）',
    opts.before === '1:1 · 1K · 1张', opts.before);
  check('弹层里改参数：胶囊摘要 + 底部像素实时更新',
    opts.after === '9:16 · 2K · 2张' && /9:16 · 1152 × 2048 · 2\.4MP/.test(opts.foot)
    && opts.sizeOn === '2k' && opts.batchOn === '2',
    JSON.stringify({ after: opts.after, foot: opts.foot }));
  check('4K 显示像素与「本地偏慢」提醒',
    /9:16 · 2304 × 4096 · 9\.4MP · 本地偏慢/.test(opts.foot4k), opts.foot4k);

  // 种子：默认「随机」，切「固定」才钉住（不然同一段提示词怎么点都出同一张）
  const seedUi = await page.evaluate(`(() => {
    const menu = document.querySelector('.gen-opts');
    if (!menu) return { open: false };
    const btns = [...menu.querySelectorAll('button[data-seed]')];
    const inp = menu.querySelector('input.go-num:not([data-dim])');
    const onOf = () => (menu.querySelector('button[data-seed].on') || {}).dataset?.seed;
    const def = { labels: btns.map((b) => b.dataset.seed), on: onOf(), disabled: !!inp.disabled,
                  foot: menu.querySelector('.go-foot').textContent.trim() };
    btns.find((b) => b.dataset.seed === 'fixed').click();
    const afterFixed = { on: onOf(), disabled: !!inp.disabled, foot: menu.querySelector('.go-foot').textContent.trim() };
    inp.value = '12345';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      open: true, def, afterFixed, val: inp.value,
      title: document.querySelector('.gen-panel .optsel .gm-btn').title,
      segCols: getComputedStyle(menu.querySelector('.go-seg.two')).gridTemplateColumns.split(' ').length,
    };
  })()`);
  check('种子段：默认「随机」，输入框灰着只作展示',
    seedUi.open && seedUi.def.labels.join('|') === 'random|fixed' && seedUi.def.on === 'random'
    && seedUi.def.disabled === true && /种子随机/.test(seedUi.def.foot),
    JSON.stringify(seedUi.def));
  check('切「固定」后可以填种子，底部不再提示随机',
    seedUi.afterFixed.on === 'fixed' && seedUi.afterFixed.disabled === false
    && !/种子随机/.test(seedUi.afterFixed.foot) && seedUi.segCols === 2,
    JSON.stringify(seedUi.afterFixed));
  check('填进去的种子写进了胶囊提示（复现时照着填）',
    seedUi.val === '12345' && /固定种子 12345/.test(seedUi.title), seedUi.title);

  // 存进存档的也得是新值，不能只是 UI 上换了张皮
  await new Promise((r) => setTimeout(r, 800));
  const savedOpts = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${projId}.json`), 'utf8'));
      return (j.nodes.find((x) => x.id === 'i2') || {}).gen || {};
    } catch { return {}; }
  })();
  check('画幅 / 清晰度 / 张数 / 种子写进了存档',
    savedOpts.aspect === '9:16' && savedOpts.size === '2k' && Number(savedOpts.batch) === 2
    && savedOpts.seedMode === 'fixed' && Number(savedOpts.seed) === 12345,
    JSON.stringify({ a: savedOpts.aspect, s: savedOpts.size, b: savedOpts.batch, m: savedOpts.seedMode, sd: savedOpts.seed }));

  // 自定义尺寸：直接敲宽高 → 切到「自定义」档，画幅按宽高反推，胶囊改报像素
  const custom = await page.evaluate(`(async () => {
    const menu = document.querySelector('.gen-opts');
    if (!menu) return { open: false };
    const pill = document.querySelector('.gen-panel .optsel .gm-btn');
    const w = menu.querySelector('.go-num[data-dim="w"]');
    const h = menu.querySelector('.go-num[data-dim="h"]');
    const type = (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const shown = { w: w.value, h: h.value };          // 打开时应该已经是当前生效尺寸
    type(w, 1280); type(h, 720);
    const after = {
      pill: pill.textContent.trim(),
      foot: menu.querySelector('.go-foot').textContent.trim(),
      on: (menu.querySelector('.go-ratio.on') || {}).dataset?.a,
      lit: menu.querySelector('.go-custom').classList.contains('on'),
      segLit: !!menu.querySelector('.go-seg button.on[data-s]'),
      w: w.value, h: h.value,
    };
    // 不齐 16 的值 → 失焦后对齐（1001 → 1008）
    type(w, 1001);
    w.dispatchEvent(new Event('change', { bubbles: true }));
    after.snapped = w.value;
    type(w, 1280);                                     // 回到 1280，下面查存档
    return { open: true, shown, after };
  })()`);
  check('自定义尺寸输入框打开时就是当前生效尺寸',
    custom.open && custom.shown.w === '1152' && custom.shown.h === '2048',
    JSON.stringify(custom.shown));
  check('敲宽高就切到自定义：胶囊改报像素、画幅反推、档位灯全灭',
    custom.after.pill === '1280×720 · 2张' && custom.after.lit === true && custom.after.segLit === false
    && custom.after.on === '16:9',
    JSON.stringify(custom.after));
  check('底部尺寸跟着自定义走', /16:9 · 1280 × 720 · 0\.9MP/.test(custom.after.foot), custom.after.foot);
  check('宽高自动对齐 16 的倍数（1001 → 1008）', custom.after.snapped === '1008', custom.after.snapped);

  await new Promise((r) => setTimeout(r, 800));
  const savedCustom = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${projId}.json`), 'utf8'));
      return (j.nodes.find((x) => x.id === 'i2') || {}).gen || {};
    } catch { return {}; }
  })();
  check('自定义尺寸与 size=custom 一起进存档',
    savedCustom.size === 'custom' && savedCustom.custom && savedCustom.custom.w === 1280
    && savedCustom.custom.h === 720 && savedCustom.aspect === '16:9',
    JSON.stringify({ s: savedCustom.size, c: savedCustom.custom, a: savedCustom.aspect }));

  // 点空白处关掉弹层：只收菜单，不能把节点一起取消选中——
  // 否则「选完参数顺手点一下空白」会把整个生成器面板收掉，看着像参数丢了。
  const blank = await page.evaluate(`(async () => {
    const pill = document.querySelector('.gen-panel .optsel .gm-btn');
    const tick = () => new Promise((r) => requestAnimationFrame(r));
    // 上一段（自定义尺寸）结束时弹层还开着，先收起来，回到「没菜单」这个干净起点
    if (document.querySelector('.gen-opts')) { pill.click(); await tick(); }
    const clean = !document.querySelector('.gen-opts');
    pill.click(); await tick();
    const opened = !!document.querySelector('.gen-opts');
    pill.click(); await tick();                      // 再点同一个胶囊＝收起
    const toggled = !document.querySelector('.gen-opts');
    pill.click(); await tick();
    const again = !!document.querySelector('.gen-opts');
    const st = document.getElementById('stage');
    const o = { bubbles: true, cancelable: true, clientX: 40, clientY: 320, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    st.dispatchEvent(new PointerEvent('pointerdown', o));
    st.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    await new Promise((r) => setTimeout(r, 120));
    const panel = document.querySelector('.gen-panel');
    return {
      clean, opened, toggled, again,
      pop: !!document.querySelector('.gen-opts'),
      panelOpen: panel ? getComputedStyle(panel).display !== 'none' : false,
      selected: !!document.querySelector('.node.selected'),
    };
  })()`);
  check('再点一次参数胶囊就收起（不是关了又立刻开）',
    blank.clean && blank.opened && blank.toggled && blank.again, JSON.stringify(blank));
  check('点空白只收弹层：节点仍选中、生成器面板不跟着消失',
    !blank.pop && blank.panelOpen && blank.selected, JSON.stringify(blank));

  // 点面板里的别处也要收弹层（.gen-panel 会拦 pointerdown，关闭监听必须挂在捕获阶段）
  const inner = await page.evaluate(`(async () => {
    const pill = document.querySelector('.gen-panel .optsel .gm-btn');
    pill.click();
    // 关闭监听是延后一拍（setTimeout 0）挂上的，等它挂好再点，别跟实现抢时序
    await new Promise((r) => setTimeout(r, 80));
    const t = document.querySelector('.gen-panel .gen-prompt');
    const b = t.getBoundingClientRect();
    t.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 20,
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true
    }));
    await new Promise((r) => setTimeout(r, 120));
    return { pop: !!document.querySelector('.gen-opts') };
  })()`);
  check('点面板里的提示词区也收弹层', !inner.pop, JSON.stringify(inner));


  // 缩放上限 800%：滚轮一直放大，停下来必须正好停在 800%，不能无上限
  const zoom = await page.evaluate(`(async () => {
    const st = document.getElementById('stage');
    const r = st.getBoundingClientRect();
    const wheel = () => st.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -240, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      bubbles: true, cancelable: true
    }));
    for (let i = 0; i < 40; i++) wheel();
    await new Promise((res) => requestAnimationFrame(res));
    const spun = document.getElementById('zoomBtn').textContent.trim();
    const scale = getComputedStyle(document.getElementById('world')).transform;
    // 菜单里的 800% 预设
    document.getElementById('zoomBtn').click();
    const btn = document.querySelector('#zoomMenu button[data-zoom="8"]');
    const hasPresets = ['2', '4', '8'].every((v) => !!document.querySelector('#zoomMenu button[data-zoom="' + v + '"]'));
    if (btn) btn.click();
    await new Promise((res) => requestAnimationFrame(res));
    const preset = document.getElementById('zoomBtn').textContent.trim();
    // 缩回去，后面的截图别停在 8 倍
    document.getElementById('zoomBtn').click();
    document.querySelector('#zoomMenu button[data-zoom="1"]').click();
    return { spun, scale8: /matrix\\(8,/.test(scale), hasPresets, preset };
  })()`);
  check('画布放大上限 800%', zoom.spun === '800%' && zoom.scale8 && zoom.hasPresets && zoom.preset === '800%',
    JSON.stringify(zoom));

  // 圆形 dock / 视图工具
  const shapes = await page.evaluate(`(() => ({
    bar: getComputedStyle(document.getElementById('bar')).borderRadius,
    vt: getComputedStyle(document.getElementById('viewTools')).borderRadius,
    prime: getComputedStyle(document.querySelector('#bar .icon.prime')).borderRadius
  }))()`);
  check('dock / 视图工具为胶囊、白色加号为正圆',
    shapes.bar === '999px' && shapes.vt === '999px' && shapes.prime === '999px', JSON.stringify(shapes));

  // ---- 工作流弹窗：固定尺寸 + 左导航右内容 ----
  // 以前是顶部横向 tab + 内容自适应高度：4 个预设把窗口撑到 78vh，切到「添加工作流」内容变少，
  // 窗口又缩回去。这里盯两件事：尺寸不随 tab 变、导航真的在左边。
  await page.evaluate(`document.querySelector('#projectBar [data-act="add-workflow"]').click()`);
  await page.waitFor(`!document.querySelector('#modal').classList.contains('hidden')`, 6000);
  await new Promise((r) => setTimeout(r, 350));

  // 弹窗里不允许出现蓝色：扫描所有元素的文字/底色/描边/阴影，找明显偏蓝的 rgb
  // （b 比 r、g 都高出 40 以上）。主题色 #09caf5 会立刻被抓到。
  const blueHits = await page.evaluate(`(() => {
    const isBlue = (v) => {
      const m = String(v).match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
      if (!m) return false;
      const r = +m[1], g = +m[2], b = +m[3];
      return b > 120 && b - r > 40 && b - g > 40;
    };
    const hits = [];
    document.querySelectorAll('#modal *').forEach((el) => {
      const cs = getComputedStyle(el);
      ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'boxShadow'].forEach((p) => {
        if (isBlue(cs[p])) hits.push((el.className || el.tagName) + ' · ' + p);
      });
    });
    return [...new Set(hits)];
  })()`);
  check('弹窗里没有蓝色：选中条 / 卡片 / 描边都是中性色',
    blueHits.length === 0, JSON.stringify(blueHits));

  const modalBox = () => page.evaluate(`(() => {
    const s = document.querySelector('#modal .sheet').getBoundingClientRect();
    const nav = document.querySelector('#modalTabs').getBoundingClientRect();
    const panes = document.querySelector('.modal-panes').getBoundingClientRect();
    const tabs = [...document.querySelectorAll('#modalTabs .tab')];
    const tab = tabs[0];
    return {
      w: Math.round(s.width), h: Math.round(s.height),
      // 期望值按视口算：窗口够大时就是 1200×780，小屏被 max-width/max-height 兜底
      expectW: Math.min(1200, Math.round(innerWidth * 0.94)),
      expectH: Math.min(780, Math.round(innerHeight * 0.92)),
      sideBySide: Math.round(nav.right) <= Math.round(panes.left) + 1,
      navW: Math.round(nav.width), panesW: Math.round(panes.width),
      tabRadius: parseFloat(getComputedStyle(tab).borderRadius),
      tabDisplay: getComputedStyle(tab).display,
      icons: tabs.filter((t) => t.querySelector('.ico .oi')).length,
      labels: tabs.map((t) => (t.querySelector('span:last-child') || {}).textContent),
    };
  })()`);
  const mPreset = await modalBox();
  await page.evaluate(`document.querySelector('#modalTabs .tab[data-tab="paste"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const mPaste = await modalBox();
  check('弹窗标题改成「资产库」',
    (await page.evaluate(`document.querySelector('#modal .sheet header strong').textContent`)) === '资产库');
  check('工作流弹窗尺寸固定 1200×780：切到内容更少的「添加工作流」不变',
    mPreset.w === mPaste.w && mPreset.h === mPaste.h
      && Math.abs(mPreset.w - mPreset.expectW) <= 2 && Math.abs(mPreset.h - mPreset.expectH) <= 2,
    `${mPreset.w}×${mPreset.h} → ${mPaste.w}×${mPaste.h}（期望 ${mPreset.expectW}×${mPreset.expectH}）`);
  check('工作流弹窗是左右双栏：导航在左、内容在右，导航项不是胶囊',
    mPreset.sideBySide && mPreset.navW >= 180 && mPreset.navW <= 260
      && mPreset.panesW > mPreset.navW * 2 && mPreset.tabRadius <= 12,
    JSON.stringify(mPreset));
  check('左侧导航是「图标 + 名称」：4 个 tab 的图标都填上了，文字没被吃掉',
    mPreset.icons === 4 && mPreset.tabDisplay === 'flex'
      && mPreset.labels.join('|') === '内置预设|我的工作流库|ComfyUI 运行记录|添加工作流',
    JSON.stringify({ icons: mPreset.icons, display: mPreset.tabDisplay, labels: mPreset.labels }));
  // 开弹窗不该顺手去拉 ComfyUI 的运行记录（离线时那是 502，控制台先红一条）。
  // 这里只验「没预加载」，不点 history 标签——CI 里没有 ComfyUI，点了反而会真报错。
  const histPreload = await page.evaluate(`document.querySelector('#pane-history').children.length`);
  check('打开弹窗不预加载运行记录（点那个标签页才去问 ComfyUI）', histPreload === 0, `${histPreload} 个子节点`);
  await page.evaluate(`document.querySelector('#modalClose').click()`);
  await new Promise((r) => setTimeout(r, 300));

  // 回首页：列表里应有夹具画布，hash 改成 #home
  await page.click('#projectBar [data-act="home"]', { settle: 900 });
  const backHome = await page.evaluate(`(() => ({
    hash: location.hash,
    home: !document.getElementById('home').classList.contains('hidden'),
    cards: document.querySelectorAll('#recentList .proj-card').length,
    name: document.querySelector('#recentList .proj-card')?.textContent.trim().slice(0, 20) || ''
  }))()`);
  check('返回首页并改写 hash', backHome.hash === '#home' && backHome.home, JSON.stringify(backHome));
  check('最近项目里有夹具画布', backHome.cards >= 1 && /e2e 夹具画布/.test(backHome.name), backHome.name);

  // 设置弹层能开能关
  await page.evaluate(`document.querySelector('#recentList .proj-card .pm').click()`);
  await new Promise((r) => setTimeout(r, 900));
  await page.click('#projectBar [data-act="settings"]', { settle: 500 });
  const settingsOpen = await page.evaluate(`!!document.getElementById('appSettings')`);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  const settingsClosed = await page.evaluate(`(() => { const el = document.getElementById('appSettings'); return !el || el.classList.contains('hidden'); })()`);
  check('设置弹层开关', settingsOpen && settingsClosed);

  // ---- 多图结果：一次出 4 张时，另外 3 张必须看得见、翻得到 ----
  // 之前只有 7px 小圆点，用户报「生成多张只显示一张，其余无法显示」。
  // 用**独立项目**装一组 gallery（不需要真图，断言只看 DOM 与状态）：
  // 往正在打开的那个项目里 POST 会被页面的 beforeunload flush 覆盖，所以另起一个。
  const galId = await page.evaluate(`(async () => {
    // 用内联 SVG 当占位图：不需要真实文件，也就不会在控制台里留 404（那条断言要盯着控制台）
    const mk = (i) => ({ url: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="' + ['#c33', '#3c3', '#33c', '#cc3'][i] + '"/></svg>'), filename: 'k' + i + '.svg', subfolder: 'infisheet', type: 'output' });
    const cv = {
      version: 2, name: 'e2e 多图', seq: 2, bootAt: Date.now(), view: { x: 120, y: 80, k: 0.9 }, groups: [], links: [],
      nodes: [{
        id: 'g9', type: 'image', title: '多图', x: 40, y: 40, dataURL: null, uploaded: null,
        gen: { prompt: '多图', wf: 'preset:krea2-txt2img.api.json', aspect: '1:1', size: '1k', batch: 4,
          seedMode: 'fixed', seed: 7, gallery: [0, 1, 2, 3].map(mk), idx: 0, extras: [],
          // 生成历史：两条，第一条的 items 与 gallery 相同（所以它会被标成「当前」）
          runs: [
            { at: Date.now() - 1000, prompt: '第二版：雨夜霓虹', seed: 222, w: 1024, h: 1024, batch: 4,
              wf: 'preset:krea2-txt2img.api.json', items: [0, 1, 2, 3].map(mk) },
            { at: Date.now() - 60000, prompt: '第一版：晴天街角', seed: 111, w: 768, h: 768, batch: 2,
              wf: 'preset:krea2-txt2img.api.json', items: [1, 2].map(mk) },
            { at: Date.now() - 180000, prompt: '更早：胶片质感', seed: 99, w: 512, h: 512, batch: 1,
              wf: 'preset:krea2-txt2img.api.json', items: [3].map(mk) },
            { at: Date.now() - 600000, prompt: '最早：白底静物', seed: 7, w: 512, h: 512, batch: 1,
              wf: 'preset:krea2-txt2img.api.json', items: [0].map(mk) },
          ] },
      }],
    };
    cv.nodes[0].dataURL = cv.nodes[0].gen.gallery[0].url;
    const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e 多图' }) });
    const pr = await r.json();
    await fetch('/api/projects/' + pr.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvas: cv }) });
    localStorage.setItem('infisheet-project', pr.id);
    return 'g9';
  })()`);
  await page.evaluate(`(() => { location.hash = '#canvas'; location.reload(); return true; })()`);
  await page.waitFor(`!!document.querySelector('.node[data-id="${galId}"] .thumb')`, 15000);
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(`(() => {
    const card = document.querySelector('.node[data-id="${galId}"] .node-card');
    const b = card.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 14, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    card.dispatchEvent(new PointerEvent('pointerdown', o));
    card.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  const galState = () => page.evaluate(`(() => {
    const c = document.querySelector('.node[data-id="${galId}"]');
    if (!c) return { missing: true };
    const nav = c.querySelector('.img-nav .nav-btn');
    const im = c.querySelector('.thumb img');
    return {
      count: (c.querySelector('.img-count') || {}).textContent,
      on: [...c.querySelectorAll('.dots .dot-i')].findIndex((d) => d.classList.contains('on')),
      navVisible: nav ? getComputedStyle(nav).opacity : null,
      dots: c.querySelectorAll('.dots .dot-i').length,
      thumb: im ? im.getAttribute('src') : null,
    };
  })()`);
  const g0 = await galState();
  check('多图结果：图上直接标出「1 / 4」，箭头常显（不再只有看不见的小圆点）',
    g0.count === '1 / 4' && Number(g0.navVisible) > 0.3, JSON.stringify(g0));
  await page.evaluate(`document.querySelector('.node[data-id="${galId}"] .img-nav .next').click()`);
  await new Promise((r) => setTimeout(r, 450));
  const g1 = await galState();
  check('点右箭头翻到第 2 张：计数、圆点、图三者同步',
    g1.count === '2 / 4' && g1.on === 1 && g1.thumb !== g0.thumb, JSON.stringify(g1));
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 450));
  const g2 = await galState();
  check('选中节点时 ← 键翻回第 1 张',
    g2.count === '1 / 4' && g2.on === 0 && g2.thumb === g0.thumb, JSON.stringify(g2));
  await page.evaluate(`document.querySelector('.node[data-id="${galId}"] .img-zoom').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const lb1 = await page.evaluate(`(() => {
    const lb = document.querySelector('#lightbox');
    return { open: !lb.classList.contains('hidden'), count: lb.querySelector('.lb-count').textContent };
  })()`);
  await page.evaluate(`document.querySelector('#lightbox .lb-next').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const lb2 = await page.evaluate(`document.querySelector('#lightbox .lb-count').textContent`);
  // 图片节点的大图也要有同一张右侧详情抽屉（以前只有生成历史有）
  const lbInfoNode = await page.evaluate(`(() => {
    const box = document.querySelector('#lightboxInfo');
    if (!box || box.classList.contains('hidden')) return { hidden: true };
    return {
      opened: box.classList.contains('open'),
      rows: [...box.querySelectorAll('.lbi-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
      prompt: (box.querySelector('.lbi-prompt') || {}).textContent,
    };
  })()`);
  check('图片节点的大图也带右侧抽屉：来源/工作流/种子 + 这一组 2 / 4',
    lbInfoNode.opened && lbInfoNode.rows.join('|').includes('生成')
      && /这一组\s*2 \/ 4/.test(lbInfoNode.rows.join('|'))
      && lbInfoNode.prompt === '多图',
    JSON.stringify(lbInfoNode));
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  const lbClosed = await page.evaluate(`document.querySelector('#lightbox').classList.contains('hidden')`);
  check('大图预览也能翻页（1/4 → 2/4），Esc 关闭',
    lb1.open && lb1.count === '1 / 4' && lb2 === '2 / 4' && lbClosed, `${lb1.count} → ${lb2} closed=${lbClosed}`);

  // ---- 生成历史：宫格缩略图，单击看大图 + 分辨率/提示词/参数 ----
  // 以前 gen.gallery 是覆盖式的：试到第 4 版最好，但已经回不去了。
  const hb = await page.evaluate(`(() => {
    const b = document.querySelector('.node[data-id="${galId}"] .img-hist');
    if (!b) return { missing: true };
    const cs = getComputedStyle(b);
    return { text: b.textContent, right: cs.right, bottom: cs.bottom };
  })()`);
  check('生成过就出现「N 次」角标（右下角，和左下角的 1 / 4 对称）',
    hb.text === '4 次' && hb.right !== 'auto' && hb.bottom !== 'auto', JSON.stringify(hb));

  const openRuns = async () => {
    await page.evaluate(`document.querySelector('.node[data-id="${galId}"] .img-hist').click()`);
    await new Promise((r) => setTimeout(r, 350));
  };
  // 现算一处真正空着的位置（不在节点 / 浮层 / 工具条上）。不写死坐标：
  // 这一节本身在往画布上加节点，写死的点迟早点到东西上。
  const findBlankPt = () => page.evaluate(`(() => {
    for (let y = 120; y < window.innerHeight - 80; y += 30) {
      for (let x = 140; x < window.innerWidth - 80; x += 40) {
        const t = document.elementFromPoint(x, y);
        if (t && t.closest && !t.closest('.node, .group, .popmenu, #bar, #dockWrap, #viewTools, #queuePanel, #statusChip, #projectBar')) return { x, y };
      }
    }
    return null;
  })()`);
  const gridState = () => page.evaluate(`(() => {
    const g = document.querySelector('.run-list .run-grid');
    if (!g) return { missing: true };
    const cells = [...g.querySelectorAll('.run-cell')];
    const r = cells.map((c) => c.getBoundingClientRect());
    const box = cells.map((c) => c.querySelector('.rc-img').getBoundingClientRect());
    return {
      cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
      n: cells.length,
      w: Math.round(box[0].width), h: Math.round(box[0].height),   // 缩略图要方，不是整个格子（格子还含时间行）
      step: r[3] ? Math.round(r[3].top - r[0].top) : 0,
      on: cells.map((c) => c.classList.contains('on')),
      badges: cells.map((c) => (c.querySelector('.rc-n') || {}).textContent || ''),
      times: cells.map((c) => (c.querySelector('.rc-time') || {}).textContent || ''),
    };
  })()`);

  await openRuns();
  const grid0 = await gridState();
  check('生成历史是宫格：3 列、格子是正方形、第二行整行落在第一行之下',
    grid0.cols === 3 && grid0.n === 4 && Math.abs(grid0.w - grid0.h) <= 2 && grid0.step >= grid0.h + 6,
    JSON.stringify(grid0));
  check('宫格按新→旧排，当前那格标「当前」，多图的格子带张数角标',
    grid0.on[0] === true && grid0.on.slice(1).every((x) => !x)
      && grid0.badges[0] === '4 张' && grid0.times[0].includes('当前'),
    JSON.stringify({ on: grid0.on, badges: grid0.badges, times: grid0.times }));

  // 单击第一格 → 大图 + 信息卡
  await page.evaluate(`document.querySelector('.run-list .run-cell').click()`);
  await new Promise((r) => setTimeout(r, 550));
  const info = await page.evaluate(`(() => {
    const box = document.querySelector('#lightboxInfo');
    if (!box || box.classList.contains('hidden')) return { hidden: true };
    const r = box.getBoundingClientRect();
    const img = document.querySelector('#lightboxImg').getBoundingClientRect();
    return {
      dim: (box.querySelector('.lbi-dim') || {}).textContent,
      rows: [...box.querySelectorAll('.lbi-row')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()),
      prompt: (box.querySelector('.lbi-prompt') || {}).textContent,
      acts: [...box.querySelectorAll('.lbi-btn')].map((b) => b.textContent),
      count: (document.querySelector('#lightbox .lb-count') || {}).textContent,
      opened: box.classList.contains('open'),
      right: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      vw: innerWidth, vh: innerHeight,
      imgRight: Math.round(img.right),
    };
  })()`);
  check('单击宫格里的图 → 大图打开，旁边列出分辨率 / 参数 / 提示词',
    !info.hidden && /^\d+ × \d+$/.test(info.dim) && /种子\s*222/.test(info.rows.join('|'))
      && info.prompt === '第二版：雨夜霓虹' && info.acts.join() === '换回节点,派生到新节点'
      && info.count === '1 / 4', JSON.stringify(info));

  check('详情是贴右侧的抽屉：整屏高、贴右边、图片让出等宽不重叠',
    info.opened && Math.abs(info.right - info.vw) <= 1 && info.top === 0
      && Math.abs(info.h - info.vh) <= 1 && info.w >= 300 && info.w <= 440
      && info.imgRight <= info.right - info.w + 1,
    JSON.stringify({ right: info.right, vw: info.vw, w: info.w, h: info.h, vh: info.vh, imgRight: info.imgRight }));

  // 点信息卡（选文字 / 点按钮）不该把大图关掉
  await page.evaluate(`document.querySelector('#lightboxInfo .lbi-prompt').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const stillOpen = await page.evaluate(`!document.querySelector('#lightbox').classList.contains('hidden')`);
  check('点信息卡不会顺手关掉大图', stillOpen);
  await page.evaluate(`document.querySelector('#lightbox').click()`);
  await new Promise((r) => setTimeout(r, 250));

  // 「换回节点」：第 2 格（2 张）换回后，节点从 1 / 4 变成 1 / 2
  await openRuns();
  await page.evaluate(`document.querySelectorAll('.run-list .run-cell')[1].click()`);
  await new Promise((r) => setTimeout(r, 550));
  await page.evaluate(`document.querySelector('#lightboxInfo .lbi-btn').click()`);
  await new Promise((r) => setTimeout(r, 450));
  const afterView = await page.evaluate(`(() => {
    const c = document.querySelector('.node[data-id="${galId}"]');
    return { count: (c.querySelector('.img-count') || {}).textContent,
      dots: c.querySelectorAll('.dots .dot-i').length };
  })()`);
  await openRuns();
  const grid1 = await gridState();
  check('「换回节点」把那一批换回节点：4 张变 2 张，「当前」标记跟着移过去',
    afterView.count === '1 / 2' && afterView.dots === 2 && grid1.on[1] === true && grid1.on[0] === false,
    JSON.stringify({ afterView, on: grid1.on }));

  // 「派生到新节点」：参数整套复制，种子钉住那次
  await page.evaluate(`document.querySelectorAll('.run-list .run-cell')[0].click()`);
  await new Promise((r) => setTimeout(r, 550));
  await page.evaluate(`document.querySelectorAll('#lightboxInfo .lbi-btn')[1].click()`);
  await new Promise((r) => setTimeout(r, 1100));
  const derived = await page.evaluate(`(async () => {
    const id = localStorage.getItem('infisheet-project');
    const j = await (await fetch('/api/projects/' + id)).json();
    const ns = j.canvas.nodes;
    const born = ns.filter((x) => x.type === 'image' && x.gen && x.gen.seed === 222)[0];
    return {
      total: ns.length,
      born: born ? { prompt: born.gen.prompt, seed: born.gen.seed, seedMode: born.gen.seedMode,
        runs: (born.gen.runs || []).length, gallery: (born.gen.gallery || []).length } : null,
    };
  })()`);
  check('「派生」把参数复制到新节点：种子钉住那次、历史跟着带一条、原节点不动',
    !!derived.born && derived.born.seed === 222 && derived.born.seedMode === 'fixed'
      && derived.born.prompt.includes('雨夜霓虹') && derived.born.runs === 1 && derived.born.gallery === 4,
    JSON.stringify(derived));

  // ---- 提示词来自「提示词节点」时，大图详情也要显示那段词 ----
  // 以前详情只读 gen.prompt（面板里那段），而连了文本节点时面板里是空的、真正出图用的是
  // 文本节点里的字 —— 于是这类图在大图详情里永远写着「（没有关联的提示词）」。
  // 夹具里 t1 → i2 就是这种接法，但 i2 没有图（打不开大图），所以在多图节点上现接一个文本节点。
  const tBlank = await findBlankPt();
  check('能找到一处空白用来双击新建节点', !!tBlank, JSON.stringify(tBlank));

  // ---- 双击菜单的样子：分组 + 图标 + 键盘 ----
  // 以前是五条光秃秃的文字按钮（132px 宽、没有分组也没有图标），扫一眼分不清
  // 「能落到画布上的节点」和「要先去选工作流的入口」。
  const addMenuUi = await page.evaluate(`(async () => {
    const st = document.getElementById('stage');
    const x = ${tBlank ? tBlank.x : 300}, y = ${tBlank ? tBlank.y : 300};
    st.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }));
    await new Promise((r) => setTimeout(r, 160));
    const m = document.getElementById('addMenu');
    const items = [...m.querySelectorAll('.am-item')];
    const r = m.getBoundingClientRect();
    return {
      open: !m.classList.contains('hidden'),
      titles: [...m.querySelectorAll('.am-title')].map((e) => e.textContent.trim()),
      labels: items.map((b) => b.textContent.trim()),
      seps: m.querySelectorAll('.am-sep').length,
      rows: items.map((b) => {
        const rb = b.getBoundingClientRect();
        const ic = b.querySelector('.am-ico');
        const lb = b.querySelector('.am-label');
        const ir = ic ? ic.getBoundingClientRect() : null;
        const lr = lb ? lb.getBoundingClientRect() : null;
        return {
          h: Math.round(rb.height),
          icoW: ir ? Math.round(ir.width) : 0,
          // 图标要在文案左边，并且留出间距（0 说明图标丢了或者叠在字上）
          ind: ir && lr ? Math.round(lr.left - ir.right) : -1,
          svg: !!(ic && ic.querySelector('svg')),
        };
      }),
      // 光标不能压在菜单上：不然刚双击完，第一项就在手底下
      coversCursor: x > r.left && x < r.right && y > r.top && y < r.bottom,
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    };
  })()`);
  check('双击空白 → 菜单分「新建节点 / 工作流」两组，六项都带图标且在文案左边',
    addMenuUi.open && addMenuUi.titles.join('/') === '新建节点/工作流'
      && addMenuUi.labels.length === 6 && addMenuUi.seps === 1
      && addMenuUi.labels[2] === '加载图片…'
      && addMenuUi.rows.every((r) => r.svg && r.icoW >= 14 && r.ind >= 6 && r.h >= 28)
      && new Set(addMenuUi.rows.map((r) => r.h)).size === 1,
    JSON.stringify(addMenuUi));
  check('双击菜单不会开在光标底下，也不会跑出屏幕',
    !addMenuUi.coversCursor && addMenuUi.inView, JSON.stringify(addMenuUi));

  // 键盘：↓ 走到第一项，再 ↓ 到第二项，Esc 关掉
  const addMenuKeys = await page.evaluate(`(async () => {
    const m = document.getElementById('addMenu');
    const key = (k) => m.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const first = m.focus === undefined ? null : (document.activeElement === m);
    key('ArrowDown');
    const one = (document.activeElement.textContent || '').trim();
    key('ArrowDown');
    const two = (document.activeElement.textContent || '').trim();
    key('Escape');
    await new Promise((r) => setTimeout(r, 100));
    return { focusedMenu: first, one, two, closed: m.classList.contains('hidden') };
  })()`);
  check('双击菜单能用键盘选（↓ 走第一项、再 ↓ 走第二项、Esc 关闭）',
    addMenuKeys.focusedMenu && addMenuKeys.one === '提示词' && addMenuKeys.two === '图片'
      && addMenuKeys.closed, JSON.stringify(addMenuKeys));

  // ---- 「加载图片…」：选完就带着图，不是空白节点 ----
  // 系统选择框在无头环境里点不出来，所以这里直接喂 File 给那个 input（和真人选完文件后
  // 浏览器自己派发的 change 是同一个入口）。
  const pickUi = await page.evaluate(`(async () => {
    const st = document.getElementById('stage');
    const x = ${tBlank ? tBlank.x : 300}, y = ${tBlank ? tBlank.y : 300};
    st.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const m = document.getElementById('addMenu');
    const items = [...m.querySelectorAll('.am-item')];
    const target = items.find((b) => b.textContent.trim() === '加载图片…');
    if (!target) return { missing: true, labels: items.map((b) => b.textContent.trim()) };
    target.click();
    await new Promise((r) => setTimeout(r, 150));
    const inp = document.getElementById('imgPicker');
    return {
      menuClosed: m.classList.contains('hidden'),
      input: inp ? { type: inp.type, multiple: inp.multiple, accept: inp.accept } : null,
      nodes: document.querySelectorAll('#nodes .node').length,
    };
  })()`);
  check('点「加载图片…」→ 弹出的是选图片的文件框（可多选），菜单自己收起来',
    !pickUi.missing && pickUi.menuClosed && !!pickUi.input
      && pickUi.input.type === 'file' && pickUi.input.multiple && /image/.test(pickUi.input.accept),
    JSON.stringify(pickUi));

  const pickRes = await page.evaluate(`(async () => {
    const inp = document.getElementById('imgPicker');
    const beforeIds = [...document.querySelectorAll('#nodes .node')].map((e) => e.dataset.id);
    // 用真的 PNG（canvas 造的）：SVG 上传进 ComfyUI 后 /api/view 取不回来，测的就不是这条链路了。
    // 另外断言只看「图解码出来了没有」，不看 src 是 data: 还是 /api/view：ComfyUI 开着会上传换 URL，
    // 没开就留在 dataURL —— 两种都算成功。
    const mk = (name, color) => new Promise((res) => {
      const cv = document.createElement('canvas');
      cv.width = 120; cv.height = 80;
      const g = cv.getContext('2d');
      g.fillStyle = color; g.fillRect(0, 0, 120, 80);
      cv.toBlob((b) => res(new File([b], name, { type: 'image/png' })), 'image/png');
    });
    const dt = new DataTransfer();
    dt.items.add(await mk('probe-a.png', '#3a7b5e'));
    dt.items.add(await mk('probe-b.png', '#a37b4e'));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    // 节点是先建出来、再读文件再填图的（dataURL 是 await 出来的），所以不能只看节点数：
    // 得等新节点的 <img> 真的解码出来（naturalWidth > 0）。
    const freshIds = () => [...document.querySelectorAll('#nodes .node')]
      .map((e) => e.dataset.id).filter((id) => !beforeIds.includes(id));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const ids = freshIds();
      const done = ids.length >= 2 && ids.every((id) => {
        const im = document.querySelector('#nodes .node[data-id="' + id + '"] .thumb img');
        return im && im.naturalWidth > 0;
      });
      if (done) break;
    }
    const rows = freshIds().map((id) => {
      const el = document.querySelector('#nodes .node[data-id="' + id + '"]');
      const im = el && el.querySelector('.thumb img');
      const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
      return {
        id,
        title: (el && el.querySelector('.n-name') || {}).textContent || '',
        w: im ? im.naturalWidth : 0, h: im ? im.naturalHeight : 0,
        x: Math.round(r.left), y: Math.round(r.top),
        // 纯图片节点：下面不该有生成面板，标题上该有一颗「生成」药丸
        panels: el ? el.querySelectorAll('.gen-panel').length : -1,
        pill: ((el && el.querySelector('.n-genon')) || {}).textContent || '',
      };
    });
    return { added: rows.length, rows };
  })()`);
  check('选两张图 → 画布多两个图片节点，图直接带着（不是空白节点）、两张错开不叠在一起',
    pickRes.added === 2
      && pickRes.rows.every((r) => r.title === '图片' && r.w === 120 && r.h === 80)
      && Math.abs(Math.abs(pickRes.rows[1].x - pickRes.rows[0].x) - 30) <= 6
      && Math.abs(Math.abs(pickRes.rows[1].y - pickRes.rows[0].y) - 30) <= 6,
    JSON.stringify(pickRes));

  check('「加载图片…」进来的是**纯图片节点**：下面没有生成面板，标题上有一颗「生成」药丸',
    pickRes.added === 2 && pickRes.rows.every((r) => r.panels === 0 && r.pill === '生成'),
    JSON.stringify(pickRes.rows.map((r) => ({ panels: r.panels, pill: r.pill }))));

  // 点药丸 → 面板长出 + 存档里的 plain 消失（否则刷新后又被当纯图片节点，面板白开了）。
  // 同时看另一张：它的 plain:true 必须**在存档里**，不然刷新后那张图下面会冒出一整块生成器。
  const plainToggle = await page.evaluate(`(async () => {
    const id = ${JSON.stringify(pickRes.rows[0].id)};
    const el = document.querySelector('#nodes .node[data-id="' + id + '"]');
    const pill = el.querySelector('.n-genon');
    if (!pill) return { missing: true };
    pill.click();
    await new Promise((r) => setTimeout(r, 600));
    const after = document.querySelector('#nodes .node[data-id="' + id + '"]');
    return {
      panels: after.querySelectorAll('.gen-panel').length,
      pillGone: !after.querySelector('.n-genon'),
      promptBox: !!after.querySelector('.gen-prompt'),
    };
  })()`);
  check('点「生成」药丸 → 生成面板出现（含提示词框），药丸自己消失',
    !plainToggle.missing && plainToggle.panels === 1 && plainToggle.pillGone && plainToggle.promptBox,
    JSON.stringify(plainToggle));

  const plainSaved = await page.evaluate(`(async () => {
    await new Promise((r) => setTimeout(r, 700));
    const pid = localStorage.getItem('infisheet-project');
    const j = await (await fetch('/api/projects/' + pid)).json();
    const cv = j.canvas || {};
    const pick = (id) => (cv.nodes || []).find((n) => n.id === id) || {};
    return {
      opened: pick(${JSON.stringify(pickRes.rows[0].id)}).plain === undefined,
      kept: pick(${JSON.stringify(pickRes.rows[1].id)}).plain === true,
      openedGen: !!pick(${JSON.stringify(pickRes.rows[0].id)}).gen,
      rows: (cv.nodes || []).length,
    };
  })()`);
  check('存档里带着 plain：开了面板的那张没了这个标记，另一张仍有（刷新后不会凭空长出生成器）',
    plainSaved.opened && plainSaved.kept && plainSaved.openedGen, JSON.stringify(plainSaved));

  // 收尾：删掉这两张，别挡住后面用例要双击的那块空白
  await page.evaluate(`(() => {
    ${JSON.stringify(pickRes.rows.map((r) => r.id))}.forEach((id) => {
      const el = document.querySelector('#nodes .node[data-id="' + id + '"]');
      const del = el && el.querySelector('.n-del');
      if (del) del.click();
    });
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  // ---- 拖文件进来：得和「加载图片…」长一样的节点（纯图片节点，不挂生成面板）----
  // 两条入口给的东西不一致的话，用户会觉得「我拖进来的怎么有面板」。所以一起钉住。
  const dropRes = await page.evaluate(`(async () => {
    const st = document.getElementById('stage');
    const beforeIds = [...document.querySelectorAll('#nodes .node')].map((e) => e.dataset.id);
    const mk = () => new Promise((res) => {
      const cv = document.createElement('canvas');
      cv.width = 160; cv.height = 100;
      const g = cv.getContext('2d');
      g.fillStyle = '#4a6f8a'; g.fillRect(0, 0, 160, 100);
      cv.toBlob((b) => res(new File([b], 'dropped.png', { type: 'image/png' })), 'image/png');
    });
    const dt = new DataTransfer();
    dt.items.add(await mk());
    const x = ${tBlank ? tBlank.x : 300}, y = ${tBlank ? tBlank.y : 300};
    st.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const freshIds = () => [...document.querySelectorAll('#nodes .node')]
      .map((e) => e.dataset.id).filter((id) => !beforeIds.includes(id));
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const ids = freshIds();
      if (ids.length === 1) {
        const im = document.querySelector('#nodes .node[data-id="' + ids[0] + '"] .thumb img');
        if (im && im.naturalWidth > 0) break;
      }
    }
    const ids = freshIds();
    const el = ids.length === 1 ? document.querySelector('#nodes .node[data-id="' + ids[0] + '"]') : null;
    const im = el && el.querySelector('.thumb img');
    return {
      added: ids.length,
      id: ids[0] || '',
      panels: el ? el.querySelectorAll('.gen-panel').length : -1,
      pill: ((el && el.querySelector('.n-genon')) || {}).textContent || '',
      w: im ? im.naturalWidth : 0, h: im ? im.naturalHeight : 0,
    };
  })()`);
  check('拖一张图进画布 → 建出来的也是纯图片节点（无生成面板、标题有「生成」药丸）',
    dropRes.added === 1 && dropRes.panels === 0 && dropRes.pill === '生成'
      && dropRes.w === 160 && dropRes.h === 100,
    JSON.stringify(dropRes));

  await page.evaluate(`(() => {
    const el = document.querySelector('#nodes .node[data-id="${dropRes.id}"]');
    const del = el && el.querySelector('.n-del');
    if (del) del.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  const textId = await page.evaluate(`(async () => {
    const st = document.getElementById('stage');
    const x = ${tBlank ? tBlank.x : 300}, y = ${tBlank ? tBlank.y : 300};
    st.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const b = [...document.querySelectorAll('#addMenu button')].find((x) => x.textContent === '提示词');
    if (!b) return null;
    b.click();
    await new Promise((r) => setTimeout(r, 250));
    const el = [...document.querySelectorAll('#nodes .node.text')].pop();
    if (!el) return null;
    const ta = el.querySelector('textarea');
    ta.value = '来自提示词节点：雨夜巷口，霓虹反光';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return el.dataset.id;
  })()`);
  // 把它连到多图节点：从输出口拖到目标输入口
  const linkAdded = await page.evaluate(`(async () => {
    const src = document.querySelector('.node[data-id="${textId}"] .port.out');
    const dst = document.querySelector('.node[data-id="${galId}"] .port.in');
    if (!src || !dst) return null;
    const a = src.getBoundingClientRect(), b = dst.getBoundingClientRect();
    const from = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
    const to = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    src.dispatchEvent(new PointerEvent('pointerdown', { clientX: from.x, clientY: from.y, bubbles: true, button: 0, pointerId: 11 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.x, clientY: to.y, bubbles: true, pointerId: 11 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: to.x, clientY: to.y, bubbles: true, pointerId: 11 }));
    await new Promise((r) => setTimeout(r, 350));
    return document.querySelectorAll('#links .link-line').length;
  })()`);
  check('新建的提示词节点能连到图片节点（连线数 +1）', !!textId && linkAdded === 1,
    JSON.stringify({ textId, linkAdded }));

  await page.evaluate(`document.querySelector('.node[data-id="${galId}"] .img-zoom').click()`);
  await new Promise((r) => setTimeout(r, 450));
  const lbText = await page.evaluate(`(() => {
    const box = document.querySelector('#lightboxInfo');
    if (!box || box.classList.contains('hidden')) return { hidden: true };
    return {
      rows: [...box.querySelectorAll('.lbi-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
      prompt: (box.querySelector('.lbi-prompt') || {}).textContent,
    };
  })()`);
  check('用提示词节点出的图，大图详情里显示那段词（不再写「没有关联的提示词」）',
    !lbText.hidden && lbText.prompt === '来自提示词节点：雨夜巷口，霓虹反光'
      && lbText.rows.some((r) => /^提示词来自\s*文本节点/.test(r)),
    JSON.stringify(lbText));
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));

  // ---- 图片节点：无边 / 尺寸进标题 / 端口外浮 ----
  // 先点一下空白把选中清掉：选中态本身有一圈描边投影，量「有没有边框」会被它干扰。
  // 空白点现算：上面刚加过一个节点，写死坐标迟早点到东西上。
  const blankPt = await findBlankPt();

  if (blankPt) {
    await page.evaluate(`(() => {
      const st = document.getElementById('stage');
      st.dispatchEvent(new PointerEvent('pointerdown', { clientX: ${blankPt.x}, clientY: ${blankPt.y}, bubbles: true, button: 0, pointerId: 8 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: ${blankPt.x}, clientY: ${blankPt.y}, bubbles: true, button: 0, pointerId: 8 }));
    })()`);
    await new Promise((r) => setTimeout(r, 200));
  }

  const imgLook = await page.evaluate(`(() => {
    const node = [...document.querySelectorAll('#nodes .node.image')].find((n) => n.querySelector('.thumb img'));
    if (!node) return null;
    const card = node.querySelector('.node-card');
    const cs = getComputedStyle(card);
    const title = node.querySelector('.node-title');
    const dim = title.querySelector('.n-dim');
    const port = node.querySelector('.port.out').getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    return {
      border: cs.borderTopWidth,
      bg: cs.backgroundColor,
      shadow: cs.boxShadow,
      dim: dim ? dim.textContent.trim() : null,
      dimInTitle: !!dim && title.contains(dim),
      oldBadge: !!node.querySelector('.img-dim'),
      gap: Math.round(port.left - cr.right),
    };
  })()`);
  check('图片节点是无边的：卡片不画边框 / 背景 / 投影，画面自己就是边缘',
    imgLook && imgLook.border === '0px' && imgLook.bg === 'rgba(0, 0, 0, 0)'
      && (imgLook.shadow === 'none' || imgLook.shadow === 'rgba(0, 0, 0, 0) 0px 0px 0px 0px'),
    JSON.stringify(imgLook));
  check('图片名称与像素尺寸在同一行（不再浮在图片右上角挡画面）',
    imgLook && imgLook.dimInTitle && /^\d+ × \d+$/.test(imgLook.dim || '') && !imgLook.oldBadge,
    `dim=${imgLook && imgLook.dim} old=${imgLook && imgLook.oldBadge}`);
  check('端口浮在节点外侧、和卡片留出缝（不是压在边缘上）',
    imgLook && imgLook.gap >= 6, `gap=${imgLook && imgLook.gap}px`);

  // 顶部进度条只留给工作流节点（它运行时没有中央遮罩可用）。图片节点的卡片顶就是画面顶，
  // 怎么摆都会压住图片，而中央那块「生成中 42%」已经把同样的信息盖在图上；文本节点根本不跑。
  const barScope = await page.evaluate(`(() => ({
    image: document.querySelectorAll('#nodes .node.image .node-progress').length,
    text: document.querySelectorAll('#nodes .node.text .node-progress').length,
    wf: document.querySelectorAll('#nodes .node.wf .node-progress').length,
    all: document.querySelectorAll('#nodes .node-progress').length,
    overlays: document.querySelectorAll('#nodes .node.image .gen-overlay').length,
  }))()`);
  check('顶部进度条只画在工作流节点上（图片/文本节点不再画）',
    barScope.image === 0 && barScope.text === 0 && barScope.all === barScope.wf && barScope.overlays > 0,
    JSON.stringify(barScope));

  // 图片框要跟着图片的实际比例走：以前按 clientWidth 算一个高度写上去，又被 min-height:200
  // 顶住，2:1 的图上下就各补一条黑边（用户圈出来的就是那两条）。横图、竖图各量一次。
  const ratioFit = await page.evaluate(`(async () => {
    const im = document.querySelector('#nodes .node.image .thumb img');
    if (!im) return { missing: true };
    const measure = async (w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#3c5a8c'; g.fillRect(0, 0, w, h);
      await new Promise((res) => { im.addEventListener('load', res, { once: true }); im.src = c.toDataURL('image/png'); });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t = im.closest('.thumb');
      const tr = t.getBoundingClientRect();
      const ir = im.getBoundingClientRect();
      return {
        boxW: Math.round(tr.width), boxH: Math.round(tr.height),
        imgRatio: +(w / h).toFixed(3),
        boxRatio: +(tr.width / tr.height).toFixed(3),
        // 图片自身的盒子比例＝原图比例，说明没有一条边是被 contain 补出来的
        pxRatio: +(ir.width / ir.height).toFixed(3),
        minH: getComputedStyle(t).minHeight,
      };
    };
    // 1:2.5 足够高，会撞到 760px 的高度上限 —— 正是以前 left/right 补黑边的那条路径
    return { wide: await measure(800, 400), tall: await measure(400, 1000) };
  })()`);
  const tight = (m) => !!m && Math.abs(m.boxRatio - m.imgRatio) <= 0.02
    && Math.abs(m.pxRatio - m.imgRatio) <= 0.02 && m.minH === '0px';
  check('图片框按图片实际比例自适应（2:1 的图不再上下补黑边）',
    !!ratioFit && !ratioFit.missing && tight(ratioFit.wide),
    JSON.stringify(ratioFit && ratioFit.wide));
  check('竖图（1:2）框也跟着收窄，不会左右补黑边',
    !!ratioFit && !ratioFit.missing && tight(ratioFit.tall),
    JSON.stringify(ratioFit && ratioFit.tall));

  // ---- 连线拖到空白：弹出的「接一个节点」不选也要能点空白关掉 ----
  const linkOut = await page.evaluate(`(() => {
    const p = document.querySelector('#nodes .node .port.out');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check('画布上能找到节点的输出口和一处空白（连线菜单的前置条件）', !!blankPt && !!linkOut,
    JSON.stringify({ blankPt, linkOut }));
  if (blankPt && linkOut) {
    await page.evaluate(`(() => {
      const p = document.querySelector('#nodes .node .port.out');
      p.dispatchEvent(new PointerEvent('pointerdown', { clientX: ${linkOut.x}, clientY: ${linkOut.y}, bubbles: true, button: 0, pointerId: 9 }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: ${blankPt.x}, clientY: ${blankPt.y}, bubbles: true, pointerId: 9 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: ${blankPt.x}, clientY: ${blankPt.y}, bubbles: true, pointerId: 9 }));
    })()`);
    await new Promise((r) => setTimeout(r, 150));
    const menu = await page.evaluate(`(() => {
      const m = document.querySelector('.popmenu');
      return m ? { title: (m.querySelector('.popmenu-title') || {}).textContent, n: m.querySelectorAll('button').length } : null;
    })()`);
    check('从输出口拖到空白松手 → 弹出「接一个节点」', !!menu && menu.title === '接一个节点' && menu.n >= 2,
      JSON.stringify(menu));
    await page.evaluate(`(() => {
      const st = document.getElementById('stage');
      st.dispatchEvent(new PointerEvent('pointerdown', { clientX: ${blankPt.x}, clientY: ${blankPt.y}, bubbles: true, button: 0, pointerId: 10 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: ${blankPt.x}, clientY: ${blankPt.y}, bubbles: true, button: 0, pointerId: 10 }));
    })()`);
    await new Promise((r) => setTimeout(r, 150));
    check('什么都不选、点一下画布空白 → 菜单自动消失',
      await page.evaluate(`!document.querySelector('.popmenu')`));
  }

  // ---- 资产管理：生成结果 / 上传素材 / 画布上的图，一个抽屉里收齐 ----
  // 断言一律用「相对」关系（徽章全是什么、筛选后剩下几项），因为 /api/assets 在本机
  // 连得上 ComfyUI 时会多出几十条真实产物，写死格子数会变成环境依赖。
  await page.evaluate(`document.querySelector('[data-act="assets"]').click()`);
  await page.waitFor(`!!document.querySelector('#assetPane .asset-cell')`, 12000);
  await new Promise((r) => setTimeout(r, 600));

  const hit = (k) => page.evaluate(`[...document.querySelectorAll('#assetPane .asset-tabs button')].find((b) => b.dataset.k === '${k}').click()`);
  const paneState = () => page.evaluate(`(() => {
    const p = document.querySelector('#assetPane');
    if (!p) return { missing: true };
    const cells = [...p.querySelectorAll('.asset-cell')];
    return {
      n: cells.length,
      count: (p.querySelector('.asset-n') || {}).textContent,
      on: (p.querySelector('.asset-tabs button.on') || {}).dataset?.k,
      badges: [...new Set([...p.querySelectorAll('.asset-badge')].map((b) => b.textContent))],
      names: cells.map((c) => (c.querySelector('.asset-name') || {}).textContent),
      tip: (p.querySelector('.asset-tip') || {}).textContent,
    };
  })()`);

  const a0 = await paneState();
  check('点顶栏「资产」弹出抽屉：画布上的 4 张多图结果全部列出来（不是只列当前显示的那张）',
    a0.n >= 4 && a0.count === `${a0.n} 项` && a0.badges.includes('画布')
      && ['k0.svg', 'k1.svg', 'k2.svg', 'k3.svg'].every((k) => a0.names.slice(0, a0.n).includes(k)),
    JSON.stringify({ n: a0.n, count: a0.count, badges: a0.badges, names: a0.names.slice(0, 4) }));

  // 第一版用 <button> + aspect-ratio，行高按内容算成 28px，117px 的图整片糊在上一行上。
  // 这条断言专门盯那个症状：格子得是方的，且第二行必须落在第一行下面，不能压上来。
  const aGeo = await page.evaluate(`(() => {
    const r = [...document.querySelectorAll('#assetPane .asset-cell')].map((c) => c.getBoundingClientRect());
    return { n: r.length, w: Math.round(r[0].width), h: Math.round(r[0].height), step: Math.round(r[3].top - r[0].top) };
  })()`);
  check('资产格子是正方形，且第二行整行落在第一行之下（不重叠）',
    Math.abs(aGeo.w - aGeo.h) <= 2 && aGeo.step >= aGeo.h + 6, JSON.stringify(aGeo));

  // 计数文案有两种形态：还有别的来源时是「4 / 59 项」，只剩一个来源时退化成「4 项」
  // （app.js: `list.length === total ? total + ' 项' : list.length + ' / ' + total + ' 项'`）。
  // CI 里没有 ComfyUI，资产只有画布那几张 → 全部 == 画布 → 走的是「4 项」这一支，
  // 所以这里只断言「前导数字 = 筛选后的格子数」，不能写死「4 / N 项」。
  const countOf = (txt, n) => txt === `${n} 项` || new RegExp(`^${n} / \\d+ 项$`).test(txt || '');

  await hit('canvas');
  await new Promise((r) => setTimeout(r, 350));
  const aC = await paneState();
  check('筛「画布」只剩画布上的图，且计数按筛选结果算',
    aC.on === 'canvas' && aC.n === 4 && aC.badges.join() === '画布' && countOf(aC.count, aC.n),
    JSON.stringify(aC));

  await hit('output');
  await new Promise((r) => setTimeout(r, 350));
  const aO = await paneState();
  check('筛「生成」不会混进画布图 / 上传图（没结果就明说是空的）',
    aO.on === 'output' && (aO.n === 0 ? /还没有资产/.test(aO.tip || '') : aO.badges.join() === '生成'),
    JSON.stringify({ n: aO.n, badges: aO.badges, tip: aO.tip }));

  await hit('all');
  await page.evaluate(`(() => {
    const q = document.querySelector('#assetPane .asset-q');
    q.value = 'k0.svg';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  const aQ = await paneState();
  check('搜索按文件名过滤（k0.svg 只剩 1 项）', aQ.n === 1 && aQ.names[0] === 'k0.svg', JSON.stringify(aQ.names));

  // 清空搜索 → 单击开大图 → 翻页 → Esc 只关大图，抽屉留着
  await page.evaluate(`(() => {
    const q = document.querySelector('#assetPane .asset-q');
    q.value = '';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  // 大图列表就是当前筛选结果，翻页能一直翻到底——总数按当场的格子数算，不写死
  const nAll = await page.evaluate(`document.querySelectorAll('#assetPane .asset-cell').length`);
  await page.evaluate(`document.querySelector('#assetPane .asset-cell').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const lbA = await page.evaluate(`(() => {
    const lb = document.querySelector('#lightbox');
    return { open: !lb.classList.contains('hidden'), count: lb.querySelector('.lb-count').textContent };
  })()`);
  const lbInfoAsset = await page.evaluate(`(() => {
    const box = document.querySelector('#lightboxInfo');
    if (!box || box.classList.contains('hidden')) return { hidden: true };
    return {
      opened: box.classList.contains('open'),
      rows: [...box.querySelectorAll('.lbi-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
    };
  })()`);
  check('资产抽屉里的大图也带抽屉：至少给出「来源」和「文件」',
    lbInfoAsset.opened && lbInfoAsset.rows.some((t) => /^来源/.test(t)) && lbInfoAsset.rows.some((t) => /^文件/.test(t)),
    JSON.stringify(lbInfoAsset));
  await page.evaluate(`document.querySelector('#lightbox .lb-next').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const lbB = await page.evaluate(`document.querySelector('#lightbox .lb-count').textContent`);
  check('抽屉里单击看大图，能接着翻（1/N → 2/N）',
    lbA.open && lbA.count === `1 / ${nAll}` && lbB === `2 / ${nAll}`, `${lbA.count} → ${lbB}，共 ${nAll}`);

  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 300));
  const escA = await page.evaluate(`({
    lightbox: document.querySelector('#lightbox').classList.contains('hidden'),
    pane: !!document.querySelector('#assetPane'),
  })`);
  check('Esc 逐层关：先关大图，抽屉不跟着一起关',
    escA.lightbox === true && escA.pane === true, JSON.stringify(escA));

  // 放一张进画布：节点数 +1，落的图就是点的那一张
  const beforeAdd = await page.evaluate(`document.querySelectorAll('#nodes .node.image').length`);
  const pickSrc = await page.evaluate(`document.querySelector('#assetPane .asset-cell img').getAttribute('src')`);
  await page.evaluate(`document.querySelector('#assetPane .asset-cell .asset-add').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const addRes = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node.image')];
    const last = nodes[nodes.length - 1];
    // dataURL 原样搬过去：放进画布的是「同一张图」，而不是重新生成或复制文件
    return { n: nodes.length, src: (last.querySelector('.thumb img') || {}).getAttribute('src') };
  })()`);
  check('点「＋」把资产放进画布：多一个图片节点，且就是那一张',
    addRes.n === beforeAdd + 1 && addRes.src === pickSrc, `${beforeAdd} → ${addRes.n} same=${addRes.src === pickSrc}`);

  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 300));
  check('再按 Esc 关掉抽屉', await page.evaluate(`!document.querySelector('#assetPane')`));

  // ---- 生成队列：入口 / 空态 / 位置 / 点外收起 ----
  // 这里只验壳子：真任务要 ComfyUI 才能造出来，任务文案与汇总在 Node 段已测过。
  const q0 = await page.evaluate(`(() => {
    const btn = document.getElementById('queueBtn');
    const panel = document.getElementById('queuePanel');
    const badge = document.getElementById('queueCount');
    return {
      btn: !!btn,
      panelHidden: !!panel && panel.classList.contains('hidden'),
      badgeHidden: !!badge && badge.classList.contains('hidden'),
      sum: (document.getElementById('queueSummary') || {}).textContent || '',
    };
  })()`);
  check('顶栏有队列入口；没有任务时面板收着、角标不显示',
    q0.btn && q0.panelHidden && q0.badgeHidden && q0.sum === '还没有任务', JSON.stringify(q0));

  await page.evaluate(`document.getElementById('queueBtn').click()`);
  const q1 = await page.evaluate(`(() => {
    const panel = document.getElementById('queuePanel');
    const r = panel.getBoundingClientRect();
    const b = document.getElementById('queueBtn').getBoundingClientRect();
    return {
      open: !panel.classList.contains('hidden'),
      dx: Math.round(Math.abs(r.right - b.right)),       // 面板右边和入口右边对齐
      below: r.top >= b.bottom,                          // 挂在入口下方，不压住它
      empty: ((panel.querySelector('.q-empty') || {}).textContent || '').trim(),
      inView: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      btnOn: document.getElementById('queueBtn').classList.contains('on'),
      // 入口自己也得在视口里：ComfyUI 离线时状态文字很长，曾经把「任务」顶出 chip
      // （按钮右边缘 1594 > 视口 1584），面板再右对齐就必然对不上。
      btnInView: b.right <= window.innerWidth && b.left >= 0,
    };
  })()`);
  check('点队列 → 面板贴着入口弹出（右对齐、在下方）、落在视口内、空态有说明',
    q1.open && q1.dx <= 2 && q1.below && q1.inView && q1.btnOn && q1.btnInView && q1.empty.includes('还没有任务'), JSON.stringify(q1));

  // 点画布以外的地方也该收：挂在 document 捕获阶段，画布那些 stopPropagation 拦不住
  await page.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  check('点面板外面 → 队列面板收起',
    await page.evaluate(`document.getElementById('queuePanel').classList.contains('hidden')`));

  // ---- 风格选择器（397 个 Krea2 预设，按分类分文件放在 static/styles/）----
  // 真机验过提示词确实拼进去了（ComfyUI /history 里 CLIPTextEncode 的 text 是
  // 「Style: … Subject: 主体」整句）；这里管界面：按钮位置、面板、搜索、套用、存档。
  await page.evaluate(`(() => {
    const el = document.querySelector('#nodes .node.image');
    const r = el.getBoundingClientRect();
    const opt = { clientX: r.left + 40, clientY: r.top + 14, bubbles: true, button: 0, pointerId: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', opt));
    window.dispatchEvent(new PointerEvent('pointerup', opt));
  })()`);
  await page.waitFor(`!!document.querySelector('.gen-panel .gen-chips .gen-style')`, 5000);
  await new Promise((r) => setTimeout(r, 200));

  const chipRow = await page.evaluate(`(() => {
    const row = document.querySelector('.gen-panel .gen-chips');
    return [...row.querySelectorAll('.chip')].map((x) => (x.textContent || '').trim());
  })()`);
  // 位置是需求本身：「风格」就在「清空」右边那一格
  check('按钮行里有「风格」，紧跟在「清空」后面',
    chipRow.indexOf('风格') === chipRow.indexOf('清空') + 1, JSON.stringify(chipRow));

  // 按钮行必须自己适配面板宽度：以前是 nowrap + 溢出可见，「风格」一旦显示中文名，
  // 最后两个按钮就画到面板外面（截图里那半个展开键）。现在动作按钮单独一层、放不下就换行。
  const rowFit = () => page.evaluate(`(() => {
    const panel = document.querySelector('.gen-panel');
    const row = panel.querySelector('.gen-chips');
    const main = panel.querySelector('.gen-chips-main');
    const cs = getComputedStyle(panel);
    const limit = panel.getBoundingClientRect().right - parseFloat(cs.paddingRight) + 1;
    const chips = [...row.querySelectorAll('.chip')];
    const top0 = chips.length ? chips[0].getBoundingClientRect().top : 0;
    const wrapped = chips.filter((b) => b.getBoundingClientRect().top > top0 + 4);
    return {
      rows: new Set(chips.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      outside: chips.filter((b) => b.getBoundingClientRect().right > limit)
        .map((b) => (b.textContent || '').trim() || 'icon'),
      overflow: Math.round(row.scrollWidth - row.clientWidth),
      wrappedLeft: wrapped.length && main
        ? Math.round(wrapped[0].getBoundingClientRect().left - main.getBoundingClientRect().left) : null,
      texts: chips.map((b) => (b.textContent || '').trim() || 'icon'),
    };
  })()`);
  const fit0 = await rowFit();
  check('按钮行不画到面板外面（没套风格时四个按钮一行放得下）',
    fit0.outside.length === 0 && fit0.overflow <= 1 && fit0.rows === 1, JSON.stringify(fit0));

  await page.evaluate(`document.querySelector('.gen-panel .gen-style').click()`);
  await page.waitFor(`!!document.querySelector('.style-pop .sp-cell')`, 10000);
  await new Promise((r) => setTimeout(r, 400));
  const sp = await page.evaluate(`(() => {
    const p = document.querySelector('.style-pop');
    const r = p.getBoundingClientRect();
    const b = document.querySelector('.gen-panel .gen-style').getBoundingClientRect();
    const imgs = [...p.querySelectorAll('.sp-img img')];
    return {
      tabs: p.querySelectorAll('.sp-tabs button').length,
      tabOn: ((p.querySelector('.sp-tabs button.on') || {}).textContent || '').trim(),
      cells: p.querySelectorAll('.sp-cell').length,
      thumbs: imgs.filter((i) => i.naturalWidth > 0).length,
      name: ((p.querySelector('.sp-name') || {}).textContent || '').trim(),
      fits: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      clearOfBtn: r.bottom <= b.top + 2 || r.top >= b.bottom - 2,
      scroll: p.querySelector('.sp-body').scrollHeight > p.querySelector('.sp-body').clientHeight,
    };
  })()`);
  check('点「风格」→ 面板弹出：分类标签齐全、缩略图都加载出来、落在视口内且不压住按钮',
    sp.tabs >= 10 && sp.tabOn.startsWith('动漫') && sp.cells > 40 && sp.thumbs === sp.cells
      && sp.fits && sp.clearOfBtn && sp.name.length > 0, JSON.stringify(sp));
  check('风格列表在自己的区域里滚动（表头和搜索框不跟着跑）', sp.scroll === true);

  // 宫格：格子必须是方的。全局那条「所有按钮一律 999px」的规则带了一长串 :not()
  // （特异性 0,13,1），会把格子裁成圆形、缩略图变成一个个圆圈——只能靠 :not(.sp-cell) 豁免。
  const shape = await page.evaluate(`(() => {
    const c = document.querySelector('.style-pop .sp-cell');
    const box = c.querySelector('.sp-img');
    const img = box.querySelector('img');
    const rb = box.getBoundingClientRect(), ri = img.getBoundingClientRect();
    return {
      radius: parseFloat(getComputedStyle(c).borderRadius),
      imgW: Math.round(ri.width), imgH: Math.round(ri.height),
      boxW: Math.round(rb.width), boxH: Math.round(rb.height),
    };
  })()`);
  check('风格格子是方的（圆角 ≤ 12px），缩略图铺满格子、不溢出',
    shape.radius <= 12 && shape.imgW === shape.boxW && shape.imgH === shape.boxH, JSON.stringify(shape));

  // 搜索跨分类：搜「吉卜力」只剩一条
  await page.evaluate(`(() => {
    const q = document.querySelector('.style-pop .sp-q');
    q.value = '吉卜力';
    q.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(`document.querySelectorAll('.style-pop .sp-cell').length === 1`, 10000);
  const sr = await page.evaluate(`(() => {
    const p = document.querySelector('.style-pop');
    return { n: (p.querySelector('.sp-n') || {}).textContent || '', name: (p.querySelector('.sp-name') || {}).textContent || '' };
  })()`);
  check('搜索「吉卜力」→ 只剩 1 条，且是吉卜力风格',
    sr.n.includes('1') && sr.name === '吉卜力风格', JSON.stringify(sr));

  await page.evaluate(`document.querySelector('.style-pop .sp-cell').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const ap = await page.evaluate(`(() => {
    const btn = document.querySelector('.gen-panel .gen-style');
    return {
      label: btn.textContent.trim(),
      on: btn.classList.contains('on'),
      closed: !document.querySelector('.style-pop'),
    };
  })()`);
  check('点一个风格 → 按钮变成风格名并高亮，弹层自动收起',
    ap.label === '吉卜力风格' && ap.on && ap.closed, JSON.stringify(ap));

  // 中文风格名比「风格」两个字宽一截：这时候允许换行，但换行后仍不能越界，
  // 且要跟第一个动作按钮左对齐（不然看着像掉出来的一格）
  const fit1 = await rowFit();
  check('套上中文风格名后：放不下就换行，换行也不越界、并且与动作按钮左对齐',
    fit1.outside.length === 0 && fit1.overflow <= 1
      && (fit1.rows === 1 || fit1.wrappedLeft === 0), JSON.stringify(fit1));

  // 存档：只存指针 {cat,i,cn}，不存那四百字英文模板。
  // 存到哪儿取决于当前有没有绑项目（data/canvas.json 或 data/projects/<id>.json），
  // 干脆把整个临时 data 目录读一遍——比猜 state.projectId 是哪一个稳。
  await new Promise((r) => setTimeout(r, 1600));
  const projDir = path.join(dataDir, 'projects');
  const canvasRaw = [path.join(dataDir, 'canvas.json'), ...(fs.existsSync(projDir) ? fs.readdirSync(projDir).map((f) => path.join(projDir, f)) : [])]
    .filter((f) => fs.existsSync(f) && f.endsWith('.json'))
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const saveInfo = await page.evaluate(`(() => ({
    st: (document.querySelector('#saveState') || {}).textContent || '',
    proj: (document.querySelector('#projName') || {}).textContent || '',
  }))()`);
  check('风格写进画布存档（只存 {cat,i,cn}，不存整段模板）',
    // 服务端落盘是缩进过的 JSON，正则不能假设紧凑格式
    /"style":\s*\{\s*"cat":\s*"anime",\s*"i":\s*\d+,\s*"cn":\s*"吉卜力风格"\s*\}/.test(canvasRaw)
      && !canvasRaw.includes('watercolor-inspired'),
    `${(canvasRaw.match(/"style":\s*\{[^}]*\}/) || ['(没有 style)'])[0]} | ${JSON.stringify(saveInfo)}`);

  // 再打开：记住当前分类、把已选的标出来，并能一键去掉
  await page.evaluate(`document.querySelector('.gen-panel .gen-style').click()`);
  await page.waitFor(`!!document.querySelector('.style-pop .sp-cell.on')`, 10000);
  await new Promise((r) => setTimeout(r, 300));
  const re = await page.evaluate(`(() => {
    const p = document.querySelector('.style-pop');
    return {
      active: (p.querySelector('.sp-cell.on .sp-name') || {}).textContent || '',
      tabOn: ((p.querySelector('.sp-tabs button.on') || {}).textContent || '').trim(),
      hasClear: !!p.querySelector('.sp-clear'),
    };
  })()`);
  check('重新打开：已选的那条高亮、分类记得住、底部有「不用风格」',
    re.active === '吉卜力风格' && re.tabOn.startsWith('动漫') && re.hasClear, JSON.stringify(re));

  await page.evaluate(`document.querySelector('.style-pop .sp-clear').click()`);
  await new Promise((r) => setTimeout(r, 400));
  check('点「不用风格」→ 按钮回到「风格」、高亮取消',
    await page.evaluate(`(() => {
      const b = document.querySelector('.gen-panel .gen-style');
      return b.textContent.trim() === '风格' && !b.classList.contains('on');
    })()`));

  // ---- 图片工具条：扩图 / 裁剪 / 局部重绘 / 消除 / 高清 ----
  // 放在节点标题上方，按屏幕坐标定位（不吃画布缩放），只对「单选 + 有图」的图片节点出现。
  const pick = await page.evaluate(`(() => {
    // 只挑「已经真正解码出来」的图：裁剪要用 naturalWidth 把显示像素换算回原图像素，
    // 拿一张还没加载完 / 没有固有尺寸的 SVG 进去，画布会裁出 0×0。
    const imgs = [...document.querySelectorAll('#nodes .node.image')]
      .filter((e) => { const im = e.querySelector('.thumb img'); return im && im.naturalWidth >= 8 && im.naturalHeight >= 8; });
    const txt = document.querySelector('#nodes .node.text');
    return { img: imgs.length ? imgs[0].dataset.id : null, text: txt ? txt.dataset.id : null };
  })()`);
  if (!pick.img || !pick.text) throw new Error(`工具条用例需要一张有图的图片节点 + 一个文本节点：${JSON.stringify(pick)}`);

  const textSel = await page.center(`#nodes .node[data-id="${pick.text}"] .node-title`);
  if (!textSel) throw new Error(`找不到文本节点的标题：${JSON.stringify(pick)}`);
  await page.clickAt(textSel.x, textSel.y, { settle: 400 });
  const toolHidden = await page.evaluate(`(() => {
    const bar = document.getElementById('imgTools');
    return { exists: !!bar, hidden: !bar || bar.classList.contains('hidden') };
  })()`);
  check('选中的是文本节点 → 图片工具条不出现（没有可做的图片操作）',
    toolHidden.exists && toolHidden.hidden, JSON.stringify(toolHidden));

  const toolSel = await page.center(`#nodes .node[data-id="${pick.img}"] .node-title`);
  if (!toolSel) throw new Error(`找不到图片节点的标题：${JSON.stringify(pick)}`);
  await page.clickAt(toolSel.x, toolSel.y, { settle: 400 });
  const toolBar = await page.evaluate(`(() => {
    const bar = document.getElementById('imgTools');
    if (!bar) return { hidden: true };
    const r = bar.getBoundingClientRect();
    const nb = document.querySelector('.node[data-id="${pick.img}"]').getBoundingClientRect();
    return {
      hidden: bar.classList.contains('hidden'),
      tools: [...bar.querySelectorAll('.it-btn')].map((b) => b.textContent.trim()),
      centered: Math.abs((r.left + r.width / 2) - (nb.left + nb.width / 2)) <= 2,
      above: r.bottom <= nb.top,
      gap: Math.round(nb.top - r.bottom),
      inView: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth,
      h: Math.round(r.height),
    };
  })()`);
  check('选中一张有图的节点 → 工具条浮在节点上方（居中、不压标题）、工具齐全',
    !toolBar.hidden
      && toolBar.tools.join('/') === '裁剪/高清'
      && toolBar.centered && toolBar.above && toolBar.gap <= 12 && toolBar.inView,
    JSON.stringify(toolBar));

  // 工具条是屏幕坐标：缩放画布后它的大小不该跟着变
  // 用 50%（节点缩到视口装得下）来验：200% 时节点本身比视口还宽，工具条必然被
  // 视口边缘夹住，「居中/在上方」就不该成立了。
  await page.evaluate(`document.querySelector('[data-zoom="0.5"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const toolZoomed = await page.evaluate(`(() => {
    const r = document.getElementById('imgTools').getBoundingClientRect();
    const nb = document.querySelector('.node[data-id="${pick.img}"]').getBoundingClientRect();
    return { h: Math.round(r.height), centered: Math.abs((r.left + r.width / 2) - (nb.left + nb.width / 2)) <= 2, above: r.bottom <= nb.top };
  })()`);
  await page.evaluate(`document.querySelector('[data-zoom="fit"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  check('缩到 50% 后工具条尺寸不变、仍然贴着节点上方（屏幕坐标，不吃缩放）',
    toolZoomed.h === toolBar.h && toolZoomed.centered && toolZoomed.above, JSON.stringify(toolZoomed));

  // 拖动节点时工具条要**实时跟着**：以前拖动只改节点的 transform（scheduleLayout 只管
  // 连线/分组/小地图），屏幕坐标的浮条钉在原地，松手那一帧才瞬移过去。
  // 这里在 pointermove 之后、松手之前采样——中途采不到就说明「实时」是假的。
  const toolFollow = await page.evaluate(`(async () => {
    const el = document.querySelector('.node[data-id="${pick.img}"]');
    const card = el.querySelector('.node-card');
    const r = card.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const at = (dx, dy) => ({ ...base, clientX: r.left + 30 + dx, clientY: r.top + 14 + dy });
    const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const sample = () => {
      const nb = el.getBoundingClientRect();
      const b = document.getElementById('imgTools').getBoundingClientRect();
      return {
        node: [Math.round(nb.left), Math.round(nb.top)],
        barCenter: Math.round(b.left + b.width / 2),
        nodeCenter: Math.round(nb.left + nb.width / 2),
        gap: Math.round(nb.top - b.bottom),
      };
    };
    card.dispatchEvent(new PointerEvent('pointerdown', { ...at(0, 0), buttons: 1 }));
    await raf();
    const s0 = sample();
    window.dispatchEvent(new PointerEvent('pointermove', { ...at(60, 40), buttons: 1 }));
    await raf();
    const s1 = sample();
    window.dispatchEvent(new PointerEvent('pointermove', { ...at(120, 80), buttons: 1 }));
    await raf();
    const s2 = sample();
    // 拖回原位再松手：后面的用例按坐标点这个节点，挪走了会点到别的节点上
    window.dispatchEvent(new PointerEvent('pointermove', { ...at(0, 0), buttons: 1 }));
    await raf();
    const s3 = sample();
    window.dispatchEvent(new PointerEvent('pointerup', { ...at(0, 0), buttons: 0 }));
    await raf();
    return { s0, s1, s2, s3 };
  })()`);
  const followOk = (s) => Math.abs(s.barCenter - s.nodeCenter) <= 2 && s.gap >= 0 && s.gap <= 12;
  check('拖动节点时工具条实时跟随（不是松手才瞬移）',
    toolFollow.s1.node[0] !== toolFollow.s0.node[0]
      && followOk(toolFollow.s1) && followOk(toolFollow.s2) && followOk(toolFollow.s3)
      && toolFollow.s2.node[0] !== toolFollow.s1.node[0]
      && Math.abs(toolFollow.s3.node[0] - toolFollow.s0.node[0]) <= 1,
    JSON.stringify(toolFollow));

  // 裁剪：比例档 + 选区 + 落地成一个新节点
  const cropBefore = await page.evaluate(`document.querySelectorAll('#nodes .node').length`);
  await page.evaluate(`document.querySelector('#imgTools [data-tool="crop"]').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const cropUi = await page.evaluate(`(() => {
    const m = document.getElementById('cropMask');
    if (!m) return { open: false };
    const sel = m.querySelector('.crop-sel');
    const img = m.querySelector('img');
    return {
      open: true,
      ratios: [...m.querySelectorAll('.crop-ratio')].map((b) => b.textContent.trim()),
      sel: [Math.round(sel.offsetWidth), Math.round(sel.offsetHeight)],
      img: [img.clientWidth, img.clientHeight],
      size: m.querySelector('.crop-size').textContent.trim(),
    };
  })()`);
  check('点「裁剪」→ 弹出裁剪浮层：比例档齐全、选区默认在图片中间',
    cropUi.open && cropUi.ratios.join('/') === '自由/1:1/4:5/3:4/16:9/9:16'
      && cropUi.sel[0] > 0 && cropUi.sel[1] > 0 && /裁出 \d+ × \d+/.test(cropUi.size),
    JSON.stringify(cropUi));

  // 八个锚点：四角 + 四边中点。
  const anchors = await page.evaluate(`[...document.querySelectorAll('#cropMask .crop-sel .ch')]
    .map((h) => h.className.replace('ch', '').trim()).sort()`);
  check('裁剪选区有八个锚点（四角 + 四边中点）',
    anchors.join(',') === 'e,n,ne,nw,s,se,sw,w', JSON.stringify(anchors));

  // 压暗只作用于图片：以前靠 .crop-sel 的 9999px 阴影铺满全屏，那是 positioned 元素，
  // 会把标题、比例按钮、取消/裁出来一起压暗（按钮能点，看着像禁用）。
  const cropDim = await page.evaluate(`(() => {
    const img = document.querySelector('#cropMask .crop-stage img');
    const sel = document.querySelector('#cropMask .crop-sel');
    const dim = document.querySelector('#cropMask .crop-dim');
    const head = document.querySelector('#cropMask .crop-head');
    const foot = document.querySelector('#cropMask .crop-foot');
    const inter = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const i = img.getBoundingClientRect();
    const strips = dim ? [...dim.children].map((e) => e.getBoundingClientRect()) : [];
    // 四边贴不贴齐：沿图片中线各取一条扫描线，看这条线上的暗条最远到哪儿。
    // 必须用**小数**比，不能用 Math.round 后的值——真正会出事的就是 0.12px 那种缝。
    const cy = i.top + i.height / 2;
    const cx = i.left + i.width / 2;
    const atY = strips.filter((r) => r.top <= cy && r.bottom >= cy);
    const atX = strips.filter((r) => r.left <= cx && r.right >= cx);
    const gap = (v) => Number.isFinite(v) ? +v.toFixed(2) : 999;
    return {
      shown: !!dim && !dim.classList.contains('hidden'),
      n: strips.length,
      touchesChrome: strips.some((r) => inter(r, head.getBoundingClientRect())
        || inter(r, foot.getBoundingClientRect())),
      insideImg: strips.every((r) => r.left >= i.left - 1 && r.top >= i.top - 1
        && r.right <= i.right + 1 && r.bottom <= i.bottom + 1),
      // 图片四边到压暗覆盖的边缘还差多少（正数=留缝=亮线，负数=溢出）
      gaps: {
        left: gap(Math.min(...atY.map((r) => r.left)) - i.left),
        right: gap(i.right - Math.max(...atY.map((r) => r.right))),
        top: gap(Math.min(...atX.map((r) => r.top)) - i.top),
        bottom: gap(i.bottom - Math.max(...atX.map((r) => r.bottom))),
      },
      imgSize: [+i.width.toFixed(2), +i.height.toFixed(2)],
      clientSize: [img.clientWidth, img.clientHeight],
      selShadow: getComputedStyle(sel).boxShadow,
      // 压暗层的圆角必须跟图片一致：不一致时四块方角暗条会在图片圆角外露出尖角
      imgRadius: getComputedStyle(img).borderRadius,
      dimRadius: dim ? getComputedStyle(dim).borderRadius : '',
      dimOverflow: dim ? getComputedStyle(dim).overflow : '',
    };
  })()`);
  check('裁剪：压暗只在图片范围内，不盖住比例按钮和底部按钮',
    cropDim.shown && cropDim.n === 4 && !cropDim.touchesChrome && cropDim.insideImg,
    JSON.stringify(cropDim));
  check('裁剪：选区不再用超大阴影铺满全屏', cropDim.selShadow === 'none', cropDim.selShadow);
  // 暗条不能自己算宽高：图片按 max-height 缩放后是 933.13 × 524.89 这种小数，
  // img.clientWidth/clientHeight 取整（933 / 525），算出来右边缘短 0.12px、下边缘差 0.11px，
  // 图上就是一条 1px 亮线。四边都必须贴死（容差 0.05px，比 Math.round 严 20 倍）。
  check('裁剪：压暗贴着图片四边，不留亚像素缝（否则右/下各有一条 1px 亮线）',
    Math.max(...Object.values(cropDim.gaps).map(Math.abs)) <= 0.05,
    `gaps ${JSON.stringify(cropDim.gaps)} · 图片 ${JSON.stringify(cropDim.imgSize)} 实际取整 ${JSON.stringify(cropDim.clientSize)}`);
  check('裁剪：压暗层圆角跟图片一致（否则圆角里会套一个方角）',
    cropDim.imgRadius === cropDim.dimRadius && cropDim.dimOverflow === 'hidden',
    `img ${cropDim.imgRadius} / dim ${cropDim.dimRadius} / ${cropDim.dimOverflow}`);


  await page.evaluate(`document.querySelectorAll('#cropMask .crop-ratio')[1].click()`);
  await new Promise((r) => setTimeout(r, 250));
  const cropSquare = await page.evaluate(`(() => {
    const sel = document.querySelector('#cropMask .crop-sel');
    return { w: Math.round(sel.offsetWidth), h: Math.round(sel.offsetHeight) };
  })()`);
  check('选 1:1 → 选区变成正方形（拖角时也按比例锁）',
    Math.abs(cropSquare.w - cropSquare.h) <= 1, JSON.stringify(cropSquare));

  await page.evaluate(`document.querySelector('#cropMask [data-act="apply"]').click()`);
  await new Promise((r) => setTimeout(r, 600));
  const cropRes = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    const last = nodes[nodes.length - 1];
    const img = last.querySelector('.thumb img');
    return {
      n: nodes.length,
      title: (last.querySelector('.n-name') || {}).textContent || '',
      w: img ? img.naturalWidth : 0,
      h: img ? img.naturalHeight : 0,
      mask: !!document.getElementById('cropMask'),
    };
  })()`);
  check('点「裁出来」→ 画布多一个正方形图片节点，浮层自动关掉',
    cropRes.n === cropBefore + 1 && cropRes.title.startsWith('裁剪')
      && cropRes.w === cropRes.h && cropRes.w > 0 && !cropRes.mask,
    JSON.stringify(cropRes));

  // 剩下的编辑类工具是「拿这张图当参考改一版」：新建节点、切编辑工作流、预填提示词，原图不动。
  const editBefore = await page.evaluate(`document.querySelectorAll('#nodes .node').length`);
  await page.evaluate(`document.querySelector('#imgTools [data-tool="upscale"]').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const editRes = await page.evaluate(`(async () => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    const last = nodes[nodes.length - 1];
    const ta = document.querySelector('.node.selected .gen-prompt');
    const wf = document.querySelector('.node.selected .gen-bar .gensel.wfsel .gm-btn');
    const label = wf ? wf.textContent.trim() : '';
    // 挑工作流必须看能力：以前按名字里的「编辑」匹配，选中过 Moss_图像编辑 —— 纯文生图，
    // 参考图根本没进图。这里直接问服务端这个预设吃不吃图。
    const lib = await (await fetch('/api/library')).json();
    const hit = (lib.presets || []).find((x) => (x.title || x.name) === label);
    return {
      n: nodes.length,
      title: (last.querySelector('.n-name') || {}).textContent || '',
      selected: last.classList.contains('selected'),
      prompt: ta ? ta.textContent.trim().slice(0, 24) : '',
      wf: label,
      takesImage: !!(hit && hit.takes_image),
      hasImg: !!last.querySelector('.thumb img'),
    };
  })()`);
  check('点「高清」→ 新建一个编辑节点：带着这张图、切到真吃得下参考图的工作流（不是纯文生图）、提示词已预填',
    editRes.n === editBefore + 1 && editRes.selected && editRes.title.startsWith('高清')
      && editRes.hasImg && editRes.prompt.includes('参考')
      && editRes.takesImage,
    JSON.stringify(editRes));

  // 收尾：删掉刚造的两个节点，别影响后面的用例
  await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    nodes.slice(-2).forEach((el) => {
      const del = el.querySelector('.n-del');
      if (del) del.click();
    });
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  // ---- 进度百分比不许「有几率消失」 ----
  // 真实竞态：轮询某一拍拿不到数字（服务端 /api/job 的 progress 为 null —— 排队中、
  // ws 还没到第一个采样器、history 先落库但没 completed 都会这样），旧代码会把节点上
  // 记着的百分比一并擦掉，画面变成「生成中 12% → 生成中… → 生成中 30%」。
  // 这里把 fetch 换成脚本化的假 ComfyUI，第 3 拍故意不给数字，然后盯着那行字看。
  // 先点一下节点标题把 i2 的面板显示出来：隐藏的 contenteditable 上 execCommand 不生效
  const pctSel = await page.center('#nodes .node[data-id="i2"] .node-title');
  await page.clickAt(pctSel.x, pctSel.y, { settle: 400 });
  const pctSeqBox = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ta = document.querySelector('[data-panel-for="i2"] .gen-prompt');
    ta.focus();
    document.execCommand('insertText', false, 'a cat');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const ticks = [
      { status: 'running', progress: 5 },
      { status: 'running', progress: 12 },
      { status: 'running', progress: null },     // ← 这一拍没有数字
      { status: 'running', progress: 30 },
      { status: 'success', artifacts: [] },
    ];
    let i = 0;
    const hits = [];
    window.fetch = async (url, opts) => {
      const u = String(url);
      hits.push(u.slice(0, 60));
      if (u.startsWith('/api/run')) return json({ ok: true, prompt_id: 'pct-test' });
      // 分析这一步在本机没开 ComfyUI 时会 502（服务端要问 object_info）：
      // 给一份「没有图片插槽」的分析结果——这正是纯文生图的分支，也顺手把控制台洗静。
      if (u.startsWith('/api/analyze')) return json({ ok: true, slots: [] });
      // 参考图会上传：这里故意让它失败。上传成功的话节点会改用 /api/view 显示，
      // 而 ComfyUI 没开时那张图必然 502，会把「控制台无报错」一起拖红。
      // 失败是 app 允许的路径（「这张传不上去就跳过」），正好走纯文生图。
      if (u.startsWith('/api/upload')) return json({ ok: false, error: 'offline' });
      if (u.startsWith('/api/job')) {
        const t = ticks[Math.min(i++, ticks.length - 1)];
        return json(Object.assign({ ok: true, progress: null }, t));
      }
      return real(url, opts);
    };
    document.querySelector('[data-panel-for="i2"] .gen-run').click();
    const seen = [];
    // 准备阶段要读工作流、跑 /api/analyze（ComfyUI 没开时这一步会慢），
    // 采样窗口给到 24s：只盯 5 个 tick，够宽但不至于把整套拖太久。
    for (let k = 0; k < 200; k++) {
      const ov = document.querySelector('.node[data-id="i2"] .gen-overlay');
      const txt = ov && !ov.classList.contains('hidden') ? ov.textContent.trim() : '';
      if (txt && seen[seen.length - 1] !== txt) seen.push(txt);
      if (i >= ticks.length) break;
      await sleep(120);
    }
    window.fetch = real;
    const st = document.querySelector('[data-panel-for="i2"] .gen-status');
    const status = st ? st.textContent.trim() : '';
    // 收尾：提示词和队列记录都不留给后面的用例
    const clear = document.querySelector('[data-panel-for="i2"] .gen-chips .chip:nth-child(3)');
    if (clear) clear.click();
    return { seen, status, hits };
  })()`);
  const pctSeq = pctSeqBox.seen;
  const afterFirst = pctSeq.slice(Math.max(0, pctSeq.indexOf('生成中 12%')));
  check('进度百分比不会因为某一拍没数字而消失（12% → 30%，中间不退回「生成中…」）',
    pctSeq.includes('生成中 5%') && pctSeq.includes('生成中 12%') && pctSeq.includes('生成中 30%')
      && !afterFirst.includes('生成中…'),
    JSON.stringify(pctSeqBox));

  // ---- MCP：外部改画布，浏览器要自己跟上 ----
  // 服务端那条链路归 tests/mcp.py；这里验的是**前端**：它手里握着整份画布快照，
  // 一次自动保存就能把 MCP 刚建的节点抹掉。所以这条用例盯的是「轮询 → 重载」这段。
  const mcpCall = async (method, params) => {
    const r = await fetch(`${server.base}mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return r.json();
  };
  await mcpCall('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' },
  });
  const browserPid = await page.evaluate(`localStorage.getItem('infisheet-project') || ''`);
  const used = browserPid
    ? await mcpCall('tools/call', { name: 'use_project', arguments: { project: browserPid } })
    : null;
  const added = used
    ? await mcpCall('tools/call', {
      name: 'add_text_node', arguments: { text: 'MCP 写进来的提示词', title: 'MCP 节点' },
    })
    : null;
  const mcpNode = added?.result?.structuredContent?.node?.id || '';
  check('MCP 能在浏览器当前打开的项目上建节点', !!mcpNode,
    `${browserPid} · ${mcpNode}${added?.result?.isError ? ' · ' + added.result.content?.[0]?.text : ''}`);

  let syncedValue = '';
  let syncedTick = 0;
  for (let k = 0; k < 40; k++) {
    syncedValue = await page.evaluate(
      `(() => { const n = document.querySelector('.node[data-id="${mcpNode}"] textarea'); return n ? n.value : ''; })()`);
    if (syncedValue === 'MCP 写进来的提示词') { syncedTick = k; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  const syncDiag = await page.evaluate(`(() => ({
    hidden: document.hidden,
    visibility: document.visibilityState,
    pid: localStorage.getItem('infisheet-project') || '',
    nodes: document.querySelectorAll('.node').length,
    save: (document.getElementById('saveState') || {}).textContent || '',
  }))()`);
  check('MCP 改完画布，浏览器几秒内自动同步（不用刷新页面）', syncedValue === 'MCP 写进来的提示词',
    `节点 ${mcpNode} · 第 ${syncedTick} 次探测 · 值「${syncedValue}」· ` + JSON.stringify(syncDiag));

  const revMeta = async () => (await (await fetch(`${server.base}api/projects/${browserPid}?meta=1`)).json()).rev;
  const revA = await revMeta();
  await new Promise((r) => setTimeout(r, 1500));
  const revB = await revMeta();
  check('同步之后浏览器不会把旧版本写回去（rev 只涨不回退）', revB === revA, `rev ${revA} → ${revB}`);

  // ---- 顶栏的 MCP 灯 ----
  // 上面那串 initialize 发生在页面已经打开之后，而前端健康检查是 10s 一次：
  // 这里要等一个完整的轮询周期，所以只能轮询着看，不能拍一个固定 sleep。
  let lampText = '';
  let lampTick = 0;
  for (let k = 0; k < 60; k++) {
    lampText = await page.evaluate(
      `(() => { const el = document.getElementById('mcpText'); return el ? el.textContent : ''; })()`);
    if (lampText.startsWith('MCP 已连接')) { lampTick = k; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  const lampDiag = await page.evaluate(`(() => {
    const seg = document.getElementById('mcpSeg');
    const chip = document.getElementById('mcpChip');
    const dot = document.getElementById('mcpDot');
    const text = document.getElementById('mcpText');
    return {
      hidden: seg ? seg.classList.contains('hidden') : 'no-seg',
      text: text ? text.textContent : '',
      ellipsis: text ? text.scrollWidth > text.clientWidth + 1 : null,
      dot: dot ? dot.className : '',
      on: chip ? chip.classList.contains('on') : false,
      title: chip ? (chip.title || '').split('\\n')[0] : '',
    };
  })()`);
  check('顶栏 MCP 灯：客户端握手后自动点亮（不用刷新页面）',
    lampText.startsWith('MCP 已连接') && lampDiag.on === true && String(lampDiag.dot).includes('ok'),
    `第 ${lampTick} 次探测 · ${JSON.stringify(lampDiag)}`);
  check('MCP 灯里写着是哪个应用接的', /MCP 已连接 · e2e/.test(lampDiag.text), lampDiag.text);
  check('MCP 灯能说清是谁接进来的', /e2e/.test(lampDiag.title), lampDiag.title);

  // ---- MCP 安装入口：点顶栏那盏灯 ----
  // 门槛全在第一步（端点是什么、stdio 命令怎么写、路径在哪），所以这个面板必须把
  // 「能直接抄的东西」摆出来。写入那步在 e2e 里也能真点：HOME 已指到临时目录。
  const readSetup = () => page.evaluate(`(() => {
    const box = document.getElementById('mcpSetup');
    const note = document.getElementById('mcpSetupNote');
    return {
      open: !!box && !box.classList.contains('hidden'),
      endpoint: (document.getElementById('mcpSetupEndpoint') || {}).textContent || '',
      tabs: [...document.querySelectorAll('#mcpSetupTabs .mcp-tab')].map((b) => b.textContent),
      on: [...document.querySelectorAll('#mcpSetupTabs .mcp-tab.on')].map((b) => b.textContent),
      path: (document.getElementById('mcpSetupPath') || {}).textContent || '',
      json: (document.getElementById('mcpSetupJson') || {}).textContent || '',
      exists: (document.getElementById('mcpSetupExists') || {}).textContent || '',
      note: note ? note.textContent : '',
      noteKind: note ? note.className : '',
    };
  })()`);

  await page.evaluate(`document.getElementById('mcpChip').click()`);
  await new Promise((r) => setTimeout(r, 700));
  const setupA = await readSetup();
  check('点顶栏的 MCP 灯 → 打开接入面板（端点 + 三个客户端）',
    setupA.open && /\/mcp$/.test(setupA.endpoint) && setupA.tabs.length === 3,
    `${setupA.endpoint} · ${setupA.tabs.join('/')}`);
  check('面板里的配置能直接抄：stdio 指向 mcp_server.py',
    /mcp_server\.py/.test(setupA.json) && /"stdio"/.test(setupA.json) && /mcpServers/.test(setupA.json),
    setupA.json.split('\n').slice(0, 3).join(' '));

  // 切客户端：路径和片段都得跟着换（Claude 是另一套格式，没有 type）
  await page.evaluate(`document.querySelectorAll('#mcpSetupTabs .mcp-tab')[1].click()`);
  await new Promise((r) => setTimeout(r, 250));
  const setupB = await readSetup();
  check('切到 Claude：路径与配置片段一起换（它的条目没有 type）',
    setupB.path !== setupA.path && /claude/i.test(setupB.path) && !/"type"/.test(setupB.json),
    `${setupB.path.split(/[\\/]/).slice(-2).join('/')} · ${setupB.on.join('')}`);

  // 切回 WorkBuddy 并真写一次（e2e 的 HOME 指向临时目录，不会碰用户的真配置）
  await page.evaluate(`document.querySelectorAll('#mcpSetupTabs .mcp-tab')[0].click()`);
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(`document.getElementById('mcpSetupWrite').click()`);
  let setupC = await readSetup();
  for (let k = 0; k < 40 && !/已写入/.test(setupC.note); k++) {
    await new Promise((r) => setTimeout(r, 150));
    setupC = await readSetup();
  }
  const wbCfg = path.join(dataDir, 'mcp-home', '.workbuddy', 'mcp.json');
  let wbJson = null;
  try { wbJson = JSON.parse(fs.readFileSync(wbCfg, 'utf8')); } catch { wbJson = null; }
  check('点「写入这个文件」→ 真把 infisheet 写进客户端配置',
    /已写入/.test(setupC.note) && !!wbJson
      && String(wbJson.mcpServers?.infisheet?.args?.[0] || '').endsWith('mcp_server.py'),
    setupC.note.slice(0, 80));

  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  const closed = await readSetup();
  check('Esc 关掉面板', closed.open === false);

  // ---- 断开：心跳停了，租约到期后灯要自己变灰 ----
  // 「断开」没有事件可等（桥死了不会发告别消息），所以判据是租约：替桥发一次心跳，
  // 然后停手，等租约（3s）+ 一个健康轮询周期（10s）过去。真的起一个 stdio 桥没必要——
  // 心跳就是一条 POST，谁发都算数。
  const beat = () => fetch(server.base + 'api/mcp/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Host': 'e2e' },
    body: '{}',
  });
  await beat();
  let gone = '';
  let goneTick = 0;
  for (let k = 0; k < 80; k++) {
    gone = await page.evaluate(
      `(() => { const el = document.getElementById('mcpText'); return el ? el.textContent : ''; })()`);
    if (gone.startsWith('MCP 已断开')) { goneTick = k; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  check('心跳停了、租约过期后灯自己变「已断开」（不刷新页面）',
    gone.startsWith('MCP 已断开'), `第 ${goneTick} 次探测 · ${gone}`);
  check('断开的灯说得出是谁掉了线', /e2e/.test(gone), gone);

  // 重新接上：这里必须**持续**心跳（真桥每 lease/3 秒一次）。只发一次的话，
  // 3 秒租约等不到下一次健康检查（10s 一轮），灯还没轮到就被判过期了——
  // 第一版就是这么红的，测的是「心跳间隔」而不是「能不能恢复」。
  const hbTimer = setInterval(() => { beat().catch(() => {}); }, 1000);
  let back = '';
  try {
    for (let k = 0; k < 80; k++) {
      back = await page.evaluate(
        `(() => { const el = document.getElementById('mcpText'); return el ? el.textContent : ''; })()`);
      if (back.startsWith('MCP 已连接')) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    clearInterval(hbTimer);
  }
  check('重新有心跳后灯又绿了（不用重新握手）', back.startsWith('MCP 已连接'), back);

  const consoleErrors = page.errors.filter((e) => !/favicon/.test(e.text || ''));
  // 只打 text 的话永远只看到「Uncaught」——把 detail / 位置也带上，否则报错了也查不出是哪一行
  const errText = (e) => [e.text, e.detail, e.url && `${e.url}:${e.line}`].filter(Boolean).join(' ');
  check('控制台无报错', consoleErrors.length === 0, consoleErrors.map(errText).join(' | '));

  const shotDir = path.join(TMP, 'shots');
  await page.screenshot(path.join(shotDir, 'e2e-canvas.png'));
  console.log(`\n截图：${shotDir}\\e2e-canvas.png`);

  // ---- 裁剪压暗的亚像素对齐（要另外起一个项目才测得出来）----
  // 前面那条断言跑在夹具图（16×16）上，显示尺寸是整数，四边天然贴齐，永远为 0——
  // 它证明不了「不会留缝」。真机上图片按 max-height 缩放成 933.13 × 524.89 这种小数，
  // 若拿 clientWidth/clientHeight（933 / 525）算暗条宽高，右边缘就短 0.12px、下边缘差 0.11px，
  // 图上是一条 1px 亮线。所以这里换一张 1600×900 的图，把「带小数」这个前提真造出来。
  const fracId = await page.evaluate(`(async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">'
      + '<rect width="1600" height="900" fill="#ffffff"/></svg>';
    const cv = {
      version: 2, name: 'e2e 亚像素', seq: 1, bootAt: Date.now(),
      view: { x: 60, y: 40, k: 1 }, groups: [], links: [],
      nodes: [{
        id: 'f1', type: 'image', title: '亚像素', x: 200, y: 200,
        dataURL: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), uploaded: null,
        gen: { prompt: '亚像素', wf: 'preset:krea2-txt2img.api.json', aspect: '16:9', size: '1k',
          batch: 1, seedMode: 'fixed', seed: 1, gallery: [], idx: 0, extras: [], runs: [] },
      }],
    };
    const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e 亚像素' }) });
    const pr = await r.json();
    await fetch('/api/projects/' + pr.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvas: cv }) });
    localStorage.setItem('infisheet-project', pr.id);
    return 'f1';
  })()`);
  await page.evaluate(`(() => { location.hash = '#canvas'; location.reload(); return true; })()`);
  await page.waitFor(`!!document.querySelector('.node[data-id="${fracId}"]')`, 15000);
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(`(() => {
    const card = document.querySelector('.node[data-id="${fracId}"] .node-card');
    const b = card.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 14, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    card.dispatchEvent(new PointerEvent('pointerdown', o));
    card.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(`document.querySelector('#imgTools .it-btn[data-tool="crop"]').click()`);
  await page.waitFor(`!!document.querySelector('#cropMask .crop-sel:not(.hidden)')`, 10000);
  await new Promise((r) => setTimeout(r, 400));
  const fracDim = await page.evaluate(`(() => {
    const img = document.querySelector('#cropMask .crop-stage img');
    const dim = document.querySelector('#cropMask .crop-dim');
    const i = img.getBoundingClientRect();
    const strips = [...dim.children].map((e) => e.getBoundingClientRect());
    const cy = i.top + i.height / 2, cx = i.left + i.width / 2;
    const atY = strips.filter((r) => r.top <= cy && r.bottom >= cy);
    const atX = strips.filter((r) => r.left <= cx && r.right >= cx);
    return {
      img: [+i.width.toFixed(2), +i.height.toFixed(2)],
      client: [img.clientWidth, img.clientHeight],
      gaps: {
        left: +(Math.min(...atY.map((r) => r.left)) - i.left).toFixed(2),
        right: +(i.right - Math.max(...atY.map((r) => r.right))).toFixed(2),
        top: +(Math.min(...atX.map((r) => r.top)) - i.top).toFixed(2),
        bottom: +(i.bottom - Math.max(...atX.map((r) => r.bottom))).toFixed(2),
      },
    };
  })()`);
  // 图片显示尺寸必须是小数，否则这条用例测不到东西（退化成整数说明视口变了，得重新挑图）
  const fractional = fracDim.img.some((v) => Math.abs(v - Math.round(v)) > 0.01);
  check('裁剪：图片被缩成小数尺寸时，压暗四边仍然贴死（右/下不留 1px 亮线）',
    fractional && Math.max(...Object.values(fracDim.gaps).map(Math.abs)) <= 0.05,
    `图片 ${JSON.stringify(fracDim.img)}（取整 ${JSON.stringify(fracDim.client)}）· gaps ${JSON.stringify(fracDim.gaps)}`
      + (fractional ? '' : ' · 图片尺寸是整数，这条用例已测不到亚像素，需要换一张图'));
  await page.evaluate(`(() => { const b = document.querySelector('#cropMask [data-act="cancel"]'); if (b) b.click(); return true; })()`);

  // ---- 关闭服务：设置里的「服务」分组 ----
  // 关掉后端是不可逆动作（所有标签页 + MCP 客户端一起断），所以必须二次确认。
  // 这里先验确认条，再真的关一次——e2e 起的就是个临时实例，关掉正好把收尾也验了。
  await page.evaluate(`document.querySelector('[data-act="settings"]').click()`);
  await page.waitFor(`!!document.getElementById('setShutdown')`, 5000);
  await page.evaluate(`document.getElementById('setShutdown').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const confirmUi = await page.evaluate(`(() => ({
    bar: !!document.querySelector('#appSettings .set-srv-confirm'),
    go: (document.getElementById('setSrvGo') || {}).textContent || '',
    cancel: !!document.getElementById('setSrvCancel'),
    overlay: !document.getElementById('serverDown').classList.contains('hidden'),
  }))()`);
  check('点「关闭服务…」先弹二次确认，不会直接关',
    confirmUi.bar && /确定关闭/.test(confirmUi.go) && confirmUi.cancel && !confirmUi.overlay,
    JSON.stringify(confirmUi));

  await page.evaluate(`document.getElementById('setSrvCancel').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const afterCancel = await page.evaluate(`(() => ({
    bar: !!document.querySelector('#appSettings .set-srv-confirm'),
    overlay: !document.getElementById('serverDown').classList.contains('hidden'),
    btn: !!document.getElementById('setShutdown'),
  }))()`);
  check('取消之后什么都不会发生（确认条收起、服务还在）',
    !afterCancel.bar && !afterCancel.overlay && afterCancel.btn, JSON.stringify(afterCancel));

  // 真关：先点确认，再等页面把「服务已关闭」写出来
  await page.evaluate(`document.getElementById('setShutdown').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(`document.getElementById('setSrvGo').click()`);
  let downText = '';
  for (let k = 0; k < 80; k++) {
    downText = await page.evaluate(`(() => {
      const b = document.getElementById('serverDown');
      if (!b || b.classList.contains('hidden')) return '';
      return (document.getElementById('serverDownText') || {}).textContent || '';
    })()`);
    if (/服务已关闭/.test(downText)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  let reachable = true;
  try {
    const r = await fetch(server.base + 'api/health', { signal: AbortSignal.timeout(2000) });
    reachable = r.ok;
  } catch { reachable = false; }
  check('点「确定关闭」→ 盖上说明页，且服务真的不再响应',
    /服务已关闭/.test(downText) && !reachable, `${downText} · reachable=${reachable}`);

} catch (e) {
  check('运行过程未抛错', false, String(e && e.message ? e.message : e));
} finally {
  if (page) await page.close();
  if (chromeCtx) await stopChrome(chromeCtx);
  await server.stop();
  rmDir(dataDir);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 项：通过 ${results.length - failed.length} · 失败 ${failed.length}`);
if (fs.existsSync(path.join(TMP, 'chrome-profile'))) {
  rmDir(path.join(TMP, 'chrome-profile'));
}
process.exit(failed.length ? 1 : 0);

