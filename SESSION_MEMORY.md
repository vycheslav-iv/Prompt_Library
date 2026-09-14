# Память сессии — Prompt Library (2026-09-15, detail layout fix)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Результат на сейчас

- **Detail layout решён** (§20): root height:100%, main flex:1, detail flex-shrink:0
- **Sizing решён** (§18): `computeSize` — фиксированные константы на виджете
- **Audit пройден** (§19): isinstance, _add_entry dedup, sort 0
- **Функционал готов**: сохранение, категории, поиск, сортировка, виды, DnD, панель книги, выдача, превью. Python прогон: PASSED.
- Репозиторий: `https://github.com/vycheslav-iv/Prompt_Library.git`, master чист.

## 2. Итоговое состояние кода

- `prompt_library_node.py` — `PromptLibrary`. Audit fixes: isinstance, _add_entry, preview.
- `web/js/prompt_library.js` — DOM widget. Detail layout fix: root height:100%, main flex:1.
- **Ключевое правило**: НИКОГДА не перезаписывать `this.computeSize` на ноде — это ломает layout (§20.4).

## 3. Что важно не сломать

- `computeSize` — на **виджете** (`browserWidget.computeSize`), НЕ на ноде
- `root` = `height:100%`, `main` = `flex:1`, `detail` = `flex-shrink:0`
- list/tree = фикс 320px + overflow-y:auto
- Порядок `widgets_values` = порядок INPUT_TYPES
- Удаление категории НЕ теряет книги
- Поле `folder` не переименовывать
- `D:\ComfyUI_windows_portable_old\` — архив
- Исходник → `python sync.py Prompt_Library` → рестарт + Ctrl+F5
- gh: `vycheslav-iv`. Запрещено: PowerShell, `rm -rf .git`

## 4. Отложено (§17)

- СPLIT на две ноды: **Prompt Library** + **Prompt Saver**
- Постраничность (~20 записей на страницу)

## 5. Связанные файлы

- `SPECIFICATION.md` (§18 sizing, §19 audit, §20 detail layout)
- `SESSION_MEMORY-history/`
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Prompt_Library\`
- Скилы: `comfyui-cycle-guard`, `comfyui-dom-widget-sizing`
