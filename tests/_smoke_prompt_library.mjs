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
  return el;
}

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
  createTextNode: () => makeEl("text"),
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
const fetchStub = async (u) =>
  String(u).includes("/prompt_library/list") ? jsonResponse({ entries: [], folders: [] }) : jsonResponse({});

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
  ];
  const node = {
    id: 1, pos: [0, 0], size: [470, 700], flags: {}, bgcolor: null, widgets,
    inputs: [{ name: "source", type: "*", link: null }, { name: "image", type: "IMAGE", link: null }],
    outputs: [
      { name: "category_out", type: "STRING", links: [] },
      { name: "prompt_out", type: "STRING", links: [] },
      { name: "out_2", type: "STRING", links: [] },
      { name: "out_3", type: "STRING", links: [] },
      { name: "out_4", type: "STRING", links: [] },
      { name: "out_5", type: "STRING", links: [] },
      { name: "out_6", type: "STRING", links: [] },
      { name: "out_7", type: "STRING", links: [] },
      { name: "out_8", type: "STRING", links: [] },
      { name: "out_9", type: "STRING", links: [] },
      { name: "out_10", type: "STRING", links: [] },
      { name: "out_11", type: "STRING", links: [] },
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
    removeOutput() {}, setSize(s) { node.size = s; }, setDirtyCanvas() {},
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
  check(`${tag}: версия JS видна`, st.version === "1.44-multi-output");
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
    check(`${tag}: 7 детей root (подхват + 6)`,
      st.root.children.length === 7 && st.root.children[6] === st.hintRow,
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
  check("после возврата — canvas-раскладка", areaOf(stC) === undefined && stC.root.children.length === 7);
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
  check("7 детей root", stC.root.children.length === 7);
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
  check("bulk-бар в нижней строке (hintRow)",
    st.hintRow && st.hintRow.children.some((c) => c.textContent === "🗑 Удалить"));
  check("метки: строка внизу фиксирована, счётчик сжимается, кнопки видны",
    String(st.hintRow.style.cssText).includes("height:22px")
    && String(st.hintRow.style.cssText).includes("flex-shrink:0")
    && String(st.bulkCount.style.cssText).includes("min-width:0")
    && String(st.bulkClear.style.cssText).includes("flex-shrink:0"));
  check("метки: hint скрыт, кнопки показаны",
    st.hint.style.display === "none" && st.bulkDel.style.display === "" && st.bulkCount.textContent === "Помечено — категорий: 3.");
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
    const btn = found.find((b) => b.textContent === "+ Категория");
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
// Одна умная кнопка «📤 Экспорт» в шапке проводника (рядом с «+ Категория»):
//   — при активных метках (Ctrl/Shift) → exportMarked() (отмеченные записи + категории),
//   — без меток → exportFolder(st.selFolder || "__all") (текущая категория, «Всё», «Избранное», «Без категории»).
// Отдельных кнопок 📤 на строках дерева и в bulk-баре НЕТ (были — шум, переработано).
// Прогресс-бар progTrack flex-резиновый (flex:1 1 0, height 12px), во время экспорта
// подсказка hint скрыта (бар занимает строку), после экспорта возвращается.
// Стаб запросов: /list отдаёт те же записи (иначе фоновый reload() из
// onNodeCreated сбросит st.entries в []), /entry — полные тексты, /preview —
// картинку.
let bulkExportPickerCalled = false;
const installFetchStub = (entries, fulls) => {
  sandbox.fetch = async (u) => {
    const url = String(u);
    if (url.includes("/prompt_library/list")) return jsonResponse({ entries, folders: [] });
    if (url.includes("/prompt_library/entry?id=")) {
      const id = decodeURIComponent(url.split("id=")[1] || "");
      return jsonResponse(fulls.get ? (fulls.get(id) || {}) : (fulls[id] || {}));
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
    check("v1.34: у строк дерева НЕТ кнопки 📤 (одна кнопка в шапке)",
      !Array.from(st.tree.children).some(rowHasEx));
    check("v1.34: в шапке проводника есть кнопка «📤 Экспорт»",
      !!st.exportBtn && st.exportBtn.textContent === "📤 Экспорт");
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

// Умная кнопка «📤 Экспорт» в шапке проводника: при активных метках
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
  // Нет bulk-кнопки в нижней строке (одна кнопка — в шапке)
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

// --- v1.44 (§40): мультивывод — привязки доп. выходов 2..11 ---------------
// bindOutSlot/unbindOutSlot/applyOutSockets/nextOutSlot/plDrop→__outs,
// папка-слот (active_id + маркер 🔌), рендер «🔌 Выходы», гидрация slots_out,
// предупреждение о полном списке и дубли.
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
  for (let i = 2; i <= 11; i++) node.outputs.push({ name: `out_${i}`, type: "STRING", links: [] });
  node.disconnectOutput = (i) => { if (node.outputs[i]) node.outputs[i].links = []; };
  node.addWidget("text", "slots_out", "", null, { hidden: true, hideInPanel: true, serialize: true });
  // Отключаем reload в тестах, чтобы не перезаписывать тестовые entries
  node._pl.reload = async () => {};
};

await run("slots: карточка → слот 2, сокет виден, имя обрезано, дубль игнор", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  addSlotEnv(node);
  // Режим "Выдача" — только в нём доступна категория "Выходы"
  const modeW = node.widgets.find((w) => w.name === "mode");
  modeW.value = "📤 Выдача";
  st.entries = [mkSlotEntry("e1", "", "abcdefghijklmnopqrstuvwxyz"), mkSlotEntry("e2")];
  st.selFolder = "__all";
  st.renderTree(); st.render();
  st.plDrop({ kind: "entry", ids: ["e1"], id: "e1" }, "__outs");
  const slots = st.readOutSlots();
  check("слот занял индекс 2 (card e1)",
    slots.length === 1 && slots[0].i === 2 && slots[0].kind === "card" && slots[0].id === "e1");
  check("сокет out_2 виден", node.outputs[2].hide === false);
  check("неиспользуемые сокеты скрыты", node.outputs[3].hide === true && node.outputs[11].hide === true);
  check("имя провода НЕ меняется (оставляем RETURN_NAMES), tooltip с подключением",
    node.outputs[2].name === "out_2" && node.outputs[2].title && node.outputs[2].title.includes("abcdefghijklmnop"),
    `name=${node.outputs[2].name}, title=${node.outputs[2].title}`);
  check("привязка записана в виджет", (() => { const w = node.widgets.find((x) => x.name === "slots_out"); return typeof w.value === "string" && JSON.parse(w.value).length === 1; })());
  st.plDrop({ kind: "entry", ids: ["e1"], id: "e1" }, "__outs");
  check("дубль той же карточки игнорируется", st.readOutSlots().length === 1);
  st.plDrop({ kind: "entry", ids: ["e2"], id: "e2" }, "__outs");
  check("следующая привязка → индекс 3 и сокет показан",
    st.readOutSlots().length === 2 && st.readOutSlots()[1].i === 3 && node.outputs[3].hide === false);
});

await run("slots: папка-слот — клик в дереве открывает карточки, выбор active_id", async () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  addSlotEnv(node);
  const modeW = node.widgets.find((w) => w.name === "mode");
  modeW.value = "📤 Выдача";
  st.entries = [mkSlotEntry("e10", "ПапкаA"), mkSlotEntry("e11", "ПапкаA")];
  st.folders = ["ПапкаA"];
  st.selWidget = node.widgets.find((w) => w.name === "selected");
  st.selWidget.value = "e11"; // активное выделение лежит в этой папке
  st.renderTree(); st.render();
  st.plDrop({ kind: "folder", path: "ПапкаA" }, "__outs");
  const slot = st.readOutSlots()[0];
  check("папка-слот: kind folder, active_id наследует выделение",
    slot && slot.kind === "folder" && slot.path === "ПапкаA" && slot.active_id === "e11");
  check("сокет out_2 виден", node.outputs[2].hide === false);
  // Клик по папке-слоту в дереве → открыть её карточки в категории "Выходы"
  const treeRows = st.tree.children;
  const folderSlotRow = treeRows.find((r) => r.children[0] && r.children[0].textContent === "🔌📁 ПапкаA");
  check("папка-слот видна в дереве (с иконкой 📁)", !!folderSlotRow);
  folderSlotRow.onclick({});
  check("переключилось на __outs и открыта папка ПапкаA", st.selFolder === "__outs" && st.outsActiveFolder === "ПапкаA");
  st.render();
  // В категории "Выходы" показаны карточки папки
  const cards = st.list.children.filter((c) => c.draggable === false && c.children[0] && (c.children[0].textContent === "🔌" || c.children[0].textContent === "📄"));
  check("показаны карточки папки ПапкаA", cards.length === 2, String(cards.length));
  // Карточка e11 активна (🔌, зелёная)
  const activeCard = cards.find((c) => c.children[0].textContent === "🔌");
  check("активная карточка e11 подсвечена (🔌 + зелёный фон)", !!activeCard && String(activeCard.style.cssText).includes("background:#1c3525"));
  // Клик по неактивной карточке e10 → становится активной
  const nonActive = cards.find((c) => c.children[0].textContent === "📄");
  check("есть неактивная карточка", !!nonActive);
  await nonActive.onclick({});
  check("клик переключил active_id на e10", st.outSlotOfFolder("ПапкаA").active_id === "e10");
  console.log("DEBUG outsActiveFolder after click:", st.outsActiveFolder);
  console.log("DEBUG slots:", st.readOutSlots());
  st.render();
  console.log("DEBUG list children after render:", st.list.children.length, st.list.children.map(c => c.draggable === false && c.children[0] ? c.children[0].textContent : null));
  const cards2 = st.list.children.filter((c) => c.draggable === false && c.children[0] && (c.children[0].textContent === "🔌" || c.children[0].textContent === "📄"));
  console.log("DEBUG cards2:", cards2.map(c => ({icon: c.children[0]?.textContent, bg: c.style.cssText})));
  const newActive = cards2.find((c) => c.children[0].textContent === "🔌");
  console.log("DEBUG newActive:", newActive ? {icon: newActive.children[0]?.textContent, bg: newActive.style.cssText} : null);
  check("теперь активна e10", !!newActive && String(newActive.style.cssText).includes("background:#1c3525"));
});

await run("slots: отвязка отключает провод и прячет сокет", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  addSlotEnv(node);
  st.entries = [mkSlotEntry("e1")];
  st.selFolder = "__all";
  st.bindOutSlot({ kind: "card", id: "e1", name: "e1" });
  node.outputs[2].links = [7]; // к выходу подключён провод
  st.unbindOutSlot(2);
  check("провод отключён", node.outputs[2].links.length === 0);
  check("сокет скрыт", node.outputs[2].hide === true);
  check("привязка удалена", st.readOutSlots().length === 0);
  check("виджет обновлён", JSON.parse(node.widgets.find((w) => w.name === "slots_out").value).length === 0);
});

await run("slots: рендер «🔌 Выходы» — строки слотов, битая привязка, отвязка ✖", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  addSlotEnv(node);
  const modeW = node.widgets.find((w) => w.name === "mode");
  modeW.value = "📤 Выдача";
  st.entries = [mkSlotEntry("e1")];
  st.selFolder = "__all";
  st.bindOutSlot({ kind: "card", id: "e1", name: "e1" });
  st.bindOutSlot({ kind: "card", id: "ghost", name: "ghost" }); // записи нет в базе
  st.selFolder = "__outs";
  st.render();
  const rows = st.list.children.filter((c) => String(c.style.cssText).includes("#2e6b4f"));
  check("отрисованы строки слотов", rows.length === 2, String(rows.length));
  check("первый слот — карточка e1", rows.some((r) => ftext(r).includes("T e1") || ftext(r).includes("e1")), ftext(rows[0]));
  const ghost = rows.find((r) => ftext(r).includes("(запись удалена)"));
  check("битая привязка показана как удалённая", !!ghost);
  check("мета битой привязки объясняет поведение",
    ghost && ftext(ghost).includes("записи нет"), ghost ? ftext(ghost) : "");
  const delB = ghost && ghost.children[2];
  check("кнопка ✖ найдена", delB && delB.textContent === "✖");
  delB.onclick({ stopPropagation() {} });
  check("✖ отвязала слот", st.outSlotOfEntry("ghost") === null && st.readOutSlots().length === 1);
  const rows2 = st.list.children.filter((c) => String(c.style.cssText).includes("#2e6b4f"));
  check("список перерисован без снятого слота", rows2.length === 1 && st.outSlotOfEntry("e1") !== null);
});

await run("slots: 10 занято — лишняя привязка предупреждает, дубль молчит", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  addSlotEnv(node);
  let toasts = [];
  st.toast = (...a) => { toasts.push(a); };
  st.entries = [];
  st.selFolder = "__all";
  for (let i = 2; i <= 11; i++) st.bindOutSlot({ kind: "card", id: `e${i}`, name: `x${i}`, i });
  check("заняты все 10 слотов 2..11", st.readOutSlots().length === 10 && st.nextOutSlot() === null);
  // Проверка режима: в режиме "Запись" bindOutSlot не должен вызываться через plDrop,
  // но напрямую он работает — проверяем логику дублей/лимитов
  st.bindOutSlot({ kind: "card", id: "e21", name: "e21" });
  check("11-я привязка предупреждает и не добавляется",
    toasts.length === 1 && String(toasts[0][2]).includes("Все 10") && st.readOutSlots().length === 10);
  st.bindOutSlot({ kind: "card", id: "e2", name: "x2", i: 2 });
  check("дубль при полном списке молчит (проверка до занятости)", toasts.length === 1);
  st.bindOutSlot({ kind: "folder", path: "Лишняя" });
  check("папка в полный список не проходит", st.readOutSlots().length === 10 && toasts.length === 2);
});

await run("slots: onConfigure восстанавливает привязки (named и позиция)", () => {
  const sv = JSON.stringify([{ i: 4, kind: "card", id: "e1", name: "Кайзер" }]);

  const n1 = makeNode();
  proto.onNodeCreated.call(n1);
  addSlotEnv(n1);
  proto.onConfigure.call(n1, {
    widgets_values: ["📥 Запись", "e1", "Фото", "", sv],
    widgets_values_named: { mode: "📥 Запись", selected: "e1", save_folder: "Фото", slots_out: sv },
  });
  n1._pl.applyOutSockets();
  const s1 = n1._pl;
  check("named: сокет out_4 показан после rAF", n1.outputs[4].hide === false, String(n1.outputs[4]?.hide));

  const n2 = makeNode();
  proto.onNodeCreated.call(n2);
  addSlotEnv(n2);
  proto.onConfigure.call(n2, { widgets_values: ["📥 Запись", "e1", "Фото", "", sv], widgets_values_named: {} });
  n2._pl.applyOutSockets();
  check("позиционный фолбэк widgets_values[4]",
    n2._pl.slotsOut.length === 1 && n2._pl.slotsOut[0].i === 4 && n2.outputs[4].hide === false, String(n2.outputs[4]?.hide));

  const n3 = makeNode();
  proto.onNodeCreated.call(n3);
  addSlotEnv(n3);
  proto.onConfigure.call(n3, { widgets_values: ["📥 Запись", "", ""], widgets_values_named: {} });
  n3._pl.applyOutSockets();
check("старый граф без slots_out: слотов нет, сокеты скрыты",
    n3._pl.slotsOut.length === 0 && n3.outputs[4].hide === true && n3.outputs[9].hide === true, String(n3.outputs[4]?.hide));
});

await run("slots: строка «🔌 Выходы» в дереве открывает режим слотов", () => {
  const node = makeNode();
  proto.onNodeCreated.call(node);
  const st = node._pl;
  addSlotEnv(node);
  const modeW = node.widgets.find((w) => w.name === "mode");
  modeW.value = "📤 Выдача";
  st.folders = ["Фото"];
  st.entries = [];
  st.renderTree(); st.render();
  const outsRow = st.tree.children[2];
  check("третья строка дерева — категория выходов",
    outsRow && outsRow.children[0] && outsRow.children[0].textContent === "🔌 Выходы");
  outsRow.onclick({});
  check("клик переключил selFolder на __outs", st.selFolder === "__outs");
  check("save_folder виджет получил __outs",
    node.widgets.find((w) => w.name === "save_folder").value === "__outs");
  st.bindOutSlot({ kind: "card", id: "zz", name: "zz" }); // записи нет в базе
  st.render();
  const rows = st.list.children.filter((c) => String(c.style.cssText).includes("#2e6b4f"));
  check("слот виден в категории выходов (битая запись)", rows.length === 1 && ftext(rows[0]).includes("(запись удалена)"));
  check("сокет out_2 после всего жив", node.outputs[2].hide === false);
});

console.log("=== phases ok:", okCount, "| rAF left:", rafQueue.length);
if (errors.length) {
  console.log("=== ERRORS ===");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("=== SMOKE OK: canvas + vue + живая смена режима, ошибок нет ===");
