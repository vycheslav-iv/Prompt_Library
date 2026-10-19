// Временный смоук-тест (не для репозитория): исполняет web/js/prompt_library.js
// в vm-контексте с заглушками DOM/LiteGraph, прогоняет жизненный цикл в обоих
// режимах и проверяет ЖИВУЮ смену режима (canvas ↔ Nodes 2.0) обоими сигналами.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Путь от самого теста (tests/ → .. = папка проекта), а не от cwd:
// работает и из папки проекта, и из любой другой директории (AGENTS.md §1.1).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = path.join(ROOT, "web", "js", "prompt_library.js");
const errors = [];
const check = (label, cond) => { if (!cond) errors.push(`ASSERT FAIL: ${label}`); };

function makeStyle() {
  const t = {};
  return new Proxy(t, {
    get(o, p) {
      if (p === "setProperty" || p === "removeProperty") return () => {};
      return o[p] ?? "";
    },
    set(o, p, v) { o[p] = v; return true; },
  });
}

function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: makeStyle(), children: [], childNodes: [], dataset: {}, parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); el.children.push(c); c.parentNode = el; return c; },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i >= 0) el.children.splice(i, 0, c); else el.children.push(c);
      c.parentNode = el; return c;
    },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    append(...cs) { cs.forEach((c) => el.appendChild(c)); },
    replaceChildren(...cs) { el.children = []; cs.forEach((c) => el.appendChild(c)); },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    contains(c) { let p = c; while (p) { if (p === el) return true; p = p.parentNode; } return false; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],    // Vue-нода: [data-node-id] — сюда applyNodeMinWidth пишет min-width
    closest: (sel) => (sel === "[data-node-id]" ? nodeElStub : null),
    focus() {}, blur() {}, click() {}, scrollIntoView() {},
    getContext: () => ({ drawImage() {} }), toDataURL: () => "data:,",
    cloneNode: () => makeEl(tag),
    getBoundingClientRect: () => ({ width: 480, height: 596, top: 0, left: 0, right: 480, bottom: 596, x: 0, y: 0 }),
    dispatchEvent: () => true,
    [Symbol.iterator]: function* () {},
    value: "", textContent: "", placeholder: "", title: "", type: "",
    rows: 0, checked: false, disabled: false, src: "", href: "", id: "", className: "",
    offsetHeight: 596, offsetWidth: 480, scrollHeight: 596, clientHeight: 596, scrollTop: 0,
    naturalWidth: 100, naturalHeight: 100, complete: true,
  };
  // innerHTML как в браузере: присвоение "" реально чистит детей. Раньше это
  // было обычное свойство, поэтому список/дерево «накапливали» карточки между
  // рендерами и посчитать их было нельзя (v1.27).
  let _html = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => _html,
    set: (v) => { _html = String(v == null ? "" : v); if (_html === "") el.children = []; },
    configurable: true,
  });
  // textContent как в браузере: чтение — склейка текста ПОТОМКОВ, запись — свой
  // текст (и сброс прежних детей). Раньше это было обычное свойство, поэтому
  // заголовок карточки, собранный из пролётов (иконки + имя), читался как пустой
  // — тест падал бы «на пустом месте», хотя в браузере текст виден.
  let _text = "";
  Object.defineProperty(el, "textContent", {
    get: () => (el.children && el.children.length ? el.children.map(readTextStub).join("") : _text),
    set: (v) => { _text = String(v == null ? "" : v); el.children = []; },
    configurable: true,
  });
  return el;
}
// Текст поддерева: у листа — его собственный textContent (геттер ниже).
const readTextStub = (x) => (x.children && x.children.length
  ? x.children.map(readTextStub).join("")
  : String(x.textContent == null ? "" : x.textContent));

// «Элемент ноды» для проверки applyNodeMinWidth (в реальности — `.lg-node[data-node-id]`)
class HTMLElementStub {
  constructor() { this.style = makeStyle(); this.dataset = {}; this.classList = { add() {}, remove() {} }; }
}
const nodeElStub = new HTMLElementStub();

// Всё созданное через createElement/Image — в реестре: фазы кадров из файла
// должны иметь доступ к <video>, чтобы вручную поднять его события.
const madeEls = [];

const documentStub = {
  createElement: (t) => { const el = makeEl(t); madeEls.push(el); return el; },
  // Текстовый узел ОБЯЗАН нести текст: раньше заглушка теряла аргумент, и
  // карточка с заголовком-текстовым-узлом выглядела «без названия» — тест
  // доказывал бы то, чего нет в браузере (ftext/`firstTitle` читают текст).
  createTextNode: (t) => { const el = makeEl("text"); el.textContent = String(t == null ? "" : t); return el; },
  createDocumentFragment: () => makeEl("fragment"),
  body: makeEl("body"), head: makeEl("head"), documentElement: makeEl("html"),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
};

const storage = new Map();
const localStorageStub = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const jsonResponse = (data) => ({
  ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data),
  blob: async () => ({}), headers: { get: () => null },
});
// Заготовка ответа /prompt_library/list для фаз со слотами (создаётся в mkSlotNode).
// Нужна потому, что нода при создании сама тянет список (`reload()` в
// onNodeCreated), и его ответ приходит ПОЗЖЕ, чем фаза выставила свои записи —
// без общей ссылки «догоняющий» reload затирал бы тестовые entries данными
// предыдущей фазы (именно это валило фазу папки-вывода).
let listOverride = null;
// Геттеры, а не снимок: ответ /list читается в момент РАЗБОРА, поэтому в нём
// всегда актуальные массивы текущей фазы (иначе уже запущенный запрос приносил бы
// данные той фазы, в которой он был отправлен).
const listResponse = {
  get entries() { return (listOverride && listOverride.entries) || []; },
  get folders() { return (listOverride && listOverride.folders) || []; },
};
const fetchStub = async (u) => String(u).includes("/prompt_library/list")
  ? jsonResponse(listResponse) : jsonResponse({});

const rafQueue = [];
const settingsListeners = {};
const settingsStub = {
  get: (id) => (id === "Comfy.VueNodes.Enabled" ? settingsVueEnabled : undefined),
  set() {}, setSettingValue() {}, getSettingValue: (id) => settingsStub.get(id),
  addEventListener(type, cb) { (settingsListeners[type] ??= []).push(cb); },
  removeEventListener(type, cb) {
    const arr = settingsListeners[type] ?? [];
    const i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  },
  dispatchChange(id, value) {
    for (const cb of settingsListeners[id + ".change"] ?? []) cb({ detail: { value } });
  },
};
let settingsVueEnabled = false;
// Авторитетный флаг фронтенда (useVueFeatureFlags → LiteGraph.vueNodesMode)
const LG = { vueNodesMode: false };
let captured = null;

const flushRaf = (label) => {
  let n = 0;
  while (rafQueue.length) {
    const cb = rafQueue.shift();
    if (++n > 50) throw new Error("RAF runaway (>50)");
    try { cb(); } catch (e) {
      errors.push(`[rAF ${label}] ${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
    }
  }
};

// app.api — ComfyApi (EventTarget) в реальном фронтенде 1.52: addEventListener
// добавляет тип в его _registered, а WS-сообщение приходит CustomEvent'ом.
const apiListeners = {};
const apiStub = {
  fetchApi: async () => ({}),
  addEventListener(type, cb) { (apiListeners[type] ??= []).push(cb); },
  removeEventListener(type, cb) {
    const arr = apiListeners[type] ?? [];
    const i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  },
  dispatch(type, detail) { for (const cb of [...(apiListeners[type] ?? [])]) cb({ type, detail: detail || {} }); },
};

const appStub = {
  registerExtension(ext) { captured = ext; },
  extensionManager: {
    toast: { add() {} },
    dialog: { confirm: async () => true, prompt: async () => null },
    setting: { get: (id) => settingsStub.get(id), set() {}, setSettingValue() {} },
    command: { registerCommand() {}, execute() {} },
    registerExtension() {},
  },
  graph: { setDirtyCanvas() {}, links: {}, getNodeById: () => null, _nodes: [] },
  canvas: { ds: { scale: 1, offset: [0, 0] }, draw() {}, setDirty() {}, canvas: makeEl("canvas") },
  ui: { dialog: {}, settings: settingsStub },
  api: apiStub,
  workflowManager: { activeWorkflow: null, openWorkflow: async () => {} },
  loadGraphData: async () => {},
};

const windowStub = {
  comfyAPI: { app: { app: appStub, ComfyApp: {}, ComfyAppSetup: appStub } },
  document: documentStub, localStorage: localStorageStub, LiteGraph: LG,
  addEventListener() {}, removeEventListener() {},
  innerWidth: 1920, innerHeight: 1080,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  showDirectoryPicker: undefined, // v1.33: включается в фазе экспорта
};
windowStub.window = windowStub;

const sandbox = {
  window: windowStub, document: documentStub, localStorage: localStorageStub, console,
  fetch: fetchStub, confirm: () => true, alert: () => {}, prompt: () => null,
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
  cancelAnimationFrame: () => {}, setTimeout, clearTimeout, setInterval, clearInterval,
  navigator: { userAgent: "node", clipboard: { writeText: async () => {} } },
  location: { href: "http://localhost/", origin: "http://localhost" },
  HTMLElement: HTMLElementStub,
  Image: function () { const el = makeEl("img"); madeEls.push(el); return el; },
  URL: { createObjectURL: () => "blob:", revokeObjectURL() {} },
  Blob: function () {}, FileReader: function () { this.readAsDataURL = () => {}; },
  structuredClone: (v) => JSON.parse(JSON.stringify(v)),
  TextDecoder, TextEncoder, // v1.57: нужны pngChunks (tEXt/iTXt читаются в UTF-8)
};
sandbox.globalThis = sandbox;

const src = fs.readFileSync(FILE, "utf8");
vm.runInContext(src, vm.createContext(sandbox), { filename: FILE });
if (!captured) { console.log("NO EXTENSION CAPTURED"); process.exit(1); }

function makeNode() {
  const widgets = [
    { name: "mode", value: "📥 Запись", type: "combo", options: {}, callback: null, serialize: true },
    { name: "selected", value: "", type: "text", options: {}, callback: null, serialize: true },
    { name: "save_folder", value: "", type: "text", options: {}, callback: null, serialize: true },
    { name: "pickup", value: "", type: "text", options: {}, callback: null, serialize: true },
    { name: "slots_out", value: "[]", type: "text", options: { hidden: true, hideInPanel: true }, serialize: true },
    // v1.72: основной выход держит ТОЛЬКО active (selected — про выделение)
    { name: "active", value: "", type: "text", options: { hidden: true, hideInPanel: true }, serialize: true },
    // v1.73 (§61): путь категории — пишет ДВОЙНОЙ клик по папке. options
    // пустые: hideInPanel ставит сам onNodeCreated (иначе проверка скрытия
    // была бы слепо-зелёной уже на старом коде).
    { name: "cat_pick", value: "", type: "text", options: {}, serialize: true },
  ];
  const node = {
    id: 1, pos: [0, 0], size: [470, 700], flags: {}, bgcolor: null, widgets,
    inputs: [{ name: "source", type: "*", link: null }, { name: "image", type: "IMAGE", link: null }],
    // Как node def после v1.44: 12 выходов, localized_name — из RU-локали
    // (index-based, см. resolveNodeDefSlotText в litegraphService.ts).
    outputs: [
      { name: "category_path", type: "STRING", localized_name: "путь категории", links: [] },
      { name: "prompt_1", type: "STRING", localized_name: "промпт 1 (основной)", links: [] },
      { name: "prompt_2", type: "STRING", localized_name: "промпт 2", links: [] },
      { name: "prompt_3", type: "STRING", localized_name: "промпт 3", links: [] },
      { name: "prompt_4", type: "STRING", localized_name: "промпт 4", links: [] },
      { name: "prompt_5", type: "STRING", localized_name: "промпт 5", links: [] },
      { name: "prompt_6", type: "STRING", localized_name: "промпт 6", links: [] },
      { name: "prompt_7", type: "STRING", localized_name: "промпт 7", links: [] },
      { name: "prompt_8", type: "STRING", localized_name: "промпт 8", links: [] },
      { name: "prompt_9", type: "STRING", localized_name: "промпт 9", links: [] },
      { name: "prompt_10", type: "STRING", localized_name: "промпт 10", links: [] },
      { name: "prompt_11", type: "STRING", localized_name: "промпт 11", links: [] },
    ],
    graph: { setDirtyCanvas() {}, links: {}, getNodeById: () => null, _nodes: [] },
    addWidget(type, name, value, cb, opts) {
      const w = { name, value, type, callback: cb, options: opts || {}, serialize: true };
      widgets.push(w); return w;
    },
    addDOMWidget(name, type, el, opts) {
      const w = { name, type, element: el, options: opts || {}, computeSize: null };
      widgets.push(w); node._dom = w; return w;
    },
    addInput(name, type) { const i = { name, type, link: null }; node.inputs.push(i); return i; },
    removeInput(idx) { node.inputs.splice(idx, 1); },
    disconnectInput(i) { if (node.inputs[i]) node.inputs[i].link = null; },
    disconnectOutput(i) { if (node.outputs[i]) node.outputs[i].links = []; },
    // Как в LGraphNode: removeOutput отключает свой сокет и переезжает номера
    // ссылок у следующих (link.origin_slot--), addOutput кладёт сокет в конец.
    removeOutput(i) {
      if (i < 0 || i >= node.outputs.length) return;
      if (node.outputs[i]) node.outputs[i].links = [];
      node.outputs.splice(i, 1);
      for (const holder of node._testLinks || []) if (holder.slot > i) holder.slot--;
    },
    addOutput(name, type, opts) {
      const o = Object.assign({ name, type, links: [] }, opts || {});
      node.outputs.push(o);
      return o;
    },
    connect() { return true; },
    setSize(s) { node.size = s; }, setDirtyCanvas() {},
    getExtraMenuOptions: () => [], onResize: null,
    element: makeEl("div"), computeSize: () => [470, 700],
  };
  return node;
}

let okCount = 0;
const run = async (label, fn) => {
  try { await fn(); okCount++; } catch (e) {
    errors.push(`[${label}] ${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
  }
  flushRaf(label);
};

const proto = {};
const nodeType = function () {};
nodeType.prototype = proto;

// Общая раскладка панелей: пол 480px в ОБОИХ режимах (иначе в Vue нода
// сжималась «в ноль» и панели исчезали).
function checkCommon(tag, st) {
  check(`${tag}: height не фиксирован`, st.tree.style.height === "" && st.list.style.height === "");
  // одинаково в обоих режимах: обрезка + отказ от собственных 400px
  check(`${tag}: root обрезает содержимое`, st.root.style.overflow === "hidden");
  check(`${tag}: root без собственного min-width`, st.root.style.minWidth === "0");
  // Версию берём ИЗ ИСХОДНИКА, а не строкой в тесте: иначе каждая правка
  // PL_JS_VERSION роняла смоук и приходилось править тест (проверка сама себя
  // не проверяет — важно, что версия есть и нода её видит).
  const jsVer = (src.match(/PL_JS_VERSION = "([^"]+)"/) || [])[1] || "";
  check(`${tag}: версия JS видна`, !!jsVer && st.version === jsVer, `js=${jsVer} st=${st.version}`);
  // v1.25: строка подхвата — первая в root (это настройка, как виджет режима),
  // фиксированной высоты; селектор собирает узлы-источники из живого графа.
  check(`${tag}: строка подхвата первая в root`, st.root.children[0] === st.pickupRow);
  check(`${tag}: селектор подхвата создан`, !!st.pickupSel
    && st.pickupSel.children.length >= 1 && st.pickupSel.children[0].value === "");
}

// Канвас: панели СЖИМАЮТСЯ (flex 1 1 0 + min-height:0) — тот же clamp, что в Vue.
// Полом был min-height:480px на панелях: когда реального места меньше пола
// (панель книги до 320px против номинальных DETAIL_H=280, другой шрифт/зум),
// контент вылезал за root и detail его перекрывал — низ списка с кнопками.
function checkCanvasPanes(tag, st) {
  check(`${tag}: tree сжимается (без пола)`, st.tree.style.flex === "1 1 0" && st.tree.style.minHeight === "0");
  check(`${tag}: list сжимается (без пола)`, st.list.style.flex === "1 1 0" && st.list.style.minHeight === "0");
  check(`${tag}: main сжимается и обрезает`,
    st.main.style.flex === "1 1 0" && st.main.style.minHeight === "0" && st.main.style.overflow === "hidden");
}

// Vue: пол перенесён на scrollArea (только он попадает в замер min-content,
// который в Vue задаёт высоту ноды) и равен канвасному — ноду нельзя сжать
// сильнее, чем в старом режиме.
function checkVuePanes(tag, st, area) {
  check(`${tag}: tree заполняет окно`, st.tree.style.flex === "1 1 0" && st.tree.style.minHeight === "0");
  check(`${tag}: list заполняет окно`, st.list.style.flex === "1 1 0" && st.list.style.minHeight === "0");
  check(`${tag}: пол на scrollArea`, area.style.minHeight === "480px" && area.style.flex === "1 1 0" && area.style.overflowY === "auto");
}

const nodes = [];

// Патч прототипа — один раз на тип ноды, как в реальном ComfyUI
await run("beforeRegisterNodeDef", () =>
  captured.beforeRegisterNodeDef(nodeType, { name: "PromptLibrary", input: {}, output: {} }));

for (const vue of [false, true]) {
  LG.vueNodesMode = vue;
  settingsVueEnabled = vue;
  const tag = vue ? "VUE" : "CANVAS";
  const node = makeNode(); nodes.push({ tag, node });
  const root = () => node._pl.root;
  const scrollAreaOf = () => root().children.find((c) => c.style && c.style.overflowY === "auto" && c.children.includes(node._pl.detail));

  await run(`${tag}:onNodeCreated`, () => proto.onNodeCreated.call(node));
  await run(`${tag}:onConfigure`, () => proto.onConfigure.call(node, {
    widgets_values: ["📥 Запись", "", "Fs/FAS"],
    widgets_values_named: { mode: "📥 Запись", selected: "", save_folder: "Fs/FAS" },
  }));
  await run(`${tag}:onConnectionsChange`, () => proto.onConnectionsChange?.call(node, 1, true, {}, {}, {}));
  await run(`${tag}:onResize`, () => node.onResize?.([470, 900], [0, 0]));

  const st = node._pl;
  if (!st) { errors.push(`${tag}: st отсутствует`); continue; }

  await run(`${tag}:reload`, () => st.reload?.());
  await run(`${tag}:syncSaveFolder`, () => st.syncSaveFolder?.());
  await run(`${tag}:renderTree`, () => st.renderTree?.());
  await run(`${tag}:render`, () => st.render?.());
  await run(`${tag}:applyPaneLayout`, () => st.applyPaneLayout?.());
  await run(`${tag}:applyNodeMinWidth`, () => st.applyNodeMinWidth?.());
  await run(`${tag}:enforceMinWidth`, () => st.enforceMinWidth?.());
  await run(`${tag}:syncNodeSize`, () => st.syncNodeSize?.());
  await run(`${tag}:hookCanvasDrop`, () => st.hookCanvasDrop?.());
  await run(`${tag}:checkCycle`, () => st.checkCycle?.());
  await run(`${tag}:ensureIssueSafe`, () => st.ensureIssueSafe?.());
  await run(`${tag}:plDrop`, () => st.plDrop?.({ preventDefault() {}, dataTransfer: { getData: () => "" }, clientY: 0 }));
  await run(`${tag}:toast`, () => st.toast?.("info", "s", "d"));
  await run(`${tag}:mode callback`, async () => {
    const mw = node.widgets.find((w) => w.name === "mode");
    if (mw && typeof mw.callback === "function") { mw.value = "📤 Выдача"; await mw.callback(mw.value); }
  });
  await run(`${tag}:toggle input`, () => {
    const found = [];
    const walk = (el) => { if (!el?.children) return; for (const c of el.children) { found.push(c); walk(c); } };
    walk(st.root);
    for (const b of found) if (typeof b.onclick === "function" && b.onclick.length === 0) {
      try { b.onclick(); } catch (e) { /* часть кнопок хочет аргументы */ }
    }
  });

  checkCommon(tag, st);
  check(`${tag}: isVueNodes = флаг LiteGraph`, st.isVueNodes() === vue);
  if (vue) {
    check(`${tag}: main+detail в scrollArea`, st.detail.parentNode !== st.root && scrollAreaOf() !== undefined);
    const area = scrollAreaOf();
    checkVuePanes(tag, st, area);
    check(`${tag}: scrollArea перед нижней строкой`, st.root.children.indexOf(area) < st.root.children.indexOf(st.hintRow));
    check(`${tag}: min-width ноды = MIN_W`, nodeElStub.style.minWidth === `${470}px`);
  } else {
    check(`${tag}: main+detail прямые дети root`, st.detail.parentNode === st.root);
    check(`${tag}: scrollArea нет в root`, scrollAreaOf() === undefined);
    check(`${tag}: 8 детей root (подхват + ряд экспорта + 6)`,
      st.root.children.length === 8 && st.root.children[7] === st.hintRow,
      String(st.root.children.length));
    checkCanvasPanes(tag, st);
  }
  console.log(`--- ${tag}: ok, root children=${st.root.children.length} ---`);
}

// --- ЖИВАЯ смена режима (без reload) ---
const canvasNode = nodes.find((n) => n.tag === "CANVAS");
const stC = canvasNode.node._pl;
const areaOf = (st) => st.root.children.find((c) => c.style && c.style.overflowY === "auto" && c.children.includes(st.detail));

await run("switch: canvas → Vue через LiteGraph.vueNodesMode", () => {
  // нода, созданная в canvas-режиме, после переключения флага должна сама
  // перейти в Vue-раскладку (шаг выше уже перевёл её в Vue — возвращаем назад)
  LG.vueNodesMode = false;
  check("после возврата — canvas-раскладка", areaOf(stC) === undefined && stC.root.children.length === 8);
  LG.vueNodesMode = true; // именно это делает фронтенд в useVueFeatureFlags
  check("после флага — Vue-раскладка", areaOf(stC) !== undefined && stC.root.style.overflow === "hidden");
  check("пол переехал на scrollArea", areaOf(stC).style.minHeight === "480px");
  check("_vuePanes обновился", stC._vuePanes === true);
  // ключевой фикс: min-width применяется ПОСЛЕ монтирования Vue-ноды (rAF)
  check("min-width ноды применён после монтирования", nodeElStub.style.minWidth === "470px");
});
await run("switch: Vue → canvas через LiteGraph.vueNodesMode", () => {
  nodeElStub.style.minWidth = ""; // сбрасываем, чтобы проверить повторное применение
  LG.vueNodesMode = false;
  check("вернулись в canvas-раскладку", areaOf(stC) === undefined);
  check("8 детей root", stC.root.children.length === 8);
  check("обрезка осталась (не зависит от режима)", stC.root.style.overflow === "hidden");
  checkCanvasPanes("после возврата", stC);
});
await run("switch: событие настроек (страховка)", () => {
  settingsStub.dispatchChange("Comfy.VueNodes.Enabled", true);
  check("событие переключило раскладку", areaOf(stC) !== undefined);
  settingsStub.dispatchChange("Comfy.VueNodes.Enabled", false);
  check("событие вернуло canvas", areaOf(stC) === undefined);
});
await run("fallback: без window.LiteGraph работает чтение настройки", () => {
  const saved = windowStub.LiteGraph;
  windowStub.LiteGraph = undefined;
  settingsVueEnabled = true;
  check("настройка даёт Vue-режим", stC.isVueNodes() === true);
  settingsVueEnabled = false;
  check("настройка даёт canvas", stC.isVueNodes() === false);
  windowStub.LiteGraph = saved;
});
await run("onRemoved отписывает ноду от смены режима", () => {
  proto.onRemoved.call(canvasNode.node);
  LG.vueNodesMode = true; // не должно ничего сломать
});

// --- checkCycle не должен просить перерисовку без смены состояния ---------
// (checkCycle зовётся из onDrawForeground: безусловный setDirtyCanvas там = вечный repaint)
await run("checkCycle: без изменений — без запросов перерисовки", () => {
  const node = makeNode();
  let dirty = 0;
  node.graph.setDirtyCanvas = () => { dirty++; };
  proto.onNodeCreated.call(node);
  node._pl.checkCycle(); node._pl.checkCycle();
  check("спокойное состояние не дёргает канвас", dirty === 0, `dirty=${dirty}`);

  // кольцо: image подключён + выход ведёт куда-то → ровно одна перерисовка на смену
  node.inputs.find((i) => i.name === "image").link = 7;
  node.outputs[0].links = [3];
  const before = dirty;
  node._pl.checkCycle();
  check("кольцо подсвечивается одним запросом", dirty === before + 1, `dirty=${dirty}`);
  node._pl.checkCycle();
  check("повторный вызов не дёргает канвас", dirty === before + 1, `dirty=${dirty}`);

  // снятие кольца — снова ровно одна перерисовка
  node.inputs.find((i) => i.name === "image").link = null;
  const mid = dirty;
  node._pl.checkCycle();
  check("снятие кольца — один запрос", dirty === mid + 1, `dirty=${dirty}`);
  node._pl.checkCycle();
  check("после снятия — тишина", dirty === mid + 1, `dirty=${dirty}`);
});

// --- Мультивыделение: диапазон и эксклюзив (исполнение настоящего кода) ---
await run("marks: диапазон + эксклюзив карточки/папки", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const mk = (id) => ({ id, title: id, head: id, folder: "", favorite: false,
    created_at: "2026-09-18T01:00:00", last_used: null,
    has_preview: false, has_workflow: false, media: "image" });
  st.entries = [mk("e1"), mk("e2"), mk("e3")];
  st.folders = ["A", "B", "C"];
  st.selFolder = "__all";
  st.renderTree(); st.render();
  st.markEntryToggle("e1", false);
  check("ctrl: карточка помечена", st.markEntries.has("e1"));
  st.markEntryToggle("e3", true);
  check("shift: диапазон e1..e3",
    st.markEntries.has("e1") && st.markEntries.has("e2") && st.markEntries.has("e3"));
  st.markFolderToggle("A", false);
  check("эксклюзив: папка с зажатым модификатором не метится, карточки целы",
    st.markFolders.size === 0 && st.markEntries.size === 3);
  st.clearMarks();
  st.markFolderToggle("A", false);
  check("папки метятся когда карточки не помечены", st.markFolders.has("A"));
  st.markFolderToggle("C", true);
  check("shift: диапазон папок A..C",
    ["A", "B", "C"].every((k) => st.markFolders.has(k)));
  st.markEntryToggle("e2", false);
  check("эксклюзив: карточка с зажатым модификатором не метится, папки целы",
    st.markEntries.size === 0 && st.markFolders.size === 3);
  st.renderHint(3);
  // v1.52–v1.53: внизу остался только СЧЁТЧИК (статус); оба массовых ДЕЙСТВИЯ
  // («🗑 Удалить» и «✖ снять метки») уехали в ряд действий и стоят РЯДОМ справа.
  check("в нижней строке остался только счётчик меток",
    st.hintRow && st.hintRow.children.includes(st.bulkCount)
      && !st.hintRow.children.includes(st.bulkDel)
      && !st.hintRow.children.includes(st.bulkClear));
  check("«🗑 Удалить» и «✖» — последние в ряду действий, РЯДОМ (пара)",
    st.exportRow.children.includes(st.bulkDel)
      && st.exportRow.children.includes(st.bulkClear)
      && st.exportRow.children[st.exportRow.children.length - 2] === st.bulkDel
      && st.exportRow.children[st.exportRow.children.length - 1] === st.bulkClear,
    st.exportRow.children.map((c) => c.textContent).join(" | "));
  check("пару прижимает вправо «🗑» (margin-left:auto), высоту не меняет (flex-shrink:0)",
    String(st.bulkDel.style.cssText).includes("margin-left:auto")
      && String(st.bulkDel.style.cssText).includes("flex-shrink:0")
      && String(st.bulkClear.style.cssText).includes("flex-shrink:0")
      && String(st.exportRow.style.cssText).includes("height:22px"));
  // v1.53: место при нехватке ширины отдаёт ПОДПИСЬ ряда, а не кнопки (живой
  // замер `_probe_live_dom.py --export-row`: на MIN_W сжимались именно кнопки).
  // (читаем cssText строкой: стенд — заглушка DOM и шорткат `flex`
  // в отдельные flexShrink/flexBasis не раскладывает)
  check("подпись ряда сжимаема (эллипсис), кнопки экспорта — нет",
    String(st.exportCaption.style.cssText).includes("text-overflow:ellipsis")
      && String(st.exportCaption.style.cssText).includes("flex:0 1 auto")
      && [st.exportBtn, st.galleryBtn, st.importBtn]
        .every((b) => String(b.style.cssText).includes("flex-shrink:0")),
    st.exportCaption.style.cssText);
  check("метки: строка внизу фиксирована, счётчик сжимается, «✖» видна",
    String(st.hintRow.style.cssText).includes("height:22px")
    && String(st.hintRow.style.cssText).includes("flex-shrink:0")
    && String(st.bulkCount.style.cssText).includes("min-width:0")
    && String(st.bulkClear.style.cssText).includes("flex-shrink:0"));
  check("метки: hint скрыт, кнопки показаны (удаление — в ряду сверху)",
    st.hint.style.display === "none" && st.bulkDel.style.display === ""
      && st.bulkClear.style.display === ""
      && st.bulkCount.textContent === "Помечено — категорий: 3.");
  check("hint остался текстом в одну строку",
    String(st.hint.style.cssText).includes("nowrap") && typeof st.hint.textContent === "string");
  st.clearMarks();
  st.renderHint(0);
  check("метки сняты: hint вернулся, кнопки скрыты",
    st.hint.style.display === "" && st.bulkDel.style.display === "none" && st.bulkClear.style.display === "none");
  st.clearMarks();
  check("clearMarks всё снял",
    st.markEntries.size === 0 && st.markFolders.size === 0
    && st.anchorEntry === null && st.anchorFolder === null);
});

// --- Переименование на месте: Enter применяет, Esc/пусто отменяет ---
await run("inlineEdit: Enter/Esc/пусто", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const host = { innerHTML: "x", children: [],
    appendChild(c) { this.children.push(c); return c; } };
  let committed = null;
  st.inlineEdit(host, "old", (v) => { committed = v; });
  const inp = host.children[0];
  check("input создан с текстом", inp && inp.value === "old");
  inp.value = "new";
  inp.onkeydown({ key: "Enter", stopPropagation() {} });
  check("Enter применил новое", committed === "new");
  committed = "sentinel";
  st.inlineEdit(host, "old", (v) => { committed = v; });
  host.children[host.children.length - 1].onkeydown({ key: "Escape", stopPropagation() {} });
  check("Esc отменил (без коммита)", committed === "sentinel");
  st.inlineEdit(host, "old", (v) => { committed = v; });
  const inp3 = host.children[host.children.length - 1];
  inp3.value = "   ";
  inp3.onkeydown({ key: "Enter", stopPropagation() {} });
  check("пустое не применяется", committed === "sentinel");
});

// --- Возврат высоты после закрытия панелей (только canvas) ---
await run("panels: panelOpened/shrinkBack", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  st._vuePanes = false;
  node.size = [470, 900];
  st.panelOpened();
  node.size = [470, 1200]; // панель открылась, нода выросла
  st.detail.style.display = "flex";
  st.shrinkBack();
  check("пока деталка открыта — высоту не трогаем", node.size[1] === 1200);
  st.detail.style.display = "none";
  st.shrinkBack();
  check("после закрытия — вернулись к запомненной", node.size[1] === 900);
  node.size = [470, 1500]; // ручной ресайз шире запомненного
  st.panelOpened();
  st.detail.style.display = "flex";
  st.detail.style.display = "none";
  st.shrinkBack();
  check("ручной ресайз не срезаем ниже запомненного", node.size[1] === 1500);
  st._vuePanes = true;
  node.size = [470, 2000];
  st.detail.style.display = "none";
  st.shrinkBack();
  check("во Vue размером владеет layout — не трогаем", node.size[1] === 2000);
});

// --- Синхронизация ДВУХ нод на одной странице (удаление карточек/папок) ---
// Сценарий пользователя: две Library-ноды в одном графе, в одной удалили
// карточку — вторая должна перечитать базу, а не показывать удалённое.
await run("sync: удаление карточки обновляет соседнюю ноду", async () => {
  const a = makeNode(); const b = makeNode();
  proto.onNodeCreated.call(a); proto.onNodeCreated.call(b);
  // стартовый reload() каждой ноды асинхронный — даём ему осесть, иначе он
  // перезапишет st.entries, который тест выставляет вручную
  await new Promise((r) => setImmediate(r));
  const sa = a._pl; const sb = b._pl;
  const mk = (id) => ({ id, title: id, head: id, folder: "", favorite: false,
    created_at: "2026-09-18T01:00:00", last_used: null,
    has_preview: false, has_workflow: false, media: "image" });
  sa.entries = [mk("e1"), mk("e2")];
  sa.selFolder = "__all";
  sa.renderTree(); sa.render();
  let bReloads = 0;
  sb.reload = () => { bReloads++; };
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push(url);
    return jsonResponse({ ok: true });
  };
  try {
    const cards = sa.list.children.filter((c) => c.draggable);
    check("карточки отрисованы", cards.length === 2, `cards=${cards.length}`);
    const buttons = [];
    const walk = (el) => { if (!el?.children) return; for (const c of el.children) { if (typeof c.onclick === "function") buttons.push(c); walk(c); } };
    walk(cards[0]);
    const del = buttons.find((x) => x.textContent === "🗑");
    check("кнопка 🗑 найдена", !!del);
    await del.onclick({ stopPropagation() {} });
    check("запрос удаления ушёл", posts.some((u) => u.includes("/prompt_library/delete")), posts.join(","));
    check("соседняя нода перечитала базу", bReloads === 1, `b=${bReloads}`);
    check(`карточка убрана локально (n=${sa.entries.length}, [${sa.entries.map((x) => x.id).join(",")}])`, sa.entries.length === 1);
  } finally { sandbox.fetch = origFetch; }
});

await run("sync: onRemoved убирает ноду из реестра", async () => {
  const a = makeNode(); const b = makeNode();
  proto.onNodeCreated.call(a); proto.onNodeCreated.call(b);
  const sa = a._pl;
  let aReloads = 0;
  sa.reload = () => { aReloads++; };
  proto.onRemoved.call(a);
  await b._pl.apiPost("/prompt_library/delete", { id: "нет-такого" });
  check("снятая нода не перечитывается", aReloads === 0, `a=${aReloads}`);
});

// --- Автообновление: broadcast prompt_library/refresh (v1.21/v1.22) ---
await run("broadcast: app.api → reload, onRemoved отписывает", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  let reloads = 0;
  st.reload = () => { reloads++; };
  check("слушатель подписан на app.api",
    (apiListeners["prompt_library/refresh"] ?? []).includes(st.apiListener));
  apiStub.dispatch("prompt_library/refresh");
  check("событие вызывает reload", reloads === 1, `reloads=${reloads}`);
  proto.onRemoved.call(node);
  apiStub.dispatch("prompt_library/refresh");
  check("после onRemoved мёртвая нода не грузит базу", reloads === 1, `reloads=${reloads}`);
  check("слушатель снят из app.api",
    !(apiListeners["prompt_library/refresh"] ?? []).includes(st.apiListener));
});

// --- Подсказка о дубликате видна без открытой панели книги ---
await run("hint: стойкое сообщение о дубле", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  proto.onExecuted.call(node, { entries: [{}], skipped_duplicate: { id: "x1", folder: "Фото" } });
  check("дубль виден в hint без открытой панели",
    String(st.hint.textContent).includes("Фото"), st.hint.textContent);
  st.render(0);
  check("стойкое сообщение переживает обычный рендер",
    String(st.hint.textContent).includes("Фото"), st.hint.textContent);
  st.hintSticky = null;
  st.render(0);
  check("после сброса hint снова обычный",
    !String(st.hint.textContent).includes("Фото"), st.hint.textContent);
});

// --- Служебный префикс __ не создаётся из UI ---
await run("folder: префикс __ отклоняется на клиенте", async () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  let toasts = 0; let posts = 0;
  st.toast = () => { toasts++; };
  const origFetch = sandbox.fetch; const origPrompt = sandbox.prompt;
  sandbox.fetch = async (u) => {
    if (String(u).includes("folder_create")) posts++;
    return jsonResponse({ ok: true, path: "x" });
  };
  sandbox.prompt = () => "__fav";
  try {
    const found = [];
    const walk = (el) => { if (!el?.children) return; for (const c of el.children) { found.push(c); walk(c); } };
    walk(st.root);
    // Именно КНОПКА, а не контейнер (v1.48: в шапке осталась она одна, и у
    // её обёртки тот же textContent — поиск по тексту ловил div)
    const btn = found.find((b) => typeof b.onclick === "function" && b.textContent === "+ Категория");
    check("кнопка «+ Категория» найдена", !!btn);
    await btn.onclick();
    check("запрос на сервер не ушёл", posts === 0, `posts=${posts}`);
    check("пользователь предупреждён", toasts === 1, `toasts=${toasts}`);
  } finally { sandbox.fetch = origFetch; sandbox.prompt = origPrompt; }
});

// --- v1.24: автоподхват обложки из прогона (без IMAGE-провода) ---
// Механика: сервер рассылает `executed` с файлами созданных картинок
// ({filename, subfolder, type}) — JS ждёт saved_id от нашей ноды, берёт первую
// картинку и после `execution_success` зовёт /attach_preview.
await run("preview: автоподхват обложки из прогона", async () => {
  const node = makeNode();
  // Живой жизненный цикл: в onNodeCreated id ещё не назначен (LGraphNode
  // ставит UNASSIGNED_NODE_ID = -1), реальный id приходит при graph.add.
  // Старый смоук давал id сразу — и был зелёным при сломанном рукопожатии.
  node.id = -1;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  check("id в onNodeCreated не назначен — свой id не кэширован как -1",
    st.ownId() === "", st.ownId());
  node.id = 12;
  check("после назначения id ownId читается живьём", st.ownId() === "12", st.ownId());
  check("ожидание подхвата пусто на старте", st.pendingPreview.size === 0);
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse({ ok: true, preview: "previews/e9.png" });
  };
  try {
    // 1. наша нода сохранила запись e9 в прогоне p1
    apiStub.dispatch("executed", { node: "12", prompt_id: "p1", output: { saved_id: ["e9"] } });
    check("saved_id запомнен", st.pendingPreview.get("p1")?.id === "e9");
    // 2. SaveImage отчитался о файле (тут же прогон)
    apiStub.dispatch("executed", { node: "77", prompt_id: "p1",
      output: { images: [{ filename: "ComfyUI_0001.png", subfolder: "", type: "output" }] } });
    // 3. прогон завершён
    apiStub.dispatch("execution_success", { prompt_id: "p1" });
    await new Promise((r) => setImmediate(r));
    const post = posts.find((p) => p.url.includes("/prompt_library/attach_preview"));
    check("attach_preview вызван", !!post, JSON.stringify(posts.map((p) => p.url)));
    check("payload: запись + файл прогона",
      post && post.body.id === "e9" && post.body.filename === "ComfyUI_0001.png" && post.body.type === "output",
      JSON.stringify(post?.body));
    check("ожидание очищено после успеха", st.pendingPreview.size === 0);

    // 4. без saved_id (прогон без записи в базу) — ничего не отправляем
    posts.length = 0;
    apiStub.dispatch("executed", { node: "77", prompt_id: "p2",
      output: { images: [{ filename: "x.png", subfolder: "", type: "output" }] } });
    apiStub.dispatch("execution_success", { prompt_id: "p2" });
    await new Promise((r) => setImmediate(r));
    check("без записи в базу обложка не прикрепляется", posts.length === 0, JSON.stringify(posts));

    // 5. упавший/прерванный прогон — ожидание снимается, запросов нет
    posts.length = 0;
    apiStub.dispatch("executed", { node: "12", prompt_id: "p3", output: { saved_id: ["e7"] } });
    apiStub.dispatch("execution_error", { prompt_id: "p3" });
    apiStub.dispatch("execution_success", { prompt_id: "p3" });
    await new Promise((r) => setImmediate(r));
    check("ошибка прогона чистит ожидание", st.pendingPreview.size === 0 && posts.length === 0);

    // 6. нода внутри subgraph: id приходит с префиксом ("5:12")
    posts.length = 0;
    apiStub.dispatch("executed", { node: "5:12", display_node: "5:12",
      prompt_id: "p5", output: { saved_id: ["e6"] } });
    check("subgraph: своя нода узнана по префиксному id", st.pendingPreview.get("p5")?.id === "e6",
      JSON.stringify([...st.pendingPreview.keys()]));
    apiStub.dispatch("executed", { node: "77", prompt_id: "p5",
      output: { images: [{ filename: "sub.png", subfolder: "", type: "output" }] } });
    apiStub.dispatch("execution_success", { prompt_id: "p5" });
    await new Promise((r) => setImmediate(r));
    check("subgraph: обложка привязана к записи",
      posts.some((p) => p.url.includes("attach_preview") && p.body.id === "e6" && p.body.filename === "sub.png"),
      JSON.stringify(posts));

    // 7. картинка не первая — используем первую (стабильно)
    posts.length = 0;
    apiStub.dispatch("executed", { node: "12", prompt_id: "p4", output: { saved_id: ["e5"] } });
    apiStub.dispatch("executed", { node: "77", prompt_id: "p4",
      output: { images: [{ filename: "a.png", subfolder: "S", type: "temp" }, { filename: "b.png", subfolder: "", type: "output" }] } });
    apiStub.dispatch("execution_success", { prompt_id: "p4" });
    await new Promise((r) => setImmediate(r));
    const p4 = posts.find((p) => p.url.includes("/prompt_library/attach_preview"));
    check("берётся первый файл прогона (temp → output не путается)",
      p4 && p4.body.filename === "a.png" && p4.body.subfolder === "S" && p4.body.type === "temp",
      JSON.stringify(p4?.body));
  } finally { sandbox.fetch = origFetch; }
});

// v1.60: в img2img-пайплайне (Qwen-Image и т.п.) ПЕРВЫМ с картинкой часто
// отчитывается PreviewImage ЗАГРУЖЕННОГО кадра (type "temp"), а итоговый
// SavePreviewImage/SaveImage (type "output") приходит позже. До фикса в запас
// шёл первый файл прогона — обложкой записи становился ВХОД. Теперь в запас и в
// ожидание идёт САМАЯ ПОЗДНЯЯ картинка с приоритетом output над temp-превью.
await run("preview: итог (output) побеждает ранний temp-превью кадра (v1.60)", async () => {
  const node = makeNode();
  node.id = -1;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  node.id = 51;
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse({ ok: true, preview: "previews/e4.png" });
  };
  try {
    // 1. наша нода сохранила запись (картинок ещё нет)
    apiStub.dispatch("executed", { node: "51", prompt_id: "r1", output: { saved_id: ["e0"] } });
    // 2. ПЕРВЫМ с картинкой отчитывается превью загруженного кадра (temp)
    apiStub.dispatch("executed", { node: "60", prompt_id: "r1",
      output: { images: [{ filename: "ref_preview.png", subfolder: "", type: "temp" }] } });
    check("первым в запас легла превью-картинка кадра",
      st.runImages.get("r1")?.filename === "ref_preview.png",
      JSON.stringify(st.runImages.get("r1")));
    // 3. итоговый SavePreviewImage приходит ПОЗЖЕ (output) — он и есть обложка
    apiStub.dispatch("executed", { node: "61", prompt_id: "r1",
      output: { images: [{ filename: "final.png", subfolder: "", type: "output" }] } });
    check("output-файл СМЕНИЛ запас (temp не выигрывает у итога)",
      st.runImages.get("r1")?.filename === "final.png",
      JSON.stringify(st.runImages.get("r1")));
    apiStub.dispatch("execution_success", { prompt_id: "r1" });
    await new Promise((r) => setImmediate(r));
    const post = posts.find((p) => p.url.includes("/prompt_library/attach_preview"));
    check("обложка записи — ИТОГ прогона, а не превью загруженного кадра",
      post && post.body.id === "e0" && post.body.filename === "final.png"
      && post.body.type === "output",
      JSON.stringify(post?.body));
    check("запас прогона очищен", st.runImages.size === 0);
  } finally { sandbox.fetch = origFetch; }
});

// v1.68: сторонняя нода сохранения (Degg Images Save/Compare) отдаёт файлы
// под СВОИМ ключом `degg_compare_images` — она сознательно не использует
// `images`, чтобы не включать штатное превью ноды. Пул обложек обязан видеть
// файлы ЛЮБОГО ключа output, а не только images/video/gifs — иначе запись
// создаётся, а обложка не прикрепляется («в прогоне нет файлов-превью»).
await run("preview: файлы прогона под СВОИМ ключом сторонней ноды (v1.68)", async () => {
  const node = makeNode();
  node.id = -1;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  node.id = 70;
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse({ ok: true, preview: "previews/e8.png" });
  };
  try {
    // 1. наша нода сохранила запись
    apiStub.dispatch("executed", { node: "70", prompt_id: "c1", output: { saved_id: ["e8"] } });
    // 2. Degg Images Save/Compare отчитался о файле ПОД СВОИМ КЛЮЧОМ
    //    (в output нет ни images, ни video, ни gifs)
    apiStub.dispatch("executed", { node: "88", prompt_id: "c1",
      output: { degg_compare_images: [{ filename: "cmp_out.png", subfolder: "", type: "output" }],
                degg_open_path: ["C:/out/cmp_out.png"] } });
    check("файл под своим ключом лег в запас прогона",
      st.runImages.get("c1")?.filename === "cmp_out.png",
      JSON.stringify(st.runImages.get("c1")));
    // 3. прогон завершён — обложка обязана приклеиться
    apiStub.dispatch("execution_success", { prompt_id: "c1" });
    await new Promise((r) => setImmediate(r));
    const post = posts.find((p) => p.url.includes("/prompt_library/attach_preview"));
    check("attach_preview вызван для чужого ключа",
      !!post, JSON.stringify(posts.map((p) => p.url)));
    check("payload: запись + файл сторонней ноды",
      post && post.body.id === "e8" && post.body.filename === "cmp_out.png",
      JSON.stringify(post?.body));
    check("запас прогона очищен", st.runImages.size === 0);

    // 4. штатный images по-прежнему в приоритете, если ключей несколько
    posts.length = 0;
    apiStub.dispatch("executed", { node: "70", prompt_id: "c2", output: { saved_id: ["e9"] } });
    apiStub.dispatch("executed", { node: "88", prompt_id: "c2",
      output: { images: [{ filename: "std.png", subfolder: "", type: "output" }],
                degg_compare_images: [{ filename: "degg.png", subfolder: "", type: "temp" }] } });
    check("стандартный images не затирается чужим ключом",
      st.runImages.get("c2")?.filename === "std.png",
      JSON.stringify(st.runImages.get("c2")));
    apiStub.dispatch("execution_success", { prompt_id: "c2" });
    await new Promise((r) => setImmediate(r));
    const post2 = posts.find((p) => p.url.includes("/prompt_library/attach_preview"));
    check("обложка — стандартный images при наличии обоих ключей",
      post2 && post2.body.filename === "std.png", JSON.stringify(post2?.body));
  } finally { sandbox.fetch = origFetch; }
});

await run("preview: onRemoved снимает exec-слушатели", async () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  // v1.25: подхват держит текст прогона и ожидающие токены — удалённая нода
  // не должна их за собой тащить (иначе утечка до конца сессии).
  st.pendingPickup.set("z1", { token: "t", node: "1", text: "x" });
  st.runTexts.set("1", "x");
  const before = (apiListeners["executed"] ?? []).length;
  proto.onRemoved.call(node);
  check("подхват: карты очищены при удалении ноды",
    st.pendingPickup.size === 0 && st.runTexts.size === 0
    && st.pendingPreview.size === 0 && st.runImages.size === 0);
  check("executed/execution_success сняты",
    (apiListeners["executed"] ?? []).length === before - 1
    && !(apiListeners["execution_success"] ?? []).includes(st.execListeners[1][1]));
  // id уникален именно для этой ноды: в предыдущих фазах уже живут ноды с id 12,
  // их слушатели не сняты — иначе проверка ловит не эту ноду.
  node.id = 33;
  let posts = 0;
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (u) => { if (String(u).includes("attach_preview")) posts++; return jsonResponse({}); };
  try {
    apiStub.dispatch("executed", { node: "33", prompt_id: "p9", output: { saved_id: ["e1"] } });
    apiStub.dispatch("execution_success", { prompt_id: "p9" });
    await new Promise((r) => setImmediate(r));
    check("удалённая нода не дёргает attach_preview", posts === 0 && st.pendingPreview.size === 0);
  } finally { sandbox.fetch = origFetch; }
});

await run("mode: три режима — выдающие требуют отключить IMAGE-провод", async () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const modeW = node.widgets.find((w) => w.name === "mode");
  let safeCalls = 0;
  st.ensureIssueSafe = async () => { safeCalls++; return true; };
  modeW.value = "📥 Запись";
  await modeW.callback(modeW.value);
  check("«Запись» не трогает провод", safeCalls === 0);
  modeW.value = "📤 Выдача";
  await modeW.callback(modeW.value);
  check("«Выдача» проверяет кольцо", safeCalls === 1);
  modeW.value = "📤📥 Выдача + запись";
  await modeW.callback(modeW.value);
  check("«Выдача + запись» проверяет кольцо", safeCalls === 2);
});

await run("preview: нода ПОСЛЕ узлов вывода (позиция старого сейвера)", async () => {
  const node = makeNode();
  node.id = -1;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  node.id = 21;
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse({ ok: true, preview: "previews/e3.png" });
  };
  try {
    // 1. Сначала картинки прогона (нода ниже SaveImage, saved_id ещё не пришёл)
    apiStub.dispatch("executed", { node: "77", prompt_id: "q1",
      output: { images: [{ filename: "late.png", subfolder: "", type: "output" }] } });
    check("картинка отложена в запас прогона", st.runImages.get("q1")?.filename === "late.png");
    // 2. Теперь отчиталась наша нода
    apiStub.dispatch("executed", { node: "21", prompt_id: "q1", output: { saved_id: ["e3"] } });
    check("запас подхвачен в ожидание", st.pendingPreview.get("q1")?.image?.filename === "late.png");
    apiStub.dispatch("execution_success", { prompt_id: "q1" });
    await new Promise((r) => setImmediate(r));
    check("обложка прикреплена из запасённой картинки",
      posts.some((p) => p.url.includes("attach_preview") && p.body.id === "e3" && p.body.filename === "late.png"),
      JSON.stringify(posts));
    check("запас прогона очищен", st.runImages.size === 0);
  } finally { sandbox.fetch = origFetch; }
});

// --- v1.25: подхват финального текста из другого узла (без провода назад) ---
// Провод «финальный текст → эта же нода» — кольцо (ComfyUI исполняет только
// DAG), поэтому текст забирается после прогона: нода отдаёт токен (ui.pickup),
// источник — текст (ui.text), JS сохраняет это через /save_pickup + обложку.
await run("pickup: список узлов и сохранение текста источника", async () => {
  const node = makeNode();
  node.id = 41;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const keeper = { id: 1622, type: "PromptKeeper", title: "Итоговый Promt", mode: 0,
    outputs: [{ name: "text", type: "STRING" }],
    widgets: [{ name: "text", value: "старый текст", type: "customtext" }] };
  const noise = { id: 1524, type: "KSampler", title: "", mode: 0,
    outputs: [{ name: "LATENT", type: "LATENT" }], widgets: [{ name: "steps", value: 20, type: "number" }] };
  const otherLib = { id: 5, type: "PromptLibrary", title: "", mode: 0,
    outputs: [{ name: "prompt_out", type: "STRING" }], widgets: [] };
  // Узлы в режимах mute/bypass не исполнятся: у LiteGraph NEVER = 2 (mute),
  // BYPASS = 4 (bypass) — ровно пара, по которой фронтенд сам считает узел
  // неактивным (app.ts: isMuted = mode === NEVER || mode === BYPASS).
  const bypassed = { id: 7, type: "PromptKeeper", title: "Bypassed", mode: 4,
    outputs: [{ name: "text", type: "STRING" }], widgets: [] };
  const muted = { id: 8, type: "PromptKeeper", title: "Muted", mode: 2,
    outputs: [{ name: "text", type: "STRING" }], widgets: [] };
  const prevNodes = appStub.graph._nodes;
  const prevGet = appStub.graph.getNodeById;
  appStub.graph._nodes = [keeper, noise, otherLib, bypassed, muted, node];
  appStub.graph.getNodeById = (id) => appStub.graph._nodes.find((n) => String(n.id) === String(id)) || null;
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes("save_pickup")) return jsonResponse({ ok: true, id: "e77", duplicate: false });
    return jsonResponse({ ok: true, preview: "previews/e77.png" });
  };
  try {
    st.refreshPickupOptions();
    const opts = st.pickupSel.children.map((o) => o.value);
    check("pickup: селектор нашёл текстовый узел", opts.includes("1622"), JSON.stringify(opts));
    check("pickup: первая опция — «из входа»", st.pickupSel.children[0].value === "");
    check("pickup: узел без текста не предложен", !opts.includes("1524"), JSON.stringify(opts));
    check("pickup: вторая Library-нода не предложена", !opts.includes("5"), JSON.stringify(opts));
    check("pickup: bypass-узел (mode 4) не предложен", !opts.includes("7"), JSON.stringify(opts));
    check("pickup: mute-узел (mode 2, NEVER) не предложен", !opts.includes("8"), JSON.stringify(opts));
    st.pickupSel.value = "1622";
    st.pickupSel.onchange();
    check("pickup: выбор пишется в скрытый виджет",
      node.widgets.find((w) => w.name === "pickup").value === "1622",
      String(node.widgets.find((w) => w.name === "pickup").value));
    check("pickup: пользователь видит подсказку об источнике",
      String(st.hintSticky || "").includes("#1622"), String(st.hintSticky));
    // прогон: наша нода отдала токен → узел-источник отдал текст → успех
    apiStub.dispatch("executed", { node: "41", prompt_id: "r1",
      output: { pickup: ["tok1"], pickup_node: ["1622"] } });
    check("pickup: токен запомнен", st.pendingPickup.get("r1")?.token === "tok1",
      JSON.stringify(st.pendingPickup.get("r1")));
    apiStub.dispatch("executed", { node: "1622", prompt_id: "r1",
      output: { text: ["финальный текст из LLM"] } });
    check("pickup: текст источника досыпан в ожидание",
      st.pendingPickup.get("r1")?.text === "финальный текст из LLM",
      JSON.stringify(st.pendingPickup.get("r1")));
    apiStub.dispatch("executed", { node: "77", prompt_id: "r1",
      output: { images: [{ filename: "run.png", subfolder: "", type: "output" }] } });
    apiStub.dispatch("execution_success", { prompt_id: "r1" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const save = posts.find((p) => p.url.includes("save_pickup"));
    check("pickup: save_pickup с токеном и текстом источника",
      save && save.body.token === "tok1" && save.body.text === "финальный текст из LLM",
      JSON.stringify(save?.body));
    const cov = posts.find((p) => p.url.includes("attach_preview"));
    check("pickup: обложка прикреплена к новой записи",
      cov && cov.body.id === "e77" && cov.body.filename === "run.png", JSON.stringify(cov?.body));
    check("pickup: ожидание очищено", st.pendingPickup.size === 0);
  } finally {
    sandbox.fetch = origFetch;
    appStub.graph._nodes = prevNodes;
    appStub.graph.getNodeById = prevGet;
  }
});

await run("pickup: фолбэк на виджет графа и id с префиксом subgraph", async () => {
  const node = makeNode();
  node.id = 42;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const keeper = { id: 900, type: "PromptKeeper", title: "Финал", mode: 0,
    outputs: [{ name: "text", type: "STRING" }],
    widgets: [{ name: "text", value: "текст из виджета", type: "customtext" }] };
  const prevNodes = appStub.graph._nodes;
  const prevGet = appStub.graph.getNodeById;
  appStub.graph._nodes = [keeper, node];
  appStub.graph.getNodeById = (id) => appStub.graph._nodes.find((n) => String(n.id) === String(id)) || null;
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes("save_pickup")) return jsonResponse({ ok: true, id: "e78", duplicate: false });
    return jsonResponse({ ok: true });
  };
  try {
    st.setPickup("900");
    st.runTexts.set("900", "текст из прогона");
    check("pickup: приоритет — текст этого прогона",
      st.pickupText("900") === "текст из прогона", st.pickupText("900"));
    st.runTexts.clear();
    check("pickup: прогон без ui.text — берём виджет графа",
      st.pickupText("900") === "текст из виджета", st.pickupText("900"));
    check("pickup: неизвестный узел -> пусто", st.pickupText("нет-такого") === "");
    // Нода внутри subgraph приходит с префиксом ("5:900"), а в селекторе — "900"
    apiStub.dispatch("executed", { node: "42", prompt_id: "r2",
      output: { pickup: ["tok2"], pickup_node: ["900"] } });
    apiStub.dispatch("executed", { node: "5:900", display_node: "5:900", prompt_id: "r2",
      output: { text: ["текст из subgraph"] } });
    check("pickup: id с префиксом subgraph распознан",
      st.pendingPickup.get("r2")?.text === "текст из subgraph",
      JSON.stringify(st.pendingPickup.get("r2")));
    apiStub.dispatch("execution_success", { prompt_id: "r2" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const save = posts.find((p) => p.url.includes("save_pickup"));
    check("pickup: сохранён текст из subgraph-узла",
      save && save.body.text === "текст из subgraph", JSON.stringify(save?.body));
  } finally {
    sandbox.fetch = origFetch;
    appStub.graph._nodes = prevNodes;
    appStub.graph.getNodeById = prevGet;
  }
});

await run("pickup: дубликат — без тоста (подхват срабатывает каждый Queue)", async () => {
  const node = makeNode();
  node.id = 44;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const keeper = { id: 901, type: "PromptKeeper", title: "Финал", mode: 0,
    outputs: [{ name: "text", type: "STRING" }],
    widgets: [{ name: "text", value: "уже в базе", type: "customtext" }] };
  const prevNodes = appStub.graph._nodes;
  const prevGet = appStub.graph.getNodeById;
  appStub.graph._nodes = [keeper, node];
  appStub.graph.getNodeById = (id) => appStub.graph._nodes.find((n) => String(n.id) === String(id)) || null;
  const origFetch = sandbox.fetch;
  const origToast = st.toast;
  const posts = [];
  let toasts = 0;
  st.toast = () => { toasts++; };
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes("save_pickup")) {
      return jsonResponse({ ok: true, id: "e1", duplicate: true, folder: "Подхват" });
    }
    return jsonResponse({ ok: true });
  };
  try {
    st.setPickup("901");
    apiStub.dispatch("executed", { node: "44", prompt_id: "r4",
      output: { pickup: ["tok4"], pickup_node: ["901"] } });
    apiStub.dispatch("executed", { node: "901", prompt_id: "r4",
      output: { text: ["уже в базе"] } });
    apiStub.dispatch("execution_success", { prompt_id: "r4" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check("pickup: дубль всё равно проверяем на сервере",
      posts.some((p) => p.url.includes("save_pickup")), JSON.stringify(posts.map((p) => p.url)));
    check("pickup: дубль — без тоста (не надоедаем на каждый Queue)", toasts === 0, `toasts=${toasts}`);
    check("pickup: дубль виден в нижней строке ноды",
      String(st.hintSticky || "").includes("Подхват"), String(st.hintSticky));
    check("pickup: дубль — обложку не трогаем",
      !posts.some((p) => p.url.includes("attach_preview")), JSON.stringify(posts.map((p) => p.url)));
  } finally {
    sandbox.fetch = origFetch;
    st.toast = origToast;
    appStub.graph._nodes = prevNodes;
    appStub.graph.getNodeById = prevGet;
  }
});

await run("pickup: пустой текст источника — записи нет, пользователь предупреждён", async () => {
  const node = makeNode();
  node.id = 43;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const prevNodes = appStub.graph._nodes;
  const prevGet = appStub.graph.getNodeById;
  appStub.graph._nodes = [node];
  appStub.graph.getNodeById = () => null;
  const origFetch = sandbox.fetch;
  const origToast = st.toast;
  let posts = 0;
  let toasts = 0;
  st.toast = () => { toasts++; };
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts++;
    return jsonResponse({ ok: true });
  };
  try {
    apiStub.dispatch("executed", { node: "43", prompt_id: "r3",
      output: { pickup: ["tok3"], pickup_node: ["999"] } });
    apiStub.dispatch("execution_success", { prompt_id: "r3" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check("pickup: пустой текст — save_pickup не зовём", posts === 0, `posts=${posts}`);
    check("pickup: пользователь предупреждён тостом", toasts === 1, `toasts=${toasts}`);
    check("pickup: ожидание снято", st.pendingPickup.size === 0);
  } finally {
    sandbox.fetch = origFetch;
    st.toast = origToast;
    appStub.graph._nodes = prevNodes;
    appStub.graph.getNodeById = prevGet;
  }
});

// --- v1.28: подхват и кэш ComfyUI --------------------------------------------
// У ноды с подхватом нет проводов, поэтому ComfyUI кэширует её по виджетам:
// без IS_CHANGED execute() со второго одинакового Queue не вызывается, токена
// нет — и запись молча не создавалась. Проверяем, что теперь причина видна.
await run("pickup + кэш: токена нет — записи нет, но причина показана (v1.28)", async () => {
  const node = makeNode();
  node.id = 45;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const prevNodes = appStub.graph._nodes;
  const prevGet = appStub.graph.getNodeById;
  appStub.graph._nodes = [node];
  appStub.graph.getNodeById = () => null;
  let posts = 0;
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts++;
    return jsonResponse({ ok: true });
  };
  try {
    st.setPickup("901");
    // Нода НЕ исполнялась: `executed` для неё не пришёл (её закэшировали),
    // но прогон дошел до успешного завершения
    apiStub.dispatch("executed", { node: "901", prompt_id: "c1",
      output: { text: ["текст источника"] } });
    apiStub.dispatch("execution_success", { prompt_id: "c1" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check("pickup+кэш: save_pickup не зовём (токена нет)", posts === 0, `posts=${posts}`);
    check("pickup+кэш: причина видна в нижней строке ноды (раньше — полная тишина)",
      String(st.hintSticky || "").includes("кэш"), String(st.hintSticky));
  } finally {
    sandbox.fetch = origFetch;
    appStub.graph._nodes = prevNodes;
    appStub.graph.getNodeById = prevGet;
  }
});

// --- v1.38: подхват подчиняется режиму ----------------------------------------
// Подхват — это ЗАПИСЬ (токен -> /save_pickup -> новая запись + обложка), значит
// в «📤 Выдача» он выключен: сервер не отдаёт токен, а сообщает причину флагом
// pickup_blocked. Клиент не должен ни звать save_pickup, ни врать про «кэш».
await run("pickup: режим не пишет — подхват не сохраняет и не врёт про кэш (v1.38)", async () => {
  const node = makeNode();
  node.id = 47;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const prevNodes = appStub.graph._nodes;
  const prevGet = appStub.graph.getNodeById;
  appStub.graph._nodes = [node];
  appStub.graph.getNodeById = () => null;
  let posts = 0;
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts++;
    return jsonResponse({ ok: true });
  };
  try {
    st.setPickup("1622");
    st.hintSticky = null;
    proto.onExecuted.call(node, { mode_notice: ["Режим «📤 Выдача» ничего не сохраняет: подхват выключен."] });
    apiStub.dispatch("executed", { node: "47", prompt_id: "b1",
      output: { pickup: [], pickup_node: [], pickup_blocked: ["1622"] } });
    apiStub.dispatch("execution_success", { prompt_id: "b1" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check("pickup+выдача: save_pickup не зовём", posts === 0, `posts=${posts}`);
    check("pickup+выдача: о кэше не врём",
      !String(st.hintSticky || "").includes("кэш"), String(st.hintSticky));
    check("pickup+выдача: причина видна в нижней строке (подсказка ноды)",
      String(st.hintSticky || "").includes("не сохраняет"), String(st.hintSticky));
    check("pickup+выдача: ожидание подхвата пусто", st.pendingPickup.size === 0);
    check("pickup+выдача: флаг прогона снят", !st.runPickupBlocked.has("b1"));
  } finally {
    sandbox.fetch = origFetch;
    appStub.graph._nodes = prevNodes;
    appStub.graph.getNodeById = prevGet;
  }
});

await run("pickup: отказ сервера (протухший токен) не уходит в тишину", async () => {
  const node = makeNode();
  node.id = 46;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const prevNodes = appStub.graph._nodes;
  const prevGet = appStub.graph.getNodeById;
  const keeper = { id: 902, type: "PromptKeeper", title: "Финал", mode: 0,
    outputs: [{ name: "text", type: "STRING" }],
    widgets: [{ name: "text", value: "финальный текст", type: "customtext" }] };
  appStub.graph._nodes = [keeper, node];
  appStub.graph.getNodeById = (id) => appStub.graph._nodes.find((n) => String(n.id) === String(id)) || null;
  const origFetch = sandbox.fetch;
  st.hintSticky = null;
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    if (url.includes("save_pickup")) return { ...jsonResponse({ error: "unknown token" }), ok: false, status: 400 };
    return jsonResponse({ ok: true });
  };
  try {
    apiStub.dispatch("executed", { node: "46", prompt_id: "c2",
      output: { pickup: ["tokX"], pickup_node: ["902"] } });
    apiStub.dispatch("execution_success", { prompt_id: "c2" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check("pickup: 400 от сервера виден в нижней строке (со статусом)",
      String(st.hintSticky || "").includes("400"), String(st.hintSticky));
  } finally {
    sandbox.fetch = origFetch;
    appStub.graph._nodes = prevNodes;
    appStub.graph.getNodeById = prevGet;
  }
});

// --- v1.26: видео как обложка + замена обложки из файла ----------------------
// Ядро отдаёт видео в том же `images` (+ animated), сторонние ноды (VHS) —
// в `video`/`gifs`: раньше читался только `images`, и видео-прогон оставался
// без обложки.
await run("preview: видео-прогон (images+animated) и сторонние пулы video/gifs", async () => {
  const node = makeNode();
  node.id = 21;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse({ ok: true, preview: "previews/e1.png" });
  };
  try {
    apiStub.dispatch("executed", { node: "21", prompt_id: "v1", output: { saved_id: ["e1"] } });
    apiStub.dispatch("executed", { node: "88", prompt_id: "v1",
      output: { images: [{ filename: "clip.mp4", subfolder: "", type: "output" }], animated: [true] } });
    apiStub.dispatch("execution_success", { prompt_id: "v1" });
    await new Promise((r) => setImmediate(r));
    check("видео-прогон: файл ушёл в attach_preview",
      posts.some((p) => p.url.includes("attach_preview") && p.body.filename === "clip.mp4"),
      JSON.stringify(posts.map((p) => p.body)));

    posts.length = 0;
    apiStub.dispatch("executed", { node: "21", prompt_id: "v2", output: { saved_id: ["e2"] } });
    apiStub.dispatch("executed", { node: "89", prompt_id: "v2",
      output: { gifs: [{ filename: "clip2.webm", subfolder: "v", type: "output" }] } });
    apiStub.dispatch("execution_success", { prompt_id: "v2" });
    await new Promise((r) => setImmediate(r));
    check("сторонний пул gifs тоже становится обложкой",
      posts.some((p) => p.url.includes("attach_preview") && p.body.filename === "clip2.webm"),
      JSON.stringify(posts.map((p) => p.body)));

    posts.length = 0;
    apiStub.dispatch("executed", { node: "21", prompt_id: "v3", output: { saved_id: ["e3"] } });
    apiStub.dispatch("executed", { node: "90", prompt_id: "v3",
      output: { video: [{ filename: "clip3.mkv", subfolder: "", type: "output" }] } });
    apiStub.dispatch("execution_success", { prompt_id: "v3" });
    await new Promise((r) => setImmediate(r));
    check("сторонний пул video тоже становится обложкой",
      posts.some((p) => p.url.includes("attach_preview") && p.body.filename === "clip3.mkv"),
      JSON.stringify(posts.map((p) => p.body)));
  } finally {
    sandbox.fetch = origFetch;
  }
});

await run("preview: кадр из файла с диска (картинка и видео)", async () => {
  const node = makeNode();
  node.id = 31;
  proto.onNodeCreated.call(node);
  const st = node._pl;

  check("readPreviewFile: без файла — null", (await st.readPreviewFile(null)) === null);

  const pImg = st.readPreviewFile({ name: "photo.png", type: "image/png" });
  const img = madeEls.filter((e) => e.tagName === "IMG").pop();
  check("картинка: загружена через blob-URL", !!img && String(img.src).startsWith("blob:"));
  img.onload?.();
  const resImg = await pImg;
  check("картинка: media=image + PNG dataURL",
    !!resImg && resImg.media === "image" && String(resImg.dataUrl).startsWith("data:"),
    JSON.stringify(resImg));

  const pVid = st.readPreviewFile({ name: "clip.mp4", type: "video/mp4" });
  const vid = madeEls.filter((e) => e.tagName === "VIDEO").pop();
  check("видео: элемент <video> с preload=metadata", !!vid && vid.preload === "metadata");
  vid.onloadeddata?.();
  vid.onseeked?.();
  const resVid = await pVid;
  check("видео: media=video + кадр как dataURL",
    !!resVid && resVid.media === "video" && String(resVid.dataUrl).startsWith("data:"),
    JSON.stringify(resVid));

  const pBad = st.readPreviewFile({ name: "broken.mp4", type: "video/mp4" });
  const bad = madeEls.filter((e) => e.tagName === "VIDEO").pop();
  bad.onerror?.();
  check("битый контейнер: null без зависания", (await pBad) === null);
});

await run("preview: замена обложки существующей записи (кнопка панели книги)", async () => {
  const node = makeNode();
  node.id = 41;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    if (url.includes("/prompt_library/entry")) {
      return jsonResponse({ id: "e1", title: "t", folder: "", prompt: "p", media: "video" });
    }
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse({ ok: true });
  };
  try {
    check("панель книги: кнопка замены обложки есть", !!st.bPreview);
    check("кнопка лежит в ряду действий панели",
      st.detail.children.some((c) => Array.isArray(c.children) && c.children.includes(st.bPreview)));

    st.full.set("e1", { id: "e1", title: "t", folder: "", prompt: "p", media: "video" });
    await st.fillDetail("e1");
    check("просмотр: кнопка замены СКРЫТА (обложка — содержимое записи, не действие просмотра)",
      st.bPreview.style.display === "none", String(st.bPreview.style.display));
    check("media=video: подпись кнопки 🎬", String(st.bPreview.textContent).startsWith("🎬"),
      st.bPreview.textContent);
    check("формуляр несёт метку типа", String(st.dMeta.textContent).includes("🎬 видео"),
      st.dMeta.textContent);

    st.full.set("e1", { id: "e1", title: "t", folder: "", prompt: "p", media: "image" });
    await st.fillDetail("e1");
    check("media=image: подпись кнопки 🖼", String(st.bPreview.textContent).startsWith("🖼"),
      st.bPreview.textContent);

    // Возвращаем видео-запись: на ней проверяем отмену и подтверждение
    st.full.set("e1", { id: "e1", title: "t", folder: "", prompt: "p", media: "video" });
    await st.fillDetail("e1");
    st.bEdit.onclick();
    check("режим ✏️ Редактировать: кнопка замены показана", st.bPreview.style.display === "",
      String(st.bPreview.style.display));

    const fileInput = st.detail.children
      .flatMap((c) => (Array.isArray(c.children) ? c.children : []))
      .find((el) => el.tagName === "INPUT" && el.type === "file" && String(el.accept).includes("video"));
    check("в панели есть скрытый input для картинки/видео", !!fileInput, String(fileInput?.accept));
    const pickFrame = async (name) => {
      fileInput.files = [{ name, type: "video/mp4" }];
      const pending = fileInput.onchange();
      const vid = madeEls.filter((e) => e.tagName === "VIDEO").pop();
      vid.onloadeddata?.();
      vid.onseeked?.();
      await pending;
    };
    st.detailId = "e1";

    // Отказ в подтверждении — обложка не меняется (замена необратима)
    const origConfirm = appStub.extensionManager.dialog.confirm;
    appStub.extensionManager.dialog.confirm = async () => false;
    try {
      await pickFrame("clip.mp4");
      check("отмена подтверждения: POST не уходит", posts.length === 0, JSON.stringify(posts));
      check("отмена подтверждения: подпись вернулась к текущему типу",
        String(st.bPreview.textContent).startsWith("🎬"), st.bPreview.textContent);
    } finally {
      appStub.extensionManager.dialog.confirm = origConfirm;
    }

    // Согласие — кадр уходит с force и меткой
    await pickFrame("clip2.mp4");
    const post = posts.find((p) => p.url.includes("attach_preview"));
    check("замена: POST attach_preview с preview_data + force",
      !!post && post.body.id === "e1" && post.body.force === true
        && post.body.media === "video" && String(post.body.preview_data).startsWith("data:"),
      JSON.stringify(post?.body));
    check("замена: локальная метка кэша превью поставлена", st.previewStamp.has("e1"));
    check("замена: метка формуляра обновилась", String(st.dMeta.textContent).includes("🎬 видео"),
      st.dMeta.textContent);
    check("замена не сбрасывает режим редактирования (несохранённый текст не теряется)",
      st.bPreview.style.display === "" && st.dText.readOnly === false,
      `${st.bPreview.style.display} / readOnly=${st.dText.readOnly}`);

    // Выход из редактирования (💾) — кнопка замены снова скрыта
    st.bSave.onclick();
    await new Promise((r) => setImmediate(r));
    check("после 💾 Сохранить кнопка замены скрыта", st.bPreview.style.display === "none",
      String(st.bPreview.style.display));
  } finally {
    sandbox.fetch = origFetch;
  }
});

await run("редактирование: ✖ Отмена возвращает значения из базы", async () => {
  const node = makeNode();
  node.id = 51;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  st.full.set("e1", { id: "e1", title: "Исходное", folder: "Фото", prompt: "исходный текст", media: "image" });
  await st.fillDetail("e1");
  check("просмотр: кнопки правки и замены скрыты", st.bSave.style.display === "none"
    && st.bCancel.style.display === "none" && st.bPreview.style.display === "none",
    `${st.bSave.style.display}/${st.bCancel.style.display}/${st.bPreview.style.display}`);

  st.bEdit.onclick();
  check("правка: показаны 💾, ✖ Отмена и замена обложки", st.bSave.style.display === ""
    && st.bCancel.style.display === "" && st.bPreview.style.display === "");
  check("правка: поля доступны для ввода", st.dTitle.readOnly === false && st.dText.readOnly === false);

  let confirms = 0;
  const origConfirm = appStub.extensionManager.dialog.confirm;
  try {
    appStub.extensionManager.dialog.confirm = async () => { confirms++; return true; };
    // «Зашёл в правку и передумал»: менять нечего — тихий возврат, без диалога
    await st.bCancel.onclick();
    check("отмена без правок: без диалога (не раздражаем)", confirms === 0, `confirms=${confirms}`);
    check("отмена без правок: снова просмотр", st.bSave.style.display === "none"
      && st.bCancel.style.display === "none" && st.dText.readOnly === true);

    // Правки есть — выходим с подтверждением, значения берутся из базы
    st.bEdit.onclick();
    st.dText.value = "изменённый текст";
    await st.bCancel.onclick();
    check("отмена с правками: подтверждение запрошено", confirms === 1, `confirms=${confirms}`);
    check("отмена с правками: текст вернулся из базы", st.dText.value === "исходный текст",
      String(st.dText.value));
    check("отмена с правками: поля снова только для чтения", st.dText.readOnly === true);
    check("отмена с правками: пользователь уведомлён нижней строкой",
      String(st.hintSticky || "").includes("отменены"), String(st.hintSticky));

    // Отказ в диалоге — правки и режим остаются на месте
    st.bEdit.onclick();
    st.dText.value = "второй вариант";
    appStub.extensionManager.dialog.confirm = async () => { confirms++; return false; };
    await st.bCancel.onclick();
    check("отказ в диалоге: остаёмся в правке с введённым текстом",
      st.dText.value === "второй вариант" && st.dText.readOnly === false
      && st.bCancel.style.display === "", String(st.dText.value));
  } finally {
    appStub.extensionManager.dialog.confirm = origConfirm;
  }
});

// --- v1.32: панель свойств не трогает наши виджеты (§37.10) ------------------
// Корень зажатия: панель рендерит виджеты узла; для типа `custom` компонента в
// реестре нет → монтируется WidgetLegacy, который пишет widget.width = ширине
// панели. Лечение — не пускать виджеты ноды в панель вообще (options.hideInPanel:
// панель фильтрует по нему, остальной фронтенд — нет).
await run("v1.32: виджеты ноды скрыты из панели свойств", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const w = node.widgets.find((x) => x.name === "pl_browser");
  check("v1.32: pl_browser создан", !!w);
  check("v1.32: pl_browser с hideInPanel (панель его не рендерит)",
    !!(w && w.options && w.options.hideInPanel === true), JSON.stringify(w && w.options));
  for (const name of ["selected", "save_folder", "pickup"]) {
    const tw = node.widgets.find((x) => x.name === name);
    check(`v1.32: технический ${name} с hideInPanel`,
      !!(tw && tw.options && tw.options.hideInPanel === true));
  }
  // width мы по-прежнему никогда не задаём сами
  check("v1.32: свой width не выставляется", !!w && w.width === undefined);
});

// --- v1.31: stale widget.width сносится (§37) --------------------------------
await run("v1.31: чужое widget.width не переживает кадр", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const w = node.widgets.find((x) => x.name === "pl_browser");
  check("v1.31: pl_browser создан", !!w);
  check("v1.31: свежее состояние без width", !!w && w.width === undefined);
  if (w) w.width = 213; // чужое stale-значение, как живьём (§37)
  proto.onDrawForeground.call(node);
  check("v1.31: onDrawForeground сносит stale width",
    !!w && w.width === undefined, String(w && w.width));
  if (w) w.width = 213;
  node.onResize([800, 900]);
  check("v1.31: onResize сносит stale width",
    !!w && w.width === undefined, String(w && w.width));
});

// --- v1.27 (аудит): двойной клик, полнотекстовый поиск, гигиена состояния ----
const walkDom = (el, out = []) => { if (!el?.children) return out; for (const c of el.children) { out.push(c); walkDom(c, out); } return out; };

await run("v1.27: защита от двойного клика на «Сохранить промпт»", async () => {
  const node = makeNode();
  node.id = 61;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const posts = [];
  // Ответ приходит не сразу: второй клик обязан быть отброшен импгновенно
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes("/prompt_library/add")) { await gate; return jsonResponse({ ok: true, id: "e1" }); }
    return jsonResponse({ ok: true });
  };
  try {
    // Текст вводится в textarea РУЧНОГО ввода (у панели книги своя — st.dText);
    // берём ПОСЛЕДНЮЮ из созданных в этой ноде, а не первую за весь прогон
    const ta = madeEls.filter((e) => e.tagName === "TEXTAREA" && e !== st.dText).pop();
    const saveBtn = walkDom(st.root).find((el) => el.tagName === "BUTTON"
      && String(el.textContent).includes("Сохранить промпт"));
    check("v1.27: кнопка ручного сохранения найдена", !!ta && !!saveBtn, String(saveBtn?.textContent));
    ta.value = "текст под двойным кликом";
    const p1 = saveBtn.onclick(); // первый клик уходит в fetch
    const p2 = saveBtn.onclick(); // второй — при живом первом
    check("v1.27: во время запроса кнопка помечена занятой (⏳)",
      String(saveBtn.textContent).includes("⏳"), saveBtn.textContent);
    release();
    await p1; await p2;
    check("v1.27: двойной клик дал ровно один POST /add",
      posts.filter((p) => p.url.includes("/prompt_library/add")).length === 1,
      JSON.stringify(posts.map((p) => p.url)));
    check("v1.27: после ответа защита снята (можно сохранять снова)", st._saving === false);
  } finally {
    sandbox.fetch = origFetch;
  }
});

// --- v1.29: название в ручном вводе ------------------------------------------
await run("v1.29: ручной ввод с названием", async () => {
  const node = makeNode();
  node.id = 62;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes("/prompt_library/add")) return jsonResponse({ ok: true, id: "e2" });
    return jsonResponse({ ok: true });
  };
  try {
    check("v1.29: поле названия есть в окне ввода",
      !!st.inputTitle && st.inputTitle.tagName === "INPUT", String(st.inputTitle?.tagName));
    const ta = madeEls.filter((e) => e.tagName === "TEXTAREA" && e !== st.dText).pop();
    const saveBtn = walkDom(st.root).find((el) => el.tagName === "BUTTON"
      && String(el.textContent).includes("Сохранить промпт"));
    check("v1.29: кнопка ручного сохранения найдена", !!ta && !!saveBtn);
    // С названием — уходит в POST, после успеха оба поля очищены
    st.inputTitle.value = "Моё название";
    ta.value = "текст с названием";
    await saveBtn.onclick();
    const add = posts.filter((p) => p.url.includes("/prompt_library/add")).pop();
    check("v1.29: title уходит в POST /add",
      add?.body?.title === "Моё название", JSON.stringify(add?.body));
    check("v1.29: после сохранения текст и название очищены",
      ta.value === "" && st.inputTitle.value === "",
      JSON.stringify({ ta: ta.value, title: st.inputTitle.value }));
    // Без названия — уходит пустым, сервер возьмёт начало текста (_auto_title)
    ta.value = "текст без названия";
    await saveBtn.onclick();
    const add2 = posts.filter((p) => p.url.includes("/prompt_library/add")).pop();
    check("v1.29: пустое название уходит пустым (авто на сервере)",
      add2?.body?.title === "", JSON.stringify(add2?.body));
  } finally {
    sandbox.fetch = origFetch;
  }
});

// --- v1.30: закреп в папке ---------------------------------------------------
await run("v1.30: закреплённые вверху папки, вне папок — обычный порядок", async () => {
  const node = makeNode();
  node.id = 63;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const posts = [];
  const srv = (id, created, pinned) => ({ id, title: id, prompt: id, folder: "A",
    favorite: false, pinned: !!pinned, created_at: created, last_used: null,
    preview: null, has_workflow: false, media: null });
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list"))
      return jsonResponse({ entries: [srv("e1", "2026-09-19T02:00:00", false), srv("e2", "2026-09-19T01:00:00", true)], folders: ["A"] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return jsonResponse({ ok: true });
  };
  const pinBtns = () => walkDom(st.root).filter((el) => el.tagName === "BUTTON"
    && /^(Закрепить вверху папки|Открепить)$/.test(String(el.title || "")));
  // Карточка: [img, body, actions]; заголовок — body.children[0]
  const firstTitle = () => {
    const card = st.list.children[0];
    const body = card && card.children[1];
    return String((body && body.children[0] && body.children[0].textContent) || "");
  };
  try {
    // В папке: новая незакреплённая (e1) + старая закреплённая (e2) — вверху e2.
    // Записи — через /list (как в живую, заодно проверяется plMap); стартовый
    // reload() ноды тоже ходит в /list, поэтому подмена позже его не затирает.
    st.selFolder = "A";
    st.renderTree(); await st.reload();
    check("v1.30: в папке кнопки закрепа есть", pinBtns().length === 2, String(pinBtns().length));
    check("v1.30: закреплённая — первая в папке",
      firstTitle().includes("e2"), firstTitle());
    // Клик по 📌 незакреплённой: оптимистичный флип + POST /pin
    const btn1 = pinBtns().find((b) => String(b.title) === "Закрепить вверху папки");
    check("v1.30: у незакреплённой подсказка «Закрепить»", !!btn1);
    await btn1.onclick({ stopPropagation() {} });
    const pin = posts.filter((p) => p.url.includes("/prompt_library/pin")).pop();
    check("v1.30: клик шлёт POST /pin с новым значением",
      pin?.body?.id === "e1" && pin?.body?.pinned === true, JSON.stringify(pin?.body));
    // Вне папок («Всё»): кнопок нет, порядок обычный (новые сверху)
    st.selFolder = "__all";
    st.renderTree(); st.render();
    check("v1.30: во «Всё» кнопок закрепа нет", pinBtns().length === 0);
    check("v1.30: во «Всё» закреп не всплывает (порядок обычный)",
      firstTitle().includes("e1"), firstTitle());
  } finally {
    sandbox.fetch = origFetch;
  }
});

await run("v1.27: серверный полнотекстовый поиск (слово из середины текста)", async () => {
  const node = makeNode();
  node.id = 71;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const calls = [];
  // Что «находит» сервер: меняем между запросами (query в URL закодирован
  // escape-последовательностью, поэтому на текст в URL ориентироваться нельзя)
  let serverIds = ["deep1"];
  // Записи приходят через стартовый reload() ноды (как в живую) — в форме
  // сервера, чтобы заодно проверить plMap; совпадение в глубине текста отдаёт
  // только /search (в head такой записи слова запроса нет).
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) {
      return jsonResponse({ folders: [], entries: [
        { id: "loc1", title: "Локальная", prompt: "локальное совпадение иголка", folder: "", media: null },
        { id: "deep1", title: "Глубокая", prompt: "глубина без слов запроса", folder: "", media: null },
      ] });
    }
    if (url.includes("/prompt_library/search")) {
      calls.push(url);
      return jsonResponse({ ids: serverIds });
    }
    return jsonResponse({ ok: true });
  };
  try {
    // Стартовый reload() ноды ушёл ещё до подмены fetch — перечитываем список
    // тем же путём, что и в живую (plMap серверного ответа)
    await st.reload();
    check("v1.27: reload наполнил список из сервера", st.entries.length === 2,
      String(st.entries.length));

    st.search.value = "иголка";
    st.onSearch();
    // v1.39: серверный запрос идёт с паузой (дебаунс) — ждём её в тесте
    await new Promise((r) => setTimeout(r, st.SEARCH_DEBOUNCE + 60));
    check("v1.27: поиск спросил сервер один раз", calls.length === 1 && calls[0].includes("q="), JSON.stringify(calls));
    check("v1.27: id из глубины текста пришли в st.deepIds", st.deepIds && st.deepIds.has("deep1"));
    check("v1.27: карточка из глубины текста показана вместе с локальными",
      st.list.children.length === 2, String(st.list.children.length));

    // Запрос без совпадений: ни локально, ни на сервере
    serverIds = [];
    st.search.value = "ничегонесовпадает";
    st.onSearch();
    await new Promise((r) => setTimeout(r, st.SEARCH_DEBOUNCE + 60));
    check("v1.27: нет совпадений — список пуст", st.list.children.length === 0,
      String(st.list.children.length));

    st.search.value = "";
    st.onSearch();
    await new Promise((r) => setTimeout(r, st.SEARCH_DEBOUNCE + 60));
    check("v1.27: пустой запрос — серверный поиск сброшен, видны все",
      st.deepIds === null && st.list.children.length === 2, String(st.list.children.length));
  } finally {
    sandbox.fetch = origFetch;
  }
});

// --- v1.39: дебаунс поиска: печать больше не бьёт по базе на каждую букву ----
// Каждый /search читает и парсит всю library.json под общим замком базы, а
// oninput срабатывает на КАЖДУЮ букву. Теперь серверный запрос один — на всю серию.
await run("v1.39: поиск — один запрос на серию нажатий (дебаунс)", async () => {
  const node = makeNode();
  node.id = 72;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  const calls = [];
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    if (url.includes("/prompt_library/search")) { calls.push(url); return jsonResponse({ ids: [] }); }
    return jsonResponse({ ok: true });
  };
  try {
    await st.reload();
    for (const q of ["м", "мо", "мон", "монс", "монст"]) {
      st.search.value = q;
      st.search.oninput();
    }
    check("v1.39: пока печатаешь — запросов нет", calls.length === 0, JSON.stringify(calls.length));
    await new Promise((r) => setTimeout(r, st.SEARCH_DEBOUNCE + 80));
    check("v1.39: после паузы — ровно один запрос", calls.length === 1, JSON.stringify(calls));

    // Пустой запрос сбрасывает поиск синхронно и снимает таймер
    st.search.value = "";
    st.onSearch();
    await new Promise((r) => setTimeout(r, st.SEARCH_DEBOUNCE + 80));
    check("v1.39: пустой запрос — без запроса и без лока",
      st.deepIds === null && calls.length === 1, JSON.stringify(calls.length));
  } finally {
    sandbox.fetch = origFetch;
  }
});

await run("v1.27: метка кэша превью чистится при удалении записи", async () => {
  const node = makeNode();
  node.id = 81;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) {
      return jsonResponse({ folders: [], entries: [
        { id: "e1", title: "Удаляемая", prompt: "текст", folder: "", media: "image",
          preview: "previews/e1.png" },
      ] });
    }
    return jsonResponse({ ok: true });
  };
  try {
    await st.reload();
    st.previewStamp.set("e1", Date.now());
    st.render();
    const delBtn = walkDom(st.list).find((el) => el.tagName === "BUTTON"
      && String(el.textContent) === "🗑");
    check("v1.27: кнопка удаления карточки найдена", !!delBtn);
    await delBtn.onclick({ stopPropagation() {} });
    check("v1.27: запись убрана из списка", st.entries.length === 0);
    check("v1.27: метка кэша превью удалена вместе с записью",
      !st.previewStamp.has("e1"), JSON.stringify([...st.previewStamp.keys()]));
  } finally {
    sandbox.fetch = origFetch;
  }
});

// --- v1.33: экспорт записи в папку на диске (§38) ----------------------------
// Кнопка «💾 Экспортировать» в панели книги: по клику открывается системный
// выбор папки (showDirectoryPicker). С обложкой — создаётся ПОДПАПКА <title>/ и
// в неё пишутся <title>.md + обложка <title>.png/.jpg; без обложки — только
// <title>.md прямо в выбранную папку (подпапку не плодим).
let pickerCalled = false;
await run("v1.33: экспорт записи в папку (кнопка + файлы + метаданные)", async () => {
  const node = makeNode();
  node.id = 82;
  proto.onNodeCreated.call(node);
  const st = node._pl;

  // Фейковый FileSystemDirectoryHandle: getDirectoryHandle создаёт подпапку,
  // getFileHandle кладёт файл в текущую папку (путь с префиксом подпапок)
  const files = [];
  const makeDir = (prefix) => ({
    getFileHandle: async (name) => ({
      createWritable: async () => {
        let content = "";
        return {
          write: async (chunk) => { content = chunk; },
          close: async () => { files.push({ name: prefix + name, content }); },
        };
      },
    }),
    getDirectoryHandle: async (name) => makeDir(prefix + name + "/"),
  });
  const fakeDirHandle = makeDir("");

  const origFetch = sandbox.fetch;
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => { pickerCalled = true; return fakeDirHandle; };
  // Превью отдаём как PNG с честным blob.type
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    if (url.includes("/prompt_library/preview")) {
      return { ok: true, status: 200, blob: async () => ({ type: "image/png", size: 3 }) };
    }
    return jsonResponse({ ok: true });
  };
  try {
    // Запись с обложкой и спецсимволами в названии (санитизация имени файла)
    st.full.set("e1", {
      id: "e1", title: 'Запись "важная" / фото?', folder: "Фото",
      prompt: "красивая девушка в парке", media: "image", favorite: true,
      preview: "previews/e1.png", created_at: "2026-09-20 10:00",
    });
    await st.fillDetail("e1");

    // Кнопка на месте, в ряду действий, кликабельна
    check("v1.33: кнопка экспорта создана", !!st.bExport,
      String(st.detail.children.length));
    check("v1.33: кнопка лежит в ряду действий панели",
      st.detail.children.some((c) => Array.isArray(c.children) && c.children.includes(st.bExport)));
    check("v1.33: текст кнопки — «Экспортировать»",
      String(st.bExport.textContent).includes("Экспортировать"), st.bExport.textContent);

    // Клик → диалог выбора папки → создана ПОДПАПКА с названием, файлы внутри
    files.length = 0;
    await st.exportEntry();
    check("v1.33: диалог выбора папки открылся", pickerCalled === true);
    check("v1.33: подпапка <title>/ + файлы внутри неё (обложка есть)",
      files.length === 2
        && files.every((f) => f.name.startsWith("Запись _важная_ _ фото_/")),
      files.map((f) => f.name).join(","));

    // Имя файла: разбор строки, мы вырезаем спецсимволы файловой системы
    const md = files.find((f) => f.name.endsWith(".md"));
    const img = files.find((f) => f.name.endsWith(".png"));
    check("v1.33: .md лежит в подпапке с очищенным названием",
      !!md && md.name === "Запись _важная_ _ фото_/Запись _важная_ _ фото_.md",
      files.map((f) => f.name).join(","));
    check("v1.33: обложка лежит в той же подпапке (.png)",
      !!img && img.name === "Запись _важная_ _ фото_/Запись _важная_ _ фото_.png",
      files.map((f) => f.name).join(","));
    check("v1.33: текст промпта попал в .md", !!md && String(md.content).includes("красивая девушка в парке"),
      String(md.content));
    check("v1.33: метаданные в .md (категория + тип + избранное)",
      !!md && String(md.content).includes("Категория: Фото")
        && String(md.content).includes("📷 фото")
        && String(md.content).includes("В избранном: да"),
      String(md.content));

    // Без обложки — только .md
    files.length = 0;
    st.full.set("e2", { id: "e2", title: "Текст", folder: "", prompt: "просто текст", media: null, favorite: false });
    await st.fillDetail("e2");
    await st.exportEntry();
    check("v1.33: без превью пишется только .md",
      files.length === 1 && files[0].name === "Текст.md",
      files.map((f) => f.name).join(","));

    // Отмена диалога — тихо, ничего не пишется
    files.length = 0;
    windowStub.showDirectoryPicker = async () => { const e = new Error("cancel"); e.name = "AbortError"; throw e; };
    await st.exportEntry();
    check("v1.33: отмена выбора папки — файлы не пишутся и ошибок нет",
      files.length === 0, files.map((f) => f.name).join(","));

    // Браузер без File System Access API — человечная подсказка
    windowStub.showDirectoryPicker = undefined;
    await st.exportEntry();
    check("v1.33: браузер без поддержки — стойкая подсказка про Chrome/Edge",
      !!st.hintSticky && String(st.hintSticky).includes("Chrome"), String(st.hintSticky));
  } finally {
    windowStub.showDirectoryPicker = origPicker;
    sandbox.fetch = origFetch;
  }
});

await run("v1.33: sanitizeFileName режет недопустимые символы", () => {
  const node = makeNode();
  node.id = 83;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  check("v1.33: слэши/двоеточия/елочки вырезаны",
    st.sanitizeFileName('a/b\\c:d*e?f"g<h>i|j') === "a_b_c_d_e_f_g_h_i_j",
    st.sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'));
  check("v1.33: пустое название — фолбэк «запись»",
    st.sanitizeFileName("") === "запись", st.sanitizeFileName(""));
  check("v1.33: точки в начале отрезаны (не dot-file)",
    st.sanitizeFileName("...hidden") === "hidden", st.sanitizeFileName("...hidden"));
});

// --- v1.34: экспорт папок и отмеченного (§39) ----------------------
// Одна умная кнопка «📤 Экспорт» в ряду экспорта/импорта (v1.48: переехала из
// шапки проводника — там с v1.48 только «+ Категория»):
//   — при активных метках (Ctrl/Shift) → exportMarked() (отмеченные записи + категории),
//   — без меток → exportFolder(st.selFolder || "__all") (текущая категория, «Всё», «Избранное», «Без категории»).
// Отдельных кнопок 📤 на строках дерева и в bulk-баре НЕТ (были — шум, переработано).
// Прогресс-бар progTrack flex-резиновый (flex:1 1 0, height 12px), во время экспорта
// подсказка hint скрыта (бар занимает строку), после экспорта возвращается.
// Стаб запросов: /list отдаёт те же записи (иначе фоновый reload() из
// onNodeCreated сбросит st.entries в []), /entry — полные тексты, /preview —
// картинку.
let bulkExportPickerCalled = false;
// Метаданные для /meta (v1.46, §41): NO живого (правильное имя) — сервер отдаёт
// в /list помимо id/title/folder только head. /meta перехватывается тем же
// стабом, чтобы фазы галереи не трогали настоящий бэкенд.
let metaOverride = null;
const installFetchStub = (entries, fulls, metas = null) => {
  listOverride = null;
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse(listOverride ? listResponse : { entries, folders: [] });
    if (url.includes("/prompt_library/entry?id=")) {
      const id = decodeURIComponent(url.split("id=")[1] || "");
      return jsonResponse(fulls.get ? (fulls.get(id) || {}) : (fulls[id] || {}));
    }
    if (url.includes("/prompt_library/meta?id=")) {
      const id = decodeURIComponent(url.split("id=")[1] || "");
      const pool = metas || metaOverride;
      const m = (pool && (pool.get ? pool.get(id) : pool[id])) || {};
      return jsonResponse({ id, meta: m });
    }
    if (url.includes("/prompt_library/preview")) {
      return { ok: true, status: 200, blob: async () => ({ type: "image/png", size: 3 }) };
    }
    return jsonResponse({ ok: true });
  };
};
const makeDirHandle = (files, prefix = "") => ({
  getFileHandle: async (name) => ({
    createWritable: async () => {
      let content = "";
      return {
        write: async (chunk) => { content = chunk; },
        close: async () => { files.push({ name: prefix + name, content }); },
      };
    },
  }),
  getDirectoryHandle: async (name) => makeDirHandle(files, prefix + name + "/"),
});

await run("v1.34: экспорт категории — зеркало иерархии, обложка рядом", async () => {
  const raw = [
    { id: "E1", title: "Фото с моря", folder: "Фото", preview: "p/E1.png", prompt: "полный текст фото с моря" },
    { id: "E2", title: "Портрет", folder: "Фото/Портреты", preview: "", prompt: "полный текст портрета" },
    { id: "E4", title: "Альбом выпуска", folder: "Фото/Портреты/Альбом", preview: "p/E4.png", prompt: "полный текст альбома" },
    { id: "E9", title: "Без папки", folder: "", preview: "", prompt: "полный текст без папки" },
  ];
  // /list шлёт сжатую проекцию (как настоящий сервер) — без prompt/preview
  installFetchStub(raw.map(({ id, title, folder }) => ({ id, title, folder, head: "", favorite: false, pinned: false, has_preview: !!1, media: null })), new Map(raw.map((e) => [e.id, e])));

  const node = makeNode();
  node.id = 84;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  await st.reload();

  const files = [];
  const fakeDirHandle = makeDirHandle(files);

  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => { bulkExportPickerCalled = true; return fakeDirHandle; };
  try {
    await st.exportFolder("Фото");
    // Зеркало: категория «Фото» → папка «Фото/» c файлами; подкатегория портретов
    // ложится в «Фото/Портреты/», а альбом — на уровень глубже.
    check("v1.34: диалог выбора папки открылся", bulkExportPickerCalled === true);
    check("v1.34: файлы в зеркале иерархии (Фото/, Фото/Портреты/, …/Альбом/)",
      files.some((f) => f.name === "Фото/Фото с моря.md")
        && files.some((f) => f.name === "Фото/Портреты/Портрет.md")
        && files.some((f) => f.name === "Фото/Портреты/Альбом/Альбом выпуска.md"),
      files.map((f) => f.name).join(","));
    // Обложка у записей с превью пишется РЯДОМ (не в подпапку <title>/)
    check("v1.34: обложка рядом с .md (не в подпапке title/)",
      files.some((f) => f.name === "Фото/Фото с моря.png")
        && !files.some((f) => f.name.includes("Фото с моря/Фото с моря")),
      files.map((f) => f.name).join(","));
    // .md несёт полный текст (взяли из /entry, а не обрывок head из списка)
    const md = files.find((f) => f.name === "Фото/Фото с моря.md");
    check("v1.34: полный текст промпта в .md",
      !!md && String(md.content).includes("полный текст фото с моря"),
      String(md.content));
    // Единая кнопка экспорта в заголовке проводника (рядом с «+ Категория»),
    // а НЕ на каждой строке дерева — на строках 📤 быть не должно.
    const rowHasEx = (row) => {
      const kids = Array.isArray(row.children) ? row.children : [];
      return kids.some((c) => c.textContent === "📤");
    };
    check("v1.34: у строк дерева НЕТ кнопки 📤 (одна кнопка на ноде)",
      !Array.from(st.tree.children).some(rowHasEx));
    check("v1.34/v1.48: есть кнопка «📤 Экспорт» — в ряду экспорта, а не в дереве",
      !!st.exportBtn && st.exportBtn.textContent === "📤 Экспорт"
        && st.exportRow.children.includes(st.exportBtn));
    // Прогресс-бар: перехватываем setExportProgress во время экспорта —
    // он скрыт ДО экспорта, показан с процентами ВО ВРЕМЯ и скрыт ПОСЛЕ.
    // Во время показа подсказка внизу скрыта (бар занимает всю строку) —
    // «резиновый» растягивающийся бар.
    const origProg = st.setExportProgress;
    const progCalls = [];
    const hintDuringShow = [];
    st.setExportProgress = (...args) => {
      const [show] = args;
      const r = origProg(...args);
      // Сразу после применения: что видно в строке в момент ПОКАЗА бара.
      if (show) hintDuringShow.push({ hint: st.hint.style.display, track: st.progTrack.style.display });
      progCalls.push(args);
      return r;
    };
    check("v1.34: прогресс-бар скрыт до экспорта", st.progTrack.style.display === "none");
    await st.exportFolder("Фото");
    st.setExportProgress = origProg;
    check("v1.34: прогресс-бар показан во время экспорта и заполнен",
      progCalls.some(([show, done, total]) => show && done > 0 && total > 0));
    check("v1.34: во время показа подсказка скрыта, бар занимает строку",
      hintDuringShow.length > 0 && hintDuringShow.every((s) => s.hint === "none" && s.track === ""),
      JSON.stringify(hintDuringShow));
    check("v1.34: прогресс-бар скрыт после экспорта", st.progTrack.style.display === "none");
    check("v1.34: подсказка возвращена после экспорта", st.hint.style.display === "");
  } finally {
    windowStub.showDirectoryPicker = origPicker;
  }
});

await run("v1.34: экспорт категории — __all, избранное, записи без папки", async () => {
  const raw = [
    { id: "FA", title: "Избранная", folder: "Фото/Портреты", preview: "", prompt: "textFA", favorite: true },
    { id: "FR", title: "Избранная корень", folder: "", preview: "", prompt: "textFR", favorite: true },
    { id: "NR", title: "Обычная без папки", folder: "", preview: "", prompt: "textNR", favorite: false },
    { id: "NO", title: "Обычная в папке", folder: "Архив", preview: "", prompt: "textNO", favorite: false },
  ];
  installFetchStub(raw.map((e) => ({ id: e.id, title: e.title, folder: e.folder, favorite: e.favorite, head: "", pinned: false, has_preview: false, media: null })), new Map(raw.map((e) => [e.id, e])));

  const node = makeNode();
  node.id = 85;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  await st.reload();

  const files = [];
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => makeDirHandle(files);

  // __all: вся база от корня (дерево сохраняется и для вложенных папок)
  files.length = 0;
  await st.exportFolder("__all");
  check("v1.34: «Всё» — зеркало всей базы от корня, вложенные папки сохранены",
    files.some((f) => f.name === "Фото/Портреты/Избранная.md")
      && files.some((f) => f.name === "Избранная корень.md")
      && files.some((f) => f.name === "Архив/Обычная в папке.md")
      && files.some((f) => f.name === "Обычная без папки.md"),
    files.map((f) => f.name).join(","));

  // __fav: только избранные, но дерево их папок сохранено
  files.length = 0;
  await st.exportFolder("__fav");
  check("v1.34: «Избранное» — только избранные с сохранением папок",
    files.some((f) => f.name === "Фото/Портреты/Избранная.md")
      && files.some((f) => f.name === "Избранная корень.md")
      && !files.some((f) => f.name.includes("Обычная")),
    files.map((f) => f.name).join(","));

  // __root: записи БЕЗ категории — в корень выбранной папки
  files.length = 0;
  await st.exportFolder("__root");
  check("v1.34: «Без категории» — только без папки, в корень",
    files.some((f) => f.name === "Обычная без папки.md")
      && files.some((f) => f.name === "Избранная корень.md")
      && !files.some((f) => f.name.includes("/")),
    files.map((f) => f.name).join(","));

  // Пустая категория — стойкое сообщение, диалог НЕ открывается
  files.length = 0;
  let pickerOpened = false;
  windowStub.showDirectoryPicker = async () => { pickerOpened = true; return makeDirHandle(files); };
  await st.exportFolder("Пустота");
  check("v1.34: пустая категория — подсказка и без диалога",
    pickerOpened === false && !!st.hintSticky && String(st.hintSticky).includes("нечего экспортировать"),
    String(st.hintSticky));
  // Отмена диалога — тихо, ничего не пишется
  files.length = 0;
  windowStub.showDirectoryPicker = async () => { const e = new Error("cancel"); e.name = "AbortError"; throw e; };
  await st.exportFolder("__all");
  check("v1.34: отмена выбора папки — тихо, ничего не писано", files.length === 0, st.hintSticky);
  // Браузер без File System Access API — подсказка про Chrome/Edge
  windowStub.showDirectoryPicker = undefined;
  await st.exportFolder("__all");
  check("v1.34: без поддержки API — подсказка про Chrome/Edge",
    !!st.hintSticky && String(st.hintSticky).includes("Chrome"), String(st.hintSticky));
  windowStub.showDirectoryPicker = origPicker;
});

await run("v1.34: bulk-экспорт отмеченного (записи + категории)", async () => {
  const raw = [
    { id: "B1", title: "Помеченная запись", folder: "Фото", preview: "", prompt: "textB1" },
    { id: "B4", title: "Внутри помеченной папки", folder: "Фото/Портреты", preview: "", prompt: "textB4" },
    { id: "B9", title: "Без папки", folder: "", preview: "", prompt: "textB9" },
    { id: "BX", title: "Не отмечена", folder: "Другое", preview: "", prompt: "textBX" },
  ];
  installFetchStub(raw.map((e) => ({ id: e.id, title: e.title, folder: e.folder, head: "", favorite: false, pinned: false, has_preview: false, media: null })), new Map(raw.map((e) => [e.id, e])));

  const node = makeNode();
  node.id = 86;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  await st.reload();
  // Отмечены: запись B1 (занесена в bulk-бар) и категория «Фото» (её содержимое
  // с подпапками попадает по клику в bulk-баре)
  st.markEntries.add("B1");
  st.markFolders.add("Фото");

  const files = [];
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => makeDirHandle(files);
  try {
    await st.exportMarked();
    check("v1.34: bulk-экспорт берёт отмеченные записи + содержимое отмеченных категорий",
      files.some((f) => f.name === "Фото/Помеченная запись.md")
        && files.some((f) => f.name === "Фото/Портреты/Внутри помеченной папки.md")
        && !files.some((f) => f.name.includes("Не отмечена")),
      files.map((f) => f.name).join(","));
    // Экспорт без пометок — ничего не делает, без диалога
    let opened = false;
    st.markEntries.clear(); st.markFolders.clear();
    windowStub.showDirectoryPicker = async () => { opened = true; return makeDirHandle(files); };
    await st.exportMarked();
    check("v1.34: экспорт без пометок — без диалога и действий", opened === false, String(!!st.hintSticky));
  } finally {
    windowStub.showDirectoryPicker = origPicker;
  }
});

// Умная кнопка «📤 Экспорт» (v1.48 — в ряду экспорта/импорта): при активных метках
// экспортирует отмеченное (exportMarked), без меток — текущую категорию
// (exportFolder). Отдельной bulk-кнопки в нижней строке БОЛЬШЕ НЕТ.
// --- v1.39: экспорт не теряет записи с одинаковыми названиями -----------------
// Имя файла берётся из названия записи (авто-название = первые 60 символов
// промпта), а `getFileHandle(..., {create:true})` молча перезатирает первый файл.
// В живой базе таких групп 6 — это 9 записей, которые «Экспорт всего» терял.
await run("v1.39: экспорт — три записи с одним названием = три файла", async () => {
  const raw = [
    { id: "D1", title: "Одинаковое имя", folder: "Дуб", preview: "", prompt: "первый текст" },
    { id: "D2", title: "Одинаковое имя", folder: "Дуб", preview: "", prompt: "второй текст" },
    { id: "D3", title: "Одинаковое имя", folder: "Дуб", preview: "", prompt: "третий текст" },
  ];
  installFetchStub(raw.map(({ id, title, folder }) => ({ id, title, folder, head: "", favorite: false, pinned: false, has_preview: false, media: null })), new Map(raw.map((e) => [e.id, e])));

  const node = makeNode();
  node.id = 85;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  await st.reload();

  const files = [];
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => makeDirHandle(files);
  try {
    await st.exportFolder("Дуб");
    const names = files.map((f) => f.name);
    check("v1.39: три записи с одним названием — три файла (одна раньше терялась)",
      files.length === 3, JSON.stringify(names));
    check("v1.39: имена файлов различаются", new Set(names).size === 3, JSON.stringify(names));
    const all = files.map((f) => String(f.content)).join("\n");
    check("v1.39: тексты всех записей на диске",
      all.includes("первый текст") && all.includes("второй текст") && all.includes("третий текст"));
    check("v1.39: в .md виден № записи (видно, чей файл)",
      files.every((f) => /- №: D\d/.test(String(f.content))),
      JSON.stringify(files.map((f) => String(f.content).split("\n")[2])));
  } finally {
    windowStub.showDirectoryPicker = origPicker;
  }
});

await run("v1.34: умная кнопка экспорта (метки → отмеченное, без меток → категория)", async () => {
  const raw = [
    { id: "S1", title: "Запись одна", folder: "Фото", preview: "", prompt: "textS1", favorite: false },
    { id: "S2", title: "Запись два", folder: "Без папки", preview: "", prompt: "textS2", favorite: false },
  ];
  installFetchStub(raw.map((e) => ({ id: e.id, title: e.title, folder: e.folder, head: "", favorite: false, pinned: false, has_preview: false, media: null })), new Map(raw.map((e) => [e.id, e])));

  const node = makeNode();
  node.id = 87;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  await st.reload();

  const files = [];
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => makeDirHandle(files);
  // Нет bulk-кнопки в нижней строке (одна кнопка — в ряду экспорта/импорта)
  check("v1.34: отдельной bulk-кнопки экспорта в нижней строке нет",
    !("bulkExport" in st) || st.bulkExport === undefined, String(st.bulkExport));

  // С метками — экспорт отмеченного (exportFolder не вызывается): шпион
  // перехватывает exportFolder, но экспорт идёт через exportMarked (настоящий).
  let folderCalls = [];
  const origFolder = st.exportFolder;
  st.exportFolder = async (k) => { folderCalls.push(k); };
  st.markEntries.add("S1");
  files.length = 0;
  await st.exportBtn.onclick();
  st.exportFolder = origFolder;
  check("v1.34: при метках умная кнопка экспортирует отмеченное",
    files.some((f) => f.name.includes("Запись одна")) && !files.some((f) => f.name.includes("Запись два")),
    files.map((f) => f.name).join(","));
  check("v1.34: при метках exportFolder не вызван", folderCalls.length === 0, String(folderCalls));

  // Без меток — экспорт текущей категории (selFolder, настоящий exportFolder)
  st.markEntries.clear(); st.markFolders.clear();
  st.selFolder = "Фото";
  files.length = 0;
  await st.exportBtn.onclick();
  check("v1.34: без меток умная кнопка экспортирует текущую категорию",
    files.some((f) => f.name === "Фото/Запись одна.md")
      && !files.some((f) => f.name.includes("Запись два")),
    files.map((f) => f.name).join(","));

  // Без меток и без выбранной категории — вся база (__all)
  st.selFolder = "__all";
  files.length = 0;
  await st.exportBtn.onclick();
  check("v1.34: без меток и выбранной категории — вся база",
    files.some((f) => f.name === "Фото/Запись одна.md")
      && files.some((f) => f.name === "Без папки/Запись два.md"),
    files.map((f) => f.name).join(","));

  // Метки после экспорта остаются как есть (не сбрасываются кнопкой)
  st.markEntries.add("S2");
  folderCalls = [];
  st.exportFolder = async (k) => { folderCalls.push(k); };
  await st.exportBtn.onclick();
  st.exportFolder = origFolder;
  check("v1.34: при метках кнопка НЕ экспортирует категорию (экспорт отмеченного)",
    folderCalls.length === 0, String(folderCalls));
  st.markEntries.clear();
  files.length = 0;
  await st.exportBtn.onclick();
  check("v1.34: после сброса меток кнопка снова экспортирует категорию/базу",
    files.some((f) => f.name === "Фото/Запись одна.md"),
    files.map((f) => f.name).join(","));

  windowStub.showDirectoryPicker = origPicker;
});

// --- v1.45 (§40): мультивывод — выходы по требованию ----------------------
// Сокеты доп. выходов создаются/убираются ФИЗИЧЕСКИ (addOutput/removeOutput):
// `o.hide` в этом фронтенде не работает вовсе (NodeSlots.vue рисует все
// nodeData.outputs — живой факт, см. SPEC §40.2). Номер выхода = место в списке
// «🔌 Выходы». Проверяем: bindOutSlot/unbindOutSlot/reorderOutSlot/
// applyOutSockets/plDrop→__outs, кнопку «Подключить выход», карточки с превью,
// папку-вывод (active_id), гидрацию slots_out, лимит и дубли.
const ftext = (el) => {
  const a = [];
  const walk = (x) => {
    if (x.children && x.children.length) { for (const c of x.children) walk(c); return; }
    if (x.textContent) a.push(String(x.textContent));
  };
  walk(el);
  return a.join("|");
};
const mkSlotEntry = (id, folder = "", title = null) => ({ id, title: title || id, head: id, folder, favorite: false,
  created_at: "2026-09-18T01:00:00", last_used: null,
  has_preview: false, has_workflow: false, media: "image" });
const addSlotEnv = (node) => {
  node.addWidget("text", "slots_out", "", null, { hidden: true, hideInPanel: true, serialize: true });
  // Отключаем reload в тестах, чтобы не перезаписывать тестовые entries
  node._pl.reload = async () => {};
};
// Нода для фаз мультивывода + кадр rAF (сокеты правятся именно там, чтобы не
// урезать outputs до configure при загрузке графа). entries/folders — общие
// массивы с ответом /list: фаза НАПОЛНЯЕТ их (push), а не подменяет ссылку, иначе
// «догоняющий» reload ноды отдал бы старые данные чужой фазы.
const mkSlotNode = () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  st.reload = async () => {};
  st.entries = [];
  st.folders = [];
  listOverride = { entries: st.entries, folders: st.folders };
  flushRaf("slots:onNodeCreated");
  return node;
};
const slotWidget = (node) => node.widgets.find((w) => w.name === "slots_out");

await run("slots: свежая нода — только 2 выхода; привязка создаёт свой сокет", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("e1", "", "abcdefghijklmnopqrstuvwxyz"), mkSlotEntry("e2"));
  st.selFolder = "__all";
  st.renderTree(); st.render();
  check("на свежей ноде видны только 2 штатных выхода (12 → 2)",
    node.outputs.length === 2 && node.outputs[0].name === "category_path" && node.outputs[1].name === "prompt_1",
    String(node.outputs.length));
  st.plDrop({ kind: "entry", ids: ["e1"], id: "e1" }, "__outs");
  const slots = st.readOutSlots();
  check("привязка заняла выход 2 (card e1)",
    slots.length === 1 && slots[0].i === 2 && slots[0].kind === "card" && slots[0].id === "e1");
  check("появился ровно один доп. сокет (prompt_2)",
    node.outputs.length === 3 && node.outputs[2].name === "prompt_2", `len=${node.outputs.length}, name=${node.outputs[2] && node.outputs[2].name}`);
  check("RU-имя сокета из локали деф-а («промпт 2»)",
    node.outputs[2].localized_name === "промпт 2", String(node.outputs[2].localized_name));
  check("tooltip сокета показывает, что уходит в провод",
    node.outputs[2].title && node.outputs[2].title.includes("abcdefghijklmnop"),
    String(node.outputs[2].title));
  check("привязка записана в виджет", (() => { const w = slotWidget(node); return typeof w.value === "string" && JSON.parse(w.value).length === 1; })());
  st.plDrop({ kind: "entry", ids: ["e1"], id: "e1" }, "__outs");
  check("дубль той же карточки игнорируется", st.readOutSlots().length === 1 && node.outputs.length === 3);
  st.plDrop({ kind: "entry", ids: ["e2"], id: "e2" }, "__outs");
  check("следующая привязка → выход 3 (сокетов стало 4)",
    st.readOutSlots().length === 2 && st.readOutSlots()[1].i === 3 && node.outputs.length === 4);
});

await run("slots: папка-вывод — карточки с превью, клик не уводит из «Выходов»", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("e10", "ПапкаA"), mkSlotEntry("e11", "ПапкаA"));
  st.entries[1].has_preview = true;
  st.folders.push("ПапкаA");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "e11"; // активное выделение лежит в этой папке
  st.renderTree(); st.render();
  st.plDrop({ kind: "folder", path: "ПапкаA" }, "__outs");
  const slot = st.readOutSlots()[0];
  check("папка-вывод: kind folder, active_id наследует выделение",
    slot && slot.kind === "folder" && slot.path === "ПапкаA" && slot.active_id === "e11");
  check("сокет выхода 2 появился", node.outputs.length === 3);
  // Строка папки-вывода в дереве несёт НОМЕР провода
  const folderSlotRow = st.tree.children.find((r) => ftext(r).includes("ПапкаA") && ftext(r).includes("🔌2"));
  check("папка-вывод видна в дереве с номером провода (📁 ПапкаA + 🔌2)", !!folderSlotRow,
    st.tree.children.map((r) => ftext(r)).join(" ; "));
  // v1.55: ЛЮБОЙ значок 🔌 в дереве обязан быть осветлён так же, как на
  // карточках. Обход всего дерева, а не поиск одного элемента: у папки-вывода
  // в дереве сразу ДВА места с 🔌 — строка слота (пролёт с фильтром, v1.45.7) и
  // бейдж «🔌2» у самой строки папки (был без фильтра). Поиск «первого
  // подходящего» находил только строку слота и молчал о бейдже.
  const treePlugs = [];
  const walkPlugs = (el) => {
    for (const c of (el.children || [])) {
      const t = String(c.textContent || "");
      if (!(c.children || []).length && t.includes("🔌")) treePlugs.push(c);
      walkPlugs(c);
    }
  };
  walkPlugs(st.tree);
  const darkPlugs = treePlugs.filter((s) => !String(s.style.cssText).includes("brightness(1.65)"));
  check("каждый 🔌 в дереве осветлён (и строка слота, и бейдж у папки): найдено >= 2, тёмных 0",
    treePlugs.length >= 2 && darkPlugs.length === 0,
    `всего 🔌: ${treePlugs.length}; без фильтра: ${darkPlugs.map((s) => s.textContent + " | " + s.style.cssText).join(" ;; ") || "—"}`);
  folderSlotRow.onclick({});
  check("клик открыл папку внутри «Выходов»", st.selFolder === "__outs" && st.outsActiveFolder === "ПапкаA");
  st.render();
  // Карточки папки — с превью (img), как в обычном списке
  const cards = st.list.children.filter((c) => c.children[0] && c.children[0].tagName === "IMG");
  check("карточки папки показаны с превью (img)", cards.length === 2, String(cards.length));
  const activeCard = cards.find((c) => String(c.style.cssText).includes("background:#2e6b4f"));
  check("активный вывод e11 — ярко-зелёный dblclick (фон #2e6b4f)", !!activeCard);
  const nonActive = cards.find((c) => !String(c.style.cssText).includes("background:#2e6b4f"));
  check("есть неактивная карточка", !!nonActive);
  await nonActive.ondblclick?.({});
  check("двойной клик переключил active_id на e10", st.outSlotOfFolder("ПапкаA").active_id === "e10");
  check("selFolder не поменялся — из «Выходов» никуда не уходим", st.selFolder === "__outs", st.selFolder);
  // v1.59 (§независимость): клик по карточке в «Выходах» переключает только
  // активный вывод папки-слота (провод), но НЕ трогает основной выход и не
  // снимает выделение с не подключённого промпта. selWidget остаётся "e11"
  // (он не подключён к «Выходы»), панель открыта для просмотра.
  check("карточка «Выходов» НЕ трогает основной выход (selWidget остался e11), просмотр открыт",
    st.selWidget.value === "e11" && st.detail.style.display === "flex" && st.detailId === "e10",
    `sel=${st.selWidget.value}, detail=${st.detail.style.display}, detailId=${st.detailId}`);
  st.render();
  const newActive = st.list.children.filter((c) => c.children[0] && c.children[0].tagName === "IMG")
    .find((c) => String(c.style.cssText).includes("background:#2e6b4f"));
  check("после перерисовки активна e10 (а не пропала)", !!newActive,
    `outs=${st.outsActiveFolder} kids=${st.list.children.map((c) => ftext(c)).join(" ; ")}`);
  check("сокет выхода 2 — про папку-вывод и её активную карточку",
    String(node.outputs[2].title).includes("ПапкаA") && String(node.outputs[2].title).includes("e10"),
    String(node.outputs[2].title));

  // v1.45.1 (п. 2–3 из отчёта пользователя): в виде «Список» карточки «Выходов»
  // обязаны быть как обычные — превью из текущего вида (82px), ширина на всю
  // строку. Раньше тут были жёсткие 40px («узкие карточки с мелкими превью»).
  st.viewSel.value = "list";
  st.render();
  check("вид «Список» — список остаётся колонкой", st.list.style.flexDirection === "column",
    st.list.style.flexDirection);
  const listCard = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG");
  check("в «Списке» превью вывода — 82px (не жёсткие 40px)",
    !!listCard && String(listCard.children[0].style.cssText).includes("width:82px"),
    listCard ? String(listCard.children[0].style.cssText) : "нет карточки");
  check("в «Списке» карточка вывода тянется на всю строку (нет фикс. ширины)",
    !!listCard && !String(listCard.style.cssText).includes("width:"),
    listCard ? String(listCard.style.cssText) : "нет карточки");
  // Шапка-подсказка живёт в flex-КОЛОНКЕ, где `flex:1 1 100%` означает «вся
  // высота» — она растягивалась и выдавливала карточки в низ списка (скриншот).
  const headEl = st.list.children.find((c) => ftext(c).includes("решает, что уходит"));
  check("шапка папки-вывода не растягивается — карточки не падают вниз",
    !!headEl && String(headEl.style.cssText).includes("flex:0 0 auto")
      && !String(headEl.style.cssText).includes("flex:1 1 100%"),
    headEl ? String(headEl.style.cssText) : "нет шапки");
  check("шапка стоит в списке первой, карточки — после неё",
    st.list.children[0] === headEl && st.list.children.indexOf(listCard) > 0);
  st.viewSel.value = "large";
  st.render();
});

// v1.59 (§независимость): «Выходы» не дышат в основной выход. В ОБЫЧНОЙ галерее
// карточка, подключённая слотом (или лежащая в папке-выводе), при клике НЕ пишет
// в selWidget (основной промпт 1) и НЕ снимает выделение с неподключённых
// промптов — она лишь открывает панель просмотра. Неподключённая карточка
// по-прежнему выбирается обычным кликом.
await run("v1.59: карточки «Выходов» и папки-выводов не трогают основной выход в обычной галерее", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.folders.push("Фото", "Видео");
  st.entries.push(mkSlotEntry("e1", "Фото"), mkSlotEntry("e2", "Фото"), mkSlotEntry("e3", "Видео"));
  st.selFolder = "__all";
  st.renderTree(); st.render();
  // Основной выход смотрит на НЕ подключённую запись e3 («Видео»).
  st.selWidget.value = "e3";
  // Карточка e1 подключена слотом на доп. выход; папка «Фото» — папкой-выводом.
  st.plDrop({ kind: "entry", id: "e1" }, "__outs");
  st.plDrop({ kind: "folder", path: "Фото" }, "__outs");
  st.renderTree(); st.render();
  const cardE1 = st.list.children.find((c) => ftext(c).includes("e1"));
  check("в обычной галерее есть карточка e1 (подключённая к «Выходы»)", !!cardE1,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  await cardE1.onclick({});
  check("клик по подключённой карточке НЕ пишет в основной выход (selWidget остался e3), только просмотр",
    st.selWidget.value === "e3" && st.detailId === "e1" && st.detail.style.display === "flex",
    `sel=${st.selWidget.value}, id=${st.detailId}, d=${st.detail.style.display}`);
  // Карточка из папки-вывода (e2 тоже в «Фото»): тот же принцип.
  const cardE2 = st.list.children.find((c) => ftext(c).includes("e2"));
  check("есть карточка e2 (лежит в папке-выводе «Фото»)", !!cardE2,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  await cardE2.onclick({});
  check("клик по карточке из папки-вывода тоже не трогает основной выход (selWidget=e3)",
    st.selWidget.value === "e3", `sel=${st.selWidget.value}`);
  check("просмотр e2 открыт", st.detailId === "e2" && st.detail.style.display === "flex",
    `id=${st.detailId}, d=${st.detail.style.display}`);
  // Неподключённая карточка обязана выбираться как раньше (регрессия обычного клика).
  const cardE3 = st.list.children.find((c) => ftext(c).includes("e3"));
  check("есть карточка e3 (не подключена)", !!cardE3,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  await cardE3.onclick({});
  check("клик по НЕ подключённой карточке по-прежнему выбирает её в основной выход",
    st.selWidget.value === "e3", `sel=${st.selWidget.value}`);
});

// v1.72.3 (отчёт пользователя): «в «Выходах» при одиночном клике подсветка
// карточек не происходит, хотя выбор меняется; при двойном — подсвечивает».
// Причина: isSel в makeOutCard смотрел только на selWidget, а клик в «Выходах»
// по контракту v1.59 в selWidget НЕ пишет — выбор живёт в detailId. Подсветка
// «Выходов» обязана следовать detailId, не меняя selWidget.
await run("v1.72.3: одиночный клик в «Выходах» подсвечивает карточку (detailId), selWidget не трогаем", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.folders.push("ПапкаA", "Прочее");
  st.entries.push(mkSlotEntry("e10", "ПапкаA"), mkSlotEntry("e11", "ПапкаA"), mkSlotEntry("e12", "Прочее"));
  st.selWidget.value = "e11"; // основной выход — НЕ на тех карточках, что кликаем
  st.plDrop({ kind: "folder", path: "ПапкаA" }, "__outs"); // 🔌2
  st.plDrop({ kind: "entry", id: "e12" }, "__outs");       // 🔌3
  st.selFolder = "__outs";
  st.outsActiveFolder = null;
  st.renderTree(); st.render();

  // (а) отдельная карточка-слот в корне «Выходов»
  const slotCard = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG" && ftext(c).includes("e12"));
  check("слот-карточка e12 отображена в «Выходах»", !!slotCard,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  // v1.73.5 (§64, контракт А): включённая слот-карточка теперь ВСЕГДА яркая
  // #2e6b4f — ассерт «клик подсветил» на включённой ловил бы не клик, а
  // состояние. Контракт клика-подсветки (detailId → isSel → #1c3525)
  // проверяем на выключенной карточке; включённая покрыта фазой v1.73.5.
  // §2.3: конфликт задача↔тест → правится тест, фикс не откатывается.
  // readOutSlots каждый раз отдаёт новые объекты — off пишем через writeOutSlots.
  const e12Arr = st.readOutSlots();
  const e12S = e12Arr.find((x) => x && x.kind === "card" && x.id === "e12");
  if (e12S) { e12S.off = true; st.writeOutSlots(e12Arr); }
  await slotCard.onclick({});
  check("слот: панель открыта для e12, selWidget остался e11 (v1.59 не тронут)",
    st.detailId === "e12" && st.selWidget.value === "e11",
    `detail=${st.detailId}, sel=${st.selWidget.value}`);
  st.render();
  const selCard = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG" && ftext(c).includes("e12"));
  check("слот: одиночный клик подсветил карточку зелёным (фон #1c3525 + рамка #2e6b4f)",
    !!selCard && String(selCard.style.cssText).includes("background:#1c3525")
      && String(selCard.style.cssText).includes("#2e6b4f"),
    selCard ? String(selCard.style.cssText).slice(0, 160) : "нет карточки");

  // (б) карточка внутри папки-вывода
  const row = st.tree.children.find((r) => ftext(r).includes("ПапкаA") && ftext(r).includes("🔌2"));
  check("строка папки-вывода «ПапкаA» в дереве есть", !!row);
  row.onclick({});
  st.render();
  const inFolder = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG" && ftext(c).includes("e10"));
  check("карточка e10 внутри папки-вывода отображена", !!inFolder,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  await inFolder.onclick({});
  check("папка: панель открыта для e10, selWidget остался e11",
    st.detailId === "e10" && st.selWidget.value === "e11",
    `detail=${st.detailId}, sel=${st.selWidget.value}`);
  st.render();
  const c10 = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG" && ftext(c).includes("e10"));
  const c11 = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG" && ftext(c).includes("e11"));
  check("папка: одиночный клик подсветил e10 зелёным (фон #1c3525)",
    !!c10 && String(c10.style.cssText).includes("background:#1c3525"),
    c10 ? String(c10.style.cssText).slice(0, 160) : "нет карточки");
  check("папка: активная e11 — ярко-зелёная dblclick (фон #2e6b4f), важнее селекта",
    !!c11 && String(c11.style.cssText).includes("background:#2e6b4f"),
    c11 ? String(c11.style.cssText).slice(0, 160) : "нет карточки");
});

// v1.45.3 (два скриншота пользователя):
// (1) иконка 📷 в заголовке карточки «сползла вниз» — пролёты иконок обязаны
//     стоять по строке (inline-block + line-height:1 + vertical-align:middle):
//     глиф Segoe UI Emoji сидел ниже базовой линии текста.
// (2) папка-слот в видах «Крупные»/«Средние»: занимать ЯЧЕЙКУ карточки —
//     ширина = карточка (imgSize + 12), высота — как у карточки БЕЗ превью
//     (общая растяжка линии сетки, свой align-self не ставим). Изначально
//     папка была огромной (по ширине контента), потом слишком маленькой
//     (align-self:flex-start) — отчёт пользователя, финал — ровно ячейка.
await run("v1.45.3: иконка по строке, папка-слот по размеру карточки в сетке", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selFolder = "__outs"; // мы В «Выходах»: list должен рисовать строки слотов
  st.entries.push(mkSlotEntry("e1", "", "Аналитика"), mkSlotEntry("e10", "ПапкаA"));
  st.folders.push("ПапкаA");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "e1";
  st.renderTree(); st.render();
  st.plDrop({ kind: "folder", path: "ПапкаA" }, "__outs");
  st.plDrop({ kind: "entry", ids: ["e1"], id: "e1" }, "__outs");
  st.render();
  // (1) пролёты иконок в заголовке карточки выровнены по строке
  const card = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG");
  check("карточка вывода в «Выходах» есть", !!card);
  const titleBox = card ? card.children[1].children[0] : null;
  const icons = titleBox ? titleBox.children.filter((s) => /[🔌📌📷🎬]/.test(String(s.textContent || ""))) : [];
  check("иконки заголовка — inline-block с line-height:1 и vertical-align:middle",
    icons.length > 0 && icons.every((s) => {
      const cs = String(s.style.cssText);
      return cs.includes("display:inline-block") && cs.includes("line-height:1")
        && cs.includes("vertical-align:middle");
    }),
    icons.map((s) => String(s.style.cssText)).join(" || ") || "нет иконок");
  // v1.45.4 (третий скриншот пользователя): после вертикал-align инки внутри
  // эмодзи-бокса всё равно сидят на разной высоте — живой canvas-скан дал
  // 📷 3.4px, 🎬 1.4, 📌 1.8, 🔌 1.6 ниже текстового центра. Каждому глифу —
  // свой translateY, чтобы чернила встали на центр текста.
  // v1.45.5 (чётвёртый скрин): в плотном ряду «Списка» камера с полным подъёмом
  // по глазу чуть выше — там съезжаем на -2.4px (dense-правило в plCardTitle.
  // «Выходы» тут, как и в жизни, рисуются рядами «Списка» → камера -2.4).
  // v1.45.6 (пятый скрин): пролёт «🔌N » несёт ЦИФРУ вывода — цифра это обычный
  // текст, поднятый пролёт всплывает ею. Правило plIcon: подъём только у чистых
  // эмодзи, «🔌N » без подъёма (число стоит на строке как имя).
  const needLift = { "📷": "-3.4px", "🎬": "-1.4px", "📌": "-1.8px", "🔌": "-1.6px" };
  check("иконки заголовка — точный подъём чернил по глифу (v1.45.4)",
    icons.length > 0 && icons.every((s) => {
      const g = String(s.textContent || "").match(/(📷|🎬|📌|🔌)/);
      if (!g) return false;
      const want = needLift[g[1]];
      return want ? s.style.transform === "translateY(" + want + ")" : !s.style.transform;
    }),
    icons.map((s) => `${s.textContent}->${s.style.transform}`).join(" || ") || "нет иконок");
  // Список (dense): камера чуть ниже (-2.4px), пролёт «🔌N » без подъёма —
  // с подъёмом цифра (обычный текст) «всплывала» (v1.45.6). В сетке (крупных/
  // средних) блок «эмодзи+цифра» поднят целиком на -1.6px (v1.45.7).
  const vsel = st.viewSel;
  vsel.value = "list";
  st.render();
  const card2 = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG");
  const title2 = card2 ? card2.children[1].children[0] : null;
  const icons2 = title2 ? title2.children.filter((s) => /[🔌📌📷🎬]/.test(String(s.textContent || ""))) : [];
  check("Список: dense-подъём камеры -2.4px, 🔌N без подъёма (v1.45.5/v1.45.6)",
    icons2.length > 0 && icons2.every((s) => {
      const g = String(s.textContent || "").match(/(📷|🎬|📌|🔌)/);
      if (!g) return false;
      if (g[1] === "🔌") return !s.style.transform;
      return s.style.transform === "translateY(" + (g[1] === "📷" ? "-2.4px" : needLift[g[1]]) + ")";
    }),
    icons2.map((s) => `${s.textContent}->${s.style.transform}`).join(" || ") || "нет иконок");
  vsel.value = "large";
  st.render();
  // (2) папка-слот в «Крупных» — в ячейке карточки: ширина175px, высота
  // общая растяжка линии сетки (как у карточки без превью): отдельного
  // align-self у папки НЕТ — иначе она сжимается в маленький брусок.
  const rowLg = st.list.children.find((c) => ftext(c).includes("папка-вывод"));
  check("в «Крупных» папка-слот в ячейке карточки (175px, тянется как карточка без превью)",
    !!rowLg && String(rowLg.style.cssText).includes("width:175px")
      && String(rowLg.style.cssText).includes("flex-direction:column")
      && !String(rowLg.style.cssText).includes("align-self:flex-start"),
    rowLg ? String(rowLg.style.cssText) : "нет строки папки");
  st.viewSel.value = "medium"; st.render();
  const rowMd = st.list.children.find((c) => ftext(c).includes("папка-вывод"));
  check("в «Средних» ширина папка-слота = 121px",
    !!rowMd && String(rowMd.style.cssText).includes("width:121px"),
    rowMd ? String(rowMd.style.cssText) : "нет строки папки");
  // (2b) «Список» не пострадал: строка по-прежнему без фикс. ширины
  st.viewSel.value = "list"; st.render();
  const rowRow = st.list.children.find((c) => ftext(c).includes("папка-вывод"));
  check("в «Списке» строка папки без фикс. ширины (на всю строку)",
    !!rowRow && !String(rowRow.style.cssText).includes("width:"),
    rowRow ? String(rowRow.style.cssText) : "нет строки папки");
  st.viewSel.value = "large"; st.render();
});

await run("slots: отвязка снимает свой сокет, чужие провода переезжают с привязкой", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("e1"), mkSlotEntry("e2"), mkSlotEntry("e3"));
  st.selFolder = "__all";
  st.bindOutSlot({ kind: "card", id: "e1", name: "e1" });
  st.bindOutSlot({ kind: "card", id: "e2", name: "e2" });
  st.bindOutSlot({ kind: "card", id: "e3", name: "e3" });
  check("три привязки — сокеты 2,3,4", node.outputs.length === 5, String(node.outputs.length));
  node.outputs[2].links = [7]; // выход 2 → e1
  node.outputs[4].links = [9]; // выход 4 → e3
  st.unbindOutSlot(3);          // снимаем СРЕДНИЙ (e2)
  const left = st.readOutSlots();
  check("привязок осталось 2: e1 и e3", left.length === 2 && left[0].id === "e1" && left[1].id === "e3",
    JSON.stringify(left.map((s) => s.id)));
  check("сокетов стало 4 (свой сокет убран)", node.outputs.length === 4, String(node.outputs.length));
  check("провод e1 остался на выходе 2", node.outputs[2].links.length === 1);
  check("провод e3 переехал на выход 3 вместе со своей привязкой",
    node.outputs[3].links.length === 1 && left[1].i === 3, String(node.outputs[3].links.length));
  check("виджет обновлён", JSON.parse(slotWidget(node).value).length === 2);
});

await run("slots: перетаскивание строки в «Выходах» меняет номер провода", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("e1"), mkSlotEntry("e2"));
  st.bindOutSlot({ kind: "card", id: "e1", name: "Первый" });
  st.bindOutSlot({ kind: "card", id: "e2", name: "Второй" });
  check("порядок: e1→выход 2, e2→выход 3",
    st.outSlotOfEntry("e1").i === 2 && st.outSlotOfEntry("e2").i === 3);
  node.outputs[2].links = [7]; // провод висит на выходе 2
  st.reorderOutSlot(1, 0);     // тянем вторую строку наверх
  check("содержимое поехало за позицией: e2→2, e1→3",
    st.outSlotOfEntry("e2").i === 2 && st.outSlotOfEntry("e1").i === 3);
  check("сокетов столько же (перестановка, не добавление)", node.outputs.length === 4);
  check("провод остался на своём сокете (ему и адресуют)", node.outputs[2].links.length === 1);
  check("тултип выхода 2 теперь про e2 (Второй)",
    String(node.outputs[2].title).includes("Второй"), String(node.outputs[2].title));
  // Строка в дереве тоже таскается (атрибут draggable) и знает свой индекс
  const rowOuts = st.tree.children.find((r) => ftext(r).includes("🔌2") && ftext(r).includes("Второй"));
  check("строка вывода в дереве помечена draggable и показывает номер", !!rowOuts && rowOuts.draggable === true,
    rowOuts ? String(rowOuts.draggable) : "нет строки");
});

await run("slots: кнопка «🔌 Подключить выход» берёт выделение или категорию", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const toasts = [];
  st.toast = (...a) => toasts.push(a);
  st.entries.push(mkSlotEntry("e1", "Фото"));
  st.folders.push("Фото");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  const btn = st.listHead.children[0];
  check("кнопка живёт в шапке списка", !!btn && btn.textContent === "🔌 Подключить выход", btn ? btn.textContent : "нет");
  st.selFolder = "__all"; st.selWidget.value = "";
  btn.onclick();
  check("без выделения и категории — предупреждение, ничего не подключено",
    toasts.length === 1 && st.readOutSlots().length === 0, String(toasts.length));
  st.selFolder = "Фото";
  btn.onclick();
  check("текущая категория подключилась к выходу 2",
    !!st.outSlotOfFolder("Фото") && st.outSlotOfFolder("Фото").i === 2);
  st.selWidget.value = "e1";
  btn.onclick();
  check("выделенная карточка подключилась к выходу 3",
    !!st.outSlotOfEntry("e1") && st.outSlotOfEntry("e1").i === 3);
  btn.onclick();
  check("повторное подключение того же — предупреждение, без дубля",
    st.readOutSlots().length === 2 && toasts.length === 2, `slots=${st.readOutSlots().length}, toasts=${toasts.length}`);
});

await run("slots: рендер «🔌 Выходы» — карточка с превью, битая привязка, отвязка ✖", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("e1"));
  st.entries[0].has_preview = true;
  st.selFolder = "__all";
  st.bindOutSlot({ kind: "card", id: "e1", name: "e1" });
  st.bindOutSlot({ kind: "card", id: "ghost", name: "ghost" }); // записи нет в базе
  st.selFolder = "__outs";
  st.render();
  const cardE1 = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG");
  check("живая карточка вывода рисуется карточкой с превью (img), а не строкой", !!cardE1);
  check("на карточке видно НОМЕР провода (🔌2)", !!cardE1 && ftext(cardE1).includes("🔌2"), cardE1 ? ftext(cardE1) : "");
  // v1.45.1: 🔌N и метка типа (📷/🎬) — отдельные пролёты с воздухом и
  // осветляющим фильтром. Раньше это была одна склеенная тёмная строка
  // «🔌3📷», которая тонула на тёмной ноде (отчёт пользователя).
  const tSpans = (cardE1 && cardE1.children[1] && cardE1.children[1].children[0]
    && cardE1.children[1].children[0].children) || [];
  check("иконки карточки — отдельные пролёты: номер выхода, тип медиа, имя",
    tSpans.length === 3 && String(tSpans[0].textContent).startsWith("🔌2")
      && String(tSpans[1].textContent).startsWith("📷")
      && String(tSpans[2].textContent).includes("e1"),
    JSON.stringify(tSpans.map((s) => String(s.textContent))));
  check("иконки осветлены фильтром и разведены отбивкой (не слипаются)",
    tSpans.length === 3 && tSpans.slice(0, 2).every((s) => String(s.style.cssText).includes("brightness")
      && String(s.style.cssText).includes("margin-right")),
    JSON.stringify(tSpans.map((s) => String(s.style.cssText))));
  const ghost = st.list.children.find((c) => ftext(c).includes("ghost"));
  check("битая привязка показана строкой вывода", !!ghost);
  check("мета битой привязки объясняет поведение",
    ghost && ftext(ghost).includes("записи нет"), ghost ? ftext(ghost) : "");
  const delB = ghost && ghost.children[2];
  // v1.73.2: контракт кнопки сменился — раньше здесь проверялся текстовый
  // ✖/оранжевый; теперь это кнопка-кружок (стиль — в фазах v1.73.2 ниже).
  check("кнопка отвязки найдена (button)", delB && delB.tagName === "BUTTON");
  delB.onclick({ stopPropagation() {} });
  check("✖ отвязала выход", st.outSlotOfEntry("ghost") === null && st.readOutSlots().length === 1);
  check("сокет убран с ноды", node.outputs.length === 3, String(node.outputs.length));
  const stillE1 = st.list.children.find((c) => ftext(c).includes("e1"));
  check("список перерисован без снятого вывода", !!stillE1 && st.outSlotOfEntry("e1") !== null);
});

// --- v1.73.2 (§60.15-продолжение): кружок-крестик на карточках и битых ---
// строках вывода (пользователь: «крестики [оранжевые ✖ на карточках] тоже
// переделать на красный в кружке, такой же как на Выходы») + оптическая
// центровка крестика (пользователь: «крестик не отцентрован»; замер —
// tests/_probe_unlink_center.py: dy≈+0.62..+0.88px ниже центра).
await run("v1.73.2: крестик отвязки карточки вывода — тёмный кружок, не оранжевый ✖", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("e1"));
  st.entries[0].has_preview = true;
  st.selFolder = "__all";
  st.bindOutSlot({ kind: "card", id: "e1", name: "e1" });
  st.selFolder = "__outs";
  st.render();
  const card = st.list.children.find((c) => c.children[0] && c.children[0].tagName === "IMG");
  const del = card && [...(card.children || [])].find((c) => c.tagName === "BUTTON");
  const dcss = String(del && del.style ? del.style.cssText : "(нет кнопки)");
  check("v1.73.2: кнопка отвязки есть на карточке вывода", !!del, dcss.slice(0, 120));
  check("v1.73.2: карточка — круг (border-radius:50%)", dcss.includes("border-radius:50%"), dcss.slice(0, 200));
  check("v1.73.2: карточка — фон тёмный #414141", dcss.includes("background:#414141"), dcss.slice(0, 200));
  check("v1.73.2: карточка — крестик красный #e05555, оранжевого нет",
    dcss.includes("color:#e05555") && !dcss.includes("#e08a3c"), dcss.slice(0, 200));
  check("v1.73.2: карточка — глиф ✕/✖", /[✕✖]/.test(String(del ? del.textContent : "")),
    String(del ? del.textContent : ""));
  // Охранитель поведения: клик отвязывает карточку (не ломаем wiring).
  del.onclick({ stopPropagation() {} });
  check("v1.73.2: клик отвязал карточку (unbindOutSlot)",
    st.outSlotOfEntry("e1") === null && st.readOutSlots().length === 0,
    "slots=" + st.readOutSlots().length);
});

await run("v1.73.2: крестик битой строки вывода — тёмный кружок + оптическая центровка", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selFolder = "__all";
  st.bindOutSlot({ kind: "card", id: "ghost", name: "ghost" });
  st.selFolder = "__outs";
  st.render();
  const ghost = st.list.children.find((c) => ftext(c).includes("ghost"));
  const del = ghost && [...(ghost.children || [])].find((c) => c.tagName === "BUTTON");
  const dcss = String(del && del.style ? del.style.cssText : "(нет кнопки)");
  check("v1.73.2: кнопка отвязки есть на битой строке", !!del, dcss.slice(0, 120));
  check("v1.73.2: битая строка — круг (border-radius:50%)", dcss.includes("border-radius:50%"), dcss.slice(0, 200));
  check("v1.73.2: битая строка — фон тёмный #414141", dcss.includes("background:#414141"), dcss.slice(0, 200));
  check("v1.73.2: битая строка — крестик красный #e05555, оранжевого нет",
    dcss.includes("color:#e05555") && !dcss.includes("#e08a3c"), dcss.slice(0, 200));
  // Оптическая центровка: фикс. 14x14 + border-box, padding-bottom поднимает
  // глиф на ~0.5px к центру (замер прибором: dy было +0.62..+0.88).
  check("v1.73.2: box-sizing:border-box (крестик не растит кнопку)",
    dcss.includes("box-sizing:border-box"), dcss.slice(0, 200));
  check("v1.73.2: оптическая центровка — padding-bottom:1px",
    dcss.includes("padding:0 0 1px"), dcss.slice(0, 200));
});

await run("slots: 10 занято — лишняя привязка предупреждает, дубль молчит", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  let toasts = [];
  st.toast = (...a) => { toasts.push(a); };
  st.selFolder = "__all";
  for (let i = 2; i <= 11; i++) st.bindOutSlot({ kind: "card", id: `e${i}`, name: `x${i}` });
  check("заняты все 10 выходов 2..11 (сокетов стало 12)",
    st.readOutSlots().length === 10 && st.nextOutSlot() === null && node.outputs.length === 12,
    `slots=${st.readOutSlots().length}, outs=${node.outputs.length}`);
  st.bindOutSlot({ kind: "card", id: "e21", name: "e21" });
  check("11-я привязка предупреждает и не добавляется",
    toasts.length === 1 && String(toasts[0][2]).includes("Все 10") && st.readOutSlots().length === 10);
  st.bindOutSlot({ kind: "card", id: "e2", name: "x2" });
  check("дубль при полном списке молчит (проверка до занятости)", toasts.length === 1);
  st.bindOutSlot({ kind: "folder", path: "Лишняя" });
  check("папка в полный список не проходит", st.readOutSlots().length === 10 && toasts.length === 2);
});

await run("slots: onConfigure восстанавливает привязки (named и позиция)", () => {
  const sv = JSON.stringify([{ i: 2, kind: "card", id: "e1", name: "Кайзер" }]);

  const n1 = mkSlotNode();
  addSlotEnv(n1);
  proto.onConfigure.call(n1, {
    widgets_values: ["📥 Запись", "e1", "Фото", "", sv],
    widgets_values_named: { mode: "📥 Запись", selected: "e1", save_folder: "Фото", slots_out: sv },
  });
  n1._pl.applyOutSockets();
  check("named: привязка восстановлена, сокет 2 создан",
    n1._pl.readOutSlots().length === 1 && n1.outputs.length === 3 && n1.outputs[2].name === "prompt_2",
    `slots=${n1._pl.readOutSlots().length}, outs=${n1.outputs.length}`);
  check("RU-имя восстановленного сокета — «промпт 2»",
    n1.outputs[2].localized_name === "промпт 2", String(n1.outputs[2].localized_name));
  check("тултип сокета — про Кайзера", String(n1.outputs[2].title).includes("Кайзер"), String(n1.outputs[2].title));

  const n2 = mkSlotNode();
  addSlotEnv(n2);
  proto.onConfigure.call(n2, { widgets_values: ["📥 Запись", "e1", "Фото", "", sv], widgets_values_named: {} });
  n2._pl.applyOutSockets();
  check("позиционный фолбэк widgets_values[4]",
    n2._pl.slotsOut.length === 1 && n2.outputs.length === 3, String(n2.outputs.length));

  const n3 = mkSlotNode();
  addSlotEnv(n3);
  proto.onConfigure.call(n3, { widgets_values: ["📥 Запись", "", ""], widgets_values_named: {} });
  n3._pl.applyOutSockets();
  check("старый граф без slots_out: выходов только два, доп. сокетов нет",
    n3._pl.slotsOut.length === 0 && n3.outputs.length === 2, String(n3.outputs.length));

  // Главное про загрузку графа: сокеты НЕ урезаются синхронно в onNodeCreated
  // (иначе фронтенд сопоставил бы outputs графа с урезанным списком —
  // zip(this.outputs, data.outputs) — и потерял бы сокеты воркфлоу).
  const n4 = makeNode();
  proto.onNodeCreated.call(n4);
  addSlotEnv(n4);
  check("до rAF в ноде ещё все 12 выходов из def", n4.outputs.length === 12, String(n4.outputs.length));
  flushRaf("slots:after-create");
  check("после rAF — только два (привязок нет)", n4.outputs.length === 2, String(n4.outputs.length));

  // Сокет с проводом не убираем, даже если привязки в нём нет.
  const n5 = mkSlotNode();
  addSlotEnv(n5);
  n5.outputs.push({ name: "prompt_2", type: "STRING", links: [7] });
  n5._pl.applyOutSockets();
  check("сокет с проводом остался, а без провода — убран",
    n5.outputs.length === 3 && n5.outputs[2].links.length === 1, String(n5.outputs.length));
  check("про провод без привязки нода говорит вслух",
    (n5._pl.outOrphan || []).includes(2), JSON.stringify(n5._pl.outOrphan));
});

await run("категории: смена папки не снимает выбранную запись (основной промпт жив)", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.folders.push("Фото", "Видео");
  st.entries.push(mkSlotEntry("e1", "Фото"), mkSlotEntry("e2", "Видео"));
  st.selFolder = "Фото";
  st.renderTree(); st.render();
  const card = st.list.children.find((c) => ftext(c).includes("e1"));
  check("карточка папки найдена", !!card, st.list.children.map((c) => ftext(c)).join(" ; "));
  await card.onclick({});
  check("клик выбрал запись (панель промпта открыта)",
    st.selWidget.value === "e1" && st.detailId === "e1" && st.detail.style.display === "flex",
    `sel=${st.selWidget.value}, id=${st.detailId}, d=${st.detail.style.display}`);
  // Переходим в ДРУГУЮ категорию: выбранная запись — источник основного текста
  // на выходе prompt_1, поэтому просмотр другой папки не должен его гасить
  // (отчёт пользователя: «выделение снимается и промпт не выводится»).
  const otherRow = st.tree.children.find((r) => ftext(r).includes("Видео"));
  check("строка другой категории найдена", !!otherRow,
    st.tree.children.map((r) => ftext(r)).join(" ; "));
  otherRow.onclick({});
  check("папка переключилась на «Видео»", st.selFolder === "Видео", st.selFolder);
  check("выбранная запись НЕ снята", st.selWidget.value === "e1", String(st.selWidget.value));
  check("панель промпта осталась открытой",
    st.detailId === "e1" && st.detail.style.display === "flex",
    `id=${st.detailId}, d=${st.detail.style.display}`);
});

await run("кнопка «+ Категория» — жёлтая с чёрным текстом", () => {
  const node = mkSlotNode();
  const st = node._pl;
  check("кнопка доступна из состояния (как exportBtn)", !!st.newFolderBtn);
  // Заглушка стилей не разбирает cssText на свойства (как браузер), поэтому
  // проверяем саму строку: жёлтый фон + чёрный текст и НЕ прежний серый.
  const css = String(st.newFolderBtn.style.cssText);
  check("фон жёлтый, текст чёрный — читается на тёмной ноде",
    css.includes("background:#e8c33a") && css.includes("color:#111")
      && !css.includes("background:#2a2a2a"), css);
  check("подпись кнопки не изменилась", st.newFolderBtn.textContent === "+ Категория",
    String(st.newFolderBtn.textContent));
});

await run("slots: строка «🔌 Выходы» в дереве открывает режим слотов", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.folders.push("Фото");
  st.renderTree(); st.render();
  const outsRow = st.tree.children[2];
  check("третья строка дерева — категория выходов",
    !!outsRow && ftext(outsRow).includes("🔌") && ftext(outsRow).includes("Выходы"),
    outsRow ? ftext(outsRow) : "строки нет");
  // v1.55: вилка в строке «Выходы» — таким же пролётом с фильтром карточек, а не
  // тёмным текстовым узлом (отчёт пользователя: значок не был осветлён).
  const plugSpan = outsRow && (outsRow.children[0].children || [])
    .find((s) => String(s.textContent || "") === "🔌");
  check("вилка в строке «Выходы» осветлена, как на карточках (brightness 1.65)",
    !!plugSpan && String(plugSpan.style.cssText).includes("brightness(1.65)"),
    plugSpan ? String(plugSpan.style.cssText) : "пролёта с 🔌 нет — значок в текстовом узле");
  check("подпись строки не потерялась", ftext(outsRow).includes("Выходы"), ftext(outsRow));
  outsRow.onclick({});
  check("клик переключил selFolder на __outs", st.selFolder === "__outs");
  check("save_folder виджет получил __outs",
    node.widgets.find((w) => w.name === "save_folder").value === "__outs");
  st.bindOutSlot({ kind: "card", id: "zz", name: "zz" }); // записи нет в базе
  st.render();
  const rows = st.list.children.filter((c) => ftext(c).includes("zz"));
  check("вывод виден в категории выходов (битая запись)",
    rows.length === 1 && ftext(rows[0]).includes("записи нет"),
    st.list.children.map((c) => ftext(c)).join(" ; "));
  check("сокет выхода 2 после всего жив", node.outputs.length === 3 && node.outputs[2].name === "prompt_2");
});

// --- v1.54: «📄 Без категории» — служебная ветка дерева ---------------------
// Баг: строка исчезла из проводника (c2dd0bd, v1.44 — при вставке строк
// «🔌 Выходы» её appendChild удалили вместе с комментарием, а фраза
// «перед Без категории» осталась). Следствие: записи без категории (folder="")
// попадали в список ТОЛЬКО через «Всё»; отдельной ветки не было вовсе.
await run("v1.54: строка «📄 Без категории» в дереве — записи без категории", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.folders.push("Фото");
  st.entries.push(mkSlotEntry("free1", ""), mkSlotEntry("in1", "Фото"));
  st.selFolder = "__all";
  st.renderTree(); st.render();
  const labels = st.tree.children.map((r) => ftext(r));
  check("в дереве есть строка «📄 Без категории»",
    labels.some((t) => t.includes("Без категории")), labels.join(" ; "));
  const rootRow = st.tree.children.find((r) => ftext(r).includes("Без категории"));
  check("она идёт ПОСЛЕ «🔌 Выходы» (порядок: Всё / Избранное / Выходы / Без категории)",
    !!rootRow && st.tree.children.indexOf(rootRow) === 3, labels.join(" ; "));
  // Значок закреплён проверкой: 📥 занят кнопкой «📥 Импорт» в ряду действий,
  // у служебной ветки — «📄» (лист). Смена значка = осознанная правка теста.
  check("подпись строки — ровно «📄 Без категории» (не 📥 — он у кнопки «Импорт»)",
    !!rootRow && ftext(rootRow) === "📄 Без категории", rootRow ? ftext(rootRow) : "строки нет");
  await rootRow.onclick({});
  check("клик переключил selFolder на __root", st.selFolder === "__root", st.selFolder);
  check("save_folder виджет получил __root",
    node.widgets.find((w) => w.name === "save_folder").value === "__root");
  const shown = st.list.children.map((c) => ftext(c));
  check("в списке — только записи БЕЗ категории (записи из папок не мешаются)",
    shown.some((t) => t.includes("free1")) && !shown.some((t) => t.includes("in1")),
    shown.join(" ; "));
});

// --- v1.56: импорт из .md (Stage 1) ----------------------------------------
// Файлы живут у клиента → разбор делает браузер, сервер принимает готовый
// список (/prompt_library/import). Проверяем четыре вещи, которые легко
// сломать незаметно: разбор шапки экспорта, обход папки с обложками (в т.ч.
// «Третий/Третий.md» от одиночного экспорта), меню источников и целевая ветка.
const walkEls = (el, out = []) => {
  for (const c of (el.children || [])) { out.push(c); walkEls(c, out); }
  return out;
};

await run("v1.56: «📥 Импорт» — рабочая кнопка и меню источников", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const before = documentStub.body.children.length;
  st.importStart();
  check("клик открыл меню оверлеем вне ноды (раскладку не трогает)",
    documentStub.body.children.length === before + 1,
    String(documentStub.body.children.length));
  const panel = documentStub.body.children[documentStub.body.children.length - 1];
  const btns = walkEls(panel).filter((e) => typeof e.onclick === "function");
  check("в меню 4 источника + «Отмена»", btns.length === 5, String(btns.length));
  // «Отмена» тоже нажимается — считаем активные СРЕДИ источников.
  const sources = btns.filter((b) => String(b.textContent) !== "Отмена");
  check("все четыре источника активны (PNG/HTML/текст включены)",
    sources.length === 4 && sources.every((b) => !b.disabled),
    btns.map((b) => `${b.textContent}${b.disabled ? "(off)" : ""}`).join(" | "));
  check("метки источников на месте: .md, PNG, HTML, текстовый файл",
    sources.some((b) => b.textContent.includes("Папка с .md"))
      && sources.some((b) => b.textContent.includes("PNG"))
      && sources.some((b) => b.textContent.includes("HTML"))
      && sources.some((b) => b.textContent.includes("Текстовый файл")),
    sources.map((b) => String(b.textContent)).join(" | "));
  const cancel = btns[btns.length - 1];
  cancel.onclick();
  check("«Отмена» снимает оверлей", documentStub.body.children.length === before,
    String(documentStub.body.children.length));
});

await run("v1.56: разбор .md — свой формат, чужой файл, CRLF", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const own = ["# Закат над морем", "", "- №: a1b2c3", "- Категория: Фото/Пейзажи",
    "- Создана: 2021-05-06T07:08:09", "- Тип: 📷 фото", "- В избранном: да", "",
    "## Промпт", "", "тёплый свет, длинная выдержка", ""].join("\r\n");
  const p = st.parseImportMd(own, "из-имени");
  check("свой файл опознан по шапке экспорта", p.own === true && p.title === "Закат над морем",
    JSON.stringify(p));
  check("категория, дата, тип и ★ перенесены",
    p.folder === "Фото/Пейзажи" && p.created_at === "2021-05-06T07:08:09"
      && p.media === "image" && p.favorite === true, JSON.stringify(p));
  check("текст — без заголовка и без хвостовых пустых строк (CRLF не мешает)",
    p.prompt === "тёплый свет, длинная выдержка", JSON.stringify(p.prompt));
  const nocat = st.parseImportMd("# X\n\n- №: z\n- Категория: Без категории\n\n## Промпт\n\nтекст", "f");
  check("«Без категории» из шапки — это корень, а не папка с таким именем",
    nocat.folder === "", JSON.stringify(nocat.folder));
  const vid = st.parseImportMd("- №: v\n- Категория: Видео\n- Тип: 🎬 видео\n- В избранном: нет\n\n## Промпт\n\nкадры", "f");
  check("видео и «нет» в избранном читаются", vid.media === "video" && vid.favorite === false,
    JSON.stringify(vid));
  const foreign = st.parseImportMd("# Мой промпт\n\nстрока один\nстрока два\n", "из-имени");
  check("чужой md: название из «# …», промпт — всё тело (own=false)",
    foreign.own === false && foreign.title === "Мой промпт"
      && foreign.prompt === "строка один\nстрока два", JSON.stringify(foreign));
  const plain = st.parseImportMd("просто текст без заголовка", "Имя файла.txt");
  check("текст без заголовка: название — из имени файла",
    plain.title === "Имя файла.txt" && plain.prompt === "просто текст без заголовка",
    JSON.stringify(plain));
  check("пустой файл даёт пустой промпт (в импорт такой не пойдёт)",
    st.parseImportMd("   \n\n  ", "f").prompt === "");
  // Заголовок «## Промпт» без нашей шапки — ещё не признак своего файла:
  // иначе чужой md терял бы текст и получал пустую категорию молча.
  check("«## Промпт» без шапки — всё ещё чужой файл (own=false)",
    st.parseImportMd("# Чужой\n\n## Промпт\n\nтело", "f").own === false);
});

await run("v1.56: обход папки — .md + обложки рядом и в одноимённой подпапке", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const fileEntry = (name) => ({ kind: "file", name });
  const dirEntry = (name, entries) => ({
    kind: "directory", name,
    values: async function* () { for (const e of entries) yield e; },
  });
  const root = dirEntry("root", [
    fileEntry("Первый.md"), fileEntry("первый.PNG"),
    fileEntry("Второй.md"),
    dirEntry("Третий", [fileEntry("Третий.md"), fileEntry("Третий.png")]),
    dirEntry("Пусто", []),
  ]);
  const found = await st.collectImportDir(root);
  check("найдены все .md, включая вложенную папку", found.length === 3,
    found.map((f) => f.rel).join(" | "));
  const first = found.find((f) => f.base === "Первый");
  check("обложка ищется без учёта регистра расширения",
    !!first.cover && first.cover.name === "первый.PNG", JSON.stringify(first && first.cover));
  const third = found.find((f) => f.base === "Третий");
  check("обложка внутри одноимённой папки тоже находится (одиночный экспорт v1.33)",
    !!third.cover && third.cover.name === "Третий.png" && third.rel === "Третий/Третий.md",
    JSON.stringify(third));
  check("у файла без обложки cover пуст (импорт без превью — не ошибка)",
    found.find((f) => f.base === "Второй").cover === null);
  check("план обложек: небольшой PNG — как есть (в нём чанк workflow)",
    st.coverPlan("x.png", 1000) === "raw" && st.coverPlan("x.PNG", 500000) === "raw");
  check("план обложек: тяжёлый PNG и любой jpg — ужимать в браузере",
    st.coverPlan("x.png", 9000000) === "shrink" && st.coverPlan("x.jpg", 10) === "shrink");
});

await run("v1.56: цель импорта и отказ в служебных ветках", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const started = [];
  const orig = st.importMdFromFolder;
  st.importMdFromFolder = async (tree) => { started.push(tree); };
  const origToast = st.toast;
  const toasts = [];
  st.toast = (sev, sum, det) => { toasts.push(`${sev}:${sum}:${det}`); };
  try {
    check("умолчание структуры: «Без категории» — плоско, остальные — со структурой",
      st.importTreeDefault("__root") === false && st.importTreeDefault("Фото") === true
        && st.importTreeDefault("__all") === true,
      st.importTreeDefault("__root") + "/" + st.importTreeDefault("Фото"));
    st.selFolder = "Коллекция";
    st.importPickTree("Коллекция");
    check("реальная папка: импорт начинается сразу, структура сохраняется",
      started.length === 1 && started[0] === true, JSON.stringify(started));
    st.selFolder = "__fav";
    st.importPickTree("__fav");
    check("«Избранное» — не место хранения: предупреждение без импорта",
      started.length === 1 && toasts.length === 1 && String(toasts[0]).includes("Избранное"),
      JSON.stringify(toasts));
    st.importPickTree("__outs");
    check("«🔌 Выходы» тоже отклонены (только привязки)",
      started.length === 1 && String(toasts[1]).includes("Выходы"), JSON.stringify(toasts));
    // «Без категории»: спрашиваем о структуре только тут, где выбор реально есть
    const before = documentStub.body.children.length;
    st.importPickTree("__root");
    check("«Без категории» открывает выбор «плоско / со структурой»",
      documentStub.body.children.length === before + 1 && started.length === 1,
      String(documentStub.body.children.length));
    const panel = documentStub.body.children[documentStub.body.children.length - 1];
    const btns = walkEls(panel).filter((e) => typeof e.onclick === "function");
    check("в диалоге два варианта + «Отмена»", btns.length === 3, String(btns.length));
    btns[1].onclick();
    check("выбор «сохранить структуру» уходит в импорт с tree=true",
      started.length === 2 && started[1] === true, JSON.stringify(started));
  } finally {
    st.importMdFromFolder = orig;
    st.toast = origToast;
  }
});

await run("v1.56: полный проход импорта — payload, дубликаты, обложки, отчёт", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.fileToDataUrl = async () => "data:image/png;base64,QUJD";
  const origFetch = sandbox.fetch;
  const origPicker = windowStub.showDirectoryPicker;
  const posts = [];
  const toasts = [];
  const origToast = st.toast;
  st.toast = (sev, sum, det) => { toasts.push(`${sev}|${det}`); };
  const md = (t, cat) => `# ${t}\n\n- №: x\n- Категория: ${cat}\n- Создана: 2020-02-02T02:02:02\n- Тип: 📷 фото\n- В избранном: нет\n\n## Промпт\n\nтекст ${t}\n`;
  const fh = (name, text) => ({
    kind: "file", name,
    getFile: async () => ({ name, size: 1000, text: async () => text }),
  });
  const dir = {
    kind: "directory", name: "root",
    values: async function* () {
      yield fh("Один.md", md("Один", "Фото"));
      yield fh("Один.png", "");
      yield fh("Два.md", md("Два", "Фото/Зима"));
    },
  };
  windowStub.showDirectoryPicker = async () => dir;
  sandbox.fetch = async (u, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(u), body });
    if (String(u).includes("/prompt_library/import")) {
      return jsonResponse({ ok: true, created: [
        { id: "imp1", title: "Один", folder: "Коллекция/Фото", src: "Один.md" },
        { id: "imp2", title: "Два", folder: "Коллекция/Фото/Зима", src: "Два.md" },
      ], skipped: [{ title: "Старый", exists_folder: "Фото", reason: "db" }],
        failed: [], free: 100, total: 3 });
    }
    if (String(u).includes("/prompt_library/list")) return jsonResponse(listResponse);
    return jsonResponse({});
  };
  try {
    st.selFolder = "Коллекция";
    await st.importMdFromFolder(true);
    const imp = posts.find((p) => p.url.includes("/prompt_library/import"));
    check("в /import ушла цель и структура из проводника",
      imp && imp.body.target === "Коллекция" && imp.body.tree === true,
      JSON.stringify(imp && imp.body && { t: imp.body.target, tree: imp.body.tree }));
    check("каждый файл ушёл записью с категорией, датой и src",
      imp && imp.body.items.length === 2
        && imp.body.items[0].src === "Один.md" && imp.body.items[0].folder === "Фото"
        && imp.body.items[0].created_at === "2020-02-02T02:02:02",
      JSON.stringify(imp && imp.body.items));
    const covers = posts.filter((p) => p.url.includes("attach_preview"));
    check("обложка привязана ТОЛЬКО к своей записи (id по src, force=true)",
      covers.length === 1 && covers[0].body.id === "imp1" && covers[0].body.force === true
        && String(covers[0].body.preview_data).startsWith("data:image/png"),
      JSON.stringify(covers.map((c) => c.body.id)));
    check("отчёт в нижней строке: создано/дубликаты/без обложки",
      /создано 2/.test(String(st.hintSticky)) && /дубликатов 1/.test(String(st.hintSticky)),
      String(st.hintSticky));
    check("тост предупреждает о дубликате и говорит, где он лежит",
      toasts.length === 1 && toasts[0].startsWith("warn")
        && String(toasts[0]).includes("уже в «Фото»"), JSON.stringify(toasts));
  } finally {
    sandbox.fetch = origFetch;
    windowStub.showDirectoryPicker = origPicker;
    st.toast = origToast;
  }
});

await run("v1.56: отказ сервера (лимит базы) говорится словами, обложек нет", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const origFetch = sandbox.fetch;
  const origPicker = windowStub.showDirectoryPicker;
  const posts = [];
  const toasts = [];
  const origToast = st.toast;
  st.toast = (sev, sum, det) => { toasts.push(String(det)); };
  windowStub.showDirectoryPicker = async () => ({
    kind: "directory", name: "root",
    values: async function* () {
      yield { kind: "file", name: "A.md",
        getFile: async () => ({ name: "A.md", size: 10, text: async () => "# A\n\n- №: 1\n- Категория: X\n\n## Промпт\n\nтекст" }) };
    },
  });
  sandbox.fetch = async (u, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(u), body });
    if (String(u).includes("/prompt_library/import")) {
      return { ok: false, status: 400, json: async () => ({ error: "limit", free: 3, want: 9, max: 500 }) };
    }
    if (String(u).includes("/prompt_library/list")) return jsonResponse(listResponse);
    return jsonResponse({});
  };
  try {
    await st.importMdFromFolder(true);
    check("отказ объяснён числами (свободно/нужно/лимит), а не «ошибка»",
      toasts.length === 1 && /свободно 3 из 500/.test(toasts[0]) && /записей 9/.test(toasts[0]),
      JSON.stringify(toasts));
    check("после отказа обложки не заливаются",
      !posts.some((p) => p.url.includes("attach_preview")),
      JSON.stringify(posts.map((p) => p.url)));
    check("в подсказке сказано, что импорт отменён", /Импорт отменён/.test(String(st.hintSticky)),
      String(st.hintSticky));
  } finally {
    sandbox.fetch = origFetch;
    windowStub.showDirectoryPicker = origPicker;
    st.toast = origToast;
  }
});

await run("v1.46: галерея — кнопки «🌐 Экспорт в HTML» (ряд) и «🌐 В HTML» (панель карточки)", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  check("«🌐 Экспорт в HTML» доступна из состояния (как exportBtn)", !!st.galleryBtn);
  check("подпись и значок — как у карточки (v1.48)",
    st.galleryBtn && st.galleryBtn.textContent === "🌐 Экспорт в HTML", String(st.galleryBtn && st.galleryBtn.textContent));
  const cssG = String(st.galleryBtn && st.galleryBtn.style.cssText);
  check("галерея стилем отличается от Экспорт (фиолетовая, не синяя)",
    cssG.includes("background:#3a2c6a") && !cssG.includes("background:#2c4a73"), cssG);
  check("«🌐 В HTML» в панели карточки", !!st.bGallery && st.bGallery.textContent === "🌐 В HTML",
    String(st.bGallery && st.bGallery.textContent));
  // Фиолетовый цвет кнопки светится на фоне ноды — галерея не путается с Экспорт.
});

await run("v1.48: ряд экспорта/импорта — в шапке проводника только «+ Категория»", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  check("ряд экспорта есть в состоянии (exportRow)", !!st.exportRow);
  // 6 = подпись «Библиотека:» + три кнопки + «🗑 Удалить» + «✖» (v1.53)
  check("в ряду лежат «📤 Экспорт», «🌐 Экспорт в HTML», «📥 Импорт» и пара массовых действий",
    st.exportRow.children.length === 6
      && st.exportRow.children.includes(st.exportBtn)
      && st.exportRow.children.includes(st.galleryBtn)
      && st.exportRow.children.includes(st.importBtn)
      && st.exportRow.children.includes(st.bulkDel)
      && st.exportRow.children.includes(st.bulkClear),
    String(st.exportRow.children.length));
  check("ряд — отдельная строка под «➕ Добавить промпт» и над тулбаром",
    st.root.children.indexOf(st.exportRow) > st.root.children.indexOf(st.inputTitle.parentNode)
      && st.root.children.indexOf(st.exportRow)
        < st.root.children.indexOf(st.root.children.find((c) => c.children.includes(st.search))),
    String(st.root.children.indexOf(st.exportRow)));
  check("ряд фиксированной высоты 22px (высота ноды считается константами)",
    String(st.exportRow.style.cssText).includes("height:22px"), String(st.exportRow.style.cssText));
  check("«📥 Импорт» в ряду и подпись на месте",
    st.importBtn.textContent === "📥 Импорт", String(st.importBtn.textContent));
  check("v1.56: кнопка импорта БОЛЬШЕ не выключена (первый источник работает)",
    st.importBtn.disabled !== true
      && String(st.importBtn.style.cssText).includes("cursor:pointer"),
    String(st.importBtn.style.cssText));
  // Дерево больше не несёт кнопок экспорта: только «+ Категория»
  const treeHead = st.tree.parentNode.children[0];
  const headTexts = treeHead.children[1].children.map((b) => b.textContent);
  check("в шапке проводника осталась только «+ Категория»",
    headTexts.length === 1 && headTexts[0] === "+ Категория", headTexts.join(","));
});

await run("v1.46: галерея категории — зеркало обложек + prompt_library.html в корне", async () => {
  const raw = [
    { id: "G1", title: "Фото с моря", folder: "Фото", preview: "p/G1.png", prompt: "полный текст фото с моря" },
    { id: "G2", title: "Портрет", folder: "Фото/Портреты", preview: "", prompt: "полный текст портрета" },
    { id: "G4", title: "Альбом выпуска", folder: "Фото/Портреты/Альбом", preview: "p/G4.png", prompt: "полный текст альбома" },
    { id: "G9", title: "Без папки", folder: "", preview: "", prompt: "полный текст без папки" },
  ];
  const metas = new Map([
    ["G1", { model: "flux1-dev", vae: "ae.safetensors", loras: [{ name: "detail", strength: 0.7 }],
      sampler: "euler", scheduler: "normal", steps: 20, cfg: 1.0, denoise: 1, seed: 12345, width: 768, height: 512 }],
    ["G2", { sampler: "dpmpp_2m", scheduler: "karras", steps: 28, cfg: 7, seed: 99 }],
  ]);
  installFetchStub(raw.map(({ id, title, folder }) => ({ id, title, folder, head: "", favorite: false, pinned: false, has_preview: true, media: null })),
    new Map(raw.map((e) => [e.id, e])), metas);

  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  await st.reload();

  const files = [];
  const fakeDirHandle = makeDirHandle(files);
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => fakeDirHandle;
  try {
    await st.exportFolderHtml("Фото");
    // Зеркало: html-файл — в папке категории, обложки — рядом и в подпапках.
    const html = files.find((f) => f.name === "Фото/prompt_library.html");
    check("v1.46: prompt_library.html лежит в зеркале категории (Фото/)",
      !!html, files.map((f) => f.name).join(","));
    check("v1.46: обложки в зеркале: рядом и по подпапкам",
      files.some((f) => f.name === "Фото/Фото с моря.png")
        && files.some((f) => f.name === "Фото/Портреты/Альбом/Альбом выпуска.png"),
      files.map((f) => f.name).join(","));
    check("v1.46: галерея НЕ пишет .md (html — поверх, не заменяя)",
      !files.some((f) => f.name.endsWith(".md")), files.map((f) => f.name).join(","));
    const content = String(html && html.content);
    // Карточка G1: превью-ссылка относительная (не base64), промпт в data-атрибуте,
    // метаданные генерации таблицей.
    check("v1.46: обложка в html — относительная ссылка на png",
      content.includes("src=\"%D0%A4%D0%BE%D1%82%D0%BE%20%D1%81%20%D0%BC%D0%BE%D1%80%D1%8F.png\""),
      content.slice(0, 600));
    check("v1.46: в html есть карточка G2 без обложки (заглушка «без обложки»)",
      content.includes("без обложки"));
    check("v1.46: промпт в data-prompt (encodeURIComponent, не сырой)",
      content.includes('data-prompt="%D0%BF%D0%BE%D0%BB%D0%BD%D1%8B%D0%B9%20%D1%82%D0%B5%D0%BA%D1%81%D1%82%20%D1%84%D0%BE%D1%82%D0%BE%20%D1%81%20%D0%BC%D0%BE%D1%80%D1%8F"')
        && content.includes("data-prompt="), "data-prompt присутствует");
    check("v1.46: метаданные генерации таблицей (Модель/LoRA/Семплер/Разрешение)",
      content.includes("Модель") && content.includes("LoRA")
        && content.includes("Семплер") && content.includes("Разрешение"),
      "таблица параметров есть");
    check("v1.46: в шапке html счёт и название категории",
      content.includes("Фото · 3 записей") || content.includes("Вся библиотека"), "шапка галереи");
  } finally {
    windowStub.showDirectoryPicker = origPicker;
  }
});

await run("v1.46: галерея отмеченного — те же карточки через exportMarkedHtml", async () => {
  const raw = [
    { id: "M1", title: "Отмеченная", folder: "Фото", preview: "p/M1.png", prompt: "текстM1" },
    { id: "M2", title: "Вторая", folder: "Видео", preview: "", prompt: "текстM2" },
    { id: "M3", title: "Мимо", folder: "Архив", preview: "", prompt: "текстM3" },
  ];
  installFetchStub(raw.map((e) => ({ id: e.id, title: e.title, folder: e.folder, head: "", favorite: false, pinned: false, has_preview: !!1, media: null })),
    new Map(raw.map((e) => [e.id, e])), null);

  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  await st.reload();
  st.markEntries.add("M1"); st.markEntries.add("M2");

  const files = [];
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => makeDirHandle(files);
  try {
    await st.exportMarkedHtml();
    const html = files.find((f) => f.name === "prompt_library.html");
    check("v1.46: html отмеченного пишется в выбранную папку", !!html,
      files.map((f) => f.name).join(","));
    const content = String(html && html.content);
    check("v1.46: в отмеченной галерее обе метки, «Мимо» — нет",
      content.includes("Отмеченная") && content.includes("Вторая")
        && !content.includes("Мимо"), content.slice(0, 400));
    check("v1.46: шапка отмеченного — «Отмеченное · 2 записей»",
      content.includes("Отмеченное · 2 записей"), "шапка");
    // Отмеченные пишут обложку в зеркало с корня, не в подпапку категории
    check("v1.46: обложка отмеченной в зеркале от корня",
      files.some((f) => f.name === "Фото/Отмеченная.png"), files.map((f) => f.name).join(","));
  } finally {
    windowStub.showDirectoryPicker = origPicker;
  }
});

await run("v1.46: галерея одной записи — html + обложка рядом, без зеркала", async () => {
  const full = { id: "S1", title: "Соло", folder: "Фото", preview: "p/S1.png", prompt: "сольный промпт" };
  installFetchStub([{ id: "S1", title: "Соло", folder: "Фото", head: "", favorite: false, pinned: false, has_preview: true, media: null }],
    new Map([["S1", full]]),
    new Map([["S1", { sampler: "euler", steps: 15, cfg: 1.5, seed: 7 }]]));

  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  st.detailId = "S1";
  st.full.set("S1", full);

  const files = [];
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => makeDirHandle(files);
  try {
    await st.exportEntryHtml();
    const html = files.find((f) => f.name === "prompt_library.html");
    check("v1.46: карточка пишет prompt_library.html", !!html,
      files.map((f) => f.name).join(","));
    check("v1.46: обложка рядом (не в подпапку)", 
      files.some((f) => f.name === "Соло.png"), files.map((f) => f.name).join(","));
    const content = String(html && html.content);
    check("v1.46: в html — карточка сольной записи и её промпт",
      content.includes("Соло") && content.includes('data-prompt="%D1%81%D0%BE%D0%BB%D1%8C%D0%BD%D1%8B%D0%B9%20%D0%BF%D1%80%D0%BE%D0%BC%D0%BF%D1%82"'),
      content.slice(0, 400));
  } finally {
    windowStub.showDirectoryPicker = origPicker;
  }
});

await run("v1.47: галерея «Все» — разделы по категориям (и без них, если категория одна)", async () => {
  const raw = [
    { id: "C1", title: "Корневая", folder: "", preview: "", prompt: "текстC1" },
    { id: "C2", title: "Фотокарточка", folder: "Фото", preview: "", prompt: "текстC2" },
    { id: "C3", title: "Портрет", folder: "Фото/Портреты", preview: "", prompt: "текстC3" },
    { id: "C4", title: "Видеофайл", folder: "Видео", preview: "", prompt: "текстC4" },
  ];
  installFetchStub(raw.map((e) => ({ id: e.id, title: e.title, folder: e.folder, head: "", favorite: false, pinned: false, has_preview: false, media: null })),
    new Map(raw.map((e) => [e.id, e])), null);

  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  await st.reload();

  const files = [];
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => makeDirHandle(files);
  try {
    await st.exportFolderHtml("__all");
    const html = files.find((f) => f.name === "prompt_library.html");
    const content = String(html && html.content);
    check("v1.47: в галерее есть разделы (pl-sec) по категориям",
      (content.match(/class="pl-sec"/g) || []).length === 4, String((content.match(/pl-sec/g) || []).length));
    check("v1.47: раздел каждой категории назван своим путём",
      content.includes("📁 Фото") && content.includes("📁 Фото/Портреты")
        && content.includes("📁 Видео") && content.includes("📁 Без категории"), content.slice(0, 500));
    check("v1.47: вложенная категория с отступом, корневая — без",
      content.includes('class="pl-sec" style="margin-left:0px">📁 Без категории')
        && content.includes('class="pl-sec" style="margin-left:14px">📁 Фото/Портреты'),
      content.slice(0, 500));
    check("v1.47: у раздела — счётчик записей",
      content.includes('<span class="pl-count">1</span>'), content.slice(0, 500));
    // Карточки на месте внутри разделов (счёт 4 записи в шапке)
    check("v1.47: все четыре карточки в галерее",
      ["Корневая", "Фотокарточка", "Портрет", "Видеофайл"].every((t) => content.includes(t)), content.slice(0, 300));

    // Одна категория в выборке — без заголовков разделов
    const files2 = [];
    windowStub.showDirectoryPicker = async () => makeDirHandle(files2);
    await st.exportFolderHtml("Видео");
    const html2 = files2.find((f) => f.name === "Видео/prompt_library.html");
    check("v1.47: одна категория в выборке — без разделов",
      !!html2 && !String(html2.content).includes('class="pl-sec"'),
      files2.map((f) => f.name).join(","));
  } finally {
    windowStub.showDirectoryPicker = origPicker;
  }
});

await run("v1.49: неразрешённый переключатель — честная пометка в параметрах", async () => {
  const full = { id: "A1", title: "Свитч", folder: "Фото", preview: "", prompt: "текст A1" };
  installFetchStub([{ id: "A1", title: "Свитч", folder: "Фото", head: "", favorite: false, pinned: false, has_preview: false, media: null }],
    new Map([["A1", full]]),
    new Map([["A1", { model: "a.safetensors, b.safetensors", ambiguous: true, steps: 8 }]]));

  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  // Строки таблицы: первая — предупреждение о переключателе
  const rows = st.metaRows({ model: "a.safetensors, b.safetensors", ambiguous: true, steps: 8 });
  check("v1.49: при неразрешённом свитче первая строка — предупреждение",
    rows.length && rows[0][0] === "Переключатель" && /все ветки/.test(rows[0][1]),
    JSON.stringify(rows));
  check("v1.49: без пометки предупреждения нет",
    !st.metaRows({ model: "a.safetensors" }).some((r) => r[0] === "Переключатель"));

  // Та же пометка должна доехать до html-галереи
  const files = [];
  const origPicker = windowStub.showDirectoryPicker;
  windowStub.showDirectoryPicker = async () => makeDirHandle(files);
  try {
    await st.reload();
    await st.exportFolderHtml("Фото");
    const html = files.find((f) => f.name === "Фото/prompt_library.html");
    check("v1.49: в галерее видно, что ветка переключателя не определена",
      !!html && String(html.content).includes("показаны все ветки"),
      files.map((f) => f.name).join(","));
  } finally {
    windowStub.showDirectoryPicker = origPicker;
  }
});

// --- v1.57: импорт PNG из ComfyUI, HTML-галереи и текстового файла (Stage 2–3)
// Источники стали активными: PNG разбираем в браузере (чанки tEXt/iTXt → граф →
// положительный промпт), галерея — обратный ход экспорта html (карточка → запись,
// обложка рядом), текст — разбиение на записи. Сервер не менялся (/import один).
const crcDummy = () => Buffer.alloc(4);
const rawPngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, crcDummy()]);
};
const pngTexT = (kw, value) => rawPngChunk("tEXt", Buffer.concat([
  Buffer.from(kw, "utf8"), Buffer.from([0]), Buffer.from(value, "utf8")]));
const pngITxt = (kw, value) => rawPngChunk("iTXt", Buffer.concat([
  Buffer.from(kw, "utf8"), Buffer.from([0]),
  Buffer.from([0, 0]), Buffer.from("en", "latin1"), Buffer.from([0]), Buffer.from([0]),
  Buffer.from(value, "utf8")]));
const makePng = (chunks) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  ...chunks,
]);

await run("v1.57: PNG — разбор чанков и положительный промпт из графа", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "детали", clip: ["1", 1] } },
    "5": { class_type: "KSampler", inputs: {
      seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1,
      model: ["1", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["9", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "красивая девушка", clip: ["1", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "плохое качество", clip: ["1", 1] } },
  };
  const ui = { nodes: [
    { id: 5, type: "KSampler", inputs: [{ name: "positive", link: 10 }], widgets: [] },
    { id: 6, type: "CLIPTextEncode", inputs: [{ name: "clip", link: 2 }], widgets: ["красивая девушка", ""] },
  ], links: [[10, 6, 0, 5, "CONDITIONING"]] };
  const gs = JSON.stringify(graph);
  const us = JSON.stringify(ui);
  const chunks = st.pngChunks(new Uint8Array(makePng([pngTexT("prompt", gs), pngITxt("workflow", us)])));
  check("v1.57: tEXt/iTXt прочитаны по ключевому слову (prompt/workflow)", !!chunks.prompt && !!chunks.workflow,
    JSON.stringify(Object.keys(chunks)));
  check("v1.57: положительный промпт из графа — positive → CLIPTextEncode",
    st.promptFromGraph(JSON.parse(chunks.prompt)) === "красивая девушка", JSON.stringify(chunks.prompt));
  check("v1.57: из UI-графа — тот же текст через widgets CLIPTextEncode",
    st.promptFromWorkflow(JSON.parse(chunks.workflow)) === "красивая девушка", JSON.stringify(chunks.workflow));
  const g2 = {
    "5": { class_type: "KSampler", inputs: { positive: ["6", 0], negative: ["7", 0] } },
    "6": { class_type: "TextConcat", inputs: { text: ["8", 0] } },
    "8": { class_type: "CLIPTextEncode", inputs: { text: "итоговый текст" } },
  };
  check("v1.57: промпт нашёлся даже через цепочку ссылок (следования до depth)",
    st.promptFromGraph(g2) === "итоговый текст", String(st.promptFromGraph(g2)));
  const g3 = { "2": { class_type: "CLIPTextEncode", inputs: { text: "один-единственный" } } };
  check("v1.57: без сэмплера фолбэк — единственный CLIPTextEncode",
    st.promptFromGraph(g3) === "один-единственный", String(st.promptFromGraph(g3)));
  const g4 = { "5": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
    "6": { class_type: "CustomNode", inputs: { foo: "bar" } } };
  check("v1.57: без текста в графе — пустой ответ (не выдуманный)",
    st.promptFromGraph(g4) === "" && st.promptFromGraph({}) === "", String(st.promptFromGraph(g4)));
  const g5 = {
    "1": { class_type: "SamplerCustomAdvanced", inputs: { samples: ["5", 0] } },
    "5": { class_type: "KSampler", inputs: { positive: ["6", 0], negative: ["7", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "нашёл второй сэмплер" } },
  };
  check("v1.57: первый сэмплер без positive не блокирует — ищем дальше",
    st.promptFromGraph(g5) === "нашёл второй сэмплер", String(st.promptFromGraph(g5)));
});

// v1.63: реальная причина «импортируется имя файла, а не промпт» (2026-10-04,
// отчёт пользователя на Krea2_Raw_00001_.png). Python-json (json.dumps) пишет
// в поле is_changed токен NaN БЕЗ кавычек — такой чанк prompt невалиден по
// RFC 8259, и строгий JSON.parse на нём падает. Разбор в pngItemFromBuf был
// обёрнут в try/catch, который молча оставлял prompt пустым, а серверный
// фолбэк подставлял имя файла. Проверка ДО фикса: при bare-NaN в чанке
// импорт отдаёт пустой промпт.
await run("v1.63: чанк prompt с bare NaN (is_changed) — промпт не теряется", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const graph = {
    "5": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "охота в лесу, 17 век" } },
    // Ровно то, что кладёт в PNG Python-json: [NaN] без кавычек
    "2004": { class_type: "PromptLibrary", inputs: {}, is_changed: [0] },
  };
  const raw = JSON.stringify(graph).replace('"is_changed":[0]', '"is_changed":[NaN]');
  let strictOk = true;
  try { JSON.parse(raw); } catch (e) { strictOk = false; }
  check("v1.63: прибор верен — чанк с bare NaN действительно невалиден",
    !strictOk, "JSON.parse не упал, тест не воспроизводит причину");

  const parsed = st.pngItemFromBuf(new Uint8Array(makePng([pngTexT("prompt", raw)])));
  check("v1.63: промпт извлечён несмотря на bare NaN (обход графа не молчит)",
    parsed.prompt === "охота в лесу, 17 век", JSON.stringify(parsed.prompt));
  check("v1.63: граф записи тоже пришёл (is_changed: [NaN] -> null)",
    parsed.workflow && parsed.workflow["2004"]
      && parsed.workflow["2004"].is_changed
      && parsed.workflow["2004"].is_changed[0] === null,
    JSON.stringify(parsed.workflow && parsed.workflow["2004"]));
});

// Токен NaN внутри ТЕКСТА промпта — законная часть строки, её нельзя вырезать:
// санитайзер обязан пропускать содержимое строковых литералов.
await run("v1.63: слово NaN внутри текста промпта не вырезается санитайзером", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const graph = {
    "5": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "небо NaN и Infinity, стена NaN" } },
    "2004": { class_type: "PromptLibrary", inputs: {}, is_changed: [0] },
  };
  const raw = JSON.stringify(graph).replace('"is_changed":[0]', '"is_changed":[NaN]');
  const parsed = st.pngItemFromBuf(new Uint8Array(makePng([pngTexT("prompt", raw)])));
  check("v1.63: NaN/Infinity внутри строки остались в промпте",
    parsed.prompt === "небо NaN и Infinity, стена NaN", JSON.stringify(parsed.prompt));
});

// v1.64: воркфлоу при импорте НЕ переносился (отчёт пользователя: перетаскивание
// картинки из библиотеки в ComfyUI не открывает воркфлоу).
// Повреждён контракт поля `workflow`: в запись клали API-граф (чанк `prompt`),
// тогда как её ждут ВСЕ потребители UI-граф:
//   • чанк "workflow" в превью библиотеки читает ComfyUI при drag&drop;
//   • _gen_meta («Параметры генерации») читает nodes/widgets_values;
//   • _workflow_chunk_from_bytes достаёт именно UI-граф.
// Замер на реальном файле: в чанке оказывались ключи 1522/1523/1524 (id узлов),
// nodes/links отсутствовали, _gen_meta возвращала {}.
await run("v1.64: в запись уходит UI-граф, промпт берётся из API-графа", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const api = {
    "5": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "промпт для карточки" } },
  };
  const ui = {
    nodes: [
      { id: 5, type: "KSampler", inputs: [{ name: "positive", link: 10 }], widgets: [] },
      { id: 6, type: "CLIPTextEncode", inputs: [{ name: "text", link: 11 }], widgets: ["промпт для карточки", ""] },
    ],
    links: [[10, 6, 0, 5, "CONDITIONING"], [11, 6, 0, 6, "STRING"]],
  };
  const png = makePng([pngTexT("prompt", JSON.stringify(api)), pngITxt("workflow", JSON.stringify(ui))]);
  const parsed = st.pngItemFromBuf(new Uint8Array(png));
  check("v1.64: промпт взят из API-графа (positive-цепочка сэмплера)",
    parsed.prompt === "промпт для карточки", JSON.stringify(parsed.prompt));
  check("v1.64: в запись ушёл UI-граф — drag&drop откроет воркфлоу",
    !!(parsed.workflow && Array.isArray(parsed.workflow.nodes) && parsed.workflow.nodes.length === 2),
    "workflow=" + JSON.stringify(parsed.workflow).slice(0, 120));
  check("v1.64: UI-граф приоритетнее API-графа, даже когда оба чанка в PNG",
    parsed.workflow && Array.isArray(parsed.workflow.links) && !parsed.workflow["1524"],
    "workflow=" + JSON.stringify(parsed.workflow).slice(0, 120));
});

await run("v1.57: импорт PNG — запись с промптом, сам PNG обложкой (raw)", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const origFetch = sandbox.fetch;
  const origPicker = windowStub.showDirectoryPicker;
  const posts = [];
  const origToast = st.toast;
  st.toast = () => {};
  st.fileToDataUrl = async () => "data:image/png;base64,U0hPVA";
  const graph = { "5": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "кадр на рассвете" } } };
  const png = makePng([pngTexT("prompt", JSON.stringify(graph))]);
  const fileEntry = {
    kind: "file", name: "Shot 001.png",
    getFile: async () => ({ name: "Shot 001.png", size: png.length,
      arrayBuffer: async () => new Uint8Array(png) }),
  };
  const dir = { kind: "directory", name: "root", values: async function* () { yield fileEntry; } };
  windowStub.showDirectoryPicker = async () => dir;
  sandbox.fetch = async (u, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(u), body });
    if (String(u).includes("/prompt_library/import")) {
      return jsonResponse({ ok: true, created: [
        { id: "png1", title: "Shot 001", folder: "", src: "Shot 001.png" }],
        skipped: [], failed: [], free: 100, total: 1 });
    }
    if (String(u).includes("/prompt_library/list")) return jsonResponse(listResponse);
    return jsonResponse({});
  };
  try {
    st.selFolder = "Коллекция";
    await st.importPngFromFolder();
    const imp = posts.find((p) => p.url.includes("/prompt_library/import"));
    check("v1.57: PNG ушёл записью с промптом из чанка, категория пуста",
      imp && imp.body.items.length === 1
        && imp.body.items[0].prompt === "кадр на рассвете"
        && imp.body.items[0].title === "Shot 001"
        && imp.body.items[0].folder === ""
        && imp.body.items[0].src === "Shot 001.png",
      JSON.stringify(imp && imp.body.items));
    check("v1.57: медиа — image (PNG сам становится обложкой)",
      imp && imp.body.items[0].media === "image", JSON.stringify(imp && imp.body.items));
    check("v1.57: граф уходит в записи (items.workflow) — параметры не зависят от обложки",
      imp && imp.body.items[0].workflow && imp.body.items[0].workflow["6"]
        && imp.body.items[0].workflow["6"].inputs.text === "кадр на рассвете",
      JSON.stringify(imp && imp.body.items[0].workflow));
    const covers = posts.filter((p) => p.url.includes("attach_preview"));
    check("v1.57: тот же PNG привязан обложкой к своей записи (raw, force=true)",
      covers.length === 1 && covers[0].body.id === "png1" && covers[0].body.force === true
        && String(covers[0].body.preview_data).startsWith("data:image/png"),
      JSON.stringify(covers.map((c) => c.body.id)));
    check("v1.57: отчёт — создано 1, без дубликатов и потерь",
      /создано 1/.test(String(st.hintSticky)) && /дубликатов/.test(String(st.hintSticky)) === false,
      String(st.hintSticky));
  } finally {
    sandbox.fetch = origFetch;
    windowStub.showDirectoryPicker = origPicker;
    st.toast = origToast;
  }
});

await run("v1.57: importRun переживает ok без валидного JSON (rep=null)", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const origFetch = sandbox.fetch;
  const origToast = st.toast;
  st.toast = () => {};
  const importRes = { ok: true, status: 200,
    json: async () => { throw new Error("не JSON"); },
    text: async () => JSON.stringify({}), blob: async () => ({}), headers: { get: () => null } };
  sandbox.fetch = async (u, init) => String(u).includes("/prompt_library/import")
    ? importRes
    : (String(u).includes("/prompt_library/list") ? jsonResponse(listResponse) : jsonResponse({}));
  try {
    st.selFolder = "__all";
    let threw = null, hint = null;
    try {
      await st.importRun([{ title: "t", prompt: "p", folder: "", created_at: "",
        favorite: false, media: null, src: "s.png" }], false);
    } catch (e) { threw = e; }
    hint = String(st.hintSticky);
    check("v1.57: rep=null не роняет импорт — сводка «создано 0»",
      threw === null && /создано 0/.test(hint),
      threw ? ("THROW: " + String(threw)) : hint);
  } finally {
    sandbox.fetch = origFetch;
    st.toast = origToast;
  }
});

// --- v1.58: PNG — выбор «папка / отдельные файлы» (см. §50.7) -----------------
await run("v1.58: PNG — меню-выбор открывает панель с папкой и файлами", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const origToast = st.toast;
  st.toast = () => {};
  try {
    st.selFolder = "Коллекция";
    const before = documentStub.body.children.length;
    st.importPickPng("Коллекция");
    check("v1.58: выбор PNG открывает оверлей (а не сразу диалог папки)",
      documentStub.body.children.length === before + 1,
      String(documentStub.body.children.length));
    const panel = documentStub.body.children[documentStub.body.children.length - 1];
    const btns = walkEls(panel).filter((e) => typeof e.onclick === "function");
    const sources = btns.filter((b) => String(b.textContent) !== "Отмена");
    check("v1.58: в панели два источника + «Отмена», оба активны",
      btns.length === 3 && sources.length === 2 && sources.every((b) => !b.disabled),
      btns.map((b) => String(b.textContent)).join(" | "));
    check("v1.58: метки — папка со всеми PNG и отдельные файлы",
      sources.some((b) => b.textContent.includes("Папка") && b.textContent.includes("PNG"))
        && sources.some((b) => /файл/i.test(b.textContent)),
      sources.map((b) => String(b.textContent)).join(" | "));
    const beforeCancel = documentStub.body.children.length;
    btns[btns.length - 1].onclick();
    check("v1.58: «Отмена» снимает оверлей",
      documentStub.body.children.length === beforeCancel - 1,
      String(documentStub.body.children.length));
  } finally {
    st.toast = origToast;
  }
});

await run("v1.58: PNG — импорт отдельных файлов (src уникален, обложка по src)", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const origFetch = sandbox.fetch;
  const origToast = st.toast;
  st.toast = () => {};
  st.fileToDataUrl = async () => "data:image/png;base64,RklMRQ";
  const posts = [];
  const graph = { "5": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "луч света в окне" } } };
  const goodPng = makePng([pngTexT("prompt", JSON.stringify(graph))]);
  const fakeFile = (name, bytes) => ({ name, size: bytes.length,
    arrayBuffer: async () => new Uint8Array(bytes) });
  sandbox.fetch = async (u, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(u), body });
    if (String(u).includes("/prompt_library/import")) {
      return jsonResponse({ ok: true, created: [
        { id: "f1", title: "Первое", folder: "", src: "Первое.png" },
        { id: "f2", title: "Первое", folder: "", src: "Первое_2.png" } ],
        skipped: [], failed: [], free: 100, total: 2 });
    }
    if (String(u).includes("/prompt_library/list")) return jsonResponse(listResponse);
    return jsonResponse({});
  };
  try {
    st.selFolder = "Коллекция";
    await st.importPngFromFiles([fakeFile("Первое.png", goodPng), fakeFile("Первое.png", goodPng)]);
    const imp = posts.find((p) => p.url.includes("/prompt_library/import"));
    check("v1.58: файлы ушли записями, промпт из чанка, категория пуста",
      imp && imp.body.items.length === 2
        && imp.body.items.every((it) => it.prompt === "луч света в окне")
        && imp.body.items.every((it) => it.folder === "" && it.media === "image"),
      JSON.stringify(imp && imp.body.items));
    check("v1.58: одинаковые имена файлов получают уникальные src",
      imp && imp.body.items[0].src === "Первое.png" && imp.body.items[1].src === "Первое_2.png",
      JSON.stringify(imp && imp.body.items.map((i) => i.src)));
    check("v1.58: граф уходит в запись (items.workflow)",
      imp && imp.body.items.every((it) => it.workflow && it.workflow["6"]),
      JSON.stringify(imp && imp.body.items));
    const covers = posts.filter((p) => p.url.includes("attach_preview"));
    check("v1.58: обложки обеих записей привязаны (по уникальному src)",
      covers.length === 2 && new Set(covers.map((c) => c.body.id)).size === 2,
      JSON.stringify(covers.map((c) => c.body.id)));
    check("v1.58: отчёт — создано 2",
      /создано 2/.test(String(st.hintSticky)), String(st.hintSticky));
  } finally {
    sandbox.fetch = origFetch;
    st.toast = origToast;
  }
});

await run("v1.57: HTML-галерея — парсинг собственной карточки (round-trip)", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const full = { id: "h1", title: "Закат над морем", folder: "Фото/Пейзажи",
    created_at: "2021-05-06T07:08:09", media: "image", favorite: true,
    prompt: "тёплый свет, длинная выдержка" };
  const html = st.entryToHtml(full, { model: "flux1-dev" }, "Портреты/Закат над морем.png");
  const cards = st.parseGalleryHtml(html);
  check("v1.57: из собственной карточки читаются title и промпт",
    cards.length === 1 && cards[0].title === "Закат над морем"
      && cards[0].prompt === "тёплый свет, длинная выдержка", JSON.stringify(cards));
  check("v1.57: категория/тип/★/дата перенесены",
    cards[0].folder === "Фото/Пейзажи" && cards[0].media === "image"
      && cards[0].favorite === true && cards[0].created_at === "2021-05-06T07:08:09",
    JSON.stringify(cards[0]));
  check("v1.57: src обложки декодирован в относительный путь",
    cards[0].relImg === "Портреты/Закат над морем.png", JSON.stringify(cards[0].relImg));
  const nocat = st.parseGalleryHtml(st.entryToHtml(
    { id: "h2", title: "Нет", folder: "", media: null, favorite: false, prompt: "тело" }, {}, ""));
  check("v1.57: «Без категории» → folder=''",
    nocat.length === 1 && nocat[0].folder === "", JSON.stringify(nocat));
  const unk = st.parseGalleryHtml("<html><body>нет карточек</body></html>");
  check("v1.57: чужой html — пустой список (не ошибка)",
    Array.isArray(unk) && unk.length === 0, JSON.stringify(unk));
});

await run("v1.57: импорт HTML-галереи — категории из карточек, обложки из папки", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const origFetch = sandbox.fetch;
  const origPicker = windowStub.showDirectoryPicker;
  const origToast = st.toast;
  st.toast = () => {};
  st.fileToDataUrl = async () => "data:image/png;base64,aW1n";
  const posts = [];
  const card = (id, title, folder, img, prompt) => st.entryToHtml(
    { id, title, folder, created_at: "", media: "image", favorite: false, prompt }, {}, img);
  const html = `<!DOCTYPE html><html><body><main>\n${card("g1", "Море", "Фото", "Фото/Закат.png", "закат над водой")}\n${card("g2", "Кот", "Фото/Животные", "Фото/Животные/Cat.png", "рыжий кот")}\n</main></body></html>`;
  const htmlFile = {
    kind: "file", name: "prompt_library.html",
    getFile: async () => ({ name: "prompt_library.html", size: html.length, text: async () => html }),
  };
  const img = (name) => ({
    kind: "file", name,
    getFile: async () => ({ name, size: 1000, text: async () => "", arrayBuffer: async () => new Uint8Array(0) }),
  });
  const root = {
    kind: "directory", name: "root",
    values: async function* () {
      yield htmlFile;
      yield { kind: "directory", name: "Фото", values: async function* () {
        yield img("Закат.png");
        yield { kind: "directory", name: "Животные", values: async function* () { yield img("Cat.png"); } };
      } };
    },
  };
  windowStub.showDirectoryPicker = async () => root;
  sandbox.fetch = async (u, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(u), body });
    if (String(u).includes("/prompt_library/import")) {
      return jsonResponse({ ok: true, created: [
        { id: "h1", title: "Море", folder: "Коллекция/Фото", src: "prompt_library.html#1" },
        { id: "h2", title: "Кот", folder: "Коллекция/Фото/Животные", src: "prompt_library.html#2" } ],
        skipped: [], failed: [], free: 100, total: 2 });
    }
    if (String(u).includes("/prompt_library/list")) return jsonResponse(listResponse);
    return jsonResponse({});
  };
  try {
    st.selFolder = "Коллекция";
    await st.importHtmlFromFolder(true);
    const imp = posts.find((p) => p.url.includes("/prompt_library/import"));
    check("v1.57: html-карточки ушли записями с категориями карточки",
      imp && imp.body.items.length === 2
        && imp.body.items[0].folder === "Фото" && imp.body.items[1].folder === "Фото/Животные"
        && imp.body.items[0].src === "prompt_library.html#1"
        && imp.body.items[1].src === "prompt_library.html#2"
        && imp.body.items.every((it) => it.media === "image"),
      JSON.stringify(imp && imp.body.items));
    const covers = posts.filter((p) => p.url.includes("attach_preview"));
    check("v1.57: обложки галереи привязаны к своим записям",
      covers.length === 2 && new Set(covers.map((c) => c.body.id)).size === 2,
      JSON.stringify(covers.map((c) => c.body.id)));
  } finally {
    sandbox.fetch = origFetch;
    windowStub.showDirectoryPicker = origPicker;
    st.toast = origToast;
  }
});

await run("v1.57: текстовый файл — разбиение на записи (абзац/строка/весь)", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const es1 = st.textEntries("Заметки.txt", "первая строка\n\nвторой абзац.", "para");
  check("v1.57: абзацы — записи, title — первая строка абзаца",
    es1.length === 2 && es1[0].prompt === "первая строка" && es1[0].title === "первая строка",
    JSON.stringify(es1));
  const es2 = st.textEntries("теги.txt", "brave\nglitter\nnight", "line");
  check("v1.57: строки — записи, title — имя файла",
    es2.length === 3 && es2[1].prompt === "glitter" && es2[0].title === "теги.txt",
    JSON.stringify(es2));
  const es3 = st.textEntries("Заголовок.md", "# Заголовок\n\nвся история", "whole");
  check("v1.57: весь файл — одна запись, title из «# …»",
    es3.length === 1 && es3[0].prompt === "# Заголовок\n\nвся история" && es3[0].title === "Заголовок",
    JSON.stringify(es3));
  check("v1.57: пустой текст — пустой разбор",
    st.textEntries("p.txt", "\n \n", "para").length === 0);

  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    posts.push({ url: String(u), body });
    if (String(u).includes("/prompt_library/import")) {
      return jsonResponse({ ok: true, created: [
        { id: "t1", title: "звёзды яркие", folder: "", src: "небо.txt#para" },
        { id: "t2", title: "луна", folder: "", src: "небо.txt#para" }],
        skipped: [], failed: [], free: 100, total: 2 });
    }
    if (String(u).includes("/prompt_library/list")) return jsonResponse(listResponse);
    return jsonResponse({});
  };
  try {
    st.selFolder = "__all";
    await st.importTextRun([{ base: "небо.txt", text: "звёзды яркие\n\nлуна" }], st.selFolder, "para");
    const imp = posts.find((p) => p.url.includes("/prompt_library/import"));
    check("v1.57: текстовые записи — без категорий и обложек",
      imp && imp.body.items.length === 2
        && imp.body.items.every((it) => it.folder === "" && it.media === null)
        && imp.body.items[0].prompt === "звёзды яркие" && imp.body.items[1].prompt === "луна",
      JSON.stringify(imp && imp.body.items));
    check("v1.57: без обложек attach_preview не вызывается",
      !posts.some((p) => p.url.includes("attach_preview")),
      JSON.stringify(posts.map((p) => p.url)));
    check("v1.57: отчёт «создано 2»",
      /создано 2/.test(String(st.hintSticky)), String(st.hintSticky));
  } finally {
    sandbox.fetch = origFetch;
  }
});

// --- v1.62: сессионный кэш окна «Протестировать / ➕ Добавить промпт» ---------
// Регресс: смена воркфлоу (пересоздание ноды + onConfigure) раньше теряла текст
// и название из окна ручного ввода. Теперь — сессионный Map по id ноды.
await run("v1.62: смена воркфлоу не теряет текст/название/открытость окна ввода", async () => {
  const SID = 901;

  // Первая нода: окно открыто, текст назван и введён — запись ушла в кэш.
  const node1 = makeNode();
  node1.id = SID;
  const qwA = { name: "quick_test", value: "" };
  node1.widgets.push(qwA);
  proto.onNodeCreated.call(node1);
  const st1 = node1._pl;
  const ta1 = madeEls.filter((e) => e.tagName === "TEXTAREA" && e !== st1.dText).pop();
  const toggle1 = walkDom(st1.root).find((el) => el.tagName === "BUTTON"
    && String(el.textContent).includes("Протестировать"));
  check("v1.62: toggle найден в DOM ноды", !!ta1 && !!toggle1, String(toggle1?.textContent));

  toggle1.onclick();                                  // открыли окно
  ta1.value = "короткий тест промпта";
  st1.inputTitle.value = "Заголовок сессии";
  ta1.oninput();                                      // updateQuickTest → saveInputSession
  st1.inputTitle.oninput();
  check("v1.62: на проводе quick_test активен ВНУТРИ первой ноды", qwA.value === "короткий тест промпта", qwA.value);

  // Смена воркфлоу: новая нода с ТЕМ ЖЕ id, onNodeCreated + onConfigure.
  const node2 = makeNode();
  node2.id = SID;
  const qwB = { name: "quick_test", value: "" };
  node2.widgets.push(qwB);
  proto.onNodeCreated.call(node2);
  const st2 = node2._pl;
  proto.onConfigure.call(node2, {
    widgets_values: ["📥 Запись", "", "Fs/FAS"],
    widgets_values_named: { mode: "📥 Запись", selected: "", save_folder: "Fs/FAS" },
  });
  const ta2 = madeEls.filter((e) => e.tagName === "TEXTAREA" && e !== st2.dText).pop();

  check("v1.62: текст вернулся в новую ноду", ta2.value === "короткий тест промпта", JSON.stringify(ta2.value));
  check("v1.62: название вернулось", st2.inputTitle.value === "Заголовок сессии", JSON.stringify(st2.inputTitle.value));
  check("v1.62: окно снова открыто (inputArea flex)",
    ta2.parentNode.style.display === "flex", String(ta2.parentNode.style.display));
  check("v1.62: зеркало на провод восстановлено после onConfigure",
    qwB.value === "короткий тест промпта", qwB.value);

  // Свежий id — кэш пуст, окно остаётся закрытым (no-op, без падений).
  const node3 = makeNode();
  node3.id = 902;
  const qwC = { name: "quick_test", value: "" };
  node3.widgets.push(qwC);
  proto.onNodeCreated.call(node3);
  const st3 = node3._pl;
  proto.onConfigure.call(node3, {
    widgets_values: ["📥 Запись", "", ""],
    widgets_values_named: { mode: "📥 Запись", selected: "", save_folder: "" },
  });
  const ta3 = madeEls.filter((e) => e.tagName === "TEXTAREA" && e !== st3.dText).pop();
  check("v1.62: свежий id — окно закрыто (не flex)", ta3.parentNode.style.display !== "flex", JSON.stringify(ta3.parentNode.style.display));
  check("v1.62: свежий id — текст пуст", ta3.value === "", JSON.stringify(ta3.value));
  check("v1.62: свежий id — провод пуст", qwC.value === "", qwC.value);

  // Закрытие окна перезаписывает запись: после возврата окно закрыто, но текст
  // сохранён в поле (на провод не идёт — окно закрыто = quick_test пуст).
  toggle1.onclick();                                  // закрыли в первой ноде
  check("v1.62: после закрытия quick_test пуст", qwA.value === "", qwA.value);
  const node4 = makeNode();
  node4.id = SID;
  const qwD = { name: "quick_test", value: "" };
  node4.widgets.push(qwD);
  proto.onNodeCreated.call(node4);
  const st4 = node4._pl;
  proto.onConfigure.call(node4, {
    widgets_values: ["📥 Запись", "", ""],
    widgets_values_named: { mode: "📥 Запись", selected: "", save_folder: "" },
  });
  const ta4 = madeEls.filter((e) => e.tagName === "TEXTAREA" && e !== st4.dText).pop();
  check("v1.62: закрытое окно восстановилось закрытым",
    ta4.parentNode.style.display === "none", String(ta4.parentNode.style.display));
  check("v1.62: текст при закрытом окне тоже восстанавливается",
    ta4.value === "короткий тест промпта", JSON.stringify(ta4.value));
  check("v1.62: закрытое окно = провод пуст", qwD.value === "", qwD.value);
});

// --- v1.66: промпт импорта из ИСПОЛНЕННОГО слоя (чанк prompt) на реальных формах ---
// Отчёт пользователя (2026-10-05): «при загрузке изображения в библиотеку
// импортируется не тот промпт, по которому сгенерировано изображение».
// Замер на его собственных файлах (1139 PNG в output/): у 160 из них (14 %)
// обход positive-цепочки возвращал ПУСТО, поэтому запись либо не создавалась
// (`без текста`), либо промпт подхватывался из UI-графа/превью — а там лежит
// УСТАРЕВШИЙ виджет холста. Пример, где видно оба слоя сразу:
//   output/Ужасы/Монстры/Krea2_Raw_00249_.png
//     чанк prompt  → PromptKeeper.text = «A wide-angle… mist-laden wetland…» (исполнено)
//     чанк workflow→ тот же PromptKeeper.widgets_values[0] = «A low-angle documentary…» (старое)
// Причина пустого обхода: цепочка positive проходит сквозь узлы, которые
// детектор не знал — PreviewAny (сквозной вход `source`), ComfySwitchNode
// (ветки on_false/on_true, а не input_*), TextGenerate/LLM (его ВЫХОД в файле
// не лежит — тупик, а не источник) — и сквозь текстовые узлы, у которых
// значение лежит во входе `value` (PrimitiveStringMultiline), а не `text`/`prompt`.
// Проверка падала ДО правки: все три случая возвращали "".
await run("v1.66: промпт import берётся из исполненной ветки (примитив → value)", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const api = {
    "5": { class_type: "KSampler", inputs: { positive: ["6", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: ["9", 0], clip: ["7", 0] } },
    "9": { class_type: "PrimitiveStringMultiline", inputs: { value: "прямой промпт примитива" } },
  };
  check("v1.66: значение текстового примитива (вход `value`) найдено",
    st.promptFromGraph(api) === "прямой промпт примитива",
    JSON.stringify(st.promptFromGraph(api)));
});

await run("v1.66: цепочка проходит PreviewAny и свитчи, LLM — тупик, не источник", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  // Форма реального output/Пейзажи/Водопады/Krea2_turbo_00377_.png:
  //   KSampler → Krea2StyleSemanticConditioning.prompt → PreviewAny.source →
  //   свитч → { ветка LLM TextGenerate | примитив с промптом }
  const api = {
    "70": { class_type: "KSampler", inputs: { positive: ["798", 0] } },
    "798": { class_type: "Krea2StyleSemanticConditioning",
      inputs: { prompt: ["779", 0], clip: ["54", 0], style_image: ["735", 0] } },
    "779": { class_type: "PreviewAny", inputs: { source: ["780", 0] } },
    "780": { class_type: "ComfySwitchNode",
      inputs: { switch: ["781", 0], on_false: ["64", 0], on_true: ["777", 0] } },
    "64": { class_type: "ComfySwitchNode",
      inputs: { switch: ["61", 0], on_false: ["59", 0], on_true: ["63", 0] } },
    "59": { class_type: "PreviewAny", inputs: { source: ["67", 0] } },
    "67": { class_type: "ComfySwitchNode",
      inputs: { switch: ["62", 0], on_false: ["58", 0], on_true: ["66", 0] } },
    "58": { class_type: "PrimitiveStringMultiline", inputs: { value: ["769", 0] } },
    "769": { class_type: "PrimitiveStringMultiline",
      inputs: { value: "водопад в тропическом лесу" } },
    // Выход LLM в PNG не пишется — из него промпт взять нельзя.
    "66": { class_type: "TextGenerate", inputs: { prompt: ["57", 0], clip: ["734", 0] } },
    "57": { class_type: "StringConcatenate",
      inputs: { string_a: ["65", 0], string_b: ["58", 0] } },
    "65": { class_type: "PrimitiveStringMultiline",
      inputs: { value: "You are an expert prompt engineer for text-to-image models." } },
    "777": { class_type: "StringConcatenate",
      inputs: { string_a: ["64", 0], string_b: ["814", 0] } },
    "814": { class_type: "ImpactSwitch", inputs: { input1: ["776", 0] } },
    "776": { class_type: "PrimitiveStringMultiline",
      inputs: { value: "\n\n[MASTER STYLE]\n\nArt-directed photographic realism" } },
  };
  const got = st.promptFromGraph(api);
  check("v1.66: сквозь PreviewAny и свитчи дошёл до промпта из ветки",
    got === "водопад в тропическом лесу", JSON.stringify(got));
  check("v1.66: системный промпт LLM и [MASTER STYLE] в запись не попали",
    !/expert prompt engineer/.test(got) && !/MASTER STYLE/.test(got), JSON.stringify(got));
});

await run("v1.66: свитч сабграфа не ломает поиск входа сэмплера", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  // Форма реального output/Ужасы/Монстры/Krea2_Raw_00249_.png: positive сэмплера
  // приходит на свитч ВНУТРИ сабграфа (id вида "1717:1711").
  const api = {
    "1524": { class_type: "KSampler", inputs: { positive: ["1717:1711", 0] } },
    "1717:1711": { class_type: "ComfySwitchNode",
      inputs: { switch: ["1717:1708", 0], on_false: ["1522", 0], on_true: ["1717:1709", 0] } },
    "1522": { class_type: "CLIPTextEncode",
      inputs: { text: ["1622", 0], clip: ["1515:1520", 0] } },
    "1622": { class_type: "PromptKeeper",
      inputs: { text: "исполненный промпт болота", source: ["1625", 0] } },
    "1625": { class_type: "ComfySwitchNode",
      inputs: { switch: ["1692", 0], on_false: ["1679", 0], on_true: ["1685", 0] } },
    "1717:1709": { class_type: "CLIPTextEncode",
      inputs: { text: "чужая ветка сабграфа" } },
  };
  // v1.67 уточнил правило: у подхвата с проводом `source` исполненный текст берётся
  // из UI-графа, и здесь (граф передан без ui) работает запасной путь — свой виджет.
  check("v1.66/1.67: без UI-графа — виджет узла, а не чужая ветка сабграфа",
    st.promptFromGraph(api) === "исполненный промпт болота",
    JSON.stringify(st.promptFromGraph(api)));
});


// --- v1.67: PromptKeeper пишет ИСПОЛНЕННЫЙ текст в UI-граф, а чанк `prompt` ---
// --- хранит предпрогонный виджет. Отчёт пользователя (2026-10-05): ---------
// импортировался промпт ЧУЖОГО прогона. Форма реального файла
// output/Космос/Планеты/Krea2_Raw_00696_.png (газовый гигант):
//   чанк prompt  → 1622 PromptKeeper.text = «…low orbit… Earth…» (что лежало в
//                  виджете ДО прогона — прошлый промпт);
//   чанк workflow→ 1622 widgets_values[0] = «…uncharted gas giant…» — сюда
//                  prompt_keeper_node.py:34 записал ФАКТИЧЕСКИЙ выход узла.
// Замер на файлах пользователя: 677 из 701 расходились (сдвиг на один прогон).
const KEEPER_STALE = "A sweeping cinematic wide shot from a low orbit perspective looking down at the curved limb of Earth";
const KEEPER_DONE = "A sweeping cinematic wide shot of a serene, uncharted gas giant orbiting close to its star";
const keeperApi = {
  "1524": { class_type: "KSampler", inputs: { positive: ["1522", 0], negative: ["1523", 0] } },
  "1522": { class_type: "CLIPTextEncode", inputs: { text: ["1622", 0], clip: ["1515:1520", 0] } },
  "1622": { class_type: "PromptKeeper", inputs: { text: KEEPER_STALE, source: ["1625", 0] } },
  "1625": { class_type: "ComfySwitchNode",
    inputs: { switch: ["1692", 0], on_false: ["1679", 0], on_true: ["1685", 0] } },
  "1679": { class_type: "ComfySwitchNode",
    inputs: { switch: ["1690", 0], on_false: ["1919", 0], on_true: ["1680", 0] } },
  "1919": { class_type: "PromptKeeper", inputs: { text: "Космос. Планеты", source: ["2004", 1] } },
  "2004": { class_type: "PromptLibrary",
    inputs: { mode: "📤📥 Выдача + запись", selected: "e60c058790", pickup: "1622", slots_out: "[]" } },
  "1692": { class_type: "PrimitiveBoolean", inputs: { value: false } },
};
const keeperUi = {
  nodes: [
    { id: 1622, type: "PromptKeeper", title: "Итоговый Promt",
      inputs: [{ name: "source", type: "*", link: 1 }],
      widgets_values: [KEEPER_DONE],
      widgets_values_named: { text: KEEPER_STALE } },
    { id: 1919, type: "PromptKeeper", inputs: [{ name: "source", type: "*", link: 2 }],
      widgets_values: ["MASTER STYLE text"], widgets_values_named: { text: "Космос. Планеты" } },
    { id: 1522, type: "CLIPTextEncode", inputs: [{ name: "text", type: "STRING", link: 3 }],
      widgets_values: [""] },
  ],
  links: [[3, 1622, 0, 1522, 1, "STRING"]],
};

await run("v1.67: PromptKeeper — исполненный текст берётся из UI-графа, не из чанка prompt", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const got = st.promptFromGraph(keeperApi, keeperUi);
  check("v1.67: в запись ушёл текст ПОСЛЕДНЕГО прогона (газовый гигант), а не предпрогонный виджет",
    got === KEEPER_DONE, JSON.stringify(got));
});

await run("v1.67: PromptKeeper без UI-графа — предпрогонное значение, а не чужая ветка свитча", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const got = st.promptFromGraph(keeperApi);
  check("v1.67: без UI-графа остался виджет узла (не «Космос. Планеты» из ветки source)",
    got === KEEPER_STALE, JSON.stringify(got));
});

await run("v1.67: PromptKeeper с неподключённым source — своё значение (оба графа сходятся)", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  const api = {
    "1524": { class_type: "KSampler", inputs: { positive: ["1522", 0] } },
    "1522": { class_type: "CLIPTextEncode", inputs: { text: ["1622", 0] } },
    "1622": { class_type: "PromptKeeper", inputs: { text: "ручной промпт" } },
  };
  const ui = { nodes: [{ id: 1622, type: "PromptKeeper", widgets_values: ["ручной промпт"] }], links: [] };
  check("v1.67: неподключённый source — берётся свой текст",
    st.promptFromGraph(api, ui) === "ручной промпт", JSON.stringify(st.promptFromGraph(api, ui)));
});

// --- v1.69 (§57): подпапки — видны и открываются ----------------------------
// Отчёт пользователя (2026-10-17): «папка Космос — подпапок вообще не видно,
// нельзя зайти внутрь и подключить карточку из подпапки».
// Проверяем: (1) в открытой категории подпапки стоят карточками, клик заходит
// внутрь; (2) в «🔌 Выходах» внутри папки-вывода видны подпапки, вход в них, и
// клик по карточке подпапки решает, что уходит в провод; (3) карточка из
// подпапки папки-вывода привязывается к ней и в обычной галерее.
const fsCard = (st, words) => st.list.children.find((c) => {
  const t = ftext(c);
  return words.every((w) => t.includes(w));
});

await run("v1.69: подпапки категории — карточками, клик заходит внутрь", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("k1", "Космос"), mkSlotEntry("k2", "Космос/Планеты"),
    mkSlotEntry("k3", "Земля"));
  st.folders.push("Космос", "Космос/Планеты", "Земля");
  st.selFolder = "Космос";
  st.renderTree(); st.render();
  const texts = () => st.list.children.map((c) => ftext(c));
  const sub = fsCard(st, ["📁", "Планеты"]);
  check("v1.69: в категории видна её подпапка карточкой (📁 Планеты)", !!sub,
    texts().join(" ; ") || "—");
  check("v1.69: подпапки этой категории найдены по дереву (только прямые дети)",
    JSON.stringify(st.subfoldersOf("Космос")) === JSON.stringify(["Космос/Планеты"]),
    JSON.stringify(st.subfoldersOf("Космос")));
  check("v1.69: список категории не подмешивает карточки подпапки и чужих папок",
    texts().some((t) => t.includes("k1")) && !texts().some((t) => t.includes("k2"))
      && !texts().some((t) => t.includes("k3")), texts().join(" ; ") || "—");
  check("v1.69: у карточки-подпапки видно число записей внутри",
    !!sub && ftext(sub).includes("записей: 1"), sub ? ftext(sub) : "нет карточки");
  if (sub) sub.onclick({});
  check("v1.69: клик по подпапке открыл её (selFolder = Космос/Планеты)",
    st.selFolder === "Космос/Планеты", String(st.selFolder));
  check("v1.69: внутри подпапки видна её карточка k2",
    texts().some((t) => t.includes("k2")), texts().join(" ; ") || "—");
  // Крошки в шапке списка: возврат на уровень выше без похода в проводник.
  const up = st.headNav ? st.headNav.children.find((c) => ftext(c).includes("⬆")) : null;
  check("v1.69: в шапке списка есть возврат на уровень выше (⬆)", !!up,
    st.headNav ? ftext(st.headNav) : "нет шапки-крошек");
  if (up) {
    up.onclick({ preventDefault() {}, stopPropagation() {} });
    check("v1.69: ⬆ вернул в родительскую категорию «Космос»",
      st.selFolder === "Космос", String(st.selFolder));
  }
});

await run("v1.69: «Выходы» — подпапки папки-вывода и вывод из подпапки", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.entries.push(mkSlotEntry("k1", "Космос"), mkSlotEntry("k2", "Космос/Планеты"));
  st.folders.push("Космос", "Космос/Планеты");
  st.selFolder = "__all";
  st.renderTree(); st.render();
  st.plDrop({ kind: "folder", path: "Космос" }, "__outs");
  st.selFolder = "__outs";
  st.outsActiveFolder = "Космос";
  st.renderTree(); st.render();
  const texts = () => st.list.children.map((c) => ftext(c));
  const sub = fsCard(st, ["📁", "Планеты"]);
  check("v1.69: внутри папки-вывода видны её подпапки", !!sub,
    texts().join(" ; ") || "—");
  if (sub) sub.onclick({});
  check("v1.69: вход в подпапку не выкинул из «Выходов» и не сменил папку-вывод",
    st.selFolder === "__outs" && st.outsActiveFolder === "Космос",
    `sel=${st.selFolder}, fs=${st.outsActiveFolder}`);
  check("v1.69: показаны карточки подпапки (k2), а не записи верхней папки",
    texts().some((t) => t.includes("k2")) && !texts().some((t) => t.includes("k1")),
    texts().join(" ; ") || "—");
  const cardK2 = st.list.children.find((c) => ftext(c).includes("k2"));
  check("v1.69: карточка подпапки — обычная карточка вывода (с выбором)", !!cardK2,
    texts().join(" ; ") || "—");
  if (cardK2) await cardK2.ondblclick?.({});
  check("v1.69: двойной клик по карточке подпапки сделал её активным выводом папки-вывода",
    !!st.outSlotOfFolder("Космос") && st.outSlotOfFolder("Космос").active_id === "k2",
    JSON.stringify(st.readOutSlots()));
  // Возврат живёт в шапке папки-вывода (та же строка, что подсказка про провод).
  const outHead = st.list.children.find((c) => ftext(c).includes("решает, что уходит"));
  const back = outHead ? outHead.children.find((c) => ftext(c).includes("⬅")) : null;
  check("v1.69: в папке-выводе есть возврат из подпапки (⬅) и вход в неё виден в шапке",
    !!back && ftext(outHead).includes("подпапка"),
    outHead ? ftext(outHead) : texts().join(" ; ") || "—");
  if (back) {
    back.onclick({ preventDefault() {}, stopPropagation() {} });
    check("v1.69: возврат показал снова записи самой папки-вывода (k1)",
      texts().some((t) => t.includes("k1")), texts().join(" ; ") || "—");
  }
});

await run("v1.69: карточка подпапки привязывается к папке-выводу предка", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.entries.push(mkSlotEntry("k1", "Космос"), mkSlotEntry("k2", "Космос/Планеты"));
  st.folders.push("Космос", "Космос/Планеты");
  st.selWidget.value = "k1"; // основной выход смотрит на запись верхней папки
  st.selFolder = "__all";
  st.renderTree(); st.render();
  st.plDrop({ kind: "folder", path: "Космос" }, "__outs");
  check("v1.69: подпапка считается частью ветки папки-вывода",
    !!st.folderSlotForPath("Космос/Планеты") && st.folderSlotForPath("Космос/Планеты").path === "Космос",
    JSON.stringify(st.readOutSlots()));
  check("v1.69: чужая ветка не считается частью папки-вывода",
    !st.folderSlotForPath("Земля"), "«Земля» сматчилась с папкой-выводом «Космос»");
  st.selFolder = "Космос/Планеты";
  st.renderTree(); st.render();
  const cardK2 = st.list.children.find((c) => ftext(c).includes("k2"));
  check("v1.69: в подпапке видна карточка k2", !!cardK2,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  if (cardK2) await cardK2.ondblclick?.({});
  check("v1.69: двойной клик по карточке подпапки переключил вывод папки-вывода «Космос»",
    !!st.outSlotOfFolder("Космос") && st.outSlotOfFolder("Космос").active_id === "k2",
    JSON.stringify(st.readOutSlots()));
  check("v1.69: основной выход не тронут (карточка принадлежит папке-выводу)",
    st.selWidget.value === "k1", String(st.selWidget.value));
  check("v1.69: карточка подпапки несёт маркер активного вывода (🔌)",
    !!st.folderActOf("k2"), "маркера активного вывода нет");
  check("v1.69: привязка папки-вывода наследует выделение и из подпапки",
    (() => {
      const n2 = mkSlotNode();
      const s2 = n2._pl;
      addSlotEnv(n2);
      s2.selWidget = n2.widgets.find((w) => w.name === "selected");
      s2.entries.push(mkSlotEntry("m1", "Космос/Планеты"));
      s2.folders.push("Космос", "Космос/Планеты");
      s2.selWidget.value = "m1";
      s2.plDrop({ kind: "folder", path: "Космос" }, "__outs");
      return !!s2.outSlotOfFolder("Космос") && s2.outSlotOfFolder("Космос").active_id === "m1";
    })());
});

// --- v1.70 (§58): подсветка подпапок, в которых лежит подключённая карточка --
// Отчёт пользователя: карточка выбрана глубоко в подпапке; вернувшись в верхнюю
// категорию, не видно, в какую ветку идти за подключённым промптом. Проверяем:
// карточка-подпапка на пути к подключённой записи подсвечена (тем же синим, что
// и сама выбранная карточка) на КАЖДОМ уровне, а соседние ветки — нет.
const folderCardBy = (st, path) => st.list.children.find((c) => String(c.title || "").includes("📁 " + path + " —"));

await run("v1.70: подпапка с подключённой карточкой подсвечена по всей глубине", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.entries.push(mkSlotEntry("k1", "Космос"), mkSlotEntry("k2", "Космос/Планеты"),
    mkSlotEntry("k3", "Космос/Планеты/Марс"), mkSlotEntry("k4", "Космос/Звёзды"));
  st.folders.push("Космос", "Космос/Планеты", "Космос/Планеты/Марс", "Космос/Звёзды");
  st.selWidget.value = "k3"; // выделение; v1.72: подсветку даёт active, не selected
  // v1.72 (конракт): подключённой считается active (§2.3: тест правится вместе
  // со сменой контракта — раньше «подключённой» кодировал selWidget).
  node.widgets.find((w) => w.name === "active").value = "k3";
  st.selFolder = "Космос";
  st.renderTree(); st.render();
  const planets = folderCardBy(st, "Космос/Планеты");
  const stars = folderCardBy(st, "Космос/Звёзды");
  check("v1.70: подпапка на пути к карточке подсвечена цветом выделения",
    !!planets && String(planets.style.cssText).includes("#4a9eff"),
    planets ? String(planets.style.cssText).slice(0, 140) : "карточки подпапки нет");
  check("v1.70: соседняя подпапка без карточки не подсвечена",
    !!stars && !String(stars.style.cssText).includes("#4a9eff"),
    stars ? String(stars.style.cssText).slice(0, 140) : "карточки подпапки нет");
  check("v1.70: на подсвеченной подпапке видно, сколько подключённых внутри",
    !!planets && ftext(planets).includes("🔌 1"), planets ? ftext(planets) : "карточки нет");
  check("v1.70: счётчик подключённых считается по всей глубине (Марс — внутри Планет)",
    st.folderActiveCount("Космос/Планеты") === 1 && st.folderActiveCount("Космос/Звёзды") === 0,
    `planets=${st.folderActiveCount("Космос/Планеты")}, stars=${st.folderActiveCount("Космос/Звёзды")}`);
  // Второй уровень: входим в «Планеты» — там подсвечена уже «Марс».
  st.selFolder = "Космос/Планеты";
  st.renderTree(); st.render();
  const mars = folderCardBy(st, "Космос/Планеты/Марс");
  check("v1.70: на втором уровне подсвечена подпапка с карточкой (Марс)",
    !!mars && String(mars.style.cssText).includes("#4a9eff"),
    mars ? String(mars.style.cssText).slice(0, 140) : "карточки подпапки нет");
});

await run("v1.70: путь к карточке из «Выходов» подсвечен и в галерее, и в «Выходах»", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.entries.push(mkSlotEntry("k1", "Космос"), mkSlotEntry("k2", "Космос/Планеты"));
  st.folders.push("Космос", "Космос/Планеты");
  st.selFolder = "__all";
  st.renderTree(); st.render();
  // Карточка из подпапки подключена к доп. выходу (выбор пуст — «промпт 1» ни при чём).
  st.plDrop({ kind: "entry", ids: ["k2"], id: "k2" }, "__outs");
  st.selFolder = "Космос";
  st.renderTree(); st.render();
  const planets = folderCardBy(st, "Космос/Планеты");
  check("v1.70: карточка в слоте «Выходов» тоже подсвечивает свою подпапку",
    !!planets && String(planets.style.cssText).includes("#4a9eff"),
    planets ? String(planets.style.cssText).slice(0, 140) : "карточки подпапки нет");
  check("v1.70: пустой выбор сам по себе ничего не подсвечивает (только слот)",
    st.folderActiveCount("Космос/Планеты") === 1, String(st.folderActiveCount("Космос/Планеты")));
  // «Выходы»: папка-вывод «Космос» — внутри неё путь к активной карточке тоже виден.
  // Карточку k2 сначала снимаем с выхода: иначе подсветка шла бы от её слота, и
  // проверка «пустая папка-вывод не подсвечена» ничего не измеряла бы.
  st.unbindOutSlot(2);
  check("v1.70: снятая с выхода карточка больше не подсвечивает подпапку",
    st.folderActiveCount("Космос/Планеты") === 0, String(st.folderActiveCount("Космос/Планеты")));
  st.plDrop({ kind: "folder", path: "Космос" }, "__outs");
  st.selFolder = "__outs";
  st.outsActiveFolder = "Космос";
  st.outsBrowsePath = "Космос";
  st.renderTree(); st.render();
  const outPlanets = folderCardBy(st, "Космос/Планеты");
  check("v1.70: без активной карточки папки-вывода подпапка не подсвечена",
    !!outPlanets && !String(outPlanets.style.cssText).includes("#4a9eff"),
    outPlanets ? String(outPlanets.style.cssText).slice(0, 140) : "карточки подпапки нет");
  if (outPlanets) outPlanets.onclick({});
  const cardK2 = st.list.children.find((c) => ftext(c).includes("k2"));
  check("v1.70: внутри подпапки папки-вывода видна карточка k2", !!cardK2,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  if (cardK2) await cardK2.ondblclick?.({});
  check("v1.70: двойной клик по карточке сделал её активным выводом папки-вывода",
    !!st.outSlotOfFolder("Космос") && st.outSlotOfFolder("Космос").active_id === "k2",
    JSON.stringify(st.readOutSlots()));
  // Назад к корню папки-вывода — и путь к подключённой карточке должен быть виден.
  const outHead = st.list.children.find((c) => ftext(c).includes("решает, что уходит"));
  const back = outHead ? outHead.children.find((c) => ftext(c).includes("⬅")) : null;
  if (back) back.onclick({ preventDefault() {}, stopPropagation() {} });
  const backPlanets = folderCardBy(st, "Космос/Планеты");
  check("v1.71: в «Выходах» путь к активной карточке папки-вывода подсвечен зелёным (светлая рамка)",
    !!backPlanets && String(backPlanets.style.cssText).includes("#4caf50"),
    backPlanets ? String(backPlanets.style.cssText).slice(0, 140) : "карточки подпапки нет");
});

// --- v1.71.1: подпапки папки-слота зелёные и в обычном проводнике ----------
// Отчёт пользователя: папка подключена к «Выходы» — внутри «Выходов» её
// подпапки зелёные, но клик по той же папке в проводнике (обычный режим)
// показывает их синими: зелёная логика (inOutSlot/parentSlot/isOutFolder)
// была закрыта флагом `o.outs`, который в обычном списке не передаётся.
await run("v1.71.1: подпапки подключённой категории зелёные и в проводнике, и в «Выходах»", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.entries.push(mkSlotEntry("g1", "Космос"), mkSlotEntry("g2", "Космос/Планеты"),
    mkSlotEntry("g3", "Космос/Звёзды"));
  st.folders.push("Космос", "Космос/Планеты", "Космос/Звёзды");
  // Папка «Космос» → доп. выход; активный вывод — g2, лежит в подпапке.
  st.selWidget.value = "g2";
  await st.plDrop({ kind: "folder", path: "Космос" }, "__outs");
  check("v1.71.1: папка подключена, активная карточка в подпапке",
    !!st.outSlotOfFolder("Космос") && st.outSlotOfFolder("Космос").active_id === "g2",
    JSON.stringify(st.readOutSlots()));
  // Клик по папке в проводнике: обычный режим, folderNavCard без opts.outs.
  st.selFolder = "Космос";
  st.renderTree(); st.render();
  const planets = folderCardBy(st, "Космос/Планеты");
  const stars = folderCardBy(st, "Космос/Звёзды");
  check("v1.71.1: подпапка с активным выводом зелёная (#4caf50), а не синяя",
    !!planets && String(planets.style.cssText).includes("#4caf50"),
    planets ? String(planets.style.cssText).slice(0, 160) : "карточки подпапки нет");
  check("v1.71.1: соседняя подпапка в пределах папки-слота зелёная (фон #1c3525)",
    !!stars && String(stars.style.cssText).includes("#1c3525"),
    stars ? String(stars.style.cssText).slice(0, 160) : "карточки подпапки нет");
  check("v1.71.1: бейдж подпапки — номер её слота (🔌 2), а не «(внутри)»",
    !!planets && ftext(planets).includes("🔌 2") && !ftext(planets).includes("(внутри)"),
    planets ? ftext(planets) : "карточки нет");
});

// --- v1.72: активация карточки по ДВОЙНОМУ клику ----------------------------
// Одиночный клик = только выделение; dblclick = промпт карточки уходит на выход
// того контекста, где она показана: галерея → основной выход (active), папка-
// вывод → active_id слота, привязанная карточка → тоггл off (пустой текст).
// Повторный dblclick = деактивация. Красная фаза: на текущем коде обработчика
// dblclick нет вовсе, поэтому ЕДИНСТВЕННОЕ место, где старый код ещё может
// сработать, — дожившиеся onclick: их мы НЕ вызываем перед dblclick.
await run("v1.72: галерея — dblclick активирует основной выход (active)", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("e71", "Фото"), mkSlotEntry("e72", "Фото"));
  st.folders.push("Фото");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  const activeW = node.widgets.find((w) => w.name === "active");
  st.selFolder = "__all";
  st.renderTree(); st.render();
  const card71 = st.list.children.find((c) => ftext(c).includes("e71"));
  const card72 = st.list.children.find((c) => ftext(c).includes("e72"));
  check("v1.72: карточки галереи видны", !!card71 && !!card72,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  if (card71) card71.onclick({});
  check("v1.72: одиночный клик только выделяет (sel=e71, active пуст)",
    st.selWidget.value === "e71" && !!activeW && activeW.value === "",
    `sel=${st.selWidget.value}, active=${activeW && activeW.value}`);
  check("v1.72: у карточки есть обработчик dblclick",
    typeof (card72 && card72.ondblclick) === "function",
    String(card72 && typeof card72.ondblclick));
  // Клик НЕ вызываем: на старом коде он бы сам выставил active и замаскировал
  // отсутствие dblclick.
  if (card72 && card72.ondblclick) await card72.ondblclick({});
  check("v1.72: dblclick переключил основной выход на e72",
    !!activeW && activeW.value === "e72", `active=${activeW && activeW.value}`);
  // Навигатор/счётчики подключённости обязаны считать по active: на старом
  // activeOutIds (читает selected) тут едет e71 — КРАСНОЕ до правки JS.
  check("v1.72: навигатор считает подключённым active (не selected)",
    st.activeOutIds().has("e72") && !st.activeOutIds().has("e71"),
    JSON.stringify([...st.activeOutIds().keys()]));
  st.render();
  const act72 = st.list.children.find((c) => ftext(c).includes("e72")
    && String(c.style.cssText).includes("background:#2a5a91"));
  check("v1.72: активная карточка — сплошная заливка #2a5a91", !!act72,
    st.list.children.map((c) => ftext(c) + " {" + String(c.style.cssText).slice(0, 90) + "}")
      .join(" ; ") || "—");
  // Повторный dblclick — деактивация (compound: до смены было e72).
  const was = activeW && activeW.value;
  if (card72 && card72.ondblclick) await card72.ondblclick({});
  check("v1.72: повторный dblclick снимает активацию (было e72 → стало пусто)",
    was === "e72" && !!activeW && activeW.value === "",
    `was=${was}, active=${activeW && activeW.value}`);
});

await run("v1.72: без клика карточки серые — тёмно-синий только у выбранной", () => {
  // Отчёт пользователя: после правки v1.72 ВСЕ карточки стали синими.
  // Причина была в gалерее: fallback брал `selVal ? "#1e2c44"` (любая
  // непустая выборка) вместо `e.id === selVal`. Серыми обязаны быть все, кроме
  // (1) выбранной одиночным кликом (#1e2c44 + рамка #4a9eff) и (2) главной
  // активной (#2a5a91) — здесь active пуст, активных нет.
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("q1", "Фото"), mkSlotEntry("q2", "Фото"), mkSlotEntry("q3", "Фото"));
  st.folders.push("Фото");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selFolder = "__all";
  st.renderTree(); st.render();
  st.selWidget.value = "q2";
  st.render();
  const bgOf = (id) => {
    const c = st.list.children.find((x) => ftext(x).includes(id));
    const m = c && String(c.style.cssText || "").match(/background:\s*(#[0-9a-fA-F]{6})/);
    return m ? m[1].toLowerCase() : String(c && c.style.cssText);
  };
  check("v1.72: невыбранная карточка q1 без клика — серая (#1e1e1e)",
    bgOf("q1") === "#1e1e1e", bgOf("q1"));
  check("v1.72: невыбранная карточка q3 без клика — серая (#1e1e1e)",
    bgOf("q3") === "#1e1e1e", bgOf("q3"));
  check("v1.72: выбранная кликом q2 — тёмно-синяя (#1e2c44)",
    bgOf("q2") === "#1e2c44", bgOf("q2"));
  check("v1.72: активных нет (active пуст) — ни одна карточка не #2a5a91",
    ["q1", "q2", "q3"].every((id) => bgOf(id) !== "#2a5a91"));
});

await run("v1.72: «Выходы» (папка-вывод) — dblclick переключает active_id", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("f1", "ПапкаF"), mkSlotEntry("f2", "ПапкаF"));
  st.folders.push("ПапкаF");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selFolder = "__all";
  st.renderTree(); st.render();
  await st.plDrop({ kind: "folder", path: "ПапкаF" }, "__outs");
  st.selFolder = "__outs";
  st.outsActiveFolder = "ПапкаF";
  st.renderTree(); st.render();
  const cF1 = st.list.children.find((c) => ftext(c).includes("f1"));
  const cF2 = st.list.children.find((c) => ftext(c).includes("f2"));
  check("v1.72: карточки папки-вывода видны", !!cF1 && !!cF2,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  // Клик f1: на старом коде он пишет active_id и отравляет проверку dblclick —
  // поэтому после него и проверяем, что КЛИК ничего не активировал.
  if (cF1) cF1.onclick({});
  const slotB = st.outSlotOfFolder("ПапкаF");
  check("v1.72: одиночный клик по f1 НЕ пишет active_id", !!slotB && slotB.active_id !== "f1",
    JSON.stringify(slotB));
  check("v1.72: у карточки папки-вывода есть dblclick",
    typeof (cF2 && cF2.ondblclick) === "function",
    String(cF2 && typeof cF2.ondblclick));
  if (cF2 && cF2.ondblclick) await cF2.ondblclick({});
  const slotB2 = st.outSlotOfFolder("ПапкаF");
  check("v1.72: dblclick переключил active_id на f2",
    !!slotB2 && slotB2.active_id === "f2", JSON.stringify(slotB2));
  const a2 = slotB2 && slotB2.active_id;
  if (cF2 && cF2.ondblclick) await cF2.ondblclick({});
  const a3 = (st.outSlotOfFolder("ПапкаF") || {}).active_id;
  check("v1.72: повторный dblclick снимает активный вывод (было f2 → пусто)",
    a2 === "f2" && a3 !== "f2", `a2=${a2}, a3=${a3}`);
});

await run("v1.72: галерея папки с папкой-выводом — клик не активирует, dblclick активирует (route 4)", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("f1", "ПапкаF"), mkSlotEntry("f2", "ПапкаF"));
  st.folders.push("ПапкаF");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  await st.plDrop({ kind: "folder", path: "ПапкаF" }, "__outs");
  st.selFolder = "ПапкаF"; // галерея по обычной папке, у которой есть папка-вывод
  st.renderTree(); st.render();
  const gF2 = st.list.children.find((c) => ftext(c).includes("f2"));
  check("v1.72: карточки галереи папки видны", !!gF2,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  // Старый код галереи (:3059-3065) сам пишет active_id при клике — красное.
  if (gF2) gF2.onclick({});
  const sG1 = st.outSlotOfFolder("ПапкаF");
  check("v1.72: одиночный клик в галерее папки НЕ пишет active_id", !!sG1 && sG1.active_id !== "f2",
    JSON.stringify(sG1));
  // Сброс вручную: без него старый клик оставил бы active_id=f2 и проверка
  // dblclick прошла бы по чужому следу (слепой зелёный).
  const arr0 = st.readOutSlots();
  const fs0 = st.pickFolderSlot(arr0, "ПапкаF");
  if (fs0) { fs0.active_id = ""; st.writeOutSlots(arr0); st.applyOutSockets(); }
  const sG0 = st.outSlotOfFolder("ПапкаF");
  check("v1.72: сброс active_id перед dblclick прошёл", !!sG0 && sG0.active_id === "",
    JSON.stringify(sG0));
  check("v1.72: у карточки галереи папки есть dblclick",
    typeof (gF2 && gF2.ondblclick) === "function",
    String(gF2 && typeof gF2.ondblclick));
  if (gF2 && gF2.ondblclick) await gF2.ondblclick({});
  const sG2 = st.outSlotOfFolder("ПапкаF");
  check("v1.72: dblclick в галерее активирует вывод папки (route 4)",
    !!sG2 && sG2.active_id === "f2", JSON.stringify(sG2));
});

await run("v1.72: привязанная карточка — dblclick toggles off (галерея + корень «Выходов»)", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("g1", "Космос"));
  st.folders.push("Космос");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selFolder = "__all";
  st.renderTree(); st.render();
  await st.plDrop({ kind: "entry", ids: ["g1"], id: "g1" }, "__outs");
  // 1) Галерея: привязанная карточка светится зелёным, dblclick выключает её.
  st.selFolder = "__all";
  st.renderTree(); st.render();
  // КОНТРАКТ СМЕНИЛСЯ (v1.73.6, §65): раньше (v1.72.2) привязанная карточка
  // галереи ВСЕГДА несла тусклый v1.71-цвет #1c3525 «независимо от активности».
  // Контракт А (§64.1, v1.73.5) распространён на проводник: карточка, которая
  // ВЫВОДИТСЯ (!off), обязана быть ярко-зелёной #2e6b4f/#7fe0a8 — как в
  // «Выходах». §2.3: конфликт задача↔тест → правится тест, не задача.
  // Выключенная (после dblclick ниже) остаётся тусклой #1c3525.
  const gCard = st.list.children.find((c) => ftext(c).includes("g1"));
  check("v1.73.6: привязанная (включённая) карточка в галерее — ярко-зелёная (фон #2e6b4f + рамка #7fe0a8)",
    !!gCard && String(gCard.style.cssText).includes("background:#2e6b4f")
      && String(gCard.style.cssText).includes("#7fe0a8"),
    gCard ? String(gCard.style.cssText).slice(0, 140) : "карточки нет");
  if (gCard) gCard.onclick({});
  const slot0 = st.outSlotOfEntry("g1");
  check("v1.72: одиночный клик не выключает слот (off не появился)",
    !!slot0 && !slot0.off, JSON.stringify(slot0));
  check("v1.72: у привязанной карточки галереи есть dblclick",
    typeof (gCard && gCard.ondblclick) === "function",
    String(gCard && typeof gCard.ondblclick));
  if (gCard && gCard.ondblclick) await gCard.ondblclick({});
  const slot1 = st.outSlotOfEntry("g1");
  check("v1.72: dblclick ставит off (слот молчит)", !!slot1 && slot1.off === true,
    JSON.stringify(slot1));
  st.render();
  // Охранитель контракта §65 (v1.73.6): выключенная (off) привязанная
  // карточка — тусклая #1c3525, яркой заливки #2e6b4f НЕТ. На старом коде
  // зелёный (там всегда тусклая) — ловит мутацию «яркая без учёта off».
  const gOff = st.list.children.find((c) => ftext(c).includes("g1"));
  check("v1.72.2: выключенная карточка — фон #1c3525, зелёной заливки нет",
    !!gOff && String(gOff.style.cssText).includes("background:#1c3525")
      && !String(gOff.style.cssText).includes("background:#2e6b4f"),
    gOff ? String(gOff.style.cssText).slice(0, 140) : "карточки нет");
  const offNow = slot1 && slot1.off;
  if (gOff && gOff.ondblclick) await gOff.ondblclick({});
  const slot2 = st.outSlotOfEntry("g1");
  check("v1.72: повторный dblclick включает обратно (off снят)",
    offNow === true && !!slot2 && !slot2.off, JSON.stringify(slot2));
  // 2) Корень «Выходов»: та же карточка через makeOutCard (ctx.slot).
  st.selFolder = "__outs";
  st.outsActiveFolder = "";
  st.renderTree(); st.render();
  // КОНТРАКТ СМЕНИЛСЯ (v1.73.5, §64, контракт А): раньше v1.72.4-проверка
  // требовала, что слот-карточка НИКОГДА не несёт #2e6b4f («яркий только у
  // папки-вывода»). Отчёт пользователя + согласование: яркая = карточка
  // ВЫВОДИТСЯ (!off), параллель active_id папки. Тест правится под новый
  // контракт (§2.3: конфликт задача↔тест → правится тест): карточка сейчас
  // включена (slot4 без off) → обязана быть ярко-зелёной.
  const oCard = st.list.children.find((c) => ftext(c).includes("g1"));
  check("v1.73.5: включённая карточка слота в «Выходах» — ярко-зелёная (фон #2e6b4f)",
    !!oCard && String(oCard.style.cssText).includes("background:#2e6b4f"),
    oCard ? String(oCard.style.cssText).slice(0, 140) : "карточки нет");
  check("v1.72: у карточки слота есть dblclick",
    typeof (oCard && oCard.ondblclick) === "function",
    String(oCard && typeof oCard.ondblclick));
  if (oCard && oCard.ondblclick) await oCard.ondblclick({});
  const slot3 = st.outSlotOfEntry("g1");
  check("v1.72: dblclick по карточке слота ставит off", !!slot3 && slot3.off === true,
    JSON.stringify(slot3));
  const off3 = slot3 && slot3.off;
  if (oCard && oCard.ondblclick) await oCard.ondblclick({});
  const slot4 = st.outSlotOfEntry("g1");
  check("v1.72: повторный dblclick по карточке слота снимает off",
    off3 === true && !!slot4 && !slot4.off, JSON.stringify(slot4));
});

await run("v1.72: миграция графа — active при первой загрузке старого воркфлоу", async () => {
  // (а) старый граф без active (6 значений) → active := selected из wv[1]
  const nA = mkSlotNode();
  addSlotEnv(nA);
  const wA = nA.widgets.find((w) => w.name === "active");
  proto.onConfigure.call(nA, {
    widgets_values: ["📥 Запись", "e72", "Фото", "", "[]", ""],
    widgets_values_named: {},
  });
  check("v1.72 (а): старый граф 6 значений → active унаследовал selected (e72)",
    !!wA && wA.value === "e72", String(wA && wA.value));
  // (б) 7 значений и named.active:"" — именованное ПУСТОЕ перекрывает позицию:
  // позиционный остаток "m1" стоит и в виджете, и в wv[6] — выжить может
  // только ветка named. До правки JS миграции нет → в m1 и остаётся (RED).
  const nB = mkSlotNode();
  addSlotEnv(nB);
  const wB = nB.widgets.find((w) => w.name === "active");
  if (wB) wB.value = "m1";
  proto.onConfigure.call(nB, {
    widgets_values: ["📥 Запись", "m1", "Фото", "", "[]", "", "m1"],
    widgets_values_named: { active: "" },
  });
  check("v1.72 (б): named.active=\"\" перекрывает позицию (не остался m1)",
    !!wB && wB.value === "", String(wB && wB.value));
  // (в) named.active задан → читается при гидрации (позиция wv[6] намеренно
  // другая: только ветка named даёт e73, позиционная дала бы «stale7»).
  const nC = mkSlotNode();
  addSlotEnv(nC);
  const wC = nC.widgets.find((w) => w.name === "active");
  proto.onConfigure.call(nC, {
    widgets_values: ["📥 Запись", "", "", "", "[]", "", "stale7"],
    widgets_values_named: { active: "e73" },
  });
  check("v1.72 (в): named.active читается при гидрации",
    !!wC && wC.value === "e73", String(wC && wC.value));
  // (г) старый граф 5 значений (до slots_out/quick_test/active) — selected
  // берём из позиции wv[1]: без миграции active остаётся пустым (RED).
  const nD = mkSlotNode();
  addSlotEnv(nD);
  const wD = nD.widgets.find((w) => w.name === "active");
  proto.onConfigure.call(nD, {
    widgets_values: ["📥 Запись", "e74", "Фото", "", "[]"],
    widgets_values_named: {},
  });
  check("v1.72 (г): граф в 5 значений → active унаследовал selected из wv[1] (e74)",
    !!wD && wD.value === "e74", String(wD && wD.value));
});

// --- v1.72.5: новая карточка в подключённую папку/подпапку «Выходов» ---------
await run("v1.72.5: сохранение при выбранной папке-выводе уходит в неё, не в «Без категории»", async () => {
  const node = mkSlotNode();
  node.id = 90;
  proto.onNodeCreated.call(node);
  const st = node._pl;
  addSlotEnv(node);
  const origFetch = sandbox.fetch;
  const posts = [];
  sandbox.fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries: [], folders: [] });
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes("/prompt_library/add")) return jsonResponse({ ok: true, id: "a1" });
    return jsonResponse({ ok: true });
  };
  try {
    st.plDrop({ kind: "folder", path: "ПапкаA" }, "__outs");
    const ta = madeEls.filter((e) => e.tagName === "TEXTAREA" && e !== st.dText).pop();
    const saveBtn = walkDom(st.root).find((el) => el.tagName === "BUTTON"
      && String(el.textContent).includes("Сохранить промпт"));
    check("v1.72.5: кнопка сохранения найдена", !!ta && !!saveBtn);
    // (а) открыта папка-вывод в «Выходах» → промпт идёт в неё
    st.selFolder = "__outs";
    st.outsActiveFolder = "ПапкаA";
    st.outsBrowsePath = "ПапкаA";
    ta.value = "текст в папку-вывод";
    await saveBtn.onclick();
    const addA = posts.filter((p) => p.url.includes("/prompt_library/add")).pop();
    check("v1.72.5: выбрана папка-вывод → folder = «ПапкаA» (а не «»)",
      addA?.body?.folder === "ПапкаA", JSON.stringify(addA?.body));
    // (б) открытая подпапка (просмотр ниже корня папки-вывода) → в подпапку
    st.outsBrowsePath = "ПапкаA/Под";
    ta.value = "текст в подпапку";
    await saveBtn.onclick();
    const addB = posts.filter((p) => p.url.includes("/prompt_library/add")).pop();
    check("v1.72.5: открыта подпапка → folder = «ПапкаA/Под»",
      addB?.body?.folder === "ПапкаA/Под", JSON.stringify(addB?.body));
    // (в) сами «Выходы» без открытой папки → «Без категории» (контракт v1.72.5:
    // это поведение сохраняется, пользователь его подтвердил)
    st.outsActiveFolder = "";
    st.outsBrowsePath = "";
    ta.value = "текст в без категории";
    await saveBtn.onclick();
    const addC = posts.filter((p) => p.url.includes("/prompt_library/add")).pop();
    check("v1.72.5: сами «Выходы» без папки → folder = «» (Без категории)",
      addC?.body?.folder === "", JSON.stringify(addC?.body));
    // (г) проводник: папка выбрана обычным кликом → folder = её путь
    st.selFolder = "ПапкаA";
    ta.value = "текст из проводника";
    await saveBtn.onclick();
    const addD = posts.filter((p) => p.url.includes("/prompt_library/add")).pop();
    check("v1.72.5: папка выбрана в проводнике → folder = «ПапкаA»",
      addD?.body?.folder === "ПапкаA", JSON.stringify(addD?.body));
  } finally {
    sandbox.fetch = origFetch;
  }
});

// --- v1.72.6: зелёное выделение подключённой папки в проводнике и её карточек --
// Отчёт пользователя (два скриншота): (1) клик по подключённой 🔌 папке в ОБЩЕМ
// дереве подсвечивает строку тёмно-синим #2c4a73 — нужен зелёный как у строк
// слотов в «Выходах» (§60.8), цвет обязан свидетельствовать о подключении;
// (2) карточки в списке, открытом через проводник у подключённой папки, при
// клике не подсвечиваются вовсе — клик по подключённой карточке не пишет
// selWidget (v1.59), а bg-цепочка галереи не читает st.detailId, в отличие от
// makeOutCard после v1.72.3.
await run("v1.72.6: строка подключённой папки в проводнике активна зелёным как в «Выходах»", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("h1", "ПапкаH"), mkSlotEntry("u1", "ПапкаU"));
  st.folders.push("ПапкаH", "ПапкаU");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  await st.plDrop({ kind: "folder", path: "ПапкаH" }, "__outs");
  st.renderTree();
  // Строки папок узнаются по кнопке 📍/📌: строка слота «Выходов» с тем же
  // путём (📁 ПапкаH 🔌N) лежит выше и кнопки закрепления не имеет.
  const folderRowOf = (key) => st.tree.children.find((r) => {
    const t = ftext(r);
    return t.includes(key) && (t.includes("📍") || t.includes("📌"));
  });
  const rowH = folderRowOf("ПапкаH");
  check("v1.72.6: строка папки-категории «ПапкаH» в дереве найдена", !!rowH,
    st.tree.children.map((r) => ftext(r)).join(" ; ") || "—");
  if (rowH) rowH.onclick({});
  const cssH = String((folderRowOf("ПапкаH") || {}).style?.cssText || "");
  check("v1.72.6: активная подключённая папка — зелёный фон #2e6b4f (как строка слота в «Выходах»)",
    cssH.includes("background:#2e6b4f"), cssH.slice(0, 220));
  check("v1.72.6: …и inset-полоса #7fe0a8 как у активного слота в «Выходах»",
    cssH.includes("box-shadow:inset 3px 0 0 #7fe0a8"), cssH.slice(0, 220));
  // Охранители контракта: неподключённая папка остаётся синей; подключённая
  // без выбора — прозрачной (зелёная заливка только у активной).
  const rowU = folderRowOf("ПапкаU");
  if (rowU) rowU.onclick({});
  const cssU = String((folderRowOf("ПапкаU") || {}).style?.cssText || "");
  check("v1.72.6: активная неподключённая папка — прежний синий #2c4a73",
    cssU.includes("background:#2c4a73"), cssU.slice(0, 220));
  st.selFolder = "__all";
  st.renderTree();
  const cssIdle = String((folderRowOf("ПапкаH") || {}).style?.cssText || "");
  check("v1.72.6: подключённая папка без выбора — без зелёной заливки (transparent)",
    cssIdle.includes("background:transparent"), cssIdle.slice(0, 220));
});

await run("v1.72.6: карточка в списке подключённой папки — зелёный селект при клике", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("k1", "ПапкаK"), mkSlotEntry("k2", "ПапкаK"),
    mkSlotEntry("m1", "ПапкаM"));
  st.folders.push("ПапкаK", "ПапкаM");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  await st.plDrop({ kind: "folder", path: "ПапкаK" }, "__outs");
  st.selFolder = "ПапкаK";
  st.renderTree(); st.render();
  const bgOf = (id) => {
    const c = st.list.children.find((x) => ftext(x).includes(id));
    const m = c && String(c.style.cssText || "").match(/background:\s*(#[0-9a-fA-F]{6})/);
    return m ? m[1].toLowerCase() : String(c && c.style.cssText);
  };
  const cardK = st.list.children.find((c) => ftext(c).includes("k1"));
  check("v1.72.6: карточка k1 в списке подключённой папки видна", !!cardK,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  if (cardK) await cardK.onclick({});
  const cssK = String((st.list.children.find((c) => ftext(c).includes("k1")) || {}).style?.cssText || "");
  check("v1.72.6: клик подсветил карточку подключённой папки зелёным (#1c3525 + рамка #2e6b4f)",
    bgOf("k1") === "#1c3525" && cssK.includes("border:1px solid #2e6b4f"),
    `${bgOf("k1")} | ${cssK.slice(0, 160)}`);
  check("v1.72.6: это СЕЛЕКТ, не активация — сплошной заливки #2e6b4f нет",
    bgOf("k1") !== "#2e6b4f", bgOf("k1"));
  check("v1.72.6: selWidget не тронут (v1.59: подключённая карточка не берёт основной выход)",
    st.selWidget.value === "" && st.detailId === "k1",
    `sel=${st.selWidget.value}, detail=${st.detailId}`);
  check("v1.72.6: невыбранная соседка k2 — серая (#1e1e1e)",
    bgOf("k2") === "#1e1e1e", bgOf("k2"));
  // Охранитель: в неподключённой папке клик по-прежнему даёт синий #1e2c44
  // (контракт v1.72.2, галерея без подключения не зеленеет).
  st.selFolder = "ПапкаM";
  st.renderTree(); st.render();
  const cardM = st.list.children.find((c) => ftext(c).includes("m1"));
  if (cardM) await cardM.onclick({});
  check("v1.72.6: неподключённая папка — синий селект #1e2c44 (v1.72.2 не тронут)",
    bgOf("m1") === "#1e2c44", bgOf("m1"));
});

await run("v1.72.7: активация карточки в списке подключённой папки — ярко-зелёная как в «Выходах»", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("k1", "ПапкаK"), mkSlotEntry("k2", "ПапкаK"));
  st.folders.push("ПапкаK");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  await st.plDrop({ kind: "folder", path: "ПапкаK" }, "__outs");
  st.selFolder = "ПапкаK";
  st.renderTree(); st.render();
  const bgOf = (id) => {
    const c = st.list.children.find((x) => ftext(x).includes(id));
    const m = c && String(c.style.cssText || "").match(/background:\s*(#[0-9a-fA-F]{6})/);
    return m ? m[1].toLowerCase() : String(c && c.style.cssText);
  };
  const cssOf = (id) => {
    const c = st.list.children.find((x) => ftext(x).includes(id));
    return String((c && c.style.cssText) || "");
  };
  const card1 = st.list.children.find((c) => ftext(c).includes("k1"));
  check("v1.72.7: карточка k1 в списке подключённой папки видна", !!card1,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  // Одиночный клик — селект-зелёный (контракт v1.72.6, охраняется как был).
  if (card1) await card1.onclick({});
  check("v1.72.7: одиночный клик — селект-зелёный #1c3525 + рамка #2e6b4f (v1.72.6 охранитель)",
    bgOf("k1") === "#1c3525" && cssOf("k1").includes("border:1px solid #2e6b4f"),
    `${bgOf("k1")} | ${cssOf("k1").slice(0, 160)}`);
  // Двойной клик — активация вывода папки (route 4): должна дать ЯРКИЙ цвет,
  // как isActive в makeOutCard (§60.8): фон #2e6b4f + рамка #7fe0a8.
  if (card1 && card1.ondblclick) await card1.ondblclick({});
  const slotK = st.outSlotOfFolder("ПапкаK");
  check("v1.72.7: dblclick активировал вывод папки (active_id=k1)",
    !!slotK && slotK.active_id === "k1", JSON.stringify(slotK));
  check("v1.72.7: активированная карточка в галерее — ЯРКО-зелёная (фон #2e6b4f + рамка #7fe0a8)",
    bgOf("k1") === "#2e6b4f" && cssOf("k1").includes("#7fe0a8"),
    `${bgOf("k1")} | ${cssOf("k1").slice(0, 160)}`);
  // Повторный dblclick снимает активацию → возврат к селект-зелёному.
  if (card1 && card1.ondblclick) await card1.ondblclick({});
  check("v1.72.7: деактивация вернула селект-зелёный #1c3525 (яркой заливки нет)",
    bgOf("k1") === "#1c3525", bgOf("k1"));
  // Соседняя карточка никак не задета активацией.
  check("v1.72.7: соседка k2 без активации — серая #1e1e1e (не ярко-зелёная)",
    bgOf("k2") === "#1e1e1e", bgOf("k2"));
});

// v1.72.8 (третья итерация, отчёт по скриншоту): «костыльно, тончайшая
// рамка — нужны нормальные вещи». Inset-тень на строке со скруглением
// рендерилась сужающимися краями и висела у ЛЕВОГО КРАЯ строки (вдали от
// иконки при отступе) — выглядела как остаток рамки. Контракт: настоящий
// ЭЛЕМЕНТ-метка (span 4×13, радиус 2px, #4a9eff) первым ребёнком строки —
// сразу слева от 📁, вместе с отступом вложенности; inset-тени для пути
// больше НЕТ; фон строки не трогается; ровно одна строка (только папка
// карточки, без предков). Приоритет: marked (☑ + оранжевая тень) и
// подключённый активный (зелёная тень) гасят метку.
await run("v1.72.8: папка активной карточки — элемент-метка слева от 📁, без тени и заливки", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("a81", "Фото/Портреты"), mkSlotEntry("a82", "Видео"));
  st.folders.push("Фото", "Фото/Портреты", "Видео");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  st.selFolder = "__all";
  st.renderTree(); st.render();
  const activeW = node.widgets.find((w) => w.name === "active");
  // Строки папок узнаются по 📍/📌 (заголовок строки-слота «Выходов» не имеет
  // кнопки закрепления). Подпись строки — ЛИСТ («📁 Портреты»), полный путь
  // живёт в title: «Фото» и «Портреты» не пересекаются по ftext.
  const folderRowOf = (key) => st.tree.children.find((r) => {
    const t = ftext(r);
    return t.includes(key) && (t.includes("📍") || t.includes("📌"));
  });
  const cssOf = (key) => String((folderRowOf(key) || {}).style?.cssText || "");
  // Метка — отдельный ребёнок строки с #4a9eff (у самой строки цвета пути нет:
  // тень убрана, drag-outline — событие, не покраска).
  const markChildOf = (key) => {
    const r = folderRowOf(key);
    return r && [...(r.children || [])]
      .find((c) => String(c.style?.cssText || "").includes("#4a9eff"));
  };
  const rowPosOf = (key) => {
    const r = folderRowOf(key);
    return r && [...(r.children || [])].indexOf(markChildOf(key));
  };
  // Сани: до активации ни метки, ни тени, ни заливки.
  check("v1.72.8: до активации подпапка чиста (нет метки/тени, transparent)",
    !markChildOf("Портреты") && cssOf("Портреты").includes("background:transparent")
      && !cssOf("Портреты").includes("#4a9eff"), cssOf("Портреты").slice(0, 200));
  const card81 = st.list.children.find((c) => ftext(c).includes("a81"));
  check("v1.72.8: карточка a81 в галерее видна", !!card81,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  // Маршрут 4 (своих слотов и папок-слотов нет) → activeW.
  if (card81) await card81.ondblclick({});
  check("v1.72.8: dblclick выставил основной выход (active=a81)",
    !!activeW && activeW.value === "a81", `active=${activeW && activeW.value}`);
  st.renderTree();
  // КРАСНОЕ до правки: вместо элемента — inset-тень на строке.
  check("v1.72.8: подпапка — ЭЛЕМЕНТ-метка (#4a9eff) среди детей строки",
    !!markChildOf("Портреты"),
    cssOf("Портреты").slice(0, 220) + " | children="
    + [...((folderRowOf("Портреты") || {}).children || [])].length);
  check("v1.72.8: inset-тени пути на строке больше НЕТ",
    !cssOf("Портреты").includes("box-shadow:inset 3px 0 0 #4a9eff"), cssOf("Портреты").slice(0, 220));
  // Метка — первым ребёнком (слева от 📁), а не у края строки.
  check("v1.72.8: метка первым ребёнком — слева от иконки папки",
    rowPosOf("Портреты") === 0, `pos=${rowPosOf("Портреты")}`);
  // Контракт фона: никакой заливки.
  check("v1.72.8: подпапка — фон прозрачный (заливки нет)",
    cssOf("Портреты").includes("background:transparent"), cssOf("Портреты").slice(0, 220));
  // Одна строка: предок и соседка чисты.
  check("v1.72.8: предок «Фото» НЕ отмечен (нет метки и заливки)",
    !markChildOf("Фото") && cssOf("Фото").includes("background:transparent"), cssOf("Фото").slice(0, 220));
  check("v1.72.8: соседняя «Видео» чиста (transparent)",
    cssOf("Видео").includes("background:transparent"), cssOf("Видео").slice(0, 220));
  // Деактивация повторным dblclick снимает метку.
  if (card81) await card81.ondblclick({});
  st.renderTree();
  check("v1.72.8: деактивация убрала метку с подпапки",
    !markChildOf("Портреты") && cssOf("Портреты").includes("background:transparent"),
    cssOf("Портреты").slice(0, 140));
});

// v1.72.9 (§60.13, третья итерация, живой скриншот): «я активировал карточку
// в подпапке, а зелёный маркер стоит на основной корневой папке, а должен
// быть на подпапке». Контракт: зелёная метка #7fe0a8 — на СТРОКЕ ПАПКИ
// КАРТОЧКИ (точное se.folder === key, без предков), когда эта карточка
// активна на ближайший слот-вывод (folderSlotForPath(se.folder).active_id —
// тот же слот, что и маршрут 2). Подключённая папка при карточке в её
// подпапке ВТОРУЮ метку не получает. Приоритет: синяя activeW-метка >
// зелёная; marked гасит зелёную. Детект — только `background:#7fe0a8`
// (слот-бейдж 🔌N — того же цвета, но это color).
await run("v1.72.9: зелёная метка — на строке папки активной карточки вывода", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("b81", "Фото/Портреты"), mkSlotEntry("b82", "Видео"));
  st.folders.push("Фото", "Фото/Портреты", "Видео");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  st.selFolder = "__all";
  // Как на скриншоте: подключён ПРЕДОК «Фото», карточка активирована в подпапке.
  await st.plDrop({ kind: "folder", path: "Фото" }, "__outs");
  st.renderTree(); st.render();
  const folderRowOf = (key) => st.tree.children.find((r) => {
    const t = ftext(r);
    return t.includes(key) && (t.includes("📍") || t.includes("📌"));
  });
  const cssOf = (key) => String((folderRowOf(key) || {}).style?.cssText || "");
  // Метка — ребёнок строки с background:<цвет> (бейджи — color:<цвет>, не путать).
  const markChildOf = (key, color) => {
    const r = folderRowOf(key);
    return r && [...(r.children || [])]
      .find((c) => String(c.style?.cssText || "").includes("background:" + color));
  };
  const setAct = (path, id) => {
    const arr = st.readOutSlots();
    const fs = st.pickFolderSlot(arr, path);
    if (fs) { fs.active_id = id || ""; st.writeOutSlots(arr); st.applyOutSockets(); }
    st.renderTree(); st.render();
  };
  check("v1.72.9: до активации зелёных меток нет",
    !markChildOf("Портреты", "#7fe0a8") && !markChildOf("Фото", "#7fe0a8"),
    cssOf("Портреты").slice(0, 160) + " | " + cssOf("Фото").slice(0, 160));
  // Активируем карточку подпапки на вывод «Фото» (маршрут 2).
  setAct("Фото", "b81");
  // КРАСНОЕ до правки JS: метка висит на подключённом предке, а не на подпапке.
  check("v1.72.9: подпапка карточки «Портреты» — зелёная ЭЛЕМЕНТ-метка",
    !!markChildOf("Портреты", "#7fe0a8"),
    cssOf("Портреты").slice(0, 200) + " | children="
    + [...((folderRowOf("Портреты") || {}).children || [])].length);
  check("v1.72.9: подключённый предок «Фото» БЕЗ метки (метка на папке карточки)",
    !markChildOf("Фото", "#7fe0a8"), cssOf("Фото").slice(0, 160));
  // Синяя метка не появляется (activeW не трогали).
  check("v1.72.9: синяя метка не появилась (activeW пуст)",
    !markChildOf("Портреты", "#4a9eff"), cssOf("Портреты").slice(0, 140));
  // Сброс активации — метки нет.
  setAct("Фото", "");
  check("v1.72.9: деактивация убрала зелёную метку",
    !markChildOf("Портреты", "#7fe0a8"), cssOf("Портреты").slice(0, 140));
  // Случай 2: подключена сама папка карточки — метка на ней же.
  await st.plDrop({ kind: "folder", path: "Фото/Портреты" }, "__outs");
  setAct("Фото/Портреты", "b81");
  check("v1.72.9: подключена сама папка карточки — метка на ней",
    !!markChildOf("Портреты", "#7fe0a8"), cssOf("Портреты").slice(0, 200));
  // Охранитель §60.11: открытая в галерее СЛОТ-папка залита — метка гаснет.
  st.selFolder = "Фото/Портреты";
  st.renderTree(); st.render();
  check("v1.72.9: открытая слот-папка — метка гаснет (залита §60.11)",
    !markChildOf("Портреты", "#7fe0a8")
      && cssOf("Портреты").includes("background:#2e6b4f"), cssOf("Портреты").slice(0, 140));
  // Соседняя ветка чиста.
  check("v1.72.9: соседняя «Видео» без меток",
    !markChildOf("Видео", "#7fe0a8") && !markChildOf("Видео", "#4a9eff"),
    cssOf("Видео").slice(0, 140));
});

// v1.72.10 (§60.14, задача пользователя): «в "Выходы" штекеры с
// подключенными папками — если активирована карточка любая в подаваемом на
// "Выходе", то штекер становится зеленым, если не активирована - обычным,
// ИЛИ рядом со штекером слева сделать маленький круг зеленый». Эмодзи 🔌
// не перекрашивается CSS-цветом, поэтому берётся второй вариант: у строки
// папки-слота с непустым active_id (dblclick → маршрут 2, §60.11) первым
// ребёнком строки (слева от штекера 🔌N) появляется зелёный кружок 6px
// #7fe0a8. Карточка-слот кружка не имеет — сама карточка и есть вывод.
// Детект кружка: ребёнок строки со background:#7fe0a8 (штекер 🔌N —
// color:#7fe0a8, не фон; залитка открытой папки — cssText СТРОКИ, не
// ребёнка).
await run("v1.72.10: зелёный кружок у штекера папки-вывода с активной карточкой", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("b91", "Фото"), mkSlotEntry("b92", "Видео"));
  st.folders.push("Фото", "Видео");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  st.selFolder = "__all";
  await st.plDrop({ kind: "folder", path: "Фото" }, "__outs"); // 🔌 папка
  await st.plDrop({ kind: "entry", id: "b92" }, "__outs");      // 🔌 карточка
  st.renderTree(); st.render();
  // Строка слота в «Выходах»: прямой ребёнок st.tree с num-спаном /^🔌\d+$/
  // (папки главного дерева такого спана не имеют).
  const slotRowOf = (needle) => st.tree.children.find((r) =>
    [...(r.children || [])]
      .some((c) => /^🔌\d+$/.test(String(c.textContent || "")) && ftext(r).includes(needle)));
  const dotOf = (row) => row && [...(row.children || [])]
    .find((c) => String(c.style?.cssText || "").includes("background:#7fe0a8"));
  const setAct = (path, id) => {
    const arr = st.readOutSlots();
    const fs = st.pickFolderSlot(arr, path);
    if (fs) { fs.active_id = id || ""; st.writeOutSlots(arr); st.applyOutSockets(); }
    st.renderTree(); st.render();
  };
  const rowCss = (row) => String(row && row.style ? row.style.cssText : "(нет строки)");
  // До активации: кружка нет.
  check("v1.72.10: папка-слот «Фото» без активной карточки — кружка нет",
    !dotOf(slotRowOf("Фото")), rowCss(slotRowOf("Фото")).slice(0, 160));
  // Карточка-слот — без кружка всегда (даже если её выбрать).
  check("v1.72.10: карточка-слот — кружка нет (только папки-выводы)",
    !!slotRowOf("b92") && !dotOf(slotRowOf("b92")), rowCss(slotRowOf("b92")).slice(0, 160));
  // Активируем карточку на папку-вывод → кружок слева от штекера.
  setAct("Фото", "b91");
  const actRow = slotRowOf("Фото");
  check("v1.72.10: папка-слот с активной карточкой — зелёный кружок слева от штекера",
    !!dotOf(actRow) && ftext(actRow).includes("🔌"),
    rowCss(actRow).slice(0, 200) + " | children=" + [...(actRow ? actRow.children : [])].length);
  // Деактивация — кружок снят.
  setAct("Фото", "");
  check("v1.72.10: деактивация сняла кружок",
    !dotOf(slotRowOf("Фото")), rowCss(slotRowOf("Фото")).slice(0, 140));
  // Активная карточка на ВТОРОМ папочном слоте — кружок только на нём.
  st.entries.push(mkSlotEntry("b93", "Видео"));
  await st.plDrop({ kind: "folder", path: "Видео" }, "__outs");
  setAct("Фото", "b91");
  setAct("Видео", "b93");
  check("v1.72.10: два папочных слота — кружки на обоих, карточка-слот чист",
    !!dotOf(slotRowOf("Фото")) && !!dotOf(slotRowOf("Видео"))
      && !dotOf(slotRowOf("b92")),
  [...(slotRowOf("b92") ? slotRowOf("b92").children : [])].length + " children у карточки");
});

// v1.72.11 (§60.15, задача пользователя): «крестики удаления X можешь
// заменить на тёмный, но не серый кружок с красным крестиком внутри, так
// будет красивее». Контракт: кнопка отвязки в строке слота «Выходов» —
// <button> с border-radius:50% (круг), background:#414141 (тёмный —
// #262626→#383838→#464646 подбирался по фидбеку, итог чуть темнее),
// color:#e05555 (красный крестик), font-weight:700 (жирнее, фидбек),
// глиф ✕; hover осветляет (#525252 / #ff6b6b). Поведение не трогается: stopPropagation + unbindOutSlot —
// слот отвязывается.
await run("v1.72.11: кнопка отвязки слота — тёмный кружок с красным крестиком", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("c91", "Фото"));
  st.folders.push("Фото");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  st.selFolder = "__all";
  await st.plDrop({ kind: "folder", path: "Фото" }, "__outs");
  st.renderTree(); st.render();
  const slotRowOf = (needle) => st.tree.children.find((r) =>
    [...(r.children || [])]
      .some((c) => /^🔌\d+$/.test(String(c.textContent || "")) && ftext(r).includes(needle)));
  const delBtnOf = (row) => row && [...(row.children || [])]
    .find((c) => c.tagName === "BUTTON");
  const row = slotRowOf("Фото");
  const del = delBtnOf(row);
  const dcss = String(del && del.style ? del.style.cssText : "(нет кнопки)");
  check("v1.72.11: кнопка отвязки существует в строке слота", !!del, dcss.slice(0, 120));
  // КРАСНОЕ до правки JS: старый ✖ — background:none, цвет #e08a3c, без круга.
  check("v1.72.11: кнопка — круг (border-radius:50%)",
    dcss.includes("border-radius:50%"), dcss.slice(0, 200));
  check("v1.72.11: фон тёмный #414141 (не none/сливается)",
    dcss.includes("background:#414141"), dcss.slice(0, 200));
  check("v1.72.11: крестик жирный (font-weight:700)",
    dcss.includes("font-weight:700") || dcss.includes("font-weight:bold"),
    dcss.slice(0, 200));
  check("v1.72.11: крестик красный #e05555 (не #e08a3c)",
    dcss.includes("color:#e05555") && !dcss.includes("#e08a3c"), dcss.slice(0, 200));
  check("v1.72.11: глиф-крестик ✕/✖", /[✕✖]/.test(String(del ? del.textContent : "")),
    String(del ? del.textContent : ""));
  // Охранитель поведения: клик по кнопке отвязывает слот (не ломаем wiring).
  const before = st.readOutSlots().length;
  if (del && del.onclick) del.onclick({ stopPropagation() {} });
  st.renderTree(); st.render();
  check("v1.72.11: клик по кнопке отвязал слот (unbindOutSlot)",
    st.readOutSlots().length === before - 1,
    "было " + before + " → стало " + st.readOutSlots().length);
});

// --- v1.73 (§61): ДВОЙНОЙ клик по папке → путь категории на выходе 0 ---------
await run("v1.73: cat_pick — двойной клик выбирает папку, строка фиолетовая", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("k1", "Котики/Пушистые"), mkSlotEntry("k2", "Псы"));
  st.folders.push("Котики", "Котики/Пушистые", "Псы");
  st.selFolder = "__all";
  st.renderTree(); st.render();
  const cpW = node.widgets.find((w) => w.name === "cat_pick");
  const rowOf = (key) => st.tree.children.find((r) =>
    [...(r.children || [])].some((c) => c.title === key));
  check("v1.73: виджет cat_pick есть в харнессе", !!cpW, String(!!cpW));
  check("v1.73: cat_pick скрыт из панели свойств (hideInPanel)",
    !!(cpW && cpW.options && cpW.options.hideInPanel === true),
    String(cpW && cpW.options && cpW.options.hideInPanel));
  const rowK = rowOf("Котики/Пушистые");
  check("v1.73: строка вложенной папки отрисована (плоский обход)",
    !!rowK, st.tree.children.map((r) => ftext(r)).join(" ; "));
  check("v1.73: у строки папки есть обработчик dblclick",
    !!(rowK && typeof rowK.ondblclick === "function"),
    String(rowK && typeof rowK.ondblclick));
  // Двойной клик: cat_pick = путь папки, строка фиолетовая с кружком-меткой
  if (rowK && rowK.ondblclick) rowK.ondblclick({});
  const rowK2 = rowOf("Котики/Пушистые");
  check("v1.73: cat_pick === путь папки после dblclick",
    !!cpW && String(cpW.value || "") === "Котики/Пушистые",
    String(cpW && cpW.value));
  const cssPick = String((rowK2 && rowK2.style.cssText) || "");
  check("v1.73: заливка строки — фиолетовая #3a2d66", cssPick.includes("background:#3a2d66"), cssPick);
  check("v1.73: рамка-кольцо — inset #b388ff", cssPick.includes("box-shadow:inset 0 0 0 1px #b388ff"), cssPick);
  const mkP = rowK2 && rowK2.children[0];
  // Стиль читаем целиком из cssText: стаб style не парсит строку в свойства
  // (width/height как отдельные поля в стабе пусты всегда).
  const mkCss = String((mkP && mkP.style && mkP.style.cssText) || "");
  check("v1.73: метка-кружок 6px первым ребёнком строки",
    !!(mkP && mkCss.includes("width:6px") && mkCss.includes("border-radius:50%")),
    mkCss);
  check("v1.73: подсказка метки — «Путь категории»",
    !!(mkP && String(mkP.title || "").includes("Путь категории")),
    String(mkP && mkP.title));
  check("v1.73: title строки упоминает двойной клик",
    !!(rowK2 && String(rowK2.title || "").includes("Двойной клик")),
    String(rowK2 && rowK2.title));
  // Повторный dblclick по той же папке — снять выбор
  if (rowK2 && rowK2.ondblclick) rowK2.ondblclick({});
  const rowK3 = rowOf("Котики/Пушистые");
  check("v1.73: повторный dblclick снимает выбор (cat_pick пуст)",
    !!cpW && String(cpW.value || "") === "", String(cpW && cpW.value));
  check("v1.73: без выбора строка снова прозрачная",
    String((rowK3 && rowK3.style.cssText) || "").includes("background:transparent"),
    String(rowK3 && rowK3.style.cssText));
  // Охранители: чужая строка не красится; служебная ветка без обработчика
  const rowP = rowOf("Псы");
  check("v1.73: чужая строка папки прозрачная",
    String((rowP && rowP.style.cssText) || "").includes("background:transparent"),
    String(rowP && rowP.style.cssText));
  const rowAll = st.tree.children.find((r) => ftext(r).includes("📚"));
  check("v1.73: служебная ветка «Всё» без dblclick-обработчика",
    !!(rowAll && typeof rowAll.ondblclick !== "function"),
    String(rowAll && typeof rowAll.ondblclick));
});

await run("v1.73: приоритет стилей — активная папка синяя, пометка ☑ важнее pick", () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("k1", "Котики"), mkSlotEntry("k2", "Псы"));
  st.folders.push("Котики", "Псы");
  st.selFolder = "__all";
  st.renderTree(); st.render();
  const cpW = node.widgets.find((w) => w.name === "cat_pick");
  const rowOf = (key) => st.tree.children.find((r) =>
    [...(r.children || [])].some((c) => c.title === key));
  // Путь категории задан напрямую — здесь тестируются СТИЛИ (логика dblclick
  // — в фазе выше): папка pick остаётся фиолетовой, когда открыта другая.
  cpW.value = "Котики";
  st.renderTree();
  const rowK = rowOf("Котики");
  check("v1.73: папка cat_pick фиолетовая, когда открыта другая",
    !!(rowK && String(rowK.style.cssText).includes("background:#3a2d66")),
    String(rowK && rowK.style.cssText));
  // Клик по «Псы» — активная строка синяя, cat_pick-строка не перекрашивается
  const rowD = rowOf("Псы");
  if (rowD && rowD.onclick) rowD.onclick({});
  const cssD = String((rowOf("Псы") && rowOf("Псы").style.cssText) || "");
  check("v1.73: активная (открытая) папка — прежний синий #2c4a73",
    cssD.includes("background:#2c4a73"), cssD);
  const cssK = String((rowOf("Котики") && rowOf("Котики").style.cssText) || "");
  check("v1.73: cat_pick-строка не перекрашена в синий (фиолетовая стоит)",
    cssK.includes("background:#3a2d66"), cssK);
  check("v1.73: cat_pick пережил клик по чужой папке",
    String(cpW.value || "") === "Котики", String(cpW.value));
  // Пометка ☑ важнее cat_pick (оранжевая заливка по-прежнему сверху)
  st.markFolders.add("Котики");
  st.renderTree();
  const cssM = String((rowOf("Котики") && rowOf("Котики").style.cssText) || "");
  check("v1.73: помеченная строка (☑) важнее cat_pick — оранжевая",
    cssM.includes("background:rgba(224,138,60,.35)"), cssM);
  check("v1.73: пометка не трогает значение cat_pick",
    String(cpW.value || "") === "Котики", String(cpW.value));
});

// --- v1.73.4 (§63): одиночная карточка в «Выходах» ---------------------------
// Задача пользователя (две части): (1) «при подключении одиночной карточки в
// "Выходы" папка/подпапка не подсвечивается зелёным маркером» — контракт §60.13
// строился ТОЛЬКО на папке-выводе (folderSlotForPath → pickFolderSlot фильтрует
// kind !== "folder", active_id), карточка-слот в выборку не попадала;
// (2) «нельзя деактивировать двойным кликом, она всегда выводится» — у строки
// карточки-слота в ДЕРЕВЕ обработчика ondblclick НЕТ вовсе (два клика
// подряд лишь перерисовывают выбор). Контракт: папка (точная, без предков)
// подключённой НЕвыключенной карточки-слота несёт зелёную ЭЛЕМЕНТ-метку
// #7fe0a8; выключенная (off) карточка молчит и метки не получает; dblclick
// по строке карточки-слота тогглит off (маршрут 1/2 activateCard), строка
// при off затемняется (color:#777); строка ПАПОЧНОГ�� слота dblclick не
// получает (маршрут 2 — на карточках, §60.11).
await run("v1.73.4: папка подключённой одиночной карточки-слота — зелёная метка", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("m1", "SYSTEM PROMPT/Видео"), mkSlotEntry("m2", "SYSTEM PROMPT"));
  st.folders.push("SYSTEM PROMPT", "SYSTEM PROMPT/Видео", "Другая");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  st.selFolder = "__all";
  await st.plDrop({ kind: "entry", ids: ["m1"], id: "m1" }, "__outs");
  st.renderTree(); st.render();
  const folderRowOf = (key) => st.tree.children.find((r) => {
    const t = ftext(r);
    return t.includes(key) && (t.includes("📍") || t.includes("📌"));
  });
  const markOf = (key) => {
    const r = folderRowOf(key);
    return r && [...(r.children || [])]
      .find((c) => String(c.style?.cssText || "").includes("background:#7fe0a8"));
  };
  const cssRow = (key) => String((folderRowOf(key) || {}).style?.cssText || "(нет строки)");
  const setOff = (on) => {
    const arr = st.readOutSlots();
    const s = arr.find((x) => x && x.kind === "card" && x.id === "m1");
    if (s) { if (on) s.off = true; else delete s.off; }
    st.writeOutSlots(arr);
    st.renderTree(); st.render();
  };
  check("v1.73.4: карточка-слот привязан (прибор в порядке)",
    !!st.outSlotOfEntry("m1"), JSON.stringify(st.outSlotOfEntry("m1")));
  // КРАСНОЕ до правки JS: метка строится только из папок-выводов.
  check("v1.73.4: точная папка карточки-слота «Видео» — зелёная ЭЛЕМЕНТ-метка",
    !!markOf("Видео"),
    cssRow("Видео").slice(0, 200) + " | children="
    + [...((folderRowOf("Видео") || {}).children || [])].length);
  check("v1.73.4: предок «SYSTEM PROMPT» без метки (точная папка, как §60.13)",
    !markOf("SYSTEM PROMPT"), cssRow("SYSTEM PROMPT").slice(0, 160));
  check("v1.73.4: соседняя «Другая» чиста",
    !markOf("Другая"), cssRow("Другая").slice(0, 160));
  // Выключенная карточка молчит (Python: off → "") — метки не получает.
  setOff(true);
  check("v1.73.4: карточка с off:true — метки НЕТ (не выводится)",
    !markOf("Видео"), cssRow("Видео").slice(0, 160));
  setOff(false);
  // КРАСНОЕ до правки JS: снятие off метку не возвращает (её и не было).
  check("v1.73.4: снятие off вернуло зелёную метку",
    !!markOf("Видео"), cssRow("Видео").slice(0, 160));
});

await run("v1.73.4: dblclick по строке карточки-слота в дереве — тоггл off", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.entries.push(mkSlotEntry("m3", "Музыка"));
  st.folders.push("Музыка");
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  st.selFolder = "__all";
  await st.plDrop({ kind: "entry", ids: ["m3"], id: "m3" }, "__outs");
  st.renderTree(); st.render();
  const slotRowOf = (needle) => st.tree.children.find((r) =>
    [...(r.children || [])]
      .some((c) => /^🔌\d+$/.test(String(c.textContent || "")) && ftext(r).includes(needle)));
  const rowCss = (row) => String(row && row.style ? row.style.cssText : "(нет строки)");
  const row = slotRowOf("m3");
  check("v1.73.4: строка карточки-слота в дереве отрисована", !!row,
    st.tree.children.map((r) => ftext(r)).join(" ; "));
  // КРАСНОЕ до правки JS: обработчика dblclick у строки слота нет вовсе.
  check("v1.73.4: у строки карточки-слота есть ondblclick",
    !!(row && typeof row.ondblclick === "function"),
    String(row && typeof row.ondblclick));
  if (row && row.ondblclick) await row.ondblclick({});
  const s1 = st.outSlotOfEntry("m3");
  // КРАСНОЕ до правки JS: без обработчика off не появился — карточка «всегда выводится».
  check("v1.73.4: dblclick поставил off (карточка молчит)",
    !!(s1 && s1.off === true), JSON.stringify(s1));
  const row2 = slotRowOf("m3");
  // КРАСНОЕ до правки JS: строки не перерисовались/не затемнились.
  check("v1.73.4: выключенная строка затемнена (color:#777)",
    !!row2 && rowCss(row2).includes("color:#777"), rowCss(row2).slice(0, 200));
  // Охранитель: у строки ПАПОЧНОГО слота dblclick не появляется.
  await st.plDrop({ kind: "folder", path: "Музыка" }, "__outs");
  st.renderTree(); st.render();
  const fRow = slotRowOf("Музыка");
  check("v1.73.4: у строки папки-слота НЕТ ondblclick (охранитель)",
    !!(fRow && typeof fRow.ondblclick !== "function"),
    String(fRow && typeof fRow.ondblclick));
  // Повторный dblclick включает обратно; строка перестаёт быть тёмной.
  const row3 = slotRowOf("m3");
  if (row3 && row3.ondblclick) await row3.ondblclick({});
  const s2 = st.outSlotOfEntry("m3");
  check("v1.73.4: повторный dblclick снял off",
    !!(s2 && !s2.off), JSON.stringify(s2));
  const row4 = slotRowOf("m3");
  check("v1.73.4: включённая строка снова НЕ затемнена",
    !!row4 && !rowCss(row4).includes("color:#777"), rowCss(row4).slice(0, 160));
});

// --- v1.73.5 (§64): яркая зелёная у одиночной карточки-слота в «Выходах» -----
// Отчёт пользователя: «яркая зелёная подсветка — это при двойном клике, а при
// одиночном — менее яркая; всегда как при одиночном клике». Контракт А
// (согласован): ярко-зелёный #2e6b4f/#7fe0a8 = карточка ВЫВОДИТСЯ (!off) —
// параллель активной карточки папки-вывода (active_id) и Python-контракта
// (включена ⇔ выводится); выключенная — тусклая, одиночный клик = выделение
// #1c3525 (яркость важнее выделения). Причина бага: isActive в makeOutCard
// требовал o.fs (:2732), слот-карточка (:3138) яркого цвета не достигала вовсе.
await run("v1.73.5: карточка-слот «Выходов» — яркая пока выводится, тусклая когда выключена", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  st.folders.push("Космос");
  st.entries.push(mkSlotEntry("c1", "Космос"));
  st.selFolder = "__outs";
  st.outsActiveFolder = null;
  st.renderTree(); st.render();
  await st.plDrop({ kind: "entry", ids: ["c1"], id: "c1" }, "__outs");
  st.renderTree(); st.render();

  const find = () => st.list.children.find((c) => ftext(c).includes("c1"));
  const css = (el) => String(el && el.style ? el.style.cssText : "(нет карточки)");
  const card0 = find();
  check("v1.73.5: карточка-слот c1 отображена в «Выходах»", !!card0,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  const slot0 = st.outSlotOfEntry("c1");
  check("v1.73.5: на старте карточка включена (off нет)", !!slot0 && !slot0.off,
    JSON.stringify(slot0));
  // КРАСНОЕ до правки JS: isActive требует o.fs — слот-карточка всегда тусклая.
  check("v1.73.5: включённая карточка-слот — ярко-зелёная (фон #2e6b4f)",
    !!card0 && css(card0).includes("background:#2e6b4f"), css(card0).slice(0, 160));
  // КРАСНОЕ до правки JS: рамка активной — #7fe0a8, у слот-карточки #333/#2e6b4f.
  check("v1.73.5: …и яркая рамка #7fe0a8",
    !!card0 && css(card0).includes("#7fe0a8"), css(card0).slice(0, 160));

  // Одиночный клик: яркость включённой важнее выделения — не гаснет.
  await card0.onclick({});
  const d1 = st.detailId;
  st.render();
  const card1 = find();
  check("v1.73.5: одиночный клик открыл панель (detailId=c1)",
    d1 === "c1", String(d1));
  // КРАСНОЕ до правки JS: после клика карточка уходит в isSel #1c3525.
  check("v1.73.5: клик по включённой НЕ гасит яркость (фон #2e6b4f)",
    !!card1 && css(card1).includes("background:#2e6b4f"), css(card1).slice(0, 160));

  // Двойной клик выключает (v1.73.4 toggleOff) → тусклая «менее яркая».
  if (card1 && card1.ondblclick) await card1.ondblclick({});
  const slot1 = st.outSlotOfEntry("c1");
  check("v1.73.5: dblclick выключил карточку (off=true)",
    !!(slot1 && slot1.off === true), JSON.stringify(slot1));
  const card2 = find();
  // Охранители (на старом коде зелёные): выключенная не яркая, селект-тёмная.
  check("v1.73.5: выключенная карточка НЕ ярко-зелёная (нет #2e6b4f)",
    !!card2 && !css(card2).includes("background:#2e6b4f"), css(card2).slice(0, 160));
  check("v1.73.5: …но выделение осталось — «менее яркая» #1c3525",
    !!card2 && css(card2).includes("background:#1c3525"), css(card2).slice(0, 160));

  // Повторный dblclick включает → снова яркая.
  if (card2 && card2.ondblclick) await card2.ondblclick({});
  const slot2 = st.outSlotOfEntry("c1");
  check("v1.73.5: повторный dblclick включил обратно (off снят)",
    !!(slot2 && !slot2.off), JSON.stringify(slot2));
  const card3 = find();
  // КРАСНОЕ до правки JS: включённая снова должна быть яркой.
  check("v1.73.5: включённая снова ярко-зелёная (фон #2e6b4f)",
    !!card3 && css(card3).includes("background:#2e6b4f"), css(card3).slice(0, 160));
});

// --- v1.73.6 (§65): яркая привязанная карточка в ПРОВОДНИКЕ ------------------
// Отчёт пользователя: карточка, подключённая к выходам, в проводнике «в
// независимости от активности всегда тускло-зелёная, а должна подсвечиваться
// ярко-зелёным, если активна» (активация — dblclick тогглит off, §63.2).
// Контракт А (§64.1, v1.73.5) распространён на обычный список галереи:
// ярко #2e6b4f/#7fe0a8 ⇔ !off; выключенная — тусклая #1c3525; яркость
// важнее выделения (одиночный клик не гасит).
await run("v1.73.6: проводник — привязанная карточка яркая пока активна, тусклая когда выключена", async () => {
  const node = mkSlotNode();
  const st = node._pl;
  addSlotEnv(node);
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "";
  st.detailId = null;
  st.folders.push("Новая");
  st.entries.push(mkSlotEntry("n1", "Новая"), mkSlotEntry("n2", "Новая"));
  st.selFolder = "__all";
  st.renderTree(); st.render();
  await st.plDrop({ kind: "entry", ids: ["n1"], id: "n1" }, "__outs");
  st.selFolder = "Новая";
  st.renderTree(); st.render();

  const find = (id) => st.list.children.find((c) => ftext(c).includes(id));
  const css = (el) => String(el && el.style ? el.style.cssText : "(нет карточки)");
  const slot0 = st.outSlotOfEntry("n1");
  check("v1.73.6: карточка n1 привязана и включена (прибор)", !!slot0 && !slot0.off,
    JSON.stringify(slot0));
  const card0 = find("n1");
  check("v1.73.6: карточка n1 отображена в проводнике", !!card0,
    st.list.children.map((c) => ftext(c)).join(" ; ") || "—");
  // КРАСНОЕ до правки JS: bg-цепочка галереи не знает про cardBright —
  // привязанная всегда идёт веткой outMark → тусклый #1c3525.
  check("v1.73.6: активная (включённая) привязанная карточка — ЯРКО-зелёная (фон #2e6b4f)",
    !!card0 && css(card0).includes("background:#2e6b4f"), css(card0).slice(0, 160));
  // КРАСНОЕ до правки JS: рамка у привязанной #2e6b4f, не #7fe0a8.
  check("v1.73.6: …и яркая рамка #7fe0a8",
    !!card0 && css(card0).includes("#7fe0a8"), css(card0).slice(0, 160));
  // Охранитель: непривязанная соседняя карточка НЕ яркая (фикс не должен
  // заливать всю галерею).
  const plain = find("n2");
  check("v1.73.6: непривязанная карточка n2 не яркая (нет #2e6b4f)",
    !!plain && !css(plain).includes("background:#2e6b4f"), css(plain).slice(0, 160));

  // Одиночный клик: яркость включённой важнее выделения — не гаснет.
  await card0.onclick({});
  const d1 = st.detailId;
  st.render();
  const card1 = find("n1");
  check("v1.73.6: одиночный клик открыл панель (detailId=n1)", d1 === "n1", String(d1));
  // КРАСНОЕ до правки JS: после клика карточка уходит в ветку outMark → #1c3525.
  check("v1.73.6: клик по активной НЕ гасит яркость (фон #2e6b4f)",
    !!card1 && css(card1).includes("background:#2e6b4f"), css(card1).slice(0, 160));

  // Двойной клик выключает (activateCard → toggleOff) → тусклая.
  if (card1 && card1.ondblclick) await card1.ondblclick({});
  const slot1 = st.outSlotOfEntry("n1");
  check("v1.73.6: dblclick выключил карточку (off=true)",
    !!(slot1 && slot1.off === true), JSON.stringify(slot1));
  const card2 = find("n1");
  // Охранители (зелёные и до, и после фикса): выключенная тусклая, без #2e6b4f.
  check("v1.73.6: выключенная карточка НЕ яркая (нет #2e6b4f)",
    !!card2 && !css(card2).includes("background:#2e6b4f"), css(card2).slice(0, 160));
  check("v1.73.6: …но привязка видна — тусклый #1c3525",
    !!card2 && css(card2).includes("background:#1c3525"), css(card2).slice(0, 160));

  // Повторный dblclick включает → снова яркая.
  if (card2 && card2.ondblclick) await card2.ondblclick({});
  const slot2 = st.outSlotOfEntry("n1");
  check("v1.73.6: повторный dblclick включил обратно (off снят)",
    !!(slot2 && !slot2.off), JSON.stringify(slot2));
  const card3 = find("n1");
  // КРАСНОЕ до правки JS: включённая снова обязана быть яркой.
  check("v1.73.6: активная снова ярко-зелёная (фон #2e6b4f)",
    !!card3 && css(card3).includes("background:#2e6b4f"), css(card3).slice(0, 160));
});

console.log("=== phases ok:", okCount, "| rAF left:", rafQueue.length);
if (errors.length) {
  console.log("=== ERRORS ===");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("=== SMOKE OK: canvas + vue + живая смена режима, ошибок нет ===");
