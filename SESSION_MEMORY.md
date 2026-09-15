# Память сессии — Prompt Library (2026-09-15, skills update)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- Обновлён скил `comfyui-dom-widget-sizing`: 3 новых паттерна + 1 запрещённый подход
- Обновлена SPECIFICATION.md §18.6: дополнительные паттерны из Prompt Library
- Закоммичено и запушено: `87caf62`

## 2. Добавленные паттерны в скил

- **List/tree alignment** — одинаковая структура (header 22px + scrollable 320px)
- **Flex stretch** — `flex:1` + `width:34%; flex-shrink:0` (растяжение при ресайзе)
- **Textarea в detail** — `resize:none; rows=10; overflow-y:auto`
- **Запрещено**: override `this.computeSize` на ноде (ломает border/resize)

## 3. Итоговое состояние кода

- `comfyui-dom-widget-sizing/SKILL.md` — 220 строк, 8 паттернов + 8 запрещённых подходов
- Скил синхронизирован в `.opencode`, `.kilo`, `.agents`
- `SPECIFICATION.md` v1.6: §18.6 дополнен новыми паттернами

## 4. Следующие шаги

1. **SPLIT на две ноды**: Prompt Library + Prompt Saver
2. **Постраничность** (~20 записей на страницу)
3. **Детальный анализ фронтенда** — прочитать `core-*.js` вокруг `computeSize`

## 5. Связанные файлы

- `.opencode/skills/comfyui-dom-widget-sizing/SKILL.md`
- `.kilo/skills/comfyui-dom-widget-sizing/SKILL.md`
- `.agents/skills/comfyui-dom-widget-sizing/SKILL.md`
- `SPECIFICATION.md` (v1.6)
- `SESSION_MEMORY-history/2026-09-15-1700.md`
