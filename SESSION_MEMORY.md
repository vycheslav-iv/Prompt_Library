# Память сессии — Prompt Library (v1.32, 2026-09-20)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

**Аудит v1.31 по просьбе пользователя («это костыль или настоящий фикс?»).**
Вердикт: страж `unstickWidth` был **маской**, а диагноз §37 («писателя нет,
значение — ископаемое») — **ошибочным**. Настоящий писатель найден живым
аудитом: **панель свойств** рендерит виджеты узла через `WidgetLegacy.vue`
(для неизвестного типа `custom` нет компонента в реестре), а тот пишет
`widgetInstance.width = ширина панели` прямо в живой объект виджета.
Корень закрыт в **v1.32**: `options.hideInPanel = true` — панель наши виджеты
больше не рендерит. Проверено живьём в канвасе и Vue: `hits: 0`.

## 2. Итоговое состояние кода

- `web/js/prompt_library.js` (2416 строк), `PL_JS_VERSION = "1.32-hide-in-panel"`:
  `browserWidget.options.hideInPanel = true` (~:2210) + тот же флаг у технических
  `selected`/`save_folder`/`pickup` (~:134); `st.unstickWidth` оставлен
  страховкой (создание ~:2216, `onResize` ~:2119, `onDrawForeground` ~:2362)
- `prompt_library_node.py` — без изменений (1303 строки)
- `check.json` — проверки для единого чекера папки: **`python _process/check.py Prompt_Library`**
  (запускать из корня бандла; зелёное = Python + смоук + аудит)
- `tests/`: Python **244**, смоук **74** (новая фаза «v1.32»: hideInPanel у
  `pl_browser` и трёх технических полей; фаза «v1.31» про страж на месте),
  аудит чист (+2 статические проверки: hideInPanel и страж на месте)
- `tests/_probe_live_dom.py` — новый флаг **`--audit-writer`** (§37.9):
  канвас/Vue, выделение ноды через `canvas.selectNodes`, страж отключается,
  ловушка на `widget.width`, надёжное открытие панели через настройку
  `Comfy.RightSidePanel.IsOpen`, вывод `hits`/`lastHits[].stack`/`panelWidgetRows`/
  `panelMirrors`/`wrapperW`. Старый `--trap` теперь сам выделяет ноду и больше
  не делает ложного вывода «писателя нет»
- `SPECIFICATION.md` — **v1.32**: §37 переписан целиком (§37.1 симптом, §37.2
  механизм с точными замерами, §37.3 почему виджет попадал в панель, §37.4
  лечение, §37.5–§37.6 проверки, §37.7 почему v1.31 не была фиксом, §37.8 след
  для другого ИИ, §37.9 методика `--audit-writer`); плюс шапка, §14, §15 (пп.24–25),
  §17, §34.2

## 3. Ключевые факты (чтобы не расследовать заново)

- Формула оверлея: `DomWidgets.vue → updateWidgets()` (каждый кадр, на
  `canvas.onDrawForeground`) → `widgetState.size = [(widget.width ?? posNode.width) - margin*2, …]`.
- Писатель: `WidgetItem.vue` (панель) → `getComponent(widget.type) || WidgetLegacy`
  → `WidgetLegacy.vue draw()` → `widgetInstance.width = canvasEl.parentElement.clientWidth`
  (плюс тот же `draw` из `ResizeObserver`). `widgetInstance` — живой виджет ноды.
- Замеры: 262 → 235 при ноде 1000 → обёртка 215; у пользователя 213 при ноде 1137
  → 193. Совпадение точное (margin = 10).
- Панель фильтрует виджеты по `options.canvasOnly | hidden | hideInPanel | advanced`
  (`rightSidePanel/shared.ts → computedSectionDataList`). `widget.hidden` панель НЕ читает.
- `hideInPanel` читают ТОЛЬКО панельные компоненты; `canvasOnly` не используем —
  его читает `shouldRenderAsVue` (сломало бы рендер в Nodes 2.0).

## 4. Что важно не сломать при продолжении работы

- **Не возвращать диагноз «писателя нет»** — он опровергнут живой ловушкой (§37.7).
- **`hideInPanel` у `pl_browser` не убирать** — иначе панель снова зажмёт контент.
- **`st.unstickWidth` не удалять** — лечит вкладки, заражённые до v1.32.
- **Ловушку/аудит запускать по правилам §37.9**: нода через `canvas.selectNodes`,
  страж отключён, проверять, что панель реально отрисовала виджеты
  (`panelWidgetRows`/`panelMirrors`); в канвас-режиме `[data-node-id]` не существует.
- Закреп ТОЛЬКО в папке (`selFolder` без `__`); `IS_CHANGED` не убирать (подхват, §33);
  классы-якоря `pl-root`/`pl-main`/`pl-scroll`; порядок INPUT_TYPES
  `[mode, selected, save_folder, pickup]`; пол — только в `computeLayoutSize`;
  база под `_DB_LOCK`; тесты только в `tests/`; после правки — `python sync.py Prompt_Library`.
- Перед отчётом о готовности — `python _process/check.py Prompt_Library` (из корня бандла;
  процесс папки целиком — `_process/PROCESS.md`).

## 5. Следующие шаги (идеи, не сделано)

1. **[живая проверка у пользователя]** рестарт ComfyUI + Ctrl+F5, маркер
   `1.32-hide-in-panel`: панель открыть/закрыть, ресайз — контент на месте;
   в панели свойств остаётся только «Режим».
2. Живые проверки v1.28 (подхват ×3 Queue), v1.29 (название), v1.30 (закреп).
3. §25.3 п.1 — воркфлоу inline в `library.json`; п.3 — сироты превью.
4. Бюджет высоты панели книги в правке — только живая проверка.
5. Коммит правок v1.32 (сейчас не закоммичено: 5 файлов + снапшот памяти).

## 6. Связанные файлы

- `web/js/prompt_library.js` — расширение (маркер `1.32-hide-in-panel`)
- `prompt_library_node.py` — нода и все роуты (`/pin`, `/attach_preview`, `/save_pickup`)
- `tests/_test_prompt_library.py`, `tests/_smoke_prompt_library.mjs`, `tests/_audit_prompt_library.mjs`
- `tests/_probe_live_dom.py` (`--audit-writer` — аудит писателя, §37.9),
  `tests/_probe_snippet.js` (v2: `overlay` + `wrapper`)
- `SPECIFICATION.md` (§34–§37), `README.md`
- `SESSION_MEMORY-history/2026-09-20.md` — снапшот прошлой памяти (с неверным диагнозом)
- скилы: `comfyui-frontend-sources` (обязателен перед sizing/layout), `comfyui-dom-widget-sizing`,
  `comfyui-node-testing`, `comfyui-deferred-capture`
- `sync.py` — в корне бандла `F:\AI_projects\Custom_node_ComfyUI\`

## 7. Коммиты

| Коммит | Что |
|---|---|
| (пока не закоммичено) | v1.32: корень зажатия — `hideInPanel` + аудит писателя |
| `5628fc8` | память: v1.31 |
| `db6e8fb` | `fix: панель свойств не зажимает контент — страж unstickWidth (v1.31)` |
