# Память сессии — Prompt Library (2026-09-15, audit)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Результат на сейчас

- **Sizing решён** (§18): `computeSize` — фиксированные константы (`BASE_H=436`, `DETAIL_H=160`)
- **Audit пройден** (§19): 4 исправления + 5 осознанно оставленных
- **Функционал готов**: сохранение (авто/кнопка), категории, поиск, сортировка, виды, DnD, панель книги, выдача, превью 512px. Python прогон: PASSED.
- Репозиторий: `https://github.com/vycheslav-iv/Prompt_Library.git`, master чист.

## 2. Итоговое состояние кода

- `prompt_library_node.py` — `PromptLibrary` (prompt/mode/selected/save_folder + optional source/image). **Audit fixes**: `isinstance(source, str)`, `_add_entry()` вместо дублирования, preview сохраняется ПОСЛЕ `_add_entry()`.
- `web/js/prompt_library.js` — дерево, виды, DnD, detail, MODE, сторож, `dropAutoSockets`, `computeSize` (фикс. константы), `syncNodeSize`, `enforceMinWidth`. **Audit fixes**: sort comparator возвращает 0, `console.debug` вместо `console.log`.
- **Скил создан**: `comfyui-dom-widget-sizing` (3 папки) + методология решения проблем.

## 3. Что важно не сломать

- `computeSize` — фиксированные константы, НЕ `offsetHeight`/`scrollHeight`/`plScale`
- Порядок `widgets_values` = порядок INPUT_TYPES
- Удаление категории НЕ теряет книги (переезд в корень)
- Поле `folder` в базе/API не переименовывать
- `D:\ComfyUI_windows_portable_old\` — архив, не трогать
- Исходник → `python sync.py Prompt_Library` → рестарт + Ctrl+F5 + пересоздать ноду
- gh: `vycheslav-iv`. Запрещено: PowerShell, `rm -rf .git`, `git init` в корне

## 4. Отложено (§17)

- СPLIT на две ноды: **Prompt Library** (без IMAGE) + **Prompt Saver** (пассивная)
- Постраничность списка (~20 записей на страницу)

## 5. Связанные файлы

- `SPECIFICATION.md` (§18 sizing, §19 audit), `README.md`, `SESSION_MEMORY-history/`
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library\`
- Скилы: `comfyui-cycle-guard`, `comfyui-dom-widget-sizing`
