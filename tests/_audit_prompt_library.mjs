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

console.log(`\n=== ${fail ? "НАЙДЕНО ПРОБЛЕМ: " + fail : "аудит чист"}`);
process.exit(fail ? 1 : 0);
