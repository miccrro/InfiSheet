#!/usr/bin/env node
/**
 * e2e 冒烟：起隔离 server → 开 headless Chrome → 按真实交互走一遍关键路径 → 断言。
 * 不依赖 ComfyUI（不出图），也不碰你的 data/。
 *
 *   npm run test:e2e            # 默认 headless
 *   HEADED=1 npm run test:e2e   # 想看着它跑
 *   GROUP=资产 npm run test:e2e  # 只打印名字里带「资产」的用例（流程仍然全跑）
 *   STOP_AT=资产 npm run test:e2e # 跑到名字里带「资产」的第一条就收工（改前面某块时反馈快）
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, newPage, stopChrome } from './cdp.mjs';
import { ROOT, TMP, freePort, makeDataDir, seedProject, startServer, rmDir } from './lib/server.mjs';

const results = [];
// GROUP / STOP_AT 是「改一块、只看这一块」的旋钮。
// 这个脚本是一条顺序流程（前一段留下的画布和项目是后一段的前提），没法把中间某一段
// 单独拎出来跑，所以：
//   GROUP=资产 npm run test:e2e   仍然全跑，但只打印名字里带「资产」的用例——失败时不用翻 470 行
//   STOP_AT=资产 npm run test:e2e  跑到名字里带「资产」的那条就收工，改前面某块时反馈快
// 真要「只跑资产库 60 秒」，得把脚本按节拆成可独立启动的文件，那是另一件事。
const GROUP = (process.env.GROUP || '').trim();
const STOP_AT = (process.env.STOP_AT || '').trim();
class StopRun extends Error {}
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!GROUP || name.includes(GROUP)) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  }
  if (STOP_AT && name.includes(STOP_AT)) throw new StopRun(`STOP_AT=${STOP_AT}`);
}
// 环境相关的用例显式跳过，而不是长期红着。
// 一条永远红的断言等于没有断言：真回归混在那片红里也看不出来。
function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why });
  if (!GROUP || name.includes(GROUP)) console.log(`SKIP  ${name}  [${why}]`);
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
  const { buildGenGraph, dimsTarget, refMarks, batchShortfall } = new Function(
    `${pickFn(appSrc, 'bindRefImages')}\n${pickFn(appSrc, 'freshNodeId')}\n${pickFn(appSrc, 'dimsTarget')}\n${pickFn(appSrc, 'dimsSwitches')}\n${pickFn(appSrc, 'refCapacity')}\n${pickFn(appSrc, 'promptPlan')}\n${pickFn(appSrc, 'planSeed')}\n${pickFn(appSrc, 'batchShortfall')}\n${pickFn(appSrc, 'refMarks')}\n${pickFn(appSrc, 'buildGenGraph')}\nreturn { buildGenGraph, dimsTarget, dimsSwitches, promptPlan, planSeed, refMarks, batchShortfall, bindRefImages };`)();

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

  // 角标写成「2 次」但只生成了一次：同一次生成被记了两遍。
  // 根因是 pushRun 以前走 runsOf 的迁移分支，而那时 gen.gallery 已经被这次结果覆盖 ——
  // 迁移把**刚出的这批图**当成「更早的一次」，再叠上真正那条，历史里两条指向同一张图。
  // 下面三条：① 写坏的老存档读出来就自愈 ② 追加时不再编造 ③ 别把正常历史去重掉
  const dupNode = { id: 'd', type: 'image', gen: {
    gallery: [{ filename: 'k_00022_.png' }],
    runs: [
      { at: 1000, w: 1024, h: 1024, seed: 7, items: [{ filename: 'k_00022_.png' }] },
      { at: 0, legacy: true, w: null, h: null, seed: 7, items: [{ filename: 'k_00022_.png' }] },
    ],
  } };
  const dupRuns = runsOf(dupNode);
  check('生成历史：同一次生成的重复记录只留一条，留下的是带时间/尺寸的那条（角标不再写成「2 次」）',
    dupRuns.length === 1 && dupRuns[0].at === 1000 && !dupRuns[0].legacy
      && dupNode.gen.runs.length === 1,      // 顺手自愈存档，下次保存就是干净的
    `${dupRuns.length} 条 · ${JSON.stringify(dupRuns[0] && { at: dupRuns[0].at, legacy: !!dupRuns[0].legacy })}`);

  const freshNode = { id: 'f', type: 'image', gen: { gallery: [{ filename: 'old.png' }] } };
  pushRun(freshNode, { at: 2, prompt: '这次', items: [{ filename: 'new.png' }] });
  check('生成历史：第一次生成只记一条（不拿刚出的图再造一条「更早」）',
    freshNode.gen.runs.length === 1 && !freshNode.gen.runs.some((r) => r.legacy),
    JSON.stringify(freshNode.gen.runs.map((r) => ({ legacy: !!r.legacy, at: r.at }))));

  const twiceNode = { id: 't', type: 'image', gen: { runs: [] } };
  pushRun(twiceNode, { at: 3, items: [{ filename: 'a.png' }] });
  pushRun(twiceNode, { at: 2, items: [{ filename: 'b.png' }] });
  check('生成历史：真生成两次（产物不同）留两条，别把正常历史去重掉',
    runsOf(twiceNode).length === 2, `${runsOf(twiceNode).length} 条`);

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

  // 扩图的尺寸算法是纯函数：四边各扩多少 → 新画布（宽高必须是 16 的倍数）。
  // 为什么是 16 而不是 8：生成面板的「自定义尺寸」走 snapDim 也是 16 的倍数，
  // 两边步长不一致时 696 这种尺寸会被面板舍成 688 —— 图上和设置里又对不上了。
  // 浏览器里那张测试图只有 16×16，16 像素一格等于 100% 的台阶，比例根本量不准，
  // 所以「比例准不准」在 Node 里用真实尺寸验，浏览器只验「画布真的变宽了」。
  const { outpaintSize, outpaintBands, outpaintPad, outpaintFrame } = new Function(
    `${pickFn(appSrc, 'snapSide')}\n${pickFn(appSrc, 'fitPad')}\n${pickFn(appSrc, 'outpaintPad')}\n`
    + `${pickFn(appSrc, 'outpaintFrame')}\n`
    + `${pickFn(appSrc, 'outpaintSize')}\n${pickFn(appSrc, 'outpaintBands')}\n`
    + 'return { outpaintSize, outpaintBands, outpaintPad, outpaintFrame };')();
  const os16 = outpaintSize(1024, 768, 16 / 9, 20);
  const osP = outpaintSize(1024, 768, 9 / 16, 20);
  const osPad = outpaintSize(1024, 768, 0, 20);
  check('扩图尺寸：真实尺寸下 16:9 / 9:16 / 原比例都算得准，且都是 16 的倍数',
    os16[0] % 16 === 0 && os16[1] % 16 === 0 && Math.abs(os16[0] / os16[1] - 16 / 9) < 0.02
      && osP[0] % 16 === 0 && osP[1] % 16 === 0 && Math.abs(osP[0] / osP[1] - 9 / 16) < 0.02
      && osPad[0] % 16 === 0 && osPad[1] % 16 === 0
      && osPad[0] > 1024 && osPad[1] > 768,
    JSON.stringify({ os16, osP, osPad }));
  // 四条边：中间那块必须正好等于原图，四条带子拼起来不重叠。
  // 用「原比例 + 四周各扩 20%」这一路——宽高都长，四条边才都出现。
  const fPad = outpaintFrame(1024, 768, outpaintPad(1024, 768, 0, 20));
  const ob = outpaintBands(1024, 768, fPad.nw, fPad.nh, fPad.ox, fPad.oy);
  const areaOf = (bs) => bs.reduce((s, b) => s + b[2] * b[3], 0);
  check('扩图遮罩：四条边围住原图，带子面积 + 原图面积 = 新画布面积',
    ob.length === 4 && fPad.ox > 0 && fPad.oy > 0
      && areaOf(ob) + 1024 * 768 === fPad.nw * fPad.nh,
    JSON.stringify({ ox: fPad.ox, oy: fPad.oy, bands: ob, area: areaOf(ob) }));
  // 四边各扩可以不一样（拖锚点就是这么来的）：原图偏左，右边只留一条窄边。
  // 数字都挑成 16 的倍数，snap 之后不会多出零头把 ox/oy 顶离 0。
  const fAsym = outpaintFrame(1024, 768, { l: 200, t: 0, r: 40, b: 128 });
  const ab = outpaintBands(1024, 768, fAsym.nw, fAsym.nh, fAsym.ox, fAsym.oy);
  check('扩图遮罩：四边扩得不一样时，原图不在正中间，遮罩仍然只盖住新长出来的部分',
    fAsym.ox === 200 && fAsym.oy === 0 && ab.length === 3
      && areaOf(ab) + 1024 * 768 === fAsym.nw * fAsym.nh,
    JSON.stringify({ frame: fAsym, bands: ab, area: areaOf(ab) }));

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

  // 拿 fixtures/workflows 里的真实图再过一遍（原来读的是 presets/，内置预设已整档删掉）：
  // 大多数宽高是连线，这条就是防「面板选了尺寸、提交图上没写」的回归。
  //
  // 分族看的是**图里有没有尺寸来源**（EmptyLatentImage / ResolutionSelector 这类）。
  // 没有尺寸来源的那一族（超分放大）尺寸必须跟着输入图走：它是「把这张图放大」，
  // 钉死 1280×720 反而是错的。
  const wfFixtureDir = path.join(ROOT, 'tests', 'fixtures', 'workflows');
  const presetRows = fs.readdirSync(wfFixtureDir).filter((f) => f.endsWith('.json')).map((f) => {
    const g = JSON.parse(fs.readFileSync(path.join(wfFixtureDir, f), 'utf8')).graph;
    const t = dimsTarget(g);
    const r = buildGenGraph(g, [], { width: 1280, height: 720 }, 1, 'p', null);
    const takesImage = Object.values(g).some((x) => {
      const ct = (x || {}).class_type;
      return ct === 'LoadImage' || ct === 'LoadImageMask';
    });
    return { f: f.replace(/\.(api\.)?json$/, ''), t, sized: r.sized, noSizeSrc: !t, takesImage,
      w: t ? r.graph[t].inputs.width : 0, h: t ? r.graph[t].inputs.height : 0 };
  });
  // 不写死数量：夹具目录随时会多一个
  const pinned = presetRows.filter((p) => !p.noSizeSrc);
  const followers = presetRows.filter((p) => p.noSizeSrc);
  check('样本工作流全部钉得住尺寸（含从 ResolutionSelector 连线的）',
    presetRows.length >= 4 && pinned.length >= 3
      && pinned.every((p) => p.sized && p.w === 1280 && p.h === 720),
    presetRows.map((p) => `${p.f}→${p.t || '无'}:${p.w}×${p.h}`).join(' | '));
  check('没有尺寸来源的样本不钉尺寸，但必须真吃得下输入图（局部重绘 / 超分都是「尺寸跟着原图走」）',
    followers.length >= 1 && followers.every((p) => !p.sized && p.takesImage),
    followers.map((p) => `${p.f}→${p.t || '无'}·吃图=${p.takesImage}`).join(' | ') || '没有这类样本');

  // ---- 尺寸被「开关」挡着：Qwen turbo 编辑流（SamplerCustomAdvanced + ComfySwitchNode）----
  // 编码器自己会按参考图吐一个 latent，工作流用开关二选一：on_true = 空 latent（面板尺寸），
  // on_false = 编码器那个（参考图尺寸）。导出时停在 on_false，尺寸写进 on_true 却不拨开关，
  // 出图永远是参考图大小——用户看到的就是「自定义画幅不生效」（面板 1152×2048，出图 1024×1008）。
  const turbo = {
    '505': { class_type: 'SamplerCustomAdvanced', inputs: { latent_image: ['468', 0] } },
    '468': { class_type: 'ComfySwitchNode', inputs: { switch: false, on_false: ['474', 2], on_true: ['456', 0] } },
    '456': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '474': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'p' } },
  };
  const tr = buildGenGraph(turbo, [], { width: 1152, height: 2048 }, 1, 'p', null);
  check('尺寸写进开关的另一支时，开关要跟着拨过去（否则自定义画幅不生效）',
    tr.sized && tr.graph['468'].inputs.switch === true
      && tr.graph['456'].inputs.width === 1152 && tr.graph['456'].inputs.height === 2048,
    JSON.stringify(tr.graph['468'].inputs));
  check('开关是连线的（工作流自己的机关）就不硬改，但也不能谎报尺寸生效',
    (() => {
      const g = JSON.parse(JSON.stringify(turbo));
      g['468'].inputs.switch = ['999', 0];
      const r = buildGenGraph(g, [], { width: 512, height: 768 }, 1, 'p', null);
      return r.sized === false && Array.isArray(r.graph['468'].inputs.switch);
    })(), 'blocked');

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

  // ---- 首次使用引导：先确认生成的图存哪 ----
  // 只问一次。主按钮是「用默认，开始使用」——绝大多数人不用改，别为了一个可选项拦路。
  // 这段必须排在所有画布用例前面：卡片是浮层，不关掉后面点哪儿都点在遮罩上。
  let setupCard = null;
  try {
    setupCard = await page.waitFor(`(() => {
      const el = document.getElementById('setupCard');
      if (!el) return null;
      const inp = el.querySelector('.setup-path');
      return { lead: (el.querySelector('.setup-lead') || {}).textContent || '',
               dir: inp ? inp.value : '',
               defBtn: (el.querySelector('.setup-default') || {}).textContent || '',
               hint: (el.querySelector('.setup-hint') || {}).textContent || '' };
    })()`, 12000);
  } catch { setupCard = null; }
  check('首次打开：先问一次「生成的图存哪」',
    !!setupCard && /自动存一份/.test(setupCard.lead || ''), JSON.stringify(setupCard));
  check('引导预填默认目录（程序目录下的 assets），主按钮是「用默认，开始使用」',
    !!setupCard && String(setupCard.dir).replace(/\\/g, '/').endsWith('/assets')
      && /用默认/.test(setupCard.defBtn || ''),
    JSON.stringify(setupCard));
  await page.evaluate(`document.querySelector('#setupCard .setup-default').click()`);
  const setupClosed = await page.waitFor(`!document.getElementById('setupCard')`, 8000)
    .catch(() => false);
  check('点「用默认，开始使用」→ 卡片关掉，不拦着画布', setupClosed === true);
  const setupAfter = await (await fetch(server.base + 'api/setup')).json();
  check('设置完就不再问（needsSetup 落成 false，下次打开直接进画布）',
    setupAfter.needsSetup === false, JSON.stringify(setupAfter));

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

  const materialMenu = await page.evaluate(`(() => {
    const node = document.querySelector('.node.selected');
    const before = node.querySelector('.thumb img')?.getAttribute('src') || '';
    node.querySelector('.gen-material').click();
    const menu = document.querySelector('.material-menu');
    const items = menu ? [...menu.querySelectorAll('.material-item')] : [];
    return {
      before,
      afterOpen: node.querySelector('.thumb img')?.getAttribute('src') || '',
      title: menu?.querySelector('.popmenu-title')?.textContent,
      count: items.length,
      thumbnails: items.every((x) => !!x.querySelector('img')?.getAttribute('src')),
    };
  })()`);
  check('画布素材先打开带缩略图的选择列表，不会直接换成第一张图',
    materialMenu.title === '选择画布图片' && materialMenu.count >= 2
      && materialMenu.thumbnails && materialMenu.afterOpen === materialMenu.before,
    JSON.stringify(materialMenu));
  const materialPick = await page.evaluate(`(() => {
    const item = [...document.querySelectorAll('.material-menu .material-item')].at(-1);
    const expected = item.querySelector('img').getAttribute('src');
    item.click();
    return {
      chosen: document.querySelector('.node.selected .thumb img')?.getAttribute('src') === expected,
      closed: !document.querySelector('.material-menu'),
    };
  })()`);
  check('选中指定画布素材后才替换当前节点图片',
    materialPick.chosen && materialPick.closed, JSON.stringify(materialPick));
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 200));

  // 面板是同步建的，但「底部渐隐」的 has-more 要等一帧（app.js 里是 requestAnimationFrame 里算的，
  // 因为要先有布局才知道 scrollHeight）。以前这里直接读，偶尔会抢在那一帧之前 → 偶发红。
  await page.waitFor(`!!document.querySelector('.gen-panel .gen-prompt')`, 5000);
  await page.evaluate(`(() => {
    const ta = document.querySelector('.gen-panel .gen-prompt');
    window.__fadePromptOriginal = ta.innerHTML;
    ta.textContent = Array(40).fill('E2E long prompt text to verify bottom fade').join('\\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.waitFor(`document.querySelector('.gen-panel .gen-prompt')?.classList.contains('has-more')`, 3000).catch(() => null);
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
      statusRow: !!p.querySelector('.gen-status-row .gen-status'),
      prompt: { minH: ts.minHeight, maxH: ts.maxHeight, border: ts.borderTopWidth, bg: ts.backgroundColor, scrollable: ta.scrollHeight > ta.clientHeight, masked: ta.classList.contains('has-more') },
      run: { h: Math.round(run.getBoundingClientRect().height), bg: rs.backgroundColor, radius: rs.borderRadius },
      pill: { h: Math.round(pill.getBoundingClientRect().height) },
    };
  })()`);
  check('生成器面板出现', panel && panel.visible);
  check('提示词框：无边框、92~190px、透明底',
    panel && panel.prompt.border === '0px' && panel.prompt.minH === '92px' && panel.prompt.maxH === '190px' && panel.prompt.bg === 'rgba(0, 0, 0, 0)',
    JSON.stringify(panel?.prompt));
  check('长提示词出现底部渐隐', panel && panel.prompt.masked === true);
  await page.evaluate(`(() => {
    const ta = document.querySelector('.gen-panel .gen-prompt');
    if (ta && window.__fadePromptOriginal !== undefined) {
      ta.innerHTML = window.__fadePromptOriginal;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      delete window.__fadePromptOriginal;
    }
  })()`);

  // ---- 生成器面板：固定版面（660 宽），贴在节点下沿，且不跟画布缩放 ----
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
  check('面板是固定 660 宽的版面（不再跟着节点宽度走）',
    Math.abs(pg0.w - 660) <= 1 && pg0.w - pg0.nodeW >= 32, `${pg0.w} vs 节点 ${pg0.nodeW}`);
  // 圆角矩形而不是胶囊：这一排和底栏两个下拉、展开键、发送键共用同一个 8px，
  // 整块面板里不再有「胶囊 + 正圆 + 方角」三种圆角并排。
  check('上排按钮：8px 圆角矩形、实心底、浅灰字（对齐参考图那颗「＋ 上传」）',
    pg0.chipRadius === '8px' && pg0.chipColor === 'rgb(204, 211, 222)'
      && pg0.chipH >= 23 && pg0.chipH <= 27,
    `${pg0.chipRadius} / ${pg0.chipColor} / ${pg0.chipH}px`);

  // 固定版面＝换挡不换尺寸：200% 下还是 660×同样的高，缝还是 10px（间距按 1/k 补偿过）
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
  // 状态文字从底栏里**搬出来**单占一行了（见 .gen-status-row）：底栏要放工作流名 /
  // 画幅 / 张数 / 生成键，谁长了都得截，而报错恰恰不能截。所以这里只剩四样东西。
  check('底栏顺序：工作流 → 竖线 → 参数 → 生成',
    panel && panel.barChildren.join(',') === 'gensel,gen-sep,gensel,gen-run',
    panel ? panel.barChildren.join(',') : '');
  check('状态文字不在底栏里，单独一行',
    panel && !panel.barChildren.includes('gen-status') && panel.statusRow === true,
    panel ? JSON.stringify({ bar: panel.barChildren, row: panel.statusRow }) : '');
  check('生成按钮与左侧下拉同高、纯白、8px 圆角矩形', panel && Math.abs(panel.run.h - panel.pill.h) <= 1 && panel.run.bg === 'rgb(255, 255, 255)' && panel.run.radius === '8px',
    panel ? JSON.stringify(panel.run) + ' pill=' + panel.pill.h : '');

  // 底栏去胶囊：两个下拉以前是「999px + 实心底 + 一圈描边」的药丸，比下面的提示词还抢眼。
  // 现在改成「图标 + 名字 | 图标 + 名字」的平铺文字，底色跟面板一致，只有 hover / 展开时
  // 给一块**不带描边**的圆角矩形。
  // 画布上可能同时挂着好几个节点的面板，只看**选中节点**这一个
  const barLook = await page.evaluate(`(() => {
    const root = document.querySelector('.node.selected .gen-panel') || document.querySelector('.gen-panel');
    const sels = [...root.querySelectorAll('.gen-bar .gensel')];
    const cs = sels.map((el) => getComputedStyle(el));
    const sep = root.querySelector('.gen-bar .gen-sep');
    const sr = sep ? sep.getBoundingClientRect() : null;
    const bar = root.querySelector('.gen-bar');
    const run = root.querySelector('.gen-bar .gen-run');
    return {
      // 生成按钮的右边缘离底栏右边缘还差多少：应该是 0（状态文字 flex:1 把空位吃满）
      runGap: Math.round(bar.getBoundingClientRect().right - run.getBoundingClientRect().right),
      // 工作流那颗现在直接用图标表里的 wf：两个方框 + 一条肘形连线，和「新建节点」
      // 菜单里那颗是同一张图。以前这里是一张 48 栅格、自带 stroke-width 的「三个圆环
      // 串一圈」手绘图——子元素一旦写死描边，style.css 的 --oi-stroke 光学补偿就全废了，
      // 它也是整个界面里唯一不在 24 栅格体系里的图标。
      wf: (() => {
        const svg = root.querySelector('.gen-bar .gensel.wfsel .gensel-icon svg');
        if (!svg) return null;
        const same = (name) => {
          const tmp = document.createElement('div');
          tmp.innerHTML = window.icon(name);
          return tmp.firstChild ? svg.innerHTML.trim() === tmp.firstChild.innerHTML.trim() : false;
        };
        return {
          rects: svg.querySelectorAll('rect').length,
          paths: svg.querySelectorAll('path').length,
          viewBox: svg.getAttribute('viewBox'),
          // 子元素自带 stroke-width 的个数：必须是 0，否则描边粗细不受 CSS 控制
          inlineSw: [...svg.children].filter((c) => c.getAttribute('stroke-width')).length,
          isWf: same('wf'),
          // 顺手确认它不是以前那颗链环：换了图标但忘了改断言的话，这里会红
          isLink: same('link'),
        };
      })(),
      // 上排 chips：圆角矩形（8px），不是胶囊
      chip: (() => {
        const c = root.querySelector('.gen-chips .chip:not(.icon-only)');
        if (!c) return null;
        const cs = getComputedStyle(c);
        return { radius: cs.borderTopLeftRadius, h: Math.round(c.getBoundingClientRect().height) };
      })(),
      runRadius: run ? getComputedStyle(run).borderTopLeftRadius : '',
      // 展开那颗是纯图标按钮：图标必须在方框正中间（四边留白相等）
      expand: (() => {
        const b = root.querySelector('.gen-chips .chip.icon-only');
        if (!b) return null;
        const svg = b.querySelector('svg');
        const br = b.getBoundingClientRect(), sr = svg.getBoundingClientRect();
        return {
          pad: getComputedStyle(b).padding,
          gaps: [Math.round(sr.left - br.left), Math.round(br.right - sr.right),
                 Math.round(sr.top - br.top), Math.round(br.bottom - sr.bottom)],
          h: Math.round(br.height),
          rowH: Math.round(root.querySelector('.gen-chips .chip').getBoundingClientRect().height),
        };
      })(),
      n: sels.length,
      radius: cs.map((c) => c.borderTopLeftRadius),
      bg: cs.map((c) => c.backgroundColor),
      border: cs.map((c) => c.borderTopWidth),
      sep: sr ? [Math.round(sr.width), Math.round(sr.height)] : null,
      sepBg: sep ? getComputedStyle(sep).backgroundColor : '',
    };
  })()`);
  check('底栏两个下拉不再是胶囊：透明底、无描边、8px 圆角',
    barLook.n === 2 && barLook.radius.every((r) => r === '8px')
      && barLook.bg.every((b) => b === 'rgba(0, 0, 0, 0)')
      && barLook.border.every((b) => b === '0px'),
    JSON.stringify(barLook));
  check('两块之间是一根 1px 竖线（「图标+名字 | 图标+名字」）',
    !!barLook.sep && barLook.sep[0] === 1 && barLook.sep[1] >= 10 && barLook.sepBg !== 'rgba(0, 0, 0, 0)',
    JSON.stringify({ sep: barLook.sep, bg: barLook.sepBg }));
  // 状态文字以前被 max-width:30% 卡住，空着也占不到整行，右边空出一大截，
  // 生成按钮就停在离右边 140px 的地方——看着像没对齐。
  check('生成按钮贴到最右边（状态文字把中间的空位吃满）',
    barLook.runGap === 0, `还差 ${barLook.runGap}px`);
  check('工作流那颗图标：和图标表里的 wf 是同一张图（两个方框 + 肘形连线）',
    !!barLook.wf && barLook.wf.isWf === true && barLook.wf.isLink === false
      && barLook.wf.rects === 2 && barLook.wf.paths === 1
      && barLook.wf.viewBox === '0 0 24 24' && barLook.wf.inlineSw === 0,
    JSON.stringify(barLook.wf));
  // 圆角统一：chips / 两个下拉 / 展开键 / 发送键一律 8px 圆角矩形。
  // 以前 chips 是胶囊、发送键是正圆、展开键是 8px 方角，三种圆角并排看着像拼起来的。
  check('圆角统一成圆角矩形：chips 8px、发送键 8px',
    !!barLook.chip && barLook.chip.radius === '8px' && barLook.chip.h === 26
      && barLook.runRadius === '8px',
    JSON.stringify({ chip: barLook.chip, run: barLook.runRadius }));
  // 展开那颗是纯图标按钮：以前 `.gen-chips .chip` 的 `padding: 0 10px` 也套在它身上，
  // 26px 的框减掉左右各 10 只剩 6px 内容宽，14px 的图标向两边各溢出 4px——看着就是「没居中」。
  check('展开按钮：图标在方框正中（四边留白相等），高度和旁边的胶囊一致',
    !!barLook.expand && barLook.expand.pad === '0px'
      && barLook.expand.gaps.every((g) => Math.abs(g - barLook.expand.gaps[0]) <= 1)
      && barLook.expand.h === barLook.expand.rowH,
    JSON.stringify(barLook.expand));

  const barPt = await page.center('.node.selected .gen-panel .gen-bar .gensel.wfsel');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(barPt.x), y: Math.round(barPt.y) });
  await new Promise((r) => setTimeout(r, 220));
  const barHover = await page.evaluate(`(() => {
    const el = document.querySelector('.node.selected .gen-panel .gen-bar .gensel.wfsel');
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopWidth };
  })()`);
  check('鼠标移上去：亮一块圆角矩形，仍然没有描边',
    /^rgba?\(255, 255, 255, 0\.[0-9]+\)$/.test(barHover.bg) && barHover.border === '0px',
    JSON.stringify(barHover));

  await page.clickAt(barPt.x, barPt.y);
  await new Promise((r) => setTimeout(r, 350));
  const barOpen = await page.evaluate(`(() => {
    const el = document.querySelector('.node.selected .gen-panel .gen-bar .gensel.wfsel');
    return { cls: el.className, menu: !!document.querySelector('.popmenu'),
             bg: getComputedStyle(el).backgroundColor };
  })()`);
  check('点开菜单：这颗下拉保持高亮（去胶囊后只剩底色能说明菜单从哪儿弹出来）',
    /pop-open/.test(barOpen.cls) && barOpen.menu && barOpen.bg === 'rgba(255, 255, 255, 0.1)',
    JSON.stringify(barOpen));
  await page.clickAt(barPt.x, barPt.y);          // 再点一次收起，别把菜单留给后面的用例
  await new Promise((r) => setTimeout(r, 300));
  check('收起菜单：高亮撤掉',
    !/pop-open/.test(await page.evaluate(`document.querySelector('.node.selected .gen-panel .gen-bar .gensel.wfsel').className`)),
    await page.evaluate(`document.querySelector('.node.selected .gen-panel .gen-bar .gensel.wfsel').className`));

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
    // 13 个固定比例 + 第一格「智能」（按图片实际宽高比算）
    opts.open && opts.sections.join(',') === '画幅,清晰度,张数,种子'
    && opts.ratios.length === 14 && opts.ratios[0] === 'auto' && opts.cols === 5,
    JSON.stringify({ sections: opts.sections, ratios: opts.ratios?.length, first: opts.ratios?.[0], cols: opts.cols }));
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

  // 存进存档的也得是新值，不能只是 UI 上换了张皮。
  // 这里是「等文件变成新值」而不是「睡 800ms 再看」：存档有防抖，机器一忙
  // 固定等待就会偶发红一次（实测跑 e2e 的同时还开着别的实例时必现）。
  const readGen = () => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${projId}.json`), 'utf8'));
      return (j.nodes.find((x) => x.id === 'i2') || {}).gen || {};
    } catch { return {}; }
  };
  const wantGen = (g) => g.aspect === '9:16' && g.size === '2k' && Number(g.batch) === 2
    && g.seedMode === 'fixed' && Number(g.seed) === 12345;
  let savedOpts = readGen();
  for (let k = 0; k < 30 && !wantGen(savedOpts); k++) {
    await new Promise((r) => setTimeout(r, 100));
    savedOpts = readGen();
  }
  check('画幅 / 清晰度 / 张数 / 种子写进了存档', wantGen(savedOpts),
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

  // 悬浮控制条：12px 圆角矩形（不是胶囊）；条高统一 40、条内控件 32×32——
  // 这套 token 见 style.css 的「悬浮控制条统一」一节（--ui-bar-h / --ui-bar-r / --ui-ctl）。
  // 以前四条条各写各的（42 / 34 / 46 / 52，圆角 16 / 16 / 999 / 999），后来统一成一档。
  // 主按钮带文字所以更宽（≥40），但高度和次级按钮同档——它不再比另外三条条高。
  const shapes = await page.evaluate(`(() => {
    const prime = document.querySelector('#bar .icon.prime');
    const sec = document.querySelector('#bar [data-act="select-mode"]');
    const pb = document.querySelector('#projectBar .icon.tiny');
    const vt = document.querySelector('#viewTools .vt');
    const size = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const ico = (el) => {
      const s = el.querySelector('svg.oi') || el.querySelector('svg');
      const r = s.getBoundingClientRect();
      return Math.round(r.width);
    };
    return {
      bar: getComputedStyle(document.getElementById('bar')).borderRadius,
      vt: getComputedStyle(document.getElementById('viewTools')).borderRadius,
      primeR: getComputedStyle(prime).borderRadius,
      prime: size(prime),
      sec: size(sec),
      ctl: [size(pb), size(vt), size(sec)],
      ico: [ico(pb), ico(vt), ico(sec)],
      hs: ['projectBar', 'statusChip', 'viewTools'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().height)),
    };
  })()`);
  const square = (s) => s[0] === s[1];
  check('底栏 / 视图工具是 12px 圆角矩形；三条单行悬浮条同高 40；主按钮比次级宽但同高',
    shapes.bar === '12px' && shapes.vt === '12px'
      && shapes.hs.every((h) => h === 40)
      && shapes.prime[1] === shapes.sec[1]      // 同一档高度：主按钮不再单独拔高
      && shapes.prime[0] >= 40                  // 带文字，所以更宽
      && shapes.sec[0] === 32 && shapes.sec[1] === 32,
    JSON.stringify(shapes));
  check('项目栏 / 视图工具 / 底栏的普通按钮是同一档：32 方块 + 20 图标',
    shapes.ctl.every(square) && shapes.ctl.every((s) => s[0] === 32)
      && shapes.ico.every((n) => n === 20),
    JSON.stringify({ ctl: shapes.ctl, ico: shapes.ico }));

  // 紧凑模式走同一套 token：普通按钮 28 方块 + 18 图标，文字收起。
  // 直接改 body 上的 dataset 只验证 CSS 那一层（切换与持久化在「设置 → 界面密度」里另测）。
  // 按钮上有过渡，切完要等它跑完再量——否则量到的是上一档的 32。
  const shapeOf = () => page.evaluate(`(() => {
    const pb = document.querySelector('#projectBar .icon.tiny');
    const vt = document.querySelector('#viewTools .vt');
    const sec = document.querySelector('#bar [data-act="select-mode"]');
    const size = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const ico = (el) => Math.round((el.querySelector('svg.oi') || el.querySelector('svg')).getBoundingClientRect().width);
    return {
      ctl: [size(pb), size(vt), size(sec)],
      ico: [ico(pb), ico(vt), ico(sec)],
      label: getComputedStyle(document.querySelector('#bar .icon.prime .lbl')).display,
    };
  })()`);
  const prevDensity = await page.evaluate(`document.body.dataset.density || 'comfortable'`);
  await page.evaluate(`document.body.dataset.density = 'compact'`);
  await new Promise((r) => setTimeout(r, 420));
  const compactShape = await shapeOf();
  await page.evaluate(`document.body.dataset.density = '${prevDensity}'`);
  await new Promise((r) => setTimeout(r, 420));
  check('紧凑模式：同一批普通按钮收到 28 方块 + 18 图标，文字收起',
    compactShape.ctl.every((s) => s[0] === 28 && s[1] === 28)
      && compactShape.ico.every((n) => n === 18) && compactShape.label === 'none',
    JSON.stringify(compactShape));

  // 从端口拖到空白 → 菜单里挑节点：建完必须顺手接上。
  // 用户是从端口一路拖出来松手的，看到一个没连上的新节点等于白拖一次
  // （文本 / 图片这两支以前就是这样：只有「工作流」和「图片输出」接了线）。
  const linkBlank = await page.evaluate(`(() => {
    const port = document.querySelector('#nodes .node .port.out');
    if (!port) return null;
    let pt = null;
    for (let y = 120; y < window.innerHeight - 120 && !pt; y += 60) {
      for (let x = 900; x < window.innerWidth - 60; x += 60) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('.node, .group, .popmenu, #dockWrap, #viewTools, #minimap, #topBar, #canvasEmpty')) { pt = [x, y]; break; }
      }
    }
    if (!pt) return null;
    const r = port.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    port.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: pt[0], clientY: pt[1], buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: pt[0], clientY: pt[1], buttons: 0 }));
    return pt;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const linkMenuPick = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.popmenu button')].find((b) => b.textContent.trim() === '文本节点');
    if (!btn) return { picked: false, menu: [...document.querySelectorAll('.popmenu button')].map((b) => b.textContent.trim()) };
    btn.click();
    return { picked: true };
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  const linkMenuNew = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    const last = nodes[nodes.length - 1];
    return { id: last && last.dataset.id, inLinked: !!(last && last.querySelector('.port.in.linked')) };
  })()`);
  check('拖到空白建节点：建完自动接上（不是建了个散节点）',
    !!linkBlank && linkMenuPick.picked && linkMenuNew.inLinked,
    JSON.stringify({ linkBlank, linkMenuPick, linkMenuNew }));

  // 端口外那圈 6px 隐形命中区是给「抓」用的，松手不能也认它：
  // 两个挨着的节点之间整片都会变成连接区，用户拖出去想新建节点会被旁边的口抢走
  // （报的「拖出去自动吸住」）。这里把落点放在别的端口 20px 外的空白处，
  // 必须弹「接一个节点」，不能被吸过去直接连线。
  const magnet = await page.evaluate(`(() => {
    const out = document.querySelector('#nodes .node .port.out');
    if (!out) return null;
    const fromId = out.dataset.port.split(':')[0];
    for (const inp of document.querySelectorAll('#nodes .node .port.in')) {
      const toId = inp.dataset.port.split(':')[0];
      if (toId === fromId) continue;
      const r = inp.getBoundingClientRect();
      const pt = [Math.round(r.left - 20), Math.round(r.top + r.height / 2)];
      const el = document.elementFromPoint(pt[0], pt[1]);
      if (!el || el.closest('.node, .port, .popmenu, #dockWrap, #viewTools, #minimap, #topBar')) continue;
      const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      const or = out.getBoundingClientRect();
      out.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: or.left + or.width / 2, clientY: or.top + or.height / 2, buttons: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: pt[0], clientY: pt[1], buttons: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: pt[0], clientY: pt[1], buttons: 0 }));
      return { pt, toId };
    }
    return null;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const magnetMenu = await page.evaluate(`JSON.stringify([...document.querySelectorAll('.popmenu')].map((m) => m.textContent.replace(/\\s+/g, ' ').trim()))`);
  check('端口吸附不越界：落在别家端口 20px 外要弹菜单，不能直接吸住',
    !magnet || magnetMenu.includes('接一个节点'), JSON.stringify({ magnet, magnetMenu }));
  await page.evaluate(`document.querySelectorAll('.popmenu').forEach((m) => m.remove())`);

  // 多选拖线：选中两个节点后从一个的输出口拖到同一个目标，两个都要接上
  // （用户要的「多选可以同时拖拽连接同一节点」）
  const batch = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    const target = nodes.find((n) => n.classList.contains('image') && !n.querySelector('.port.in.linked'));
    if (!target) return null;
    const srcs = nodes.filter((n) => n !== target && n.querySelector('.port.out')).slice(0, 2);
    if (srcs.length < 2) return null;
    const pick = (el, shift) => {
      const t = el.querySelector('.node-title') || el;
      const r = t.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, shiftKey: shift };
      t.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 0 }));
    };
    pick(srcs[0], false);
    pick(srcs[1], true);
    const before = document.querySelectorAll('#links path').length;
    const out = srcs[0].querySelector('.port.out');
    const inp = target.querySelector('.port.in');
    const or = out.getBoundingClientRect();
    const ir = inp.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    out.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: or.left + or.width / 2, clientY: or.top + or.height / 2, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: ir.left + ir.width / 2, clientY: ir.top + ir.height / 2, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: ir.left + ir.width / 2, clientY: ir.top + ir.height / 2, buttons: 0 }));
    return { before, targetId: target.dataset.id, srcIds: srcs.map((n) => n.dataset.id), sel: document.querySelectorAll('#nodes .node.selected').length };
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const batchAfter = await page.evaluate(`(() => ({
    paths: document.querySelectorAll('#links path').length,
    flash: (document.getElementById('queueBadge') || {}).textContent || '',
  }))()`);
  check('多选拖线：选中的节点一起接到同一个目标',
    !!batch && batchAfter.flash.includes('已连上 2 个节点') && batchAfter.paths > batch.before,
    JSON.stringify({ batch, batchAfter }));
  await page.evaluate(`document.querySelectorAll('.popmenu').forEach((m) => m.remove())`);

  // 框选连线：拖一个框罩住某条线的中段，松手后这条线要被选中（提示里给条数）
  const marqueeLink = await page.evaluate(`(() => {
    const p = document.querySelector('#links .link-line');
    if (!p) return null;
    const pt = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM();
    const mid = { x: Math.round(m.a * pt.x + m.c * pt.y + m.e), y: Math.round(m.b * pt.x + m.d * pt.y + m.f) };
    let start = null;
    for (let d = 24; d <= 140 && !start; d += 8) {
      for (const [dx, dy] of [[-d, -d], [-d, d], [d, -d], [d, d]]) {
        const x = mid.x + dx, y = mid.y + dy;
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('.node, .port, #links, .popmenu, #dockWrap, #viewTools, #minimap, #topBar')) { start = { x, y }; break; }
      }
    }
    if (!start) return null;
    const end = { x: 2 * mid.x - start.x, y: 2 * mid.y - start.y };
    const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const stage = document.getElementById('stage');
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: start.x, clientY: start.y, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: end.x, clientY: end.y, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: end.x, clientY: end.y, buttons: 0 }));
    return { mid, start, end };
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const marqueeState = await page.evaluate(`(() => ({
    sel: document.querySelectorAll('#links .link-line.sel').length,
    flash: (document.getElementById('queueBadge') || {}).textContent || '',
  }))()`);
  check('框选连线：框住曲线中段就能选中，提示给出条数',
    !!marqueeLink && marqueeState.sel > 0 && marqueeState.flash.includes('条连线'),
    JSON.stringify({ marqueeLink, marqueeState }));
  // 收掉这次框选（点一下空白即可），别让后面的用例带着选中态跑
  await page.evaluate(`(() => {
    const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const stage = document.getElementById('stage');
    stage.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 8, clientY: 8, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 8, clientY: 8, buttons: 0 }));
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  // 左侧输入口拖到空白：语义是「添加上下文」，要弹出上游菜单并把新节点接进这一口。
  // 以前这条路径只在「正好松手在别的输出口上」才有反应，拖到空白什么都不发生。
  const srcDrag = await page.evaluate(`(() => {
    const port = [...document.querySelectorAll('#nodes .node .port.in')].find((p) => !p.classList.contains('linked'));
    if (!port) return null;
    const nodeId = port.dataset.port.split(':')[0];
    let pt = null;
    for (let y = 120; y < window.innerHeight - 120 && !pt; y += 60) {
      for (let x = 900; x < window.innerWidth - 60; x += 60) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('.node, .group, .popmenu, #dockWrap, #viewTools, #minimap, #topBar, #canvasEmpty')) { pt = [x, y]; break; }
      }
    }
    if (!pt) return null;
    const r = port.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    port.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: pt[0], clientY: pt[1], buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: pt[0], clientY: pt[1], buttons: 0 }));
    return { nodeId, pt };
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const srcMenu = await page.evaluate(`(() => {
    const menu = document.querySelector('.popmenu');
    const title = menu ? (menu.textContent || '').trim().slice(0, 5) : '';
    // 菜单项随目标节点类型变（文本节点的输入口只吃图片），所以取第一项，别写死文字
    const btn = menu && menu.querySelector('button');
    if (!btn) return { title, items: menu ? [...menu.querySelectorAll('button')].map((b) => b.textContent.trim()) : [] };
    btn.click();
    return { title, picked: true };
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  const srcTargetId = (srcDrag && srcDrag.nodeId) || '';
  const srcLinked = await page.evaluate(`(() => {
    const port = document.querySelector('[data-port="${srcTargetId}:in"]');
    return { linked: !!(port && port.classList.contains('linked')), nodes: document.querySelectorAll('#nodes .node').length };
  })()`);
  check('左输入口拖到空白：弹「添加上下文」，建完接进这一口',
    !!srcDrag && srcMenu.title === '添加上下文' && !!srcMenu.picked && srcLinked.linked,
    JSON.stringify({ srcDrag, srcMenu, srcLinked }));

  // 空图片节点上不再摆「上传图片 / 文本生图」两颗按钮：面板里本来就有「上传」和提示词框，
  // 两颗都是重复入口（用户原话：没有实际用处）
  const emptyTry = await page.evaluate(`(() => ({
    tries: document.querySelectorAll('.try-item, .thumb-empty .try').length,
    icons: document.querySelectorAll('.thumb-empty .ph-big').length,
  }))()`);
  check('空图片节点只剩大图标，没有「上传图片 / 文本生图」按钮',
    emptyTry.tries === 0 && emptyTry.icons > 0, JSON.stringify(emptyTry));

  // 空节点平时必须是「空的」：不摆任何推荐内容，只有鼠标进来才浮出提示
  // （用户报过「在没有任何操作的情况下绿色区域会显示推荐内容」）
  const hintIdle = await page.evaluate(`(() => {
    const h = document.querySelector('.node .thumb-hint');
    return h ? { opacity: getComputedStyle(h).opacity, text: h.textContent.trim() } : null;
  })()`);
  const hintBox = await page.evaluate(`(() => {
    const t = document.querySelector('.node .thumb.is-empty');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (hintBox) await page.clickAt(hintBox.x, hintBox.y, { settle: 350 });
  const hintHover = await page.evaluate(`(() => {
    const h = document.querySelector('.node .thumb-hint');
    return h ? getComputedStyle(h).opacity : null;
  })()`);
  check('空节点默认不显示任何内容，悬停才浮出「双击上传」提示',
    !!hintIdle && hintIdle.opacity === '0' && hintHover === '1'
      && hintIdle.text.includes('双击上传'), JSON.stringify({ hintIdle, hintHover }));

  // 提示词框：无边框（不要输入框那种方框感），拖右下角手柄能自由改高，
  // 双击手柄退回「按内容自动长高」（用户：将提示词框修改成无边框，可自由放大缩小）
  const textBox = await page.evaluate(`(() => {
    const node = document.querySelector('#nodes .node.text');
    const ta = node && node.querySelector('.text-body');
    const hd = node && node.querySelector('.node-resize');
    if (!ta || !hd) return null;
    const cs = getComputedStyle(ta);
    const before = Math.round(ta.getBoundingClientRect().height);
    const r = hd.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    hd.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: cx, clientY: cy, buttons: 1 }));
    // 只往下拉：横向位移为 0，宽度保持默认，别把后面用例的坐标算歪
    window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: cx, clientY: cy + 90, buttons: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: cx, clientY: cy + 90, buttons: 0 }));
    return {
      border: cs.borderTopWidth, bg: cs.backgroundColor, shadow: cs.boxShadow,
      before, after: Math.round(ta.getBoundingClientRect().height),
      overflowY: getComputedStyle(ta).overflowY,
    };
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  check('提示词框无边框：透明底、无描边、无阴影',
    !!textBox && textBox.border === '0px' && textBox.bg === 'rgba(0, 0, 0, 0)' && textBox.shadow === 'none',
    JSON.stringify(textBox));
  check('提示词框可自由拉高：拖手柄变高并切成滚动',
    !!textBox && textBox.after > textBox.before + 40 && textBox.overflowY === 'auto',
    JSON.stringify(textBox));

  const textReset = await page.evaluate(`(() => {
    const hd = document.querySelector('#nodes .node.text .node-resize');
    if (!hd) return null;
    hd.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const ta = document.querySelector('#nodes .node.text .text-body');
    return { h: Math.round(ta.getBoundingClientRect().height), overflowY: getComputedStyle(ta).overflowY };
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const textResetAfter = await page.evaluate(`(() => {
    const ta = document.querySelector('#nodes .node.text .text-body');
    return { h: Math.round(ta.getBoundingClientRect().height), overflowY: getComputedStyle(ta).overflowY };
  })()`);
  // 双击后必须真的回到自动高度：高度退回去、overflow 变回 hidden
  check('提示词框双击手柄：退回按内容自动高度',
    !!textReset && textResetAfter.overflowY === 'hidden'
      && textResetAfter.h <= (textBox ? textBox.before + 4 : 999),
    JSON.stringify({ textReset, textResetAfter, before: textBox && textBox.before }));

  // 底色 #262626 + 平时只读：画布上滚动/点选都要经过这块字，一碰就进输入态迟早改错提示词
  const skin = await page.evaluate(`(() => {
    const n = document.querySelector('#nodes .node.text');
    const ta = n.querySelector('.text-body');
    const cs = getComputedStyle(ta);
    return {
      bg: getComputedStyle(n.querySelector('.node-card')).backgroundColor,
      caret: cs.caretColor, cursor: cs.cursor, editable: ta.isContentEditable,
      len: ta.textContent.length, editing: n.classList.contains('editing'),
    };
  })()`);
  check('提示词框：默认底色 #262626 + 平时只读（没有光标、不是 text 光标）',
    skin.bg === 'rgb(38, 38, 38)' && skin.editable === false && !skin.editing
      && skin.caret === 'rgba(0, 0, 0, 0)' && skin.cursor === 'default',
    JSON.stringify(skin));

  const taPt = await page.evaluate(`(() => {
    const r = document.querySelector('#nodes .node.text .text-body').getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 18) };
  })()`);
  const typeZ = async () => {
    await page.send('Input.dispatchKeyEvent', {
      type: 'char', text: 'Z', unmodifiedText: 'Z', key: 'Z', code: 'KeyZ',
    });
    await new Promise((r) => setTimeout(r, 200));
  };
  // 单击 = 选中节点，不进编辑态；这时候打字必须改不动内容（防误触的核心）
  await page.clickAt(taPt.x, taPt.y, { settle: 250 });
  await typeZ();
  const afterClick = await page.evaluate(`(() => {
    const n = document.querySelector('#nodes .node.text');
    const ta = n.querySelector('.text-body');
    return { editable: ta.isContentEditable, editing: n.classList.contains('editing'), len: ta.textContent.length };
  })()`);
  check('提示词框单击不编辑：只读，打字改不动内容',
    afterClick.editable === false && !afterClick.editing && afterClick.len === skin.len,
    JSON.stringify({ afterClick, before: skin.len }));

  // 双击才进编辑态：可以打字，Esc 退出回到只读
  await page.clickAt(taPt.x, taPt.y, { clickCount: 2, settle: 320 });
  const inEdit = await page.evaluate(`(() => {
    const n = document.querySelector('#nodes .node.text');
    const ta = n.querySelector('.text-body');
    return { editable: ta.isContentEditable, editing: n.classList.contains('editing'), caret: getComputedStyle(ta).caretColor };
  })()`);
  await typeZ();
  const typed = await page.evaluate(`document.querySelector('#nodes .node.text .text-body').textContent.length`);
  await page.key('Escape', { settle: 300 });
  const afterEsc = await page.evaluate(`(() => {
    const n = document.querySelector('#nodes .node.text');
    const ta = n.querySelector('.text-body');
    return { editable: ta.isContentEditable, editing: n.classList.contains('editing'), focus: document.activeElement === ta };
  })()`);
  check('提示词框双击才进编辑：光标回来、能打字，Esc 退出回只读',
    inEdit.editable === true && inEdit.editing && inEdit.caret !== 'rgba(0, 0, 0, 0)'
      && typed === skin.len + 1 && afterEsc.editable === false && !afterEsc.editing && !afterEsc.focus,
    JSON.stringify({ inEdit, typed, afterEsc, before: skin.len }));
  // 把试打的那个字符抹掉，别留给后面的用例
  await page.evaluate(`(() => {
    const ta = document.querySelector('#nodes .node.text .text-body');
    if (ta.innerHTML.endsWith('Z')) ta.innerHTML = ta.innerHTML.slice(0, -1);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  // ---- 提示词格式条（用户：与图片功能顶部的功能条一致）----
  // 单选文本节点就浮出来，7 个按钮：颜色 / 标题 / 列表 / 加粗 / 斜体 / 分割线 / 展开
  const tbar = await page.evaluate(`(() => {
    const bar = document.getElementById('textTools');
    if (!bar) return null;
    const cs = getComputedStyle(bar);
    const dot = bar.querySelector('[data-tool="color"] .it-dot');
    const first = bar.querySelector('.it-btn');
    return {
      hidden: bar.classList.contains('hidden'),
      btns: [...bar.querySelectorAll('.it-btn')].map((b) => b.dataset.tool),
      labels: [...bar.querySelectorAll('.it-btn span')].map((s) => s.textContent),
      seps: bar.querySelectorAll('.it-sep').length,
      h: Math.round(bar.getBoundingClientRect().height),
      radius: cs.borderRadius,
      btnRadius: first ? getComputedStyle(first).borderRadius : '',
      dot: dot ? getComputedStyle(dot).backgroundColor : null,
      dotSize: dot ? Math.round(dot.getBoundingClientRect().width) : 0,
      top: Math.round(bar.getBoundingClientRect().top),
      nodeTop: Math.round(document.querySelector('#nodes .node.text').getBoundingClientRect().top),
    };
  })()`);
  check('提示词格式条：单选文本节点就浮出，7 个按钮齐全且顺序对',
    !!tbar && tbar.hidden === false
      && tbar.btns.join(',') === 'color,h,ol,b,i,hr,preset,expand'
      && tbar.labels.join(',') === '颜色,标题,列表,加粗,斜体,分割线,预设,展开',
    JSON.stringify(tbar));
  check('格式条与图片工具条同一套壳：12px 圆角、按钮 8px、浮在节点上方',
    !!tbar && tbar.h >= 30 && tbar.h <= 40 && tbar.radius === '12px' && tbar.btnRadius === '8px'
      && tbar.top < tbar.nodeTop, JSON.stringify(tbar));
  check('颜色按钮上带当前底色的小圆点（默认 #262626）',
    !!tbar && tbar.dot === 'rgb(38, 38, 38)' && tbar.dotSize >= 6 && tbar.dotSize <= 12,
    JSON.stringify({ dot: tbar && tbar.dot, size: tbar && tbar.dotSize }));

  // 逐项验证命令真的写进 html（语义标签，不是一堆行内 style）。
  // 每次都从同一段干净内容起：选中整段再点按钮，等价于用户拖选后点格式。
  const fmt = (kind) => page.evaluate(`(() => {
    const ed = document.querySelector('#nodes .node.text .text-body');
    const btn = document.querySelector('#textTools [data-tool="${kind}"]');
    if (!ed || !btn) return null;
    ed.innerHTML = '<div>柔和侧光</div><div>浅景深</div>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    btn.click();
    return { html: ed.innerHTML, text: ed.textContent, on: btn.classList.contains('on') };
  })()`);
  const fmtB = await fmt('b');
  check('加粗：选中整段点「B」→ 写出 <b>，纯文本不受影响',
    !!fmtB && /<b>/i.test(fmtB.html) && /柔和侧光/.test(fmtB.text), JSON.stringify(fmtB));
  const fmtI = await fmt('i');
  check('斜体：点「I」→ 写出 <i>',
    !!fmtI && /<i>/i.test(fmtI.html) && /浅景深/.test(fmtI.text), JSON.stringify(fmtI));
  const fmtH = await fmt('h');
  check('标题：点「标题」→ 这一段变成 <h3>',
    !!fmtH && /<h3>/i.test(fmtH.html) && /柔和侧光/.test(fmtH.text), JSON.stringify(fmtH));
  const fmtOl = await fmt('ol');
  check('列表：点「1.」→ 变成 <ol><li> 的有序列表',
    !!fmtOl && /<ol>/i.test(fmtOl.html) && /<li>/i.test(fmtOl.html), JSON.stringify(fmtOl));

  // 分割线插在光标处（不替换选中的内容）：先落到末尾再点
  const fmthr = await page.evaluate(`(() => {
    const ed = document.querySelector('#nodes .node.text .text-body');
    const btn = document.querySelector('#textTools [data-tool="hr"]');
    if (!ed || !btn) return null;
    ed.innerHTML = '<div>柔和侧光</div><div>浅景深</div>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    btn.click();
    return { html: ed.innerHTML, hrs: ed.querySelectorAll('hr').length, text: ed.textContent };
  })()`);
  check('分割线：点「—」→ 插入 <hr>，原来的字都还在',
    !!fmthr && fmthr.hrs === 1 && /柔和侧光/.test(fmthr.text) && /浅景深/.test(fmthr.text),
    JSON.stringify(fmthr));

  // 格式是「能看」也要「能存」：html 进存档、value 还是剥干净的纯文本
  await new Promise((r) => setTimeout(r, 900));
  const savedText = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${projId}.json`), 'utf8'));
      return j.nodes.find((x) => x.id === 't1') || {};
    } catch { return {}; }
  })();
  check('存档里 html 与 value 各存一份：html 带 <hr>，value 是纯文本（送模型的那份）',
    /<hr/i.test(savedText.html || '') && /柔和侧光/.test(savedText.value || '')
      && !/[<>]/.test(savedText.value || ''),
    JSON.stringify({ html: savedText.html, value: savedText.value }));

  // 换底色：点色板 → 卡片背景跟着变，存档里带 bg
  const bgAfter = await page.evaluate(`(() => {
    const btn = document.querySelector('#textTools [data-tool="color"]');
    btn.click();
    const pop = document.querySelector('.text-color-pop');
    if (!pop) return { pop: false };
    const sw = [...pop.querySelectorAll('.tcp-swatch')];
    const target = sw.find((b) => b.dataset.color === '#22303c') || sw[4];
    const info = {
      pop: true, swatches: sw.length,
      hasCustom: !!pop.querySelector('input[type="color"]'),
      hasReset: !!pop.querySelector('.tcp-reset'),
      on: sw.filter((b) => b.classList.contains('on')).map((b) => b.dataset.color),
    };
    target.click();
    const card = document.querySelector('#nodes .node.text .node-card');
    const dot = document.querySelector('#textTools [data-tool="color"] .it-dot');
    return {
      ...info, bg: getComputedStyle(card).backgroundColor,
      dot: getComputedStyle(dot).backgroundColor,
      closed: !document.querySelector('.text-color-pop'),
    };
  })()`);
  check('换底色：色板气泡有 8 个色 + 自定义 + 恢复默认，点一下卡片和圆点一起变、气泡收起',
    !!bgAfter && bgAfter.pop && bgAfter.swatches === 8 && bgAfter.hasCustom && bgAfter.hasReset
      && bgAfter.on.join(',') === '#262626' && bgAfter.bg === 'rgb(34, 48, 60)'
      && bgAfter.dot === 'rgb(34, 48, 60)' && bgAfter.closed === true,
    JSON.stringify(bgAfter));
  await new Promise((r) => setTimeout(r, 900));
  const savedBg = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', `${projId}.json`), 'utf8'));
      return (j.nodes.find((x) => x.id === 't1') || {}).bg;
    } catch { return null; }
  })();
  check('换过的底色存进存档（刷新后还在）', savedBg === '#22303c', String(savedBg));

  // 展开：全屏编辑打开（里面的格式条不重复「展开」按钮），Esc 关闭
  const full = await page.evaluate(`(() => {
    document.querySelector('#textTools [data-tool="expand"]').click();
    const root = document.getElementById('textFull');
    if (!root) return { open: false };
    const ed = root.querySelector('.tf-ed');
    return {
      open: true,
      w: Math.round(root.querySelector('.tf-panel').getBoundingClientRect().width),
      btns: [...root.querySelectorAll('.it-btn')].map((b) => b.dataset.tool),
      editable: ed.isContentEditable,
      len: ed.textContent.length,
      barHidden: document.getElementById('textTools').classList.contains('hidden'),
      bg: getComputedStyle(ed).backgroundColor,
    };
  })()`);
  check('展开：全屏编辑打开，里面有同一排格式按钮（不重复「展开」），格式条自己让位',
    !!full && full.open && full.w >= 700 && full.btns.join(',') === 'color,h,ol,b,i,hr,preset'
      && full.editable === true && full.len >= 4 && full.barHidden === true,
    JSON.stringify(full));
  await page.key('Escape', { settle: 400 });
  const fullClosed = await page.evaluate(`(() => ({
    open: !!document.getElementById('textFull'),
    barHidden: document.getElementById('textTools').classList.contains('hidden'),
    len: document.querySelector('#nodes .node.text .text-body').textContent.length,
  }))()`);
  check('全屏编辑 Esc 关闭：节点里那块内容还在（不是只改了浮层）',
    fullClosed.open === false && fullClosed.barHidden === false && fullClosed.len >= 4,
    JSON.stringify(fullClosed));

  // 恢复成 fixture 里那段原文，后面的用例还得用
  // 文案四边留白一致：从文档 / 网页粘进来的提示词多半是 <p> 包着的，浏览器给 <p> 的
  // 默认外边距是 1em，第一行上面、最后一行下面会凭空多出十几像素，左右却还是 10px——
  // 看着就是「上边距比左右宽」。这条把四个方向量出来对齐（字形到卡片边框）。
  const pad = await page.evaluate(`(() => {
    const node = document.querySelector('#nodes .node.text');
    const ed = node.querySelector('.text-body');
    ed.innerHTML = '<p>创意，想象，大幅留白，高饱和度对比，抽象表现主义，克制的笔触，质感的颜料堆积，莱杰希斯。</p>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    const cr = node.querySelector('.node-card').getBoundingClientRect();
    const p = ed.firstElementChild;
    const ps = p ? getComputedStyle(p) : null;
    const rects = [];
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      if (!t.nodeValue.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(t);
      rects.push(...[...r.getClientRects()].filter((x) => x.height > 2));
    }
    return {
      tag: ed.firstElementChild && ed.firstElementChild.tagName,
      margins: ps ? [ps.marginTop, ps.marginRight, ps.marginBottom, ps.marginLeft] : [],
      L: Math.round(Math.min(...rects.map((r) => r.left)) - cr.left),
      T: Math.round(Math.min(...rects.map((r) => r.top)) - cr.top),
      B: Math.round(cr.bottom - Math.max(...rects.map((r) => r.bottom))),
    };
  })()`);
  check('文案四边留白一致：<p> 包着的提示词，上下留白和左右一样（默认外边距已压平）',
    !!pad && pad.tag === 'P' && pad.margins.length === 4 && pad.margins.every((m) => m === '0px'),
    JSON.stringify(pad));

  // ---- 提示词预设：把常用的存起来，一键插回来 ----
  await page.evaluate(`window.prompt = () => 'E2E 预设'`);
  await page.evaluate(`document.querySelector('#textTools [data-tool="preset"]').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const pop0 = await page.evaluate(`(() => {
    const p = document.querySelector('.text-preset-pop');
    return p ? { open: true, empty: !!p.querySelector('.tpp-empty'), w: Math.round(p.getBoundingClientRect().width) }
      : { open: false };
  })()`);
  check('格式条上的「预设」：弹出面板，没存过时先告诉你怎么用',
    !!pop0.open && pop0.empty === true && pop0.w > 200, JSON.stringify(pop0));

  await page.evaluate(`document.querySelector('.tpp-save').click()`);
  await new Promise((r) => setTimeout(r, 800));
  const pop1 = await page.evaluate(`(() => {
    const items = [...document.querySelectorAll('.tpp-item')];
    return { n: items.length, name: (items[0] || {}).textContent || '',
      prev: (document.querySelector('.tpp-prev') || {}).textContent || '' };
  })()`);
  const savedOnDisk = await page.evaluate(
    `(async () => (await (await fetch('/api/prompts')).json()).items.map((x) => x.name))()`);
  check('「存当前」把这条提示词存成预设：面板里出现，服务端也真存了',
    pop1.n >= 1 && pop1.name.includes('E2E 预设') && savedOnDisk.includes('E2E 预设'),
    JSON.stringify({ pop1, savedOnDisk }));

  // 预览是一整行长文本：必须省略在条目里，不能把面板撑开（隐式 auto 列会被 nowrap 撑爆）。
  // 「替换 / ×」常驻压暗，别只在悬停时冒出来——不然没人知道这条能改能删。
  const popFit = await page.evaluate(`(() => {
    const p = document.querySelector('.text-preset-pop');
    const it = document.querySelector('.tpp-item');
    const prev = it.querySelector('.tpp-prev');
    const ops = it.querySelector('.tpp-ops');
    const pr = p.getBoundingClientRect(), ir = it.getBoundingClientRect(), vr = prev.getBoundingClientRect();
    return {
      over: Math.round(vr.right - pr.right),
      fit: Math.round(ir.width) <= Math.round(pr.width) + 1,
      ops: ops ? getComputedStyle(ops).display : null,
      opN: ops ? ops.children.length : 0,
      ell: getComputedStyle(prev).textOverflow,
    };
  })()`);
  check('预设条目不出界：长预览省略在条目里，「替换 / ×」常驻（压暗而非藏起来）',
    popFit.over <= 0 && popFit.fit && popFit.ops === 'flex' && popFit.opN === 2 && popFit.ell === 'ellipsis',
    JSON.stringify(popFit));

  // 清空节点再点预设：整段插回来
  await page.evaluate(`(() => {
    const ed = document.querySelector('#nodes .node.text .text-body');
    ed.innerHTML = '';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.evaluate(`document.querySelector('.tpp-item').click()`);
  await new Promise((r) => setTimeout(r, 450));
  const inserted = await page.evaluate(
    `document.querySelector('#nodes .node.text .text-body').textContent.trim()`);
  const popClosed = await page.evaluate(`!document.querySelector('.text-preset-pop')`);
  check('点一条预设就插回节点里（插完面板自己收起）',
    inserted.length > 5 && popClosed === true, JSON.stringify({ inserted: inserted.slice(0, 40), popClosed }));

  // 恢复成 fixture 里那段原文，后面的用例还得用
  await page.evaluate(`(() => {
    const ed = document.querySelector('#nodes .node.text .text-body');
    ed.innerHTML = '<div>a cinematic portrait of a woman standing in a rain-soaked neon street</div>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.querySelector('#textTools [data-tool="color"]');
    if (btn) btn.click();
    const rs = document.querySelector('.text-color-pop .tcp-reset');
    if (rs) rs.click();
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  // 端口圆点：必须压在卡片垂直中线上（左右两口都一样）。
  // 20px 的端口配 18px 时代留下的 calc(50% - 9px)，整口会偏低 1px，放大后看得见。
  const portAlign = await page.evaluate(`(() => {
    const n = document.querySelector('#nodes .node.text');
    const c = n.querySelector('.node-card').getBoundingClientRect();
    const i = n.querySelector('.port.in').getBoundingClientRect();
    const o = n.querySelector('.port.out').getBoundingClientRect();
    const r = (v) => Math.round(v * 100) / 100;
    return {
      inD: r(i.top + i.height / 2 - (c.top + c.height / 2)),
      outD: r(o.top + o.height / 2 - (c.top + c.height / 2)),
      size: [Math.round(i.width), Math.round(i.height)],
    };
  })()`);
  check('端口圆点压在卡片中线上：左右两口误差都 < 0.6px',
    Math.abs(portAlign.inD) < 0.6 && Math.abs(portAlign.outD) < 0.6, JSON.stringify(portAlign));

  // 拉伸手柄改隐藏式：平时完全看不见，也不再弹那条原生 tooltip
  const hdIdle = await page.evaluate(`(() => {
    const hd = document.querySelector('#nodes .node.text .node-resize');
    return { opacity: getComputedStyle(hd).opacity, title: hd.getAttribute('title') || '', aria: hd.getAttribute('aria-label') || '' };
  })()`);
  const cardPt = await page.evaluate(`(() => {
    const r = document.querySelector('#nodes .node.text .node-card').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await page.clickAt(cardPt.x, cardPt.y, { settle: 300 });
  const hdHover = await page.evaluate(`getComputedStyle(document.querySelector('#nodes .node.text .node-resize')).opacity`);
  check('缩放手柄隐藏式：悬停节点也不浮出、没有原生 tooltip',
    hdIdle.opacity === '0' && hdIdle.title === '' && hdIdle.aria !== '' && hdHover === '0',
    JSON.stringify({ hdIdle, hdHover }));

  // ---- 工作流库并进全局设置：左导航 + 右分格 ----
  // 以前是「设置一条长滚动」+「资产库一整个弹窗」：同一个工作流列表在两处渲染，
  // 「挑一个用」和「管它」被拆成两个地方。现在只有这一个面板，工作流就是第一格。
  await page.evaluate(`document.querySelector('#bar [data-act="add-wf"]').click()`);
  await page.waitFor(`!!document.getElementById('appSettings')`, 6000);
  await new Promise((r) => setTimeout(r, 400));

  // 面板里不允许出现蓝色：扫描所有元素的文字/底色/描边/阴影，找明显偏蓝的 rgb
  // （b 比 r、g 都高出 40 以上）。主题色 #09caf5 会立刻被抓到。
  const blueHits = await page.evaluate(`(() => {
    const isBlue = (v) => {
      const m = String(v).match(/rgba?\\((\\d+), (\\d+), (\\d+)/);
      if (!m) return false;
      const r = +m[1], g = +m[2], b = +m[3];
      return b > 120 && b - r > 40 && b - g > 40;
    };
    const hits = [];
    document.querySelectorAll('#appSettings *').forEach((el) => {
      const cs = getComputedStyle(el);
      ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'boxShadow'].forEach((p) => {
        if (isBlue(cs[p])) hits.push((el.className || el.tagName) + ' · ' + p);
      });
    });
    return [...new Set(hits)];
  })()`);
  check('设置面板里没有蓝色：选中条 / 行 / 描边都是中性色',
    blueHits.length === 0, JSON.stringify(blueHits));

  const setBox = () => page.evaluate(`(() => {
    const s = document.querySelector('#appSettings .sheet').getBoundingClientRect();
    const nav = document.querySelector('#setTabs').getBoundingClientRect();
    const panes = document.querySelector('.sheet-panes').getBoundingClientRect();
    const tabs = [...document.querySelectorAll('#setTabs .tab')];
    const tab = tabs[0];
    return {
      w: Math.round(s.width), h: Math.round(s.height),
      // 期望值按视口算：窗口够大时就是 880×640，小屏被 max-width / 90vh 兜底。
      // 基准取 documentElement.clientHeight 而不是 innerHeight——后者含横向滚动条那十几个像素，
      // 和 CSS 里 vh 的基准对不上，算出来的期望值会凭空高出 16px。
      expectW: Math.min(880, Math.round(document.documentElement.clientWidth * 0.94)),
      expectH: Math.min(640, Math.round(document.documentElement.clientHeight * 0.9)),
      sideBySide: Math.round(nav.right) <= Math.round(panes.left) + 1,
      navW: Math.round(nav.width), panesW: Math.round(panes.width),
      tabRadius: parseFloat(getComputedStyle(tab).borderRadius),
      tabDisplay: getComputedStyle(tab).display,
      icons: tabs.filter((t) => t.querySelector('.ico .oi')).length,
      labels: tabs.map((t) => (t.querySelector('span:last-child') || {}).textContent),
    };
  })()`);
  const sSet = await setBox();

  // 工作流格：搜索 + 导入 + 一行说明 + 一份列表 + 一排分类。
  // 这四样以前散在三个地方（设置里的下拉 / 设置里的列表 / 资产库弹窗的卡片）。
  // 现在**没有「默认工作流」这一档**了：谁被默认选中，就意味着用户没选过也照样出图。
  const wfPane = await page.evaluate(`(() => {
    const pane = document.getElementById('set-pane-wf');
    const rows = [...pane.querySelectorAll('.wf-item')];
    return {
      missing: ['setWfSearch', 'setWfList', 'setCats', 'setImportWf', 'setWfDefault']
        .filter((id) => !document.getElementById(id)),
      rows: rows.length,
      shape: rows.length ? rows[0].children.length : 0,
      stars: rows.filter((r) => r.querySelector('.wf-star')).length,
      uses: rows.filter((r) => r.querySelector('.wf-use')).length,
      dels: rows.filter((r) => r.querySelector('.wf-del')).length,
      cats: rows.filter((r) => r.querySelector('.wf-cat')).length,
      checks: rows.filter((r) => r.querySelector('.wf-check')).length,
      chips: pane.querySelectorAll('.wf-chip').length,
      def: (document.getElementById('setWfDefault') || {}).textContent || '',
    };
  })()`);
  check('工作流库就是设置的第一格：搜索 / 导入 / 说明 / 列表 / 分类都在',
    wfPane.missing.length === 0 && wfPane.rows > 0 && wfPane.chips > 0,
    JSON.stringify(wfPane));
  // 七件套：第 1 颗是图标（点开换标），第 4 颗 ☆ 设「能力分类的默认」，第 5 颗是放大镜「查残留」——
  // 导入时弹过一次之后，文件就躺在列表里了，想再确认一遍（或怀疑某张图不是自己出的）
  // 原来没有任何入口。
  check('每行七件套：图标 / 名字 / 分类 / 加到画布 / ☆ 设默认 / 查残留 / 删除',
    wfPane.shape === 7 && wfPane.stars === wfPane.rows && wfPane.uses === wfPane.rows
      && wfPane.dels === wfPane.rows && wfPane.cats === wfPane.rows
      && wfPane.checks === wfPane.rows,
    JSON.stringify(wfPane));
  check('那一行读数报「每个能力分类当前用哪一份」，夹具没设过就写「未设」',
    /^按分类默认/.test(wfPane.def) && /未设/.test(wfPane.def), wfPane.def);

  // ☆ 设默认：按**能力分类**各一份，存服务端 data/wf-defaults.json（换设备 / MCP 读同一份）
  // 吃遮罩的那份（局部重绘）不给设——它只能由遮罩编辑器选中，设了也永远不会被自动挑中。
  const maskStar = await page.evaluate(`(() => {
    const row = document.querySelector('#appSettings #setWfList .wf-item[data-id="lib:krea2-局部重绘.api"]');
    const s = row && row.querySelector('.wf-star');
    return { off: !!s && s.classList.contains('off'), aria: s ? s.getAttribute('aria-disabled') : '' };
  })()`);
  check('吃遮罩的工作流不能设默认：星压暗 + aria-disabled（不是点了没反应）',
    maskStar.off && maskStar.aria === 'true', JSON.stringify(maskStar));

  const starCell = await page.center('#appSettings #setWfList .wf-item[data-id="lib:krea2-文生图.api"] .wf-star');
  await page.clickAt(starCell.x, starCell.y, { settle: 700 });
  const starOn = await page.evaluate(`(async () => {
    const box = document.getElementById('appSettings');
    const row = box.querySelector('#setWfList .wf-item[data-id="lib:krea2-文生图.api"]');
    const saved = await (await fetch('/api/wf/defaults')).json();
    return {
      on: !!row.querySelector('.wf-star.on'),
      name: row.querySelector('b').textContent,
      def: (document.getElementById('setWfDefault') || {}).textContent || '',
      saved: saved.defaults || {},
    };
  })()`);
  const savedVals = Object.values(starOn.saved);
  check('点 ☆ 设成该分类的默认：星变实心、说明行写出名字、服务端存下来',
    starOn.on && starOn.def.includes(starOn.name)
      && savedVals.length === 1 && /^(preset|lib):/.test(savedVals[0]),
    JSON.stringify(starOn));
  // 再点一次取消：分类回到「未设」，服务端那条也删掉（别留死 id）
  const starCell2 = await page.center('#appSettings #setWfList .wf-item[data-id="lib:krea2-文生图.api"] .wf-star.on');
  await page.clickAt(starCell2.x, starCell2.y, { settle: 700 });
  const starOff = await page.evaluate(`(async () => {
    const box = document.getElementById('appSettings');
    const saved = await (await fetch('/api/wf/defaults')).json();
    return {
      on: !!box.querySelector('#setWfList .wf-star.on'),
      def: (document.getElementById('setWfDefault') || {}).textContent || '',
      saved: saved.defaults || {},
    };
  })()`);
  check('再点一次取消默认：星回空心、说明行回「未设」、服务端清掉这条',
    !starOff.on && /未设/.test(starOff.def) && Object.keys(starOff.saved).length === 0,
    JSON.stringify(starOff));

  // 尺寸不随内容变：把搜索框填成匹配不到的词，内容从一屏行塌成一句「没有匹配」
  await page.evaluate(`(() => {
    const i = document.getElementById('setWfSearch');
    i.value = 'zzz-没有这个工作流';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const sEmpty = await setBox();
  const emptyHit = await page.evaluate(`(() => ({
    rows: document.querySelectorAll('#set-pane-wf .wf-item').length,
    tip: (document.querySelector('#setWfList .tip') || {}).textContent || '',
  }))()`);
  check('搜索能过滤：一个词把列表收到「没有匹配」',
    emptyHit.rows === 0 && /没有匹配/.test(emptyHit.tip), JSON.stringify(emptyHit));
  check('设置面板尺寸固定 880×640：内容塌成一句「没有匹配」也不变',
    sSet.w === sEmpty.w && sSet.h === sEmpty.h
      && Math.abs(sSet.w - sSet.expectW) <= 2 && Math.abs(sSet.h - sSet.expectH) <= 2,
    `${sSet.w}×${sSet.h} → ${sEmpty.w}×${sEmpty.h}（期望 ${sSet.expectW}×${sSet.expectH}）`);
  await page.evaluate(`(() => {
    const i = document.getElementById('setWfSearch');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  check('设置是左右双栏：导航在左、内容在右，导航项不是胶囊',
    sSet.sideBySide && sSet.navW >= 150 && sSet.navW <= 220
      && sSet.panesW > sSet.navW * 2 && sSet.tabRadius <= 12,
    JSON.stringify(sSet));
  check('左侧导航 5 格：图标都填上了，文字没被吃掉',
    sSet.icons === 5 && sSet.tabDisplay === 'flex'
      && sSet.labels.join('|') === '工作流|运行记录|外观|连接|高级',
    JSON.stringify({ icons: sSet.icons, display: sSet.tabDisplay, labels: sSet.labels }));
  // 开面板不该顺手去拉 ComfyUI 的运行记录（离线时那是 502，控制台先红一条）。
  // 这里只验「没预加载」，不点运行记录那一格——CI 里没有 ComfyUI，点了反而会真报错。
  const histPreload = await page.evaluate(`document.querySelector('#set-pane-history').children.length`);
  check('打开设置不预加载运行记录（点那一格才去问 ComfyUI）', histPreload === 0, `${histPreload} 个子节点`);
  // 切一格：只换右边，左边导航和面板尺寸都不动
  await page.evaluate(`document.querySelector('#setTabs .tab[data-set="look"]').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const switched = await page.evaluate(`(() => ({
    look: !document.getElementById('set-pane-look').classList.contains('hidden'),
    wf: document.getElementById('set-pane-wf').classList.contains('hidden'),
    active: document.querySelector('#setTabs .tab.active').dataset.set,
    swatches: document.querySelectorAll('#setBgSwatches .bg-swatch').length,
  }))()`);
  check('点左导航只换右边那一格：外观格出来了，工作流格收起，色板也在',
    switched.look && switched.wf && switched.active === 'look' && switched.swatches > 0,
    JSON.stringify(switched));
  await page.evaluate(`document.querySelector('#setTabs .tab[data-set="wf"]').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(`document.querySelector('#appSettings .x').click()`);
  await new Promise((r) => setTimeout(r, 300));

  // 回首页前先选中一张有图的节点：工具条是「选中才有」的浮层，不选它就没得可收，
  // 这条用例也就成了空跑。
  const homeImg = await page.evaluate(`(() => {
    const n = [...document.querySelectorAll('#nodes .node.image')]
      .find((e) => { const im = e.querySelector('.thumb img'); return im && im.naturalWidth >= 8; });
    return n ? n.dataset.id : '';
  })()`);
  if (!homeImg) throw new Error('回首页收浮层的用例需要一张有图的图片节点');
  const homeTitle = await page.center(`#nodes .node[data-id="${homeImg}"] .node-title`);
  if (!homeTitle) throw new Error('找不到图片节点的标题');
  await page.clickAt(homeTitle.x, homeTitle.y, { settle: 400 });
  const chromeBefore = await page.evaluate(`(() => {
    const bar = document.getElementById('imgTools');
    const r = bar && bar.getBoundingClientRect();
    return {
      shown: !!bar && !bar.classList.contains('hidden'),
      // 记下它此刻的中心：回首页之后要在**同一个点**上验「现在点下去是首页」
      at: r && r.width ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null,
    };
  })()`);
  check('回首页之前：选中图片节点，工具条是开着的',
    chromeBefore.shown && !!chromeBefore.at, JSON.stringify(chromeBefore));

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

  // ---- 最近项目卡片：左边缩略图 / 右边名称 + 日期 / 最右「⋯」 ----
  const cardUi = await page.evaluate(`(() => {
    const c = [...document.querySelectorAll('#recentList .proj-card')]
      .find((x) => /e2e 夹具画布/.test(x.textContent));
    if (!c) return { found: false };
    const thumb = c.querySelector('.pc-thumb img');
    const ph = c.querySelector('.pc-thumb .pc-ph');
    const tile = c.querySelector('.pc-thumb');
    return {
      found: true,
      name: (c.querySelector('.pc-name') || {}).textContent || '',
      date: (c.querySelector('.pc-date') || {}).textContent || '',
      hasThumb: !!thumb,
      thumbOk: thumb ? (thumb.complete && thumb.naturalWidth > 0) : null,
      phText: ph ? (ph.querySelector('em') || {}).textContent || '' : '',
      dotBg: tile ? /radial-gradient/.test(getComputedStyle(tile).backgroundImage) : false,
      dots: c.querySelectorAll('.pc-more span').length,
    };
  })()`);
  check('最近项目卡片：缩略图 + 画布名 + yyyy-mm-dd 日期 + 最右三个点',
    cardUi.found && /e2e 夹具画布/.test(cardUi.name) && /^\d{4}-\d{2}-\d{2}$/.test(cardUi.date)
      && cardUi.dots === 3,
    JSON.stringify(cardUi));
  // 没封面的画布（新画布、只有空节点）以前是一块纯色 + 一个几乎看不见的图标，
  // 和图加载失败长得一模一样。现在画点阵底 + 「空画布」两个字，说清楚是没内容，不是坏了。
  check('卡片缩略图：有图就真显示图，没图就画点阵 + 「空画布」（不留空框）',
    cardUi.hasThumb ? cardUi.thumbOk === true : (cardUi.phText === '空画布' && cardUi.dotBg),
    JSON.stringify(cardUi));

  const openCardMenu = `(() => {
    const c = [...document.querySelectorAll('#recentList .proj-card')]
      .find((x) => /e2e 夹具画布/.test(x.textContent));
    if (!c) return false;
    c.querySelector('.pc-more').click();
    return true;
  })()`;
  await page.evaluate(openCardMenu);
  await new Promise((r) => setTimeout(r, 350));
  const projMenu = await page.evaluate(`(() => [...document.querySelectorAll('.popmenu button')].map((b) => b.textContent.trim()))()`);
  check('卡片「⋯」菜单：打开 / 重命名 / 修改封面 / 删除项目',
    projMenu.join('/') === '打开/重命名/修改封面/删除项目', JSON.stringify(projMenu));

  // 重命名：标题就地变输入框，Enter 保存（不是 prompt 弹窗，也不是跳页）
  await page.evaluate(`[...document.querySelectorAll('.popmenu button')].find((b) => b.textContent === '重命名').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const renOld = await page.evaluate(`(() => { const i = document.querySelector('.pc-name-input'); return i ? i.value : ''; })()`);
  check('重命名：卡片标题就地变成输入框，预填当前名字', renOld === 'e2e 夹具画布', renOld);
  await page.evaluate(`(() => {
    const i = document.querySelector('.pc-name-input');
    i.value = 'e2e 夹具画布 改名';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const renNew = await page.evaluate(`(() => [...document.querySelectorAll('#recentList .pc-name')].map((x) => x.textContent).join('|'))()`);
  check('重命名：回车后卡片上立刻是新名字', /e2e 夹具画布 改名/.test(renNew), renNew);
  // 改回去：后面的用例还要按「e2e 夹具画布」找这个夹具
  await page.evaluate(`(() => {
    const c = [...document.querySelectorAll('#recentList .proj-card')].find((x) => /改名/.test(x.textContent));
    c.querySelector('.pc-more').click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(`[...document.querySelectorAll('.popmenu button')].find((b) => b.textContent === '重命名').click()`);
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(`(() => {
    const i = document.querySelector('.pc-name-input');
    i.value = 'e2e 夹具画布';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  // 修改封面：列出这个项目里的图 + 两个出口（恢复自动 / 从本机选）
  await page.evaluate(openCardMenu);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(`[...document.querySelectorAll('.popmenu button')].find((b) => b.textContent === '修改封面').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const coverUi = await page.evaluate(`(() => {
    const p = document.getElementById('coverPick');
    return {
      open: !!p,
      cells: p ? p.querySelectorAll('.cover-cell').length : 0,
      imgsOk: p ? [...p.querySelectorAll('.cover-cell img')].every((i) => i.complete && i.naturalWidth > 0) : false,
      actions: p ? [...p.querySelectorAll('.cover-foot button')].map((b) => b.textContent.trim()) : [],
    };
  })()`);
  check('修改封面：列出项目里的图，底部有「恢复自动 / 从本机选一张」',
    coverUi.open && coverUi.cells >= 1 && coverUi.imgsOk && coverUi.actions.length === 2,
    JSON.stringify(coverUi));
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 300));
  check('修改封面：Esc 关掉，不动项目',
    !(await page.evaluate(`!!document.getElementById('coverPick')`)), 'coverPick 已关');

  // ---- 回首页要把画布那套浮层收干净 ----
  // 这些浮层都挂在 body 上、position:fixed，z-index 比 #home(45) 高：图片工具条 46、对齐条 45、
  // 连线删除 46、任务面板 60、资产抽屉 62。画布本身被首页整块盖住了，它们却照旧钉在视口上——
  // 用户截图里那条「裁剪 / 旋转 / … / 下载」就悬在首页项目卡片的上方，看着像首页自带的工具条。
  const chromeAfter = await page.evaluate(`(() => {
    const bar = document.getElementById('imgTools');
    const align = document.getElementById('alignBar');
    const del = document.getElementById('linkDel');
    const [x, y] = ${JSON.stringify(chromeBefore.at || [0, 0])};
    const at = document.elementFromPoint(x, y);
    return {
      hidden: !bar || bar.classList.contains('hidden') || getComputedStyle(bar).display === 'none',
      // 原来那条工具条所在的位置，现在点下去必须落在首页里，而不是还浮着的按钮
      hitHome: !!(at && at.closest && at.closest('#home')),
      hit: at ? (at.id || at.className || at.tagName) : 'none',
      selected: document.querySelectorAll('#nodes .node.selected').length,
      align: !align || align.classList.contains('hidden'),
      linkDel: !del || del.classList.contains('hidden'),
      home: !document.getElementById('home').classList.contains('hidden'),
    };
  })()`);
  check('返回首页：工具条 / 对齐条 / 连线删除全收起，原来那个位置点下去是首页',
    chromeAfter.hidden && chromeAfter.hitHome && chromeAfter.align && chromeAfter.linkDel
      && chromeAfter.selected === 0 && chromeAfter.home, JSON.stringify(chromeAfter));

  // ---- 品牌图标：首页那块、标签页那颗、左下角按钮，用的都是同一张原图 ----
  // 以前首页品牌位是一块 conic-gradient 彩球、标签页是内联 data URI 的小方块，
  // 和品牌没关系。现在全部指向 static/icon.svg（桌面那张图，原样，不裁剪不改写）。
  const brand = await page.evaluate(`(() => {
    const img = document.querySelector('.home-brand .logo-orb');
    const icon = document.querySelector('link[rel="icon"]');
    const touch = document.querySelector('link[rel="apple-touch-icon"]');
    const dock = document.querySelector('#dockWrap .dock-orb img');
    return {
      tag: img ? img.tagName : '',
      src: img ? img.getAttribute('src') : '',
      loaded: img ? img.naturalWidth : 0,
      w: img ? Math.round(img.getBoundingClientRect().width) : 0,
      icon: icon ? icon.getAttribute('href') : '',
      touch: touch ? touch.getAttribute('href') : '',
      dockSrc: dock ? dock.getAttribute('src') : '',
    };
  })()`);
  check('首页品牌位就是 app 图标本身，不是彩球，且真的加载出来了',
    brand.tag === 'IMG' && brand.src === '/icon.svg' && brand.loaded > 0 && brand.w === 36,
    JSON.stringify(brand));
  check('标签页图标和 180px 大图标都指向同一张 icon.svg',
    brand.icon === '/icon.svg' && brand.touch === '/icon.svg', `${brand.icon} · ${brand.touch}`);
  check('左下角「返回首页」按钮里也是同一张图', brand.dockSrc === '/icon.svg', String(brand.dockSrc));

  // ---- 首页页脚三件事：就地办完，不把人踹进画布 ----
  // 以前「快捷键」只 flash 一行字就顺手 showCanvas()，「工作流库」也先 showCanvas() 再开弹窗，
  // 「ComfyUI 地址」是个外链——想改个端口得先进画布、开设置、改完再点回首页。
  const footActs = await page.evaluate(`[...document.querySelectorAll('[data-home-act]')].map((b) => b.dataset.homeAct)`);
  check('首页页脚三个入口都在：地址 / 快捷键 / 工作流库',
    footActs.join('|') === 'comfy|help|workflows', footActs.join('|'));

  await page.evaluate(`document.querySelector('[data-home-act="comfy"]').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const comfyPop = await page.evaluate(`(() => {
    const m = document.querySelector('.popmenu.comfy-pop');
    const inp = m && m.querySelector('input');
    const r = m && m.getBoundingClientRect();
    return {
      has: !!m,
      url: inp ? inp.value : '',
      hint: m ? m.querySelector('.set-tip').textContent : '',
      buttons: m ? [...m.querySelectorAll('button')].map((b) => b.textContent) : [],
      // 弹层必须完整落在视口里：页脚贴着窗口下沿，翻上来的位置算错就会被切掉
      inside: !!r && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      onHome: !document.getElementById('home').classList.contains('hidden'),
      hash: location.hash,
    };
  })()`);
  check('首页点 ComfyUI 地址：就地弹出小面板（输入框 + 状态 + 保存），不跳画布',
    comfyPop.has && /^https?:\/\//.test(comfyPop.url) && /已连接|连不上/.test(comfyPop.hint)
      && comfyPop.buttons.join('|') === '保存并测试|恢复默认'
      && comfyPop.inside && comfyPop.onHome && comfyPop.hash === '#home',
    JSON.stringify(comfyPop));
  // 点外面就收起来（探针是 JS 直接 click，不走 pointerdown，得手动补一次）
  await page.evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  const popGone = await page.evaluate(`document.querySelectorAll('.popmenu.comfy-pop').length`);
  check('点别处就收起地址小面板', popGone === 0, `${popGone} 个`);

  await page.evaluate(`document.querySelector('[data-home-act="help"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const homeHelp = await page.evaluate(`(() => {
    const h = document.getElementById('helpSheet');
    const r = h.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      open: !h.classList.contains('hidden'),
      // 命中点必须落在浮层里：被 #home 盖住的话这里会是首页的元素
      onTop: !!hit && h.contains(hit),
      onHome: !document.getElementById('home').classList.contains('hidden'),
      hash: location.hash,
    };
  })()`);
  check('首页点「快捷键」：浮层直接盖在首页上（没被首页盖住），不跳画布',
    homeHelp.open && homeHelp.onTop && homeHelp.onHome && homeHelp.hash === '#home',
    JSON.stringify(homeHelp));
  await page.evaluate(`document.getElementById('helpSheet').classList.add('hidden')`);

  await page.evaluate(`document.querySelector('[data-home-act="workflows"]').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const homeLib = await page.evaluate(`(() => ({
    open: !!document.getElementById('appSettings'),
    pane: !!(document.getElementById('set-pane-wf')
      && !document.getElementById('set-pane-wf').classList.contains('hidden')),
    rows: document.querySelectorAll('#set-pane-wf .wf-item').length,
    onHome: !document.getElementById('home').classList.contains('hidden'),
    hash: location.hash,
  }))()`);
  check('首页点「工作流库」：直接开设置的工作流格，盖在首页上，不跳画布',
    homeLib.open && homeLib.pane && homeLib.rows > 0 && homeLib.onHome && homeLib.hash === '#home',
    JSON.stringify(homeLib));
  await page.evaluate(`document.querySelector('#appSettings .x').click()`);
  await new Promise((r) => setTimeout(r, 300));

  // 设置弹层能开能关
  await page.evaluate(`document.querySelector('#recentList .proj-card .pm').click()`);
  await new Promise((r) => setTimeout(r, 900));
  await page.click('#projectBar [data-act="settings"]', { settle: 500 });
  const settingsOpen = await page.evaluate(`!!document.getElementById('appSettings')`);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  const settingsClosed = await page.evaluate(`(() => { const el = document.getElementById('appSettings'); return !el || el.classList.contains('hidden'); })()`);
  check('设置弹层开关', settingsOpen && settingsClosed);

  // ---- 设置 → 界面密度 ----
  // 两档切换要立刻改到实际控件上（不只是换个 class），并且记住选择。
  // 这里只验证「点了之后按钮尺寸真的变了 + 存进了 localStorage」，刷新恢复在启动时读。
  await page.click('#projectBar [data-act="settings"]', { settle: 500 });
  const vtW = () => page.evaluate(`Math.round(document.querySelector('#viewTools .vt').getBoundingClientRect().width)`);
  const pickDensity = (v) => page.evaluate(`(() => {
    const box = document.getElementById('appSettings');
    const b = box.querySelector('#setDensity [data-density="${v}"]');
    b.click();
    return { checked: b.getAttribute('aria-checked'), stored: localStorage.getItem('infisheet-density') };
  })()`);
  const densityHas = await page.evaluate(`(() => {
    const box = document.getElementById('appSettings');
    // 密度在「外观」页：默认停在「工作流」，先切过去
    box.querySelector('#setTabs [data-set="look"]').click();
    return box.querySelectorAll('#setDensity [data-density]').length;
  })()`);
  const densityBefore = await vtW();
  const pickCompact = await pickDensity('compact');
  await new Promise((r) => setTimeout(r, 420));   // 有过渡，等它跑完再量
  const densityCompact = await vtW();
  const pickComfort = await pickDensity('comfortable');
  await new Promise((r) => setTimeout(r, 420));
  const densityComfort = await vtW();
  const density = {
    has: densityHas, before: densityBefore, compact: densityCompact, comfort: densityComfort,
    compactStored: pickCompact.stored, comfortStored: pickComfort.stored,
    compactChecked: pickCompact.checked,
  };
  check('设置 → 界面密度：切到紧凑视图工具收到 28，切回舒适回到 32，并记住选择',
    density.has === 2 && density.before === 32 && density.compact === 28 && density.comfort === 32
      && density.compactStored === 'compact' && density.comfortStored === 'comfortable'
      && density.compactChecked === 'true',
    JSON.stringify(density));
  await page.key('Escape', { code: 'Escape', keyCode: 27 });

  // ---- 设置里的工作流区 ----
  // 以前是六个按钮挤成两组，其中三对是同一件事（打开库 == 管理库、新增预设 ≈ 导入 JSON、
  // 管理预设 == 打开库的预设页），而且「默认工作流」下拉里只有内置预设——自己存进库的
  // 永远选不到，用户的原话就是「工作流被固定死了」。
  // 现在合成一处：一个下拉 + 一份列表（改名 / 换分类 / 设默认 / 删除）+ 一排可自定义的分类。
  // 只操作**库**里的条目：data/library/ 是用户的真实目录，e2e 改了会污染它们。
  await page.evaluate(`(async () => {
    await fetch('/api/library/' + encodeURIComponent('e2e 我的流程'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: { '1': { class_type: 'KSampler', inputs: {} } }, title: 'e2e 我的流程' }),
    });
  })()`);
  await page.click('#projectBar [data-act="settings"]', { settle: 900 });
  const wfSet = await page.evaluate(`(() => {
    const box = document.getElementById('appSettings');
    const rows = [...box.querySelectorAll('#setWfList .wf-item')];
    const ids = [...box.querySelectorAll('[id]')].map((b) => b.id);
    return {
      dup: ids.filter((id, i) => ids.indexOf(id) !== i),
      has: ['setWfSearch', 'setWfList', 'setCats', 'setImportWf', 'setWfDefault']
        .every((id) => !!box.querySelector('#' + id)),
      gone: ['setAddPreset', 'setManagePreset', 'setManageLibrary', 'setOpenLib']
        .filter((id) => !!box.querySelector('#' + id)).length,
      rows: rows.length,
      shape: rows.length
        // 只取第一个 class：★ 已设 / 吃遮罩压暗时会是「wf-star on」「wf-star off」
        ? [...rows[0].children].map((c) => c.tagName.toLowerCase()
            + (c.className ? '.' + String(c.className).split(' ')[0] : ''))
        : [],
      stars: rows.filter((r) => r.querySelector('.wf-star')).length,
      listH: Math.round(box.querySelector('#setWfList').getBoundingClientRect().height),
      libRow: rows.some((r) => r.dataset.id.indexOf('lib:') === 0),
    };
  })()`);
  check('设置里的工作流区不再重复：一组按钮 + 一份列表，旧的「新增 / 管理预设、管理库工作流」全删了',
    wfSet.has && wfSet.gone === 0 && wfSet.dup.length === 0,
    JSON.stringify({ has: wfSet.has, gone: wfSet.gone, dup: wfSet.dup }));
  check('工作流列表每行是「图标 / 名字 / 分类 / 加到画布 / ☆ 设默认 / 查残留 / 删除」七件套',
    wfSet.shape.join('|') === 'button.wf-ico-btn|b|button.wf-cat|button.wf-use|button.wf-star|button.wf-check|button.wf-del'
      && wfSet.stars === wfSet.rows,
    JSON.stringify({ shape: wfSet.shape, stars: wfSet.stars }));
  check('列表按内容撑开（不被压成一条线），预设和自己存进库的工作流在同一份列表里',
    wfSet.listH >= 96 && wfSet.libRow && wfSet.rows >= 7,
    JSON.stringify({ h: wfSet.listH, rows: wfSet.rows, lib: wfSet.libRow }));

  // 分类可以自己加：新建「我的常用」，再把库工作流挪过去
  await page.evaluate(`window.prompt = () => '我的常用'`);
  const addChip = await page.center('#appSettings .wf-chip.add');
  await page.clickAt(addChip.x, addChip.y, { settle: 900 });
  const catNew = await page.evaluate(`(() => {
    const box = document.getElementById('appSettings');
    return [...box.querySelectorAll('.wf-chip span')].map((s) => s.textContent);
  })()`);
  check('能新建分类（胶囊里多一个「我的常用」）', catNew.includes('我的常用'), catNew.join(' / '));

  const libCell = await page.center('#appSettings #setWfList .wf-item[data-id^="lib:"] .wf-cat');
  await page.clickAt(libCell.x, libCell.y, { settle: 500 });
  await page.evaluate(`[...document.querySelectorAll('.popmenu button')]
    .find((b) => b.textContent.trim() === '我的常用').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const catMoved = await page.evaluate(`(() => {
    const box = document.getElementById('appSettings');
    const row = box.querySelector('#setWfList .wf-item[data-id^="lib:"]');
    return {
      cat: row ? row.querySelector('.wf-cat').textContent : '',
      chips: [...box.querySelectorAll('.wf-chip')].map((c) => c.textContent),
    };
  })()`);
  check('给工作流换分类：行里的胶囊跟着变，分类那排立刻多出这一组',
    catMoved.cat === '我的常用' && catMoved.chips.includes('我的常用1'),
    JSON.stringify({ cat: catMoved.cat, chips: catMoved.chips }));

  // 存进服务端，不是只记在内存里：关掉重开还在
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await new Promise((r) => setTimeout(r, 300));
  await page.click('#projectBar [data-act="settings"]', { settle: 900 });
  const catKept = await page.evaluate(`(() => {
    const box = document.getElementById('appSettings');
    return [...box.querySelectorAll('.wf-chip span')].map((s) => s.textContent);
  })()`);
  check('分类表存到了服务端（关掉设置再开还在）', catKept.includes('我的常用'), catKept.join(' / '));
  await page.evaluate(`delete window.prompt`);
  // 删除也走设置里那个 ×。这条曾经是坏的：列表项没带 file，
  // deleteWfItem 拿到的是 undefined → 请求 /api/library/undefined → 404，界面只会说「删除失败」。
  // 顺带把夹具工作流清掉，别留给后面的用例。
  await page.evaluate(`window.confirm = () => true`);
  // 这里**不能**用 center() + clickAt()：坐标是先量后点，中间只要列表重排一次
  // （分类异步回填、行高变化）就会点到隔壁那行的 ×——而隔壁是另一份工作流，
  // 真文件，删掉就没了（跑测试把用户的预设删了两次，就是这么来的）。
  // × 绑的是普通 onclick，直接点元素，坐标竞态就没有了。
  // 点名删「e2e 我的流程」这一条：以前这里点的是「第一个 lib: 行」，
  // 而列表里现在全是 lib: 行（内置预设删掉后只剩库这一个来源），第一个就是夹具里的真工作流，
  // 删掉它后面所有生成用例都会红。点名删自己造的一次性条目，绝不碰夹具。
  await page.evaluate(`document.querySelector('#appSettings #setWfList .wf-item[data-id="lib:e2e 我的流程"] .wf-del').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const delGone = await page.evaluate(`(async () => {
    const box = document.getElementById('appSettings');
    const rows = [...box.querySelectorAll('#setWfList .wf-item')].map((r) => r.dataset.id);
    // 查列表而不是 GET 那个已删的名字：那一下必然 404，会把最后的「控制台无报错」拖红
    const r = await (await fetch('/api/library')).json();
    return { rows, names: (r.items || []).map((it) => it.name) };
  })()`);
  check('设置里的 × 真能删掉库工作流（曾经请求成 /api/library/undefined）',
    !delGone.rows.includes('lib:e2e 我的流程') && !delGone.names.includes('e2e 我的流程'),
    JSON.stringify(delGone));

  // ---- 工作流图标：内置模型标 + 自己传的图 ----
  // 名字左边那一格。没设过时是虚线框（不是「图裂了」），点开是 12 个预设模型标。
  // 这里用**夹具里第一行**当样本，测完恢复默认——不动它的名字和分类，后面还要跑生成。
  const icoSlot = await page.evaluate(`(() => {
    const row = document.querySelector('#appSettings #setWfList .wf-item');
    const b = row && row.querySelector('.wf-ico-btn');
    return { id: row ? row.dataset.id : '', hasBtn: !!b,
             none: !!(b && b.querySelector('.wf-ico.is-none')) };
  })()`);
  check('工作流每行名字前有图标位，没设过时画成虚线框（不是空白也不是图裂）',
    icoSlot.hasBtn && icoSlot.none, JSON.stringify(icoSlot));

  await page.evaluate(`document.querySelector('#appSettings #setWfList .wf-item .wf-ico-btn').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const icoPicker = await page.evaluate(`(() => {
    const p = document.querySelector('.icon-pop');
    if (!p) return null;
    const btns = [...p.querySelectorAll('.icon-pick')];
    return { n: btns.length, names: btns.map((b) => b.title).slice(0, 4),
             foot: [...p.querySelectorAll('.icon-pop-row button')].map((b) => b.textContent) };
  })()`);
  check('点图标弹出一排预设模型标（Qwen / FLUX / SD…），另有「上传图片 / 恢复默认」',
    !!icoPicker && icoPicker.n >= 10 && /Qwen/.test(icoPicker.names[0]) && icoPicker.foot.length === 2,
    JSON.stringify(icoPicker));

  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('.icon-pop .icon-pick')].find((x) => /Qwen/.test(x.title));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const icoSet = await page.evaluate(`(async () => {
    const row = document.querySelector('#appSettings #setWfList .wf-item');
    const ico = row.querySelector('.wf-ico-btn .wf-ico');
    const img = ico && ico.querySelector('img');
    const lib = await (await fetch('/api/library')).json();
    const it = (lib.items || []).find((x) => 'lib:' + x.name === row.dataset.id);
    return { id: row.dataset.id,
             src: img ? img.getAttribute('src') : '',
             // 只看 src 不够：路径写错（比如 /static/logos/）时 src 一样对，
             // 但图是 404，界面上就是一块空白。必须看真的解码出来了没有。
             loaded: !!(img && img.complete && img.naturalWidth > 0),
             // 商标是白色透明底 PNG，容器带 is-logo 且不垫浅色板（垫了白图标就没了）
             plate: !!(ico && ico.classList.contains('is-logo')),
             bg: ico ? getComputedStyle(ico).backgroundColor : '',
             server: it ? it.icon : '(缺)' };
  })()`);
  check('选「Qwen」→ 这一行当场换成 Qwen 的商标，服务端也记下了（preset:qwen）',
    /^\/logos\/qwen\.png(\?v=\d+)?$/.test(icoSet.src) && icoSet.loaded && icoSet.plate
      && icoSet.server === 'preset:qwen',
    JSON.stringify(icoSet));
  // 白色图标 + 浅色垫板 = 什么都看不见。这条专门盯住那个退化。
  check('商标容器不垫浅色板（白图标垫白底就消失了）',
    /rgba\(0, 0, 0, 0\)|transparent/.test(icoSet.bg), icoSet.bg);

  // 自己传一张：前端先缩到 96px 再传，服务端按内容哈希落盘（data/icons/）。
  // 不把 base64 写进工作流文件——那个文件是每次列库都要整份读的。
  await page.evaluate(`document.querySelector('#appSettings #setWfList .wf-item .wf-ico-btn').click()`);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('.icon-pop .icon-pop-row button')].find((x) => /上传图片/.test(x.textContent));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await page.setFiles('input.wf-ico-file', [path.join(ROOT, 'tests', 'fixtures', 'icon-sample.png')]);
  await new Promise((r) => setTimeout(r, 1300));
  const icoUp = await page.evaluate(`(async () => {
    const row = document.querySelector('#appSettings #setWfList .wf-item');
    const img = row.querySelector('.wf-ico-btn .wf-ico img');
    const lib = await (await fetch('/api/library')).json();
    const it = (lib.items || []).find((x) => 'lib:' + x.name === row.dataset.id);
    return { src: img ? img.getAttribute('src') : '', server: it ? it.icon : '' };
  })()`);
  check('上传自己的图 → 变成 <img>，服务端存成 file:哈希.png（不把 base64 塞进工作流文件）',
    /^\/api\/icon\/[0-9a-f]{8,40}\.png$/.test(icoUp.src)
      && /^file:[0-9a-f]{8,40}\.png$/.test(icoUp.server),
    JSON.stringify(icoUp));

  await page.evaluate(`document.querySelector('#appSettings #setWfList .wf-item .wf-ico-btn').click()`);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('.icon-pop .icon-pop-row button')].find((x) => /恢复默认/.test(x.textContent));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const icoReset = await page.evaluate(`(async () => {
    const row = document.querySelector('#appSettings #setWfList .wf-item');
    const lib = await (await fetch('/api/library')).json();
    const it = (lib.items || []).find((x) => 'lib:' + x.name === row.dataset.id);
    return { none: !!row.querySelector('.wf-ico.is-none'), server: it ? it.icon : '(缺)' };
  })()`);
  check('「恢复默认」→ 回到虚线框，工作流文件里那个 icon 字段被删掉（不是留个空串）',
    icoReset.none && icoReset.server === '', JSON.stringify(icoReset));

  // ---- 库工作流：改名直接写回文件，删除就是真删 ----
  // 以前列表里还并着一份随程序分发的 presets/：改名只能记覆盖层、删除只能「隐藏」，
  // 于是多出一整套「恢复出厂」。内置预设整档删掉之后，库里的条目就是普通文件，
  // 这里验的就是这两件事本身。用一次性条目当样本，别动夹具里的工作流（后面还要跑生成）。
  await page.evaluate(`(async () => {
    await fetch('/api/library/' + encodeURIComponent('e2e 改名样本'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: { '1': { class_type: 'KSampler', inputs: {} } }, title: 'e2e 改名样本' }),
    });
  })()`);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await new Promise((r) => setTimeout(r, 300));
  await page.click('#projectBar [data-act="settings"]', { settle: 900 });
  const libRow = await page.evaluate(`(() => {
    const row = document.querySelector('#appSettings #setWfList .wf-item[data-id="lib:e2e 改名样本"]');
    if (!row) return null;
    return { id: row.dataset.id, label: row.querySelector('b').textContent };
  })()`);
  check('新建的库工作流立刻出现在设置列表里（不再有第二份来源）', !!libRow, JSON.stringify(libRow));
  if (libRow) {
    await page.evaluate(`window.prompt = () => 'e2e 改过的名字'`);
    await page.evaluate(`document.querySelector('#appSettings #setWfList .wf-item[data-id="${libRow.id}"] b').click()`);
    await new Promise((r) => setTimeout(r, 900));
    const libRenamed = await page.evaluate(`(async () => {
      const lib = await (await fetch('/api/library')).json();
      const it = (lib.items || []).find((x) => x.name === 'e2e 改名样本') || {};
      const row = document.querySelector('#appSettings #setWfList .wf-item[data-id="lib:e2e 改名样本"]');
      return { label: row ? row.querySelector('b').textContent : '', title: it.title || '' };
    })()`);
    check('改名写回库文件本身（列表和 /api/library 一起变，没有覆盖层这一说）',
      libRenamed.label === 'e2e 改过的名字' && libRenamed.title === 'e2e 改过的名字',
      JSON.stringify(libRenamed));

    await page.evaluate(`window.confirm = () => true`);
    await page.evaluate(`document.querySelector('#appSettings #setWfList .wf-item[data-id="lib:e2e 改名样本"] .wf-del').click()`);
    await new Promise((r) => setTimeout(r, 900));
    const libGone = await page.evaluate(`(async () => {
      const lib = await (await fetch('/api/library')).json();
      return {
        rows: [...document.querySelectorAll('#appSettings #setWfList .wf-item')].map((r) => r.dataset.id),
        names: (lib.items || []).map((x) => x.name),
      };
    })()`);
    check('删除是真删：列表里没了，/api/library 里也没了',
      !libGone.rows.includes('lib:e2e 改名样本') && !libGone.names.includes('e2e 改名样本'),
      JSON.stringify(libGone));
    await page.evaluate(`delete window.prompt`);
    await page.evaluate(`delete window.confirm`);
  }
  // ---- 已导入的工作流也能再查一次残留 ----
  // 导入那一刻的检查只弹一次；文件早就躺在列表里了，想再确认一遍（或者怀疑某张图不是
  // 自己出的）原来一个入口都没有。现在每行末尾有一颗放大镜。
  await page.evaluate(`(() => {
    window.__residueFixtureFetch = window.fetch;
    window.__residueFixtureCalls = 0;
    window.fetch = async (u, o) => {
      if (String(u).startsWith('/api/residue')) {
        const graph = JSON.parse(o.body).graph || {};
        const dirty = window.__residueFixtureCalls++ === 1;
        const residue = dirty ? [{
          id: '61.value', kind: 'text', node: '61', input: 'value', class_type: 'CLIPTextEncode',
          where: 'CLIPTextEncode · 61.value', value: 'E2E dirty prompt', fix: '', auto: false,
          why: 'test residue',
        }] : [];
        return new Response(JSON.stringify({ ok: true, source: 'api', graph, residue,
          node_count: Object.keys(graph).length, partial: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return window.__residueFixtureFetch(u, o);
    };
  })()`);
  const chkClean = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('#appSettings #setWfList .wf-item[data-id="lib:Qwen-image-2.1图像编辑.api"]');
    if (!row) return { missing: true };
    const btn = row.querySelector('.wf-check');
    if (!btn) return { noBtn: true };
    btn.click();
    for (let k = 0; k < 60; k++) {
      const badge = document.getElementById('queueBadge');
      if (badge && !badge.classList.contains('hidden') && /干净|残留/.test(badge.textContent)) break;
      await sleep(100);
    }
    const badge = document.getElementById('queueBadge');
    return { flash: badge ? badge.textContent : '', card: !!document.getElementById('residueCard') };
  })()`);
  check('已导入的工作流能再查一次残留：干净的直接说「是干净的」，不弹卡片',
    chkClean.flash && /是干净的/.test(chkClean.flash) && chkClean.card === false,
    JSON.stringify(chkClean));

  const chkDirty = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const row = document.querySelector('#appSettings #setWfList .wf-item[data-id="lib:krea2-文生图.api"]');
    if (!row) return { missing: true };
    row.querySelector('.wf-check').click();
    for (let k = 0; k < 60 && !document.getElementById('residueCard'); k++) await sleep(100);
    const card = document.getElementById('residueCard');
    const out = {
      card: !!card,
      title: card ? card.querySelector('.sheet header strong').textContent : '',
      rows: card ? card.querySelectorAll('.rs-row').length : 0,
      clean: card ? (card.querySelector('.rs-clean') || {}).textContent : '',
      skip: card ? (card.querySelector('.rs-skip') || {}).textContent : '',
      note: card ? card.textContent.replace(/\\s+/g, ' ') : '',
    };
    // 只验证「能不能查到」，不改任何文件：直接取消
    if (card) card.querySelector('.rs-cancel').click();
    await sleep(120);
    out.gone = !document.getElementById('residueCard');
    return out;
  })()`);
  check('查到残留就列出条目，底部改成「不改 / 清理选中项并保存」（不是「导入」）',
    chkDirty.card && chkDirty.rows > 0 && /清理选中项并保存/.test(chkDirty.clean)
      && chkDirty.skip === '不改' && /写回工作流库/.test(chkDirty.note) && chkDirty.gone,
    JSON.stringify({ ...chkDirty, note: (chkDirty.note || '').slice(0, 160) }));

  await page.evaluate(`(() => {
    if (window.__residueFixtureFetch) window.fetch = window.__residueFixtureFetch;
    delete window.__residueFixtureFetch;
    delete window.__residueFixtureCalls;
  })()`);
  await page.evaluate(`delete window.confirm`);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await new Promise((r) => setTimeout(r, 300));
  // ---- 导入前的残留体检 ----
  // API 图里 LoadImage.image 记的是导出者机器上的文件名，换台机器就不存在，
  // 但会跟着提交给 ComfyUI，而界面上看不见也改不了。这里的口径是：
  // 非空的要报、空的不报；图片类默认勾选（清空永远安全）、文本类默认不勾（可能是模板自带的系统提示）。
  const residueProbe = await page.evaluate(`(async () => {
    const probe = async (graph) => (await (await fetch('/api/residue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph }),
    })).json());
    const dirty = await probe({
      '1': { class_type: 'LoadImage', inputs: { image: '023.jpg' }, _meta: { title: '加载图像' } },
      '2': { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: '加载图像' } },
    });
    const clean = await probe({
      '1': { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: '加载图像' } },
    });
    return { dirty, clean };
  })()`);
  const rd = residueProbe.dirty || {};
  const rl = rd.residue || [];
  check('导入前能查出 LoadImage 里的残留图（空值不误报）',
    rd.ok === true && rl.length === 1 && rl[0].node === '1' && rl[0].value === '023.jpg'
      && rl[0].auto === true && (residueProbe.clean || {}).residue.length === 0,
    JSON.stringify({ dirty: rl, clean: (residueProbe.clean || {}).residue }));

  // ---- ComfyUI 地址：换一台电脑之后不用改启动脚本 ----
  // 顶栏那一段状态本身就是入口（连不上时点它直接落到输入框），设置里能改、能存。
  await page.click('#projectBar [data-act="settings"]', { settle: 500 });
  const comfyPanel = await page.evaluate(`(() => {
    const input = document.getElementById('setComfyUrl');
    const hint = document.getElementById('setComfyHint');
    return {
      has: !!input && !!document.getElementById('setComfySave') && !!document.getElementById('setComfyReset') && !!hint,
      url: input ? input.value : '',
      placeholder: input ? input.placeholder : '',
      hint: hint ? hint.textContent.slice(0, 40) : '',
    };
  })()`);
  check('设置里有 ComfyUI 地址入口（地址 + 保存 + 恢复 + 当前状态）',
    comfyPanel.has && /^https?:\/\//.test(comfyPanel.url) && comfyPanel.placeholder === 'http://127.0.0.1:8188',
    JSON.stringify(comfyPanel));

  // 用一个确定没人监听的端口：手输 host:port 要能被补成 http:// 再存下来。
  // 等「保存并测试」自己跑完（它 disabled 就是忙碌标记），别用固定 sleep——
  // ComfyUI 在线时探活要走完整条链路，900ms 不一定回得来，读到的是上一拍的旧值，
  // 于是「地址没补 http://」「连不上不标红」两条一起假红。
  const deadPort = await freePort();
  await page.evaluate(`(() => {
    document.getElementById('setComfyUrl').value = '127.0.0.1:${deadPort}';
    document.getElementById('setComfySave').click();
  })()`);
  await page.waitFor(`!document.getElementById('setComfySave').disabled`, 15000);
  const comfySaved = await page.evaluate(`(() => ({
    url: document.getElementById('setComfyUrl').value,
    hint: document.getElementById('setComfyHint').textContent,
    cls: document.getElementById('setComfyHint').className,
  }))()`);
  check('手输 host:port 会被补成 http:// 再保存',
    comfySaved.url === `http://127.0.0.1:${deadPort}`, comfySaved.url);
  check('连不上时标红并说清原因（不是静默失败）',
    /set-tip bad/.test(comfySaved.cls) && /连不上/.test(comfySaved.hint), comfySaved.hint.slice(0, 60));

  await page.evaluate(`document.getElementById('setComfyReset').click()`);
  await page.waitFor(`!document.getElementById('setComfySave').disabled`, 15000);
  const comfyReset = await page.evaluate(`document.getElementById('setComfyUrl').value`);
  check('「恢复默认」把地址改回 127.0.0.1:8188', comfyReset === 'http://127.0.0.1:8188', comfyReset);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });

  await page.evaluate(`document.getElementById('comfyChip').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const chipEntry = await page.evaluate(`(() => ({
    open: !!document.getElementById('appSettings'),
    focus: document.activeElement ? document.activeElement.id : '',
  }))()`);
  check('顶栏 ComfyUI 状态就是入口：点一下直接落到地址输入框',
    chipEntry.open && chipEntry.focus === 'setComfyUrl', JSON.stringify(chipEntry));
  await page.key('Escape', { code: 'Escape', keyCode: 27 });

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
        gen: { prompt: '多图', wf: 'lib:krea2-txt2img.api', aspect: '1:1', size: '1k', batch: 4,
          seedMode: 'fixed', seed: 7, gallery: [0, 1, 2, 3].map(mk), idx: 0, extras: [],
          // 生成历史：两条，第一条的 items 与 gallery 相同（所以它会被标成「当前」）
          runs: [
            { at: Date.now() - 1000, prompt: '第二版：雨夜霓虹', seed: 222, w: 1024, h: 1024, batch: 4,
              wf: 'lib:krea2-txt2img.api', items: [0, 1, 2, 3].map(mk) },
            { at: Date.now() - 60000, prompt: '第一版：晴天街角', seed: 111, w: 768, h: 768, batch: 2,
              wf: 'lib:krea2-txt2img.api', items: [1, 2].map(mk) },
            { at: Date.now() - 180000, prompt: '更早：胶片质感', seed: 99, w: 512, h: 512, batch: 1,
              wf: 'lib:krea2-txt2img.api', items: [3].map(mk) },
            { at: Date.now() - 600000, prompt: '最早：白底静物', seed: 7, w: 512, h: 512, batch: 1,
              wf: 'lib:krea2-txt2img.api', items: [0].map(mk) },
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
    const ta = el.querySelector('.text-body');
    if (!ta) return null;
    ta.innerHTML = '<div>来自提示词节点：雨夜巷口，霓虹反光</div>';
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
  // 详情里的提示词 = 上游文本节点那段 + 面板那段（面板不再「有上游就作废」），
  // 两段用空行隔开，顺序是上游在前
  check('用提示词节点 + 面板的图，大图详情里两段词都在（不再写「没有关联的提示词」）',
    !lbText.hidden
      && (lbText.prompt || '').startsWith('来自提示词节点：雨夜巷口，霓虹反光')
      && (lbText.prompt || '').includes('多图')
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

  // ---- 资产库：流畅度 / 宽度 / 框选 / 缩略图 ----
  // 勾选一格只该改 class：以前每次点都 grid.innerHTML='' 重建全部格子，
  // 浏览器得把看得见的十几张大图重新解码一遍，点一下卡一下。
  await page.evaluate(`document.querySelector('#assetPane .asset-pick').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const reuse = await page.evaluate(`(() => {
    const cell = document.querySelector('#assetPane .asset-cell');
    const img = cell.querySelector('img');
    img.dataset.mark = 'first';
    cell.click();
    const after = document.querySelector('#assetPane .asset-cell img');
    return { same: after.dataset.mark === 'first', on: cell.classList.contains('on') };
  })()`);
  check('勾选一格不重建格子：<img> 还是原来那个（省掉一次大图解码）',
    reuse.same && reuse.on === true, JSON.stringify(reuse));

  // 缩略图的规则（见 app.js 的 thumbURL）：服务端能取的（/api/ 开头）走 /api/thumb?w=320，
  // 原图地址留在 data-src；画布上的图是 dataURL，服务端缩不了，原样用。
  // 以前这条用例只找 /api/ 那一类格子，本机没有真实产物时直接 null → 假红。
  // 现在两种格子都按规则验，只有「一条 /api/ 资产都没有」时才跳过缩略图那半条。
  const thumb = await page.evaluate(`(() => {
    const cells = [...document.querySelectorAll('#assetPane .asset-cell')];
    const bad = [];
    let api = 0;
    for (const c of cells) {
      const full = c.dataset.src || '';
      const src = c.querySelector('img').getAttribute('src') || '';
      if (full.startsWith('/api/')) {
        api++;
        if (!src.startsWith('/api/thumb') || !/[?&]w=320/.test(src) || !src.includes(encodeURIComponent(full))) {
          bad.push({ full: full.slice(0, 30), src: src.slice(0, 30) });
        }
      } else if (src !== full) {
        bad.push({ full: full.slice(0, 20), src: src.slice(0, 20) });
      }
    }
    return { n: cells.length, api, bad: bad.slice(0, 3) };
  })()`);
  check('格子的图按规则取地址：/api/ 资产走缩略图、dataURL 原样用，原图地址都留在 data-src',
    thumb.n > 0 && thumb.bad.length === 0, JSON.stringify(thumb));
  if (thumb.api === 0) {
    skip('格子里的图走缩略图接口（w=320）', '本机资产列表里没有 /api/ 资产，这一半没东西可验');
  }

  // 框选：拖一个框，框到的格子一次全选中
  const marqBox = await page.evaluate(`(() => {
    const r = [...document.querySelectorAll('#assetPane .asset-cell')].map((c) => {
      const b = c.getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom };
    });
    const last = r[Math.min(3, r.length - 1)];
    const hit = r.filter((x) => x.r >= r[0].l && x.l <= last.r && x.b >= r[0].t && x.t <= last.b).length;
    return {
      from: { x: Math.round(r[0].l + 3), y: Math.round(r[0].t + 3) },
      to: { x: Math.round(last.r - 3), y: Math.round(last.b - 3) },
      hit, n: r.length,
    };
  })()`);
  // 先把上一格勾选清掉（走「清空」按钮，别只手改 class——那会让内部状态对不上）
  await page.evaluate(`document.querySelector('#assetPane .asset-none').click()`);
  await new Promise((r) => setTimeout(r, 150));
  await page.drag(marqBox.from, marqBox.to, { steps: 14, settle: 400 });
  const marq = await page.evaluate(`({
    on: document.querySelectorAll('#assetPane .asset-cell.on').length,
    label: (document.querySelector('#assetPane .asset-sel') || {}).textContent,
    left: !!document.querySelector('#assetPane .asset-marquee'),
  })`);
  check('框选：拖一个框，框到的格子一次全选中（不用一张张点）',
    marqBox.hit >= 2 && marq.on === marqBox.hit && marq.label === `已选 ${marqBox.hit} 项`
      && marq.left === false, JSON.stringify({ marqBox, marq }));

  // 动作条：上行「选了什么」，下行「做什么」；「完成」离「删除」最远
  const actBar = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#assetPane .asset-actions .asset-arow')];
    return {
      rows: rows.map((r) => [...r.children].map((c) => (c.tagName === 'SELECT' ? 'select' : c.textContent.trim()))),
    };
  })()`);
  check('动作条按「先选、再动手」重排：上行计数+全选/清空/完成，下行才是收进库/移动/删除',
    actBar.rows.length === 2 && actBar.rows[0][0].startsWith('已选')
      && actBar.rows[0].slice(1).join('/') === '全选/清空/完成'
      && actBar.rows[1].join('/') === '收进库/select/删除', JSON.stringify(actBar));

  // 顶栏那个「选择」在多选态里要让位：否则屏幕上并排两个「完成」，点哪个都行，反而犹豫。
  const pickToggle = await page.evaluate(`(() => {
    const b = document.querySelector('#assetPane .asset-pick');
    return {
      gone: b.classList.contains('gone'),
      visible: getComputedStyle(b).display !== 'none',
      q: Math.round(document.querySelector('#assetPane .asset-q').getBoundingClientRect().width),
      done: document.querySelectorAll('#assetPane .asset-actions .asset-done').length,
    };
  })()`);
  check('多选态里顶栏「选择」让位：全屏只有动作条一个「完成」，搜索框占满',
    pickToggle.gone && !pickToggle.visible && pickToggle.done === 1 && pickToggle.q > 240,
    JSON.stringify(pickToggle));

  // 拖左边沿变宽：宫格列数跟着涨（不是把三列拉大）
  const w0 = await page.evaluate(`Math.round(document.querySelector('#assetPane .asset-pane').getBoundingClientRect().width)`);
  const gripPt = await page.evaluate(`(() => {
    const r = document.querySelector('#assetPane .asset-grip').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await page.drag({ x: gripPt.x, y: gripPt.y }, { x: gripPt.x - 300, y: gripPt.y }, { steps: 12, settle: 400 });
  const w1 = await page.evaluate(`(() => {
    const pane = document.querySelector('#assetPane .asset-pane');
    return {
      w: Math.round(pane.getBoundingClientRect().width),
      cols: getComputedStyle(document.querySelector('#assetPane .asset-grid')).gridTemplateColumns.split(' ').length,
      saved: localStorage.getItem('infisheet-asset-w'),
    };
  })()`);
  check('拖左边沿把抽屉拉宽：宫格多排几列（宽度记在本机，下次打开还是这么宽）',
    w1.w >= w0 + 200 && w1.cols > 3 && Number(w1.saved) === w1.w,
    JSON.stringify({ w0, w1 }));
  await page.evaluate(`document.querySelector('#assetPane .asset-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 250));
  const w2 = await page.evaluate(`Math.round(document.querySelector('#assetPane .asset-pane').getBoundingClientRect().width)`);
  check('双击左边沿：宽度复位到默认', w2 === w0, `${w0} → ${w1.w} → ${w2}`);

  // 退出多选态，后面的用例还要接着点格子
  await page.evaluate(`document.querySelector('#assetPane .asset-pick').click()`);
  await new Promise((r) => setTimeout(r, 200));

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
  // 格子里的 <img> 现在是缩略图，原图地址在 data-src 上（点「＋」落进画布的是原图）
  const pickSrc = await page.evaluate(`document.querySelector('#assetPane .asset-cell').dataset.src`);
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

  // ---- 资产库：改名 / 分组 / 多选 / 移动 / 移除 ----
  // 分组和「移除」都是本项目自己的用户数据（data/asset-lib.json），不依赖 ComfyUI，
  // 所以这一段在 CI 里能完整跑。最要紧的一条：移除只写 hidden 标记，绝不删磁盘文件——
  // 断言查的是「列表里少了」，不是「文件没了」。
  const paneTitle = await page.evaluate(`document.querySelector('#assetPane header strong').textContent`);
  check('面板叫「资产库」，不再只是「资产」', paneTitle === '资产库', paneTitle);

  // prompt / confirm 是原生弹窗，无头下点不了：在页面里换掉
  await page.evaluate(`(() => {
    window.__answer = null;
    window.prompt = () => window.__answer;
    window.confirm = () => true;
    return true;
  })()`);
  await page.evaluate(`window.__answer = '人像'; document.querySelector('#assetPane .asset-g-add').click()`);
  await new Promise((r) => setTimeout(r, 800));
  const gPills = await page.evaluate(`[...document.querySelectorAll('#assetPane .asset-groups button')].map((b) => b.textContent)`);
  check('新建分组：胶囊排在「全部 / 未分组」之后',
    gPills[0] === '全部' && gPills[1] === '未分组' && gPills.includes('人像'), gPills.join('/'));

  // 多选：进选择态，点两格
  await page.evaluate(`document.querySelector('#assetPane .asset-pick').click()`);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(`document.querySelectorAll('#assetPane .asset-cell')[0].click()`);
  await page.evaluate(`document.querySelectorAll('#assetPane .asset-cell')[1].click()`);
  await new Promise((r) => setTimeout(r, 300));
  const pickState = await page.evaluate(`({
    label: (document.querySelector('#assetPane .asset-sel') || {}).textContent,
    on: document.querySelectorAll('#assetPane .asset-cell.on').length,
    hintHidden: document.querySelector('#assetPane .asset-hint').classList.contains('hidden'),
  })`);
  check('多选：点两格 → 「已选 2 项」，提示行让位给动作条',
    pickState.label === '已选 2 项' && pickState.on === 2 && pickState.hintHidden === true,
    JSON.stringify(pickState));

  // 移动到「人像」
  await page.evaluate(`(() => {
    const s = document.querySelector('#assetPane .asset-move');
    s.value = [...s.options].find((o) => o.textContent === '人像').value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(`[...document.querySelectorAll('#assetPane .asset-groups button')].find((b) => b.textContent === '人像').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const inGroup = await page.evaluate(`({
    n: document.querySelectorAll('#assetPane .asset-cell').length,
    ops: [...document.querySelectorAll('#assetPane .asset-g-ops button')].map((b) => b.textContent),
  })`);
  check('移动：两张进了「人像」，筛该分组只剩这两张（并且露出改名/删除）',
    inGroup.n === 2 && inGroup.ops.join('/') === '改名/删除', JSON.stringify(inGroup));

  // 移除：还在多选态，选一张删掉
  await page.evaluate(`document.querySelectorAll('#assetPane .asset-cell')[0].click()`);
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(`document.querySelector('#assetPane .asset-del').click()`);
  await new Promise((r) => setTimeout(r, 1000));
  const afterDel = await page.evaluate(`({
    cells: document.querySelectorAll('#assetPane .asset-cell').length,
    restore: document.querySelector('#assetPane .asset-restore').textContent,
  })`);
  check('移除：从资产库消失，底部留一个「已移除 1 项」的找回入口',
    afterDel.cells === 1 && afterDel.restore === '已移除 1 项', JSON.stringify(afterDel));

  // 找回：退回原分组（分组归属还在，不会被顺手清掉）
  await page.evaluate(`document.querySelector('#assetPane .asset-pick').click()`);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(`document.querySelector('#assetPane .asset-restore').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const afterRestore = await page.evaluate(`({
    cells: document.querySelectorAll('#assetPane .asset-cell').length,
    restoreHidden: document.querySelector('#assetPane .asset-restore').classList.contains('hidden'),
  })`);
  check('找回：点「已移除 N 项」放回原分组，入口自己消失',
    afterRestore.cells === 2 && afterRestore.restoreHidden === true, JSON.stringify(afterRestore));

  // 分组改名
  await page.evaluate(`window.__answer = '人物'; document.querySelector('#assetPane .asset-g-ops button').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const gRenamed = await page.evaluate(`[...document.querySelectorAll('#assetPane .asset-groups button')].map((b) => b.textContent)`);
  check('分组改名', gRenamed.includes('人物') && !gRenamed.includes('人像'), gRenamed.join('/'));

  // 删分组：组内资产回「未分组」，图本身不丢
  const cellsInGroup = (label) => page.evaluate(`(() => {
    [...document.querySelectorAll('#assetPane .asset-groups button')].find((b) => b.textContent === '${label}').click();
    return document.querySelectorAll('#assetPane .asset-cell').length;
  })()`);
  const u0 = await cellsInGroup('未分组');
  await cellsInGroup('人物');
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(`[...document.querySelectorAll('#assetPane .asset-g-ops button')].find((b) => b.textContent === '删除').click()`);
  await new Promise((r) => setTimeout(r, 1000));
  const afterRm = await page.evaluate(`[...document.querySelectorAll('#assetPane .asset-groups button')].map((b) => b.textContent)`);
  const u1 = await cellsInGroup('未分组');
  check('删分组：组内 2 张回到「未分组」，图本身不丢',
    !afterRm.includes('人物') && u1 === u0 + 2, `未分组 ${u0} → ${u1}；${afterRm.join('/')}`);

  // ---- 资产库的目录：收进库 / 改名 / 删除 / 改路径 ----
  // 上一段验的是「列表里的分组」，这一段验的是**磁盘**：库内文件真的是目录里的文件，
  // 收进库是复制，改名是改文件名，删除是移进 .trash 而不是 unlink。
  // 所以断言直接读 dataDir 下的文件系统——列表对了但文件没动，等于没做。
  const assetDir = path.join(dataDir, 'assets');
  const diskFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')) : []);
  const norm = (p) => String(p || '').replace(/\\/g, '/');

  const rootTitle = await page.evaluate(`document.querySelector('#assetPane .asset-path-t').title`);
  // title 现在是「路径 + 换行 + 一句说明」，取第一行比整串比更稳
  check('抽屉底部写明存放目录（完整路径挂在 title 上，一眼知道文件在哪）',
    norm(String(rootTitle).split('\n')[0]).endsWith('/assets'), rootTitle);
  // 「默认」两个字是给用户看的：默认路径跟着程序走，把整个文件夹拷到别的机器图还在；
  // 自定义路径（尤其填到 D:\ 上）换机器就没了。分不清这两者，用户就不知道该不该备份。
  const rootIsDefault = await page.evaluate(
    `document.querySelector('#assetPane .asset-path-t').textContent.includes('（默认）')`);
  check('默认路径在抽屉里标出「（默认）」（用户才知道这个目录是跟着程序走的）',
    rootIsDefault === true, String(rootIsDefault));

  await hit('canvas');
  await new Promise((r) => setTimeout(r, 350));
  await page.evaluate(`document.querySelector('#assetPane .asset-pick').click()`);
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(`document.querySelectorAll('#assetPane .asset-cell')[0].click()`);
  await page.evaluate(`document.querySelectorAll('#assetPane .asset-cell')[1].click()`);
  await page.evaluate(`document.querySelector('#assetPane .asset-imp').click()`);
  await new Promise((r) => setTimeout(r, 2200));
  const imported = diskFiles(assetDir);
  await hit('lib');
  await new Promise((r) => setTimeout(r, 450));
  const libView = await paneState();
  check('收进库：两张复制进资产目录（磁盘上真有文件），来源变成「库」',
    imported.length === 2 && libView.n === 2 && libView.badges.join() === '库',
    `磁盘 ${imported.join(',')} · 列表 ${libView.n} 张 ${libView.badges.join('/')}`);

  // 改名只对库内文件开放：库外的是 ComfyUI 的产物，改完下次读 /history 又变回去
  await page.evaluate(`document.querySelector('#assetPane .asset-pick').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const rnBtn = await page.evaluate(`!!document.querySelector('#assetPane .asset-cell .asset-rn')`);
  await page.evaluate(`window.__answer = '封面'; document.querySelector('#assetPane .asset-cell .asset-rn').click()`);
  await new Promise((r) => setTimeout(r, 1400));
  check('改名：库内格子有「改名」入口，且磁盘上的文件名真的跟着变',
    rnBtn === true && diskFiles(assetDir).includes('封面.svg'), diskFiles(assetDir).join(','));

  // 删除：真删（进系统回收站），原地址立刻 404，也不再留 .trash 目录
  // 按 src 找格子，不按下标：目录扫描顺序不是稳定的（NTFS 给什么顺序就是什么），
  // 按下标可能删到另一张，断言就成了「删对了才通过」的运气测试。
  // 按 data-src（原图地址）找，不按 <img>：img 现在指向缩略图，名字被套了两层编码
  const pickCover = `(() => {
    const cell = [...document.querySelectorAll('#assetPane .asset-cell')]
      .find((c) => decodeURIComponent(c.dataset.src || '').includes('封面'));
    return cell || null;
  })()`;
  const delSrc = await page.evaluate(`(() => {
    const c = ${pickCover};
    return c ? c.dataset.src : '';
  })()`);
  await page.evaluate(`document.querySelector('#assetPane .asset-pick').click()`);
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(`(() => { const c = ${pickCover}; if (c) c.click(); return !!c; })()`);
  await page.evaluate(`document.querySelector('#assetPane .asset-del').click()`);
  await new Promise((r) => setTimeout(r, 1600));
  const leftFiles = diskFiles(assetDir);
  // 从 Node 这边探，不在页面里 fetch：页面里打一个 404 会进控制台，
  // 末尾那条「控制台无报错」就被自己弄红了，真正该抓的 JS 报错反而被淹。
  const goneStatus = await fetch(server.base.replace(/\/$/, '') + delSrc).then((r) => r.status);
  check('删除库内文件：真删（进系统回收站），磁盘上没有，也不留 .trash',
    goneStatus === 404 && !leftFiles.includes('封面.svg') && !fs.existsSync(path.join(assetDir, '.trash')),
    `磁盘 ${leftFiles.join(',')} · 旧地址 ${goneStatus}`);

  // 改存放路径：文件跟着搬，抽屉里的路径跟着变
  const newRoot = path.join(dataDir, 'pics');
  await page.evaluate(`document.querySelector('#assetPane .asset-pick').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(`document.querySelector('#assetPane .asset-root').click()`);
  await page.evaluate(`(() => {
    const i = document.querySelector('#assetPane .asset-path-in');
    i.value = ${JSON.stringify(newRoot)};
    return true;
  })()`);
  await page.evaluate(`document.querySelector('#assetPane .asset-path button.prime').click()`);
  await new Promise((r) => setTimeout(r, 2000));
  const movedTo = diskFiles(newRoot);
  const movedTitle = await page.evaluate(`document.querySelector('#assetPane .asset-path-t').title`);
  check('改存放路径：剩下那张搬到新目录，抽屉里的路径跟着变',
    movedTo.length === 1 && norm(String(movedTitle).split('\n')[0]).endsWith('/pics'),
    `新目录 ${movedTo.join(',')} · 路径 ${movedTitle}`);
  const customText = await page.evaluate(`document.querySelector('#assetPane .asset-path-t').textContent`);
  check('改成自定义路径后不再标「（默认）」', !customText.includes('（默认）'), customText);

  // 清空 = 恢复默认。改过一次自定义路径的人得有路可退，否则只能去数据目录里翻 lib.json 手改。
  await page.evaluate(`document.querySelector('#assetPane .asset-root').click()`);
  await page.evaluate(`(() => {
    const i = document.querySelector('#assetPane .asset-path-in');
    i.value = '';
    return true;
  })()`);
  await page.evaluate(`document.querySelector('#assetPane .asset-path button.prime').click()`);
  await new Promise((r) => setTimeout(r, 2000));
  const backText = await page.evaluate(`document.querySelector('#assetPane .asset-path-t').textContent`);
  check('清空路径 = 恢复默认（文件搬回程序/数据目录下的 assets，并重新标出「（默认）」）',
    backText.includes('（默认）') && diskFiles(assetDir).length === 1, `${backText} · ${diskFiles(assetDir).join(',')}`);

  // 收尾：回到「全部」、退出多选，后面的 Esc 才是关抽屉
  await hit('all');
  await cellsInGroup('全部');
  await new Promise((r) => setTimeout(r, 300));

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

  // ---- 图片工具条：裁剪 / 遮罩 / 高清 ----
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
    const b = bar ? bar.getBoundingClientRect() : null;
    const at = document.elementFromPoint(${textSel.x}, ${textSel.y});
    return {
      exists: !!bar, hidden: !bar || bar.classList.contains('hidden'),
      bar: b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null,
      hit: at ? (at.className || at.tagName) + ' · ' + String(at.textContent || '').trim().slice(0, 8) : 'none',
      sel: [...document.querySelectorAll('#nodes .node.selected')].map((e) => e.dataset.id),
    };
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
      // 只数真正摊开的那几个：「更多编辑」是窄屏才顶替上来的，宽屏下 display:none
      tools: [...bar.querySelectorAll('.it-btn')]
        .filter((b) => b.getClientRects().length).map((b) => b.textContent.trim()),
      seps: bar.querySelectorAll('.it-sep').length,
      // 分隔线插在哪儿是「分组」这件事本身，光数个数看不出错位
      layout: [...bar.querySelectorAll('.it-btn, .it-sep')]
        .filter((el) => el.classList.contains('it-sep') || el.getClientRects().length)
        .map((el) => (el.classList.contains('it-sep') ? '|' : el.dataset.tool)).join('/'),
      // 居中；居中放不下时改成和节点左/右边缘对齐（见 positionImgTools），两种都算「贴着自己」
      attached: Math.abs((r.left + r.width / 2) - (nb.left + nb.width / 2)) <= 2
        || Math.abs(r.left - nb.left) <= 2 || Math.abs(r.right - nb.right) <= 2,
      w: Math.round(r.width),
      above: r.bottom <= nb.top,
      // 节点贴着屏幕上方时上面放不下（再抬就被顶栏挡住），这时压在自己那张图的上沿。
      // 三种位置都算「贴着自己这个节点」，真正不能接受的是压在**别的**节点标题上（clearsTitles）。
      below: r.top >= nb.bottom,
      gap: Math.round(nb.top - r.bottom),
      clearsTitles: [...document.querySelectorAll('#nodes .node')]
        .filter((el) => el.dataset.id !== '${pick.img}')
        .map((el) => el.querySelector('.node-title')).filter(Boolean)
        .every((t) => {
          const q = t.getBoundingClientRect();
          return q.right < r.left || q.left > r.right || q.bottom < r.top || q.top > r.bottom;
        }),
      inView: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth,
      h: Math.round(r.height),
      place: bar.dataset.place,
      // 整条浮在画布上难免压到别人：只让按钮吃点击，其余位置穿透
      pe: getComputedStyle(bar).pointerEvents,
      btnPe: getComputedStyle(bar.querySelector('.it-btn')).pointerEvents,
    };
  })()`);
  check('选中一张有图的节点 → 工具条贴着它（上方，放不下就压在自己图上）、图标 + 文案齐全',
    !toolBar.hidden
      && toolBar.tools.join('/') === '裁剪/旋转/调色/智能编辑/遮罩/擦除/去字/扩图/抠图/高清/下载'
      && toolBar.attached && toolBar.inView
      && (toolBar.place === 'above' || toolBar.place === 'over')
      && toolBar.pe === 'none' && toolBar.btnPe === 'auto',
    JSON.stringify(toolBar));
  // 智能编辑归在「靠遮罩」那一段：它和遮罩 / 擦除 / 去字是同一类（先标位置，再让模型改）
  check('工具条按「本地变换 / 涂抹 / 整图编辑 / 导出」分四段（三条分隔线，4/3/3/1）',
    toolBar.seps === 3
      && toolBar.layout === 'crop/rotate/color/|/smart/mask/erase/detext/|/outpaint/cutout/upscale/|/download',
    toolBar.layout);

  // ---- 窄屏收纳：1024 宽时把四个「整图交给模型」的工具收进「更多编辑」 ----
  // 整条带文字约 590px，1024 的窗口里横着几乎占满，很难找到不压别人标题的位置。
  // 收起来之后只剩 440 左右，好摆得多。收的是擦除 / 去字 / 抠图 / 高清，
  // 裁剪 / 旋转 / 调色 / 遮罩 / 扩图 / 下载 必须一直在条上。
  const wideTools = await page.evaluate(`(() => {
    const bar = document.getElementById('imgTools');
    const vis = [...bar.querySelectorAll('.it-btn')].filter((b) => b.getClientRects().length);
    const btns = vis.map((b) => b.getBoundingClientRect());
    const blocked = [...document.querySelectorAll('#nodes .node')]
      .filter((el) => el.dataset.id !== '${pick.img}')
      .map((el) => el.querySelector('.node-title')).filter(Boolean)
      .filter((t) => {
        const q = t.getBoundingClientRect();
        return btns.some((b) => !(q.right < b.left || q.left > b.right || q.bottom < b.top || q.top > b.bottom));
      }).length;
    return { narrow: bar.classList.contains('is-narrow'),
      tools: vis.map((b) => b.dataset.tool || 'more'),
      toggleShown: vis.some((b) => b.dataset.moreToggle),
      blocked };
  })()`);
  check('宽屏：工具条整条摊开，不出现「更多编辑」',
    wideTools.narrow === false && !wideTools.toggleShown && wideTools.tools.length === 11,
    JSON.stringify(wideTools));

  await page.setViewport(1024, 768);
  await new Promise((r) => setTimeout(r, 400));
  const narrowTools = await page.evaluate(`(() => {
    const bar = document.getElementById('imgTools');
    const r = bar.getBoundingClientRect();
    const vis = [...bar.querySelectorAll('.it-btn')].filter((b) => b.getClientRects().length);
    const nb = document.querySelector('.node[data-id="${pick.img}"]').getBoundingClientRect();
    const toggle = bar.querySelector('.it-more-toggle');
    // 「盖住标题」按**按钮**算，不按整条算：整条 pointer-events:none，空白处点下去会穿透，
    // 真正会抢点击的只有按钮本身。整条压到标题上一直是允许的（宽屏也一样）。
    const btns = vis.map((b) => b.getBoundingClientRect());
    const blockedTitles = [...document.querySelectorAll('#nodes .node')]
      .filter((el) => el.dataset.id !== '${pick.img}')
      .map((el) => ({ id: el.dataset.id, t: el.querySelector('.node-title') }))
      .filter((x) => x.t)
      .filter((x) => {
        const q = x.t.getBoundingClientRect();
        return btns.some((b) => !(q.right < b.left || q.left > b.right || q.bottom < b.top || q.top > b.bottom));
      })
      .map((x) => x.id);
    return {
      narrow: bar.classList.contains('is-narrow'),
      w: Math.round(r.width),
      tools: vis.map((b) => b.dataset.tool || 'more'),
      // 收起的那四个必须真的不占位（getClientRects 为空），不然只是「看不见但还挡着」
      gone: ['erase', 'detext', 'cutout', 'upscale']
        .every((k) => !bar.querySelector('[data-tool="' + k + '"]').getClientRects().length),
      // 「更多编辑」是个真按钮：可 Tab 到（tabIndex >= 0）、不是 display:none 的假元素
      toggleFocusable: !!toggle && toggle.tabIndex >= 0 && toggle.getClientRects().length > 0,
      inView: r.left >= 0 && r.right <= window.innerWidth,
      attached: Math.abs((r.left + r.width / 2) - (nb.left + nb.width / 2)) <= 2
        || Math.abs(r.left - nb.left) <= 2 || Math.abs(r.right - nb.right) <= 2,
      blockedTitles,
      vw: window.innerWidth,
    };
  })()`);
  // 智能编辑也留在条上（它和遮罩同类，属于高频），所以收起来之后是 7 颗 + 「更多编辑」
  check('1024 宽：四个「整图编辑」收进「更多编辑」，核心七颗还在（条从 ~670 收到 ~520）',
    narrowTools.narrow && narrowTools.gone
      && narrowTools.tools.join('/') === 'crop/rotate/color/smart/mask/outpaint/more/download'
      && narrowTools.toggleFocusable && narrowTools.w < 560,
    JSON.stringify(narrowTools));
  // 收纳的意义就是「腾地方」：条窄了之后，被按钮盖住的标题数不能比宽屏时更多。
  // （不要求「一个都不盖」：画布被用户拖乱之后，任何固定宽度的浮条都可能压到别人的标题，
  //   宽屏下也一样——这里只验「收起来确实更省地方」。）
  check('1024 宽：收纳之后工具条仍在视口内、仍贴着自己这个节点，且被按钮压住的标题不比宽屏多',
    narrowTools.inView && narrowTools.attached
      && narrowTools.blockedTitles.length <= wideTools.blocked,
    JSON.stringify({ inView: narrowTools.inView, attached: narrowTools.attached,
      narrowBlocked: narrowTools.blockedTitles, wideBlocked: wideTools.blocked, w: narrowTools.w }));

  const moreMenu = await page.evaluate(`(async () => {
    const t = document.querySelector('#imgTools .it-more-toggle');
    t.click();
    await new Promise((r) => setTimeout(r, 260));
    const m = document.querySelector('.popmenu');
    const out = m ? {
      title: (m.querySelector('.popmenu-title') || {}).textContent || '',
      items: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()),
      icons: [...m.querySelectorAll('button')].filter((b) => b.querySelector('svg')).length,
    } : null;
    t.click();          // 再点一次收起
    await new Promise((r) => setTimeout(r, 200));
    return out;
  })()`);
  check('「更多编辑」菜单：四项都在，且写清「需要生成 / 将在新节点中生成」',
    !!moreMenu && moreMenu.items.length === 4
      && /擦除 · 需要生成/.test(moreMenu.items[0])
      && /去字 · 需要生成/.test(moreMenu.items[1])
      && /抠图 · 将在新节点中生成/.test(moreMenu.items[2])
      && /高清 · 将在新节点中生成/.test(moreMenu.items[3])
      && moreMenu.icons === 4,
    JSON.stringify(moreMenu));

  await page.clearViewport();
  await new Promise((r) => setTimeout(r, 400));
  const backWide = await page.evaluate(`(() => {
    const bar = document.getElementById('imgTools');
    return { narrow: bar.classList.contains('is-narrow'),
      tools: [...bar.querySelectorAll('.it-btn')].filter((b) => b.getClientRects().length).length };
  })()`);
  check('视口还原后工具条自己摊开（不用刷新、不用重新选中）',
    backWide.narrow === false && backWide.tools === 11, JSON.stringify(backWide));

  // 下载：把图存成本地文件。headless 里不真落盘（会污染下载目录），只把 <a> 的
  // click 拦下来，验「文件名取自节点标题、扩展名跟着 MIME 走」这两件真正会错的事。
  const dl = await page.evaluate(`(async () => {
    const rec = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { rec.push(this.download); };
    const b = document.querySelector('#imgTools [data-tool="download"]');
    const hasIcon = !!(b && b.querySelector('svg'));
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 400));
    HTMLAnchorElement.prototype.click = orig;
    const title = (document.querySelector('.node[data-id="${pick.img}"] .n-name') || {}).textContent || '';
    return { rec, hasIcon, title };
  })()`);
  check('点「下载」→ 按节点标题命名、扩展名跟着图片 MIME（不是一律 .png）',
    dl.hasIcon && dl.rec.length === 1
      && dl.title && dl.rec[0] === `${dl.title.trim()}.svg`,
    JSON.stringify(dl));

  // 工具条是屏幕坐标：缩放画布后它的大小不该跟着变
  // 用 50%（节点缩到视口装得下）来验：200% 时节点本身比视口还宽，工具条必然被
  // 视口边缘夹住，「居中/在上方」就不该成立了。
  await page.evaluate(`document.querySelector('[data-zoom="0.5"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const toolZoomed = await page.evaluate(`(() => {
    const r = document.getElementById('imgTools').getBoundingClientRect();
    const nb = document.querySelector('.node[data-id="${pick.img}"]').getBoundingClientRect();
    return { h: Math.round(r.height),
             attached: Math.abs((r.left + r.width / 2) - (nb.left + nb.width / 2)) <= 2
               || Math.abs(r.left - nb.left) <= 2 || Math.abs(r.right - nb.right) <= 2,
             place: document.getElementById('imgTools').dataset.place };
  })()`);
  await page.evaluate(`document.querySelector('[data-zoom="fit"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  check('缩到 50% 后工具条尺寸不变、仍然贴着自己这个节点（屏幕坐标，不吃缩放）',
    toolZoomed.h === toolBar.h && toolZoomed.attached
      && (toolZoomed.place === 'above' || toolZoomed.place === 'over'),
    JSON.stringify(toolZoomed));

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
      // 同上：带文字之后整条很宽，压到别人的标题就往上抬，所以只看「在上面 + 不盖标题」
      const clears = [...document.querySelectorAll('#nodes .node')]
        .filter((x) => x !== el)
        .map((x) => x.querySelector('.node-title')).filter(Boolean)
        .every((t) => {
          const q = t.getBoundingClientRect();
          return q.right < b.left || q.left > b.right || q.bottom < b.top || q.top > b.bottom;
        });
      return {
        node: [Math.round(nb.left), Math.round(nb.top)],
        barCenter: Math.round(b.left + b.width / 2),
        nodeCenter: Math.round(nb.left + nb.width / 2),
        gap: Math.round(nb.top - b.bottom),
        // above / over 都算「贴着自己这个节点」：贴着屏幕顶边时上面放不下，会压在自己图上
        place: document.getElementById('imgTools').dataset.place,
        clears,
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
  const followOk = (s) => Math.abs(s.barCenter - s.nodeCenter) <= 2
    && (s.place === 'above' || s.place === 'over');
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
    const hit = (lib.items || []).find((x) => (x.title || x.name) === label);
    return {
      n: nodes.length,
      title: (last.querySelector('.n-name') || {}).textContent || '',
      selected: last.classList.contains('selected'),
      prompt: ta ? ta.textContent.trim().slice(0, 24) : '',
      wf: label,
      takesImage: !!(hit && hit.takes_image),
      cat: (hit && hit.category) || '',
      hasImg: !!last.querySelector('.thumb img'),
    };
  })()`);
  check('点「高清」→ 新建节点并自动挑到「高清放大」这一类（不是随便一个吃图的工作流）',
    editRes.n === editBefore + 1 && editRes.selected && editRes.title.startsWith('高清')
      && editRes.hasImg && editRes.prompt.includes('参考')
      && editRes.takesImage && editRes.cat === 'upscale',
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

  // ---- 旋转 / 调色 / 扩图 / 抠图 / 去字 ----
  // 前三个是本地处理（不进模型）：旋转和调色直接重画像素，扩图只负责把画布撑大。
  // 后两个要模型：抠图整张交给图像编辑，去字走遮罩 + 局部重绘。
  const toolBase = await page.evaluate(`document.querySelectorAll('#nodes .node').length`);
  // 工具条是「选中才有」的浮层：每个工具点之前先确保这张图被选中，
  // 免得被上一个动作（拖拽 / 同步）留下的选择状态带偏
  const selectImg = () => page.evaluate(`(() => {
    const el = document.querySelector('.node[data-id="${pick.img}"]');
    if (!el) return false;
    const opt = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', opt));
    el.dispatchEvent(new PointerEvent('pointerup', opt));
    return true;
  })()`);
  const lastNode = () => page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    const last = nodes[nodes.length - 1];
    const im = last ? last.querySelector('.thumb img') : null;
    return {
      n: nodes.length,
      title: last ? ((last.querySelector('.n-name') || {}).textContent || '') : '',
      w: im ? im.naturalWidth : 0, h: im ? im.naturalHeight : 0,
      src: im ? String(im.getAttribute('src')) : '',
      wf: (document.querySelector('.node.selected .gensel.wfsel .gm-btn') || {}).textContent || '',
      prompt: (document.querySelector('.node.selected .gen-prompt') || {}).textContent || '',
    };
  })()`);

  const srcBefore = await page.evaluate(`(() => {
    const im = document.querySelector('.node[data-id="${pick.img}"] .thumb img');
    return { src: String(im.getAttribute('src')), w: im.naturalWidth, h: im.naturalHeight };
  })()`);
  await selectImg();
  await new Promise((r) => setTimeout(r, 250));
  // 菜单是「点同一颗按钮再点一次就收起」的开关，中间插一拍等就可能被别的动作收掉：
  // 开菜单、读菜单、点菜单项都在同一拍里做完
  const rotMenu = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = document.querySelector('#imgTools [data-tool="rotate"]');
    const diag = { has: !!btn, disabled: btn ? btn.disabled : null,
                   sel: document.querySelectorAll('#nodes .node.selected').length,
                   barHidden: document.getElementById('imgTools').classList.contains('hidden'),
                   err: '' };
    try { btn.click(); } catch (e) { diag.err = String(e); }
    await sleep(60);
    const m = document.querySelector('.popmenu');
    diag.items = m ? [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
    const pick = [...document.querySelectorAll('.popmenu button')]
      .find((b) => b.textContent.trim() === '右转 90°');
    diag.clicked = !!pick;
    if (pick) pick.click();
    return diag;
  })()`);
  check('点「旋转」→ 弹出 90° / 180° / 翻转五种',
    rotMenu.items.join('/') === '右转 90°/左转 90°/旋转 180°/水平翻转/垂直翻转', JSON.stringify(rotMenu));
  await new Promise((r) => setTimeout(r, 800));
  const rotRes = await lastNode();
  check('「右转 90°」→ 新建节点、图确实换了一张（原图不动）',
    rotRes.n === toolBase + 1 && rotRes.title.startsWith('旋转')
      && rotRes.src && rotRes.src !== srcBefore.src,
    JSON.stringify({ rotRes, before: srcBefore.src.slice(0, 30) }));

  await selectImg();
  await new Promise((r) => setTimeout(r, 250));
  // 调色：预览和落地必须同一串 filter，否则「看着调好了、应用出来不一样」
  await page.evaluate(`document.querySelector('#imgTools [data-tool="color"]').click()`);
  await new Promise((r) => setTimeout(r, 350));
  const colorUi = await page.evaluate(`(() => {
    const p = document.getElementById('imgPanel');
    const sheet = p && p.querySelector('.ip-sheet');
    const img = document.querySelector('.node[data-id="${pick.img}"] .thumb img');
    let geo = null;
    if (sheet && img) {
      const pr = sheet.getBoundingClientRect(), ir = img.getBoundingClientRect();
      const ox = Math.max(0, Math.min(pr.right, ir.right) - Math.max(pr.left, ir.left));
      const oy = Math.max(0, Math.min(pr.bottom, ir.bottom) - Math.max(pr.top, ir.top));
      geo = {
        overlap: Math.round(ox * oy),
        inView: pr.left >= 0 && pr.top >= 0 && pr.right <= innerWidth && pr.bottom <= innerHeight,
        box: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)],
      };
    }
    const cs = p ? getComputedStyle(p) : null;
    return {
      open: !!p,
      sliders: p ? p.querySelectorAll('.ip-body input[type="range"]').length : 0,
      presets: p ? [...p.querySelectorAll('[data-preset]')].map((b) => b.textContent.trim()) : [],
      toolsHidden: document.getElementById('imgTools').classList.contains('hidden'),
      dim: cs ? cs.backgroundColor : '',
      blur: cs ? (cs.backdropFilter || cs.webkitBackdropFilter || 'none') : '',
      geo,
    };
  })()`);
  check('点「调色」→ 弹层有亮度/对比度/饱和度/色温 + 预设，且工具条让位',
    colorUi.open && colorUi.sliders === 4 && colorUi.presets.length >= 5 && colorUi.toolsHidden,
    JSON.stringify(colorUi));
  // 调色唯一的意义就是「看着这张图调」：以前是 inset:0 的模态（62% 黑罩 + 3px 模糊），
  // 还居中压在图上，拖滑杆时画布上根本看不出变化。
  check('调色面板不是模态：不铺黑罩、不模糊画布（否则「实时预览」等于看不见）',
    /rgba\(0, 0, 0, 0\)|transparent/.test(colorUi.dim) && (colorUi.blur === 'none' || colorUi.blur === ''),
    `${colorUi.dim} · blur=${colorUi.blur}`);
  check('调色面板贴着图片放：不压在图上，且整块都在视口内',
    !!colorUi.geo && colorUi.geo.overlap === 0 && colorUi.geo.inView,
    JSON.stringify(colorUi.geo));

  // 打开时四个滑杆全 0 —— 这就是「原图」。以前七个预设一个都不亮（看不出当前是哪档），
  // 而且点「应用」会新建一张和原图逐像素一样的副本。两件事都得盯住。
  const colorInit = await page.evaluate(`(() => {
    const p = document.getElementById('imgPanel');
    const apply = p.querySelector('.ip-apply');
    return {
      on: [...p.querySelectorAll('[data-preset].on')].map((b) => b.textContent.trim()),
      disabled: apply.disabled,
      tip: (p.querySelector('.ip-tip').textContent || '').trim(),
    };
  })()`);
  check('调色面板：打开时「原图」高亮、应用禁用（全 0 应用出来就是同一张图）',
    colorInit.on.length === 1 && colorInit.on[0] === '原图' && colorInit.disabled,
    JSON.stringify(colorInit));

  const colorDrag = await page.evaluate(`(async () => {
    const p = document.getElementById('imgPanel');
    const sl = p.querySelector('.ip-body input[data-k="bright"]');
    const apply = p.querySelector('.ip-apply');
    const fire = () => sl.dispatchEvent(new Event('input', { bubbles: true }));
    sl.value = '24'; fire();
    await new Promise((r) => setTimeout(r, 80));
    const moved = {
      on: [...p.querySelectorAll('[data-preset].on')].map((b) => b.textContent.trim()),
      disabled: apply.disabled,
      filter: document.querySelector('.node[data-id="${pick.img}"] .thumb img').style.filter,
    };
    sl.value = '0'; fire();
    await new Promise((r) => setTimeout(r, 80));
    const back = {
      on: [...p.querySelectorAll('[data-preset].on')].map((b) => b.textContent.trim()),
      disabled: apply.disabled,
    };
    return { moved, back };
  })()`);
  check('拖滑杆 → 预设高亮清空、应用可点、图上真的套了滤镜',
    colorDrag.moved.on.length === 0 && !colorDrag.moved.disabled
      && /brightness\(1\.24/.test(colorDrag.moved.filter),
    JSON.stringify(colorDrag.moved));
  check('拖回全 0 → 「原图」重新高亮、应用又禁用（高亮跟数值走，不跟最后点的按钮走）',
    colorDrag.back.on.length === 1 && colorDrag.back.on[0] === '原图' && colorDrag.back.disabled,
    JSON.stringify(colorDrag.back));
  await page.evaluate(`[...document.querySelectorAll('#imgPanel [data-preset]')]
    .find((b) => b.textContent.trim() === '黑白').click()`);
  await new Promise((r) => setTimeout(r, 250));
  const colorPrev = await page.evaluate(
    `document.querySelector('.node[data-id="${pick.img}"] .thumb img').style.filter`);
  check('选预设「黑白」→ 画布上的图立刻变灰（实时预览）', /saturate\(0/.test(colorPrev), colorPrev);
  await page.evaluate(`document.querySelector('#imgPanel .ip-apply').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const colorRes = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    const last = nodes[nodes.length - 1];
    const im = last.querySelector('.thumb img');
    let px = null;
    if (im && im.naturalWidth) {
      const cv = document.createElement('canvas');
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      const c = cv.getContext('2d');
      c.drawImage(im, 0, 0);
      const d = c.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
      px = [d[0], d[1], d[2]];
    }
    return { n: nodes.length, title: ((last.querySelector('.n-name') || {}).textContent || ''),
             px, filter: document.querySelector('.node[data-id="${pick.img}"] .thumb img').style.filter };
  })()`);
  check('应用后新建「调色」节点，黑白真的烘进图里，原图预览滤镜撤掉',
    colorRes.n === toolBase + 2 && colorRes.title.startsWith('调色') && colorRes.filter === ''
      && !!colorRes.px && Math.abs(colorRes.px[0] - colorRes.px[1]) <= 3 && Math.abs(colorRes.px[1] - colorRes.px[2]) <= 3,
    JSON.stringify(colorRes));

  // 非模态之后没有「点空白处」这层遮罩可点，Esc 得能关（第三个出口：× / 取消 / Esc）
  await page.evaluate(`document.querySelector('#imgTools [data-tool="color"]').click()`);
  await new Promise((r) => setTimeout(r, 300));
  const escClosed = await page.evaluate(`(async () => {
    const before = !!document.getElementById('imgPanel');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    return { before, after: !!document.getElementById('imgPanel') };
  })()`);
  check('调色面板：Esc 能关掉（非模态后没有遮罩可点，键盘是第三个出口）',
    escClosed.before && !escClosed.after, JSON.stringify(escClosed));

  await selectImg();
  await new Promise((r) => setTimeout(r, 250));
  // 扩图：边框直接长在节点图上（不再有独立弹层），点生成时才烘成像素 + 遮罩。
  // 这里顺带盯住这次修的 bug：面板里的尺寸档必须跟着边框走——不能图上 32×16、
  // 面板还停在 1:1 · 1K，那样点生成按 1024×1024 跑，出来的图尺寸全错。
  await page.evaluate(`document.querySelector('#imgTools [data-tool="outpaint"]').click()`);
  await new Promise((r) => setTimeout(r, 600));
  const outUi = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('#nodes .node')].find((n) => n.querySelector('.op-sel'));
    if (!el) return { open: false };
    const sel = el.querySelector('.op-sel');
    const st = el.querySelector('.op-stage').getBoundingClientRect();
    const im = el.querySelector('.op-stage img').getBoundingClientRect();
    const panel = el.querySelector('.gen-panel');
    const bar = document.querySelector('.op-bar');
    const btn = (k) => bar && bar.querySelector('[data-of="' + k + '"]');
    return {
      open: true,
      // 边框长在节点上（舞台 + 锚点），参数条并进这个节点的生成面板
      onNode: !!el.querySelector('.op-stage') && !!bar && !!panel && panel.contains(bar),
      inFlow: bar ? getComputedStyle(bar).position : '',
      // 面板收成一条：上传 / 画布素材 / 清空 / 风格（.gen-chips）、大提示词框、底下那排
      // （工作流胶囊 / 尺寸胶囊 / 生成）全部让位，面板里还看得见的孩子只剩这条参数条。
      // 注意别去查 .wfsel 的 display —— 它藏在自己的父级里，自身 computed 仍是 flex。
      sharedUi: !!panel && panel.classList.contains('op-on')
        && ['.gen-chips', '.gen-prompt'].every((s) => {
          const x = panel.querySelector(s);
          return x && getComputedStyle(x).display !== 'none';
        })
        && !!panel.querySelector('.gen-status-row .gen-status')
        && ['.gen-upload', '.gen-material', '.gen-expand', '.gen-style', '.gen-bar'].every((s) => {
          const x = panel.querySelector(s);
          return !x || getComputedStyle(x).display === 'none';
        }),
      // 第二行：提示词输入框 + 生成（状态文字也搬进来了，不然它和输入框抢地方）
      rows: bar ? [...bar.children].map((c) => c.className) : [],
      hasInput: !!panel && !!panel.querySelector('.gen-prompt'),
      inputTag: panel && panel.querySelector('.gen-prompt') ? panel.querySelector('.gen-prompt').tagName : '',
      inputVal: panel && panel.querySelector('.gen-prompt') ? panel.querySelector('.gen-prompt').textContent.trim() : '',
      // 面板贴着**画布外框**（和工具条一个逻辑，只是它在下方）：不能压住新扩出来的地方
      frameGap: panel ? Math.round(panel.getBoundingClientRect().top - st.bottom) : null,
      frameDx: panel ? Math.round((panel.getBoundingClientRect().left + panel.getBoundingClientRect().width / 2)
        - (st.left + st.width / 2)) : null,
      // 面板里那个大提示词框（这时被藏着）存的是同一条节点的提示词：两边必须一样，
      // 说明单行输入框是**编辑同一个字段**，不是给扩图另开一份
      panelPrompt: panel && panel.querySelector('.gen-prompt')
        ? panel.querySelector('.gen-prompt').textContent.trim() : null,
      runInBar: !!bar && !!bar.querySelector('.gen-run'),
      statusInRow: !!panel && !!panel.querySelector('.gen-status-row .gen-status'),
      cancelBeforeRun: !!bar && !!bar.querySelector('[data-of="cancel"] + .gen-run'),
      // 参数行必须**单行**：以前是 flex-wrap，工作流名 + 读数 + 状态一起变长时，
      // 生成按钮被挤到下一行单独占一行（用户截图里那个孤零零的 ↑）
      paramRow: (() => {
        const row = bar && bar.querySelector('.of-params');
        if (!row) return null;
        const rr = row.getBoundingClientRect();
        const kids = [...row.children].map((c) => c.getBoundingClientRect());
        // 每个孩子都完整落在这**一行**里 = 没换行。别拿 top 相等去比：
        // 小字号元素是垂直居中的，top 天然比行顶低几个像素。
        return {
          h: Math.round(rr.height),
          w: Math.round(rr.width),
          scrollW: row.scrollWidth,
          workflowToOptions: Math.round(kids[1].left - kids[0].right),
          inside: kids.every((r) => r.top >= rr.top - 1 && r.bottom <= rr.bottom + 1),
          // 生成按钮的右边缘不能越过参数条（越了就是溢出到面板外面）
          fits: kids.every((r) => r.right <= rr.right + 1 && r.left >= rr.left - 1),
        };
      })(),
      buttons: bar ? [...bar.querySelectorAll('[data-of]')].map((b) => b.dataset.of) : [],
      labels: bar ? ['wf', 'opts', 'cancel'].map((k) => (btn(k) || {}).textContent.trim()) : [],
      read: bar ? bar.querySelector('.of-read').textContent.trim() : '',
      // 「完成」已经取消：收起扩图只走「取消」，烘像素交给「生成」
      noDone: !(bar && bar.querySelector('[data-op="done"]')),
      anchors: [...sel.querySelectorAll('.ch')].map((c) => c.dataset.anchor).sort(),
      stage: [Math.round(st.width), Math.round(st.height)],
      img: [Math.round(im.width), Math.round(im.height)],
      bands: [...el.querySelectorAll('.op-bands i')].length,
      // 工具条不再让位：边框就在节点上，不占一层浮层
      toolsShown: !document.getElementById('imgTools').classList.contains('hidden'),
      toolOn: document.querySelector('#imgTools [data-tool="outpaint"]').classList.contains('on'),
      noModal: !document.getElementById('outpaintMask'),
    };
  })()`);
  check('点「扩图」→ 节点图上直接长出八个锚点（没有独立弹层），工具条亮着但不躲',
    outUi.open && outUi.onNode && outUi.anchors.join('/') === 'e/n/ne/nw/s/se/sw/w'
      && outUi.toolsShown && outUi.toolOn && outUi.noModal,
    JSON.stringify(outUi));
  check('扩图沿用生成面板的操作区、提示词框和状态行，隐藏无关操作',
    outUi.onNode && outUi.inFlow === 'static' && outUi.sharedUi,
    JSON.stringify({ onNode: outUi.onNode, pos: outUi.inFlow, sharedUi: outUi.sharedUi }));
  check('扩图底栏整合工作流、参数和取消，工作流显示图标',
    outUi.buttons.join('/') === 'wf/opts/cancel'
      && outUi.labels[2] === '取消' && outUi.noDone
      && outUi.labels[0].length > 0 && /·/.test(outUi.labels[1]),
    JSON.stringify({ buttons: outUi.buttons, labels: outUi.labels }));
  check('扩图参数栏复用生成按钮，取消紧贴在生成按钮左侧',
    outUi.rows.join('|') === 'of-read|gen-control-row of-row of-params'
      && outUi.hasInput && outUi.inputTag === 'DIV'
      && outUi.inputVal === outUi.panelPrompt
      && outUi.runInBar && outUi.statusInRow && outUi.cancelBeforeRun,
    JSON.stringify({ rows: outUi.rows, tag: outUi.inputTag, input: outUi.inputVal.slice(0, 18),
      panel: String(outUi.panelPrompt).slice(0, 18),
      run: outUi.runInBar, status: outUi.statusInRow, cancel: outUi.cancelBeforeRun }));
  check('面板退到画布外框下沿外面（不压住新扩出来的地方），横向对着外框中线',
    outUi.frameGap >= 8 && Math.abs(outUi.frameDx) <= 2,
    JSON.stringify({ gap: outUi.frameGap, dx: outUi.frameDx }));
  // 工作流名 + 读数变长时，生成按钮不能被挤到下一行。
  // 参数行现在是 nowrap + 能截断的各自截断，所以：同一行、且都不越出这一条。
  check('参数行是单行：工作流 / 尺寸 / 分辨率 / 张数 / 读数 / 取消 / 生成 都在同一行，不溢出',
    !!outUi.paramRow && outUi.paramRow.inside && outUi.paramRow.fits
      && outUi.paramRow.h < 34 && outUi.paramRow.scrollW <= outUi.paramRow.w + 1,
    JSON.stringify(outUi.paramRow));
  check('扩图参数紧贴工作流按钮，中间不留大块空白',
    !!outUi.paramRow && outUi.paramRow.workflowToOptions >= 0
      && outUi.paramRow.workflowToOptions <= 8,
    JSON.stringify(outUi.paramRow));
  // 状态独占一行；读数变长时，底栏仍保持单行。
  const paramLong = await page.evaluate(`(() => {
    const row = document.querySelector('.node.selected .of-params');
    const read = document.querySelector('.op-bar .of-read');
    const oldRead = read.textContent;
    read.textContent = '1056 × 1216 → 1648 × 1216';
    const rr = row.getBoundingClientRect();
    const kids = [...row.children].map((c) => c.getBoundingClientRect());
    const out = {
      inside: kids.every((r) => r.top >= rr.top - 1 && r.bottom <= rr.bottom + 1),
      fits: kids.every((r) => r.right <= rr.right + 1),
      h: Math.round(rr.height),
      scrollW: row.scrollWidth, w: row.clientWidth,
    };
    read.textContent = oldRead;
    return out;
  })()`);
  check('读数变长时，参数行仍然单行、不把生成按钮挤到下一行',
    paramLong.inside && paramLong.fits && paramLong.h < 34
      && paramLong.scrollW <= paramLong.w + 1,
    JSON.stringify(paramLong));
  check('刚打开时边框和原图一样大（还没扩），尺寸档报「原图」、读数是「原图 → 画布」',
    outUi.stage[0] === outUi.img[0] && outUi.stage[1] === outUi.img[1] && outUi.bands === 0
      && outUi.labels[1].startsWith('原图 ·')
      && /\d+ × \d+\s+→\s+\d+ × \d+/.test(outUi.read),
    JSON.stringify({ stage: outUi.stage, img: outUi.img, size: outUi.labels[1], read: outUi.read }));

  // 扩图参数复用生成面板的图形化分组弹层。
  const openOf = (k) => page.evaluate(`document.querySelector('.op-bar [data-of="${k}"]').click()`);
  const pickRatio = (label) => page.evaluate(`(() => {
    const b = [...document.querySelectorAll('.popmenu.gen-opts .go-ratio')].find((x) => x.dataset.value === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const clickChip = async (label) => {
    await openOf('opts');
    await new Promise((r) => setTimeout(r, 250));
    if (!await pickRatio(label)) throw new Error(`画幅网格里没有「${label}」`);
  };
  await openOf('opts');
  const outOptions = await page.evaluate(`(() => {
    const menu = document.querySelector('.popmenu.gen-opts');
    if (!menu) return null;
    return {
      titles: [...menu.querySelectorAll('.go-title')].map((x) => x.textContent),
      ratioCount: menu.querySelectorAll('.go-ratios .go-ratio').length,
      glyphCount: menu.querySelectorAll('.go-ratios .go-ratio i').length,
      resolutionCount: menu.querySelectorAll('.go-sec:nth-child(2) .go-seg button').length,
      batchCount: menu.querySelectorAll('.go-sec:nth-child(3) .go-seg button').length,
      foot: menu.querySelector('.go-foot')?.textContent,
    };
  })()`);
  check('扩图参数用画幅图形网格和分辨率、张数按钮组',
    !!outOptions && outOptions.titles.join('/') === '画幅/分辨率/张数'
      && outOptions.ratioCount === 8 && outOptions.glyphCount === 5
      && outOptions.resolutionCount === 3 && outOptions.batchCount === 3
      && /\d+ × \d+ → \d+ × \d+/.test(outOptions.foot), JSON.stringify(outOptions));
  await openOf('opts');
  await clickChip('16:9');
  await new Promise((r) => setTimeout(r, 300));
  const outWide = await page.evaluate(`(() => {
    const el = document.querySelector('.node.selected');
    const st = el.querySelector('.op-stage').getBoundingClientRect();
    const im = el.querySelector('.op-stage img').getBoundingClientRect();
    return { stage: [Math.round(st.width), Math.round(st.height)],
             img: [Math.round(im.width), Math.round(im.height)],
             bands: [...el.querySelectorAll('.op-bands i')].length,
             read: document.querySelector('.op-bar .of-read').textContent.trim(),
             onChip: document.querySelector('.op-bar [data-of="opts"]').textContent.trim() };
  })()`);
  check('选 16:9 → 舞台变横（原图只占中间一条），左右两条新边亮出来，悬浮条上的尺寸档跟着变',
    outWide.stage[0] > outWide.stage[1] && outWide.stage[0] > outWide.img[0]
      && outWide.bands === 2 && outWide.onChip.startsWith('16:9 ·'),
    JSON.stringify(outWide));

  // 拖右边那个锚点：画布只在右侧变宽，左边那条边纹丝不动（这就是「自定义尺寸」的意义，
  // 也是它和比例档的区别——比例档只能两边对称地长）。
  // 用合成 PointerEvent 而不是真鼠标：夹具只有 16×16，原图铺满缩略图时一个屏幕像素
  // 只值 1/26 个原图像素，真鼠标往右 200px 才走半格（画布宽度压根不变，看着像「拖了没反应」）；
  // 合成事件可以拖 600px，不受视口边界限制。
  const eastAt = await page.center('.node.selected .op-sel .ch.e');
  const before = await page.evaluate(`(() => {
    const el = document.querySelector('.node.selected');
    const st = el.querySelector('.op-stage').getBoundingClientRect();
    const im = el.querySelector('.op-stage img').getBoundingClientRect();
    return { l: Math.round(im.left - st.left), r: Math.round(st.right - im.right),
             stageW: Math.round(st.width), imgW: Math.round(im.width),
             thumbW: Math.round(el.querySelector('.thumb').getBoundingClientRect().width),
             size: document.querySelector('.op-bar .of-read').textContent.trim(),
             opt: (el.querySelector('.go-sum') || {}).textContent || '' };
  })()`);
  await page.evaluate(`(() => {
    const el = document.querySelector('.node.selected .op-sel .ch.e');
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x0, clientY: y0 }));
    for (let i = 1; i <= 20; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x0 + i * 30, clientY: y0 }));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x0 + 600, clientY: y0 }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const after = await page.evaluate(`(() => {
    const el = document.querySelector('.node.selected');
    const st = el.querySelector('.op-stage').getBoundingClientRect();
    const im = el.querySelector('.op-stage img').getBoundingClientRect();
    const br = document.querySelector('.op-bar').getBoundingClientRect();
    const pr = el.querySelector('.gen-panel').getBoundingClientRect();
    const tb = document.getElementById('imgTools').getBoundingClientRect();
    return { l: Math.round(im.left - st.left), r: Math.round(st.right - im.right),
             stageW: Math.round(st.width), imgW: Math.round(im.width),
             thumbW: Math.round(el.querySelector('.thumb').getBoundingClientRect().width),
             size: document.querySelector('.op-bar .of-read').textContent.trim(),
             opt: (el.querySelector('.go-sum') || {}).textContent || '',
             onChip: document.querySelector('.op-bar [data-of="opts"]').textContent.trim(),
             // 工具条贴的是**画布外框**（.op-stage），不是缩略图：外框比图宽出去之后，
             // 还按缩略图居中就会「悬在框上方偏左」（用户截图里的那个样子）
             toolsDx: Math.round((tb.left + tb.width / 2) - (st.left + st.width / 2)),
             toolsGap: Math.round(st.top - tb.bottom),
             toolsPlace: document.getElementById('imgTools').dataset.place,
             toolsClamped: tb.left <= 11 || tb.right >= window.innerWidth - 11,
             // 面板也贴着这块外框：外框往下长多少，面板就往下退多少
             frameGap: Math.round(pr.top - st.bottom),
             frameDx: Math.round((pr.left + pr.width / 2) - (st.left + st.width / 2)),
             panelClamped: pr.bottom >= window.innerHeight - 65,
             // 参数条还在自己这个面板里（不是跑到屏幕角落去了）
             barInPanel: br.top >= pr.top - 1 && br.bottom <= pr.bottom + 1
               && br.left >= pr.left - 1 && br.right <= pr.right + 1 };
  })()`);
  // 屏幕像素不能直接比：画布一变宽，同一个「左边几像素」对应的原图像素就变了。
  // 按各自的缩放换算回原图像素，才是「这条边到底动没动」。
  const nat = (o) => {
    const m = /(\d+) × (\d+) → (\d+) × (\d+)/.exec(o.size);
    const nw = m ? Number(m[3]) : 0;
    const k = nw && o.stageW ? nw / o.stageW : 1;
    return { l: Math.round(o.l * k), r: Math.round(o.r * k), nw };
  };
  const nBefore = nat(before), nAfter = nat(after);
  check('拖右边锚点 → 只有右边变宽（左边一个像素都不动），尺寸档改口叫「自定义」',
    !!eastAt && nAfter.r > nBefore.r + 8 && nAfter.l === nBefore.l
      && after.size !== before.size && after.onChip.startsWith('自定义 ·'),
    JSON.stringify({ before: nBefore, after: nAfter, size: [before.size, after.size], chip: after.onChip }));
  // 这条是用户原话「图片大小固定不变」的直接回归：扩图应该是**画布长出去**，
  // 不是把画布塞满缩略图、让原图往里缩（那样拖了看着只是「图被压扁」）。
  check('拖锚点只让画布往外长：原图和缩略图的尺寸一个像素都不变，画布真的比它们宽',
    after.imgW === before.imgW && after.thumbW === before.thumbW
      && after.stageW > after.thumbW + 20,
    JSON.stringify({ imgW: [before.imgW, after.imgW], thumbW: [before.thumbW, after.thumbW],
      stageW: [before.stageW, after.stageW] }));
  // 画布拖到溢出视口，参数条还得在自己的面板里（不是被甩到屏幕角落）
  check('画布拖到溢出视口，参数条仍在自己这个节点的面板里',
    after.barInPanel === true, JSON.stringify({ barInPanel: after.barInPanel }));
  // 工具条是「贴着选中节点」的浮层，扩图时那个节点真正的外形是画布外框：
  // 外框往右长出去之后，还按缩略图居中就会整条偏到左边（用户截图里「悬在框上方偏左」）。
  // 被视口夹住是允许的（外框自己都溢出屏幕了）；节点本来就贴着屏幕上方时它会压在自己图上，
  // 那种情况（place=over）只要求横向仍然对着外框中线。
  check('扩图后工具条跟着画布外框居中（不是跟着缩略图）',
    Math.abs(after.toolsDx) <= 2 || after.toolsClamped,
    JSON.stringify({ dx: after.toolsDx, gap: after.toolsGap, place: after.toolsPlace,
      clamped: after.toolsClamped, stageW: after.stageW, thumbW: after.thumbW }));
  // 和工具条同一条规矩：外框长出去了，面板也要跟着退（不是钉在节点下沿）
  check('拖完锚点，面板仍贴在外框下沿外面、并对着外框中线（放不下才被视口夹住）',
    (after.frameGap >= 8 || after.panelClamped) && Math.abs(after.frameDx) <= 2,
    JSON.stringify({ gap: after.frameGap, dx: after.frameDx, clamped: after.panelClamped }));

  // 「无法跟随」的直接回归：画布一平移，参数条要和节点一起走（相对位置不变）。
  // 之前它是屏幕坐标的浮条，节点拖到哪儿它都钉在原地，用户的原话就是「无法跟随」。
  // 用中键拖（button 1）平移画布，不用拖节点：拖节点会往撤销栈里压一条，
  // 后面「撤销一次回到扩图前」就退不到扩图之前了。
  const opFollow = await page.evaluate(`(async () => {
    const el = document.querySelector('.node.selected');
    const st = document.getElementById('stage');
    const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true };
    const at = (dx, dy) => ({ ...base, button: 1, buttons: 4, clientX: 700 + dx, clientY: 300 + dy });
    const raf = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const sample = () => {
      const n = el.getBoundingClientRect();
      const b = document.querySelector('.op-bar').getBoundingClientRect();
      return { node: [Math.round(n.left), Math.round(n.top)],
               rel: [Math.round(b.left - n.left), Math.round(b.top - n.top)] };
    };
    st.dispatchEvent(new PointerEvent('pointerdown', at(0, 0)));
    await raf();
    const s0 = sample();
    window.dispatchEvent(new PointerEvent('pointermove', at(60, 40)));
    await raf();
    const s1 = sample();
    window.dispatchEvent(new PointerEvent('pointerup', at(60, 40)));
    await raf();
    return { s0, s1 };
  })()`);
  check('平移画布时参数条跟着节点一起走（相对节点的位置不变，不是钉在屏幕上）',
    opFollow.s1.node[0] === opFollow.s0.node[0] + 60
      && opFollow.s1.node[1] === opFollow.s0.node[1] + 40
      && Math.abs(opFollow.s1.rel[0] - opFollow.s0.rel[0]) <= 2
      && opFollow.s1.node[1] + opFollow.s1.rel[1] > opFollow.s0.node[1] + opFollow.s0.rel[1]
      && opFollow.s1.node[1] + opFollow.s1.rel[1] <= opFollow.s0.node[1] + opFollow.s0.rel[1] + 40,
    JSON.stringify(opFollow));

  check('拖的同时面板里的尺寸胶囊跟着变（不是等生成完才改）',
    after.opt !== before.opt && /^自定义 · [^·]+ · \d+张$/.test(after.onChip),
    JSON.stringify({ before: before.opt, after: after.opt }));

  // 拖完点回 16:9：尺寸回到对称，后面烘出来的画布才有确定预期
  await clickChip('16:9');
  await new Promise((r) => setTimeout(r, 300));
  // 提示词输入框改的是 n.gen.prompt **本身**（不是另存一份给扩图用）：生成时读的就是它。
  // 这里写进去、点生成、等框收起来，大提示词框里应该原样是这串字——串起来才算真的接上了。
  const OP_PROMPT_E2E = 'E2E 扩图提示词：两边补成雪原';
  const promptIn = await page.evaluate(`(() => {
    const inp = document.querySelector('.node.selected .gen-prompt');
    if (!inp) return null;
    inp.textContent = ${JSON.stringify(OP_PROMPT_E2E)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { value: inp.textContent };
  })()`);
  check('参数条里的输入框改的就是这条节点的提示词本身（不是给扩图另存一份）',
    !!promptIn && promptIn.value === OP_PROMPT_E2E,
    JSON.stringify(promptIn));

  // 生成这条路会把图丢给 ComfyUI：e2e 不碰真机（会把用户的显卡占住），
  // 只把 /api/run 挡掉——要验的「烘焙」发生在发请求之前。
  // 请求体顺手存下来：扩图**不再就地改节点**，撑大的画布只存在于这一份提交里，
  // 不看请求体就没法证明「送进去的是 32×16、不是 16×16」。
  await page.evaluate(`(() => {
    window.__runBodies = [];
    window.__uploadedImageDims = {};
    window.__realFetch = window.fetch;
    window.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('/api/upload')) {
        const file = o && o.body && o.body.get('image');
        const bitmap = file ? await createImageBitmap(file) : null;
        const name = file && file.name || 'e2e-outpaint.png';
        if (bitmap) {
          window.__uploadedImageDims[name] = { w: bitmap.width, h: bitmap.height };
          bitmap.close();
        }
        return new Response(JSON.stringify({ ok: true, image: name, subfolder: '', type: 'input' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/analyze')) {
        const body = JSON.parse(o.body);
        const slots = Object.entries(body.graph || {}).flatMap(([node, nd]) => {
          if (!nd || nd.class_type !== 'LoadImage' || !nd.inputs || !('image' in nd.inputs)) return [];
          return [{ key: String(node) + '.image', node, input: 'image', kind: 'image', class_type: nd.class_type }];
        });
        return new Response(JSON.stringify({ ok: true, slots, autogrow: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/run')) {
        try { window.__runBodies.push(JSON.parse(o.body).graph); } catch { window.__runBodies.push(null); }
        return new Response(JSON.stringify({ ok: true, prompt_id: 'e2e-outpaint' }), { status: 200 });
      }
      // 轮询也一起挡掉：真去查这个假 pid 会判「任务丢失」→ 触发自动重试 →
      // 重试时扩图框正开着、pad 还是 0，bakeOutpaint 会把框收掉（no-op 分支），
      // 后面的用例就全乱了。这里直接回「跑完了、没有产物」。
      if (url.includes('/api/job')) {
        return new Response(JSON.stringify({ ok: true, status: 'done', artifacts: [] }), { status: 200 });
      }
      return window.__realFetch(u, o);
    };
  })()`);
  await page.evaluate(`document.querySelector('.node.selected .gen-run').click()`);
  await page.waitFor(`!document.querySelector('.node.selected .op-sel')`, 8000).catch(() => null);
  await new Promise((r) => setTimeout(r, 800));
  const outRes = await page.evaluate(`(async () => {
    const el = document.querySelector('.node.selected');
    const im = el.querySelector('.thumb img');
    // 这一轮真正提交上去的图：只有请求体里看得到（节点上留的是原图）。
    // 尺寸不能从图里读 width/height 插槽——krea2 局部重绘**没有**这两个插槽，
    // 画布多大完全由送进去的那张图决定。所以按文件名把上传的图拉回来量。
    const bodies = window.__runBodies || [];
    const g = bodies[bodies.length - 1] || {};
    const sentLoads = Object.values(g).filter((nd) => nd && nd.class_type === 'LoadImage')
      .map((nd) => nd.inputs && nd.inputs.image).filter(Boolean);
    const sent = sentLoads.map((name) => ({ name, ...(window.__uploadedImageDims[name] || { w: 0, h: 0 }) }));
    // 这里**不**把 fetch 还回去：轮询还在跑，还回去就会查到真服务端、判任务丢失、触发自动重试
    return {
      n: document.querySelectorAll('#nodes .node').length,
      title: ((el.querySelector('.n-name') || {}).textContent || ''),
      dim: ((el.querySelector('.n-dim') || {}).textContent || ''),
      pill: ((el.querySelector('.n-mask') || {}).textContent || ''),
      opt: ((el.querySelector('.go-sum') || {}).textContent || ''),
      w: im ? im.naturalWidth : 0, h: im ? im.naturalHeight : 0,
      frameGone: !el.querySelector('.op-sel'),
      wf: (el.querySelector('.gensel.wfsel .gm-btn') || {}).textContent || '',
      prompt: (el.querySelector('.gen-prompt') || {}).textContent || '',
      sent,
    };
  })()`);
  check('点生成 → 原图原地不动（不覆盖、不塞遮罩），边框收起，走局部重绘',
    outRes.n === toolBase + 2 && outRes.w === 16 && outRes.h === 16 && !outRes.pill
      && outRes.frameGone && /局部重绘/.test(outRes.wf),
    JSON.stringify(outRes));
  // 这是这次改动的核心：撑大的画布不再写回节点，只作为**这一轮的源图**提交上去。
  // 16×16 按 16:9 扩 → 32×16（和上面 outpaintSize 的用例同一套算法）。
  check('送进模型的是撑大的画布（上传的那张图 32×16，不是节点上的 16×16）',
    outRes.sent.length >= 1 && outRes.sent.every((s) => s.w === 32 && s.h === 16),
    JSON.stringify(outRes.sent));
  check('面板里的尺寸档和图片尺寸一致（扩完收起来，面板还回原图那套）',
    /^1:1 · 1K( · \d+张)?$/.test(outRes.opt) && outRes.dim === '16 × 16',
    JSON.stringify({ opt: outRes.opt, dim: outRes.dim, img: [outRes.w, outRes.h] }));
  check('在参数条里写的提示词跟着进了正式提示词框（生成读的就是这一份）',
    outRes.prompt.includes(OP_PROMPT_E2E),
    JSON.stringify({ prompt: outRes.prompt.slice(0, 40) }));

  // 这一跑是假的（/api/run 和轮询都被挡掉了），节点会 busy 到轮询回来为止。
  // 必须等它落地：后面还有好几处「点生成」，busy 没清掉就会被静默吞掉（真踩过）。
  await page.waitFor(`(() => { const b = document.querySelector('.node.selected .gen-run');
    return !!b && !b.disabled; })()`, 15000).catch(() => null);
  // 任务已经结束（job 被挡成 done），这时才把 fetch 还回去：早还一次，轮询就会查到
  // 真服务端 → 判「任务丢失」→ 自动重试，重试会在开着的扩图框上再跑一遍
  await page.evaluate(`window.fetch = window.__realFetch`);

  // 扩图**不再就地改图**（撑大的画布只进这一次提交，结果落到新节点），
  // 所以这里不需要撤销：后面那些遮罩用例要的「这张图没涂过」本来就是现状。
  // 反过来，这里要是还按老路子撤销一次，就会退到别的操作上，把后面的节点计数全带歪。
  const afterRun = await page.evaluate(`(() => {
    const el = document.querySelector('.node.selected');
    const im = el.querySelector('.thumb img');
    return { w: im ? im.naturalWidth : 0, h: im ? im.naturalHeight : 0,
             pill: !!el.querySelector('.n-mask'), opt: (el.querySelector('.go-sum') || {}).textContent || '' };
  })()`);
  check('生成后原图、尺寸档都还在原位（扩图不再就地改图，不用撤销）',
    afterRun.w === 16 && afterRun.h === 16 && !afterRun.pill && /1:1 · 1K/.test(afterRun.opt),
    JSON.stringify(afterRun));

  // ---- 扩图的工作流由用户说了算 ----
  // 早先扩图面板列的是**全部**工作流，但生成时 reconcileWorkflow 只认「吃遮罩」的，
  // 于是选了别的（比如 Qwen 图像编辑）一点生成就被换成局部重绘——用户的原话是
  // 「虽然可以选择工作流，但一旦点击生成就跳转到默认的工作流」。
  // 现在：下拉只列吃图的（前缀标出「遮罩 / 整图」两条路），选了谁就用谁。
  await page.evaluate(`document.querySelector('#imgTools [data-tool="outpaint"]').click()`);
  // 图刚重渲染完可能还没解码：实现里会等一次 load 自己重来，这里给足时间
  await page.waitFor(`!!document.querySelector('.node.selected .op-bar')`, 5000).catch(() => null);
  const opReopen = await page.evaluate(`(() => {
    const sel = document.querySelector('.node.selected');
    const bar = document.querySelector('.op-bar');
    const panel = sel && sel.querySelector('.gen-panel');
    const badge = document.getElementById('queueBadge');
    return {
      selected: sel ? sel.dataset.id : null,
      hasSel: !!document.querySelector('.op-sel'),
      barInSel: !!(sel && sel.querySelector('.op-bar')),
      barAnywhere: !!bar,
      panel: panel ? getComputedStyle(panel).display : 'none',
      toolsHidden: document.getElementById('imgTools').classList.contains('hidden'),
      toolOn: (document.querySelector('#imgTools [data-tool="outpaint"]') || {}).classList
        ? document.querySelector('#imgTools [data-tool="outpaint"]').classList.contains('on') : null,
      flash: badge && !badge.classList.contains('hidden') ? badge.textContent : '',
    };
  })()`);
  check('生成后原图还在，再点「扩图」照样能打开（能接着改、接着扩）',
    opReopen.hasSel && opReopen.barInSel, JSON.stringify(opReopen));
  const wfMenuPos = await page.evaluate(`(() => {
    const b = document.querySelector('.node.selected .op-bar [data-of="wf"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  })()`);
  if (wfMenuPos) await page.clickAt(wfMenuPos[0], wfMenuPos[1], { settle: 400 });
  const opWfMenu = await page.evaluate(`(() => ({
    title: (document.querySelector('.popmenu .popmenu-title') || {}).textContent || '',
    items: [...document.querySelectorAll('.popmenu button')].map((b) => b.textContent.trim()),
  }))()`);
  check('扩图的工作流下拉只列吃图的，并标出「遮罩 / 整图」两条路',
    /只列吃图的/.test(opWfMenu.title) && opWfMenu.items.length > 0
      && opWfMenu.items.every((t) => /^(遮罩|整图) · /.test(t))
      && opWfMenu.items.some((t) => t.startsWith('遮罩 · ')),
    JSON.stringify(opWfMenu));

  await page.evaluate(`[...document.querySelectorAll('.popmenu button')]
    .find((b) => b.textContent.trim().startsWith('整图')).click()`);
  await new Promise((r) => setTimeout(r, 400));
  const opPick = await page.evaluate(`(() => {
    const b = document.querySelector('.node.selected .op-bar [data-of="wf"]');
    const badge = document.getElementById('queueBadge');
    return {
      pick: b ? b.textContent.trim() : '',
      sel: document.querySelectorAll('.node.selected').length,
      panels: document.querySelectorAll('.gen-panel').length,
      bars: document.querySelectorAll('.op-bar').length,
      sels: document.querySelectorAll('.op-sel').length,
      imgW: (() => { const im = document.querySelector('.node.selected .thumb img');
        return im ? im.naturalWidth : 0; })(),
      flash: badge && !badge.classList.contains('hidden') ? badge.textContent : '',
    };
  })()`);
  check('选了「整图」那条，参数条上立刻显示它（不是还写着局部重绘）',
    !!opPick.pick && !/局部重绘/.test(opPick.pick), JSON.stringify(opPick));

  await page.evaluate(`(() => {
    const b = document.querySelector('.op-bar [data-of="opts"]');
    if (b) b.click();
  })()`);
  // 等菜单里真的出现那一项再点：固定 350ms 在慢机器上偶尔会点空，
  // 后面那条「点生成后还是选的工作流」就会因为尺寸没改而假红。
  await page.waitFor(`!!document.querySelector('.popmenu.gen-opts .go-ratio[data-value="16:9"]')`, 4000).catch(() => null);
  await pickRatio('16:9');
  await new Promise((r) => setTimeout(r, 500));
  // 这次让提交**直接失败**（不是返回假 prompt_id）：烘焙在提交之前就做完了，
  // 断言要看的全在那一步；而失败会让节点立刻退出 busy——
  // 留一个假任务在轮询里，后面「遮罩清掉后自动换工作流」那条用例点生成会被 busy 吞掉。
  await page.evaluate(`(() => {
    window.__runBodies = [];
    window.__uploadedImageDims = {};
    window.__realFetch = window.fetch;
    window.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('/api/upload')) {
        const file = o && o.body && o.body.get('image');
        const bitmap = file ? await createImageBitmap(file) : null;
        const name = file && file.name || 'e2e-outpaint-full.png';
        if (bitmap) {
          window.__uploadedImageDims[name] = { w: bitmap.width, h: bitmap.height };
          bitmap.close();
        }
        return new Response(JSON.stringify({ ok: true, image: name, subfolder: '', type: 'input' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/analyze')) {
        const body = JSON.parse(o.body);
        const slots = Object.entries(body.graph || {}).flatMap(([node, nd]) => {
          if (!nd || nd.class_type !== 'LoadImage' || !nd.inputs || !('image' in nd.inputs)) return [];
          return [{ key: String(node) + '.image', node, input: 'image', kind: 'image', class_type: nd.class_type }];
        });
        return new Response(JSON.stringify({ ok: true, slots, autogrow: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/run')) {
        try { window.__runBodies.push(JSON.parse(o.body).graph); } catch { window.__runBodies.push(null); }
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'e2e 不提交' }), { status: 200 }));
      }
      return window.__realFetch(u, o);
    };
  })()`);
  // 前面几条用例可能留着一个假任务在轮询：busy 期间点生成会被直接吞掉，
  // 于是「烘焙没做、尺寸没变」被误报成「工作流被换掉了」。等按钮能点再点。
  await page.waitFor(`(() => { const b = document.querySelector('.node.selected .gen-run');
    return !!b && !b.disabled; })()`, 15000).catch(() => null);
  await page.evaluate(`document.querySelector('.node.selected .gen-run').click()`);
  // 提交失败时边框**故意留着**（能接着调、不用重新拖），所以这里不再等它消失，
  // 只等这一轮跑完（busy 落地）
  await page.waitFor(`(() => { const b = document.querySelector('.node.selected .gen-run');
    return !!b && !b.disabled; })()`, 15000).catch(() => null);
  await new Promise((r) => setTimeout(r, 400));
  const opKeep = await page.evaluate(`(async () => {
    const el = document.querySelector('.node.selected');
    const im = el.querySelector('.thumb img');
    const bodies = window.__runBodies || [];
    const g = bodies[bodies.length - 1] || {};
    const sentLoads = Object.values(g).filter((nd) => nd && nd.class_type === 'LoadImage')
      .map((nd) => nd.inputs && nd.inputs.image).filter(Boolean);
    const sent = sentLoads.map((name) => ({ name, ...(window.__uploadedImageDims[name] || { w: 0, h: 0 }) }));
    window.fetch = window.__realFetch;
    return {
      wf: (el.querySelector('.gensel.wfsel .gm-btn') || {}).textContent || '',
      pill: (el.querySelector('.n-mask') || {}).textContent || '',
      w: im ? im.naturalWidth : 0, h: im ? im.naturalHeight : 0,
      frameOpen: !!el.querySelector('.op-sel'),
      sent,
    };
  })()`);
  check('点生成后用的还是选的那个工作流（不再被换成局部重绘），也不给节点硬塞遮罩',
    opKeep.wf === opPick.pick && !/遮罩/.test(opKeep.pill)
      && opKeep.w === 16 && opKeep.h === 16,
    JSON.stringify({ picked: opPick.pick, ...opKeep }));
  // 只吃图的工作流没有遮罩可写：撑大的画布靠「透明边」进模型。
  // 这条以前漏过——节点自己的图只在 picked 为空时才塞，一有别的参考图就把它丢了。
  check('整图流也把撑大的画布送进模型（上传的那张图 32×16，不是节点上的 16×16）',
    opKeep.sent.length >= 1 && opKeep.sent.every((s) => s.w === 32 && s.h === 16),
    JSON.stringify(opKeep.sent));
  check('提交失败时边框不收起（用户能接着调边框重试，不用重新拖一遍）',
    opKeep.frameOpen === true, JSON.stringify({ frameOpen: opKeep.frameOpen }));

  // 收尾：用「取消」把还留着的边框收起来。
  // 别再用撤销——扩图本身已经不压撤销记录了，退两次会退到更早的操作上（节点计数就歪了）。
  await page.evaluate(`(() => {
    const b = document.querySelector('.node.selected .op-bar [data-of="cancel"]');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const opCanceled = await page.evaluate(`(() => {
    const el = document.querySelector('.node.selected');
    const im = el.querySelector('.thumb img');
    return { frameGone: !el.querySelector('.op-sel'),
             w: im ? im.naturalWidth : 0, h: im ? im.naturalHeight : 0,
             opt: (el.querySelector('.go-sum') || {}).textContent || '' };
  })()`);
  check('「取消」收起边框：原图和尺寸档都不动',
    opCanceled.frameGone && opCanceled.w === 16 && opCanceled.h === 16
      && /1:1 · 1K/.test(opCanceled.opt),
    JSON.stringify(opCanceled));

  await selectImg();
  await new Promise((r) => setTimeout(r, 250));
  // 抠图：整张交给图像编辑，必须挑一个真吃图的工作流
  await page.evaluate(`document.querySelector('#imgTools [data-tool="cutout"]').click()`);
  await new Promise((r) => setTimeout(r, 700));
  const cutRes = await lastNode();
  check('点「抠图」→ 新建节点，提示词是「去掉背景」，工作流吃图',
    cutRes.n === toolBase + 3 && cutRes.title.startsWith('抠图')
      && /背景/.test(cutRes.prompt) && cutRes.wf && !/局部重绘/.test(cutRes.wf),
    JSON.stringify(cutRes));

  await selectImg();
  await new Promise((r) => setTimeout(r, 250));
  // 去字：同一个遮罩编辑器，涂完落到新节点上，遮罩跟着搬过去
  await page.evaluate(`document.querySelector('#imgTools [data-tool="detext"]').click()`);
  await new Promise((r) => setTimeout(r, 800));
  const detextOpen = await page.evaluate(`(() => {
    const ed = document.querySelector('#maskEditor');
    return { open: !!ed, title: ed ? (ed.querySelector('.me-title') || {}).textContent || '' : '',
             hint: ed ? (ed.querySelector('.me-hint') || {}).textContent || '' : '' };
  })()`);
  check('点「去字」→ 打开同一个遮罩编辑器，标题和提示都写明「去字」',
    detextOpen.open && /去字/.test(detextOpen.title) && /文字/.test(detextOpen.hint),
    JSON.stringify(detextOpen));
  const dRect = await page.evaluate(`(() => {
    const r = document.querySelector('#maskEditor .me-cv').getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  })()`);
  await page.drag(
    { x: dRect[0] + dRect[2] * 0.3, y: dRect[1] + dRect[3] * 0.4 },
    { x: dRect[0] + dRect[2] * 0.7, y: dRect[1] + dRect[3] * 0.5 },
    { steps: 8, settle: 150 });
  await page.click('#maskEditor [data-act="apply"]', { settle: 900 });
  const detextRes = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    const last = nodes[nodes.length - 1];
    return {
      n: nodes.length, title: ((last.querySelector('.n-name') || {}).textContent || ''),
      pill: !!last.querySelector('.n-mask'),
      ov: !!last.querySelector('.thumb .mask-ov'),
      prompt: (document.querySelector('.node.selected .gen-prompt') || {}).textContent || '',
      wf: (document.querySelector('.node.selected .gensel.wfsel .gm-btn') || {}).textContent || '',
    };
  })()`);
  check('去字：涂完应用 → 新建节点，遮罩跟着搬过去，工作流切到局部重绘',
    detextRes.n === toolBase + 4 && detextRes.title.startsWith('去字')
      && /文字/.test(detextRes.prompt) && detextRes.pill && detextRes.ov
      && /局部重绘/.test(detextRes.wf),
    JSON.stringify(detextRes));

  // 收尾：删掉这一批新节点，别挡住后面的遮罩用例
  await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#nodes .node')];
    nodes.slice(${toolBase}).forEach((el) => { const d = el.querySelector('.n-del'); if (d) d.click(); });
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  // ---- 工作流芯片的图标：选了哪份就画哪份的标 ----
  // 只换字不换标，会出现「写着 FLUX、前面还挂着 Krea 的标」——设置里刚设完时最刺眼。
  // 走真界面：设置里挑标 → 回画布选这份工作流 → 看芯片。
  // 上一节收尾把那批新节点删了，先重新选中那张原始图片节点把面板叫回来。
  await selectImg();
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(`(() => {
    const b = document.querySelector('.node.selected .n-gen, .node.selected [data-act="gen"]');
    const panel = document.querySelector('.node.selected .gen-panel');
    const hidden = !panel || getComputedStyle(panel).display === 'none';
    if (b && hidden) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(`document.querySelector('#projectBar [data-act="settings"]').click()`);
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(`(() => {
    const t = [...document.querySelectorAll('#setTabs .tab')].find((x) => /工作流/.test(x.textContent));
    if (t) t.click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('#appSettings #setWfList .wf-item')]
      .find((r) => r.dataset.id === 'lib:krea2-文生图.api');
    if (row) row.querySelector('.wf-ico-btn').click();
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('.icon-pop .icon-pick')].find((x) => /FLUX/.test(x.title));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(`(() => { const c = document.querySelector('.gen-panel .wfsel .gm-btn'); if (c) c.click(); })()`);
  await new Promise((r) => setTimeout(r, 400));
  // 下拉菜单里也要画标：选工作流时第一眼看的就是这份菜单。
  // 没设图标的项必须留一格透明占位，否则有标的缩进 32px、没标的只缩进 12px，一列文字参差。
  const menuIco = await page.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.popmenu button')];
    return { total: btns.length,
             withIco: btns.filter((b) => b.querySelector('.wf-ico:not(.is-empty)')).length,
             allPadded: btns.every((b) => b.classList.contains('has-ico')) };
  })()`);
  check('工作流下拉菜单里每项都带标（没设图标的留透明占位，文字左边缘对齐）',
    menuIco.total > 1 && menuIco.withIco >= 1 && menuIco.allPadded, JSON.stringify(menuIco));
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('.popmenu button')].find((x) => /krea2-文生图/.test(x.textContent));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const chipIco = await page.evaluate(`(() => {
    const c = document.querySelector('.gen-panel .wfsel');
    const img = c && c.querySelector('.gensel-icon .wf-ico img');
    return { src: img ? img.getAttribute('src') : '',
             cls: c && c.querySelector('.gensel-icon .wf-ico')
               ? c.querySelector('.gensel-icon .wf-ico').className : '' };
  })()`);
  check('生成面板的工作流芯片跟着换标（选 FLUX 就是 FLUX 的商标，不再是一颗通用图标）',
    /^\/logos\/flux\.png(\?v=\d+)?$/.test(chipIco.src) && /is-logo/.test(chipIco.cls),
    JSON.stringify(chipIco));
  // 清掉，别让后面「按分类默认 / 扩图选流」这些用例读到一份带标的库
  await page.evaluate(`(async () => {
    await fetch('/api/wf/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'lib:krea2-文生图.api', icon: '' }) });
  })()`);


  // ---- 遮罩编辑器：涂 → 存 → 重开精确还原 ----
  // 重点不是视觉细节，是三条口径：
  //   1) canvas 内部尺寸 = 原图像素（不是显示尺寸，否则笔尖细一半、导出的遮罩整体错位）
  //   2) 遮罩按「图片身份」索引，不挂在 gen 上（挂节点上时切一张图就错位）
  //   3) 存档只存笔画，重开靠重放还原（旧实现从导出的 PNG 反推蓝色，羽化后必然走样）
  await page.evaluate(`(() => {
    const el = document.querySelector('.node[data-id="${pick.img}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  // 先把工作流钉成「纯文生图」：这条用例测的是**连图都不吃**的工作流在打开编辑器时会被换掉。
  // 「只吃图不吃遮罩」的流不再换（它走裁切局部重绘），那条在下面单独测。
  const maskWfPinned = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = document.querySelector('[data-panel-for="${pick.img}"] .gensel.wfsel .gm-btn');
    if (!btn) return { missing: true };
    btn.click();
    await sleep(320);
    const hit = [...document.querySelectorAll('.popmenu button')]
      .find((b) => /文生图/.test(b.textContent) && !/局部重绘/.test(b.textContent));
    if (!hit) return { missing: true };
    hit.click();
    await sleep(320);
    const now = document.querySelector('[data-panel-for="${pick.img}"] .gensel.wfsel .gm-btn');
    return { now: now ? now.textContent.trim() : '' };
  })()`);
  check('把这张图的工作流钉成纯文生图（不吃图的那一类）',
    !maskWfPinned.missing && /文生图/.test(maskWfPinned.now), JSON.stringify(maskWfPinned));
  await page.click('#imgTools .it-btn[data-tool="mask"]', { settle: 450 });
  const maskOpen = await page.waitFor(`(() => {
    const cv = document.querySelector('#maskEditor .me-cv');
    const img = document.querySelector('#maskEditor .me-img');
    if (!cv || !img) return null;
    const r = cv.getBoundingClientRect();
    return { cv: [cv.width, cv.height], img: [img.naturalWidth, img.naturalHeight],
             rect: [r.left, r.top, r.width, r.height],
             tools: [...document.querySelectorAll('#maskEditor [data-tool]')].map((b) => b.textContent.trim()),
             cover: document.querySelector('#maskEditor .me-cover').textContent };
  })()`, 8000);
  check('点「遮罩」→ 全屏编辑器打开，canvas 内部尺寸 = 原图像素',
    !!maskOpen && maskOpen.cv[0] === maskOpen.img[0] && maskOpen.cv[1] === maskOpen.img[1],
    maskOpen ? `cv=${maskOpen.cv} img=${maskOpen.img}` : 'none');
  check('编辑器有画笔 / 橡皮，覆盖率从 0 开始',
    !!maskOpen && maskOpen.tools.join('/') === '画笔/橡皮' && /遮罩 0%/.test(maskOpen.cover),
    maskOpen ? `${maskOpen.tools.join('/')} ${maskOpen.cover}` : 'none');

  // 纯文生图的工作流连图都不吃：遮罩根本没地方落。以前这种情况按钮直接 disabled，
  // 用户只看到「点了没反应」。现在一律允许打开，并在打开时把工作流换成能吃图的那个。
  const wfSwitched = await page.evaluate(`(() => {
    const box = document.querySelector('[data-panel-for="${pick.img}"] .wfsel');
    const badge = document.getElementById('queueBadge');
    return { wf: box ? box.textContent.trim() : 'no-box',
             flash: badge && !badge.classList.contains('hidden') ? badge.textContent.trim() : '' };
  })()`);
  check('不吃图的工作流（纯文生图）：打开编辑器时自动换成「局部重绘」并说明',
    /局部重绘/.test(wfSwitched.wf) && /已换成/.test(wfSwitched.flash),
    JSON.stringify(wfSwitched));

  const [ml, mt, mw, mh] = maskOpen.rect;
  const strokeMask = () => page.drag(
    { x: ml + mw * 0.2, y: mt + mh * 0.5 },
    { x: ml + mw * 0.8, y: mt + mh * 0.5 },
    { steps: 8, settle: 150 });
  const maskPixels = () => page.evaluate(`(() => {
    const cv = document.querySelector('#maskEditor .me-cv');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let px = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) px++;
    return { px, cover: document.querySelector('#maskEditor .me-cover').textContent };
  })()`);

  await strokeMask();
  const maskDrawn = await maskPixels();
  check('在遮罩层上拖一笔，真的画上去了', maskDrawn && maskDrawn.px > 0, JSON.stringify(maskDrawn));

  await page.click('#maskEditor [data-act="undo"]', { settle: 200 });
  const maskUndone = await maskPixels();
  check('撤销清掉最后一笔', maskUndone && maskUndone.px === 0, JSON.stringify(maskUndone));

  await strokeMask();
  await page.click('#maskEditor [data-act="apply"]', { settle: 450 });
  const maskPill = await page.evaluate(`document.querySelector('.node[data-id="${pick.img}"] .n-mask')?.textContent || ''`);
  check('应用后节点标题出现「遮罩 N%」药丸', /遮罩 \d+%/.test(maskPill), maskPill);

  // 光有药丸不够：用户要能直接看出「哪一块会被重绘」。
  // 预览层和图片同框（框=图片比例、图片铺满框），所以 canvas 100%×100% 必须像素级对齐。
  const ovSample = () => page.evaluate(`(() => {
    const ov = document.querySelector('.node[data-id="${pick.img}"] .thumb .mask-ov');
    if (!ov) return null;
    const im = document.querySelector('.node[data-id="${pick.img}"] .thumb img');
    const d = ov.getContext('2d').getImageData(Math.round(ov.width / 2), Math.round(ov.height / 2), 1, 1).data;
    const r = ov.getBoundingClientRect();
    const ir = im ? im.getBoundingClientRect() : null;
    return { px: [d[0], d[1], d[2], d[3]], cv: [ov.width, ov.height],
             box: [Math.round(r.width), Math.round(r.height)],
             img: ir ? [Math.round(ir.width), Math.round(ir.height)] : null };
  })()`);
  const ov0 = await ovSample();
  check('应用后节点图上直接看得到遮罩预览（不用点开编辑器）',
    !!ov0 && ov0.px[3] > 0, JSON.stringify(ov0));
  check('预览层和图片同尺寸（错位就是从这一步开始歪的）',
    !!ov0 && !!ov0.img && ov0.box[0] === ov0.img[0] && ov0.box[1] === ov0.img[1],
    ov0 ? `box=${ov0.box} img=${ov0.img}` : 'none');

  await page.click(`.node[data-id="${pick.img}"] .n-mask`, { settle: 550 });
  const maskBack = await page.waitFor(`(() => {
    const cv = document.querySelector('#maskEditor .me-cv');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let px = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) px++;
    return { px, cover: document.querySelector('#maskEditor .me-cover').textContent };
  })()`, 8000);
  check('点药丸重开：笔画原样还原', !!maskBack && maskBack.px > 0, JSON.stringify(maskBack));

  // 颜色 / 透明度只影响「看得见」，不进 alpha——但必须真的能改，且立刻生效。
  const edPixel = () => page.evaluate(`(() => {
    const cv = document.querySelector('#maskEditor .me-cv');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(Math.round(cv.width / 2), Math.round(cv.height / 2), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  })()`);
  const paintUi = await page.evaluate(`(() => {
    const root = document.querySelector('#maskEditor');
    return { sw: root.querySelectorAll('.me-sw').length,
             custom: !!root.querySelector('.me-custom input[type="color"]'),
             alpha: !!root.querySelector('.me-alpha') };
  })()`);
  check('编辑器有画笔颜色（色块 + 取色器）和透明度',
    paintUi.sw >= 4 && paintUi.custom && paintUi.alpha, JSON.stringify(paintUi));

  const pxBefore = await edPixel();
  await page.click('#maskEditor .me-sw[data-color="#ff5c8a"]', { settle: 250 });
  const pxAfter = await edPixel();
  check('换颜色：预览笔画当场换色（只是显示，不写进 alpha）',
    !!pxAfter && pxAfter[0] > 200 && pxAfter[1] < 140 && pxAfter[2] > 90 && pxAfter[3] > 0,
    `${JSON.stringify(pxBefore)} → ${JSON.stringify(pxAfter)}`);

  await page.evaluate(`(() => {
    const el = document.querySelector('#maskEditor .me-alpha');
    el.value = 100;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const pxOpaque = await edPixel();
  check('透明度可调：拉到 100% 时预览完全不透明', !!pxOpaque && pxOpaque[3] === 255, JSON.stringify(pxOpaque));

  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 300));
  check('Esc 关闭编辑器', (await page.evaluate(`!document.querySelector('#maskEditor')`)) === true);

  // 颜色是全局偏好：关掉编辑器之后，节点上的预览也该是新颜色（不能等重开才变）
  const ov1 = await ovSample();
  check('节点上的遮罩预览跟着换成新颜色',
    !!ov1 && ov1.px[0] > 200 && ov1.px[1] < 140 && ov1.px[3] > 0, JSON.stringify(ov1));

  await new Promise((r) => setTimeout(r, 1400));   // 存档有防抖
  // 不按 projId 读：前面的用例可能切过画布，直接扫一遍数据目录找带遮罩的那个节点
  let maskNode = null;
  for (const f of fs.readdirSync(path.join(dataDir, 'projects')).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', f), 'utf8'));
    const hit = (d.nodes || []).find((n) => n.id === pick.img && n.masks && Object.keys(n.masks).length);
    if (hit) { maskNode = hit; break; }
  }
  const maskKeys = maskNode ? Object.keys(maskNode.masks) : [];
  const maskDoc = maskKeys.length ? maskNode.masks[maskKeys[0]] : null;
  check('遮罩按图片身份存进 masks（不是节点级 gen.mask）',
    maskKeys.length === 1 && !((maskNode || {}).gen || {}).mask, maskKeys.join(','));
  check('存档只存笔画，不存位图',
    !!maskDoc && Array.isArray(maskDoc.strokes) && !maskDoc.png && !maskDoc.url,
    maskDoc ? Object.keys(maskDoc).join(',') : 'none');
  // 遮罩编辑器把工作流换成了「局部重绘」，这个选择必须真的落盘——
  // 只在内存里换的话，刷新一次节点又变回「未选择工作流」，用户涂的遮罩白费。
  const maskGen = (maskNode || {}).gen || {};
  check('遮罩编辑器换上的「局部重绘」落盘了',
    /局部重绘/.test(String(maskGen.wf || '')),
    JSON.stringify({ wf: maskGen.wf }));

  // 清掉，别影响后面的用例
  await page.evaluate(`(() => {
    const n = document.querySelector('.node[data-id="${pick.img}"] .n-mask');
    if (n) n.click();
    return true;
  })()`);
  await page.waitFor(`!!document.querySelector('#maskEditor [data-act="clear"]')`, 5000);
  await page.click('#maskEditor [data-act="clear"]', { settle: 150 });
  await page.click('#maskEditor [data-act="apply"]', { settle: 400 });

  // 反向也要对：遮罩清掉了，工作流还挂在「局部重绘」上。它的 mask 来自图片 alpha，
  // 普通图 alpha 全不透明 → mask 全 0 → 什么都不改，出图跟原图逐位相同。
  // 用户只会看到「生成成功，图没变」，这是最难自查的一类坏。自动挑的应该自己换回来。
  const mTitle = await page.center(`#nodes .node[data-id="${pick.img}"] .node-title`);
  await page.clickAt(mTitle.x, mTitle.y, { settle: 350 });
  const wfBack = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const hits = [];
    window.fetch = async (url, opts) => {
      const u = String(url);
      // 取工作流走 /api/wf/resolve（文件名可变，不能直接拼库文件名），
      // 所以两边都记：断言关心的是「挑的是哪个工作流」，不是它从哪个 URL 取。
      if (u.startsWith('/api/library/')) hits.push(decodeURIComponent(u));
      if (u.startsWith('/api/wf/resolve')) {
        const id = new URL(u, location.origin).searchParams.get('id') || '';
        hits.push('resolve:' + decodeURIComponent(id));
      }
      if (u.startsWith('/api/run')) return json({ ok: true, prompt_id: 'wf-back' });
      if (u.startsWith('/api/analyze')) return json({ ok: true, slots: [] });
      if (u.startsWith('/api/upload')) return json({ ok: false, error: 'offline' });
      // 只糊自己这个任务：别的 pid 一律走真实请求
      if (u.startsWith('/api/job')) {
        return u.includes('wf-back')
          ? json({ ok: true, status: 'success', progress: 100, artifacts: [] })
          : real(url, opts);
      }
      return real(url, opts);
    };
    const ta = document.querySelector('[data-panel-for="${pick.img}"] .gen-prompt');
    if (ta) {
      ta.focus();
      document.execCommand('insertText', false, 'a cat');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const run = document.querySelector('[data-panel-for="${pick.img}"] .gen-run');
    if (run) run.click();
    for (let k = 0; k < 80 && !hits.length; k++) await sleep(100);
    // 让这个假任务在自己的桩还生效时收尾，别把轮询带出去干扰后面的用例
    for (let k = 0; k < 20; k++) {
      const st = document.querySelector('[data-panel-for="${pick.img}"] .gen-status');
      if (st && /完成|失败|错误/.test(st.textContent)) break;
      await sleep(100);
    }
    window.fetch = real;
    const box = document.querySelector('[data-panel-for="${pick.img}"] .wfsel');
    const st = document.querySelector('[data-panel-for="${pick.img}"] .gen-status');
    const runBtn = document.querySelector('[data-panel-for="${pick.img}"] .gen-run');
    const pr = document.querySelector('[data-panel-for="${pick.img}"] .gen-prompt');
    return { hits, wf: box ? box.textContent.trim() : '',
             status: st ? st.textContent : '', busy: !!(runBtn && runBtn.disabled),
             prompt: pr ? String(pr.value != null ? pr.value : pr.textContent).slice(0, 40) : '(no prompt)' };
  })()`);
  check('遮罩清掉后不会再用「局部重绘」跑（否则出图跟原图逐位相同）',
    wfBack.hits.length > 0 && !wfBack.hits.some((h) => /局部重绘/.test(h)),
    JSON.stringify(wfBack));

  // ---- 遮罩 + 「只吃图不吃遮罩」的工作流：裁切局部重绘 ----
  // Qwen-Image-Edit 这类流的 4 个 LoadImage 全接在参考图插槽（images.image_1..4）上，
  // 没有任何节点消费 LoadImage 的 MASK 输出，服务端因此判它 takes_alpha_mask=false。
  // 以前这种流一涂遮罩就被静默换成「Krea2 · 局部重绘」——用户看到的是「我选的流一点生成就跳走」。
  // 现在不换流：把涂到的范围裁出来单独跑一次，出图再缩放贴回原位（羽化融合）。
  // 这里用一张 480×320 的四象限色块图，因为「裁剪框算错」只有靠取样颜色才看得出来。
  const cropBase = await page.evaluate(`(async () => {
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    // ComfyUI 没开：上传必然失败。当场判失败，别让整条链路等它超时。
    window.fetch = async (u, o) => (String(u).startsWith('/api/upload') ? json({ ok: false, error: 'offline' }) : real(u, o));
    const beforeIds = [...document.querySelectorAll('#nodes .node')].map((e) => e.dataset.id);
    try {
      const cv = document.createElement('canvas');
      cv.width = 480; cv.height = 320;
      const c = cv.getContext('2d');
      c.fillStyle = '#101020'; c.fillRect(0, 0, 240, 160);
      c.fillStyle = '#205020'; c.fillRect(240, 0, 240, 160);
      c.fillStyle = '#502020'; c.fillRect(0, 160, 240, 160);
      c.fillStyle = '#202050'; c.fillRect(240, 160, 240, 160);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      // 名字里别带 crop：等一下只放行「裁出来的那一块」（<节点id>-crop.png），
      // 整图上传必须失败——它一旦成功，n.dataURL 就被换成 /api/view 地址，
      // 而 ComfyUI 没开，那个地址取不到图，裁切这一步直接失败（踩过一次）。
      dt.items.add(new File([blob], 'e2e-quad.png', { type: 'image/png' }));
      const stage = document.getElementById('stage');
      const r = stage.getBoundingClientRect();
      stage.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: Math.round(r.left + r.width * 0.45), clientY: Math.round(r.top + r.height * 0.5) }));
      for (let k = 0; k < 80; k++) {
        const el = [...document.querySelectorAll('#nodes .node.image')].find((e) => {
          const im = e.querySelector('.thumb img');
          return im && im.naturalWidth === 480 && im.naturalHeight === 320;
        });
        if (el) return { id: el.dataset.id, beforeIds };
        await new Promise((r2) => setTimeout(r2, 100));
      }
      return { id: '', beforeIds };
    } finally { window.fetch = real; }
  })()`);
  check('拖一张 480×320 的图进画布（给裁切用例一张够大的底图）', !!cropBase.id, JSON.stringify(cropBase));
  const cropTitle = await page.center(`#nodes .node[data-id="${cropBase.id}"] .node-title`);
  // 拖进来的节点是「只放图」的纯图片节点：先点标题上那颗「生成」给它加面板
  await page.clickAt(cropTitle.x, cropTitle.y, { settle: 300 });
  await page.evaluate(`document.querySelector('.node[data-id="${cropBase.id}"] .n-genon').click()`);
  await new Promise((r) => setTimeout(r, 400));

  const cropWf = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btn = document.querySelector('[data-panel-for="${cropBase.id}"] .gensel.wfsel .gm-btn');
    if (!btn) return { missing: true };
    btn.click();
    await sleep(320);
    const items = [...document.querySelectorAll('.popmenu button')];
    const hit = items.find((b) => /Qwen/i.test(b.textContent));
    if (!hit) return { missing: true, items: items.map((b) => b.textContent.trim()).slice(0, 8) };
    const picked = hit.textContent.trim();
    hit.click();
    await sleep(320);
    const now = document.querySelector('[data-panel-for="${cropBase.id}"] .gensel.wfsel .gm-btn');
    return { picked, now: now ? now.textContent.trim() : '' };
  })()`);
  check('给这张图选上「Qwen 图像编辑」（只吃图、不吃遮罩）',
    !cropWf.missing && /Qwen/.test(cropWf.now), JSON.stringify(cropWf));

  await page.click('#imgTools .it-btn[data-tool="mask"]', { settle: 450 });
  const cropEd = await page.waitFor(`(() => {
    const cv = document.querySelector('#maskEditor .me-cv');
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    return { rect: [r.left, r.top, r.width, r.height], cv: [cv.width, cv.height] };
  })()`, 8000);
  check('这张图也能涂遮罩：编辑器打开，canvas 内部尺寸 = 原图像素',
    !!cropEd && cropEd.cv[0] === 480 && cropEd.cv[1] === 320, JSON.stringify(cropEd));
  const [cl, ct, cw, ch] = cropEd.rect;
  await page.drag({ x: cl + cw * 0.30, y: ct + ch * 0.50 }, { x: cl + cw * 0.42, y: ct + ch * 0.50 },
    { steps: 8, settle: 150 });
  await page.click('#maskEditor [data-act="apply"]', { settle: 450 });
  const cropMasked = await page.evaluate(`(() => ({
    wf: (document.querySelector('[data-panel-for="${cropBase.id}"] .gensel.wfsel .gm-btn') || {}).textContent.trim() || '',
    pill: (document.querySelector('.node[data-id="${cropBase.id}"] .n-mask') || {}).textContent || '',
    flash: ((document.getElementById('queueBadge') || {}).textContent || '').trim(),
  }))()`);
  check('涂完遮罩：工作流**没有**被换成局部重绘（只吃图的流也能吃遮罩）',
    /Qwen/.test(cropMasked.wf) && /遮罩 \d+%/.test(cropMasked.pill) && !/已换成/.test(cropMasked.flash),
    JSON.stringify(cropMasked));

  const cropRun = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    let upName = '', upSize = null, upPix = null;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('/api/upload')) {
        const fd = opts && opts.body;
        const f = fd && fd.get ? fd.get('image') : null;
        // 只放行裁出来的那一块；整图上传（ensureUploaded）照旧失败——放行了它，
        // n.dataURL 就会被换成 ComfyUI 的 /api/view 地址，而这里 ComfyUI 没开
        if (!f || !new RegExp('^${cropBase.id}-crop\\\\.png$').test(f.name)) {
          return json({ ok: false, error: 'offline' });
        }
        upName = f.name;
        const bm = await createImageBitmap(f);
        upSize = [bm.width, bm.height];
        const cv = document.createElement('canvas');
        cv.width = bm.width; cv.height = bm.height;
        const c = cv.getContext('2d');
        c.drawImage(bm, 0, 0);
        const px = (x, y) => { const d = c.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
        upPix = { tl: px(2, 2), right: px(Math.round(bm.width * 0.9), 8) };
        return json({ ok: true, image: 'crop-e2e.png', subfolder: '', type: 'input' });
      }
      if (u.startsWith('/api/run')) return json({ ok: true, prompt_id: 'crop-1' });
      if (u.startsWith('/api/job')) {
        return u.includes('crop-1')
          ? json({ ok: true, status: 'success', progress: 100,
                   artifacts: [{ kind: 'image', filename: 'crop_out_0001.png', subfolder: '', type: 'output' }] })
          : real(url, opts);
      }
      return real(url, opts);
    };
    const before = document.querySelectorAll('#nodes .node').length;
    const ta = document.querySelector('[data-panel-for="${cropBase.id}"] .gen-prompt');
    if (ta) { ta.focus(); document.execCommand('insertText', false, '把左边那块换成金色'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    const run = document.querySelector('[data-panel-for="${cropBase.id}"] .gen-run');
    if (run) run.click();
    let status = '';
    const trace = [];
    for (let k = 0; k < 140; k++) {
      const st = document.querySelector('[data-panel-for="${cropBase.id}"] .gen-status');
      status = st ? st.textContent : '';
      if (status && trace[trace.length - 1] !== status) trace.push(status);
      if (/完成|失败|错误/.test(status)) break;
      await sleep(100);
    }
    await sleep(300);
    window.fetch = real;
    return { upName, upSize, upPix, status, trace, before,
             panels: document.querySelectorAll('[data-panel-for="${cropBase.id}"]').length,
             after: document.querySelectorAll('#nodes .node').length,
             wf: (document.querySelector('[data-panel-for="${cropBase.id}"] .gensel.wfsel .gm-btn') || {}).textContent.trim() || '' };
  })()`);
  check('裁切重绘：上传的是裁出来的那一块（*-crop.png），不是整张烘了 alpha 的图',
    /-crop\.png$/.test(cropRun.upName), JSON.stringify(cropRun.upName));
  check('裁剪框 = 遮罩包围盒 + 余量，最小边长 256 且对齐 16',
    !!cropRun.upSize && cropRun.upSize[0] === 256 && cropRun.upSize[1] === 256,
    JSON.stringify(cropRun.upSize));
  // 涂在左半边、裁剪框以它为中心 → 框的左端仍在原图左半边（深蓝），
  // 框的右端已经跨过 x=240 那条分界线（墨绿）。位置算错的话这两点会同色。
  check('裁剪位置对：框左上角取到原图左上象限，右端跨过了象限分界线',
    !!cropRun.upPix
      && cropRun.upPix.tl[2] > cropRun.upPix.tl[1] && cropRun.upPix.tl[0] < 40
      && cropRun.upPix.right[1] > cropRun.upPix.right[0] + 20,
    JSON.stringify(cropRun.upPix));
  // 排队那条写「裁切重绘（贴回原位）」——这是用户唯一能看出「宽高是裁剪框、不是出图尺寸」的地方；
  // 完成那条写「已贴回原位」。两句都必须在，否则用户会以为出图变小了 / 图没贴回去。
  check('状态行说明白这次是「裁切重绘（贴回原位）」，完成后又说「已贴回原位」',
    (cropRun.trace || []).some((t) => /裁切重绘（贴回原位）/.test(t))
      && /完成/.test(cropRun.status) && /已贴回原位/.test(cropRun.status),
    JSON.stringify(cropRun));
  check('生成完成、工作流仍是 Qwen（没有被换走），结果另起了一个图片节点',
    /Qwen/.test(cropRun.wf) && cropRun.after === cropRun.before + 1,
    JSON.stringify({ wf: cropRun.wf, before: cropRun.before, after: cropRun.after }));

  // 收尾：只删这一轮新造的节点（拖进来的底图 + 那个产物），别影响后面的用例
  await page.evaluate(`(() => {
    const keep = new Set(${JSON.stringify(cropBase.beforeIds || [])});
    [...document.querySelectorAll('#nodes .node')]
      .filter((e) => !keep.has(e.dataset.id))
      .forEach((el) => { const d = el.querySelector('.n-del'); if (d) d.click(); });
  })()`);
  await new Promise((r) => setTimeout(r, 600));

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
        // 只认自己这个 pid：前面用例留下的任务也在轮询 /api/job，
        // 不区分的话它们会把 ticks 一口一口吃掉，这条用例就会偶发卡在 30%
        if (!u.includes('pct-test')) return real(url, opts);
        const t = ticks[Math.min(i++, ticks.length - 1)];
        return json(Object.assign({ ok: true, progress: null }, t));
      }
      return real(url, opts);
    };
    document.querySelector('[data-panel-for="i2"] .gen-run').click();
    const seen = [];
    // 面板上那行状态（生成中 42% · 1024×1024 · 12s）走的是另一条拼装路径：
    // 以前它只用**当拍**的 p，某一拍没数字就退成「生成中 · …」，于是遮罩上还有 42%、
    // 旁边那行却没有——用户看到的还是「百分比消失」。所以两处一起盯。
    const seenSt = [];
    // 准备阶段要读工作流、跑 /api/analyze（ComfyUI 没开时这一步会慢），
    // 采样窗口给到 24s：只盯 5 个 tick，够宽但不至于把整套拖太久。
    for (let k = 0; k < 200; k++) {
      const ov = document.querySelector('.node[data-id="i2"] .gen-overlay');
      const txt = ov && !ov.classList.contains('hidden') ? ov.textContent.trim() : '';
      if (txt && seen[seen.length - 1] !== txt) seen.push(txt);
      const stEl = document.querySelector('[data-panel-for="i2"] .gen-status');
      const stTxt = stEl ? stEl.textContent.trim() : '';
      if (stTxt && seenSt[seenSt.length - 1] !== stTxt) seenSt.push(stTxt);
      if (i >= ticks.length) break;
      await sleep(120);
    }
    window.fetch = real;
    const st = document.querySelector('[data-panel-for="i2"] .gen-status');
    const status = st ? st.textContent.trim() : '';
    // 收尾：提示词和队列记录都不留给后面的用例
    const clear = document.querySelector('[data-panel-for="i2"] .gen-chips .chip:nth-child(3)');
    if (clear) clear.click();
    return { seen, seenSt, status, hits };
  })()`);
  const pctSeq = pctSeqBox.seen;
  const afterFirst = pctSeq.slice(Math.max(0, pctSeq.indexOf('生成中 12%')));
  check('进度百分比不会因为某一拍没数字而消失（12% → 30%，中间不退回「生成中…」）',
    pctSeq.includes('生成中 5%') && pctSeq.includes('生成中 12%') && pctSeq.includes('生成中 30%')
      && !afterFirst.includes('生成中…'),
    JSON.stringify(pctSeqBox));
  // 状态行同理：从它第一次带上数字那一刻起，后面**还在跑**的每一拍都必须还带着数字
  // （「完成 · 8s」这种收尾文案本来就不该有百分比，不算在内）
  const stSeq = pctSeqBox.seenSt || [];
  const stFirst = stSeq.findIndex((s) => /生成中 \d+%/.test(s));
  const stAfter = stFirst >= 0 ? stSeq.slice(stFirst).filter((s) => s.startsWith('生成中')) : [];
  check('面板状态行也不会丢百分比（「生成中 12% · …」之后不许退成「生成中 · …」）',
    stFirst >= 0 && stAfter.length > 0 && stAfter.every((s) => /生成中 \d+%/.test(s)),
    JSON.stringify(stSeq));

  // ---- 失败要说清「哪里报错」 ----
  // 以前只有一句 `失败：<一坨字符串>`：分不清是上传、构建还是 ComfyUI 里某个节点，
  // 被那一行截掉的后半句还永远看不到。现在服务端把 execution_error 拆成
  // node_id / node_type / 节点标题（从这次提交的那份图里捞），前端写进状态行 + 详情卡片。
  const errBox = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const hits = [];
    window.fetch = async (url, opts) => {
      const u = String(url);
      hits.push(u.slice(0, 50));
      if (u.startsWith('/api/run')) return json({ ok: true, prompt_id: 'err-test' });
      if (u.startsWith('/api/analyze')) return json({ ok: true, slots: [] });
      if (u.startsWith('/api/upload')) return json({ ok: false, error: 'offline' });
      if (u.startsWith('/api/job')) {
        if (!u.includes('err-test')) return real(url, opts);
        return json({
          ok: false,
          error: 'Prompt outputs failed validation: node_errors',
          error_detail: {
            kind: 'execution', node_id: '3', node_type: 'LoadImage', title: '加载图像',
            message: 'Invalid image file: 视频_00001.png', exception_type: 'RuntimeError',
            where: '加载图像 · LoadImage（节点 3）',
          },
        });
      }
      return real(url, opts);
    };
    const ta = document.querySelector('[data-panel-for="i2"] .gen-prompt');
    if (ta) {
      ta.focus();
      ta.textContent = 'will fail';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    let clicked = false;
    for (let k = 0; k < 40; k++) {
      const b = document.querySelector('[data-panel-for="i2"] .gen-run');
      if (b && !b.disabled) { b.click(); clicked = true; break; }
      await sleep(100);
    }
    for (let k = 0; k < 80; k++) {
      const st = document.querySelector('[data-panel-for="i2"] .gen-status');
      if (st && /失败|错误|不足|缺失|有错/.test(st.textContent)) break;
      await sleep(100);
    }
    const st = document.querySelector('[data-panel-for="i2"] .gen-status');
    const row = document.querySelector('[data-panel-for="i2"] .gen-status-row');
    const shot = {
      clicked,
      status: st ? st.textContent.trim() : '',
      inRow: !!(row && row.contains(st)),
      isErr: !!(row && row.classList.contains('is-err')) && !!st && st.classList.contains('is-err'),
      clickable: !!(st && st.onclick),
    };
    // 点这一行 → 详情卡片
    if (st) st.click();
    await sleep(150);
    const card = document.getElementById('errCard');
    const pick = (sel) => {
      const el = card && card.querySelector(sel);
      return el ? el.textContent.trim() : '';
    };
    const detail = {
      card: !!card,
      title: pick('.sheet header strong'),
      where: pick('.err-row.where .err-v'),
      node: pick('.err-row .err-v'),
      rows: card ? card.querySelectorAll('.err-row').length : 0,
      hasCopy: !!(card && card.querySelector('.err-copy')),
      body: card ? card.textContent.replace(/\\s+/g, ' ').slice(0, 260) : '',
    };
    // 收尾：关掉卡片，别让它挡后面的点击
    if (card && card.querySelector('.err-close')) card.querySelector('.err-close').click();
    window.fetch = real;
    return { ...shot, detail, cardGone: !document.getElementById('errCard'), hits };
  })()`);
  check('失败时状态行写着「在哪」：不是一坨字符串',
    errBox.clicked && /加载图像/.test(errBox.status) && /节点 3|LoadImage/.test(errBox.status),
    JSON.stringify({ status: errBox.status, clicked: errBox.clicked }));
  check('失败的状态行在独立那一行里、标红、可点',
    errBox.inRow && errBox.isErr && errBox.clickable,
    JSON.stringify({ inRow: errBox.inRow, isErr: errBox.isErr, clickable: errBox.clickable }));
  check('点开是详情卡片：标题 / 在哪 / 节点 / 复制错误都在，Esc 或「关闭」能收掉',
    errBox.detail.card && errBox.detail.title && /加载图像/.test(errBox.detail.where)
      && /LoadImage/.test(errBox.detail.body) && errBox.detail.hasCopy && errBox.cardGone,
    JSON.stringify(errBox.detail));

  // ---- 生成完自动入库：前端必须真的把这次出的图交给资产库 ----
  // 命名规则和去重归 tests/smoke.py 管，这里只验**前端有没有接上**：MCP 那边就曾经
  // 因为「函数没注入」整个功能失效，表现却是「什么都没发生」——这种静默失效最难发现。
  // 先把这个节点选中：生成面板是按「当前选中的节点」渲染的，不选就查不到 .gen-run。
  const i2Title = await page.center(`#nodes .node[data-id="i2"] .node-title`);
  await page.clickAt(i2Title.x, i2Title.y, { settle: 400 });
  const autoImp = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const libCalls = [];
    const hits = [];
    window.fetch = async (url, opts) => {
      const u = String(url);
      hits.push(u.slice(0, 50));
      if (u.startsWith('/api/run')) return json({ ok: true, prompt_id: 'auto-imp' });
      if (u.startsWith('/api/analyze')) return json({ ok: true, slots: [] });
      if (u.startsWith('/api/upload')) return json({ ok: false, error: 'offline' });
      if (u.startsWith('/api/job')) {
        // 只糊自己这个任务：别的 pid 一律走真实请求
        if (!u.includes('auto-imp')) return real(url, opts);
        return json({ ok: true, status: 'success', progress: 100, artifacts: [
          { kind: 'image', filename: 'e2e-auto.png', subfolder: '', type: 'output' }] });
      }
      if (u.startsWith('/api/assets/lib')) {
        const body = JSON.parse(opts.body);
        libCalls.push(body);
        if (body.op === 'import') {
          return json({ ok: true, imported: 1, saved: [{ key: body.items[0].key,
            name: '20261102-000000-01.png', rel: '20261102-000000-01.png' }] });
        }
        return json({ ok: true, changed: 1, hidden: true });
      }
      return real(url, opts);
    };
    const ta = document.querySelector('[data-panel-for="i2"] .gen-prompt');
    if (ta) {
      // 提示词是 contenteditable（要能把 @[名字] 渲染成胶囊），没有 .value；
      // 写 textContent + 触发 input 才等价于用户打字，跟面板有没有焦点、是不是隐藏无关。
      ta.focus();
      ta.textContent = 'auto import';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // 夹具里的 i2 通过 t1 接收提示词节点内容，generateImage 会优先使用这条输入。
    // 同步更新两处，确保这次测试确实验证「auto import」被继承到结果节点。
    const linkedPrompt = document.querySelector('#nodes .node[data-id="t1"] .text-body');
    if (linkedPrompt) {
      linkedPrompt.textContent = 'auto import';
      linkedPrompt.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // 上一个用例刚在这个节点上收尾，按钮可能还禁用着；而且面板会随进度重渲染，
    // 抓到的元素随时会脱离文档——所以每一轮都重新查、拿到活的再点。
    let clicked = false;
    // 出图前后各拍一张快照：这次生成要验「原节点的图不被覆盖、结果落到新节点上」
    const shot = () => ({
      nodes: document.querySelectorAll('#nodes .node').length,
      links: document.querySelectorAll('#links .link-line').length,
      src: (document.querySelector('#nodes .node[data-id="i2"] .thumb img') || { getAttribute: () => '' }).getAttribute('src') || '',
      // 产物节点的标题已经改成「模型 · 提示词摘要」，不再固定叫「图片（生成）」，
      // 所以下面找「这次新落下的那个」只能靠 id 差集，不能靠标题
      ids: [...document.querySelectorAll('#nodes .node')].map((el) => el.dataset.id),
    });
    const before = shot();
    for (let k = 0; k < 40; k++) {
      const b = document.querySelector('[data-panel-for="i2"] .gen-run');
      if (b && !b.disabled) { b.click(); clicked = true; break; }
      await sleep(100);
    }
    for (let k = 0; k < 120 && !libCalls.length; k++) await sleep(100);
    let status = '';
    for (let k = 0; k < 20; k++) {
      const st = document.querySelector('[data-panel-for="i2"] .gen-status');
      status = st ? st.textContent.trim() : '';
      if (/完成|失败|错误/.test(status)) break;
      await sleep(100);
    }
    window.fetch = real;
    return { libCalls, status, clicked, hits, before, after: shot(),
             prompt: ta ? String(ta.textContent || '').slice(0, 30) : '(无输入框)' };
  })()`);
  const impCall = (autoImp.libCalls || [])[0] || {};
  const hideCall = (autoImp.libCalls || [])[1] || {};
  check('生成完自动入库：前端按「时间+序号」把这次的图交给资产库',
    impCall.op === 'import' && impCall.nameMode === 'time'
      && (impCall.items || [])[0] && impCall.items[0].key === 'output:/e2e-auto.png',
    JSON.stringify(autoImp));
  check('自动入库后把原 ComfyUI 键标成隐藏（列表里不会同一张图出现两次）',
    hideCall.op === 'hide' && hideCall.hidden === true
      && (hideCall.keys || []).includes('output:/e2e-auto.png'),
    JSON.stringify(hideCall));
  // 出图的落点：以前是 n.dataURL 直接被这批图顶掉，原图再也找不回来
  check('生成完在原节点之外新建图片节点（画布多出一个）',
    autoImp.after && autoImp.before && autoImp.after.nodes === autoImp.before.nodes + 1,
    JSON.stringify({ before: autoImp.before, after: autoImp.after }));
  check('生成完原节点的图原样留着（不被这次的产物覆盖）',
    !!autoImp.after && !!autoImp.before && autoImp.after.src === autoImp.before.src,
    JSON.stringify({ before: autoImp.before, after: autoImp.after }));
  // 方向：原节点 → 新节点（从左往右）。以前是反的，线要从产物右侧绕回原节点的 in 口
  check('新节点由原节点连出（连线条数 +1）',
    !!autoImp.after && !!autoImp.before && autoImp.after.links === autoImp.before.links + 1,
    JSON.stringify({ before: autoImp.before, after: autoImp.after }));
  // 新节点得带着这次的整套参数：打开大图详情就能看到「这张是用什么词出的」，
  // 不用回头翻原节点。以前这一步是空的（新节点 gen 只有默认工作流）。
  const bornInfo = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const beforeIds = ${JSON.stringify(autoImp.before.ids || [])};
    const node = [...document.querySelectorAll('#nodes .node')]
      .find((el) => !beforeIds.includes(el.dataset.id));
    if (!node) return { found: false };
    const zoom = node.querySelector('.img-zoom');
    if (!zoom) return { found: true, zoom: false };
    zoom.click();
    await sleep(200);
    const box = document.querySelector('#lightboxInfo');
    const out = {
      found: true, zoom: true,
      prompt: box ? ((box.querySelector('.lbi-prompt') || {}).textContent || '') : '',
      rows: box ? [...box.querySelectorAll('.lbi-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()) : [],
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
    return out;
  })()`);
  check('新节点的图片详情里带着这次用的提示词（继承参数，不用回头翻原节点）',
    bornInfo.prompt === 'auto import', JSON.stringify(bornInfo));
  // 种子这行要真跑工作流才有（这里的 /api/analyze 被 mock 成空 slots，没有种子插槽），
  // 所以只验「工作流」这一行：参数确实是随图一起带过来的，不是空壳。
  check('新节点详情里带着这次的工作流（整套参数一起继承）',
    (bornInfo.rows || []).some((r) => /^工作流.+/.test(r) && !/工作流$/.test(r)),
    JSON.stringify(bornInfo.rows));

  // ---- 连点生成只提交一次 ----
  // 准备阶段（上传参考图 / 烘焙遮罩 / 读风格）是一串 await，一次几秒。以前 busy 要等
  // **真正提交**才置位，这期间按钮可点：用户以为没反应，再点一下、再点一下，每次都从
  // 「检查 busy」那里进来，于是各提交一个任务——一次操作出三张图，三张还都不一样
  // （种子每次重算）。这条用例把 /api/analyze 拖慢 600ms 来复现那个窗口。
  const clickStorm = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const runs = [];
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('/api/run')) { runs.push(u.slice(0, 40)); return json({ ok: true, prompt_id: 'storm' }); }
      // 真正的窗口在**上传参考图**：它发生在 busy 置位之前，一张大图几秒。
      // （/api/analyze 在 busy 之后，拖慢它复现不出这个问题。）
      if (u.startsWith('/api/upload')) { await sleep(700); return json({ ok: false, error: 'offline' }); }
      if (u.startsWith('/api/analyze')) return json({ ok: true, slots: [] });
      if (u.startsWith('/api/job')) {
        if (!u.includes('storm')) return real(url, opts);
        return json({ ok: true, status: 'success', progress: 100, artifacts: [
          { kind: 'image', filename: 'e2e-storm.png', subfolder: '', type: 'output' }] });
      }
      if (u.startsWith('/api/assets/lib')) return json({ ok: true, imported: 0, saved: [] });
      return real(url, opts);
    };
    const ta = document.querySelector('[data-panel-for="i2"] .gen-prompt');
    if (ta) {
      ta.focus();
      ta.textContent = 'storm';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // 连点三次，间隔 80ms：模拟「点了没反应，再点一下」
    for (let i = 0; i < 3; i++) {
      const b = document.querySelector('[data-panel-for="i2"] .gen-run');
      if (b) b.click();
      await sleep(80);
    }
    for (let k = 0; k < 60 && !runs.length; k++) await sleep(100);
    await sleep(1600);        // 等准备阶段彻底跑完，确认没有后续提交
    window.fetch = real;
    return { runs: runs.length, urls: runs };
  })()`);
  check('连点生成只提交一次（准备阶段的 await 不再放行重复提交）',
    clickStorm.runs === 1, JSON.stringify(clickStorm));

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
      `(() => { const n = document.querySelector('.node[data-id="${mcpNode}"] .text-body'); return n ? n.textContent : ''; })()`);
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
  const saveState = () => page.evaluate(`(document.getElementById('saveState') || {}).textContent || ''`);
  const revA = await revMeta();
  const stateA = await saveState();
  await new Promise((r) => setTimeout(r, 1500));
  const revB = await revMeta();
  const stateB = await saveState();
  check('同步之后浏览器不会把旧版本写回去（rev 只涨不回退）', revB === revA,
    `rev ${revA} → ${revB} · 保存状态「${stateA}」→「${stateB}」`);

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
  // 顶栏是状态位，不是诊断面板：灯里只留「MCP 已连接」，
  // 客户端名 / 连接时间 / 调用次数都在 tooltip（下一条用例查那里）
  check('MCP 灯默认只显示简短状态，不把客户端名挂在顶栏上',
    lampDiag.text === 'MCP 已连接' && lampDiag.ellipsis === false, lampDiag.text);
  check('MCP 灯能说清是谁接进来的', /e2e/.test(lampDiag.title), lampDiag.title);

  // ---- MCP 安装入口：点顶栏那盏灯，落到设置的「连接」格 ----
  // 门槛全在第一步（端点是什么、stdio 命令怎么写、路径在哪），所以这一块必须把
  // 「能直接抄的东西」摆出来。写入那步在 e2e 里也能真点：HOME 已指到临时目录。
  // 以前 MCP 是个单独的整屏面板；现在它和 ComfyUI 地址、服务开关同属「这台机器怎么和外面连」，
  // 归在设置 → 连接里，顶栏那盏灯只负责把人送到这一格。
  const readSetup = () => page.evaluate(`(() => {
    const panel = document.getElementById('appSettings');
    const pane = document.getElementById('set-pane-conn');
    const note = document.getElementById('mcpSetupNote');
    return {
      open: !!panel && !!(pane && !pane.classList.contains('hidden')),
      // MCP 必须落在「连接」格里面，不是另一个弹窗
      inConn: !!pane && pane.contains(document.getElementById('setMcp')),
      active: ((document.querySelector('#setTabs .tab.active') || {}).dataset || {}).set || '',
      endpoint: (document.getElementById('mcpSetupEndpoint') || {}).value || '',
      tabs: [...document.querySelectorAll('#mcpSetupTabs .mcp-tab')].map((b) => b.textContent),
      on: [...document.querySelectorAll('#mcpSetupTabs .mcp-tab.on')].map((b) => b.textContent),
      path: (document.getElementById('mcpSetupPath') || {}).value || '',
      json: (document.getElementById('mcpSetupJson') || {}).textContent || '',
      exists: (document.getElementById('mcpSetupExists') || {}).textContent || '',
      note: note ? note.textContent : '',
      noteKind: note ? note.className : '',
    };
  })()`);

  await page.evaluate(`document.getElementById('mcpChip').click()`);
  // 这一块要先打两个接口（setup + health）才填得上内容：等它填满，别赌 700ms
  let setupA = await readSetup();
  for (let k = 0; k < 40 && !(setupA.open && setupA.endpoint && setupA.tabs.length); k++) {
    await new Promise((r) => setTimeout(r, 100));
    setupA = await readSetup();
  }
  check('点顶栏的 MCP 灯 → 落到设置的「连接」格，MCP 那一块就在里面（端点 + 三个客户端）',
    setupA.open && setupA.active === 'conn' && setupA.inConn
      && /\/mcp$/.test(setupA.endpoint) && setupA.tabs.length === 3,
    `${setupA.active} · inConn=${setupA.inConn} · ${setupA.endpoint} · ${setupA.tabs.join('/')}`);
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
  // 掉线的是谁：现在也在 tooltip 里，顶栏只留状态
  const goneTitle = await page.evaluate(
    `(() => { const el = document.getElementById('mcpChip'); return el ? el.title : ''; })()`);
  check('断开的灯在 tooltip 里说得出是谁掉了线', /e2e/.test(goneTitle), goneTitle.split('\n')[0]);

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

  // ComfyUI 的 /history 会一直留着「图已经被删掉」的记录（清过 output/ 就会这样），
  // 资产库照着 /history 列出来，缩略图必然 404。这不是我们的 bug——我们只是请求了它自己报的
  // 文件名——所以这里把它排除，否则本机清过一次输出目录，这条断言就永远红着，
  // 真正该抓的 JS 报错反而被淹没。除「/api/view 取不到图（404 / 502）」之外的一切照旧。
  // 502 是 ComfyUI 没开或取不到字节，同样是「图不在了」的一种，不是 JS 错。
  // 注意 URL 在 e.url 里，不在 e.text 里（text 只有「Failed to load resource…」）。
  const consoleErrors = page.errors.filter((e) => {
    const s = `${e.text || ''} ${e.url || ''}`;
    if (/favicon/.test(s)) return false;
    // ComfyUI is deliberately absent in CI. Ignore its expected proxy failures only.
    if (health.comfy === false && /502 \(Bad Gateway\)/.test(s)
        && /\/api\/(?:analyze|upload)(?:[/?#:]|$)/.test(s)) return false;
    return !(/\/api\/view\?/.test(s) && /40[34]|502/.test(s));
  });
  // 只打 text 的话永远只看到「Uncaught」——把 detail / 位置也带上，否则报错了也查不出是哪一行
  const errText = (e) => [e.text, e.detail, e.url && `${e.url}:${e.line}`].filter(Boolean).join(' ');
  check('控制台无报错（ComfyUI 里已删文件的 /api/view 404 不算）',
    consoleErrors.length === 0, consoleErrors.map(errText).join(' | '));

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
        gen: { prompt: '亚像素', wf: 'lib:krea2-txt2img.api', aspect: '16:9', size: '1k',
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

  // ---- 空画布起始页：新用户进来的第一屏 ----
  // 这一段以前一条断言都没有。结果是：点「图片生成」在 ComfyUI 没连上时要等几秒、
  // 弹一句 /object_info 的行话、3.2 秒就消失，看起来就是「点了没反应」——没人发现。
  // 现在盯三件事：① 灰按钮点得下去且有下一步 ② 点下去立刻有动静 ③ 连不上时说人话。
  const comfyOnline = !!(await (await fetch(server.base + 'api/health')).json()).comfy;
  await page.evaluate(`document.querySelector('#topBar [data-act="home"]').click()`);
  await page.waitFor(`!document.getElementById('home').classList.contains('hidden')`, 8000);
  await page.evaluate(`document.getElementById('newCanvas').click()`);
  // 新建画布落在空态起始页：这一屏就是新用户进来的第一眼。
  // 除了「起始页可见」，还要求节点数 === 0 —— 否则点下去的一瞬间旧项目还挂在屏幕上，
  // 条件立刻成立，读到的是上一个画布。
  await page.waitFor(`(() => {
    const e = document.getElementById('canvasEmpty');
    return !!e && !e.classList.contains('hidden')
      && document.querySelectorAll('#nodes .node').length === 0
      && document.querySelectorAll('#capRow button').length > 0;
  })()`, 12000);

  // 新建画布必须停在空态：不自动放节点、不自动弹生成面板。
  // 这一条是给「新用户第一眼」定的口径 —— 第一屏是「双击画布 + 一排能力」，
  // 而不是一个已经摆好的图片节点。
  const startState = await page.evaluate(`(() => ({
    nodes: document.querySelectorAll('#nodes .node').length,
    emptyShown: !document.getElementById('canvasEmpty').classList.contains('hidden'),
    sub: (document.getElementById('capSub') || {}).textContent || '',
  }))()`);
  check('新建画布：停在空态起始页，不自动放节点',
    startState.nodes === 0 && startState.emptyShown && /双击空白处/.test(startState.sub),
    JSON.stringify(startState));

  const capBase = await page.evaluate(`(() => {
    const btns = [...document.querySelectorAll('#capRow button')];
    const off = document.getElementById('capOffline');
    const isOff = (b) => b.getAttribute('aria-disabled') === 'true';
    const tagOf = (b) => {
      const t = b.querySelector('.cap-tag');
      return t ? t.textContent.trim() : '';
    };
    // 两个合法标记：「未配置」= 去配一下就好；「不支持」= 本地压根没这个能力（剪辑），配不了。
    // 灰了却什么都不说才是问题——那才是把状态只画成颜色。
    const OK_TAG = ['未配置', '不支持'];
    return {
      labels: btns.map((b) => b.querySelector('.cap-label').textContent.trim()),
      nativeDisabled: btns.filter((b) => b.disabled).length,
      ariaOff: btns.filter(isOff).map((b) => b.querySelector('.cap-label').textContent.trim()),
      tags: btns.map((b) => b.querySelector('.cap-label').textContent.trim() + '=' + tagOf(b)),
      offWithoutTag: btns.filter((b) => isOff(b) && !OK_TAG.includes(tagOf(b)))
        .map((b) => b.querySelector('.cap-label').textContent.trim()),
      onWithTag: btns.filter((b) => !isOff(b) && tagOf(b) !== '')
        .map((b) => b.querySelector('.cap-label').textContent.trim()),
      sub: (document.getElementById('capSub') || {}).textContent || '',
      offlineShown: !!off && !off.classList.contains('hidden'),
      offlineText: off ? off.innerText.replace(/\\s+/g, ' ').trim() : '',
    };
  })()`);
  check('起始页：五个能力都在，灰的也能点（用 aria-disabled 而不是原生 disabled）',
    capBase.labels.join('/') === '图片生成/视频生成/音频生成/剧本生成/智能剪辑'
      && capBase.nativeDisabled === 0 && capBase.ariaOff.includes('视频生成'),
    JSON.stringify(capBase.labels) + ' · ariaOff=' + JSON.stringify(capBase.ariaOff));
  // 空态只留一句「也可双击空白处添加节点」。以前这里还有一句「点上面任一可用能力直接放下一个…」，
  // 跟能力卡自己的文案重复，方案 v2 已删——留一句就够，别把选择变多。
  check('起始页：说明缩短为一句，不再和能力卡文案重复',
    /^也可双击空白处添加节点$/.test(capBase.sub.trim()) && !/直接放下一个/.test(capBase.sub),
    capBase.sub);
  // 灰度不是状态表达：点不动的能力必须挂一个文字标记，读屏和色弱用户都能拿到。
  // 「未配置」和「不支持」是两件事（前者去配一下就好，后者本地没有这个能力），
  // 所以两个都算合格标记；不合格的是「灰了但什么都不说」。
  // 反过来可用的按钮不该挂，否则标记变成装饰。
  check('起始页：点不动的能力卡挂文字标记（未配置 / 不支持），不只靠灰度',
    capBase.ariaOff.length > 0 && capBase.offWithoutTag.length === 0 && capBase.onWithTag.length === 0,
    JSON.stringify(capBase.tags));
  // 两种环境都要过：连不上时提示条必须出现且说人话；连得上时它必须收起（别平白吓人）
  check('起始页：连不上 ComfyUI 才出现提示条，且写的是「还没连上」而不是 urlopen 报错',
    comfyOnline
      ? capBase.offlineShown === false
      : (capBase.offlineShown === true && /还没连上 ComfyUI/.test(capBase.offlineText)
        && !/urlopen|object_info/.test(capBase.offlineText)),
    `online=${comfyOnline} · ${capBase.offlineText}`);

  // 点灰按钮：必须有可见提示，视频/音频还要把人送到工作流库
  const capOffClick = await page.evaluate(`(async () => {
    const badge = document.getElementById('queueBadge');
    badge.textContent = ''; badge.classList.add('hidden');
    const b = [...document.querySelectorAll('#capRow button')].find((x) => /视频生成/.test(x.textContent));
    b.click();
    await new Promise((r) => setTimeout(r, 350));
    return {
      flash: badge.textContent,
      shown: !badge.classList.contains('hidden'),
      sheet: !!document.getElementById('appSettings') || !!document.querySelector('.sheet'),
    };
  })()`);
  check('点灰按钮：给出下一步（不是装死），并打开工作流库',
    capOffClick.shown && /工作流库/.test(capOffClick.flash) && capOffClick.sheet,
    JSON.stringify(capOffClick));

  // 关掉工作流库，回起始页
  await page.evaluate(`(() => {
    const x = document.querySelector('#appSettings .sheet-close, .sheet-close, #sheetClose');
    if (x) x.click();
    document.querySelectorAll('[data-close]').forEach((b) => b.click());
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  // 点「图片生成」：直接放下一个图片节点 + 生成面板。
  // 图片节点自带面板（提示词 / 参考图 / 工作流胶囊 / 生成按钮），再摆「提示词 → 工作流 → 输出」
  // 三件套就是多两个要删的节点。所以这里盯的是「一个节点、已选中、面板已浮出」。
  const capClick = await page.evaluate(`(async () => {
    const badge = document.getElementById('queueBadge');
    badge.textContent = ''; badge.classList.add('hidden');
    const b = [...document.querySelectorAll('#capRow button')].find((x) => /图片生成/.test(x.textContent));
    b.click();
    // 同步读：放节点是纯本地动作，不请求 ComfyUI，点完就该有
    const syncNodes = document.querySelectorAll('#nodes .node').length;
    await new Promise((r) => setTimeout(r, 400));
    const n = document.querySelector('#nodes .node');
    const panel = n && n.querySelector('.gen-panel');
    return {
      syncNodes,
      nodes: document.querySelectorAll('#nodes .node').length,
      title: n ? (n.querySelector('.n-name') || {}).textContent : '',
      selected: !!n && n.classList.contains('selected'),
      panelShown: !!panel && getComputedStyle(panel).display !== 'none',
      wf: n ? ((n.querySelector('.gensel.wfsel .gm-btn') || {}).textContent || '') : '',
      emptyShown: !document.getElementById('canvasEmpty').classList.contains('hidden'),
      busyLeft: document.querySelectorAll('#capRow button.is-busy').length,
      flash: badge.textContent,
    };
  })()`);
  check('点「图片生成」：立刻放下一个图片节点，选中它，生成面板跟着浮出',
    capClick.syncNodes === 1 && capClick.nodes === 1 && capClick.title === '图片'
      && capClick.selected && capClick.panelShown && !capClick.emptyShown,
    JSON.stringify(capClick));
  check('点「图片生成」只放一个节点（不摆「提示词 → 工作流 → 输出」三件套）',
    capClick.nodes === 1, String(capClick.nodes));
  // 以前这里预选了一个「文生图」，用户从没选过、界面上也没写，图却已经按它跑了。
  // 现在新节点是空的：面板上明写「未选择工作流」。
  check('图片节点的生成面板**不预选**工作流：写着「未选择工作流」',
    capClick.wf === '未选择工作流', capClick.wf);
  check('按钮点完不会卡在忙碌态', capClick.busyLeft === 0, String(capClick.busyLeft));

  // 选了才算选了：点开那颗菜单 → 点一项 → 面板上立刻换成它的名字
  await page.evaluate(`document.querySelector('.node.selected .gensel.wfsel .gm-btn').click()`);
  await new Promise((r) => setTimeout(r, 350));
  const wfPickRes = await page.evaluate(`(() => {
    const items = [...document.querySelectorAll('.popmenu button')];
    const hit = items.find((b) => /文生图/.test(b.textContent));
    const label = hit ? hit.textContent.trim() : '';
    if (hit) hit.click();
    return { count: items.length, label };
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  const wfAfterPick = await page.evaluate(
    `(document.querySelector('.node.selected .gensel.wfsel .gm-btn') || {}).textContent.trim()`);
  check('在工作流菜单里点一项，面板上立刻换成它（占位语消失）',
    wfPickRes.count > 0 && !!wfAfterPick && wfAfterPick !== '未选择工作流',
    JSON.stringify({ ...wfPickRes, wfAfterPick }));

  // 名字要看得全：以前底栏那颗压着 max-width: 48%（状态文字还挤在同一行时的折中），
  // 「Qwen-image-2.1 图像编辑」这种长度直接截成「Qwen-image-2.1 图像…」——
  // 而「我选的是哪个工作流」恰恰是这一行里最不能猜的信息。
  const wfName = await page.evaluate(`(() => {
    const box = document.querySelector('.node.selected .gen-bar .gensel.wfsel');
    if (!box) return { missing: true };
    const sp = box.querySelector('.gm-btn > span');
    const cs = getComputedStyle(box);
    const bar = box.closest('.gen-bar');
    return {
      text: sp ? sp.textContent.trim() : '',
      truncated: sp ? sp.scrollWidth > sp.clientWidth + 1 : null,
      maxW: cs.maxWidth,
      wraps: getComputedStyle(bar).flexWrap,
      // 名字这颗不许把生成键挤出底栏
      runInside: (() => {
        const run = bar.querySelector('.gen-run');
        if (!run) return null;
        const b = bar.getBoundingClientRect(), r = run.getBoundingClientRect();
        return r.right <= b.right + 1 && r.left >= b.left - 1;
      })(),
    };
  })()`);
  check('工作流名显示完整（不截断），名字长了也只是换行、不把生成键挤出去',
    !wfName.missing && wfName.truncated === false && wfName.maxW !== '48%'
      && wfName.wraps === 'wrap' && wfName.runInside === true,
    JSON.stringify(wfName));

  // 空节点（节点上还没有图）生成：结果直接填进这个节点，不再多出一个。
  // 以前是「不管有没有初始图都新建一个」，于是空节点永远是空的，旁边多出一个产物节点，
  // 用户看到的就是「我在这上面生成，图却跑到别处去了」。
  const emptyGen = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('/api/run')) return json({ ok: true, prompt_id: 'empty-node' });
      if (u.startsWith('/api/analyze')) return json({ ok: true, slots: [] });
      if (u.startsWith('/api/upload')) return json({ ok: false, error: 'offline' });
      if (u.startsWith('/api/job') && u.includes('empty-node')) {
        return json({ ok: true, status: 'success', progress: 100, artifacts: [
          { kind: 'image', filename: 'e2e-empty.png', subfolder: '', type: 'output' }] });
      }
      return real(url, opts);
    };
    const before = document.querySelectorAll('#nodes .node').length;
    const ta = document.querySelector('.gen-prompt');
    if (ta) { ta.focus(); ta.textContent = 'empty node'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    let clicked = false;
    for (let k = 0; k < 40; k++) {
      const b = document.querySelector('.gen-run');
      if (b && !b.disabled) { b.click(); clicked = true; break; }
      await sleep(100);
    }
    let status = '';
    for (let k = 0; k < 120; k++) {
      await sleep(100);
      const st = document.querySelector('.gen-status');
      status = st ? st.textContent.trim() : '';
      if (/完成|失败|错误/.test(status)) break;
    }
    await sleep(300);
    window.fetch = real;
    const node = document.querySelector('#nodes .node');
    const im = node ? node.querySelector('.thumb img') : null;
    return { before, clicked, status,
             after: document.querySelectorAll('#nodes .node').length,
             src: im ? (im.getAttribute('src') || '') : '',
             count: node ? ((node.querySelector('.img-count') || {}).textContent || '') : '' };
  })()`);
  check('空节点生成：结果直接填进这个节点，不再凭空多出一个',
    emptyGen.clicked && emptyGen.after === emptyGen.before && !!emptyGen.src,
    JSON.stringify(emptyGen));

  // ---- 智能编辑：标记画在图上，连同描述一起交给模型 ----
  // 和「遮罩」是两件事：遮罩是二值的（改 / 不改），表达不了「这根箭头指着的那只碗」。
  // 所以这里盯的是：标记真的画进了交给模型的那张图、原节点一个字节不动、新节点里
  // **没有遮罩**、描述原样带走、点一次就开跑。
  // 用 canvas-mask 夹具（512×512 的真图）：16×16 的占位图上标什么都是满屏，看不出问题。
  seedProject(dataDir, 'canvas-mask.json', '20260101-000000-smart');
  await page.evaluate(`document.querySelector('#projectBar [data-act="home"]').click()`);
  await page.waitFor(`!document.getElementById('home').classList.contains('hidden')`, 8000);
  await page.waitFor(`[...document.querySelectorAll('#recentList .proj-card')]
    .some((x) => /遮罩夹具画布/.test(x.textContent))`, 10000);
  await page.evaluate(`(() => {
    const c = [...document.querySelectorAll('#recentList .proj-card')]
      .find((x) => /遮罩夹具画布/.test(x.textContent));
    c.querySelector('.pm').click();
  })()`);
  // 只等「有节点」不够：上一个画布的节点还在屏幕上，条件立刻成立，读到的会是别人的图
  await page.waitFor(`(document.getElementById('projectName') || {}).value === '遮罩夹具画布'`, 12000);
  await page.waitFor(`(() => {
    const im = document.querySelector('#nodes .node.image .thumb img');
    return !!im && im.naturalWidth === 512;
  })()`, 12000);

  const smartPick = await page.evaluate(`(() => {
    const el = document.querySelector('#nodes .node.image');
    if (!el) return null;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    const im = el.querySelector('.thumb img');
    return { id: el.dataset.id, nat: [im.naturalWidth, im.naturalHeight], src: im.getAttribute('src') };
  })()`);
  check('智能编辑：选中一张真图（512×512 夹具）',
    !!smartPick && smartPick.nat[0] === 512, JSON.stringify({ id: smartPick && smartPick.id, nat: smartPick && smartPick.nat }));

  await page.waitFor(`!!document.querySelector('#imgTools [data-tool="smart"]')`, 8000);
  await page.evaluate(`document.querySelector('#imgTools [data-tool="smart"]').click()`);
  const smartOpen = await page.waitFor(`(() => {
    const root = document.getElementById('smartEdit');
    if (!root) return null;
    const cv = root.querySelector('.se-cv');
    const img = root.querySelector('.se-img');
    const r = cv.getBoundingClientRect();
    return {
      tools: [...root.querySelectorAll('.se-tool')].map((b) => b.textContent.trim()),
      pressed: (root.querySelector('.se-tool[aria-pressed="true"]') || {}).textContent || '',
      presets: root.querySelectorAll('.se-preset').length,
      hasPrompt: !!root.querySelector('#sePrompt'),
      wf: (root.querySelector('.se-wf b') || {}).textContent || '',
      cv: [cv.width, cv.height],
      nat: [img.naturalWidth, img.naturalHeight],
      box: [r.left, r.top, r.width, r.height],
      count: root.querySelector('.se-count').textContent.trim(),
    };
  })()`, 8000).catch(() => null);
  check('点「智能编辑」→ 打开编辑器：六种标记 + 描述框 + 预设 + 工作流都在',
    !!smartOpen && smartOpen.tools.join('/') === '点击/框选/画笔/箭头/文字/橡皮'
      && smartOpen.pressed === '点击' && smartOpen.hasPrompt && smartOpen.presets === 5
      && !!smartOpen.wf,
    JSON.stringify(smartOpen && { tools: smartOpen.tools, pressed: smartOpen.pressed,
      presets: smartOpen.presets, wf: smartOpen.wf }));
  check('智能编辑：canvas 内部尺寸 = 原图像素（不然标记整体错位）',
    !!smartOpen && smartOpen.cv[0] === smartOpen.nat[0] && smartOpen.cv[1] === smartOpen.nat[1],
    smartOpen ? `cv=${smartOpen.cv} img=${smartOpen.nat}` : 'none');
  // 标注图是当「源图」送进去的：吃遮罩的那种拿不到遮罩（mask 全 0），送进去等于什么都没改
  check('智能编辑：挑的是**只吃图**的工作流（不是吃遮罩的局部重绘）',
    !!smartOpen && !!smartOpen.wf && !/局部重绘/.test(smartOpen.wf), smartOpen && smartOpen.wf);
  check('智能编辑：一打开是空的（这些标记属于这一次操作，不沿用上次）',
    !!smartOpen && /还没有标记/.test(smartOpen.count), smartOpen && smartOpen.count);

  const sb = smartOpen.box;
  const sAt = (fx, fy) => ({ x: sb[0] + sb[2] * fx, y: sb[1] + sb[3] * fy });
  const smartCount = () => page.evaluate(`document.querySelector('#smartEdit .se-count').textContent.trim()`);

  // 点击：一个带序号的点
  await page.clickAt(sAt(0.5, 0.5).x, sAt(0.5, 0.5).y, { settle: 220 });
  check('点击：点一下就有一个带序号的标记', /标记 1 处/.test(await smartCount()), await smartCount());

  // 框选：拖一个框
  await page.evaluate(`document.querySelector('#smartEdit [data-tool="rect"]').click()`);
  await page.drag(sAt(0.2, 0.62), sAt(0.5, 0.84), { steps: 10, settle: 250 });
  check('框选：拖一下就圈住一块', /标记 2 处/.test(await smartCount()), await smartCount());

  // 箭头：指哪改哪
  await page.evaluate(`document.querySelector('#smartEdit [data-tool="arrow"]').click()`);
  await page.drag(sAt(0.2, 0.24), sAt(0.42, 0.4), { steps: 10, settle: 250 });
  check('箭头：拖出一条指向目标的箭头', /标记 3 处/.test(await smartCount()), await smartCount());

  // 文字：点一下就地输入，回车落字
  await page.evaluate(`document.querySelector('#smartEdit [data-tool="text"]').click()`);
  await page.clickAt(sAt(0.62, 0.18).x, sAt(0.62, 0.18).y, { settle: 250 });
  const textInputShown = await page.evaluate(`!!document.querySelector('#smartEdit .se-textin')`);
  await page.evaluate(`(() => {
    const i = document.querySelector('#smartEdit .se-textin');
    i.value = '换成盘子';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const afterText = await smartCount();
  check('文字：就地输入框出现，回车后落成一个标记、输入框收掉',
    textInputShown === true && /标记 4 处/.test(afterText)
      && (await page.evaluate(`!document.querySelector('#smartEdit .se-textin')`)) === true,
    `${textInputShown} · ${afterText}`);

  // 撤销回到上一步
  await page.evaluate(`document.querySelector('#smartEdit [data-act="undo"]').click()`);
  check('撤销：撤掉最后一笔', /标记 3 处/.test(await smartCount()), await smartCount());

  // 预设：点一下把句子填进描述框
  await page.evaluate(`document.querySelector('#smartEdit .se-preset').click()`);
  const presetVal = await page.evaluate(`document.querySelector('#sePrompt').value`);
  check('预设：点「换衣服」把半句填进描述框（用户再补具体的）',
    /把标记区域里人物的衣服换成$/.test(presetVal), presetVal);

  // 没写描述就点生成：拦住，编辑器不关
  await page.evaluate(`(() => {
    document.querySelector('#sePrompt').value = '';
    document.querySelector('#smartEdit [data-act="run"]').click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const smartNoPrompt = await page.evaluate(`(() => ({
    still: !!document.getElementById('smartEdit'),
    flash: (document.getElementById('queueBadge') || {}).textContent || '',
    shown: !document.getElementById('queueBadge').classList.contains('hidden'),
  }))()`);
  check('没写描述就点生成：拦住并说清缺什么，编辑器不关',
    smartNoPrompt.still === true && smartNoPrompt.shown && /改成什么样/.test(smartNoPrompt.flash),
    JSON.stringify(smartNoPrompt));

  // 写上描述 → 生成：新节点 + 图里真的带标记 + 没有遮罩 + 直接开跑
  const smartGen = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const real = window.fetch.bind(window);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const hits = [];
    let upName = '', upSize = null, upDot = null, upArrow = null, upCorner = null;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith('/api/upload')) {
        // 交给 ComfyUI 的那张就是这里收到的字节：直接采样，比看 DOM 可靠
        const f = opts && opts.body && opts.body.get ? opts.body.get('image') : null;
        if (!f) return json({ ok: false, error: 'offline' });
        upName = f.name;
        const bm = await createImageBitmap(f);
        upSize = [bm.width, bm.height];
        const cv = document.createElement('canvas');
        cv.width = bm.width; cv.height = bm.height;
        const c = cv.getContext('2d');
        c.drawImage(bm, 0, 0);
        const px = (x, y) => { const d = c.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
        // 点击在 (50%,50%)，半径 18：取圈内偏右一点，避开中间那个白色的「1」
        upDot = px(Math.round(bm.width * 0.5) + 10, Math.round(bm.height * 0.5));
        // 箭头从 (20%,24%) 拖到 (42%,40%)：沿线中点应该压着红线
        upArrow = px(Math.round(bm.width * 0.31), Math.round(bm.height * 0.32));
        // 没标过的角落：必须和原图一模一样（否则说明整张被涂了）
        upCorner = px(4, 4);
        return json({ ok: true, image: f.name, subfolder: '', type: 'input' });
      }
      if (u.startsWith('/api/run')) { hits.push(u); return json({ ok: true, prompt_id: 'smart-1' }); }
      if (u.startsWith('/api/analyze')) return json({ ok: true, slots: [] });
      if (u.startsWith('/api/job') && u.includes('smart-1')) {
        return json({ ok: true, status: 'success', progress: 100, artifacts: [
          { kind: 'image', filename: 'smart_out.png', subfolder: '', type: 'output' }] });
      }
      return real(url, opts);
    };
    // 原图左上角那个像素：用来验「没标的地方一个字节都没变」
    const srcImg = document.querySelector('#nodes .node.image .thumb img');
    const scv = document.createElement('canvas');
    scv.width = srcImg.naturalWidth; scv.height = srcImg.naturalHeight;
    scv.getContext('2d').drawImage(srcImg, 0, 0);
    const sd = scv.getContext('2d').getImageData(4, 4, 1, 1).data;
    const srcCorner = [sd[0], sd[1], sd[2]];

    const before = document.querySelectorAll('#nodes .node').length;
    document.querySelector('#sePrompt').value = '把标记区域里的球换成青花瓷盘，其他不要动';
    document.querySelector('#smartEdit [data-act="run"]').click();
    for (let k = 0; k < 60; k++) {
      await sleep(100);
      if (!document.getElementById('smartEdit')) break;
    }
    // 点一次会多两个节点：承载标注图的那个 + 出图的那个（结果另起一个，和擦除 / 去字一致）
    for (let k = 0; k < 80; k++) {
      await sleep(100);
      if (document.querySelectorAll('#nodes .node').length >= before + 2) break;
    }
    await sleep(400);
    window.fetch = real;
    const made = [...document.querySelectorAll('#nodes .node.image')]
      .find((e) => /智能编辑/.test((e.querySelector('.node-title') || {}).textContent || ''));
    const srcAfter = document.querySelector('#nodes .node.image .thumb img');
    return {
      before, after: document.querySelectorAll('#nodes .node').length,
      closed: !document.getElementById('smartEdit'),
      title: made ? made.querySelector('.node-title').textContent.trim() : '',
      prompt: made ? (made.querySelector('.gen-prompt') || {}).textContent || '' : '',
      maskPill: made ? !!made.querySelector('.n-mask') : null,
      upName, upSize, upDot, upArrow, upCorner, srcCorner,
      srcSrc: srcAfter ? srcAfter.getAttribute('src') : '',
      runs: hits.length,
    };
  })()`);
  check('点生成：编辑器关掉，多出「智能编辑 · 图片」承载节点 + 一个出图节点',
    smartGen.closed && smartGen.after === smartGen.before + 2 && /智能编辑/.test(smartGen.title),
    JSON.stringify({ closed: smartGen.closed, before: smartGen.before, after: smartGen.after, title: smartGen.title }));
  check('智能编辑：描述原样带进新节点', /青花瓷盘/.test(smartGen.prompt), smartGen.prompt.slice(0, 40));
  // 这条是整个功能的立论：交给模型的是**画了标记的那张图**，不是遮罩
  check('智能编辑：传给模型的是标注图（点 / 箭头位置是红的，没标的地方原样）',
    smartGen.upSize && smartGen.upSize[0] === 512
      && smartGen.upDot && smartGen.upDot[0] > 180 && smartGen.upDot[1] < 130
      && smartGen.upArrow && smartGen.upArrow[0] > 150 && smartGen.upArrow[1] < 140
      && JSON.stringify(smartGen.upCorner) === JSON.stringify(smartGen.srcCorner),
    JSON.stringify({ size: smartGen.upSize, dot: smartGen.upDot, arrow: smartGen.upArrow,
      corner: smartGen.upCorner, srcCorner: smartGen.srcCorner }));
  check('智能编辑：上传的是标注图本身（<节点id>-edit.png，不是 -mask.png）',
    /^.+-edit\.png$/.test(smartGen.upName || '') && !/-mask\.png$/.test(smartGen.upName || ''),
    smartGen.upName);
  check('智能编辑：新节点上**没有遮罩**（这条路不走遮罩）', smartGen.maskPill === false, String(smartGen.maskPill));
  check('智能编辑：原节点的图一个字节都没动', smartGen.srcSrc === smartPick.src,
    `${(smartPick.src || '').slice(0, 40)} → ${(smartGen.srcSrc || '').slice(0, 40)}`);
  check('智能编辑：一条龙——不用再点一次生成，已经提交了', smartGen.runs >= 1, String(smartGen.runs));

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
  if (e instanceof StopRun) {
    console.log(`\n（${e.message} 命中，提前收工）`);
  } else {
    // 带上栈：只有一句 message 时，翻半天也定位不到是哪一步炸的（真踩过）
    check('运行过程未抛错', false, String(e && e.stack ? e.stack : e));
  }
} finally {
  if (page) await page.close();
  if (chromeCtx) await stopChrome(chromeCtx);
  await server.stop();
  rmDir(dataDir);
}

const skipped = results.filter((r) => r.skipped);
const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 项：通过 ${results.length - failed.length - skipped.length}`
  + `${skipped.length ? ` · 跳过 ${skipped.length}` : ''} · 失败 ${failed.length}`);
if (skipped.length) {
  console.log('跳过的（环境相关，不是没测）：');
  for (const s of skipped) console.log(`  - ${s.name}：${s.detail}`);
}
if (fs.existsSync(path.join(TMP, 'chrome-profile'))) {
  rmDir(path.join(TMP, 'chrome-profile'));
}
process.exit(failed.length ? 1 : 0);

