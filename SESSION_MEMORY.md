# Память сессии — Prompt Library (2026-09-17, v1.9.1: персистентность __fav/__root)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- v1.8 → v1.9 → v1.9.1, всё проверено живьём и запушено (`7356c89`, `455b998`).
- v1.9.1: баг сброса «Избранное»/«Без категории» на «Всё» — виджет теперь несёт
  `__fav`/`__root` как есть, `execute()` режет `__*` в корень. Headless-тест PASSED.
- Скилл `comfyui-dom-widget-sizing` вычищен от устаревшего (3 копии в синхроне).

## 2. Итоговое состояние кода

- `web/js/prompt_library.js:774-790` — `browserWidget.computeLayoutSize` (`minHeight = BASE_H + DETAIL_H + INPUT_H`); legacy `computeSize` НЕ задавать.
- `web/js/prompt_library.js:41,132,148,160` — CSS-цепочка stretch: `root height:100%` → `main flex:1` → `listContent`/`tree` flex:1 + min-height:480px.
- `web/js/prompt_library.js:822-875` — `onConfigure(info)`: sync-извлечение `save_folder` (named → позиция `[2]`) + одноразовый reconcile (валидны `__all`/`__fav`/`__root` + папки базы).
- `web/js/prompt_library.js:233-243` — `syncSaveFolder` пишет выбор как есть (`""` только для `__all`), виджет ищет заново.
- `prompt_library_node.py:211-216,270` — guard `startswith("__")` → корень; `widgets_values = [mode, selected, save_folder]`.
- `SPECIFICATION.md` v1.9.1 (§17, §22.4, §23.3–23.4 актуальны; §21.5 — архив).

## 3. Проблемы, которые встречались (и как решали)

- Пустота снизу при ресайзе — legacy `computeSize` = точная высота; решено `computeLayoutSize` (§22).
- Мёртвый персистентность-патч (хвост `prompt`, NameError под `except`) — исправлено, headless-тест (§22.5).
- Папка опаздывала при restore → sync из `info`, retry удалён, ноль polling (§23).
- Сброс `__fav`/`__root` на «Всё» — виджет не нёс служебные ключи; round-trip + guard (§23.4).

## 4. Что важно не сломать при продолжении работы

- Не задавать `browserWidget.computeSize`; sizing читает только boolean-стейт, никаких `offsetHeight`/`scrollHeight`.
- Порядок INPUT_TYPES required `[mode, selected, save_folder]` — от него зависят позиционный фолбэк `[2]` и `widgets_values`.
- `widget.serialize = false` ставить свойством (options не пробрасывается).
- Ноль `setTimeout` в пути restore; голый `except: pass` прячет регрессии.
- Служебный префикс `__` зарезервирован (реальные папки так не называть).

## 5. Следующие шаги (идеи, не сделано)

1. **SPLIT на две ноды**: Prompt Library + Prompt Saver.
2. **Постраничность** (~20 записей на страницу).

## 6. Связанные файлы

- `prompt_library.js` / `prompt_library_node.py` — код ноды (v1.9.1).
- `SPECIFICATION.md` v1.9.1 — полная документация (§22 stretch, §23 restore).
- `.opencode/skills/comfyui-dom-widget-sizing/SKILL.md` (+ `.kilo`, `.agents` копии).
- `SESSION_MEMORY-history/2026-09-17.md`, `2026-09-17-0200.md` — снапшоты памяти.
