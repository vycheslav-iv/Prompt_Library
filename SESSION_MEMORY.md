# Память сессии — Prompt Library (2026-09-16, save priority + mode reorder)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Сохранение: виджет `prompt` приоритетнее провода `source` (fallback только если виджет пуст)
- `mode` перемещён перед `prompt` в `INPUT_TYPES` (виджет режима над окном промпта)
- Переключение папки сбрасывает выделение карточки (`selWidget.value = ""`)
- `listContent`/`tree` увеличены до 480px, `BASE_H` = 596 (два ряда больших карточек с кнопками)
- SPECIFICATION.md обновлена (§8.1, §8.2, §18.3, §18.4, §20.3)
- Закоммичено и запушено: `bdaf2cf`

## 2. Итоговое состояние кода

- `prompt_library_node.py:180-186` — `INPUT_TYPES`: mode → prompt → selected → save_folder
- `prompt_library_node.py:221-226` — `execute()`: prompt приоритетнее source
- `prompt_library.js:697` — save: `pw.value || st.lastFullText`
- `prompt_library.js:332-341` — folder switch: `selWidget.value = ""`, `detailId = null`
- `prompt_library.js:724-725` — `DETAIL_H=280`, `BASE_H=596`
- `prompt_library.js:114` — `listContent`: `height:480px`
- `prompt_library.js:102` — `tree`: `height:480px`

## 3. Что важно не сломать

- `computeSize`: `BASE_H=596`, `DETAIL_H=280` (фиксированные константы)
- `listContent`/`tree` = 480px (два ряда больших карточек)
- `ensureIssueSafe()` возвращает `true`/`false` — не терять этот контракт
- Save priority: `pw.value` → `st.lastFullText` (только fallback)
- Mode widget: `mode` перед `prompt` в INPUT_TYPES
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
- `.opencode/skills/comfyui-dom-widget-sizing/SKILL.md` — sizing skill (480px/596)
- `SESSION_MEMORY-history/2026-09-16-0430.md` — снапшот перед перезаписью
