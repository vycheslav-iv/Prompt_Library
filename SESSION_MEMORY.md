# Память сессии — Prompt Library (v1.67, 2026-10-05)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

Сначала исправили v1.66 (импорт PNG — обход positive-цепочки: `value`-входы
примитивов, свитчи, сквозные `PreviewAny`/`Reroute`, узлы-генераторы как тупик;
пустой промпт 161 → 4). **Пользователь проверил живьём и нашёл, что промпт всё
равно чужой** (`Krea2_Raw_00696_.png`: импортировался «Земля с низкой орбиты»,
а картинка — газовый гигант). Причина найдена замером и исправлена в v1.67.

## 2. Итоговое состояние кода

- `web/js/prompt_library.js:154` — `PL_JS_VERSION = "1.67-executed-keeper"`
- `web/js/prompt_library.js:3670` — `st.promptFromGraph(graph, ui)` — второй аргумент UI-граф
- `web/js/prompt_library.js:3724` — `KEEPER_RE` / `keeperRuntimeText()` / `hasSourceWire()` — фактический выход подхвата берётся из UI-графа
- `web/js/prompt_library.js:3763` — keeper-правило в `traceNode` (до «своё значение раньше провода»)
- `web/js/prompt_library.js:3859` — `st.promptFromWorkflow(ui)`: у `keeper` с проводом `source` сначала `widgets_values[0]` (факт), потом `widgets_values_named.text` (предпрогон)
- `web/js/prompt_library.js:4098` — `pngItemFromBuf` передаёт `ui` в `promptFromGraph`
- `prompt_library_node.py` — не менялся
- `tests/_smoke_prompt_library.mjs` — +3 фазы v1.67 (красные ДО правки: 1 ASSERT FAIL), всего 129 фаз
- `SPECIFICATION.md` — §54 (v1.66) + **пометка, что §54 ошибочна для узлов-подхватов**, §55 (v1.67)

## 3. Проблемы, которые встречались (и как решали)

- **v1.66 ошибочно объявила чанк `prompt` авторитетным для промпта.** `PromptKeeper.process()` (`prompt_keeper_node.py:34`) при прогоне пишет в свой `widgets_values[0]` ФАКТИЧЕСКИЙ выход, а чанк `prompt` снят на постановке в очередь → хранит значение ПРОШЛОГО прогона. Для узлов-подхватов правда в UI-графе
- Признак «узел писал в себя»: `widgets_values[0]` ≠ `widgets_values_named.text` в UI-графе
- `sed`/inherеdoc с обратными слэшами ломаются в этом окружении — писать скрипты файлом через `write_file`

## 4. Что важно не сломать при продолжении работы

- **Узел-«подхват» (`PromptKeeper`) с подключённым `source`: промпт — из UI-графа** (`widgets_values[0]`), НЕ из чанка `prompt`. Иначе импортируется промпт прошлого прогона
- Остальные узлы — как в §54: `prompt` (API-граф) авторитетен; фолбэк на UI-граф только без чанка `prompt`
- Пустой промпт для media=image/video → `failed`, имя файла не подставлять
- Архитектура двух слоёв: workflow только через `_attach_workflow` → `workflows/{id}.json`
- `jsonLoose` обязателен для чанка `prompt` (Python пишет bare `NaN`)
- `PL_JS_VERSION` обновлять при каждой правке JS-логики
- Тесты — только в `Prompt_Library/tests/`; `sync.py` их не копирует

## 5. Следующие шаги (идеи, не сделано)

- Живая приёмка после перезапуска: импорт `Космос/Планеты/Krea2_Raw_00696_.png` должен дать газовый гигант
- Прочие узлы, пишущие в себя (`extra_pnginfo`), пока не найдены — если встретится, правило обобщается
- Знание вынесено в скил `comfyui-workflow-graph-parsing` (правило 6 переписано + ловушка 12)

## 6. Связанные файлы

- `web/js/prompt_library.js` — `promptFromGraph` (:3670), `promptFromWorkflow` (:3859), `pngItemFromBuf` (:4077)
- `../Prompt_Keeper/prompt_keeper_node.py` — `process()`: `if source is not None: text = str(source)` и запись в `widgets_values`
- `SPECIFICATION.md` — §54 (v1.66, с пометкой об ошибке), §55 (v1.67)
- `tests/_smoke_prompt_library.mjs`, `tests/_audit_prompt_library.mjs`, `tests/_test_prompt_library.py`
- `.agents/skills/comfyui-workflow-graph-parsing/SKILL.md` (дубли в `.kilo/`, `.opencode/`)
