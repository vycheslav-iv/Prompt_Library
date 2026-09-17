# Память сессии — Prompt Library (2026-09-17, Vue-фит НЕ работает, handoff)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.10 запушен (`3218c46`): воркфлоу в карточке, drag на канвас, lazy-превью.
- Дальше — Vue-режим (Nodes 2.0): нода не примыкает к контенту. Было 5+ итераций
  (flex, фикс, retry, hug, auto-fit) — живьём не заработало. Пользователь остановил
  работу и передал задачу другой модели. Закоммичено как есть (безвредно).

## 2. Итоговое состояние кода

- Канвас-режим: работает полностью (stretch, restore, drag, превью) — не трогать.
- Vue-режим: панели 480 + скролл работают; min-width 470 держится (через
  `[data-node-id]`); высота НЕ примыкает — открытая проблема.
- `web/js/prompt_library.js`: `autoFitHeight` (не работает — см. §3),
  `applyPaneLayout`, `isVueNodes` (через `extensionManager.setting`), калибровка
  `_vueFloor` (безвредна). Телеметрии нет (удалена).
- `SPECIFICATION.md`: §22.6–22.8 — вся история Vue-попыток + факты + изъян.

## 3. Главная проблема (для следующего агента — читать обязательно)

- Факты (из исходников, достоверно): `node.size` — Proxy → запись коммитит в
  layout store; `isSizeEqual` — сходимость; `measureMinContentHeight` меряет
  минимум по контенту; min-width = инлайн или 225; детект Vue — только через
  `app.extensionManager.setting.get('Comfy.VueNodes.Enabled')`.
- Изъян auto-fit: `chromeMin` самоблокируется (`chrome = tall − content`
  включает surplus → target = current → вечный deadband). Chrome нельзя выводить
  из высокой ноды — нужен независимый замер рамки (шапка напрямую) или константа.
- Не повторять: слепые итерации без фактов; мутирующие пробы в живом сетапе;
  polling/retry в layout-путях; выводы по телеметрии без проверки присвоения.

## 4. Что важно не сломать при продолжении работы

- Канвас stretch (§22.3) — проверен живьём, работает. Любые Vue-правки не должны
  его задевать (ветвление через `st._vuePanes`).
- Порядок INPUT_TYPES `[mode, selected, save_folder]`; `serialize=false` свойством;
  тяжёлое — никогда в `/list`; префикс `__` зарезервирован; ноль `setTimeout` в restore.

## 5. Следующие шаги (идеи, не сделано)

1. **Vue auto-fit**: независимый замер chrome (шапка ноды) + shrink через прокси
   `node.size`. Текущий `autoFitHeight` — заготовка с изъяном, переписать таргет.
2. **SPLIT на две ноды**: Prompt Library + Prompt Saver.
3. **Постраничность** (~20 записей) + разгрузка хранения перед поднятием лимита 500.

## 6. Связанные файлы

- `prompt_library.js` / `prompt_library_node.py` — код ноды.
- `SPECIFICATION.md` v1.10+ (§22 Vue-история, §23 restore, §24 workflow).
- `comfyui-dom-widget-sizing`, `comfyui-js-extension` (+ `.kilo`, `.agents` копии).
- `SESSION_MEMORY-history/2026-09-17*.md` — снапшоты.
