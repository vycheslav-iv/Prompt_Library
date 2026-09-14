# Память сессии — Prompt Library (2026-09-15, sizing решён)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Результат на сейчас

- **Sizing решён** (§18, скил `comfyui-dom-widget-sizing`): `computeSize` возвращает фиксированные константы (`BASE_H=436`, `DETAIL_H=160`). Никакого `offsetHeight`, `scrollHeight`, `plScale`, `fitNode`. Нода стабильна при зуме, resize, загрузке.
- **Функционал готов**: сохранение (авто/кнопка), категории, поиск, сортировка, виды, DnD, панель книги, выдача, превью 512px. Python прогон end-to-end: PASSED.
- Репозиторий: `https://github.com/vycheslav-iv/Prompt_Library.git`, 8 коммитов, master чист.

## 2. Итоговое состояние кода

- `prompt_library_node.py` — `PromptLibrary` (prompt/mode/selected/save_folder + optional source/image; патч `[display, mode, selected, save_folder]`).
- `web/js/prompt_library.js` — дерево категорий, виды, DnD, detail, MODE, сторож цикла, `dropAutoSockets`, `computeSize` (фикс. константы), `syncNodeSize`, `enforceMinWidth`, списки фикс 320px, голова текста 300 при проводе.
- **Скил создан**: `.opencode/skills/comfyui-dom-widget-sizing/` (+ `.kilo/`, `.agents/`).

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

- `SPECIFICATION.md` (§18 — sizing), `README.md`, `SESSION_MEMORY-history/`
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library\`
- Скилы: `comfyui-cycle-guard`, `comfyui-dom-widget-sizing`
