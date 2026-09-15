# Память сессии — Prompt Library (2026-09-16, mode revert + SPEC cleanup)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Исправил логику переключения режима: при отмене IMAGE-wire disconnect диалога
  режим возвращается на «📥 Запись» (вместо застревания на «📤 Выдача»)
- `ensureIssueSafe()` теперь возвращает `true`/`false` (был void)
- Обновил SPECIFICATION.md: убрал ложное (truncation 300 chars, autoSizing, mode-on-click)
- Закоммичено и запушено: `f33e9a2`

## 2. Итоговое состояние кода

- `prompt_library.js:671-684` — `modeW.callback` — откат режима при отмене
- `prompt_library.js:647-669` — `ensureIssueSafe()` — возвращает bool
- `prompt_library.js:724-725` — `DETAIL_H=280`, `BASE_H=436`
- SPECIFICATION.md v1.6 — toolbar order: вид → порядок → поиск

## 3. Что важно не сломать

- `computeSize`: `BASE_H=436`, `DETAIL_H=280` (фиксированные константы)
- `list` = `flex:1`, `treeBox` = `width:34%`
- `dText`: `resize:none; rows=10`
- `detail`: `max-height:320px; overflow-y:auto`
- `ensureIssueSafe()` возвращает `true`/`false` — не терять этот контракт
- Не перезаписывать `this.computeSize` на ноде
- Не использовать `root height:100%`

## 4. Следующие шаги

1. **SPLIT на две ноды**: Prompt Library + Prompt Saver
2. **Постраничность** (~20 записей на страницу)
3. **Детальный анализ фронтенда** — прочитать `core-*.js` вокруг `computeSize`

## 5. Связанные файлы

- `prompt_library.js` — JS DOM widget (актуальная версия)
- `prompt_library_node.py` — Python node (стабильный)
- `SPECIFICATION.md` v1.6 — полная документация
- `.opencode/skills/comfyui-dom-widget-sizing/SKILL.md` — sizing skill
- `SESSION_MEMORY-history/2026-09-16.md` — снапшот перед перезаписью
