# Память сессии — Prompt Library (2026-09-15,清理 false info)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Удалил из скила `comfyui-dom-widget-sizing` ложный раздел «фиксированный размер ноды»
  (отказанный подход: `resizable=false`, `requestAnimationFrame` textarea)
- Исправил SPECIFICATION.md: `DETAIL_H` 160→280, `detail` 160px→280px, `total` 596→716px
- Исправил §20.5: убрал `root height:100%` (отказанный подход)
- Закоммичено и запушено: `6549441`

## 2. Найденные и исправленные ложные данные

| Файл | Было (ложное) | Стало (правильное) |
|------|---------------|---------------------|
| SKILL.md | «фиксированный размер ноды — самый надёжный» | Удалён (отказанный подход) |
| SKILL.md | `DETAIL_H = 160` | `DETAIL_H = 280` |
| §18.3 | `DETAIL_H = 160; textarea(5rows)` | `DETAIL_H = 280; textarea(10rows)` |
| §18.4 | `detail: 160px`, `total: 596px` | `detail: 280px`, `total: 716px` |
| §20.5 | `Root = height:100%` | Удалён (используем `flex:1` на дочерних) |
| §20.5 | `max-height:200px` | `max-height:320px` |

## 3. Что важно не сломать

- `computeSize`: `BASE_H=436`, `DETAIL_H=280` (фиксированные константы)
- `list` = `flex:1`, `treeBox` = `width:34%`
- `dText`: `resize:none; rows=10`
- `detail`: `max-height:320px; overflow-y:auto`
- Не перезаписывать `this.computeSize` на ноде
- Не использовать `root height:100%`

## 4. Следующие шаги

1. **SPLIT на две ноды**: Prompt Library + Prompt Saver
2. **Постраничность** (~20 записей на страницу)
3. **Детальный анализ фронтенда** — прочитать `core-*.js` вокруг `computeSize`

## 5. Связанные файлы

- `.opencode/skills/comfyui-dom-widget-sizing/SKILL.md` (очищен)
- `SPECIFICATION.md` (v1.6, исправлены ложные данные)
- `SESSION_MEMORY-history/2026-09-15-1730.md`
