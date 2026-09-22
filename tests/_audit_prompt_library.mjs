// Аудит связности Prompt_Library: st.* (использование vs определение),
// мёртвые остатки удалённых подходов, сверка HTTP-роутов JS ↔ Python.
// Запуск: cd Prompt_Library && node tests/_audit_prompt_library.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Пути от самого теста (tests/ → .. = папка проекта), а не от cwd
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const JS = path.join(ROOT, "web", "js", "prompt_library.js");
const PY = path.join(ROOT, "prompt_library_node.py");
const jsRaw = fs.readFileSync(JS, "utf8");
const py = fs.readFileSync(PY, "utf8");
// Без комментариев: упоминания удалённых механизмов в пояснениях — не ошибка
const js = jsRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

let fail = 0;
const bad = (m) => { fail++; console.log("  ✗ " + m); };
const ok = (m) => console.log("  ✓ " + m);

// --- A. st.* : использование vs определение ---------------------------------
const refs = new Set();
const defs = new Set();
for (const m of js.matchAll(/\bst\.([A-Za-z_$][\w$]*)/g)) refs.add(m[1]);
for (const m of js.matchAll(/\bst\.([A-Za-z_$][\w$]*)\s*=/g)) defs.add(m[1]);
// литерал `const st = { a, b, c: ..., };` — тоже определения
const lit = js.match(/\bconst st = \{([\s\S]*?)\n\s*\};/);
if (lit) {
  for (const m of lit[1].matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*(?=[:,}\n])/g)) defs.add(m[1]);
}
// вызовы в других нодах: this._pl.foo (проверяются отдельно ниже)
const plRefs = new Set();
for (const m of js.matchAll(/this\._pl\??\.([A-Za-z_$][\w$]*)/g)) plRefs.add(m[1]);

console.log("A. st.* связность");
const undef = [...refs].filter((r) => !defs.has(r)).sort();
if (undef.length) bad(`st.* используется, но не определено: ${undef.join(", ")}`);
else ok(`все ${refs.size} обращений к st.* имеют определение`);

const plUndef = [...plRefs].filter((r) => !refs.has(r) && !defs.has(r)).sort();
if (plUndef.length) bad(`this._pl.* без определения: ${plUndef.join(", ")}`);
else ok(`this._pl.* (${plRefs.size} шт.) определены`);

// --- B. мёртвые остатки удалённых подходов ---------------------------------
console.log("B. мёртвые остатки");
const dead = ["autoFitHeight", "calibrateFloor", "_vueFloor", "_chromeMin", "_fitLast",
              "VUE_PANES_MIN", "fitNode"];
const stale = [];
for (const name of dead) {
  const n = js.split(name).length - 1;
  if (n > 0) stale.push(`${name}×${n}`);
}
if (stale.length) bad(`остатки удалённого: ${stale.join(", ")}`);
else ok("нет ссылок на удалённые механизмы (autoFit/fitNode/calibrateFloor/VUE_PANES_MIN)");
if (!/st\.dropAutoSockets\s*=/.test(js)) bad("dropAutoSockets не определён (нода не создастся)");
else ok("dropAutoSockets определён");

// Панель свойств не должна рендерить виджеты ноды (v1.32, §37): для типа `custom`
// подходящего компонента в реестре нет, панель монтирует WidgetLegacy, а тот
// пишет widget.width = ширину панели — DomWidgets.vue предпочитает widget.width
// живой ширине ноды, и контент зажимается навсегда.
if (!/browserWidget\.options\.hideInPanel\s*=\s*true/.test(js)) {
  bad("pl_browser без options.hideInPanel — панель свойств зажмёт контент (§37)");
} else ok("pl_browser скрыт из панели свойств (hideInPanel)");
if (!/st\.unstickWidth\s*=\s*\(\)\s*=>/.test(js)) bad("страж unstickWidth удалён (§37)");
else ok("страж unstickWidth на месте (страховка от заражённых сессий)");

// виджет prompt удалён из INPUT_TYPES — в JS его быть не должно
if (/\bname === "prompt"|widgets_values\[3\]/.test(js)) bad("JS ещё ожидает виджет prompt (удалён в v1.7)");
else ok("нет ожиданий удалённого виджета prompt");

// --- C. сверка роутов JS ↔ Python ------------------------------------------
console.log("C. HTTP-роуты JS ↔ Python");
const pyRoutes = new Set([...py.matchAll(/@routes\.(get|post)\("(\/prompt_library\/[^"]+)"/g)].map((m) => m[2]));
const jsCalls = new Set([...js.matchAll(/["'`](\/prompt_library\/[a-z_]+)/g)].map((m) => m[1]));
const missingPy = [...jsCalls].filter((r) => !pyRoutes.has(r));
const unusedPy = [...pyRoutes].filter((r) => !jsCalls.has(r));
console.log(`     python: ${[...pyRoutes].sort().join(", ")}`);
if (missingPy.length) bad(`JS зовёт роуты, которых нет в Python: ${missingPy.join(", ")}`);
else ok(`все ${jsCalls.size} роутов, вызываемых из JS, есть в Python`);
// unusedPy — не ошибка (роуты могут вызываться не из JS); печатаем информативно
if (unusedPy.length) console.log(`     (info) не вызываются из JS: ${unusedPy.join(", ")}`);

// --- D. Python: быстрые структурные проверки --------------------------------
console.log("D. Python");
const required = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "OUTPUT_NODE = True",
                  "WEB_DIRECTORY", '"hidden"', "extra_pnginfo", "unique_id"];
for (const r of required) {
  if (!py.includes(r) && !fs.readFileSync(path.join(ROOT, "__init__.py"), "utf8").includes(r)) bad(`нет ${r}`);
}
ok("обязательные атрибуты ноды на месте");
// все INPUT_TYPES-виджеты должны иметь записи в локали
const locale = JSON.parse(fs.readFileSync(path.join(ROOT, "locales/ru/nodeDefs.json"), "utf8")).PromptLibrary.inputs;
const inputBlock = py.match(/"required": \{([\s\S]*?)\s{12}\},\s*"optional"/);
const widgetNames = inputBlock
  ? [...inputBlock[1].matchAll(/^\s*"?(\w+)"?: \(/gm)].map((m) => m[1])
  : [];
const noLocale = widgetNames.filter((w) => !locale[w]);
if (!widgetNames.length) bad("не удалось разобрать INPUT_TYPES.required");
else if (noLocale.length) bad(`виджеты без локали: ${noLocale.join(", ")}`);
else ok(`локали покрывают виджеты: ${widgetNames.join(", ")}`);

// порядок positional widgets_values (JS restore ↔ Python PNG-патч)
const pyOrder = py.match(/node_data\["widgets_values"\] = \[([^\]]+)\]/);
const jsOrder = js.match(/widgets_values\[2\]/);
const want = widgetNames.join(", ");
if (!pyOrder) bad("не найден PNG-патч widgets_values");
else ok(`PNG-патч пишет позиционно: [${pyOrder[1].trim()}] (INPUT_TYPES: ${want})`);
if (!jsOrder) bad("JS не читает позиционный фолбэк widgets_values[2] (restore save_folder)");
else ok("JS restore читает позиционный индекс 2 (save_folder)");

// RETURN_NAMES ↔ outputs локали
const retNames = py.match(/RETURN_NAMES = \(([^)]+)\)/);
const outLocale = JSON.parse(fs.readFileSync(path.join(ROOT, "locales/ru/nodeDefs.json"), "utf8")).PromptLibrary.outputs;
const outCount = retNames ? retNames[1].split(",").filter((s) => s.trim()).length : 0;
const locCount = Object.keys(outLocale || {}).length;
if (outCount !== locCount) bad(`выходов ${outCount}, а в локали ${locCount}`);
else ok(`выходы и локаль совпадают (${outCount})`);

// --- E. мультивывод (§40): сокеты, порядок и имена выходов -------------------
console.log("E. Мультивывод (§40)");
// `o.hide` у слотов в этом фронтенде НЕ работает: NodeSlots.vue рисует все
// nodeData.outputs, поля hide у слотов нет. Прежний код ставил o.hide = true и
// на живой ноде были видны все 12 сокетов — возврат к этому приёму = регресс.
if (/\.hide\s*=\s*(true|false)/.test(js)) {
  bad("сокеты снова «прячутся» через o.hide — в этом фронтенде свойство не работает (§40)");
} else ok("сокеты доп. выходов не «прячутся» через o.hide (свойство не поддерживается)");

if (!/this\.removeOutput\(/.test(js) || !/this\.addOutput\(/.test(js)) {
  bad("нет динамических addOutput/removeOutput — выходы не появятся по требованию (§40)");
} else ok("выходы создаются/убираются динамически (addOutput/removeOutput)");

// Возврат execute ↔ RETURN_NAMES ↔ имена в UI: на этом стоял баг v1.44 —
// в локали сокет 0 звался «промпт», а ехала по нему дорога категории.
// Порядок с v1.45.1: 0 — путь категории, 1 — основной текст (решение
// пользователя), поэтому сверка зеркальная прежней.
const tuple = py.match(/"result":\s*\(([^\n]*)\)/);
if (!tuple) {
  bad("не найден возврат result в execute (§40)");
} else {
  // Первый элемент — обязательно путь категории, а второй — НЕ он.
  const parts = tuple[1].split(",").map((s) => s.trim());
  if (!/_sanitize_folder_path\(folder\)/.test(parts[0] || "")) {
    bad(`порядок выходов не совпадает с RETURN_NAMES (первым ждали путь): ${tuple[1].trim()}`);
  } else if (/_sanitize_folder_path/.test(parts[1] || "")) {
    bad(`путь категории отдаётся дважды/вторым — подсказка «промпт 1 (основной)» соврала бы: ${parts[1]}`);
  } else ok("выход 0 — путь категории, выход 1 — текст промпта");
}

const outNames = Object.fromEntries(Object.entries(outLocale || {}).map(([k, v]) => [k, (v && v.name) || ""]));
if (!/путь|категор/i.test(outNames[0] || "") || !/промпт/i.test(outNames[1] || "")) {
  bad(`имена выходов 0/1 в локали не совпадают с порядком: «${outNames[0]}» / «${outNames[1]}»`);
} else ok(`локаль выходов согласована с порядком («${outNames[0]}» / «${outNames[1]}»)`);

// Номера доп. выходов в UI должны совпадать с их индексами (номер провода =
// место в списке «🔌 Выходы») — иначе пользователь не поймёт, что куда идёт.
const badNum = Object.entries(outNames).slice(2).filter(([k, v]) => !String(v).includes(String(k)));
if (badNum.length) bad(`номер в имени доп. выхода ≠ индексу: ${JSON.stringify(badNum)}`);
else ok("имена доп. выходов несут свой индекс («промпт N» ↔ выход N)");

console.log(`\n=== ${fail ? "НАЙДЕНО ПРОБЛЕМ: " + fail : "аудит чист"}`);
process.exit(fail ? 1 : 0);
