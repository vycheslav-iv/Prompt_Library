# Память сессии — Prompt Library (v1.66, 2026-10-05)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

Аудит архитектуры двух слоёв (превью отдельно, workflow отдельно) — нарушений нет.
Затем исправлен дефект импорта PNG: **импортировался не тот промпт, по которому
изображение сгенерировано**. Причина: чанк `prompt` (UI-граф → API-граф) — исполненный
слой, но при провале его разбора код падал на чанк `workflow` (холст), где виджет
устаревший; плюс обход не знал вход `value` примитивов, ветки свитчей, сквозные
`PreviewAny`/`Reroute` и уходил в узлы-генераторы LLM (тупик). Замер на 1138 PNG
пользователя: пустой промпт **161 → 4**, регрессий «текст → пусто» — 0.

## 2. Итоговое состояние кода

- `web/js/prompt_library.js:154` — `PL_JS_VERSION = "1.66-executed-prompt"`
- `web/js/prompt_library.js:3695` — `TEXT_KEY_RE` — текстовые входы: `text|prompt|string|value|content|positive|input` (+суффикс `_…`/цифра)
- `web/js/prompt_library.js:3699` — `GENERATOR_RE` (`generate|ollama|llm|chatgpt`) — узел-генератор = **тупик**
- `web/js/prompt_library.js:3702` — `ownTextOf(node)` — своё значение узла (direct-строка в текстовом входе, иначе `widgets_values[0]`)
- `web/js/prompt_library.js:3718` — `traceNode` — обход positive-цепочки: своё значение раньше провода, свитч = все ветки, `linkedAny.length===1` = сквозной узел, глубина 12
- `web/js/prompt_library.js:4060` — `if (!prompt && ui && !api)` — фолбэк на UI-граф **только** без чанка `prompt`
- `prompt_library_node.py` — не менялся (архитектура двух слоёв верна: `_attach_workflow` → `workflows/{id}.json`, `_save_preview_upload` → `previews/{id}.png` + чанк workflow, `library.json` — ссылки)
- `tests/_smoke_prompt_library.mjs` — +3 фазы v1.66 (примитив `value`; PreviewAny+свитчи, LLM-тупик; свитч сабграфа + `source`); красные ДО правки (3 ASSERT FAIL)
- `SPECIFICATION.md` — §54 (v1.66) + шапка версии

## 3. Проблемы, которые встречались (и как решали)

- **Промпт брался из UI-графа при живом чанке `prompt`** → в запись уходил устаревший виджет холста — фолбэк только при отсутствии чанка `prompt`
- **`PrimitiveString*` кладёт текст во вход `value`, а не `text`** → расширен список имён входов
- **Свитчи `on_false`/`on_true` не читались** (проверялись только `input_*`/`text*`) → пробуются все ветки
- **Обход уходил в `TextGenerate`/Ollama** → в запись попадал системный промпт → генератор = тупик
- **Дублировавшийся `return null; };`** давал SyntaxError `Unexpected token ';'` (строка 5069) → убран

## 4. Что важно не сломать при продолжении работы

- **Чанк `prompt` (API-граф) = исполненный слой, авторитетен.** Чанк `workflow` (UI-граф) — холст, виджет может быть **устаревшим**. Промпт — только из `prompt`
- Фолбэк на `promptFromWorkflow(ui)` — **только** когда чанка `prompt` нет вовсе
- Пустой промпт для media=image/video → `failed`, имя файла не подставлять (§49/§52.6)
- Архитектура двух слоёв: workflow **только** через `_attach_workflow` → `workflows/{id}.json`, никогда inline
- `jsonLoose` обязателен для чанка `prompt` (Python пишет bare `NaN`)
- `PL_JS_VERSION` обновлять при каждой правке JS-логики
- Тесты — только в `Prompt_Library/tests/`; `sync.py` их не копирует

## 5. Следующие шаги (идеи, не сделано)

- Живая приёмка: перезапуск ComfyUI + Ctrl+F5, импорт реального PNG (F12 → `JS 1.66-executed-prompt`)
- Проверить на файлах LTX/WAN-экспортов (видео-графы не покрыты замером)
- Знание вынесено в скил `comfyui-workflow-graph-parsing` (правило 6 + ловушки 9–11)

## 6. Связанные файлы

- `web/js/prompt_library.js` — `promptFromGraph` (:3670), `promptFromWorkflow` (:3824), `pngItemFromBuf` (:4030)
- `prompt_library_node.py` — `_attach_workflow` (~:127), `_save_preview_upload` (~:590), `_gen_meta` (~:1426), `POST /prompt_library/import` (~:2433)
- `SPECIFICATION.md` — §52 (v1.63–v1.64), §53 (v1.65), §54 (v1.66)
- `tests/_smoke_prompt_library.mjs`, `tests/_audit_prompt_library.mjs`, `tests/_test_prompt_library.py`
- `.agents/skills/comfyui-workflow-graph-parsing/SKILL.md` (дубли в `.kilo/`, `.opencode/`)
