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
  ];
  const node = {
    id: 1, pos: [0, 0], size: [470, 700], flags: {}, bgcolor: null, widgets,
    inputs: [{ name: "source", type: "*", link: null }, { name: "image", type: "IMAGE", link: null }],
    outputs: [{ name: "CLIP", type: "CLIP", links: [] }, { name: "STRING", type: "STRING", links: [] }],
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
  check(`${tag}: версия JS видна`, st.version === "1.31-unstick-width");
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
    await st.onSearch();
    check("v1.27: поиск спросил сервер один раз", calls.length === 1 && calls[0].includes("q="), JSON.stringify(calls));
    check("v1.27: id из глубины текста пришли в st.deepIds", st.deepIds && st.deepIds.has("deep1"));
    check("v1.27: карточка из глубины текста показана вместе с локальными",
      st.list.children.length === 2, String(st.list.children.length));

    // Запрос без совпадений: ни локально, ни на сервере
    serverIds = [];
    st.search.value = "ничегонесовпадает";
    await st.onSearch();
    check("v1.27: нет совпадений — список пуст", st.list.children.length === 0,
      String(st.list.children.length));

    st.search.value = "";
    await st.onSearch();
    check("v1.27: пустой запрос — серверный поиск сброшен, видны все",
      st.deepIds === null && st.list.children.length === 2, String(st.list.children.length));
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

console.log("=== phases ok:", okCount, "| rAF left:", rafQueue.length);
if (errors.length) {
  console.log("=== ERRORS ===");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("=== SMOKE OK: canvas + vue + живая смена режима, ошибок нет ===");
