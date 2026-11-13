/**
 * InfiSheet 前端静态检查。
 *
 * 只查「会变成 bug」的东西，不查风格 —— 风格交给 prettier，两边不打架。
 * 之所以不全开 recommended：这个前端是一个 1.3 万行的 IIFE，历史代码里有大量
 * `var`、隐式全局、`arguments` 这类写法，一次性全开只会得到几千条噪音，
 * 团队会直接关掉检查。规则分三层，见 docs/工程规范.md「静态检查」一节。
 */
import js from '@eslint/js';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  Image: 'readonly',
  Audio: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  DOMException: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  KeyboardEvent: 'readonly',
  PointerEvent: 'readonly',
  MouseEvent: 'readonly',
  WheelEvent: 'readonly',
  DragEvent: 'readonly',
  ClipboardEvent: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  CSS: 'readonly',
  HTMLElement: 'readonly',
  HTMLCanvasElement: 'readonly',
  HTMLImageElement: 'readonly',
  Element: 'readonly',
  Node: 'readonly',
  NodeList: 'readonly',
  getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  console: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  matchMedia: 'readonly',
  DOMParser: 'readonly',
  XMLSerializer: 'readonly',
  createImageBitmap: 'readonly',
  OffscreenCanvas: 'readonly',
  Path2D: 'readonly',
  ImageData: 'readonly',
  DeviceOrientationEvent: 'readonly',
  Notification: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  history: 'readonly',
  screen: 'readonly',
  // static/icons.js 挂到 window 上的图标工厂：index.html 先加载 icons.js 再加载 app.js，
  // 所以 app.js 里能直接用。这是一处**隐式跨文件依赖**，靠这里的声明显式记下来，
  // 否则 ESLint 会把它当成拼错的变量名（也确实是这个仓库最容易踩的坑）。
  icon: 'readonly',
  WebSocket: 'readonly',
  AbortSignal: 'readonly',
  innerWidth: 'readonly',
  innerHeight: 'readonly',
  devicePixelRatio: 'readonly',
  isSecureContext: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'dist/**', 'tests/.tmp/**', 'tests/fixtures/**'],
  },
  {
    // 前端：浏览器脚本，不是 ESM（整个文件包在一个 IIFE 里）
    files: ['static/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: browserGlobals,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      ...js.configs.recommended.rules,

      // —— 第一层：一定是 bug，必须修 ——
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-obj-calls': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-async-promise-executor': 'error',
      'no-misleading-character-class': 'error',
      'no-prototype-builtins': 'error',
      'no-empty-pattern': 'error',
      // 中文界面里用全角空格（U+3000）做分隔是刻意的，只查代码里的异常空白
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipTemplates: true }],
      // `[, 'png']` 这种「跳过第 0 位」的写法在本仓库出现过多次，是刻意占位，不是漏写
      'no-sparse-arrays': 'off',

      // —— 第二层：八成是笔误，先当警告看，逐条清 ——
      'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',      // catch 里留个 err 方便调试，不算问题
      }],
      'no-redeclare': 'warn',
      'no-var': 'off',             // 历史代码大量 var，一次性改风险大于收益
      'prefer-const': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // —— 第三层：明确关掉，避免噪音 ——
      'no-console': 'off',
      'no-alert': 'off',
    },
  },
  {
    // 测试与工具：Node ESM，允许顶层 await 与 Node 全局
    files: ['tests/**/*.mjs', 'tools/**/*.{mjs,cjs}', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        structuredClone: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        WebSocket: 'readonly',      // tests/e2e/cdp.mjs 直连 DevTools 协议
        AbortSignal: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
