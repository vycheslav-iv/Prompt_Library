# Память сессии — Prompt Library (2026-09-16, v1.7: prompt removed)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Удалили виджет `prompt` из `INPUT_TYPES` — ручной ввод через DOM-кнопку
- Кнопка `➕ Добавить промпт` → textarea + `💾 Сохранить промпт` (POST `/prompt_library/add`)
- Вход `source` — единственный способ передать промпт проводом
- Откатили неудачные эксперименты с flex stretch (§21 в SPEC)
- Закоммичено и запушено: `b297b47` (v1.7)

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

1. **SPLIT на две ноды**: Prompt Library + Prompt Saver
2. **Постраничность** (~20 записей на страницу)
3. **Детальный анализ фронтенда** — прочитать `core-*.js` вокруг `computeSize`

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
