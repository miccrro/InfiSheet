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
const server = await startServer({ port, dataDir });
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
    `const RUN_CAP = 30;\n${pickFn(appSrc, 'runsOf')}\n${pickFn(appSrc, 'pushRun')}\nreturn { runsOf, pushRun };`)();
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
    && /refMarks\(rawPrompt/.test(genSrc),
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

  // 拿真实预设再过一遍：内置四个里三个的宽高是连线，这条就是防「面板选了尺寸、提交图上没写」的回归
  const presetRows = fs.readdirSync(path.join(ROOT, 'presets')).filter((f) => f.endsWith('.json')).map((f) => {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets', f), 'utf8')).graph;
    const t = dimsTarget(g);
    const r = buildGenGraph(g, [], { width: 1280, height: 720 }, 1, 'p', null);
    return { f: f.replace(/\.(api\.)?json$/, ''), t, sized: r.sized, w: t ? r.graph[t].inputs.width : 0, h: t ? r.graph[t].inputs.height : 0 };
  });
  check('四个内置预设全部钉得住尺寸（含三个从 ResolutionSelector 连线的）',
    presetRows.length === 4 && presetRows.every((p) => p.sized && p.w === 1280 && p.h === 720),
    presetRows.map((p) => `${p.f}→${p.t || '无'}:${p.w}×${p.h}`).join(' | '));

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

  // 连线是三次贝塞尔（两端水平切线），不是「横 → 竖 → 横」的折线
  const curve = await page.evaluate(`(() => {
    const d = document.querySelector('#links .link-line').getAttribute('d') || '';
    return { d, cubic: /^M [\\d.-]+ [\\d.-]+ C /.test(d), ortho: /[HVQ]/.test(d) };
  })()`);
  check('连线走三次贝塞尔（不是折线）', curve.cubic && !curve.ortho, curve.d.slice(0, 46));

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
    const mk = (i) => ({ url: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="' + ['#c33', '#3c3', '#33c', '#cc3'][i] + '"/></svg>'), filename: 'k' + i + '.svg', subfolder: 'comfy-canvas', type: 'output' });
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
    localStorage.setItem('comfy-canvas-project', pr.id);
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
    const id = localStorage.getItem('comfy-canvas-project');
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

  const consoleErrors = page.errors.filter((e) => !/favicon/.test(e.text || ''));
  // 只打 text 的话永远只看到「Uncaught」——把 detail / 位置也带上，否则报错了也查不出是哪一行
  const errText = (e) => [e.text, e.detail, e.url && `${e.url}:${e.line}`].filter(Boolean).join(' ');
  check('控制台无报错', consoleErrors.length === 0, consoleErrors.map(errText).join(' | '));

  const shotDir = path.join(TMP, 'shots');
  await page.screenshot(path.join(shotDir, 'e2e-canvas.png'));
  console.log(`\n截图：${shotDir}\\e2e-canvas.png`);
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

