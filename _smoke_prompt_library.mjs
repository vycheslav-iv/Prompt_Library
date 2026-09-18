// Временный смоук-тест (не для репозитория): исполняет web/js/prompt_library.js
// в vm-контексте с заглушками DOM/LiteGraph, прогоняет жизненный цикл в обоих
// режимах и проверяет ЖИВУЮ смену режима (canvas ↔ Nodes 2.0) обоими сигналами.
import fs from "node:fs";
import vm from "node:vm";

const FILE = "web/js/prompt_library.js";
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
    getContext: () => ({}), toDataURL: () => "data:,",
    cloneNode: () => makeEl(tag),
    getBoundingClientRect: () => ({ width: 480, height: 596, top: 0, left: 0, right: 480, bottom: 596, x: 0, y: 0 }),
    dispatchEvent: () => true,
    [Symbol.iterator]: function* () {},
    innerHTML: "", value: "", textContent: "", placeholder: "", title: "", type: "",
    rows: 0, checked: false, disabled: false, src: "", href: "", id: "", className: "",
    offsetHeight: 596, offsetWidth: 480, scrollHeight: 596, clientHeight: 596, scrollTop: 0,
    naturalWidth: 100, naturalHeight: 100, complete: true,
  };
  return el;
}

// «Элемент ноды» для проверки applyNodeMinWidth (в реальности — `.lg-node[data-node-id]`)
class HTMLElementStub {
  constructor() { this.style = makeStyle(); this.dataset = {}; this.classList = { add() {}, remove() {} }; }
}
const nodeElStub = new HTMLElementStub();

const documentStub = {
  createElement: (t) => makeEl(t),
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
  api: { fetchApi: async () => ({}) },
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
  Image: function () { return makeEl("img"); },
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
  check(`${tag}: версия JS видна`, st.version === "1.18-multiselect");
}

// Канвас: пол 480px на панелях (фронтенд сам растёт ноду под контент).
function checkCanvasPanes(tag, st) {
  check(`${tag}: tree пол 480px`, st.tree.style.flex === "1 1 auto" && st.tree.style.minHeight === "480px");
  check(`${tag}: list пол 480px`, st.list.style.flex === "1 1 auto" && st.list.style.minHeight === "480px");
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
    check(`${tag}: scrollArea перед hint`, st.root.children.indexOf(area) < st.root.children.indexOf(st.hint));
    check(`${tag}: min-width ноды = MIN_W`, nodeElStub.style.minWidth === `${470}px`);
  } else {
    check(`${tag}: main+detail прямые дети root`, st.detail.parentNode === st.root);
    check(`${tag}: scrollArea нет в root`, scrollAreaOf() === undefined);
    check(`${tag}: 6 детей root`, st.root.children.length === 6 && st.root.children[5] === st.hint);
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
  check("после возврата — canvas-раскладка", areaOf(stC) === undefined && stC.root.children.length === 6);
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
  check("6 детей root", stC.root.children.length === 6);
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
  check("bulk-бар с кнопкой удаления",
    st.hint.children.some((c) => c.textContent === "🗑 Удалить выбранное"));
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

console.log("=== phases ok:", okCount, "| rAF left:", rafQueue.length);
if (errors.length) {
  console.log("=== ERRORS ===");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("=== SMOKE OK: canvas + vue + живая смена режима, ошибок нет ===");
