# Память сессии — Prompt Library (2026-09-15, откат к рабочей версии)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Откат JS к коммиту `68c5ea8` (SPECIFICATION.md v1.2: §19 аудит) — до попыток layout fix
- Минимальные фиксы detail-панели: `max-height:200px`, `overflow-y:auto`, `flex-shrink:0`
- Обновили SPECIFICATION.md до v1.4: §17 (текущее состояние), §20 (история отката)
- Закоммитили и запушили: `e29c82a`

## 2. Итоговое состояние кода

- `prompt_library_node.py:18` — `PromptLibrary`. Audit fixes: isinstance, _add_entry, preview.
- `web/js/prompt_library.js:690-713` — `browserWidget.computeSize` с `BASE_H=436`, `DETAIL_H=160`
- `web/js/prompt_library.js:118-119` — detail: `max-height:200px`, `overflow-y:auto`, `flex-shrink:0`
- `web/js/prompt_library.js:129-132` — dText: `overflow-y:auto`, `max-height:120px`

## 3. Проблемы, которые встречались (и как решали)

- **10+ попыток layout fix провалились** — все были CSS-хаки без чтения исходников фронтенда
- **Причина провала**: не было прочитано место в `core-*.js` где фронтенд вызывает `computeSize`
- **Решение**: откат к рабочей версии + минимальные фиксы (detail max-height)

## 4. Что важно не сломать при продолжении работы

- `computeSize` — на **виджете** (`browserWidget.computeSize`), НЕ на ноде
- list/tree = фикс 320px + overflow-y:auto
- Порядок `widgets_values` = порядок INPUT_TYPES
- Удаление категории НЕ теряет книги
- Поле `folder` не переименовывать
- `D:\ComfyUI_windows_portable_old\` — архив
- Исходник → `python sync.py Prompt_Library` → рестарт + Ctrl+F5
- gh: `vycheslav-iv`. Запрещено: PowerShell, `rm -rf .git`

## 5. Следующие шаги (по решению пользователя)

1. **SPLIT на две ноды**: Prompt Library (дерево/поиск/выдача) + Prompt Saver (пассивная)
2. **Постраничность** (~20 записей на страницу)
3. **Детальный анализ фронтенда** — прочитать `core-*.js` вокруг `computeSize` чтобы понять
   КАК фронтенд realmente вызывает его для DOM-виджетов (обязательно перед любым sizing fix)

## 6. Связанные файлы

- `SPECIFICATION.md` (v1.4: §17 текущее, §18 sizing, §19 audit, §20 detail revert)
- `SESSION_MEMORY-history/2026-09-15-1500.md` — снапшот до отката
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library\`
- Скилы: `comfyui-cycle-guard`, `comfyui-dom-widget-sizing`
