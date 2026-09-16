# Память сессии — Prompt Library (2026-09-17, v1.9: stretch + sync restore)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.8: вертикальный stretch через `computeLayoutSize` (вместо legacy `computeSize`), фикс мёртвого `widgets_values`-патча, рабочий retry restore папки — проверено живьём, запушено (`455b998`).
- v1.9: retry удалён — restore папки синхронно из `onConfigure(info)` + одноразовый reconcile, ноль polling. Проверено живьём, закоммичено.
- Скилл `comfyui-dom-widget-sizing` приведён к текущему коду (3 копии в синхроне).

## 2. Итоговое состояние кода

- `web/js/prompt_library.js:774-790` — `browserWidget.computeLayoutSize` (`minHeight = BASE_H + DETAIL_H + INPUT_H`, `minWidth = MIN_W`); legacy `computeSize` НЕ задавать.
- `web/js/prompt_library.js:41,132,148,160` — CSS-цепочка stretch: `root height:100%` → `main flex:1` → `listContent`/`tree` flex:1 + min-height:480px.
- `web/js/prompt_library.js:822-875` — `onConfigure(info)`: sync-извлечение `save_folder` (named → позиция `[2]`) + одноразовый reconcile после `reload()`.
- `prompt_library_node.py:270` — `widgets_values = [mode, selected, save_folder]` (порядок = INPUT_TYPES required).
- `SPECIFICATION.md` v1.9 (§17, §22.4, §23 актуальны; §21.5 — архив).

## 3. Проблемы, которые встречались (и как решали)

- Пустота снизу при ресайзе — причина в `_arrangeWidgets` фронтенда (legacy = точная высота); решено новым API (§22).
- `widgets_values` с неопределённым `prompt` глушил NameError через `except: pass` — персистентность была мертва (§22.5).
- Папка не восстанавливалась: save в файле был, restore опаздывал → сначала retry, затем sync из `info` (ядро: `configure` → `onConfigure(info)` с данными) — retry удалён (§23).

## 4. Что важно не сломать при продолжении работы

- Не задавать `browserWidget.computeSize` (ломает stretch); `computeLayoutSize` читает только boolean-стейт, никаких `offsetHeight`/`scrollHeight`.
- Порядок INPUT_TYPES required `[mode, selected, save_folder]` — от него зависит позиционный фолбэк `[2]` и `widgets_values`.
- `widget.serialize = false` ставить свойством (options не пробрасывается).
- Ноль `setTimeout` в пути restore (остатки в файле — только сбросы подписей кнопок).
- Голый `except: pass` прячет регрессии — при удалении виджетов grep'ать имя везде.

## 5. Следующие шаги (идеи, не сделано)

1. **SPLIT на две ноды**: Prompt Library + Prompt Saver.
2. **Постраничность** (~20 записей на страницу).

## 6. Связанные файлы

- `prompt_library.js` / `prompt_library_node.py` — код ноды (v1.9).
- `SPECIFICATION.md` v1.9 — полная документация (§22 stretch, §23 restore).
- `.opencode/skills/comfyui-dom-widget-sizing/SKILL.md` (+ `.kilo`, `.agents` копии) — паттерны sizing/stretch/restore.
- `SESSION_MEMORY-history/2026-09-17.md` — снапшот предыдущей памяти.
