# Память сессии — Prompt Library (2026-09-19, v1.27)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md` (полная документация).
> Снапшот предыдущей версии: `SESSION_MEMORY-history/2026-09-19-v1.26.md`.

---

## 1. Что делали в этой сессии (кратко)

- **v1.27 (§32): глубокий аудит всего проекта** — шесть реальных дефектов, каждый с
  тестом:
  1. **Гонки read-modify-write** (Queue-поток ComfyUI vs HTTP-роуты в event loop)
     → общий `_DB_LOCK = threading.RLock()` (`prompt_library_node.py:32`);
     POST-роуты — `@_locked` (тело читается ДО замка, внутри только sync-код),
     `list`/`entry`/`search` — `@_locked_get` (их `_load_db` тоже пишет при
     миграции), `execute()` — обёртка `execute → _execute` (`:604`/`:614`).
     Тест проверяет ВЛАДЕНИЕ замком в момент `_save_db`, а не наличие декоратора.
  2. **`id` без проверки в `attach_preview`** (уходил в имя файла
     `previews/{id}.png`) → `re.fullmatch(r"[a-zA-Z0-9]+", entry_id)` → `400 bad id`.
  3. **Подхват предлагал mute-узлы**: было `mode === 4` как «mute», а в LiteGraph
     `NEVER = 2` (mute), `BYPASS = 4` (bypass); сверено по `app.ts`:
     `isMuted = mode === NEVER || mode === BYPASS` → теперь `mode === 2 || 4`.
  4. **Поиск не находил слово из середины текста** (`/list` отдаёт `head` ≤120
     символов) → новый `GET /prompt_library/search?q=` (только `ids`) +
     `st.onSearch`/`st.deepIds` в JS, без таймеров (last-wins по номеру запроса).
  5. **Двойной клик `💾`** давал два POST → `st._saving` (ручное сохранение),
     `st._savingEdit` (панель книги).
  6. Мелочи: `plHookVueMode` патчит только data-descriptor; `previewStamp`/`deepIds`
     чистятся (удаление записи, `onRemoved`); drop на канвас берёт состояние ЖИВОЙ
     ноды (`plLiveStates`).
- В смоуке поднята точность заглушки DOM: `innerHTML = ""` теперь реально чистит
  детей (иначе карточки «накапливались» между рендерами и их нельзя было считать).
- Маркер JS: **`1.27-audit`**. Тесты: **Python 225/225** (было 213), **смоук 68/68**
  (было 65), аудит чист.
- Контекст предыдущих версий: v1.26 (§31) — медиа-обложка без провода (видео через
  PyAV, ручное видео, замена обложки); v1.25 (§30) — подхват финального текста;
  v1.24 (§29) — одна нода вместо двух (три режима + обложка из прогона).

## 2. Итоговое состояние кода

- `prompt_library_node.py` (1252 строки)
  - `_DB_LOCK` (`:32`) · `_load_db` (`:88`, мигрирует/чинит файл — потому и под
    замком) · `_save_db` (`:149`, атомарно через `os.replace`)
  - `execute` (`:604`, только замок) → `_execute` (`:614`, вся логика: `issue/both/
    save_on`, `_output_linked`, `preview_target → ui.saved_id`, `_pickup_stash`,
    PNG-патч `[mode, selected, save_folder, pickup]`)
  - медиа: `_is_video_file` (`:431`), `_load_video_frame` (`:439`, PyAV),
    `_save_preview_upload` (`:313`), `_snapshot_workflow` (`:360`)
  - роуты (15): `_locked`/`_locked_get` (`:824`/`:841`), `attach_preview` (`:852`),
    `save_pickup` (`:932`), `search` (`:972`), `list` (`:993`), `add` (`:1020`)
- `web/js/prompt_library.js` (2321 строка), `PL_JS_VERSION = "1.27-audit"` (`:79`)
  - подхват: `st.pickupCandidates` (`:649`, `mode === 2 || 4`), `st.pickupText`,
    `st.savePickup`, обработчики `executed`/`execution_success`
  - `st.apiPost` (`:723`, единая точка мутаций + `plRefreshLocal`)
  - `st.hookCanvasDrop` (`:770`) · `st.readPreviewFile` (`:1081`, картинка/видео)
  - поиск `st.onSearch` (`:1905`) · `st.fillDetail` (`:1985`) · `st.minH` (`:2145`,
    `computeLayoutSize` = `minHeight`, `BASE_H=624/DETAIL_H=280/INPUT_H=170`)
  - `bPreview` (`:510`, замена обложки: только в режиме ✏️ + confirm),
    `💾/✖` (правка/отмена), `inputSaveBtn` (`:286`, `st._saving`)
- `tests/` (§1.1 AGENTS.md): `_test_prompt_library.py` (225 проверок; §20 = аудит),
  `_smoke_prompt_library.mjs` (68 фаз; v1.27: двойной клик, `/search`, mute/bypass,
  чистка метки), `_audit_prompt_library.mjs` (15 роутов JS↔Python, `st.*`, локали)
- `SPECIFICATION.md` — **v1.27**: §32 (аудит), §31 (медиа), §30 (подхват),
  §29 (одна нода), §28 (пол на панелях)

## 3. Проблемы, которые встречались (и как решали)

- **Потеря записи при гонке** (Queue + кнопка одновременно) — `_DB_LOCK` (§32.2).
  Файл при этом НЕ портился (`os.replace`), пропадало только чужое изменение —
  потому баг и был невидим.
- **«Mute-узел в списке подхвата»** — путаница констант LiteGraph: mute = 2,
  bypass = 4. Проверять по `app.ts`, а не по догадке (§32.4).
- **Слово из середины промпта не находилось** — `/list` отдаёт `head` ≤120 символов,
  поэтому поиск вынесен на сервер (§32.5).
- **Смоук «не видел» карточки** — заглушка `innerHTML` не чистила детей (§32.8).
- Ранее (живые): `this.id` в `onNodeCreated` = `-1` (читать id в момент события);
  subgraph-id `"5:12"` (сверять `display_node` и последний сегмент); пол на панелях
  перекрывал низ списка (пол только в `computeLayoutSize`); «видео-превью не
  сохраняется» (PIL не открывает медиаконтейнер → PyAV); замена обложки не видна
  (кэш URL по `created_at` → `st.previewStamp`).

## 4. Что важно не сломать при продолжении работы

- **Вся работа с базой — под `_DB_LOCK`.** Новый роут: либо `@_locked` (POST),
  либо `@_locked_get` (GET); внутри — НИКАКИХ `await` (тело читает декоратор).
  Иначе гонка вернётся молча.
- **Рекурсия запрещена**: значение, рождающееся в прогоне (обложка, финальный
  текст), забирается из событий `executed` + одноразовый токен, а не проводом назад.
- Всё, что нужно ПОСЛЕ прогона, живёт в токене (`_PICKUP`, лимит 20, без таймеров):
  к моменту прихода текста `execute()` уже отработал.
- Порядок INPUT_TYPES `[mode, selected, save_folder, pickup]`; PNG-патч позиционный.
- Sizing: пол — ТОЛЬКО в `computeLayoutSize`; читать только boolean-стейт
  (`display`-флаги), никогда размеры DOM (`offsetHeight`/`scrollHeight`/`plScale`),
  никаких `setInterval`/`MutationObserver`; legacy `computeSize` не задавать.
- Broadcast: `send_sync` + `app.api.addEventListener` (не `window`); из новых роутов
  не забывать `_broadcast_refresh()`.
- Подхват: дубль НЕ тостить (событие летит на каждый Queue) — только `hintSticky`.
- `media` описывает ТЕКУЩУЮ обложку; id, уходящий в имя файла, обязан проходить
  `^[a-zA-Z0-9]+$` (и на клиенте ничего не строить из него).
- Правка карточки: вход ✏️ → выход 💾 ИЛИ ✖; после замены обложки НЕ звать
  `st.fillDetail` (сотрёт несохранённый текст).
- Тесты — только в `NodeName/tests/`; `sync.py` их не копирует.

## 5. Следующие шаги (идеи, не сделано)

1. **[живая проверка v1.27]** рестарт ComfyUI + Ctrl+F5, маркер `1.27-audit`:
   (а) Queue «Запись» + одновременно «Сохранить промпт» — обе записи на месте;
   (б) поиск слова из СЕРЕДИНЫ длинного промпта; (в) mute-узел не виден в
   `📎 Текст в базу`; (г) двойной клик по «Сохранить промпт» не двоит запись.
2. **[живая проверка v1.26/v1.25/v1.24]** — §31/§30/§29 (маркеры `1.26-media` и т.д.).
3. Бюджет высоты панели книги: в v1.26b/c добавлены 2 кнопки, ряд переносится;
   оценка по CSS ≈276px против `DETAIL_H = 280` — проверить, что нижняя строка не
   подрезана (если да — поднять `DETAIL_H`, но НЕ читать размеры DOM).
4. §25.3 п.1 — воркфлоу inline в `library.json` (2.9 МБ на 92 записи; на лимите
   500 — ~150 МБ и полный парсинг на каждый запрос): вынести в `workflows/{id}.json`.
5. §25.3 п.3 — сироты превью при обрезке `MAX_ENTRIES`; заодно постраничность списка.
6. §25.3 п.5 — отмена confirm при смене режима в Vue (нужна живая проверка).
7. Сознательное (не баг): `/update` не проверяет глобальный дубль по тексту; записи
   без `media` видны только во «Всё»; в селекторе подхвата — только узлы верхнего
   уровня графа.

## 6. Связанные файлы

- `prompt_library_node.py` — нода, роуты, `_DB_LOCK`, база, подхват, медиа-обложка
- `web/js/prompt_library.js` — JS-расширение (маркер `1.27-audit`)
- `tests/_test_prompt_library.py`, `tests/_smoke_prompt_library.mjs`,
  `tests/_audit_prompt_library.mjs`
- `SPECIFICATION.md` (v1.27, §28–§32), `README.md`
- `SESSION_MEMORY-history/2026-09-19-v1.26.md` — снапшот предыдущей памяти
- Скил `comfyui-deferred-capture` (все 3 папки бандла) — ловушки 12–14: поток
  `execute` vs event loop, mute/bypass (2/4), guard id
- `sync.py` — в корне бандла `F:\AI_projects\Custom_node_ComfyUI\`

## 7. Коммиты

| Хэш | Описание |
|-----|----------|
| `b3f4b2f` | fix: close the audit findings in the library core (v1.27) |
| `b315a17` | memory: list the v1.26c commit in the session table |
| `f62abb9` | feat: ✖ Отмена в панели книги рядом с 💾 (v1.26c) |
| `66adf0a` | memory: list the v1.26b commit in the session table |
| `2ab44f4` | fix: cover replacement behind edit mode + confirm (v1.26b) |
| `dc19600` | memory: v1.26 media covers, manual video preview, cover replacement |
| `d72a685` | feat: video covers without a wire, manual video preview (v1.26) |
| `765888d` | docs: bring the pre-v1.24 spec sections up to date |
| `a4e613d` | feat: pick up the final text from a source node after the run (v1.25) |

Все запушены в `origin master`.
