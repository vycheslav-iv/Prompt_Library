# Память сессии — Prompt Library (2026-09-17, vertical stretch via computeLayoutSize)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.7 запушен (`b297b47` + docs `6d3d122`): prompt удалён, toggle input, layout stable
- **Vertical stretch**: корень найден в исходниках фронтенда (`_arrangeWidgets`:
  legacy `computeSize` = точная высота, `computeLayoutSize` = минимум + всё
  свободное место через `distributeSpace`). Это НЕ повтор §21 — читаем только
  boolean-стейт, не размеры DOM
- `browserWidget.computeSize` → `computeLayoutSize` (+ починен пропуск INPUT_H)
- CSS: `root height:100%` → `main flex:1` → `listContent`/`tree` flex:1 + min-height:480px
- `node --check` OK, синхронизировано в рабочую копию через `sync.py`
- SPEC §22 написан. НЕ коммичено, НЕ проверено живьём — нужен рестарт ComfyUI + drag-тест
- **Аудит нашёл баг v1.7**: `widgets_values = [..., prompt]` с неопределённым
  `prompt` → NameError глушился except'ом → персистентность была мертва.
  Исправлено на `[mode, selected, save_folder]`, headless-тест PASSED, synced
- **Папка не восстанавливалась**: save пишется (в файле `Fs/FAS` есть), restore
  в `onConfigure` срабатывал раньше store hydration → retry `restoreFolder`
  (5×400мс, только пока selFolder нетронут). Мигание «Всё→папка» — неустранимо
  при любом подходе (первый рендер всегда до значений)
- **Скилл `comfyui-dom-widget-sizing` обновлён** (все 3 копии): раздел про
  `computeSize` vs `computeLayoutSize` + паттерн вертикального stretch +
  `widget.serialize=false` свойством

## 2. Итоговое состояние кода

- `prompt_library_node.py:180-186` — `INPUT_TYPES`: mode → source → image (prompt удалён)
- `prompt_library_node.py:207-226` — `execute()`: source-only (prompt parameter удалён)
- `prompt_library.js:79-123` — toggle input: `➕ Добавить промпт` + textarea + save
- `prompt_library.js:724-725` — `DETAIL_H=280`, `BASE_H=596`
- `prompt_library.js:114` — `listContent`: `height:480px`
- `prompt_library.js:102` — `tree`: `height:480px`

## 3. Что важно не сломать

- `computeSize`: `BASE_H=596`, `DETAIL_H=280`, `INPUT_H=130` (фиксированные константы)
- `listContent`/`tree` = 480px (два ряда больших карточек)
- `ensureIssueSafe()` возвращает `true`/`false` — не терять этот контракт
- Toggle input: `inputVisible` toggle + `syncNodeSize()` on toggle
- Mode widget: `mode` первый в INPUT_TYPES
- Не перезаписывать `this.computeSize` на ноде
- Не использовать `root height:100%`
- **НЕ ИСПОЛЬЗОВАТЬ `flex:1` на list/tree** — создаёт feedback loop с computeSize

## 4. Следующие шаги

1. **Живой тест stretch**: рестарт ComfyUI → drag ноды вниз → открыть карточку → тогл input → зум. Ожидается: контент тянется, без пустоты и «плясок»
2. Если тест ОК — закоммитить и запушить (v1.8)
3. **SPLIT на две ноды**: Prompt Library + Prompt Saver
4. **Постраничность** (~20 записей на страницу)

## 5. Связанные файлы

- `prompt_library.js` — JS DOM widget (v1.7)
- `prompt_library_node.py` — Python node (v1.7)
- `SPECIFICATION.md` v1.7 — полная документация с §21 (failed experiments)
- `.opencode/skills/comfyui-dom-widget-sizing/SKILL.md` — sizing skill
- `SESSION_MEMORY-history/2026-09-16-0430.md` — снапшот перед перезаписью

## 6. Известные проблемы

- **Низ ноды не примыкает к контенту** — фундаментальное ограничение фиксированных констант
- **Detail-панель можно тянуть вниз** — resizable=true + onResize clamping не может запретить
- **Это acceptable** — нода функциональна, layout не идеален, но стабилен
