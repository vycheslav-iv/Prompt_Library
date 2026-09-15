# Память сессии — Prompt Library (2026-09-15, list/tree alignment)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Исправлен баг: дерево категорий улетало влево при пустой папке
- Добавлено выравнивание list/tree: одинаковая структура (header + scrollable 320px)
- list растягивается при ресайзе ноды (`flex:1`), tree — фиксированная доля (`34%`)
- Закоммичено и запушено: `810b41d`

## 2. Итоговое состояние кода

- `prompt_library_node.py` — стабилен, без изменений
- `web/js/prompt_library.js:88-89` — `treeBox`: `width:34%; min-width:110px; flex-shrink:0`
- `web/js/prompt_library.js:107-117` — `list`: `flex:1` + `listHead`(22px) + `listContent`(320px)
- `web/js/prompt_library.js:172` — `st.list = listContent` (скроллируемая область)

## 3. Что важно не сломать

- `list` = `flex:1` (растягивается), `treeBox` = `width:34%` (фиксированная доля)
- `listHead` и `treeHead` = 22px (выравнивание верхних границ)
- `listContent` и `tree` = 320px (выравнивание нижних границ)
- `computeSize` — на виджете (`browserWidget.computeSize`), НЕ на ноде
- Порядок `widgets_values` = порядок INPUT_TYPES
- Удаление категории НЕ теряет книги
- `D:\ComfyUI_windows_portable_old\` — архив
- Исходник → `python sync.py Prompt_Library` → рестарт + Ctrl+F5
- gh: `vycheslav-iv`. Запрещено: PowerShell, `rm -rf .git`

## 4. Следующие шаги (по решению пользователя)

1. **SPLIT на две ноды**: Prompt Library (дерево/поиск/выдача) + Prompt Saver (пассивная)
2. **Постраничность** (~20 записей на страницу)
3. **Детальный анализ фронтенда** — прочитать `core-*.js` вокруг `computeSize` чтобы понять
   КАК фронтенд реально вызывает его для DOM-виджетов (обязательно перед любым sizing fix)

## 5. Связанные файлы

- `SPECIFICATION.md` (v1.5: list/tree alignment + flex stretch)
- `SESSION_MEMORY-history/2026-09-15-1500.md` — снапшот до list/tree fix
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library\`
- Скилы: `comfyui-cycle-guard`, `comfyui-dom-widget-sizing`
