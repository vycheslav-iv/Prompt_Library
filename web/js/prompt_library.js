const { app } = window.comfyAPI.app;

// Лёгкая проекция серверной записи для списка
function plMap(e) {
    return {
        id: e.id,
        title: e.title || "",
        head: (e.prompt || "").slice(0, 120),
        folder: e.folder || "",
        favorite: !!e.favorite,
        pinned: !!e.pinned, // закреп вверху папки (v1.30, §36)
        created_at: e.created_at || "",
        last_used: e.last_used || null,
        use_count: e.use_count || 0, // счётчик выдач (v1.35, сортировка «Частые»)
        has_preview: !!e.preview,
        has_workflow: !!e.has_workflow,
        media: e.media || null, // 'video' / 'image' / null (старые записи — неизвестно)
    };
}

// Бейдж типа записи: только текст, раскладку не трогает
function plBadge(e) {
    return e.media === "video" ? "🎬 " : e.media === "image" ? "📷 " : "";
}

// Эмодзи-иконки (🔌 / 📷 / 🎬) в Segoe UI Emoji сами по себе тёмные и на тёмной
// ноде почти сливаются с фоном. Цвет глифа задаёт ШРИФТ — `color` на эмодзи не
// действует, поэтому единственный честный способ — фильтр яркости.
const PL_ICON_FILTER = "filter:brightness(1.65) saturate(1.1);";
// Иконка отдельным пролётом: + воздух справа (margin), чтобы «штепсель + номер»
// и «фотоаппарат» не слипались в одну тёмную кучу (отчёт пользователя).
function plIcon(text, extra) {
    const s = document.createElement("span");
    s.textContent = text;
    // Центрирование пролёта по строке: глиф Segoe UI Emoji сидит ниже базовой
    // линии текста — на карточке 📷 «сползал вниз» (отчёт пользователя, v1.45.3).
    // inline-block + line-height:1 + vertical-align:middle встают посредине
    // строки сами, без подгонки пикселей под метрики шрифта.
    s.style.cssText = PL_ICON_FILTER + "flex-shrink:0;display:inline-block;line-height:1;vertical-align:middle;" + (extra || "");
    // Подъём чернил: внутри эмодзи-бокса глифы сидят на разной высоте. Замер на
    // живой странице (canvas-скан инка, v1.45.4): 📷 ниже текста на
    // 3.4px, 🎬 на 1.4, 📌 на 1.8, 🔌 на 1.6. Компенсируем точным translateY.
    const _LIFT = { "📷": -3.4, "🎬": -1.4, "📌": -1.8, "🔌": -1.6 };
    // Подъём — только для ЧИСТЫХ эмодзи-пролётов. «🔌3 » несёт ещё цифру вывода:
    // цифра — обычный текст и обязана стоять на строке как имя; поднятый пролёт
    // «всплывает» цифрой (скрин пользователя, v1.45.6). Пролёт с латиницей/
    // цифрами не трогаем — эмодзи в нём остаётся на естественном месте.
    const _gl = /[A-Za-z0-9]/.test(text || "") ? 0
        : (_LIFT[Object.keys(_LIFT).find((t) => text && text.includes(t)) || ""] || 0);
    if (_gl) s.style.transform = "translateY(" + _gl + "px)";
    return s;
}
// Обычный текстовый пролёт (НЕ текстовый узел): фильтр яркости действует на
// элемент, а заглушки тестов и `ftext` читают текст по ЭЛЕМЕНТАМ — сырой
// текстовый узел рядом с пролётом они не видят (v1.55).
function plTextSpan(text) {
    const s = document.createElement("span");
    s.textContent = text;
    return s;
}
// Название карточки: [🔌N] [📌] [📷/🎬] + имя. Текст иконок остаётся в DOM
// (ftext в тестах и поиск по названию не ломаются), меняется только раскладка.
// dense=true — плотный ряд «Списка» (превью слева, строка по центру): там камера
// с полным подъёмом -3.4px по глазу читается приподнятой (скрин пользователя
// v1.45.5), центр глифа сходится с текстом, но ряд плотный — снижаем подъём.
function plCardTitle(e, outNum, dense) {
    const box = document.createElement("div");
    box.style.cssText = "color:#fff;font-size:12px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    if (outNum) {
        const plug = plIcon(`🔌${outNum} `, "margin-right:4px;");
        // Блок «эмодзи+цифра» в сетке (крупные/средние) по инк-замеру сидел на
        // 1.6px ниже текста — поднимаем целиком (скрин v1.45.7). В «Списке»
        // (dense) подъём губит цифру: она обычный текст и «всплывает» (v1.45.6).
        if (!dense && !plug.style.transform) plug.style.transform = "translateY(-1.6px)";
        box.appendChild(plug);
    }
    if (e.pinned) box.appendChild(plIcon("📌 ", "margin-right:2px;"));
    if (plBadge(e)) {
        const ib = plIcon(plBadge(e), "margin-right:4px;");
        if (dense && String(ib.textContent).trim() === "📷") ib.style.transform = "translateY(-2.4px)";
        box.appendChild(ib);
    }
    const name = e.title || e.head || "(без названия)";
    // Имя — обычным span'ом, а не текстовым узлом: так его видит и DOM, и
    // тестовые заглушки (ftext/`firstTitle` читают текст по элементам).
    const nm = document.createElement("span");
    nm.textContent = name;
    box.appendChild(nm);
    box.title = name;
    return box;
}

// --- Синхронизация Library-нод одной страницы -------------------------------
// WS-сигнал (§26) ходит кругом через сервер и доходит до соседней ноды с
// задержкой; пока он идёт, второй экземпляр ноды показывает устаревший список —
// удалённые карточки и папки «остаются». Держим реестр живых нод и после любой
// мутации (POST) перечитываем базу у всех, кроме инициатора — он обновляет себя
// сам. Никаких таймеров и наблюдателей: только вызовы из хендлеров (st.apiPost).
const plLiveStates = new Set();

function plRefreshLocal(except) {
    for (const s of [...plLiveStates]) {
        if (s === except) continue;
        try { s.reload?.(); } catch (e) { /* silent */ }
    }
}

// --- Смена режима рендера (canvas ↔ Nodes 2.0) без перезагрузки страницы ------
// Настройка `Comfy.VueNodes.Enabled` превращается фронтендом в авторитетный флаг
// `LiteGraph.vueNodesMode` (useVueFeatureFlags: watch → LiteGraph.vueNodesMode),
// а сам LiteGraph виден расширению как `window.LiteGraph` (useGlobalLitegraph).
// Событие настроек — только второй путь (scripts/ui/settings.ts: dispatchChange
// шлёт CustomEvent `<id>.change` на app.ui.settings); он есть не везде.
// Оборачиваем свойство accessor'ом один раз на страницу и раздаём сигнал нодам.
// Если обёртка не удалась — код молча живёт на событии настроек и на сверке
// в render() (нода обязана работать без любых обходных путей).
const plModeWatchers = new Set();
let plModeHooked = false;
function plHookVueMode() {
    if (plModeHooked) return;
    try {
        const lg = window.LiteGraph;
        if (!lg || typeof lg.vueNodesMode !== "boolean") return;
        // Патчим только ОБЫЧНОЕ свойство-значение. Если фронт сделает
        // vueNodesMode accessor'ом (геттер/сеттер со своим стейтом), наша
        // обёртка перекрыла бы его сеттер и сломала бы стор — в этом случае
        // молча живём на событии настроек и на сверке в render().
        const desc = Object.getOwnPropertyDescriptor(lg, "vueNodesMode");
        if (desc && !("value" in desc)) return;
        let current = lg.vueNodesMode;
        Object.defineProperty(lg, "vueNodesMode", {
            configurable: true,
            enumerable: true,
            get: () => current,
            set: (v) => {
                current = !!v;
                for (const fn of plModeWatchers) {
                    try { fn(current); } catch (e) { /* silent */ }
                }
            },
        });
        plModeHooked = true;
    } catch (e) { /* silent */ }
}

// Маркер сборки: виден в F12 → Console. Нужен, чтобы точно знать, какая версия JS
// реально загружена браузером (файл статичный: после правки исходника нужен Ctrl+F5).
const PL_JS_VERSION = "1.59-outs-independent";
console.log(`[PromptLibrary] JS ${PL_JS_VERSION} loaded`);

app.registerExtension({
    name: "PromptLibrary",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptLibrary") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = origOnNodeCreated?.apply(this, arguments);

            // Скрыть технические selected/save_folder (ими управляет дерево и список)
            // `hidden` (свойство) фронтенд учитывает на канвасе, но панель
            // свойств фильтрует по `options.hidden`/`options.hideInPanel`
            // (rightSidePanel/shared.ts → computedSectionDataList), поэтому
            // техническим полям ставим и `hideInPanel` (v1.32): в панели они не
            // нужны (ими управляют дерево и список), а любой лишний рендер
            // виджета в панели — это лишний шанс, что панель тронет сам виджет.
            // `w.options && …` — без падения, если у виджета options нет (нода
            // обязана создаваться на любом фронтенде, SPEC §18.5).
            const selWidget = this.widgets?.find((w) => w.name === "selected");
            if (selWidget) {
                selWidget.hidden = true;
                selWidget.options && (selWidget.options.hideInPanel = true);
                selWidget.computeSize = () => [0, -4];
            }
            const saveFolderW = this.widgets?.find((w) => w.name === "save_folder");
            if (saveFolderW) {
                saveFolderW.hidden = true;
                saveFolderW.options && (saveFolderW.options.hideInPanel = true);
                saveFolderW.computeSize = () => [0, -4];
            }
            // Узел-источник подхвата (v1.25): значение пишет DOM-селектор,
            // сам виджет только персистится (как selected/save_folder).
            const pickupW = this.widgets?.find((w) => w.name === "pickup");
            if (pickupW) {
                pickupW.hidden = true;
                pickupW.options && (pickupW.options.hideInPanel = true);
                pickupW.computeSize = () => [0, -4];
            }
            // v1.44 (§40): JSON-привязки доп. выходов — пишет JS по дропам в
            // категории «Выходы». Скрыт и не сериализуется как виджет — значение
            // пишется в widgets_values PNG-патчем (как pickup).
            const slotsOutW = this.widgets?.find((w) => w.name === "slots_out");
            if (slotsOutW) {
                slotsOutW.hidden = true;
                slotsOutW.options && (slotsOutW.options.hideInPanel = true);
                slotsOutW.computeSize = () => [0, -4];
            }


            // --- DOM: библиотека ---
            // Растяжение вниз: root заполняет высоту виджета (wrapper фронтенда —
            // flex column с *:flex-1, высота виджета = computedHeight из layout),
            // main забирает свободное место (flex:1), listContent/tree тянутся
            // внутри (flex:1 + min-height floor). Без ресайза вид как раньше.
            const root = document.createElement("div");
            // Стабильные классы на ключевых контейнерах — только для живого
            // замера в DevTools/тестах (`tests/_probe_live_dom.py`): CSS по ним не
            // строится, поведение не меняется.
            root.className = "pl-root";
            root.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:400px;height:100%;";
            // Ноду нельзя сжать уже контента, иначе дерево вылезает за границу.
            // (Само присвоение — ниже, после this._pl = st, иначе TDZ-ошибка.)
            const MIN_W = 470;
            // Пол высоты панелей (список+дерево) — ОДИН для обоих режимов.
            //  • В Vue высоту ноды задаёт МИНИМАЛЬНАЯ высота контента
            //    (measureMinContentHeight), а пол внутри `overflow-y:auto` в этот
            //    замер не попадает (содержимое скролл-контейнера не расширяет
            //    родителя) — поэтому в Vue пол стоит на самом scrollArea,
            //    см. applyPaneLayout. Маленькое значение (280) позволяло сжать
            //    ноду почти в ноль — теперь как в канвасе (480).
            const PANES_MIN_H = 480;

            // Тулбар: вид → порядок → поиск (название + текст)
            const toolbar = document.createElement("div");
            toolbar.style.cssText = "display:flex;gap:6px;";
            const search = document.createElement("input");
            search.placeholder = "Поиск по названию и тексту...";
            search.style.cssText = "flex:1;min-width:0;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 6px;";
            const sortSel = document.createElement("select");
            sortSel.title = "Порядок категории";
            sortSel.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px;max-width:150px;";
            sortSel.innerHTML = `
                <option value="new">Сначала новые</option>
                <option value="title">По названию А–Я</option>
                <option value="old">Сначала старые</option>
                <option value="used">Недавно выданные</option>
                <option value="freq">Частые</option>`;
            // Режимы вида как в проводнике Windows
            const viewSel = document.createElement("select");
            viewSel.title = "Вид списка";
            viewSel.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px;max-width:130px;";
            viewSel.innerHTML = `
                <option value="large">📷 Крупные</option>
                <option value="medium">🎞 Средние</option>
                <option value="list">📋 Список</option>`;
            try {
                const savedView = localStorage.getItem("promptLibrary.view");
                if (savedView) viewSel.value = savedView;
            } catch (e) { /* silent */ }
            if (!["large", "medium", "list"].includes(viewSel.value)) viewSel.value = "large";
            // Фильтр типа: все / только фото / только видео (записи без метки видны только во «Все»)
            const mediaSel = document.createElement("select");
            mediaSel.title = "Тип записей";
            mediaSel.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px;max-width:110px;";
            mediaSel.innerHTML = `
                <option value="all">Всё</option>
                <option value="image">📷 Фото</option>
                <option value="video">🎬 Видео</option>`;
            try {
                const savedMedia = localStorage.getItem("promptLibrary.media");
                if (savedMedia) mediaSel.value = savedMedia;
            } catch (e) { /* silent */ }
            if (!["all", "image", "video"].includes(mediaSel.value)) mediaSel.value = "all";
            toolbar.appendChild(viewSel);
            toolbar.appendChild(sortSel);
            toolbar.appendChild(mediaSel);
            toolbar.appendChild(search);
            // Видимая версия сборки прямо в интерфейсе: по скриншоту всегда
            // понятно, какой JS исполняется (споры «у тебя старый файл» закрыты).
            const verTag = document.createElement("span");
            verTag.textContent = "v" + PL_JS_VERSION;
            verTag.title = "Версия JS-расширения (должна совпадать с консолью F12)";
            verTag.style.cssText = "color:#555;font-size:10px;flex-shrink:0;align-self:center;white-space:nowrap;";
            toolbar.appendChild(verTag);

            // Кнопка-тогл ручного ввода + область ввода
            const inputToggle = document.createElement("button");
            inputToggle.textContent = "➕ Добавить промпт";
            inputToggle.title = "Показать/скрыть окно ручного ввода промпта";
            inputToggle.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;flex-shrink:0;";

            const inputArea = document.createElement("div");
            inputArea.style.cssText = "display:none;flex-direction:column;gap:4px;border:1px solid #4a9eff;border-radius:4px;padding:6px;background:#16202f;";
            // Название записи (необязательно): пусто — сервер возьмёт начало
            // текста, как раньше (тот же `_auto_title`, что и в Queue-записи).
            const inputTitle = document.createElement("input");
            inputTitle.type = "text";
            inputTitle.placeholder = "Название (необязательно)";
            inputTitle.title = "Название книги. Пусто — возьмётся из начала промпта";
            inputTitle.style.cssText = "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:4px;font-size:12px;";
            const inputText = document.createElement("textarea");
            inputText.rows = 4;
            inputText.placeholder = "Введите промпт...";
            inputText.style.cssText = "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:4px;font-size:11px;resize:vertical;max-height:300px;overflow-y:auto;";
            const inputSaveBtn = document.createElement("button");
            inputSaveBtn.textContent = "💾 Сохранить промпт";
            inputSaveBtn.title = "Сохранить в текущую категорию";
            inputSaveBtn.style.cssText = "width:100%;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:5px;cursor:pointer;font-size:12px;";
            inputArea.appendChild(inputTitle);
            inputArea.appendChild(inputText);
            // Ручное превью с диска (без провода): файл → даунскейл до 512px
            // через canvas прямо в браузере → маленький PNG dataURL на сервер.
            const inputAttachRow = document.createElement("div");
            inputAttachRow.style.cssText = "display:flex;gap:4px;align-items:center;";
            const inputFile = document.createElement("input");
            inputFile.type = "file";
            inputFile.accept = "image/*,video/*";
            inputFile.style.display = "none";
            const attachBtn = document.createElement("button");
            attachBtn.type = "button";
            attachBtn.title = "Выбрать картинку или видео с диска как превью записи (у видео берётся первый кадр)";
            attachBtn.style.cssText = "flex:1;min-width:0;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:5px;cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            const attachThumb = document.createElement("img");
            attachThumb.style.cssText = "width:40px;height:40px;object-fit:cover;border-radius:3px;background:#222;display:none;flex-shrink:0;";
            // Видео в <img> не покажешь — отдельный <video> сам рисует первый кадр
            const attachVid = document.createElement("video");
            attachVid.muted = true;
            attachVid.playsInline = true;
            attachVid.preload = "metadata";
            attachVid.style.cssText = attachThumb.style.cssText;
            const attachClear = document.createElement("button");
            attachClear.type = "button";
            attachClear.textContent = "✖";
            attachClear.title = "Убрать прикреплённое превью";
            attachClear.style.cssText = "display:none;background:none;border:none;cursor:pointer;font-size:12px;flex-shrink:0;";
            let attachedFile = null;
            // Тип файла — по MIME и по расширению: у файлов с диска браузер
            // иногда отдаёт пустой type.
            const isVideoFile = (f) => !!f && (String(f.type || "").startsWith("video/")
                || /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(f.name || ""));
            const renderAttach = () => {
                const vid = isVideoFile(attachedFile);
                attachBtn.textContent = attachedFile
                    ? `${vid ? "🎬" : "📷"} ${attachedFile.name}`
                    : "📷 Прикрепить превью";
                attachThumb.style.display = "none";
                attachVid.style.display = "none";
                attachClear.style.display = attachedFile ? "" : "none";
                if (attachedFile) {
                    try {
                        const url = URL.createObjectURL(attachedFile);
                        const show = () => { try { URL.revokeObjectURL(url); } catch (e) { /* silent */ } };
                        if (vid) {
                            attachVid.src = url;
                            attachVid.style.display = "";
                            attachVid.onloadeddata = show;
                        } else {
                            attachThumb.src = url;
                            attachThumb.style.display = "";
                            attachThumb.onload = show;
                        }
                    } catch (e) { /* silent */ }
                }
            };
            attachBtn.onclick = () => { try { inputFile.click(); } catch (e) { /* silent */ } };
            inputFile.onchange = () => {
                attachedFile = (inputFile.files && inputFile.files[0]) || null;
                renderAttach();
            };
            attachClear.onclick = () => {
                attachedFile = null;
                try { inputFile.value = ""; } catch (e) { /* silent */ }
                renderAttach();
            };
            inputAttachRow.appendChild(attachBtn);
            inputAttachRow.appendChild(attachThumb);
            inputAttachRow.appendChild(attachVid);
            inputAttachRow.appendChild(attachClear);
            inputArea.appendChild(inputAttachRow);
            inputArea.appendChild(inputSaveBtn);
            renderAttach();
            // Кадр-превью из выбранного файла: одна логика на ручной ввод,
            // замену обложки и (если понадобится) другие места — st.readPreviewFile.
            const readAttachedPreview = () => st.readPreviewFile(attachedFile);

            let inputVisible = false;
            inputToggle.onclick = () => {
                inputVisible = !inputVisible;
                inputArea.style.display = inputVisible ? "flex" : "none";
                inputToggle.style.background = inputVisible ? "#2c4a73" : "#2a2a2a";
                if (inputVisible) st.panelOpened?.();
                else st.shrinkBack?.();
                // Vue: высоту ноды владеет layout (computeLayoutSize + CSS-цепочка),
                // подгонять её из JS не нужно и вредно (SPEC §22.9).
                if (!st._vuePanes) st.syncNodeSize?.();
            };

            inputSaveBtn.onclick = async () => {
                // Защита от двойного клика (§32): второй POST стартовал бы до
                // ответа первого — в лучшем случае ложное «уже есть», в худшем
                // (гонка с потоком исполнения) потерянная запись.
                if (st._saving) return;
                const text = inputText.value.trim();
                const title = inputTitle.value.trim();
                const dest = (st.selFolder && !st.selFolder.startsWith("__")) ? st.selFolder : "";
                const base = "💾 Сохранить промпт";
                if (!text) {
                    inputSaveBtn.textContent = "⚠️ Пусто — нечего сохранять";
                    setTimeout(() => { inputSaveBtn.textContent = base; }, 1500);
                    return;
                }
                st._saving = true;
                inputSaveBtn.textContent = "⏳ Сохраняю...";
                try {
                    const prev = await readAttachedPreview();
                    if (attachedFile && !prev) {
                        // Файл выбран, а кадр снять не удалось (битый/экзотический
                        // кодек): запись сохраняем, но не молчим — иначе выглядит
                        // как «превью просто пропало».
                        console.warn("[PromptLibrary] preview: не удалось прочитать файл", attachedFile.name);
                        st.hintSticky = "Превью не прикрепилось: браузер не смог прочитать этот файл.";
                        st.renderHint?.();
                    }
                    const r = await st.apiPost("/prompt_library/add", { prompt: text, folder: dest, title,
                        ...(prev ? { preview_data: prev.dataUrl, media: prev.media } : {}) });
                    if (r.ok) {
                        let dup = null;
                        try { dup = await r.json(); } catch (e) { /* silent */ }
                        await reload();
                        if (dup && dup.duplicate) {
                            const where = dup.folder || "корне";
                            inputSaveBtn.textContent = `⚠️ Уже есть в «${where}»`;
                            try {
                                st.toast("warn", "Prompt Library: дубликат",
                                    `Такой промпт уже есть в «${where}» — новая запись не создана.`);
                            } catch (e) { /* silent */ }
                        } else {
                            inputSaveBtn.textContent = "✅ Сохранено";
                            inputText.value = "";
                            inputTitle.value = "";
                        }
                        attachedFile = null;
                        try { inputFile.value = ""; } catch (e) { /* silent */ }
                        renderAttach();
                    } else {
                        inputSaveBtn.textContent = "❌ Ошибка";
                    }
                } catch (err) { inputSaveBtn.textContent = "❌ Ошибка"; }
                st._saving = false;
                setTimeout(() => { inputSaveBtn.textContent = base; }, 1500);
            };

            // Ряд: дерево папок | список книг
            // flex:1 — забирает всё свободное место root при ресайзе ноды вниз
            const main = document.createElement("div");
            main.className = "pl-main";
            main.style.cssText = "display:flex;gap:6px;min-height:0;flex:1 1 auto;";

            const treeBox = document.createElement("div");
            treeBox.style.cssText = "width:34%;min-width:110px;display:flex;flex-direction:column;gap:4px;flex-shrink:0;";
            const treeHead = document.createElement("div");
            treeHead.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
            const treeTitle = document.createElement("div");
            treeTitle.style.cssText = "color:#888;font-size:11px;font-weight:bold;";
            treeTitle.textContent = "📁 Категории";
            const newFolderBtn = document.createElement("button");
            newFolderBtn.textContent = "+ Категория";
            newFolderBtn.title = "Создать категорию (в текущей — подкатегорию)";
            // Жёлтая кнопка с чёрным текстом (как просил пользователь): остальные
            // кнопки шапки цветные, серая терялась, а на жёлтом чёрный читается.
            newFolderBtn.style.cssText = "background:#e8c33a;color:#111;border:1px solid #c9a72f;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;font-weight:bold;";
            const exportBtn = document.createElement("button");
            exportBtn.textContent = "📤 Экспорт";
            exportBtn.title = "Экспорт на диск: при Ctrl/Shift-выделении — отмеченные записи и категории, иначе — текущая категория (с подкатегориями)";
            // flex-shrink:0 (v1.53) — кнопки не сжимаются: дефицит ширины
            // берёт на себя подпись ряда (см. exportCaption).
            exportBtn.style.cssText = "flex-shrink:0;background:#2c4a73;color:#dfe8ff;border:1px solid #4a6a9a;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;";
            exportBtn.onclick = () => {
                const smartMarked = (st.markEntries.size + st.markFolders.size) > 0;
                if (smartMarked) return st.exportMarked?.();
                return st.exportFolder?.(st.selFolder || "__all");
            };
            // Галерея (v1.46, §41): html-экспорт с обложками и параметрами
            // генерации. Та же умная логика выбора, что у .md-кнопки Экспорт.
            // v1.48: подпись и значок — как у карточки («🌐 В HTML»), кнопка
            // покинула шапку проводника вместе с «Экспорт» (см. exportRow).
            const galleryBtn = document.createElement("button");
            galleryBtn.textContent = "🌐 Экспорт в HTML";
            galleryBtn.title = "Экспорт галереи в HTML (prompt_library.html + обложки): при Ctrl/Shift-выделении — отмеченные записи и категории, иначе — текущая категория (с подкатегориями)";
            galleryBtn.style.cssText = "flex-shrink:0;background:#3a2c6a;color:#ece7ff;border:1px solid #6a5aa0;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;";
            galleryBtn.onclick = () => {
                const smartMarked = (st.markEntries.size + st.markFolders.size) > 0;
                if (smartMarked) return st.exportMarkedHtml?.();
                return st.exportFolderHtml?.(st.selFolder || "__all");
            };
            // Импорт: v1.48 держал место выключенной кнопкой, v1.56 включает
            // первый рабочий источник (.md + обложки) — та же строка, раскладка
            // не менялась. Источники PNG/HTML/текст видны в меню и ждут своих
            // шагов (§49).
            const importBtn = document.createElement("button");
            importBtn.textContent = "📥 Импорт";
            importBtn.title = "Импорт в библиотеку: .md с обложками, PNG, HTML-галерея, текст";
            importBtn.style.cssText = "flex-shrink:0;background:#2c4a73;color:#dfe8ff;border:1px solid #4a6a9a;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;";
            importBtn.onclick = () => { try { st.importStart?.(); } catch (e) { /* silent */ } };
            // Ряд экспорта/импорта (v1.48): отдельная строка под окном ручного
            // ввода и над тулбаром — в шапке проводника остаётся только
            // «+ Категория» (там кнопки не помещались и спорили с деревом).
            // v1.52: здесь же справа живёт массовое удаление (`margin-left:auto`),
            // потому что это ДЕЙСТВИЕ — ему место среди действий, а счётчик
            // помеченного и «снять метки» — это СОСТОЯНИЕ и остаётся в нижней
            // строке (hintRow). Высоту строки кнопка не меняет (ряд 22px +
            // flex-shrink:0), поэтому BASE_H не тронут.
            const exportRow = document.createElement("div");
            exportRow.className = "pl-export-row";
            exportRow.style.cssText = "display:flex;align-items:center;gap:6px;height:22px;flex-shrink:0;overflow:hidden;";
            const exportCaption = document.createElement("span");
            exportCaption.textContent = "Библиотека:";
            // v1.53: ЕДИНСТВЕННЫЙ сжимаемый элемент ряда. Когда места мало
            // (минимум ноды + активные метки с «🗑» и «✖»), дефицит забирает
            // подпись (многоточие), а кнопки остаются целыми: у них
            // `flex-shrink:0`. Наоборот (как было) сжимались именно кнопки,
            // и подписи «📤 Экспорт» / «🌐 Экспорт в HTML» резались.
            exportCaption.style.cssText = "flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888;font-size:11px;";
            exportRow.appendChild(exportCaption);
            exportRow.appendChild(exportBtn);
            exportRow.appendChild(galleryBtn);
            exportRow.appendChild(importBtn);
            // Массовое удаление добавляется ниже, в блоке bulk-элементов
            // (v1.52): `exportRow` создан раньше, а кнопка — позже.
            const treeHeadBtns = document.createElement("div");
            treeHeadBtns.style.cssText = "display:flex;align-items:center;gap:4px;";
            treeHeadBtns.appendChild(newFolderBtn);
            treeHead.appendChild(treeTitle);
            treeHead.appendChild(treeHeadBtns);
            const tree = document.createElement("div");
            // Тянется с нодой и СЖИМАЕТСЯ до отведённого места (min-height:0):
            // пол даёт минимальная высота ноды (computeLayoutSize), а не CSS.
            // С полом на панелях контент вылезал за root и его перекрывал
            // следующий сосед (detail) — «область с кнопками стала перекрыта»
            // (номинальный DETAIL_H=280 < реальной высоты панели + разница шрифтов).
            tree.style.cssText = "display:flex;flex-direction:column;gap:2px;flex:1 1 0;min-height:0;overflow-y:auto;border:1px solid #333;border-radius:4px;padding:4px;background:#191919;";
            treeBox.appendChild(treeHead);
            treeBox.appendChild(tree);

            const list = document.createElement("div");
            list.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;flex-shrink:0;";
            // Заголовок списка: пустой распорник — верх первой карточки совпадает
            // с верхом дерева (treeHead). Счётчик меток живёт в нижней строке
            // (hintRow), а массовое удаление — в ряду действий (exportRow, v1.52).
            const listHead = document.createElement("div");
            listHead.style.cssText = "height:22px;flex-shrink:0;display:flex;align-items:center;";
            // Подключение к доп. выходу без перетаскивания: выделите карточку (или
            // откройте категорию) и нажмите кнопку — то же, что дропнуть в
            // «🔌 Выходы» (v1.44 §40). Живёт в пустой шапке списка — там же по
            // высоте, что шапка проводника, и ничего не сдвигает.
            const bindOutBtn = document.createElement("button");
            bindOutBtn.textContent = "🔌 Подключить выход";
            bindOutBtn.title = "Подключить выделенную карточку (или текущую категорию) как доп. выход в категории «🔌 Выходы»";
            bindOutBtn.style.cssText = "background:#2e6b4f;color:#e8fff0;border:1px solid #3f8a63;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;white-space:nowrap;flex-shrink:0;";
            bindOutBtn.onclick = () => {
                try {
                    const selId = selWidget ? String(selWidget.value || "") : "";
                    const ent = selId ? st.entries.find((x) => x.id === selId) : null;
                    const before = st.readOutSlots().length;
                    if (ent) {
                        const already = st.outSlotOfEntry(ent.id);
                        if (already) {
                            st.toast("warn", "Prompt Library: выходы",
                                `Эта карточка уже подключена к выходу «промпт ${already.i}».`);
                            return;
                        }
                        st.bindOutSlot({ kind: "card", id: ent.id, name: ent.title || ent.head || ent.id });
                        st.hintSticky = `Карточка «${(ent.title || ent.head || ent.id).slice(0, 40)}» подключена к выходу «промпт ${before + 2}» (категория «🔌 Выходы»).`;
                        st.renderHint?.();
                        return;
                    }
                    const f = st.selFolder;
                    if (f && !f.startsWith("__")) {
                        const already = st.outSlotOfFolder(f);
                        if (already) {
                            st.toast("warn", "Prompt Library: выходы",
                                `Эта категория уже подключена к выходу «промпт ${already.i}».`);
                            return;
                        }
                        st.bindOutSlot({ kind: "folder", path: f, active_id: "", name: f.split("/").pop() || f });
                        st.hintSticky = `Категория «${f}» подключена к выходу «промпт ${before + 2}» — внутри неё выберите карточку вывода.`;
                        st.renderHint?.();
                        return;
                    }
                    st.toast("warn", "Prompt Library: выходы",
                        "Сначала выберите карточку или категорию — «Всё»/«Избранное»/«Без категории» подключить нельзя.");
                } catch (e) { /* silent */ }
            };
            listHead.appendChild(bindOutBtn);
            list.appendChild(listHead);
            // Контент списка (скроллируемый). Сжимается (min-height:0), см. tree.
            const listContent = document.createElement("div");
            listContent.style.cssText = "display:flex;flex-direction:column;gap:4px;flex:1 1 0;min-height:0;overflow-y:auto;";
            list.appendChild(listContent);

            // Слева список книг, справа проводник категорий
            main.appendChild(list);
            main.appendChild(treeBox);

            // Нижняя строка: ОДНА фиксированная (22px) — в ней либо подсказка,
            // либо СЧЁТЧИК помеченного. Оба массовых действия («🗑» и «✖») уехали
            // в ряд действий — exportRow (v1.52–v1.53), здесь остался чистый
            // СТАТУС. Рост строки исключён (height + flex-shrink:0), поэтому
            // появление элементов не отжимает место у списка/дерева. Счётчик
            // сжимается с многоточием (flex:1 1 auto + min-width:0) — в listHead
            // его выдавливало за правый край строки и резало overflow:hidden.
            const hintRow = document.createElement("div");
            hintRow.style.cssText = "display:flex;align-items:center;gap:4px;height:22px;flex-shrink:0;overflow:hidden;white-space:nowrap;";
            const hint = document.createElement("div");
            // Строго одна строка: рост подсказки отжимал бы место у списка.
            hint.style.cssText = "flex:1 1 auto;min-width:0;color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
            hint.textContent = "Запустите Queue или нажмите «Сохранить промпт» — записи появятся здесь.";
            // Элементы bulk-бара создаются один раз (без пересоздания на каждый
            // рендер) и только переключают видимость.
            const bulkCount = document.createElement("span");
            bulkCount.style.cssText = "flex:1 1 auto;min-width:0;color:#e08a3c;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;";
            const bulkDel = document.createElement("button");
            bulkDel.textContent = "🗑 Удалить";
            bulkDel.title = "Удалить помеченные записи и категории";
            // margin-left:auto — уезжает к правому краю ряда действий (v1.52).
            // В невидимом состоянии (display:none) на раскладку не влияет.
            bulkDel.style.cssText = "display:none;margin-left:auto;background:#5a2b2b;color:#ffd9d9;border:1px solid #a33;border-radius:4px;padding:0 8px;cursor:pointer;font-size:11px;flex-shrink:0;";
            bulkDel.onclick = () => st.bulkDelete?.();
            // v1.52: удаление живёт в РЯДУ ДЕЙСТВИЙ справа (а не в нижней строке);
            // `margin-left:auto` прижимает его к правому краю, отбивая от экспортов.
            // v1.53: «✖ снять метки» — рядом с ним: это одна группа массовых
            // ДЕЙСТВИЙ над метками, висеть врозь (удаление сверху, отмена внизу)
            // неудобно. `margin-left:auto` стоит на ПЕРВОМ элементе группы,
            // поэтому пара едет вправо целиком и с обычным зазором внутри.
            exportRow.appendChild(bulkDel);
            const bulkClear = document.createElement("button");
            bulkClear.textContent = "✖";
            bulkClear.title = "Снять все метки (Esc)";
            bulkClear.style.cssText = "display:none;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:0 8px;cursor:pointer;font-size:11px;flex-shrink:0;";
            bulkClear.onclick = () => st.clearMarks?.();
            exportRow.appendChild(bulkClear);   // v1.53: вплотную к «🗑 Удалить»
            // Прогресс-бар массового экспорта: показывается именно во время
            // экспорта (иначе display:none), живёт в фиксированной строке 22px,
            // поэтому высоту ноды не двигает. Растягивается на всю свободную
            // ширину строки (flex:1 1 0) — «резиновый», вместе с нодой (как
            // flex-дерево выше); размеров DOM не читает, feedback loop невозможен.
            const progTrack = document.createElement("div");
            progTrack.style.cssText = "display:none;flex:1 1 0;min-width:0;height:12px;border:1px solid #4a6a9a;border-radius:4px;background:#1a1a1a;overflow:hidden;flex-shrink:0;";
            const progFill = document.createElement("div");
            progFill.style.cssText = "width:0%;height:100%;background:linear-gradient(90deg,#3a6ea5,#5ba3e0);transition:width .15s ease;";
            progTrack.appendChild(progFill);
            hintRow.appendChild(hint);
            hintRow.appendChild(progTrack);
            hintRow.appendChild(bulkCount);

            // --- Подхват текста из другого узла (v1.25) ----------------------
            // Граф «карточка → LLM → финальный текст» одной нодой требует провода
            // НАЗАД в ту же ноду — это кольцо, а ComfyUI исполняет только ацикличный
            // граф (поэтому раньше нужны были две ноды). Вместо провода текст
            // выбранного узла забирается после прогона (см. savePickup ниже).
            // Строка фиксированной высоты (22px + flex-shrink:0): подпись/рост не
            // отжимают место у панелей и не вылезают за бюджет root (SPEC §28).
            const pickupRow = document.createElement("div");
            pickupRow.style.cssText = "display:flex;align-items:center;gap:6px;height:22px;flex-shrink:0;";
            const pickupLabel = document.createElement("div");
            pickupLabel.textContent = "📎 Текст в базу:";
            pickupLabel.title = "Откуда брать текст для новой записи. «Из входа» — как раньше (по проводу). " +
                "«Из узла» — подхват готового текста другого узла после прогона: без провода назад, потому что провод назад даёт кольцо";
            pickupLabel.style.cssText = "color:#888;font-size:11px;flex-shrink:0;white-space:nowrap;";
            const pickupSel = document.createElement("select");
            pickupSel.style.cssText = "flex:1 1 auto;min-width:0;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:0 4px;height:22px;font-size:11px;";
            pickupRow.appendChild(pickupLabel);
            pickupRow.appendChild(pickupSel);

            // --- Панель книги: название, полка, полный текст ---
            const detail = document.createElement("div");
            detail.style.cssText = "display:none;flex-direction:column;gap:4px;border:1px solid #4a9eff;border-radius:4px;padding:6px;background:#16202f;flex-shrink:0;max-height:320px;overflow-y:auto;";

            const dTitle = document.createElement("input");
            dTitle.placeholder = "Название";
            dTitle.readOnly = true;
            dTitle.style.cssText = "background:#111;color:#fff;border:1px solid #444;border-radius:4px;padding:4px 6px;font-size:12px;font-weight:bold;";
            const dFolder = document.createElement("input");
            dFolder.placeholder = "Категория: Фото/Портреты";
            dFolder.readOnly = true;
            dFolder.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 6px;font-size:11px;";
            const dText = document.createElement("textarea");
            dText.readOnly = true;
            dText.rows = 10;
            dText.style.cssText = "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:4px;font-size:11px;overflow-y:auto;resize:none;";
            const dMeta = document.createElement("div");
            dMeta.style.cssText = "color:#777;font-size:10px;";

            const dBtns = document.createElement("div");
            dBtns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
            const mkBtn = (label, title) => {
                const b = document.createElement("button");
                b.textContent = label; b.title = title;
                b.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;";
                return b;
            };
            const bCopy = mkBtn("📋 Копировать", "Скопировать полный текст в буфер обмена");
            const bEdit = mkBtn("✏️ Редактировать", "Изменить название, категорию и текст");
            const bSave = mkBtn("💾 Сохранить", "Сохранить изменения");
            bSave.style.display = "none";
            // Отмена правок: возврат к значениям из базы. Живёт только в режиме
            // редактирования (как 💾): в просмотре отменять нечего.
            const bCancel = mkBtn("✖ Отмена", "Выйти из редактирования, не сохраняя изменения");
            bCancel.style.display = "none";
            bCancel.onclick = async () => {
                if (!st.detailId) return;
                const full = st.full.get(st.detailId) || {};
                // Спрашиваем только когда есть что терять: «зашёл и передумал» —
                // тихий возврат, иначе диалог раздражал бы на ровном месте.
                const dirty = st.dTitle.value !== (full.title || "")
                    || st.dFolder.value !== (full.folder || "")
                    || st.dText.value !== (full.prompt || "");
                if (dirty) {
                    let ok = false;
                    try {
                        ok = await app.extensionManager.dialog.confirm({
                            title: "Отменить изменения",
                            message: "Правки названия, категории и текста не сохранятся. Выйти из редактирования?",
                        });
                    } catch (e) {
                        ok = confirm("Отменить изменения? Правки не сохранятся.");
                    }
                    if (!ok) return;
                }
                // Возврат — это ровно «открыть в режиме просмотра»: одна точка
                // правды (fillDetail), а не второй ручной сброс полей.
                await st.fillDetail?.(st.detailId);
                if (dirty) {
                    st.hintSticky = "Правки отменены — значения взяты из базы заново.";
                    st.renderHint?.();
                }
            };
            const bWorkflow = mkBtn("📥 Воркфлоу", "Открыть сохранённый воркфлоу на канвасе (текущий будет заменён)");
            bWorkflow.style.display = "none";
            // Замена обложки существующей записи (v1.26): картинка или видео
            // с диска, у видео — первый кадр. Провод и новый прогон не нужны.
            const bPreviewLabel = (media) => (media === "video" ? "🎬 Заменить превью" : "🖼 Заменить превью");
            const bPreview = mkBtn("🖼 Заменить превью", "Заменить обложку записи: картинка или видео с диска (у видео — первый кадр). Появляется в режиме редактирования");
            // Скрыта до ✏️ Редактировать: обложка — содержимое записи, а не действие
            // просмотра (рядом с 💾, а не с 📋/🗂).
            bPreview.style.display = "none";
            const dPreviewFile = document.createElement("input");
            dPreviewFile.type = "file";
            dPreviewFile.accept = "image/*,video/*";
            dPreviewFile.style.display = "none";
            bPreview.onclick = () => { try { dPreviewFile.value = ""; dPreviewFile.click(); } catch (e) { /* silent */ } };
            dPreviewFile.onchange = async () => {
                const f = (dPreviewFile.files && dPreviewFile.files[0]) || null;
                if (!f || !st.detailId) return;
                const id = st.detailId;
                // Снимок ДО замены: подпись кнопки восстанавливаем по нему
                // (свежая запись ещё не перечитана, если запрос упал).
                const cur = st.full.get(id) || {};
                const restore = () => { bPreview.textContent = bPreviewLabel(cur.media); };
                bPreview.textContent = "⏳ Читаю файл...";
                try {
                    const prev = await st.readPreviewFile(f);
                    if (!prev) {
                        // Не молчим: иначе «нажал — ничего не произошло»
                        console.warn("[PromptLibrary] replace preview: файл не прочитался", f.name);
                        st.hintSticky = `Превью не заменено: браузер не смог прочитать «${f.name}».`;
                        st.renderHint?.();
                        bPreview.textContent = "⚠️ Файл не прочитался";
                        setTimeout(restore, 1500);
                        return;
                    }
                    // Замена НЕОБРАТИМА: старый файл обложки перезаписывается на месте,
                    // вернуть его нельзя. Спрашиваем — как перед удалением записи.
                    let ok = false;
                    const what = prev.media === "video" ? "первый кадр видео" : "картинка";
                    try {
                        ok = await app.extensionManager.dialog.confirm({
                            title: "Заменить превью",
                            message: `Обложка записи «${st.dTitle.value || id}» будет перезаписана (${what}). `
                                + "Вернуть прежнюю обложку нельзя.",
                        });
                    } catch (e) {
                        ok = confirm(`Заменить обложку записи «${st.dTitle.value || id}» (${what})? `
                            + "Прежняя обложка будет потеряна.");
                    }
                    if (!ok) { restore(); return; }
                    const r = await st.apiPost("/prompt_library/attach_preview",
                        { id, preview_data: prev.dataUrl, media: prev.media, force: true });
                    if (!r.ok) {
                        let out = {};
                        try { out = await r.json(); } catch (e) { /* silent */ }
                        console.warn("[PromptLibrary] replace preview failed:", r.status, out);
                        bPreview.textContent = `❌ Ошибка ${r.status}`;
                        setTimeout(restore, 1500);
                        return;
                    }
                    // Тот же URL превью кэшируется по created_at — без локальной
                    // метки карточка показала бы старую обложку
                    st.previewStamp.set(id, Date.now());
                    // Режим редактирования НЕ сбрасываем: в полях может быть
                    // несохранённый текст, а обложка к нему отношения не имеет.
                    const known = st.full.get(id);
                    if (known) known.media = prev.media;
                    st.fillMeta?.(known || { id, media: prev.media });
                    bPreview.textContent = bPreviewLabel(prev.media);
                    await reload();
                    st.hintSticky = prev.media === "video"
                        ? "Обложка заменена: сохранён первый кадр видео, метка 🎬 видео."
                        : "Обложка заменена: метка 📷 фото.";
                    st.renderHint?.();
                } catch (err) {
                    console.warn("[PromptLibrary] replace preview error:", err);
                    bPreview.textContent = "❌ Ошибка";
                    setTimeout(restore, 1500);
                }
            };
            dBtns.appendChild(dPreviewFile);
            dBtns.appendChild(bCopy);
            dBtns.appendChild(bEdit);
            dBtns.appendChild(bSave);
            dBtns.appendChild(bCancel);
            dBtns.appendChild(bWorkflow);
            dBtns.appendChild(bPreview);
            bWorkflow.onclick = () => { try { st.openWorkflow?.(st.detailId); } catch (e) { /* silent */ } };

            // Экспорт записи в папку на диске (v1.33, §38): по клику —
            // системный выбор папки (showDirectoryPicker, Chrome/Edge). С
            // обложкой — создаётся подпапка <title>/ и в неё пишутся <title>.md
            // (текст + метаданные) + обложка; без обложки — только <title>.md
            // прямо в выбранную папку. Никаких тонких мест вроде sizing — файл
            // сохраняется браузером напрямую.
            const bExport = mkBtn("💾 Экспортировать", "Сохранить запись на диск: с обложкой — в подпапку <название>/, без обложки — файл .md в выбранную папку");
            bExport.onclick = () => { try { st.exportEntry?.(); } catch (e) { /* silent */ } };
            dBtns.appendChild(bExport);
            // Галерея одной записи (v1.46, §41): html-карточка + обложка
            // в выбранную папку (файл prompt_library.html + <title>.png рядом).
            const bGallery = mkBtn("🌐 В HTML", "Сохранить запись как HTML-галерею: prompt_library.html + обложку <title>.png в выбранную папку");
            bGallery.onclick = () => { try { st.exportEntryHtml?.(); } catch (e) { /* silent */ } };
            dBtns.appendChild(bGallery);

            detail.appendChild(dTitle);
            detail.appendChild(dFolder);
            detail.appendChild(dText);
            detail.appendChild(dMeta);
            detail.appendChild(dBtns);

            // Vue (Nodes 2.0): main+detail переезжают внутрь scrollArea — так
            // переполнение уходит в скролл, а не за границу ноды. В канвасе
            // scrollArea не используется вовсе: main/detail остаются прямыми
            // детьми root, ровно как раньше (не трогаем рабочий путь §22.4).
            const scrollArea = document.createElement("div");
            scrollArea.className = "pl-scroll";
            scrollArea.style.cssText = "display:flex;flex-direction:column;gap:6px;";

            root.appendChild(pickupRow);
            root.appendChild(inputToggle);
            root.appendChild(inputArea);
            root.appendChild(exportRow);
            root.appendChild(toolbar);
            root.appendChild(main);
            root.appendChild(detail);
            root.appendChild(hintRow);

            const st = {
                root, main, search, sortSel, viewSel, mediaSel, tree, list: listContent, listHead, hintRow, hint, detail,
                pickupRow, pickupSel, inputTitle,
                bulkCount, bulkDel, bulkClear,
                progTrack, progFill, exportRow, exportCaption, exportBtn, galleryBtn, importBtn, newFolderBtn,
                // Наружу — чтобы живая проба мерила ряд действий именно на том
                // минимуме, которым живёт нода (без дублирования числа в тесте).
                minW: MIN_W,
                dTitle, dFolder, dText, dMeta, bSave, bWorkflow, bPreview, bEdit, bCancel, bExport, bGallery,
                entries: [], folders: [], full: new Map(),
                pinnedFolders: new Set(),
                // id записей, найденных серверным полнотекстовым поиском (v1.27);
                // null = активного поиска нет (обычный локальный фильтр)
                deepIds: null,
                // Локальная метка «обложка заменена» (v1.26): URL превью кэшируется
                // по created_at, без метки браузер показал бы старую картинку.
                previewStamp: new Map(),
                detailId: null, selFolder: "__all",
                // Мультивыделение на удаление (Ctrl — поштучно, Shift — диапазон).
                // Живёт только в сессии, в PNG не персистится; цель сохранения
                // (selFolder) метки не меняют — конфликта «куда сохранять» нет.
                markEntries: new Set(), markFolders: new Set(),
                anchorEntry: null, anchorFolder: null, folderOrder: [],
                hintMsg: "Запустите Queue или нажмите «Сохранить промпт» — записи появятся здесь.",
                // Стойкое сообщение (например, «дубликат не сохранён»): hintMsg виден
                // только при открытой панели книги, а этот — всегда, до действия
                // пользователя (клик по папке/карточке сбрасывает).
                hintSticky: null,
                // v1.44 (§40): привязки доп. выходов. Зеркало скрытого виджета
                // slots_out: [{i, kind:"card"|"folder", id|path, active_id?, name?}].
                slotsOut: [],
                // v1.44: какая папка-слот сейчас открыта в категории «Выходы»
                outsActiveFolder: "",
            };
            this._pl = st;
            plLiveStates.add(st);
            st.version = PL_JS_VERSION;

            // --- Подхват: выбор узла-источника (v1.25) ----------------------
            // Кандидаты — узлы верхнего уровня графа, которые могут отдать
            // текст: STRING-выход или строковый виджет (text/value/string).
            // Своя нода и mute-узлы не предлагаются (mute не исполнится).
            st.pickupWidget = () => this.widgets?.find((w) => w.name === "pickup") || null;
            st.pickupNode = () => {
                try { return String((st.pickupWidget() || {}).value || "").trim(); }
                catch (e) { return ""; }
            };
            st.setPickup = (val) => {
                try {
                    const w = st.pickupWidget();
                    if (w && w.value !== val) w.value = val;
                } catch (e) { /* silent */ }
            };
            st.pickupCandidates = () => {
                const out = [];
                try {
                    const nodes = (app.graph && app.graph._nodes) || [];
                    for (const n of nodes) {
                        if (!n || n === this) continue;
                        if (String(n.type || "") === "PromptLibrary") continue;
                        // Узлы в режимах mute и bypass не исполняются: у LiteGraph
                        // NEVER = 2 (mute), BYPASS = 4 (bypass) — ровно та пара, по
                        // которой фронтенд сам считает узел неактивным
                        // (app.ts: isMuted = mode === NEVER || mode === BYPASS).
                        // Раньше здесь был только 4: mute-узел предлагался, хотя
                        // не мог отдать текст после прогона (§32).
                        if (n.mode === 2 || n.mode === 4) continue;
                        const hasStrOut = (n.outputs || []).some((o) => o
                            && String(o.type || "").toUpperCase().indexOf("STRING") >= 0);
                        const hasTextW = (n.widgets || []).some((w) => w && typeof w.value === "string"
                            && (w.type === "customtext" || w.type === "string"
                                || ["text", "value", "string", "prompt"].indexOf(String(w.name || "").toLowerCase()) >= 0));
                        if (!hasStrOut && !hasTextW) continue;
                        const title = String(n.title || n.type || "").slice(0, 40);
                        out.push({ id: String(n.id), label: `#${n.id} · ${title} (${n.type || "?"})` });
                    }
                } catch (e) { /* silent */ }
                out.sort((a, b) => a.label.localeCompare(b.label));
                return out;
            };
            st.refreshPickupOptions = () => {
                try {
                    const cur = st.pickupNode();
                    const list = st.pickupCandidates();
                    pickupSel.replaceChildren();
                    const add = (value, text, title) => {
                        const o = document.createElement("option");
                        o.value = value;
                        o.textContent = text;
                        if (title) o.title = title;
                        pickupSel.appendChild(o);
                    };
                    add("", "— из входа (провод) —",
                        "Как раньше: сохраняем текст, пришедший на вход «Промт»");
                    for (const c of list) add(c.id, c.label);
                    if (cur && !list.some((c) => c.id === cur)) {
                        // Узел удалён/переименован — не молчим: иначе непонятно, почему
                        // запись не создаётся (подхват ищет несуществующий id).
                        add(cur, `⚠️ узел #${cur} не найден`, "В графе нет узла с таким id");
                        console.warn("[PromptLibrary] pickup: узел не найден в графе:", cur);
                    }
                    pickupSel.value = cur;
                } catch (e) { /* silent */ }
            };
            pickupSel.onchange = () => {
                try {
                    const v = pickupSel.value;
                    st.setPickup(v);
                    st.hintSticky = v
                        ? `Подхват: текст для записи возьмём из узла #${v} после прогона (без провода назад).`
                        : null;
                    st.renderHint?.();
                } catch (e) { /* silent */ }
            };
            // Список узлов пересобираем перед открытием списка: без таймеров и
            // без отслеживания графа (в графе мог появиться новый текстовый узел).
            pickupSel.onmousedown = () => st.refreshPickupOptions?.();

            st.toast = (severity, summary, detail) => {
                try {
                    app.extensionManager.toast.add({ severity, summary, detail, life: 6000 });
                } catch (e) { /* silent */ }
            };
            // Единая точка для всех POST, меняющих базу: ответ пришёл — сервер уже
            // записал (и разослал WS-сигнал), но соседняя нода этой страницы получит
            // его с задержкой — перечитываем её сразу. Забыть вызов в новом хендлере
            // невозможно: мутации идут только через st.apiPost (§26.9).
            // opts.quiet — не дёргать соседние ноды на КАЖДОМ запросе: массовая
            // заливка обложек при импорте (v1.56) шлёт сотни POST, и обновление
            // после каждого — сотни лишних перечитываний базы. Вызывающий
            // обязан сам обновить всех один раз в конце.
            st.apiPost = async (path, payload, opts) => {
                const r = await fetch(path, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload || {}),
                });
                if (r && r.ok && !(opts && opts.quiet)) {
                    try { plRefreshLocal(st); } catch (e) { /* silent */ }
                }
                return r;
            };

            // Открыть воркфлоу записи на канвасе (как дроп PNG с workflow).
            // Деструктивно (заменяет текущий граф) — всегда через confirm.
            st.openWorkflow = async (id) => {
                if (!id) return;
                try {
                    let full = st.full.get(id);
                    if (!full || !full.workflow) {
                        const r = await fetch(`/prompt_library/entry?id=${encodeURIComponent(id)}`);
                        if (!r.ok) { st.toast("warn", "Prompt Library", "Не удалось прочитать запись."); return; }
                        full = await r.json();
                        st.full.set(id, full);
                    }
                    if (!full || !full.workflow) {
                        st.toast("warn", "Prompt Library: нет воркфлоу",
                            "У записи нет сохранённого воркфлоу (сохранена вручную или старой версией). Прогони Queue с этим промптом — воркфлоу прикрепится.");
                        return;
                    }
                    let ok = false;
                    try {
                        ok = await app.extensionManager.dialog.confirm({
                            title: "Открыть воркфлоу",
                            message: "Загрузить воркфлоу из записи? Текущий воркфлоу на канвасе будет заменён.",
                        });
                    } catch (e) {
                        ok = confirm("Загрузить воркфлоу из записи? Текущий воркфлоу будет заменён.");
                    }
                    if (!ok) return;
                    if (typeof app.loadGraphData !== "function") {
                        st.toast("error", "Prompt Library", "Фронтенд не даёт loadGraphData.");
                        return;
                    }
                    await app.loadGraphData(full.workflow);
                } catch (err) { st.toast("error", "Prompt Library", "Не удалось открыть воркфлоу."); }
            };

            // Drop карточки на канвас: кастомный MIME-тип (файлов нет, файловый
            // хендлер ComfyUI нас игнорирует). Слушатели — capture на canvas:
            // наш тип забираем себе (stopImmediatePropagation), чужое не трогаем.
            st.hookCanvasDrop = () => {
                try {
                    if (window.__plCanvasDropHooked) return;
                    const cv = app.canvas && app.canvas.canvas;
                    if (!cv || typeof cv.addEventListener !== "function") return;
                    cv.addEventListener("dragover", (ev) => {
                        try {
                            const t = (ev.dataTransfer && ev.dataTransfer.types) || [];
                            if (Array.prototype.includes.call(t, "application/x-pl-entry")) {
                                ev.preventDefault();
                                ev.dataTransfer.dropEffect = "copy";
                            }
                        } catch (e) { /* silent */ }
                    }, true);
                    cv.addEventListener("drop", async (ev) => {
                        let ids = null;
                        try {
                            const t = (ev.dataTransfer && ev.dataTransfer.types) || [];
                            if (!Array.prototype.includes.call(t, "application/x-pl-entry")) return;
                            const raw = ev.dataTransfer.getData("application/x-pl-entry") || null;
                            if (raw) ids = raw.split(",").filter(Boolean);
                        } catch (e) { return; }
                        if (!ids || !ids.length) return;
                        ev.preventDefault();
                        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
                        let live = null;
                        try { for (const s of plLiveStates) { live = s; break; } } catch (e) { /* silent */ }
                        await (live || st).openWorkflow(ids[0]);
                    }, true);
                    window.__plCanvasDropHooked = true;
                } catch (e) { /* silent */ }
            };
            st.hookCanvasDrop();

            // Двухрежимный layout (SPEC §22.9): высоту виджету даёт и канвас, и
            // Vue-режим (Nodes 2.0), поэтому раскладка общая, разница — только в
            // способе увести переполнение (scrollArea). Прежнее утверждение, что
            // во Vue обёртка content-sized и flex-цепочку нечем ограничить, —
            // неверно: см. факты про hasLayoutSize/gridTemplateRows в §22.9.
            // Детект: авторитетный `window.LiteGraph.vueNodesMode`, затем Settings API
            // (docs: app.extensionManager.setting.get(id)), затем ui.settings.
            st.isVueNodes = () => {
                try {
                    const lg = window.LiteGraph;
                    if (lg && typeof lg.vueNodesMode === "boolean") return lg.vueNodesMode;
                } catch (e) { /* silent */ }
                try {
                    const em = app.extensionManager;
                    if (em && em.setting && typeof em.setting.get === "function") {
                        const v = em.setting.get("Comfy.VueNodes.Enabled");
                        if (v !== undefined && v !== null) return !!v;
                    }
                } catch (e) { /* silent */ }
                try {
                    const s = app.ui && app.ui.settings;
                    if (s && typeof s.getSettingValue === "function") {
                        const v = s.getSettingValue("Comfy.VueNodes.Enabled");
                        if (v !== undefined && v !== null) return !!v;
                    }
                } catch (e) { /* silent */ }
                return false;
            };
            // Min-width ноды в Vue-режиме: ядро берёт node.style.min-width
            // инлайн или 225 по дефолту (useNodeResize) — наш MIN_W через setSize
            // туда не доходит. Ставим напрямую на [data-node-id] (семантический
            // атрибут, не build-хэш). В канвасе такого элемента нет → no-op.
            st.applyNodeMinWidth = () => {
                try {
                    const nodeEl = root.closest && root.closest("[data-node-id]");
                    if (!nodeEl || !(nodeEl instanceof HTMLElement)) return;
                    nodeEl.style.minWidth = MIN_W + "px";
                } catch (e) { /* silent */ }
            };
            // Авто-подгонка высоты (chromeMin + setSize по прокси node.size) УДАЛЕНА
            // 2026-09-17: подход тупиковый — калибровка chrome самоблокируется
            // на высокой ноде (первая же выборка даёт target = nodeH → deadband,
            // см. SPEC §22.8). Растяжение теперь делают layout + CSS:
            // канвас — computeLayoutSize (§22.3), Vue — flex-цепочка (§22.9).
            st.applyPaneLayout = (forceVue) => {
                try {
                    st._vuePanes = (typeof forceVue === "boolean") ? forceVue : st.isVueNodes();
                    // Обрезка и отказ от собственного min-width — в ОБОИХ режимах.
                    // Vue-нода (`lg-node`) НЕ обрезает содержимое, а при живом
                    // переключении режима раскладка может остаться от прежнего
                    // режима — тогда root обрежет себя сам и не разъедется за ноду
                    // (грациозная деградация вместо развалившегося вида).
                    root.style.overflow = "hidden";
                    root.style.minWidth = "0";
                    if (st._vuePanes) {
                        // Vue (Nodes 2.0), факты из исходников фронтенда 1.52:
                        //  • NodeContent  = `flex flex-auto grow flex-col` → тело ноды
                        //    имеет реальную (не content-sized) высоту;
                        //  • NodeWidgets  получает `flex:1` и строку `auto` для нашего
                        //    виджета, т.к. hasLayoutSize = typeof computeLayoutSize
                        //    === "function" (useGraphNodeManager.ts);
                        //  • обёртка WidgetDOM (`flex flex-col *:flex-1`) отдаёт наш
                        //    root через flex:1 → root тоже реальной высоты.
                        // Значит растягивать контент можно тем же flex-приёмом, что и в
                        // канвасе (§22.3). Фиксированные 480px оставляли пустоту снизу.
                        // main+detail — в scrollArea: переполнение уходит в скролл.
                        if (scrollArea.parentNode !== root) {
                            root.insertBefore(scrollArea, hintRow);
                            scrollArea.appendChild(main);
                            scrollArea.appendChild(detail);
                        }
                        // Панели заселяют видимую область (их собственный скролл
                        // рассчитан на переполнение КАРТОЧКАМИ, а не на нехватку места).
                        for (const el of [tree, listContent]) {
                            el.style.flex = "1 1 0";
                            el.style.minHeight = "0";
                            el.style.height = "";
                        }
                        main.style.flex = "1 1 0";
                        main.style.minHeight = "0";
                        scrollArea.style.flex = "1 1 0";
                        // Пол — на scrollArea, а не на панелях: только он попадает
                        // в замер минимальной высоты контента, который в Vue задаёт
                        // высоту ноды. Иначе новая нода открывается «сжатой», а
                        // ноду можно сжать почти в ноль.
                        scrollArea.style.minHeight = PANES_MIN_H + "px";
                        scrollArea.style.overflowY = "auto";
                    } else {
                        // Канвас: раскладка ТА ЖЕ, что в Vue (высота виджета = его
                        // computedHeight, т.е. root всегда заполнен), но переполнение
                        // некуда уводить — поэтому панели ОБЯЗАНЫ сжиматься до
                        // отведённого места (flex 1 1 0 + min-height:0).
                        // Раньше здесь стоял пол min-height:480px на панелях: когда
                        // реального места было меньше пола (панель книги максимум
                        // 320px против номинальных DETAIL_H=280, другой шрифт/зум),
                        // контент вылезал за root и его перекрывал следующий сосед
                        // (detail рисуется позже) — низ списка с кнопками карточек
                        // оказывался «перекрыт». Минимальный РАЗМЕР ноды теперь задаёт
                        // только computeLayoutSize.minHeight (BASE_H) — он же в обоих
                        // режимах, поэтому панели получают ≈PANES_MIN_H при ноде
                        // минимального размера и растут вместе с ней.
                        if (scrollArea.parentNode === root) {
                            root.insertBefore(main, scrollArea);
                            root.insertBefore(detail, scrollArea);
                            root.removeChild(scrollArea);
                        }
                        for (const el of [tree, listContent]) {
                            el.style.flex = "1 1 0";
                            el.style.minHeight = "0";
                            el.style.height = "";
                        }
                        main.style.flex = "1 1 0";
                        main.style.minHeight = "0";
                    }
                    // Страховка: ничего внутри main не может нарисоваться поверх
                    // соседа (detail/hintRow) — панели скроллятся сами.
                    main.style.overflow = "hidden";
                } catch (e) { /* silent */ }
            };
            // Замер пола по root.offsetHeight (_vueFloor) УДАЛЁН по той же причине:
            // в Vue root растянут до высоты ноды, поэтому измеренный «контент» =
            // текущая высота → минимальная высота запиралась на текущей (нода не
            // сжималась никогда). Минимум в обоих режимах — константы st.minH().
            st.applyPaneLayout();
            // Смена режима БЕЗ перезагрузки страницы (canvas ↔ Nodes 2.0).
            // Сигнал №1 — перехват `LiteGraph.vueNodesMode` (его выставляет сам
            // фронтенд: это и есть момент включения Vue-рендера) — plHookVueMode().
            // Сигнал №2 — событие настроек (страховка для сборок без window.LiteGraph).
            st.onModeChange = (vue) => {
                try { st.applyPaneLayout(typeof vue === "boolean" ? vue : undefined); } catch (e) { /* silent */ }
                // Vue монтирует ноду АСИНХРОННО: в момент смены флага элемента
                // `[data-node-id]` в DOM ещё нет, поэтому min-width уходил в пустоту
                // и нода оставалась на дефолтных 350px (`min-w-(--min-node-width)` в
                // LGraphNode.vue = узкая, «сжатая»); в reload-пути то же делает rAF
                // в onNodeCreated уже после монтирования — отсюда разница «до/после F5».
                try { st.settleLayout(true); } catch (e) { /* silent */ }
                try { this.graph?.setDirtyCanvas(true, true); } catch (e) { /* silent */ }
            };
            // Применение ширины/раскладки с догоняющим кадром (без таймеров и цикла):
            // первый проход — сразу, второй (один) — на случай кадра между сменой
            // флага и монтированием Vue-ноды.
            st.settleLayout = (again) => {
                try { st.applyNodeMinWidth?.(); } catch (e) { /* silent */ }
                try { st.enforceMinWidth?.(); } catch (e) { /* silent */ }
                if (again) { try { requestAnimationFrame(() => st.settleLayout(false)); } catch (e) { /* silent */ } }
            };
            plModeWatchers.add(st.onModeChange);
            plHookVueMode();
            try {
                const s = app.ui && app.ui.settings;
                if (s && typeof s.addEventListener === "function") {
                    const onVueSetting = (ev) => {
                        // detail.value = новое значение (стор обновляется до события)
                        const v = ev && ev.detail ? ev.detail.value : undefined;
                        st.onModeChange(typeof v === "boolean" ? v : undefined);
                    };
                    s.addEventListener("Comfy.VueNodes.Enabled.change", onVueSetting);
                    st.settingsListener = onVueSetting;
                    st.settingsTarget = s;
                }
            } catch (e) { /* silent */ }

            st.enforceMinWidth = () => {
                try {
                    if (this.size[0] < MIN_W) this.setSize([MIN_W, this.size[1]]);
                } catch (e) { /* silent */ }
            };

            // Выбор дерева персистится через скрытый save_folder как есть:
            // "" = "Всё", "__fav"/"__root" = служебные ветки, иначе путь папки.
            // Python на входе режет "__*" в корень (см. execute), поэтому записи
            // в служебные имена не сохраняются — виджет безопасен для round-trip.
            st.syncSaveFolder = () => {
                try {
                    const sf = this.widgets?.find((w) => w.name === "save_folder") || saveFolderW;
                    const v = st.selFolder === "__all" ? "" : (st.selFolder || "");
                    if (sf && sf.value !== v) sf.value = v;
                } catch (e) { /* silent */ }
            };

            // --- Мультивывод (§40): привязки доп. выходов 2..11 --------------
            // Скрытый виджет slots_out несёт JSON [{i, kind, id|path, active_id, name}].
            // st.slotsOut — зеркало на время сессии; пишем в виджет при каждом
            // изменении (он персистится PNG-патчем и входит в cache-key ноды).
            // Номер выхода = место в списке: привязка №0 живёт на выходе 2
            // («промпт 2»), №1 — на выходе 3 и т.д. Список всегда НЕПРЕРЫВНЫЙ,
            // иначе номера сокетов разъехались бы с индексами RETURN_TYPES
            // (Python отдаёт значения строго по индексам 0..11).
            const OUT_SLOT_MIN = 2;
            const OUT_SLOTS_LIMIT = 10;   // выходы 2..11 при RETURN_TYPES = 12
            st.outSlotsWidget = () => this.widgets?.find((w) => w.name === "slots_out") || null;
            st.readOutSlots = () => {
                let raw = st.slotsOut;
                try {
                    const w = st.outSlotsWidget();
                    if (w && Array.isArray(w.value)) raw = w.value;
                    else if (w && typeof w.value === "string" && w.value.trim()) raw = JSON.parse(w.value);
                } catch (e) { raw = st.slotsOut; }
                if (!Array.isArray(raw)) return [];
                const arr = raw.filter((s) => s && (s.kind === "card"
                    ? (typeof s.id === "string" && !!s.id)
                    : (s.kind === "folder" && typeof s.path === "string" && !!s.path)));
                arr.sort((a, b) => (Number(a.i) || 0) - (Number(b.i) || 0));
                arr.forEach((s, idx) => { s.i = OUT_SLOT_MIN + idx; });
                return arr;
            };
            st.writeOutSlots = (arr) => {
                try {
                    const clean = (Array.isArray(arr) ? arr : []).slice(0, OUT_SLOTS_LIMIT);
                    clean.forEach((s, idx) => { s.i = OUT_SLOT_MIN + idx; });
                    st.slotsOut = clean;
                    const w = st.outSlotsWidget();
                    if (w) w.value = JSON.stringify(clean);
                } catch (e) { /* silent */ }
            };
            // Индекс ближайшего свободного слота 2..11; null — все заняты.
            st.nextOutSlot = () => {
                const used = st.readOutSlots().length;
                return used < OUT_SLOTS_LIMIT ? OUT_SLOT_MIN + used : null;
            };
            st.outSlotBy = (pred) => st.readOutSlots().find((s) => s && pred(s)) || null;
            st.outSlotOfEntry = (id) => st.outSlotBy((s) => s.kind === "card" && s.id === id);
            st.outSlotOfFolder = (path) => st.outSlotBy((s) => s.kind === "folder" && s.path === path);
            // Что уходит в провод — для тултипа сокета и строк в «Выходах».
            st.outSlotLabel = (s) => {
                try {
                    const t = s && (s.name || (s.kind === "folder" ? s.path : s.id));
                    return String(t || "?").slice(0, 32);
                } catch (e) { return "?"; }
            };
            // Для папки-вывода в тултипе сокета мало имени папки: важно, какая
            // карточка сейчас из неё уходит.
            st.outSlotTitle = (s) => {
                const base = st.outSlotLabel(s);
                try {
                    if (s && s.kind === "folder" && s.active_id) {
                        const e = st.entries.find((x) => x.id === s.active_id);
                        if (e) return (base + " → " + (e.title || e.head || e.id)).slice(0, 64);
                    }
                } catch (err) { /* silent */ }
                return base;
            };
            // Мета выходов из node def (имя + localized_name из локали): нужна,
            // чтобы вернуть сокет на место, если привязку создали позже. Снимаем
            // её ОДИН раз при создании ноды (в onConfigure outputs приходят из
            // файла графа и описывают только занятые сокеты).
            st.captureOutBase = () => {
                try {
                    st.baseOutMeta = (this.outputs || []).map((o) => ({
                        name: (o && o.name) || "",
                        type: (o && o.type) || "STRING",
                        localized_name: o && o.localized_name,
                    }));
                } catch (e) { st.baseOutMeta = null; }
            };
            // Сокеты доп. выходов: занятые — есть на ноде, свободные — нет.
            //
            // ПОЧЕМУ НЕ o.hide (живой факт, проверено на фронтенде 1.52):
            // поля `hide` у слотов в этом фронтенде НЕТ вовсе — NodeSlots.vue
            // рисует все `nodeData.outputs` подряд, LGraphCanvas/LGraphNode
            // про hide слотов не знают. Прежний код ставил `o.hide = true`, и на
            // живой ноде все 12 сокетов были видны (скриншот пользователя).
            // Рабочий путь — тот же, что у смены входов в Degg_Switch: лишние
            // сокеты физически убрать (removeOutput), нужные добавить (addOutput).
            st.applyOutSockets = () => {
                try {
                    const slots = st.readOutSlots();
                    let want = Math.min(2 + OUT_SLOTS_LIMIT, 2 + slots.length);
                    const base = st.baseOutMeta || [];
                    if (!this.outputs) this.outputs = [];
                    // Провод важнее прятания: сокет с проводом не убираем, иначе в
                    // графе осталась бы ссылка на несуществующий выход (старые
                    // графы могли запускать провода с любых сокетов).
                    for (let i = this.outputs.length - 1; i >= want; i--) {
                        const o = this.outputs[i];
                        if (o && ((o.links && o.links.length) || o.link != null)) { want = i + 1; break; }
                    }
                    // 1. Лишние сокеты — убираем с конца (removeOutput сам отключает
                    //    висевшие на них провода и переезжает номера у следующих).
                    while (this.outputs.length > want) this.removeOutput(this.outputs.length - 1);
                    // 2. Недостающие — возвращаем с def-именами (RU-локаль даёт
                    //    «промпт N» через localized_name, EN — prompt_N).
                    while (this.outputs.length < want) {
                        const b = base[this.outputs.length] || {};
                        const opts = {};
                        if (b.localized_name) opts.localized_name = b.localized_name;
                        this.addOutput(b.name || ("prompt_" + this.outputs.length),
                            b.type || "STRING", opts);
                    }
                    // 3. Имена/локали выравниваем по def: граф мог быть сохранён
                    //    прошлой сборкой с чужими именами («выход 3»).
                    for (let i = 0; i < this.outputs.length; i++) {
                        const o = this.outputs[i], b = base[i];
                        if (!o || !b) continue;
                        if (b.name && o.name !== b.name) o.name = b.name;
                        if (b.localized_name) o.localized_name = b.localized_name;
                    }
                    // 4. Тултип занятого сокета — что именно уходит в этот провод;
                    //    сокет с проводом без привязки — в отдельный список (st.outOrphan),
                    //    о таком молчать нельзя: провод есть, а текста в нём нет.
                    st.outOrphan = [];
                    for (let i = 2; i < this.outputs.length; i++) {
                        const o = this.outputs[i];
                        if (!o) continue;
                        const s = slots[i - 2];
                        o.title = s ? ("→ " + st.outSlotTitle(s)) : "";
                        if (!s && ((o.links && o.links.length) || o.link != null)) st.outOrphan.push(i);
                    }
                    if (st.outOrphan.length) st.renderHint?.();
                } catch (e) { /* silent */ }
                try { this.setDirtyCanvas?.(true, true); } catch (e) { /* silent */ }
            };
            // Открытая папка = папка-слот и эта карточка — её активный вывод
            // (v1.44): карточка в списке папки подсвечивается зелёным и держит
            // маркер 🔌, пока слот подключён.
            st.folderActOf = (eid) => st.outSlotBy((s) => s.kind === "folder" && s.path === st.selFolder && s.active_id === eid);
            st.bindOutSlot = (slot) => {
                try {
                    const arr = st.readOutSlots();
                    const dup = arr.some((s) => (slot.kind === "card" ? s.id === slot.id : s.path === slot.path));
                    if (dup) return;
                    if (arr.length >= OUT_SLOTS_LIMIT) {
                        st.toast("warn", "Prompt Library: выходы", "Все 10 выходов заняты — отвяжите лишние в категории «🔌 Выходы».");
                        return;
                    }
                    // Привязка всегда встаёт в конец списка: номер выхода =
                    // место в списке, дырок в нумерации быть не может.
                    arr.push({ kind: slot.kind, id: slot.id, path: slot.path, active_id: slot.active_id, name: slot.name });
                    st.writeOutSlots(arr);
                    st.applyOutSockets();
                    renderTree(); render();
                } catch (e) { /* silent */ }
            };
            st.unbindOutSlot = (i) => {
                try {
                    const arr = st.readOutSlots();
                    const idx = arr.findIndex((s) => s.i === i);
                    if (idx < 0) return;
                    // Убираем ИМЕННО этот сокет: removeOutput отключит его провод
                    // и переедет номера у следующих — провод остаётся со своей
                    // привязкой (в списке удалили строку — остальные сдвинулись
                    // вместе с содержимым, чужие провода не страдают).
                    try {
                        if (this.outputs && i < this.outputs.length) this.removeOutput(i);
                    } catch (e) { /* silent */ }
                    arr.splice(idx, 1);
                    st.writeOutSlots(arr);
                    st.applyOutSockets();
                    renderTree(); render();
                } catch (e) { /* silent */ }
            };
            // Перетаскивание строки в «Выходах» меняет НОМЕР провода: порядок
            // списка = порядок сокетов, т.е. содержимое едет за позицией, а
            // провода остаются на своих сокетах (им же и адресуют).
            st.reorderOutSlot = (from, to) => {
                try {
                    const arr = st.readOutSlots();
                    if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
                    const [item] = arr.splice(from, 1);
                    arr.splice(to, 0, item);
                    st.writeOutSlots(arr);
                    st.applyOutSockets();
                    renderTree(); render();
                } catch (e) { /* silent */ }
            };
            // Строка слота — дроп-зона для соседних строк (перестановка).
            st.outSlotDrag = (row, idx) => {
                try {
                    row.draggable = true;
                    row.ondragstart = (ev) => {
                        ev.dataTransfer.setData("application/x-pl-slot", String(idx));
                        ev.dataTransfer.effectAllowed = "move";
                        ev.stopPropagation();
                    };
                    row.ondragover = (ev) => {
                        ev.preventDefault();
                        ev.dataTransfer.dropEffect = "move";
                        row.style.outline = "1px dashed #4a9eff";
                    };
                    row.ondragleave = () => { row.style.outline = ""; };
                    row.ondrop = (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        row.style.outline = "";
                        let from = NaN;
                        try { from = parseInt(ev.dataTransfer.getData("application/x-pl-slot"), 10); } catch (e) { /* silent */ }
                        if (Number.isNaN(from)) return;
                        st.reorderOutSlot(from, idx);
                    };
                } catch (e) { /* silent */ }
            };



const reload = async () => {
    try {
        const r = await fetch("/prompt_library/list");
        if (!r.ok) return;
        const data = await r.json();
        st.entries = (data.entries || []).map(plMap);
                    st.folders = data.folders || [];
                    st.pinnedFolders = new Set(data.pinned_folders || []);
                    // Чистим протухшие метки (запись удалена в другой вкладке,
                    // папка переименована через ✏️): сервер мусор игнорирует,
                    // но bulk-бар не должен врать о числе помеченных.
                    if (st.markEntries.size) {
                        const alive = new Set(st.entries.map((e) => e.id));
                        for (const id of st.markEntries) if (!alive.has(id)) st.markEntries.delete(id);
                        if (!st.markEntries.has(st.anchorEntry)) st.anchorEntry = null;
                    }
                    if (st.markFolders.size) {
                        const alive = new Set([...st.folders, ...st.entries.map((e) => e.folder).filter(Boolean)]);
                        for (const p of st.markFolders) if (!alive.has(p)) st.markFolders.delete(p);
                        if (!st.markFolders.has(st.anchorFolder)) st.anchorFolder = null;
                    }
                    renderTree();
                    render();
                    // fitNode удалён: высоту отдаёт computeLayoutSize (минимум),
                    // свободное место distributeSpace даёт нам, размер — у фронтенда.
                } catch (e) { /* silent */ }
            };
            st.reload = reload;

            // Глобальный слушатель: при сохранении записи на любой ноде
            // (через _broadcast_refresh → send_sync) все Library-ноды
            // автоматически перечитывают library.json без запуска Queue.
            // app.api — ComfyApi (extends EventTarget). При неизвестном
            // типе сообщения ComfyApi рассылает CustomEvent(type, {detail}).
            // Слушатель храним в st и СНИМАЕМ в onRemoved: app.api живёт всю сессию,
            // иначе удалённые ноды не собираются GC и продолжают тянуть
            // /prompt_library/list на каждый broadcast.
            try {
                const plListener = (ev) => {
                    try { if (this._pl) this._pl.reload(); } catch (e) { /* silent */ }
                };
                app.api.addEventListener("prompt_library/refresh", plListener);
                st.apiListener = plListener;
                st.apiTarget = app.api;
            } catch (e) { /* silent */ }

            // --- Автоподхват обложки из прогона (§29, v1.24) ------------------
            // Провод IMAGE для обложки больше не нужен (именно он давал кольцо
            // «prompt_out → CLIP → ... → image → сюда»). Вместо провода берём
            // файл, который сервер сам рассылает в событии `executed`:
            //   { node, prompt_id, output: { images: [{filename, subfolder, type}] } }
            // Наша нода уже отчиталась в этом же событии своим saved_id —
            // значит знаем, какой записи ждать картинку. Кладём её после
            // `execution_success` (когда файл точно записан) через apiPost.
            // ВАЖНО: свой id читаем В МОМЕНТ события, а не кэшируем здесь.
            // В onNodeCreated id ещё НЕ назначен: конструктор LGraphNode ставит
            // UNASSIGNED_NODE_ID (-1), реальный id появляется при graph.add/
            // configure. Кэш "-1" ломал рукопожатие saved_id → обложка не
            // прикреплялась (живая проверка v1.24).
            const ownId = () => {
                try {
                    const v = this && this.id;
                    if (v === undefined || v === null || String(v) === "-1") return "";
                    return String(v);
                } catch (e) { return ""; }
            };
            st.ownId = ownId;
            st.pendingPreview = new Map(); // prompt_id -> { id, image }
            // prompt_id -> первая картинка прогона. Нужно, если нода стоит ПОСЛЕ
            // узлов вывода (позиция старого сейвера): тогда saved_id приходит
            // позже картинок, и без этого запаса обложки бы не было.
            st.runImages = new Map();
            // Подхват (v1.25): текст, который узлы отдавали в ui этого прогона
            // (ключ — id узла и последний сегмент id: нода внутри subgraph
            // приходит как "5:12"), и ожидающие подхвата записи: prompt_id ->
            // { token, node, text }. Токен — от нашей ноды (ui.pickup).
            st.runTexts = new Map();
            st.pendingPickup = new Map();
            // prompt_id — прогоны, где сервер выключил подхват режимом (v1.38):
            // по ним не показываем ложное «нода не исполнялась (кэш)».
            st.runPickupBlocked = new Set();
            const PL_TEXT_LIMIT = 50;      // без таймеров: чистим по количеству
            const PL_PENDING_LIMIT = 20;   // без таймеров: чистим по количеству
            st.rememberPending = (pid, rec) => {
                try {
                    st.pendingPreview.set(pid, rec);
                    while (st.pendingPreview.size > PL_PENDING_LIMIT) {
                        const first = st.pendingPreview.keys().next().value;
                        if (first === undefined) break;
                        st.pendingPreview.delete(first);
                    }
                } catch (e) { /* silent */ }
            };
            // Кадр-превью из файла, выбранного на диске (ручной ввод и замена
            // обложки): картинка → даунскейл 512px через canvas; видео → первый
            // кадр через <video>+canvas (файл лежит на диске пользователя, сервер
            // его не видит). media нужен серверу: по нему работают 🎬-бейдж и фильтр.
            st.readPreviewFile = (file) => new Promise((resolve) => {
                if (!file) return resolve(null);
                let url = "";
                const done = (res) => {
                    try { if (url) URL.revokeObjectURL(url); } catch (e) { /* silent */ }
                    resolve(res);
                };
                const draw = (src, w, h) => {
                    try {
                        const scale = Math.min(1, 512 / Math.max(w || 1, h || 1));
                        const cw = document.createElement("canvas");
                        cw.width = Math.max(1, Math.round((w || 512) * scale));
                        cw.height = Math.max(1, Math.round((h || 512) * scale));
                        cw.getContext("2d").drawImage(src, 0, 0, cw.width, cw.height);
                        return cw.toDataURL("image/png");
                    } catch (e) { return null; }
                };
                try { url = URL.createObjectURL(file); } catch (e) { return resolve(null); }
                const vid = String(file.type || "").startsWith("video/")
                    || /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(file.name || "");
                if (!vid) {
                    const img = new Image();
                    img.onload = () => done((() => {
                        const d = draw(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
                        return d ? { dataUrl: d, media: "image" } : null;
                    })());
                    img.onerror = () => done(null);
                    img.src = url;
                    return;
                }
                const v = document.createElement("video");
                v.muted = true;
                v.playsInline = true;
                v.preload = "metadata";
                let settled = false;
                const finish = (res) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(guard);
                    done(res);
                };
                // Один одноразовый предохранитель (не наблюдатель и не polling):
                // у битого контейнера не приходит ни кадр, ни ошибка.
                const guard = setTimeout(() => finish(null), 8000);
                v.onerror = () => finish(null);
                v.onloadeddata = () => {
                    // Сдвиг на кадр вперёд: у некоторых кодеков нулевой кадр серый
                    try { if (!v.currentTime) v.currentTime = 0.05; } catch (e) { /* кадр уже есть */ }
                };
                v.onseeked = () => {
                    const d = draw(v, v.videoWidth, v.videoHeight);
                    finish(d ? { dataUrl: d, media: "video" } : null);
                };
                try { v.src = url; } catch (e) { finish(null); }
            });
            st.attachPreview = async (id, image) => {
                try {
                    const r = await st.apiPost("/prompt_library/attach_preview", {
                        id, filename: image.filename, subfolder: image.subfolder, type: image.type,
                    });
                    let out = {};
                    try { out = await r.json(); } catch (e) { /* silent */ }
                    if (!r.ok) {
                        // Диагностика на живую (F12): сервер не принял файл
                        console.warn("[PromptLibrary] attach_preview failed:", r.status, out);
                        return;
                    }
                    if (out && out.skipped) {
                        console.log("[PromptLibrary] attach_preview skipped:", out.skipped);
                        return;
                    }
                    if (out && out.preview) await reload();
                } catch (e) {
                    console.warn("[PromptLibrary] attach_preview error:", e);
                }
            };
            // Достать текст узла для подхвата: сначала текст этого прогона
            // (ui.text OUTPUT-узлов — так отдаёт PromptKeeper), иначе значение
            // строкового виджета в живом графе (обычные текстовые узлы, кэш).
            st.pickupText = (nodeId) => {
                const want = String(nodeId || "").trim();
                if (!want) return "";
                const fromRun = st.runTexts.get(want) || st.runTexts.get(want.split(":").pop());
                if (typeof fromRun === "string" && fromRun.trim()) return fromRun.trim();
                try {
                    const g = app.graph;
                    if (!g || typeof g.getNodeById !== "function") return "";
                    const n = g.getNodeById(want) || (isFinite(Number(want)) ? g.getNodeById(Number(want)) : null);
                    const ws = (n && n.widgets) || [];
                    const isText = (w) => w && typeof w.value === "string" && w.value.trim();
                    const named = ws.find((w) => isText(w)
                        && ["text", "value", "string", "prompt"].indexOf(String(w.name || "").toLowerCase()) >= 0);
                    const any = named || ws.find(isText);
                    if (any) return any.value.trim();
                } catch (e) { /* silent */ }
                return "";
            };
            st.savePickup = async (pick, shot) => {
                try {
                    const text = st.pickupText(pick.node);
                    if (!text) {
                        // Не молчим: при пустом тексте запись не создаётся, и без
                        // диагностики причина «почему-то не сохранилось» невидима.
                        console.warn(`[PromptLibrary] pickup: узел #${pick.node} не отдал текст — запись не создана`);
                        st.toast("warn", "Prompt Library: подхват",
                            `Узел #${pick.node} не отдал текст — запись не создана.`);
                        return;
                    }
                    const r = await st.apiPost("/prompt_library/save_pickup",
                        { token: pick.token, text });
                    let out = {};
                    try { out = await r.json(); } catch (e) { /* silent */ }
                    if (!r.ok) {
                        console.warn("[PromptLibrary] save_pickup failed:", r.status, out);
                        // Не молчим: отказ сервера (протухший токен) раньше не был
                        // виден нигде, кроме F12 (§33).
                        st.hintSticky = `Подхват: сервер отклонил запись (${r.status}) — подробности в F12.`;
                        st.renderHint?.();
                        return;
                    }
                    await reload();
                    if (out && out.duplicate) {
                        // Не тост: подхват срабатывает на КАЖДЫЙ Queue, и повторная
                        // генерация того же промпта поднимала бы попап каждый раз.
                        // Пишем в нижнюю строку ноды (она видна всегда) + F12.
                        const where = out.folder || "корне";
                        st.hintSticky = `Подхват: такой текст уже есть в «${where}» — новая запись не создана.`;
                        st.renderHint?.();
                        console.log(`[PromptLibrary] pickup: дубликат, запись не создана («${where}»)`);
                        return;
                    }
                    console.log(`[PromptLibrary] pickup saved: ${out && out.id} (узел #${pick.node})`);
                    st.hintSticky = `Подхват: сохранили текст узла #${pick.node}.`;
                    st.renderHint?.();
                    if (shot && out && out.id) {
                        await st.attachPreview(String(out.id), shot);
                    } else {
                        console.log("[PromptLibrary] pickup: обложки нет (в прогоне нет файлов-превью)",
                            out && out.id);
                    }
                } catch (e) {
                    console.warn("[PromptLibrary] save_pickup error:", e);
                }
            };
            try {
                const plExecuted = (ev) => {
                    try {
                        const d = ev && ev.detail;
                        if (!d || !d.prompt_id) return;
                        // Текст, отданный узлом в ui (PromptKeeper и подобные):
                        // запоминаем для подхвата — ключ и полный id, и последний
                        // сегмент (в subgraph нода приходит как "5:12").
                        const uiText = d.output && d.output.text;
                        if (uiText !== undefined && uiText !== null) {
                            const t = Array.isArray(uiText) ? uiText[0] : uiText;
                            if (typeof t === "string" && t.trim()) {
                                for (const key of [String(d.node || ""), String(d.display_node || "")]) {
                                    if (!key) continue;
                                    st.runTexts.set(key, t);
                                    const tail = key.split(":").pop();
                                    if (tail) st.runTexts.set(tail, t);
                                }
                                while (st.runTexts.size > PL_TEXT_LIMIT) {
                                    st.runTexts.delete(st.runTexts.keys().next().value);
                                }
                                // Наша нода (стоит до LLM-цепочки) исполнилась раньше —
                                // текст источника приходит после неё: досыпаем в ожидание.
                                const pp = st.pendingPickup.get(d.prompt_id);
                                if (pp && !pp.text) pp.text = st.runTexts.get(pp.node) || "";
                            }
                        }
                        // Нода внутри subgraph приходит с префиксом ("5:12") —
                        // сверяем и по display_node, и по последнему сегменту id.
                        const mine = ownId();
                        const isMine = mine !== ""
                            && [String(d.node || ""), String(d.display_node || "")]
                                .some((v) => v === mine || v.endsWith(":" + mine));
                        if (isMine) {
                            // Подхват: нода отчиталась токеном — сам текст возьмём
                            // после `execution_success` из узла-источника.
                            const tok = (d.output && d.output.pickup && d.output.pickup[0]) || "";
                            const src = (d.output && d.output.pickup_node && d.output.pickup_node[0]) || "";
                            if (tok && src) {
                                st.pendingPickup.set(d.prompt_id, {
                                    token: String(tok), node: String(src),
                                    text: st.runTexts.get(String(src)) || "",
                                });
                            }
                            // v1.38: подхват — это запись, поэтому он подчиняется
                            // режиму. В «📤 Выдача» сервер токена не даёт и говорит об
                            // этом флагом: запоминаем, чтобы на execution_success не
                            // выдать ложное «нода не исполнялась (кэш)».
                            const blocked = (d.output && d.output.pickup_blocked
                                && d.output.pickup_blocked[0]) || "";
                            if (blocked) st.runPickupBlocked.add(d.prompt_id);
                            // Наша нода сохранила запись — ждём обложку для неё.
                            // Картинка может быть уже в запасе (нода после
                            // SaveImage) — тогда берём её сразу.
                            const sid = (d.output && d.output.saved_id && d.output.saved_id[0]) || "";
                            if (!sid) return;
                            const prev = st.pendingPreview.get(d.prompt_id);
                            if (prev && prev.id === String(sid) && prev.image) return;
                            st.rememberPending(d.prompt_id, {
                                id: String(sid), image: st.runImages.get(d.prompt_id) || null,
                            });
                            return;
                        }
                        // Файл прогона для обложки. Ядро кладёт видео в `images`
                        // (+ animated: true — так отдаёт PreviewVideo), но сторонние
                        // ноды (VHS и подобные) — в `video`/`gifs`. Раньше читался
                        // только `images`, и видео-прогон оставался без обложки.
                        const pools = [d.output && d.output.images, d.output && d.output.video,
                                       d.output && d.output.gifs];
                        const pool = pools.find((p) => Array.isArray(p) && p.length && p[0] && p[0].filename);
                        if (!pool) return;
                        const im = pool[0] || {};
                        const shot = { filename: im.filename, subfolder: im.subfolder || "", type: im.type || "output" };
                        // Первый файл прогона — в запас (и в ожидание, если оно есть)
                        if (!st.runImages.has(d.prompt_id)) {
                            st.runImages.set(d.prompt_id, shot);
                            while (st.runImages.size > PL_PENDING_LIMIT) {
                                const first = st.runImages.keys().next().value;
                                if (first === undefined) break;
                                st.runImages.delete(first);
                            }
                        }
                        const rec = st.pendingPreview.get(d.prompt_id);
                        if (rec && !rec.image) rec.image = shot;
                    } catch (e) { /* silent */ }
                };
                const plDone = (ev) => {
                    try {
                        const pid = ev && ev.detail && ev.detail.prompt_id;
                        if (!pid) return;
                        const rec = st.pendingPreview.get(pid);
                        const shot = st.runImages.get(pid) || null;
                        const pick = st.pendingPickup.get(pid) || null;
                        // Нода сама сказала, что подхват выключён режимом: причина уже
                        // показана подсказкой ноды (mode_notice), «кэш» тут — враньё.
                        const pickupOff = st.runPickupBlocked.delete(pid);
                        st.pendingPreview.delete(pid);
                        st.pendingPickup.delete(pid);
                        st.runImages.delete(pid);
                        // Подхват (v1.25): запись ещё не создана — сначала сохраняем
                        // текст узла-источника, потом (из ответа) прикрепляем обложку.
                        if (pick) st.savePickup(pick, shot);
                        else if (pickupOff) { /* режим не пишет — не шумим */ }
                        else {
                            // Подхват включён, а токена нет: наша нода не исполнялась в
                            // этом прогоне (ComfyUI закэшировал её — у ноды нет проводов,
                            // см. IS_CHANGED/§33). Раньше это уходило совсем молча.
                            const want = (st.pickupNode && st.pickupNode()) || "";
                            if (want) {
                                console.warn("[PromptLibrary] pickup: токен не пришёл — нода не исполнялась в этом прогоне (кэш ComfyUI)");
                                st.hintSticky = "Подхват: нода не исполнялась в этом прогоне (кэш) — запись не создана.";
                                st.renderHint?.();
                            }
                        }
                        if (!rec) return;
                        if (rec.image) {
                            st.attachPreview(rec.id, rec.image);
                        } else {
                            // В прогоне нет ни картинок, ни видео — обложку
                            // не из чего взять, это не ошибка
                            console.log("[PromptLibrary] cover: в прогоне нет файлов-превью, обложка не прикреплена", rec.id);
                        }
                    } catch (e) { /* silent */ }
                };
                const plFailed = (ev) => {
                    try {
                        const pid = ev && ev.detail && ev.detail.prompt_id;
                        if (pid) {
                            st.pendingPreview.delete(pid);
                            st.pendingPickup.delete(pid);
                            st.runPickupBlocked.delete(pid);
                            st.runImages.delete(pid);
                        }
                    } catch (e) { /* silent */ }
                };
                app.api.addEventListener("executed", plExecuted);
                app.api.addEventListener("execution_success", plDone);
                app.api.addEventListener("execution_error", plFailed);
                app.api.addEventListener("execution_interrupted", plFailed);
                st.execListeners = [
                    ["executed", plExecuted], ["execution_success", plDone],
                    ["execution_error", plFailed], ["execution_interrupted", plFailed],
                ];
                st.apiTarget = app.api;
            } catch (e) { /* silent */ }

            // --- Drag & Drop: книги → на категории, категории → в другие категории (или в корень) ---
            st.plDrop = async (d, target) => {
                if (!d) return;
                try {
                    // v1.44 (§40): дроп в категорию «Выходы» — создаёт слот
                    // (привязку доп. выхода). Ближайший свободный индекс берёт
                    // bindOutSlot; дубль (та же карточка/папка) игнорируется.
                    if (target === "__outs") {
                        if (d.kind === "entry") {
                            for (const id of (d.ids || (d.id ? [d.id] : []))) {
                                const e = st.entries.find((x) => x.id === id);
                                st.bindOutSlot({ kind: "card", id, name: (e && (e.title || e.head)) || id });
                            }
                        } else if (d.kind === "folder") {
                            for (const p of (d.paths || (d.path ? [d.path] : []))) {
                                // Карточка-вывод папки: наследуем текущее выделение,
                                // если оно лежит в этой папке (иначе — пусто, слот
                                // отдаст «», пока карточку не кликнут внутри папки).
                                let active = "";
                                try {
                                    const s = selWidget ? String(selWidget.value || "") : "";
                                    const e = st.entries.find((x) => x.id === s && x.folder === p);
                                    if (e) active = e.id;
                                } catch (err) { /* silent */ }
                                st.bindOutSlot({ kind: "folder", path: p, active_id: active, name: (p.split("/").pop()) || p });
                            }
                        }
                        return;
                    }
                    if (d.kind === "entry") {
                        const ids = d.ids || (d.id ? [d.id] : []);
                        if (!ids.length) return;
                        if (target === "__fav") {
                            const fav = await st.apiPost("/prompt_library/favorite_many", { ids });
                            if (fav.ok) { st.full.clear(); await reload(); }
                            return;
                        }
                        const dest = target && !target.startsWith("__") ? target : (target === "__root" ? "" : null);
                        if (dest === null) return;
                        const moved = await st.apiPost("/prompt_library/move_many", { entry_ids: ids, folder: dest });
                        if (moved.ok) { st.full.clear(); await reload(); }
                    } else if (d.kind === "folder") {
                        const paths = d.paths || (d.path ? [d.path] : []);
                        if (!paths.length) return;
                        if (target === "__fav") {
                            const fav = await st.apiPost("/prompt_library/favorite_many", { folder_paths: paths });
                            if (fav.ok) { st.syncSaveFolder(); await reload(); }
                            return;
                        }
                        const new_parent = (!target || target === "__all" || target === "__root")
                            ? ""
                            : target;
                        const moved = await st.apiPost("/prompt_library/move_many", { folder_paths: paths, new_parent });
                        if (moved.ok) { st.syncSaveFolder(); await reload(); }
                    }
                } catch (e) { /* silent */ }
            };

            // Фон списка — тоже дроп-зона: книга переезжает в открытую полку
            list.ondragover = (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; };
            list.ondrop = async (ev) => {
                ev.preventDefault();
                let d = null;
                try { d = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch (e) { /* silent */ }
                if (d && d.kind === "entry" && st.selFolder) {
                    await st.plDrop(d, st.selFolder);
                }
            };

            // --- Дерево полок ---
            const folderRow = (key, label, depth, isFolder) => {
                const row = document.createElement("div");
                const active = st.selFolder === key;
                const marked = st.markFolders.has(key);
                row.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:4px;cursor:pointer;font-size:11px;color:${active ? "#fff" : "#ccc"};background:${marked ? "rgba(224,138,60,.35)" : active ? "#2c4a73" : "transparent"};${marked ? "box-shadow:inset 3px 0 0 #e08a3c;" : ""}padding-left:${4 + depth * 14}px;`;
                if (isFolder) row.title = "Клик — открыть · Ctrl+клик — пометить · Shift+клик — диапазон";
                const name = document.createElement("span");
                name.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                name.title = isFolder ? key : label;
                // v1.55: «🔌» в подписи — ОТДЕЛЬНЫМ пролётом с тем же фильтром, что
                // на карточке и в строке слота. Фильтр не может осветлить часть
                // текстового узла, поэтому подпись разбивается на пролёты; текст
                // остаётся в DOM целиком (ftext/поиск читают его по элементам).
                // Отчёт пользователя: «значок вилки в категории Выходы не был
                // осветлён в отличие от этого же значка на карточках».
                const plugLabel = /^(🔌)\s?(.*)$/u.exec(label || "");
                if (plugLabel) {
                    if (marked) name.appendChild(plTextSpan("☑ "));
                    name.appendChild(plIcon("🔌"));
                    if (plugLabel[2]) name.appendChild(plTextSpan(" " + plugLabel[2]));
                } else {
                    name.textContent = (marked ? "☑ " : "") + label;
                }
                row.appendChild(name);
                // Категория, подключённая к доп. выходу, носит номер провода
                // прямо в проводнике — видно, что куда уходит (§40).
                const slotOfFolder = isFolder ? st.outSlotOfFolder(key) : null;
                if (slotOfFolder) {
                    const bn = document.createElement("span");
                    bn.textContent = "🔌" + slotOfFolder.i;
                    bn.title = `Категория подключена к выходу «промпт ${slotOfFolder.i}»`;
                    bn.style.cssText = PL_ICON_FILTER + "color:#7fe0a8;font-size:10px;flex-shrink:0;padding:0 2px;";
                    row.appendChild(bn);
                }
                // Папки можно таскать; любая строка — дроп-зона
                row.draggable = isFolder;
                if (isFolder) {
                    row.ondragstart = (ev) => {
                        const paths = st.markFolders.size > 1 ? [...st.markFolders] : [key];
                        ev.dataTransfer.setData("text/plain", JSON.stringify({ kind: "folder", paths }));
                        ev.dataTransfer.effectAllowed = "move";
                        ev.stopPropagation();
                    };
                }
                row.ondragover = (ev) => {
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = "move";
                    row.style.outline = "1px dashed #4a9eff";
                };
                row.ondragleave = () => { row.style.outline = ""; };
                row.ondrop = async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    row.style.outline = "";
                    let d = null;
                    try { d = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch (e) { /* silent */ }
                    await st.plDrop(d, key);
                };
                if (isFolder) {
                    const pn = document.createElement("button");
                    pn.textContent = st.pinnedFolders.has(key) ? "📌" : "📍";
                    pn.title = st.pinnedFolders.has(key) ? "Открепить из проводника" : "Закрепить в проводнике";
                    pn.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    pn.onclick = async (ev) => {
                        ev.stopPropagation();
                        try {
                            const r = await st.apiPost("/prompt_library/folder_pin",
                                { path: key, pinned: !st.pinnedFolders.has(key) });
                            if (r.ok) { renderTree(); }
                        } catch (e) { /* silent */ }
                    };
                    row.appendChild(pn);
                    const rn = document.createElement("button");
                    rn.textContent = "✏️"; rn.title = "Переименовать категорию (правка прямо в строке)";
                    rn.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    rn.onclick = (ev) => {
                        ev.stopPropagation();
                        const leaf = key.split("/").pop();
                        row.draggable = false; // пока правим — строку нельзя утащить
                        st.inlineEdit(name, leaf, async (next) => {
                            // Та же защита служебного префикса, что и при создании:
                            // иначе переименование увело бы папку в призрак.
                            if (next.startsWith("__")) {
                                st.toast("warn", "Prompt Library: имя категории",
                                    "Имя не может начинаться с «__» — это служебный префикс дерева.");
                                renderTree();
                                return;
                            }
                            const parent = key.split("/").slice(0, -1).join("/");
                            const newPath = parent ? `${parent}/${next}` : next;
                            try {
                                const r = await st.apiPost("/prompt_library/folder_rename", { old: key, new: newPath });
                                if (r.ok) {
                                    if (st.selFolder === key) st.selFolder = newPath;
                                    // Метки/якорь переименованного пути едут следом
                                    if (st.markFolders.delete(key)) st.markFolders.add(newPath);
                                    if (st.anchorFolder === key) st.anchorFolder = newPath;
                                    st.syncSaveFolder();
                                    await reload();
                                } else st.toast("warn", "Prompt Library", "Не удалось переименовать.");
                            } catch (e) { st.toast("warn", "Prompt Library", "Не удалось переименовать."); }
                        });
                    };
                    const del = document.createElement("button");
                    del.textContent = "🗑"; del.title = "Удалить категорию (записи переедут в корень)";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    del.onclick = async (ev) => {
                        ev.stopPropagation();
                        if (!confirm(`Удалить категорию «${key}» с подкатегориями? Записи не пропадут — переедут в корень.`)) return;
                        try {
                            const r = await st.apiPost("/prompt_library/folder_delete", { path: key });
                            if (r.ok) {
                                if (st.selFolder === key || st.selFolder.startsWith(key + "/")) st.selFolder = "__all";
                                st.syncSaveFolder();
                                await reload();
                            }
                        } catch (e) { /* silent */ }
                    };
                    row.appendChild(rn);
                    row.appendChild(del);
                }
                row.onclick = (ev) => {
                    // Ctrl/Shift — только метка на удаление (текущую папку и цель
                    // сохранения не трогаем). Служебные ветки не помечаем.
                    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
                        if (isFolder) st.markFolderToggle(key, !!(ev.shiftKey));
                        return;
                    }
                    // Обычный клик при наличии меток — снять весь выбор (как в проводнике)
                    if (st.markEntries.size || st.markFolders.size) st.clearMarks();
                    st.selFolder = key;
                    st.outsActiveFolder = ""; // сброс активной папки при смене ветки
                    st.syncSaveFolder();
                    st.anchorFolder = key; // обычный клик ставит якорь для Shift-диапазона
                    // Выбранную запись (и панель промпта) НЕ снимаем: она — источник
                    // основного текста на выходе prompt_1, и переход по категориям
                    // ради просмотра не должен его гасить. Снимется только когда
                    // пользователь выберет другую карточку (отчёт пользователя).
                    st.hintMsg = st.detailId
                        ? st.hintMsg
                        : "Запустите Queue или нажмите «Сохранить промпт» — записи появятся здесь.";
                    st.hintSticky = null;
                    renderTree();
                    render();
                };
                return row;
            };

            const renderTree = () => {
                st.tree.innerHTML = "";
                // Порядок строк для Shift-диапазона (включая служебные — при
                // применении диапазона они пропускаются, метятся только папки).
                // Порядок строк совпадает с порядком отрисовки НИЖЕ: служебные
                // ветки, затем привязки «Выходов», затем «Без категории», затем
                // папки — иначе Shift-диапазон считает диапазон по чужому списку.
                st.folderOrder = ["__all", "__fav", "__outs"];
                st.tree.appendChild(folderRow("__all", "📚 Всё", 0, false));
                st.tree.appendChild(folderRow("__fav", "★ Избранное", 0, false));
                // v1.44 (§40): категория привязок доп. выходов (виртуальная ветка)
                const outsRow = folderRow("__outs", "🔌 Выходы", 0, false);
                st.tree.appendChild(outsRow);
                // Подключённые выходы — как дети категории «Выходы» (перед "Без категории").
                // Номер «промпт N» — это НОМЕР ПРОВОДА (он же место в списке):
                // строка таскается вверх/вниз и этим меняет, какой выход отдаёт
                // эту карточку/папку (§40).
                const slots = st.readOutSlots();
                for (let idx = 0; idx < slots.length; idx++) {
                    const slot = slots[idx];
                    const isFolder = slot.kind === "folder";
                    const selIdTree = selWidget ? String(selWidget.value || "") : "";
                    const isActive = isFolder
                        ? st.outsActiveFolder === slot.path
                        : selIdTree === slot.id;
                    const row = document.createElement("div");
                    row.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:4px;cursor:pointer;font-size:11px;color:${isActive ? "#fff" : "#ccc"};background:${isActive ? "#2e6b4f" : "transparent"};${isActive ? "box-shadow:inset 3px 0 0 #7fe0a8;" : ""}padding-left:${4 + 14}px;`;
                    const num = document.createElement("span");
                    num.textContent = `🔌${slot.i}`;
                    num.title = `Выход «промпт ${slot.i}»`;
                    num.style.cssText = PL_ICON_FILTER + "color:#7fe0a8;flex-shrink:0;margin-right:3px;";
                    const name = document.createElement("span");
                    name.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                    name.textContent = (isFolder ? "📁 " : "") + st.outSlotLabel(slot);
                    name.title = `Выход №${slot.i}: ` + (isFolder ? `папка-вывод «${slot.path}»` : "карточка-вывод")
                        + " · перетащите строку, чтобы отдать этот текст другому выходу";
                    row.appendChild(num);
                    row.appendChild(name);
                    // Кнопка отвязки
                    const del = document.createElement("button");
                    del.textContent = "✖";
                    del.title = "Отвязать выход (провод отключится, сокет исчезнет)";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;color:#e08a3c;padding:0 2px;";
                    del.onclick = (ev) => { ev.stopPropagation(); st.unbindOutSlot(slot.i); };
                    row.appendChild(del);
                    st.outSlotDrag(row, idx);
                    row.onclick = () => {
                        st.selFolder = "__outs";
                        st.outsActiveFolder = isFolder ? slot.path : "";
                        st.syncSaveFolder();
                        st.hintSticky = null;
                        if (isFolder) {
                            // Папка-вывод: открываем её карточки, но выбранную
                            // запись и панель промпта не сбрасываем — по той же
                            // причине, что и при смене категории (см. folderRow).
                            if (!st.detailId) st.hintMsg = "Выберите карточку для вывода из папки «" + slot.path + "»";
                            renderTree(); render();
                            return;
                        }
                        // Карточка-вывод: выбирается как обычная запись (слева —
                        // превью, снизу — панель промпта), из «Выходов» не уходим.
                        if (selWidget) selWidget.value = slot.id;
                        st.anchorEntry = slot.id;
                        st.fillDetail(slot.id).then(() => { renderTree(); render(); });
                    };
                    st.tree.appendChild(row);
                    st.folderOrder.push("__outs_slot_" + slot.i);
                }
                // Служебная ветка «Без категории» (folder === ""). Строка была
                // потеряна в v1.44 (c2dd0bd) при вставке строк «🔌 Выходы» —
                // записи без категории оставались только во «Всё» (v1.54).
                st.tree.appendChild(folderRow("__root", "📄 Без категории", 0, false));
                st.folderOrder.push("__root");
                const all = [...new Set([...st.folders, ...st.entries.map((e) => e.folder).filter(Boolean)])];
                all.sort((a, b) => {
                    const aP = st.pinnedFolders.has(a);
                    const bP = st.pinnedFolders.has(b);
                    if (aP && !bP) return -1;
                    if (!aP && bP) return 1;
                    return a.localeCompare(b);
                });
                const kids = new Map(); // parent -> [childPath]
                for (const f of all) {
                    const parent = f.split("/").slice(0, -1).join("/");
                    if (!kids.has(parent)) kids.set(parent, []);
                    kids.get(parent).push(f);
                }
                const walk = (parent, depth) => {
                    for (const f of (kids.get(parent) || [])) {
                        st.folderOrder.push(f);
                        st.tree.appendChild(folderRow(f, "📁 " + f.split("/").pop(), depth, true));
                        walk(f, depth + 1);
                    }
                };
                walk("", 0);
            };
            st.renderTree = renderTree;

            newFolderBtn.onclick = async () => {
                const parent = (st.selFolder && !st.selFolder.startsWith("__")) ? st.selFolder : "";
                const name = prompt(parent ? `Новая подкатегория в «${parent}»: ` : "Новая категория:");
                if (!name || !name.trim()) return;
                // Префикс "__" — служебные ветки дерева (__all/__fav/__root): такая
                // «категория» стала бы призраком (записи в неё не попадают, из UI
                // её не удалить). Сервер это тоже проверяет — здесь понятное сообщение.
                if (name.trim().startsWith("__")) {
                    st.toast("warn", "Prompt Library: имя категории",
                        "Имя не может начинаться с «__» — это служебный префикс дерева.");
                    return;
                }
                try {
                    const r = await st.apiPost("/prompt_library/folder_create", { parent, name: name.trim() });
                    if (r.ok) {
                        const data = await r.json();
                        st.selFolder = data.path;
                        st.syncSaveFolder();
                        await reload();
                    } else {
                        st.toast("warn", "Prompt Library", "Не удалось создать категорию.");
                    }
                } catch (e) { /* silent */ }
            };

            // --- Список книг ---
            const sortedFiltered = () => {
                const q = (st.search.value || "").toLowerCase();
                const mf = st.mediaSel.value || "all";
                let arr = st.entries.filter((e) => {
                    if (st.selFolder === "__fav" && !e.favorite) return false;
                    else if (st.selFolder === "__root" && e.folder) return false;
                    else if (st.selFolder && !st.selFolder.startsWith("__") && e.folder !== st.selFolder) return false;
                    if (mf !== "all" && e.media !== mf) return false;
                    if (q) {
                        const local = ((e.title || "") + "\n" + (e.head || "") + "\n" + (e.folder || "")).toLowerCase().includes(q);
                        // Слово из середины длинного промпта локально не видно
                        // (в списке — только первые 120 символов): такие записи
                        // приносит серверный поиск (§32).
                        if (!local && !(st.deepIds && st.deepIds.has(e.id))) return false;
                    }
                    return true;
                });
                const by = st.sortSel.value;
                const ts = (s) => s || "";
                if (by === "title") arr = [...arr].sort((a, b) => (a.title || a.head).localeCompare(b.title || b.head, "ru"));
                else if (by === "old") arr = [...arr].sort((a, b) => ts(a.created_at) < ts(b.created_at) ? -1 : ts(a.created_at) > ts(b.created_at) ? 1 : 0);
                else if (by === "used") arr = [...arr].sort((a, b) => ts(b.last_used || "") < ts(a.last_used || "") ? -1 : ts(b.last_used || "") > ts(a.last_used || "") ? 1 : 0);
                else if (by === "freq") arr = [...arr].sort((a, b) => (b.use_count || 0) - (a.use_count || 0) || ts(b.last_used || "") < ts(a.last_used || "") ? -1 : ts(b.last_used || "") > ts(a.last_used || "") ? 1 : 0);
                else arr = [...arr].sort((a, b) => ts(b.created_at) < ts(a.created_at) ? -1 : ts(b.created_at) > ts(a.created_at) ? 1 : 0);
                // Закреп (v1.30, §36): ТОЛЬКО в папке — закреплённые всплывают
                // поверх выбранного порядка, внутри групп порядок сохраняется.
                // Во «Всё»/«Избранном»/«Без категории» и в поиске — как обычно.
                if (st.selFolder && !st.selFolder.startsWith("__")) {
                    const pin = arr.filter((e) => e.pinned), rest = arr.filter((e) => !e.pinned);
                    if (pin.length && rest.length) arr = [...pin, ...rest];
                }
                return arr;
            };

            // Карточка вывода (категория «Выходы»): превью и название, как у
            // обычной карточки — раньше здесь была голая текстовая строка без
            // обложки. Клик = выбрать запись (подсветка + панель промпта снизу);
            // внутри папки-вывода клик ещё и отдаёт её текст в провод (§40).
            st.makeOutCard = (e, opts) => {
                const o = opts || {};
                const grid = !!o.grid, imgSize = o.imgSize || 163;
                const slot = o.slot || o.fs || null;
                const isActive = !!(o.fs && o.fs.active_id === e.id);
                const isSel = !!(selWidget && selWidget.value === e.id);
                const card = document.createElement("div");
                card.draggable = false;
                const border = isActive ? "#2e6b4f" : isSel ? "#4a9eff" : "#333";
                const bg = isActive ? "#1c3525" : isSel ? "#1e2c44" : "#1e1e1e";
                card.style.cssText = grid
                    ? `display:flex;flex-direction:column;gap:4px;width:${imgSize + 12}px;padding:4px;border-radius:4px;cursor:pointer;border:1px solid ${border};background:${bg};flex-shrink:0;`
                    : `display:flex;gap:6px;align-items:center;padding:4px;border-radius:4px;cursor:pointer;border:1px solid ${border};background:${bg};`;
                // Размер превью — тот же, что у обычной карточки в этом виде
                // (§8.1: 163/109/82). Раньше в «Списке» тут было жёстких 40px —
                // строки в «Выходах» выглядели уже и мельче, чем в категориях.
                const img = document.createElement("img");
                img.style.cssText = `width:${imgSize}px;height:${imgSize}px;object-fit:cover;border-radius:3px;background:#222;flex-shrink:0;`;
                img.loading = "lazy";
                if (e.has_preview) {
                    const stamp = st.previewStamp.get(e.id) || "";
                    img.src = `/prompt_library/preview?id=${encodeURIComponent(e.id)}`
                        + `&t=${encodeURIComponent(e.created_at || e.id)}` + (stamp ? `&r=${stamp}` : "");
                } else img.style.display = "none";
                const body = document.createElement("div");
                body.style.cssText = grid ? "min-width:0;text-align:center;" : "flex:1;min-width:0;";
                const t = plCardTitle(e, slot ? slot.i : 0, !grid);
                const m = document.createElement("div");
                m.style.cssText = "color:#8aa;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                m.textContent = isActive ? "⚡ активный вывод папки-вывода" : (e.folder || "Без категории");
                body.appendChild(t);
                // В «Списке» строка несёт и начало текста — как у обычных карточек
                if (!grid) {
                    const h = document.createElement("div");
                    h.style.cssText = "color:#bbb;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                    h.textContent = e.head || "";
                    body.appendChild(h);
                }
                body.appendChild(m);
                const del = document.createElement("button");
                del.textContent = "✖";
                del.title = "Отвязать выход (провод отключится, сокет исчезнет)";
                del.style.cssText = "background:none;border:none;cursor:pointer;font-size:12px;color:#e08a3c;flex-shrink:0;padding:0 2px;";
                del.onclick = (ev) => { ev.stopPropagation(); if (slot) st.unbindOutSlot(slot.i); };
                card.appendChild(img);
                card.appendChild(body);
                card.appendChild(del);
                card.onclick = async (ev) => {
                    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) return;
                    if (st.markEntries.size || st.markFolders.size) st.clearMarks();
                    // Папка-вывод: выбранная карточка сразу становится источником
                    // текста для этого провода (перезапись active_id → cache-key).
                    if (o.fs && o.fs.active_id !== e.id) {
                        const arr = st.readOutSlots();
                        const fs = arr.find((s) => s && s.kind === "folder" && s.path === o.fs.path);
                        if (fs) {
                            fs.active_id = e.id;
                            st.writeOutSlots(arr);
                            st.applyOutSockets();
                            st.outsActiveFolder = fs.path;
                        }
                    }
                    // v1.59: карточка «Выходов» (папки-вывода или слота) НЕ пишет в
                    // основной выход и НЕ снимает выделение — просмотр идёт панелью,
                    // привязка/переключение — только через активный вывод слота.
                    await st.fillDetail(e.id);
                    // НЕ трогаем selFolder: остаёмся в «Выходах», как в обычном режиме
                    renderTree(); render();
                    if (!st._vuePanes) st.syncNodeSize?.();
                };
                return card;
            };
            // Строка вывода в списке «Выходов»: папка-вывод или карточка, которой
            // уже нет в базе. Тянется мышью — этим меняется НОМЕР провода.
            // В сетке («Крупные»/«Средние») строка живёт в ЯЧЕЙКЕ карточки:
            // ширина = imgSize + 12 (иначе — по ширине контента, «огромная»),
            // высота — общая растяжка линии сетки, КАК у карточки без превью
            // (свой align-self не ставим: flex-start делал папку слишком
            // маленькой — отчёт пользователя, v1.45.3).
            st.slotOutRow = (slot, idx, opts) => {
                const o = opts || {};
                const grid = !!o.grid, imgSize = o.imgSize || 163;
                const row = document.createElement("div");
                row.draggable = false;
                const isSel = slot.kind === "folder" && st.outsActiveFolder === slot.path;
                const sel = isSel ? "#7fe0a8" : "#2e6b4f";
                row.style.cssText = grid
                    ? `display:flex;flex-direction:column;gap:4px;width:${imgSize + 12}px;padding:4px;border-radius:4px;cursor:pointer;border:1px solid ${sel};background:#14302a;flex-shrink:0;`
                    : `display:flex;gap:6px;align-items:center;padding:4px;border-radius:4px;cursor:pointer;border:1px solid ${sel};background:#14302a;flex-shrink:0;`;
                const num = document.createElement("span");
                num.textContent = `🔌${slot.i}`;
                num.title = `Выход «промпт ${slot.i}» · строку можно перетаскивать мышью — от этого меняется номер выхода`;
                num.style.cssText = PL_ICON_FILTER + "color:#7fe0a8;font-size:11px;flex-shrink:0;"
                    + (grid ? "align-self:center;" : "margin-right:3px;");
                const body = document.createElement("div");
                body.style.cssText = grid ? "min-width:0;overflow:hidden;text-align:center;" : "flex:1;min-width:0;";
                const t = document.createElement("div");
                t.style.cssText = "color:#fff;font-size:12px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                const m = document.createElement("div");
                m.style.cssText = "color:#8aa;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                if (slot.kind === "folder") {
                    t.textContent = `📁 ${slot.path || "?"}`;
                    const e = st.entries.find((x) => x.id === slot.active_id);
                    m.textContent = "папка-вывод" + (e ? ` · вывод: ${e.title || e.head}` : " · вывод не выбран — кликните карточку внутри");
                } else {
                    t.textContent = slot.name || slot.id || "?";
                    m.textContent = "записи нет — выход отдаст «(запись удалена)»";
                }
                const del = document.createElement("button");
                del.textContent = "✖";
                del.title = "Отвязать выход (провод отключится, сокет исчезнет)";
                del.style.cssText = "background:none;border:none;cursor:pointer;font-size:13px;color:#e08a3c;flex-shrink:0;"
                    + (grid ? "align-self:center;" : "");
                del.onclick = (ev) => { ev.stopPropagation(); st.unbindOutSlot(slot.i); };
                body.appendChild(t); body.appendChild(m);
                row.appendChild(num); row.appendChild(body); row.appendChild(del);
                st.outSlotDrag(row, idx);
                row.onclick = () => {
                    st.selFolder = "__outs";
                    st.hintSticky = null;
                    st.syncSaveFolder();
                    if (slot.kind === "folder") {
                        st.outsActiveFolder = slot.path;
                        renderTree(); render();
                        return;
                    }
                    const e = st.entries.find((x) => x.id === slot.id);
                    if (e) {
                        // v1.59: строка карточки-слота не трогает основной выход
                        st.fillDetail(e.id).then(() => { renderTree(); render(); });
                    } else {
                        renderTree(); render();
                    }
                };
                return row;
            };

            const render = () => {
                const mode = st.viewSel.value || "large";
                const grid = mode !== "list";
                const imgSize = mode === "large" ? 163 : mode === "medium" ? 109 : 82;
                st.list.style.flexDirection = grid ? "row" : "column";
                st.list.style.flexWrap = grid ? "wrap" : "nowrap";
                st.list.style.alignContent = grid ? "flex-start" : "";
                st.list.innerHTML = "";
                const selVal = selWidget ? selWidget.value : "";
                let shown = 0;
                // v1.44 (§40): категория «Выходы» — привязки доп. выходов.
                // Клик по карточке здесь работает КАК В ОБЫЧНОМ РЕЖИМЕ: подсветка,
                // превью слева, панель промпта снизу — и никакого перехода в
                // категорию, где лежит запись (раньше выбрасывало в «Всё»).
                if (st.selFolder === "__outs") {
                    const slots = st.readOutSlots();
                    const fIdx = slots.findIndex((s) => s.kind === "folder" && s.path === st.outsActiveFolder);
                    if (fIdx >= 0) {
                        // Внутри папки-вывода: её карточки (с превью). Клик отдаёт
                        // текст именно этой карточки в провод папки-вывода.
                        const fs = slots[fIdx];
                        // ВНИМАНИЕ: в «Списке» список — это flex-КОЛОНКА, поэтому
                        // `flex:1 1 100%` означало бы «занять всю высоту» (100% от
                        // высоты контейнера) — шапка растягивалась и выдавливала
                        // карточки вниз (скриншот пользователя). Полная ширина —
                        // только для сетки (там строка).
                        const head = document.createElement("div");
                        head.style.cssText = grid
                            ? "flex:1 1 100%;color:#8aa;font-size:11px;"
                            : "flex:0 0 auto;align-self:stretch;color:#8aa;font-size:11px;";
                        // Штепсель — тот же осветлённый пролёт, что и на карточках
                        // (в обычном тексте эмодзи на тёмном фоне тонет).
                        head.appendChild(plIcon("🔌 ", "margin-right:2px;"));
                        const htxt = document.createElement("span");
                        htxt.textContent = `промпт ${fs.i} · папка «${fs.path}»: клик по карточке решает, что уходит в этот провод`;
                        head.appendChild(htxt);
                        st.list.appendChild(head);
                        for (const e of st.entries.filter((x) => x.folder === fs.path)) {
                            st.list.appendChild(st.makeOutCard(e, { grid, imgSize, fs }));
                            shown++;
                        }
                        if (!shown) {
                            const empty = document.createElement("div");
                            empty.style.cssText = grid
                                ? "color:#888;padding:8px;font-size:12px;flex:1 1 100%;"
                                : "color:#888;padding:8px;font-size:12px;";
                            empty.textContent = "В папке нет записей";
                            st.list.appendChild(empty);
                        }
                        st.renderHint(shown);
                        return;
                    }
                    for (let idx = 0; idx < slots.length; idx++) {
                        const slot = slots[idx];
                        // Карточка-вывод с живой записью — обычная карточка
                        // (превью + название) с номером провода.
                        if (slot.kind === "card") {
                            const e = st.entries.find((x) => x.id === slot.id);
                            if (e) {
                                st.list.appendChild(st.makeOutCard(e, { grid, imgSize, slot }));
                                shown++;
                                continue;
                            }
                        }
                        st.list.appendChild(st.slotOutRow(slot, idx, { grid, imgSize }));
                        shown++;
                    }
                    if (!shown) {
                        const empty = document.createElement("div");
                        empty.style.cssText = "color:#888;padding:8px;font-size:12px;";
                        empty.textContent = "Выходов пока нет: выделите карточку или категорию и нажмите «🔌 Подключить выход» (или перетащите её сюда).";
                        st.list.appendChild(empty);
                    }
                    st.renderHint(shown);
                    return;
                }
                for (const e of sortedFiltered()) {
                    const card = document.createElement("div");
                    card.draggable = true;
                    // v1.44 (§40): карточка, привязанная к слоту (или активный
                    // вывод папки-слота), несёт маркер 🔌 и зелёную подсветку.
                    const outSlot = st.outSlotOfEntry(e.id) || st.folderActOf(e.id);
                    const outMark = !!outSlot;
                    card.title = (e.has_workflow
                        ? "Тяни на канвас — открыть сохранённый воркфлоу"
                        : "Воркфлоу нет (ручная запись) — прогони Queue, и воркфлоу прикрепится")
                        + " · Ctrl+клик — пометить, Shift+клик — диапазон";
                    card.ondragstart = (ev) => {
                        const ids = st.markEntries.size > 1 ? [...st.markEntries] : [e.id];
                        ev.dataTransfer.setData("text/plain", JSON.stringify({ kind: "entry", ids }));
                        try { ev.dataTransfer.setData("application/x-pl-entry", ids.join(",")); } catch (err) { /* silent */ }
                        ev.dataTransfer.effectAllowed = "copyMove";
                        ev.stopPropagation();
                    };
                    // Помеченные — левая акцент-полоса (inset box-shadow: на layout
                    // не влияет, в отличие от border) + тёплая подложка
                    const marked = st.markEntries.has(e.id);
                    const acct = marked ? "box-shadow:inset 4px 0 0 #e08a3c;" : "";
                    const bg = marked ? "#4a2f18" : outMark ? "#1c3525" : e.id === selVal ? "#1e2c44" : "#1e1e1e";
                    const border = `1px solid ${outMark ? "#2e6b4f" : e.id === selVal ? "#4a9eff" : "#333"}`;
                    card.style.cssText = grid
                        ? `display:flex;flex-direction:column;gap:4px;width:${imgSize + 12}px;padding:4px;border-radius:4px;cursor:pointer;border:${border};background:${bg};${acct}flex-shrink:0;`
                        : `display:flex;gap:6px;align-items:center;padding:4px;border-radius:4px;cursor:pointer;border:${border};background:${bg};${acct}`;

                    const img = document.createElement("img");
                    img.style.cssText = `width:${imgSize}px;height:${imgSize}px;object-fit:cover;border-radius:3px;background:#222;flex-shrink:0;`;
                    img.loading = "lazy";
                    // Стабильный t=: превью неизменно для записи (апгрейд jpg→png
                    // виден через Last-Modified → дешёвый 304, а не перезакачка).
                    // Date.now() тут был бы DDoS на 85 картинок при каждом рендере.
                    if (e.has_preview) {
                        // t=created_at — стабильный ключ кэша (иначе все превью
                        // перекачиваются на каждом рендере). После замены обложки
                        // (v1.26) добавляем локальную метку: сервер отдаёт тот же
                        // URL, и без неё браузер показал бы старую картинку.
                        const stamp = st.previewStamp.get(e.id) || "";
                        img.src = `/prompt_library/preview?id=${encodeURIComponent(e.id)}`
                            + `&t=${encodeURIComponent(e.created_at || e.id)}`
                            + (stamp ? `&r=${stamp}` : "");
                    }
                    else img.style.display = "none";

                    const body = document.createElement("div");
                    body.style.cssText = grid ? "min-width:0;text-align:center;" : "flex:1;min-width:0;";
                    // Иконки (🔌N / 📌 / 📷-🎬) — отдельными пролётами с воздухом и
                    // осветляющим фильтром (см. plCardTitle): раньше они слипались в
                    // тёмную кучу перед названием.
                    const title = plCardTitle(e, outMark ? outSlot.i : 0, !grid);
                    body.appendChild(title);
                    if (!grid) {
                        const t = document.createElement("div");
                        t.style.cssText = "color:#bbb;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                        t.textContent = e.head || "";
                        body.appendChild(t);
                    }
                    const meta = document.createElement("div");
                    meta.style.cssText = "color:#888;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                    const freq = e.use_count ? ` · ×${e.use_count}` : "";
                    meta.textContent = grid
                        ? (e.folder || "Без категории") + freq
                        : `${e.folder || "Без категории"} · ${e.created_at || ""}${e.last_used ? " · выдана " + e.last_used : ""}${freq}`;
                    body.appendChild(meta);

                    const fav = document.createElement("button");
                    fav.textContent = e.favorite ? "★" : "☆";
                    fav.title = "В избранное";
                    fav.style.cssText = "background:none;border:none;color:#e8c33a;cursor:pointer;font-size:14px;flex-shrink:0;";
                    fav.onclick = async (ev) => {
                        ev.stopPropagation();
                        const prev = e.favorite;
                        e.favorite = !prev;
                        render();
                        try {
                            const r = await st.apiPost("/prompt_library/favorite", { id: e.id, favorite: e.favorite });
                            if (!r.ok) { e.favorite = prev; render(); }
                        } catch (err) { e.favorite = prev; render(); }
                    };
                    // Закреп (v1.30, §36): только в папке — там же, где он и
                    // действует (вверху этой папки). Тот же оптимистичный
                    // паттерн, что у ★: флип → render → POST → откат при ошибке.
                    let pin = null;
                    if (st.selFolder && !st.selFolder.startsWith("__")) {
                        pin = document.createElement("button");
                        pin.textContent = "📌";
                        pin.title = e.pinned ? "Открепить" : "Закрепить вверху папки";
                        pin.style.cssText = `background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;opacity:${e.pinned ? "1" : "0.45"};`;
                        pin.onclick = async (ev) => {
                            ev.stopPropagation();
                            const prev = e.pinned;
                            e.pinned = !prev;
                            render();
                            try {
                                const r = await st.apiPost("/prompt_library/pin", { id: e.id, pinned: e.pinned });
                                if (!r.ok) { e.pinned = prev; render(); }
                            } catch (err) { e.pinned = prev; render(); }
                        };
                    }

                    const rn = document.createElement("button");
                    rn.textContent = "✏️";
                    rn.title = "Переименовать (правка прямо в строке)";
                    rn.style.cssText = "background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;";
                    rn.onclick = (ev) => {
                        ev.stopPropagation();
                        card.draggable = false; // пока правим — карточку нельзя утащить
                        st.inlineEdit(title, e.title || e.head || "", async (next) => {
                            try {
                                await st.apiPost("/prompt_library/update", { id: e.id, title: next });
                                e.title = next;
                                st.full.delete(e.id);
                            } catch (err) { /* silent */ }
                            render();
                        });
                    };

                    const del = document.createElement("button");
                    del.textContent = "🗑";
                    del.title = "Удалить книгу";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;";
                    del.onclick = async (ev) => {
                        ev.stopPropagation();
                        if (!confirm(`Удалить «${e.title || e.head}»?`)) return;
                        try {
                            await st.apiPost("/prompt_library/delete", { id: e.id });
                            st.entries = st.entries.filter((x) => x.id !== e.id);
                            st.full.delete(e.id);
                            st.previewStamp.delete(e.id);
                            if (st.detailId === e.id) { st.detailId = null; st.detail.style.display = "none"; st.shrinkBack?.(); }
                            renderTree(); render();
                            if (!st._vuePanes) st.syncNodeSize?.();
                        } catch (err) { /* silent */ }
                    };

                    card.onclick = async (ev) => {
                        // Ctrl/Shift — только метка на удаление (деталку не открываем,
                        // выбранную запись не меняем)
                        if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
                            st.markEntryToggle(e.id, !!(ev.shiftKey));
                            return;
                        }
                        // Обычный клик при наличии меток — снять весь выбор (как в проводнике)
                        if (st.markEntries.size || st.markFolders.size) st.clearMarks();
                        // v1.59: карточка, подключённая к «Выходы» (прямо слотом
                        // или папкой с ней), НЕ пишет в основной выход и НЕ снимает
                        // выделение с неподключённых промптов — «Выходы» работают
                        // независимо от выбранной записи. Панель просмотра при этом
                        // открывается (fillDetail не трогает selWidget).
                        const cardSlot = st.outSlotOfEntry(e.id);
                        const folderBound = st.outSlotOfFolder(e.folder);
                        if (!cardSlot && !folderBound) {
                            if (selWidget) selWidget.value = e.id;
                            st.anchorEntry = e.id; // обычный клик ставит якорь для Shift-диапазона
                        }
                        // v1.44 (§40): открыта папка-слот и кликнули карточку —
                        // слот сразу выводит её (перезапись active_id → cache-key
                        // меняется → нода переисполняется).
                        const arr = st.readOutSlots();
                        const folderSlot = arr.find((s) => s && s.kind === "folder" && s.path === st.selFolder);
                        if (folderSlot && folderSlot.active_id !== e.id) {
                            folderSlot.active_id = e.id;
                            st.writeOutSlots(arr);
                            st.applyOutSockets();
                        }
                        await st.fillDetail(e.id);
                        render();
                        // Vue: размером ноды владеет layout, перерисовку канваса
                        // не запрашиваем (нода — DOM, canvas не участвует).
                        if (!st._vuePanes) {
                            st.syncNodeSize?.();
                            this.graph?.setDirtyCanvas(true, true);
                        }
                    };

                    // В сетке кнопки — рядком под названием, в списке — сбоку (display:contents)
                    const actions = document.createElement("div");
                    actions.style.cssText = grid ? "display:flex;gap:2px;justify-content:center;" : "display:contents;";
                    actions.appendChild(fav);
                    if (pin) actions.appendChild(pin);
                    actions.appendChild(rn);
                    actions.appendChild(del);
                    card.appendChild(img);
                    card.appendChild(body);
                    card.appendChild(actions);
                    st.list.appendChild(card);
                    shown++;
                }
                st.renderHint(shown);
                // Страховка: если сигнал о смене режима не пришёл (сборка без
                // window.LiteGraph и без события настроек) — раскладка догонит при
                // первом же рендере. Одно чтение свойства, без таймеров и наблюдателей.
                try {
                    const vue = st.isVueNodes();
                    if (vue !== st._vuePanes) {
                        st.applyPaneLayout(vue);
                        // Догоняющий кадр: Vue мог ещё не смонтировать ноду
                        // ([data-node-id] появится только после рендера).
                        st.settleLayout?.(true);
                    }
                } catch (e) { /* silent */ }
            };
            // --- Мультивыделение на удаление (Ctrl — поштучно, Shift — диапазон) ---
            // Метки НЕ меняют текущую папку и выбранную запись → цель сохранения
            // (save_folder) всегда однозначна. Живут только в сессии.
            const rangeApply = (order, anchor, key, set) => {
                const a = order.indexOf(anchor), b = order.indexOf(key);
                if (a < 0 || b < 0) return false;
                const [lo, hi] = a < b ? [a, b] : [b, a];
                for (let i = lo; i <= hi; i++) {
                    const k = order[i];
                    if (k.startsWith("__")) continue; // служебные ветки не помечаем
                    set.add(k);
                }
                return true;
            };
            st.markEntryToggle = (id, range) => {
                // Эксклюзив: помечены папки — разметку карточек с зажатыми
                // модификаторами игнорируем (сброс чужих меток — только обычным
                // кликом, см. card.onclick / row.onclick).
                if (st.markFolders.size) return;
                if (range && st.anchorEntry && rangeApply(sortedFiltered().map((e) => e.id), st.anchorEntry, id, st.markEntries)) {
                    render();
                    return;
                }
                if (st.markEntries.has(id)) { st.markEntries.delete(id); st.anchorEntry = null; }
                else { st.markEntries.add(id); st.anchorEntry = id; }
                render();
            };
            st.markFolderToggle = (key, range) => {
                // Эксклюзив: помечены карточки — разметку папок с зажатыми
                // модификаторами игнорируем (сброс — только обычным кликом).
                if (st.markEntries.size) return;
                if (range && st.anchorFolder && rangeApply(st.folderOrder, st.anchorFolder, key, st.markFolders)) {
                    renderTree(); render();
                    return;
                }
                if (st.markFolders.has(key)) { st.markFolders.delete(key); st.anchorFolder = null; }
                else { st.markFolders.add(key); st.anchorFolder = key; }
                renderTree(); render();
            };
            st.clearMarks = () => {
                st.markEntries.clear(); st.markFolders.clear();
                st.anchorEntry = null; st.anchorFolder = null;
                renderTree(); render();
            };
            st.bulkDelete = async () => {
                const ids = [...st.markEntries], paths = [...st.markFolders];
                if (!ids.length && !paths.length) return;
                const parts = [];
                if (ids.length) parts.push(`записей: ${ids.length}`);
                if (paths.length) parts.push(`категорий: ${paths.length}`);
                const extra = paths.length ? " Записи из удалённых категорий не пропадут — переедут в корень." : "";
                if (!confirm(`Удалить ${parts.join(" и ")}?${extra}`)) return;
                try {
                    if (ids.length) {
                        await st.apiPost("/prompt_library/delete_many", { ids });
                    }
                    if (paths.length) {
                        await st.apiPost("/prompt_library/folder_delete_many", { paths });
                    }
                } catch (err) { /* silent */ }
                st.markEntries.clear(); st.markFolders.clear();
                st.anchorEntry = null; st.anchorFolder = null;
                for (const id of ids) st.previewStamp.delete(id); // метки удалённых записей
                if (st.detailId && ids.includes(st.detailId)) { st.detailId = null; st.detail.style.display = "none"; st.shrinkBack?.(); }
                if (selWidget && ids.includes(selWidget.value)) selWidget.value = "";
                if (paths.some((p) => st.selFolder === p || st.selFolder.startsWith(p + "/"))) {
                    st.selFolder = "__all";
                    st.syncSaveFolder();
                }
                await reload();
            };
            // Переименование на месте (без prompt() сверху браузера): текстовый
            // узел заменяется input'ом. Enter/уход фокуса — применить (пусто или
            // без изменений — отмена), Esc — отмена. keydown гасим на месте,
            // иначе Esc долетит до корневого слушателя меток.
            st.inlineEdit = (host, text, onCommit) => {
                const inp = document.createElement("input");
                inp.value = text;
                inp.style.cssText = "flex:1;min-width:0;width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid #4a9eff;border-radius:3px;padding:1px 4px;font-size:inherit;";
                host.innerHTML = "";
                host.appendChild(inp);
                inp.focus();
                try { inp.select(); } catch (e) { /* silent */ }
                let done = false;
                const finish = (commit) => {
                    if (done) return; done = true;
                    const v = inp.value.trim();
                    if (commit && v && v !== text) onCommit(v);
                    else { renderTree(); render(); }
                };
                inp.onkeydown = (ev) => {
                    if (ev) ev.stopPropagation();
                    if (!ev) return;
                    if (ev.key === "Enter") finish(true);
                    else if (ev.key === "Escape") finish(false);
                };
                inp.onblur = () => finish(true);
                inp.onclick = (ev) => { if (ev) ev.stopPropagation(); };
            };
            // Строка-подсказка (внизу) — одна фиксированная строка 22px:
            // есть метки → показываем bulk-бар (счётчик + кнопки) ВМЕСТО
            // подсказки; меток нет → подсказка. Высота не меняется → список
            // не дёргается. Счётчик сжимается, кнопки не выдавливаются вон.
            st.renderHint = (shown) => {
                if (st.hintSticky) st.hint.textContent = st.hintSticky;
                else if (st.detailId) st.hint.textContent = st.hintMsg;
                else {
                    const base = shown ? `Записей в категории: ${shown}. ` : "Пусто. Запустите Queue или нажмите «Сохранить промпт». ";
                    // Провод без привязки (наследие старых графов с «дырками» в
                    // нумерации выходов) — говорим вслух, а не молчим: провод есть,
                    // а текста в нём нет.
                    const orphan = (st.outOrphan && st.outOrphan.length)
                        ? `⚠ Выход «промпт ${st.outOrphan.join(", ")}» подключён проводом, но без привязки — подключите к нему карточку в «🔌 Выходах». `
                        : "";
                    st.hint.textContent = orphan + base + "Клик — открыть · Ctrl/Shift+клик — пометить · пустое место/Esc — снять.";
                }
                const nE = st.markEntries.size, nF = st.markFolders.size;
                const on = (nE + nF) > 0;
                st.hint.style.display = on ? "none" : "";
                st.bulkCount.style.display = on ? "" : "none";
                st.bulkDel.style.display = on ? "" : "none";
                st.bulkClear.style.display = on ? "" : "none";
                if (!on) return;
                const parts = [];
                if (nE) parts.push(`записей: ${nE}`);
                if (nF) parts.push(`категорий: ${nF}`);
                st.bulkCount.textContent = `Помечено — ${parts.join(", ")}.`;
                st.bulkCount.title = st.bulkCount.textContent;
            };
            // Esc снимает метки (слушатель на корне ноды — срабатывает при фокусе внутри неё).
            // outline:none — tabIndex делает div фокусируемым, без этого браузер
            // рисует контур фокуса (чисто косметика, на размер не влияет).
            root.tabIndex = 0;
            root.style.outline = "none";
            root.addEventListener("keydown", (ev) => {
                if (ev && ev.key === "Escape" && (st.markEntries.size || st.markFolders.size)) st.clearMarks?.();
            });
            // Клик по пустому месту списка/дерева снимает метки.
            // ev.target === zone отсекает всплывшие клики по карточкам/строкам
            // (у кнопок внутри — свой stopPropagation).
            for (const zone of [listContent, tree]) {
                zone.onclick = (ev) => {
                    if (ev && ev.target === zone && (st.markEntries.size || st.markFolders.size)) st.clearMarks?.();
                };
            }
            // Возврат высоты после закрытия панелей (деталка, ручной ввод).
            // Проблема: syncNodeSize только растит — открыл деталку (нода +280),
            // закрыл кликом по папке, а высота осталась → пустота внизу.
            // Решение детерминированное (не замер DOM): открытие запоминает
            // высоту, закрытие возвращает её. Только canvas — во Vue размером
            // владеет layout. Ручной ресайз пользователя шире панелей не трогаем
            // (возвращаем запомненное, а не минимум).
            st.panelOpened = () => {
                try { if (!st._vuePanes && st._prePanelH == null) st._prePanelH = this.size[1]; } catch (e) { /* silent */ }
            };
            st.shrinkBack = () => {
                try {
                    const detailHidden = !detail || detail.style.display === "none";
                    const inputHidden = !inputVisible;
                    if (!st._vuePanes && st._prePanelH != null && detailHidden && inputHidden
                        && this.size[1] > st._prePanelH) this.setSize([this.size[0], st._prePanelH]);
                    if (detailHidden && inputHidden) st._prePanelH = null;
                } catch (e) { /* silent */ }
            };
            st.render = render;
            // Полнотекстовый поиск (v1.27): локально ищем по названию / началу
            // текста / папке, а совпадение в глубине текста находит сервер
            // (/prompt_library/search отдаёт только id). Без таймеров: устаревший
            // ответ отбрасываем по номеру запроса (last-wins).
            let searchSeq = 0;
            // Пауза перед серверным запросом (дебаунс на вводе). Локальный фильтр
            // по-прежнему мгновенный; пауза только убирает лишние запросы: каждый
            // /search читает и парсит всю library.json ПОД ОБЩИМ ЗАМКОМ базы
            // (замер на живой базе: 0.165 с на 18.6 МБ), а `oninput` срабатывает
            // на каждую букву — 10 букв = 10 полных чтений базы.
            st.SEARCH_DEBOUNCE = 250;
            st.searchServer = async (q, my) => {
                try {
                    const r = await fetch(`/prompt_library/search?q=${encodeURIComponent(q)}`);
                    if (my !== searchSeq) return; // устаревший ответ — не выдаём за новый
                    if (!r.ok) return;
                    const d = await r.json();
                    if (my !== searchSeq) return;
                    st.deepIds = new Set((d && d.ids) || []);
                    render();
                } catch (e) { /* silent */ }
            };
            st.onSearch = () => {
                const q = (st.search.value || "").trim();
                const my = ++searchSeq;
                if (st._searchTimer) { clearTimeout(st._searchTimer); st._searchTimer = null; }
                if (!q) {
                    st.deepIds = null;
                    render();
                    return;
                }
                st.deepIds = null; // старый ответ не выдаём за новый
                render();          // локальные совпадения видны сразу
                st._searchTimer = setTimeout(() => {
                    st._searchTimer = null;
                    st.searchServer(q, my);
                }, st.SEARCH_DEBOUNCE);
            };
            search.oninput = () => { st.onSearch?.(); };
            sortSel.onchange = render;
            mediaSel.onchange = () => {
                try { localStorage.setItem("promptLibrary.media", mediaSel.value); } catch (e) { /* silent */ }
                render();
            };
            viewSel.onchange = () => {
                try { localStorage.setItem("promptLibrary.view", viewSel.value); } catch (e) { /* silent */ }
                render();
                // fitNode удалён.
                this.graph?.setDirtyCanvas(true, true);
            };

            bCopy.onclick = async () => {
                const txt = st.dText.value;
                try {
                    await navigator.clipboard.writeText(txt);
                    bCopy.textContent = "✅ Скопировано";
                } catch (e) {
                    st.dText.select();
                    try { document.execCommand("copy"); bCopy.textContent = "✅ Скопировано"; }
                    catch (err) { bCopy.textContent = "❌ Ошибка"; }
                }
                setTimeout(() => { bCopy.textContent = "📋 Копировать"; }, 1500);
            };
            bEdit.onclick = () => {
                for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = false;
                st.bSave.style.display = "";
                if (st.bCancel) st.bCancel.style.display = "";
                if (st.bPreview) st.bPreview.style.display = "";
                st.dTitle.focus();
            };
            bSave.onclick = async () => {
                if (!st.detailId || st._savingEdit) return; // защита от двойного клика (§32)
                st._savingEdit = true;
                try {
                    await st.apiPost("/prompt_library/update", { id: st.detailId, title: st.dTitle.value,
                        prompt: st.dText.value, folder: st.dFolder.value });
                    st.full.delete(st.detailId);
                    for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = true;
                    st.bSave.style.display = "none";
                    if (st.bCancel) st.bCancel.style.display = "none";
                    if (st.bPreview) st.bPreview.style.display = "none";
                    await reload();
                } catch (err) { /* silent */ }
                st._savingEdit = false;
            };

            // Формуляр панели книги — одна точка: клик по карточке И замена обложки
            // (после неё меняется только метка типа).
            st.fillMeta = (full) => {
                try {
                    const f = full || {};
                    const mediaLabel = f.media === "video" ? " · 🎬 видео" : f.media === "image" ? " · 📷 фото" : "";
                    const freq = f.use_count ? ` · ×${f.use_count}` : "";
                    st.dMeta.textContent = `№ ${f.id} · создана ${f.created_at || "—"} · выдана ${f.last_used || "—"}${freq}${mediaLabel}`;
                } catch (e) { /* silent */ }
            };

            // Открыть/обновить панель книги по id (режим ПРОСМОТРА: поля только
            // для чтения, кнопки правки скрыты).
            st.fillDetail = async (id) => {
                if (!id) return null;
                try {
                    if (!st.full.has(id)) {
                        const r = await fetch(`/prompt_library/entry?id=${encodeURIComponent(id)}`);
                        if (r.ok) st.full.set(id, await r.json());
                    }
                } catch (e) { return null; }
                const full = st.full.get(id);
                if (!full) return null;
                st.detailId = id;
                st.dTitle.value = full.title || "";
                st.dFolder.value = full.folder || "";
                st.dText.value = full.prompt || "";
                for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = true;
                st.bSave.style.display = "none";
                st.bWorkflow.style.display = full.workflow ? "" : "none";
                st.fillMeta(full);
                if (st.bCancel) st.bCancel.style.display = "none";
                if (st.bPreview) {
                    st.bPreview.textContent = bPreviewLabel(full.media);
                    st.bPreview.style.display = "none";
                }
                st.panelOpened?.();
                st.detail.style.display = "flex";
                st.hintMsg = "Запись выбрана. Для выдачи текста переключите режим на «📤 Выдача» или «📤📥 Выдача + запись».";
                st.hintSticky = null;
                return full;
            };

            // --- Экспорт записи в папку на диске (v1.33, §38) -----------------
            // По клику кнопки открываем системный выбор папки (File System Access
            // API, Chrome/Edge). Куда лягут файлы — зависит от содержимого записи:
            //   • обложки НЕТ   → пишем <title>.md в выбранную папку напрямую;
            //   • обложка ЕСТЬ  → создаём ПОДПАПКУ <title>/ и пишем в неё
            //     <title>.md + <title>.png/.jpg (байты обложки — роутом
            //     /prompt_library/preview, расширение по blob.type).
            // Подпапку плодим только когда есть что кроме текста — пустую директорию
            // ради одного файла не создаём. Имя файла/папки — из названия записи,
            // недопустимые для файловой системы символы вырезаются.
            st.sanitizeFileName = (name) => {
                const s = String(name || "").trim();
                return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 80) || "запись";
            };
            // Сборка .md — общая для одиночного (v1.33) и пакетного (v1.34) экспорта.
            st._entryToMd = (full) => {
                const title = st.sanitizeFileName(full.title);
                return [
                    `# ${full.title || title}`,
                    "",
                    // № записи: без него в экспорте нельзя понять, какая карточка
                    // легла в файл (и нечем доказать потерю).
                    `- №: ${full.id || "—"}`,
                    `- Категория: ${full.folder || "Без категории"}`,
                    `- Создана: ${full.created_at || ""}`,
                    `- Тип: ${full.media === "video" ? "🎬 видео" : full.media === "image" ? "📷 фото" : ""}`,
                    `- В избранном: ${full.favorite ? "да" : "нет"}`,
                    "",
                    "## Промпт",
                    "",
                    full.prompt || "",
                    "",
                ].join("\n");
            };
            st.writeEntryToDir = async (dirHandle, full) => {
                const written = [];
                const title = st.sanitizeFileName(full.title);
                const md = st._entryToMd(full);
                // Куда писать: подпапка с названием записи — только при обложке.
                let writeTo = dirHandle;
                let prefix = "";
                if (full.preview) {
                    try {
                        writeTo = await dirHandle.getDirectoryHandle(title, { create: true });
                        prefix = `${title}/`;
                    } catch (e) { /* подпапка не создалась — пишем в выбранную папку */ }
                }
                const fh = await writeTo.getFileHandle(`${title}.md`, { create: true });
                const wtr = await fh.createWritable();
                await wtr.write(md);
                await wtr.close();
                written.push(`${prefix}${title}.md`);
                if (full.preview) {
                    try {
                        const r = await fetch(`/prompt_library/preview?id=${encodeURIComponent(full.id)}`);
                        if (r.ok) {
                            const blob = await r.blob();
                            const ext = String(blob.type || "").includes("jpeg") ? ".jpg" : ".png";
                            const imgFh = await writeTo.getFileHandle(`${title}${ext}`, { create: true });
                            const imgWtr = await imgFh.createWritable();
                            await imgWtr.write(blob);
                            await imgWtr.close();
                            written.push(`${prefix}${title}${ext}`);
                        }
                    } catch (e) { /* превью — опционально */ }
                }
                return written;
            };
            st.exportEntry = async () => {
                const full = st.full.get(st.detailId) || {};
                if (!full || !full.id) {
                    st.hintSticky = "Сначала выберите запись — экспортировать пока нечего.";
                    st.renderHint?.();
                    return;
                }
                if (typeof window.showDirectoryPicker !== "function") {
                    st.hintSticky = "Ваш браузер не поддерживает выбор папки — нужен Chrome или Edge.";
                    st.renderHint?.();
                    return;
                }
                let dirHandle = null;
                try {
                    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
                } catch (e) {
                    if (e && e.name === "AbortError") return; // пользователь закрыл диалог — тихо
                    st.hintSticky = "Не удалось открыть выбор папки.";
                    st.renderHint?.();
                    return;
                }
                try {
                    const written = await st.writeEntryToDir(dirHandle, full);
                    st.hintSticky = written.length
                        ? `Сохранено: ${written.join(", ")}`
                        : "Текст не сохранился — попробуйте ещё раз.";
                    st.renderHint?.();
                } catch (err) {
                    console.warn("[PromptLibrary] export error:", err);
                    st.hintSticky = "Ошибка сохранения — файл мог быть занят или папка защищена.";
                    st.renderHint?.();
                }
            };

            // --- Пакетный экспорт: вся папка с подпапками, или отмеченное (v1.34) ---
            // Формат файла — как одиночный цикл (writeEntryToDir), НО одна разница:
            // обложка пишется РЯДОМ с .md (name.md + name.png), а не в подпапку
            // <title>/ — при десятках записей подпапка на каждую превратила бы
            // папку на диске в чащу. Структура на диске повторяет дерево категорий:
            // экспорт папки «Фото» создаёт в выбранной директории «Фото/» с её
            // файлами и подпапками («Фото/Портреты/» и т.д.). «Всё» — зеркало всей
            // базы от корня. Отмеченное — каждая запись в зеркало своей папки.
            // Имя файла в пределах ОДНОЙ папки экспорта: два разных промпта с
            // одинаковым началом дают одно авто-название (первые 60 символов), а
            // `getFileHandle(..., {create:true})` молча перезаписывает первый файл.
            // В живой базе таких групп нашлось 6 (9 записей) — «Экспорт всего»
            // терял их. Второй и следующие получают хвост " (2)", " (3)"…
            st.uniqueName = (base, used) => {
                if (!used) return base;
                let name = base;
                let n = 2;
                while (used.has(name) && n < 100) name = `${base} (${n++})`;
                used.add(name);
                return name;
            };
            st.writeEntryFlat = async (writeDir, full, used) => {
                const written = [];
                const title = st.uniqueName(st.sanitizeFileName(full.title), used);
                const md = st._entryToMd(full);
                const fh = await writeDir.getFileHandle(`${title}.md`, { create: true });
                const wtr = await fh.createWritable();
                await wtr.write(md);
                await wtr.close();
                written.push(`${title}.md`);
                if (full.preview) {
                    try {
                        const r = await fetch(`/prompt_library/preview?id=${encodeURIComponent(full.id)}`);
                        if (r.ok) {
                            const blob = await r.blob();
                            const ext = String(blob.type || "").includes("jpeg") ? ".jpg" : ".png";
                            const imgFh = await writeDir.getFileHandle(`${title}${ext}`, { create: true });
                            const imgWtr = await imgFh.createWritable();
                            await imgWtr.write(blob);
                            await imgWtr.close();
                            written.push(`${title}${ext}`);
                        }
                    } catch (e) { /* превью — опционально */ }
                }
                return written;
            };
            // Последовательное создание вложенных директорий: рекурсивной записи
            // в File System Access API нет, каждый сегмент — отдельный вызов.
            st.ensureDirPath = async (dirHandle, relPath) => {
                let cur = dirHandle;
                for (const seg of String(relPath || "").split("/")) {
                    if (!seg) continue;
                    cur = await cur.getDirectoryHandle(seg, { create: true });
                }
                return cur;
            };
            // Полный текст записей: в st.entries из /list лежит только head (первые
            // 120 символов), для экспорта нужен весь prompt. Пул из нескольких
            // параллельных fetch /entry, порядок результата не важен (Map по id).
            st.loadFulls = async (ids, limit = 6) => {
                const out = new Map();
                let i = 0;
                const worker = async () => {
                    while (i < ids.length) {
                        const id = ids[i++];
                        try {
                            const r = await fetch(`/prompt_library/entry?id=${encodeURIComponent(id)}`);
                            if (r.ok) out.set(id, await r.json());
                        } catch (e) { /* пропускаем — запишется то, что догрузилось */ }
                    }
                };
                await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, () => worker()));
                return out;
            };
            // Куда ложится запись относительно корня экспорта: последний сегмент
            // пути папки плюс всё, что глубже. Рядом с корнем — без префикса.
            st.relFolder = (folder, pathKey) => {
                if (!folder) return "";
                if (folder === pathKey) return "";
                if (pathKey && folder.startsWith(pathKey + "/")) return folder.slice(pathKey.length + 1);
                return folder; // «Всё»/избранное/отмеченное — зеркало от корня
            };
            // Прогресс-бар экспорта: show=true открывает полосу, show=false прячет.
            // done/total — для частичного заполнения (вызов с каждой записью).
            st.setExportProgress = (show, done, total) => {
                st.progTrack.style.display = show ? "" : "none";
                // На время экспорта прячем подсказку — бар занимает всю строку
                // (иначе узкий, едва заметный).
                st.hint.style.display = show ? "none" : "";
                if (show && total > 0) {
                    const pct = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
                    st.progFill.style.width = pct + "%";
                }
            };
            // --- Импорт из файлов (v1.56, Stage 1: .md + обложки) ------------
            // Файлы живут у клиента, поэтому разбор делает браузер, а сервер
            // принимает готовый список записей (/prompt_library/import) — одна
            // форма для любого источника (.md сейчас, PNG/HTML/текст дальше).
            // Разбор .md — зеркало того, что пишет _entryToMd (экспорт):
            // «# название», «- № / Категория / Создана / Тип / В избранном»,
            // «## Промпт» и сам текст. Чужой .md (без шапки) читаем как текст:
            // название — из первого «# …» либо из имени файла, промпт — всё тело.
            st.parseImportMd = (text, fallbackTitle) => {
                const src = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                const out = { own: false, title: "", prompt: "", folder: "",
                              created_at: "", favorite: false, media: null };
                const grab = (re) => { const m = re.exec(src); return m ? m[1].trim() : ""; };
                const head = /^#\s+([^\n]*)/m.exec(src);
                const num = grab(/^[-*]\s*№:\s*([^\n]*)/m);
                const cat = grab(/^[-*]\s*Категория:\s*([^\n]*)/m);
                const created = grab(/^[-*]\s*Создана:\s*([^\n]*)/m);
                const type = grab(/^[-*]\s*Тип:\s*([^\n]*)/m);
                const fav = grab(/^[-*]\s*В избранном:\s*([^\n]*)/m);
                // «Свой» — по шапке, которую пишет экспорт; одного «## Промпт»
                // мало (такой заголовок встречается и в чужих файлах).
                const own = !!(num || cat || (created && /^##\s*Промпт\s*$/m.test(src)));
                if (own) {
                    out.own = true;
                    out.title = (head ? head[1].trim() : "") || String(fallbackTitle || "");
                    const i = src.search(/^##\s*Промпт\s*$/m);
                    let body = i >= 0 ? src.slice(i).replace(/^##\s*Промпт[^\n]*\n?/, "") : src;
                    out.prompt = body.replace(/^\n+/, "").replace(/\s+$/, "");
                    // «Без категории» — это корень (пустая папка), а не категория
                    // с таким названием (иначе при импорте заводилась бы папка).
                    out.folder = cat === "Без категории" ? "" : cat;
                    out.created_at = created;
                    out.favorite = /^да$/i.test(fav);
                    out.media = /видео/i.test(type) ? "video" : (/фото/i.test(type) ? "image" : null);
                    return out;
                }
                let rest = src.trim();
                const h1 = /^#\s+(.+)\n?/.exec(rest);
                out.title = String(fallbackTitle || "");
                if (h1) { out.title = h1[1].trim() || out.title; rest = rest.slice(h1[0].length); }
                out.prompt = rest.trim();
                return out;
            };
            // Чем отправлять обложку: небольшие PNG — КАК ЕСТЬ, потому что в них
            // лежит чанк workflow нашего экспорта, и сервер вернёт по нему
            // параметры генерации (v1.56). Остальное ужимаем в браузере: dataURL
            // многомегабайтной картинки не пролезет в запрос (сервер режет по 8МБ).
            st.coverPlan = (name, size) => (/\u002epng$/i.test(String(name || ""))
                && Number(size || 0) <= 4_000_000) ? "raw" : "shrink";
            st.fileToDataUrl = (file) => new Promise((resolve) => {
                try {
                    const fr = new FileReader();
                    fr.onload = () => resolve(String(fr.result || ""));
                    fr.onerror = () => resolve("");
                    fr.readAsDataURL(file);
                } catch (e) { resolve(""); }
            });
            st.shrinkToPng = async (file, max = 512) => {
                try {
                    const bmp = await createImageBitmap(file);
                    const k = Math.min(1, max / Math.max(bmp.width || 1, bmp.height || 1));
                    const w = Math.max(1, Math.round((bmp.width || 1) * k));
                    const h = Math.max(1, Math.round((bmp.height || 1) * k));
                    const cv = document.createElement("canvas");
                    cv.width = w; cv.height = h;
                    cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
                    return cv.toDataURL("image/png");
                } catch (e) { return ""; }
            };
            st.coverDataUrl = async (entry) => {
                if (!entry) return "";
                // Имя и размер живут у File, а не у записи каталога: решение
                // «как есть / ужать» принимается по реальному файлу.
                let file = null;
                try { file = await entry.getFile(); } catch (e) { return ""; }
                if (!file) return "";
                return st.coverPlan(file.name, file.size) === "raw"
                    ? await st.fileToDataUrl(file) : await st.shrinkToPng(file);
            };
            // «Без категории» по умолчанию импортирует ПЛОСКО (решение
            // пользователя), остальные ветки — со структурой; галочка в диалоге
            // переключает. Маппинг категорий живёт на сервере (_import_target_folder),
            // чтобы правило «куда лёг файл» существовало в одном месте.
            st.importTreeDefault = (target) => String(target || "") !== "__root";
            // Обход папки: .md + обложка с тем же базовым именем рядом ЛИБО в
            // подпапке с этим именем (так выгружает одиночный экспорт v1.33).
            st.collectImportDir = async (dirHandle) => {
                const out = [];
                const exts = [".png", ".jpg", ".jpeg", ".webp"];
                const walk = async (dir, rel) => {
                    const files = [];
                    const dirs = [];
                    for await (const entry of dir.values()) {
                        if (entry.kind === "file") files.push(entry);
                        else if (entry.kind === "directory") dirs.push(entry);
                    }
                    const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
                    for (const f of files) {
                        if (!/\.md$/i.test(f.name)) continue;
                        const base = f.name.replace(/\.md$/i, "");
                        let cover = null;
                        for (const ext of exts) {
                            const hit = byName.get((base + ext).toLowerCase());
                            if (hit) { cover = hit; break; }
                        }
                        out.push({ rel: rel ? rel + "/" + f.name : f.name, base, file: f, cover });
                    }
                    for (const d of dirs) await walk(d, rel ? rel + "/" + d.name : d.name);
                };
                await walk(dirHandle, "");
                return out;
            };
            // Меню выбора источника: простой фиксированный оверлей вне ноды —
            // раскладку и BASE_H не трогает (см. §49).
            st.uiPanel = (opts) => {
                const wrap = document.createElement("div");
                wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;";
                const box = document.createElement("div");
                box.style.cssText = "min-width:300px;max-width:520px;background:#1c1c1c;color:#e6e6e6;border:1px solid #3a3a3a;border-radius:8px;padding:14px 16px;font:12px system-ui,'Segoe UI',sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.55);";
                const h = document.createElement("div");
                h.textContent = opts.title || "";
                h.style.cssText = "font-size:14px;font-weight:bold;margin-bottom:6px;";
                box.appendChild(h);
                if (opts.subtitle) {
                    const s = document.createElement("div");
                    s.textContent = opts.subtitle;
                    s.style.cssText = "color:#aaa;margin-bottom:10px;line-height:1.4;";
                    box.appendChild(s);
                }
                const close = () => { try { document.body.removeChild(wrap); } catch (e) { /* silent */ } };
                for (const it of (opts.items || [])) {
                    const b = document.createElement("button");
                    b.textContent = it.label;
                    b.disabled = !!it.disabled;
                    b.title = it.hint || "";
                    b.style.cssText = "display:block;width:100%;text-align:left;margin:4px 0;padding:7px 10px;border-radius:5px;font-size:12px;cursor:"
                        + (it.disabled ? "not-allowed;border:1px dashed #3a3a3a;background:#222;color:#777;"
                                       : "pointer;border:1px solid #4a6a9a;background:#2c4a73;color:#dfe8ff;");
                    b.onclick = () => { close(); if (it.onClick) it.onClick(); };
                    box.appendChild(b);
                }
                const cancel = document.createElement("button");
                cancel.textContent = "Отмена";
                cancel.style.cssText = "display:block;width:100%;margin-top:8px;padding:6px 10px;border-radius:5px;border:1px solid #444;background:#2a2a2a;color:#ccc;cursor:pointer;font-size:12px;";
                cancel.onclick = close;
                box.appendChild(cancel);
                wrap.onclick = (ev) => { if (ev.target === wrap) close(); };
                wrap.appendChild(box);
                document.body.appendChild(wrap);
                return { close, box, items: (opts.items || []) };
            };
            st.importSummary = (rep, extra) => {
                const e = extra || {};
                const nCreated = ((rep && rep.created) || []).length;
                const nSkip = ((rep && rep.skipped) || []).length;
                const nFail = (((rep && rep.failed) || []).length) + (e.bad || 0);
                const parts = [`создано ${nCreated}`];
                if (nSkip) parts.push(`пропущено дубликатов ${nSkip}`);
                if (nFail) parts.push(`без текста ${nFail}`);
                if (e.coverFail) parts.push(`без обложки ${e.coverFail}`);
                return parts.join(", ");
            };
            // Общий проход импорта (v1.57): запись списка записей + привязка
            // обложек. Выделен из .md-потока, чтобы PNG/галерея/текст делили
            // один путь «составили файлы → записали → обложки → отчёт». Цель
            // читается из st.selFolder — у всех источников она одна.
            st.importRun = async (items, tree, extra) => {
                if (!items || !items.length) return;
                const target = st.selFolder || "__all";
                st.setExportProgress(true, 0, items.length);
                st.hintSticky = `Импортирую ${items.length} записей…`;
                st.renderHint?.();
                let rep = null;
                try {
                    const r = await st.apiPost("/prompt_library/import", {
                        target, tree,
                        items: items.map((it) => ({ title: it.title, prompt: it.prompt,
                            folder: it.folder, created_at: it.created_at,
                            favorite: it.favorite, media: it.media, src: it.src,
                            workflow: it.workflow || null })),
                    });
                    rep = await r.json().catch(() => null);
                    if (!r.ok) {
                        // Отказы сервера (лимит базы / служебная цель) — говорим
                        // причину словами, ничего не додумывая.
                        let why = (rep && rep.error) || "неизвестная ошибка";
                        if (rep && rep.error === "limit") {
                            why = `не хватает места в базе: свободно ${rep.free} из ${rep.max}, а записей ${rep.want}`;
                        }
                        st.setExportProgress(false);
                        st.hintSticky = `Импорт отменён: ${why}.`;
                        st.renderHint?.();
                        st.toast("error", "Prompt Library: импорт не выполнен", why);
                        return;
                    }
                } catch (e) {
                    st.setExportProgress(false);
                    st.hintSticky = "Импорт сорвался: сервер не ответил.";
                    st.renderHint?.();
                    return;
                }
                // Сервер ответил ok, но без читаемого JSON (rare): отчёт «создано 0».
                if (rep === null) rep = {};
                // Обложки — по одной, тихо (без перезагрузки соседних нод на каждом
                // файле), одним итоговым локальным обновлением.
                const bySrc = new Map();
                for (const c of ((rep && rep.created) || [])) if (c && c.src) bySrc.set(c.src, c.id);
                let coverFail = 0, done = 0;
                for (const it of items) {
                    const id = bySrc.get(it.src);
                    if (id && it._cover) {
                        try {
                            const dataUrl = await st.coverDataUrl(it._cover);
                            if (dataUrl) {
                                const r2 = await st.apiPost("/prompt_library/attach_preview",
                                    { id, preview_data: dataUrl, media: it.media || "image", force: true },
                                    { quiet: true });
                                if (!r2.ok) coverFail++;
                            } else { coverFail++; }
                        } catch (e) { coverFail++; }
                    }
                    done++;
                    st.setExportProgress(true, done, items.length);
                    st.hintSticky = `Импорт: ${done} из ${items.length}…`;
                    st.renderHint?.();
                }
                try { plRefreshLocal(st); } catch (e) { /* silent */ }
                await reload();
                st.setExportProgress(false);
                const summary = st.importSummary(rep, { bad: (extra && extra.bad) || 0, coverFail });
                st.hintSticky = `Импорт из «${target === "__all" ? "Всё" : target === "__root" ? "Без категории" : target}»: ${summary}.`;
                st.renderHint?.();
                const sk = (rep.skipped || []).slice(0, 3)
                    .map((s) => `«${s.title}» — уже в «${s.exists_folder || "корне"}»`).join("; ");
                st.toast(summary.includes("дубликатов") ? "warn" : "success",
                    "Prompt Library: импорт", summary + (sk ? `. Дубликаты: ${sk}${(rep.skipped || []).length > 3 ? " и др." : ""}` : ""));
            };
            // Главный проход: выбрали папку → собрали → разобрали → записали → обложки.
            st.importMdFromFolder = async (tree) => {
                if (typeof window.showDirectoryPicker !== "function") {
                    st.toast("warn", "Prompt Library: импорт", "Нужен Chrome или Edge — выбор папки недоступен.");
                    return;
                }
                let dir = null;
                try {
                    dir = await window.showDirectoryPicker({ mode: "read" });
                } catch (e) {
                    if (e && e.name === "AbortError") return;  // закрыл диалог — тихо
                    st.toast("warn", "Prompt Library: импорт", "Не удалось открыть выбор папки.");
                    return;
                }
                st.setExportProgress(true, 0, 1);
                st.hintSticky = "Импорт: смотрю папку…";
                st.renderHint?.();
                let found = [];
                try {
                    found = await st.collectImportDir(dir);
                } catch (e) { /* пустая выборка — отчитаемся ниже */ }
                if (!found.length) {
                    st.setExportProgress(false);
                    st.hintSticky = "Импорт: в папке нет .md (Stage 1 читает .md и обложки).";
                    st.renderHint?.();
                    return;
                }
                const items = [];
                let bad = 0;
                for (const f of found) {
                    let text = "";
                    try { text = await (await f.file.getFile()).text(); }
                    catch (e) { bad++; continue; }
                    const p = st.parseImportMd(text, f.base);
                    if (!p.prompt) { bad++; continue; }
                    items.push({ title: p.title, prompt: p.prompt, folder: p.folder,
                                 created_at: p.created_at, favorite: p.favorite,
                                 media: p.media, src: f.rel, _cover: f.cover });
                }
                if (!items.length) {
                    st.setExportProgress(false);
                    st.hintSticky = `Импорт: пригодных .md не нашлось (${found.length} файлов).`;
                    st.renderHint?.();
                    return;
                }
                await st.importRun(items, tree, { bad });
            };
            // Кнопка «📥 Импорт»: меню источников (v1.57 — все четыре активны).
            st.importStart = () => {
                const t = st.selFolder || "__all";
                const where = t === "__all" ? "📚 Всё" : t === "__root" ? "📄 Без категории"
                    : t.startsWith("__") ? "служебная ветка" : `📁 ${t}`;
                st.uiPanel({
                    title: "📥 Импорт в библиотеку",
                    subtitle: `Куда: ${where}. Что уже есть в базе — не импортируется, такие записи попадут в отчёт.`,
                    items: [
                        { label: "📁 Папка с .md и обложками", onClick: () => st.importPickTree(t) },
                        { label: "🖼 PNG из ComfyUI", onClick: () => st.importPickPng(t) },
                        { label: "🌐 HTML-галерея", onClick: () => st.importPickHtml(t) },
                        { label: "📝 Текстовый файл", onClick: () => st.importPickText(t) },
                    ],
                });
            };
            // Служебные ветки не место хранения (§24): объясняем и не начинаем.
            st.importGuard = (target) => {
                if (target === "__fav" || target === "__outs") {
                    st.toast("warn", "Prompt Library: импорт",
                        target === "__fav" ? "«Избранное» — не место хранения: выберите категорию или «Всё»."
                                           : "«🔌 Выходы» — только привязки выходов: выберите категорию или «Всё».");
                    return true;
                }
                return false;
            };
            st.importPickTree = (target) => {
                if (st.importGuard(target)) return;
                if (target === "__root") {
                    // Решение о структуре появляется только когда оно вообще есть.
                    st.uiPanel({
                        title: "📄 Импорт в «Без категории»",
                        subtitle: "Категории из файлов можно сохранить или положить всё плоско в корень.",
                        items: [
                            { label: "Плоско в корень (без категорий)", onClick: () => st.importMdFromFolder(false) },
                            { label: "Сохранить структуру как категории", onClick: () => st.importMdFromFolder(true) },
                        ],
                    });
                    return;
                }
                st.importMdFromFolder(st.importTreeDefault(target));
            };
            // PNG из ComfyUI (v1.58): выбор способа — папка со всеми PNG либо
            // отдельные файлы. Категорий в PNG нет вовсе, поэтому после выбора
            // файлов диалога структуры не бывает.
            st.importPickPng = (target) => {
                if (st.importGuard(target)) return;
                st.uiPanel({
                    title: "🖼 PNG из ComfyUI",
                    subtitle: "Папка — все PNG в выбранном каталоге; файлы — один или несколько на выбор.",
                    items: [
                        { label: "📂 Папка со всеми PNG", onClick: () => st.importPngFromFolder() },
                        { label: "🖼 Отдельные файлы (один или несколько)", onClick: () => st.pickPngFiles() },
                    ],
                });
            };
            // HTML-галерея: структура карточек как категории — то же решение, что
            // у .md (галочка появляется только для «Без категории»).
            st.importPickHtml = (target) => {
                if (st.importGuard(target)) return;
                if (target === "__root") {
                    st.uiPanel({
                        title: "🌐 Импорт галереи в «Без категории»",
                        subtitle: "Категории из карточек можно сохранить или положить всё плоско в корень.",
                        items: [
                            { label: "Плоско в корень (без категорий)", onClick: () => st.importHtmlFromFolder(false) },
                            { label: "Сохранить структуру как категории", onClick: () => st.importHtmlFromFolder(true) },
                        ],
                    });
                    return;
                }
                st.importHtmlFromFolder(st.importTreeDefault(target));
            };
            // Текстовый файл: скрытый input[type=file], чтение в браузер, дальше
            // диалог «как разбить» (textSplitDialog). Категорий нет.
            st.importPickText = (target) => {
                if (st.importGuard(target)) return;
                const input = document.createElement("input");
                input.type = "file";
                input.multiple = true;
                input.accept = ".txt,.md,text/plain,text/markdown";
                input.style.display = "none";
                input.onchange = async () => {
                    const files = Array.from(input.files || []).filter((f) => /\.(txt|md)$/i.test(f.name));
                    if (!files.length) return;
                    const readFiles = [];
                    for (const f of files) {
                        let text = "";
                        try {
                            text = f.text? await f.text() : await new Promise((res, rej) => {
                                const fr = new FileReader();
                                fr.onload = () => res(String(fr.result || ""));
                                fr.onerror = rej;
                                fr.readAsText(f);
                            });
                        } catch (e) { continue; }
                        readFiles.push({ base: f.name, text });
                    }
                    if (!readFiles.length) return;
                    st.textSplitDialog(readFiles);
                };
                document.body.appendChild(input);
                input.click();
                setTimeout(() => { try { document.body.removeChild(input); } catch (e) { /* silent */ } }, 2000);
            };
            // --- v1.57: импорт PNG из ComfyUI ---------------------------------
            // Чанки tEXt/iTXt читаются в UTF-8 по ключевому слову (prompt —
            // API-граф, workflow — UI-граф). Возвращается объект {keyword: text};
            // одно имя дважды — перезаписывает (последний чанк).
            st.pngChunks = (buf) => {
                const out = {};
                if (!buf || buf.length < 8) return out;
                const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
                for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return out;
                const utf8 = (bytes) => {
                    try { return new TextDecoder("utf-8").decode(bytes); }
                    catch (e) { return Array.from(bytes).map((b) => String.fromCharCode(b)).join(""); }
                };
                const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                let p = 8;
                while (p + 8 <= buf.length) {
                    const len = dv.getUint32(p); p += 4;
                    const type = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]); p += 4;
                    if (len > buf.length - p) break; // обрезанный хвост — останавливаемся
                    const data = len > 0 ? buf.slice(p, p + len) : new Uint8Array(0);
                    p += len + 4; // + CRC (не проверяем)
                    if (type === "tEXt") {
                        let k = 0; while (k < data.length && data[k] !== 0) k++;
                        if (k > 0) out[utf8(data.slice(0, k))] = utf8(data.slice(k + 1));
                    } else if (type === "iTXt") {
                        let k = 0; while (k < data.length && data[k] !== 0) k++;
                        if (k === 0) continue;
                        const kw = utf8(data.slice(0, k));
                        const compFlag = data[k + 1];
                        let q = k + 3; while (q < data.length && data[q] !== 0) q++;
                        let r = q + 1; while (r < data.length && data[r] !== 0) r++;
                        if (compFlag === 0) out[kw] = utf8(data.slice(r + 1));
                    }
                }
                return out;
            };
            // Положительный промпт из API-графа (чанк prompt): каждый узел
            // /sampler/i по очереди → inputs.positive → следуем по inputs.text
            // (строка ИЛИ ссылка [id, idx]) до глубины 4; берём первый рабочий
            // результат (сэмплер без positive — например SamplerCustomAdvanced —
            // пропускается, а не глушит разбор). Без результата — единственный
            // CLIPTextEncode с непустым текстом. Не нашлось — "".
            st.promptFromGraph = (graph) => {
                const g = graph || {};
                const ids = Object.keys(g);
                const textVia = (pos) => {
                    if (!Array.isArray(pos)) return null;
                    let nodeId = String(pos[0]);
                    const seen = new Set();
                    let depth = 0;
                    while (nodeId && g[nodeId] && !seen.has(nodeId) && depth < 4) {
                        seen.add(nodeId);
                        const t = (g[nodeId].inputs || {}).text;
                        if (typeof t === "string") return t;
                        if (Array.isArray(t) && t.length) { nodeId = String(t[0]); depth++; }
                        else return null;
                    }
                    return null;
                };
                const samplers = ids.filter((id) => /sampler/i.test(g[id].class_type || ""));
                for (const sid of samplers) {
                    const t = textVia(g[sid].inputs && g[sid].inputs.positive);
                    if (t) return t;
                }
                const enc = ids.filter((id) => /cliptextencode/i.test(g[id].class_type || "")
                    && typeof (g[id].inputs || {}).text === "string"
                    && String(g[id].inputs.text).trim() !== "");
                return enc.length === 1 ? g[enc[0]].inputs.text : "";
            };
            // Положительный промпт из UI-графа (чанк workflow): первый
            // CLIPTextEncode с непустым первым виджетом (widgets могут не
            // совпадать по индексу с inputs — текст живёт в widgets[0]).
            st.promptFromWorkflow = (ui) => {
                const nodes = (ui && ui.nodes) || [];
                const enc = nodes.find((n) => /cliptextencode/i.test(n.type || "")
                    && Array.isArray(n.widgets) && n.widgets.length
                    && typeof n.widgets[0] === "string" && n.widgets[0].trim() !== "");
                return enc ? enc.widgets[0] : "";
            };
            // Обход папки: все *.png (вложенные — тоже), rel-путь от корня.
            st.collectImportPng = async (dirHandle) => {
                const out = [];
                const walk = async (dir, prefix) => {
                    const files = [], dirs = [];
                    for await (const e of dir.values()) {
                        if (e.kind === "file") files.push(e); else if (e.kind === "directory") dirs.push(e);
                    }
                    for (const f of files) if (/\.png$/i.test(f.name)) {
                        out.push({ rel: prefix ? prefix + "/" + f.name : f.name, file: f });
                    }
                    for (const d of dirs) await walk(d, prefix ? prefix + "/" + d.name : d.name);
                };
                await walk(dirHandle, "");
                return out;
            };
            // Чтение файла в байты: arrayBuffer там, где есть, иначе FileReader
            // (старые браузеры). Единая точка для папки и отдельных файлов.
            st._fileToBytes = async (file) => {
                if (!file) return null;
                try {
                    if (file.arrayBuffer) return new Uint8Array(await file.arrayBuffer());
                    return new Uint8Array(await new Promise((res, rej) => {
                        const fr = new FileReader();
                        fr.onload = () => res(fr.result);
                        fr.onerror = rej;
                        fr.readAsArrayBuffer(file);
                    }));
                } catch (e) { return null; }
            };
            // Разбор PNG-чанков в запись: apи-граф → положительный промпт (или
            // UI-граф → widgets), граф уходит в запись (а не только в обложку):
            // на PNG тяжелее 4МБ обложка сжимается и чанк теряется, а «Параметры
            // генерации» берутся из графа записи. Одинаково для папки и файлов.
            st.pngItemFromBuf = (buf) => {
                let prompt = "";
                let workflow = null;
                if (buf && buf.length) {
                    try {
                        const chunks = st.pngChunks(buf);
                        let api = null, ui = null;
                        if (chunks.prompt) {
                            const p = JSON.parse(chunks.prompt);
                            if (p && typeof p === "object" && !Array.isArray(p)) api = p;
                        }
                        if (!api && chunks.workflow) {
                            const u = JSON.parse(chunks.workflow);
                            if (u && typeof u === "object" && !Array.isArray(u)) ui = u;
                        }
                        prompt = st.promptFromGraph(api || {});
                        if (!prompt && ui) prompt = st.promptFromWorkflow(ui);
                        workflow = api || ui || null;
                    } catch (e) { /* чанк есть, но не JSON — оставляем пусто */ }
                }
                return { prompt, workflow };
            };
            // Импорт выбранных файлов (v1.58): один или несколько PNG из
            // штатного файлового диалога работает в любом браузере — в отличие
            // от showDirectoryPicker (Chrome/Edge). src делаем уникальным (по нему
            // приклеивается обложка): два файла с одинаковым именем получили бы
            // один src и вторая обложка перезаписала бы первую.
            st.importPngFromFiles = async (files) => {
                if (!files || !files.length) return;
                st.setExportProgress(true, 0, files.length);
                st.hintSticky = `Импорт: читаю ${files.length} PNG…`;
                st.renderHint?.();
                const items = [];
                const used = new Set();
                for (const f of files) {
                    const buf = await st._fileToBytes(f);
                    const parsed = st.pngItemFromBuf(buf);
                    const base = f.name.replace(/\.png$/i, "");
                    let src = f.name, n = 2;
                    while (used.has(src)) src = `${base}_${n++}.png`;
                    used.add(src);
                    items.push({ title: base, prompt: parsed.prompt, folder: "", created_at: "",
                        favorite: false, media: "image", workflow: parsed.workflow, src,
                        _cover: { name: f.name, size: f.size, getFile: async () => f } });
                }
                await st.importRun(items, false);
            };
            // Файловый диалог (v1.58): скрытый input — тот же паттерн, что у
            // текстового импорта (§50.4), только accept под PNG.
            st.pickPngFiles = () => {
                const input = document.createElement("input");
                input.type = "file";
                input.multiple = true;
                input.accept = "image/png,.png";
                input.style.display = "none";
                input.onchange = async () => {
                    const files = Array.from(input.files || []).filter((f) => /\.png$/i.test(f.name));
                    if (!files.length) return;
                    await st.importPngFromFiles(files);
                };
                document.body.appendChild(input);
                input.click();
                setTimeout(() => { try { document.body.removeChild(input); } catch (e) { /* silent */ } }, 2000);
            };
            // Ряд источников: PNG из ComfyUI — обложка сам файл («raw», он же
            // разбор чанка), категорий нет.
            st.importPngFromFolder = async () => {
                st.setExportProgress(true, 0, 1);
                st.hintSticky = "Импорт: смотрю папку…";
                st.renderHint?.();
                if (typeof window.showDirectoryPicker !== "function") {
                    st.setExportProgress(false);
                    st.hintSticky = "Ваш браузер не поддерживает выбор папки — нужен Chrome или Edge.";
                    st.renderHint?.();
                    return;
                }
                let dirHandle = null;
                try { dirHandle = await window.showDirectoryPicker(); }
                catch (e) {
                    st.setExportProgress(false);
                    if (e && e.name === "AbortError") return;
                    st.hintSticky = "Не удалось открыть выбор папки.";
                    st.renderHint?.();
                    return;
                }
                const found = await st.collectImportPng(dirHandle);
                if (!found.length) {
                    st.setExportProgress(false);
                    st.hintSticky = "Импорт: пригодных PNG не нашлось (0 файлов).";
                    st.renderHint?.();
                    return;
                }
                const items = [];
                for (const p of found) {
                    let file = null;
                    try { file = await p.file.getFile(); } catch (e) { /* файл не прочитался — без промпта */ }
                    const parsed = st.pngItemFromBuf(file ? await st._fileToBytes(file) : null);
                    const base = p.rel.split("/").pop().replace(/\.png$/i, "");
                    items.push({ title: base, prompt: parsed.prompt, folder: "", created_at: "",
                        favorite: false, media: "image", workflow: parsed.workflow, src: p.rel,
                        _cover: p.file });
                }
                await st.importRun(items, false);
            };
            // --- v1.57: import HTML-галереи ------------------------------------
            // Обратный ход экспорта «Галереей»: карточка → запись, рел-путь
            // превью → файл рядом (img src кодируется по сегментам).
            st._htmlUnesc = (s) => String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
            st._htmlRelDecode = (s) => String(s || "").split("/")
                .map((seg) => { try { return decodeURIComponent(seg); } catch (e) { return seg; } }).join("/");
            st.parseGalleryHtml = (html) => {
                const body = String(html || "");
                const cards = [];
                const parts = body.split('<div class="pl-card">');
                for (let i = 1; i < parts.length; i++) {
                    const b = parts[i];
                    const titleM = /<div class="pl-title">([\s\S]*?)<\/div>/.exec(b);
                    const promptM = /<details class="pl-prompt">[\s\S]*?<pre>([\s\S]*?)<\/pre>/i.exec(b);
                    const imgM = /<img src="([^"]*)"/i.exec(b);
                    if (!titleM) continue;
                    const kv = {};
                    let cur = null;
                    const reRow = /<tr><td class="k">([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g;
                    while ((cur = reRow.exec(b)) !== null) kv[st._htmlUnesc(cur[1]).trim()] = st._htmlUnesc(cur[2]).trim();
                    const folder = (kv["Категория"] && kv["Категория"] !== "Без категории")
                        ? kv["Категория"] : "";
                    const rawMedia = kv["Тип"] || "";
                    const media = /🎬/.test(rawMedia) ? "video" : /📷/.test(rawMedia) ? "image" : "";
                    cards.push({
                        title: st._htmlUnesc(titleM[1]).trim(),
                        prompt: promptM ? st._htmlUnesc(promptM[1]) : "",
                        folder,
                        created_at: kv["Создана"] || "",
                        media: media || "",
                        favorite: (kv["В избранном"] || "").trim() === "да",
                        relImg: imgM ? st._htmlRelDecode(imgM[1]) : "",
                    });
                }
                return cards;
            };
            // Обход: файлы раньше подпапок (карточки в корне — приоритетнее),
            // html-файлы и карта изображений rel→entry по всему дереву.
            st.collectImportHtml = async (dirHandle) => {
                const htmls = [];
                const images = new Map();
                const walk = async (dir, prefix) => {
                    const files = [], dirs = [];
                    for await (const e of dir.values()) {
                        if (e.kind === "file") files.push(e); else if (e.kind === "directory") dirs.push(e);
                    }
                    for (const f of files) {
                        const rel = prefix ? prefix + "/" + f.name : f.name;
                        if (/prompt_library\.html$/i.test(f.name)) {
                            htmls.push({ rel, file: f });
                        } else if (/\.(png|jpe?g|webp|gif)$/i.test(f.name)) {
                            images.set(rel, f);
                        }
                    }
                    for (const d of dirs) await walk(d, prefix ? prefix + "/" + d.name : d.name);
                };
                await walk(dirHandle, "");
                return { htmls, images };
            };
            st.importHtmlFromFolder = async (tree) => {
                st.setExportProgress(true, 0, 1);
                st.hintSticky = "Импорт: смотрю папку…";
                st.renderHint?.();
                if (typeof window.showDirectoryPicker !== "function") {
                    st.setExportProgress(false);
                    st.hintSticky = "Ваш браузер не поддерживает выбор папки — нужен Chrome или Edge.";
                    st.renderHint?.();
                    return;
                }
                let dirHandle = null;
                try { dirHandle = await window.showDirectoryPicker(); }
                catch (e) {
                    st.setExportProgress(false);
                    if (e && e.name === "AbortError") return;
                    st.hintSticky = "Не удалось открыть выбор папки.";
                    st.renderHint?.();
                    return;
                }
                const found = await st.collectImportHtml(dirHandle);
                if (!found.htmls.length) {
                    st.setExportProgress(false);
                    st.hintSticky = "Импорт: prompt_library.html не нашёлся (нужна папка с экспортом «Галереей»).";
                    st.renderHint?.();
                    return;
                }
                const items = [];
                for (const h of found.htmls) {
                    let text = "";
                    try {
                        const f = await h.file.getFile();
                        text = f.text ? await f.text() : await new Promise((res, rej) => {
                            const fr = new FileReader();
                            fr.onload = () => res(String(fr.result || ""));
                            fr.onerror = rej;
                            fr.readAsText(f);
                        });
                    } catch (e) { continue; }
                    const cards = st.parseGalleryHtml(text);
                    // Путь изображений в карточках относится к папке html-файла —
                    // пересчитываем в путь от корня обхода.
                    const htmlDir = h.rel.split("/").slice(0, -1).join("/");
                    cards.forEach((c, idx) => {
                        if (!(c && c.title && String(c.prompt || "").trim())) return;
                        let key = htmlDir ? htmlDir + "/" + c.relImg : c.relImg;
                        if (!found.images.has(key) && c.relImg) key = c.relImg;
                        items.push({ title: c.title, prompt: c.prompt, folder: c.folder,
                            created_at: c.created_at, favorite: c.favorite,
                            media: c.media || null, src: h.rel + "#" + (idx + 1),
                            _cover: found.images.get(key) || null });
                    });
                }
                if (!items.length) {
                    st.setExportProgress(false);
                    st.hintSticky = "Импорт: карточек с текстом в галерее не нашлось.";
                    st.renderHint?.();
                    return;
                }
                await st.importRun(items, tree);
            };
            // --- v1.57: импорт текстового файла -------------------------------
            // Разбиение по режимам: абзац (blank-line), строка (каждая непустая),
            // весь файл одной записью (title из «# …» либо имя файла без расширения).
            st.textEntries = (base, text, mode) => {
                const raw = String(text || "");
                const out = [];
                if (mode === "line") {
                    for (const ln of raw.split("\n")) {
                        const t = ln.trim();
                        if (t) out.push({ title: String(base || ""), prompt: t });
                    }
                    return out;
                }
                if (mode === "whole") {
                    const t = raw.trim();
                    if (!t) return out;
                    const hm = /^#\s+(.+)$/m.exec(raw);
                    const title = hm ? hm[1].trim()
                        : String(base || "").replace(/\.(txt|md)$/i, "") || "Запись";
                    out.push({ title, prompt: t });
                    return out;
                }
                // "para" — по умолчанию
                for (const block of raw.split(/\n\s*\n/)) {
                    const t = block.trim();
                    if (!t) continue;
                    const lines = t.split("\n");
                    out.push({ title: lines[0].trim(), prompt: t });
                }
                return out;
            };
            // Диалог «как разбить текст» — 3 режима для всех выбранных файлов.
            st.textSplitDialog = (readFiles) => {
                const modes = [
                    ["Абзацы (каждый абзац — запись)", "para"],
                    ["Строки (каждая строка — запись)", "line"],
                    ["Весь файл одной записью", "whole"],
                ];
                st.uiPanel({
                    title: "📝 Текстовый файл → библиотека",
                    subtitle: `Файлов: ${readFiles.length}. Как разбить на записи?`,
                    items: modes.map(([label, mode]) => ({
                        label, onClick: () => st.importTextRun(readFiles, st.selFolder || "__all", mode),
                    })),
                });
            };
            // Текстовые файлы: записи без категорий и обложек; src — имя+
            // «#режим», чтобы дубликаты считались корректно при повторном импорте.
            st.importTextRun = (readFiles, target, mode) => {
                const items = [];
                for (const f of readFiles || []) {
                    for (const e of st.textEntries(f.base, f.text, mode)) {
                        items.push({ title: e.title, prompt: e.prompt, folder: "", created_at: "",
                            favorite: false, media: null, src: String(f.base) + "#" + String(mode), _cover: null });
                    }
                }
                if (!items.length) {
                    st.hintSticky = "Импорт: в тексте не нашлось ни одной записи.";
                    st.renderHint?.();
                    return;
                }
                return st.importRun(items, false);
            };
            st.exportFolder = async (pathKey) => {
                st.setExportProgress(true, 0, 1);
                if (typeof window.showDirectoryPicker !== "function") {
                    st.setExportProgress(false);
                    st.hintSticky = "Ваш браузер не поддерживает выбор папки — нужен Chrome или Edge.";
                    st.renderHint?.();
                    return;
                }
                // Выборка записей: сама папка + все вложенные («Фото» → и записи
                // «Фото/Портреты», и «Фото/Портреты/Альбом»). Служебные ветки —
                // их особая выборка.
                let sel;
                if (pathKey === "__all") sel = st.entries;
                else if (pathKey === "__fav") sel = st.entries.filter((e) => e.favorite);
                else if (pathKey === "__root") sel = st.entries.filter((e) => !e.folder);
                else sel = st.entries.filter((e) => e.folder === pathKey || e.folder.startsWith(pathKey + "/"));
                if (!sel.length) {
                    st.setExportProgress(false);
                    st.hintSticky = `В «${pathKey === "__all" ? "Всё" : pathKey === "__fav" ? "Избранное" : pathKey === "__root" ? "Без категории" : pathKey}» нечего экспортировать.`;
                    st.renderHint?.();
                    return;
                }
                let dirHandle = null;
                try {
                    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
                } catch (e) {
                    st.setExportProgress(false);
                    if (e && e.name === "AbortError") return; // закрыл диалог — тихо
                    st.hintSticky = "Не удалось открыть выбор папки.";
                    st.renderHint?.();
                    return;
                }
                // Зеркало иерархии: для реальной папки создаём в выбранной
                // директории папку по её имени; внутри — файлы и подпапки.
                let root = dirHandle;
                if (!pathKey.startsWith("__")) {
                    const leaf = pathKey.split("/").pop();
                    try {
                        root = await dirHandle.getDirectoryHandle(st.sanitizeFileName(leaf), { create: true });
                    } catch (e) { /* не создалась — пишем в выбранную директорию */ }
                }
                const fulls = await st.loadFulls(sel.map((e) => e.id));
                let done = 0, failed = 0;
                const badNames = [];
                // Занятые имена — на каждую папку назначения свою (ключ — её путь
                // внутри корня экспорта): иначе одинаковые названия затирают друг друга.
                const usedByDir = new Map();
                const namesFor = (key) => {
                    if (!usedByDir.has(key)) usedByDir.set(key, new Set());
                    return usedByDir.get(key);
                };
                try {
                    for (const e of sel) {
                        const full = fulls.get(e.id);
                        if (!full) { // из /list нет полного текста — битую запись не пишем
                            failed++;
                            if (badNames.length < 5) badNames.push(e.title || e.id);
                            st.hintSticky = `Экспортирую «${pathKey}»: ${done + failed} из ${sel.length}…`;
                            st.setExportProgress(true, done + failed, sel.length);
                            st.renderHint?.();
                            continue;
                        }
                        try {
                            const sub = st.relFolder(e.folder, pathKey.startsWith("__") ? null : pathKey);
                            const writeDir = sub ? await st.ensureDirPath(root, sub) : root;
                            await st.writeEntryFlat(writeDir, full, namesFor(sub || "."));
                            done++;
                        } catch (err) {
                            failed++;
                            if (badNames.length < 5) badNames.push(e.title || e.id);
                        }
                        st.hintSticky = `Экспортирую «${pathKey}»: ${done + failed} из ${sel.length}…`;
                        st.setExportProgress(true, done + failed, sel.length);
                        st.renderHint?.();
                    }
                } finally {
                    st.setExportProgress(false);
                    st.hintSticky = failed
                        ? `Готово: ${done} из ${sel.length}${badNames.length ? `, не удались: ${badNames.join(", ")}` : ""}.`
                        : `Экспортировано: ${done} записей.`;
                    st.renderHint?.();
                }
            };
            // Экспорт отмеченного (bulk-бар): записи ст.entries, помеченные
            // по Ctrl/Shift, плюс содержимое помеченных папок (тоже с подпапками).
            st.exportMarked = async () => {
                const ids = [...st.markEntries];
                const paths = [...st.markFolders];
                if (!ids.length && !paths.length) return;
                st.setExportProgress(true, 0, 1);
                if (typeof window.showDirectoryPicker !== "function") {
                    st.setExportProgress(false);
                    st.hintSticky = "Ваш браузер не поддерживает выбор папки — нужен Chrome или Edge.";
                    st.renderHint?.();
                    return;
                }
                const pick = (e) => ids.includes(e.id)
                    || paths.some((p) => e.folder === p || e.folder.startsWith(p + "/"));
                const sel = st.entries.filter(pick);
                if (!sel.length) {
                    st.setExportProgress(false);
                    st.hintSticky = "Помеченного нечего экспортировать.";
                    st.renderHint?.();
                    return;
                }
                let dirHandle = null;
                try {
                    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
                } catch (e) {
                    st.setExportProgress(false);
                    if (e && e.name === "AbortError") return; // закрыл диалог — тихо
                    st.hintSticky = "Не удалось открыть выбор папки.";
                    st.renderHint?.();
                    return;
                }
                const fulls = await st.loadFulls(sel.map((e) => e.id));
                let done = 0, failed = 0;
                const badNames = [];
                // См. exportFolder: имена уникальны в пределах папки экспорта.
                const usedByDir = new Map();
                const namesFor = (key) => {
                    if (!usedByDir.has(key)) usedByDir.set(key, new Set());
                    return usedByDir.get(key);
                };
                try {
                    for (const e of sel) {
                        const full = fulls.get(e.id);
                        if (!full) {
                            failed++;
                            if (badNames.length < 5) badNames.push(e.title || e.id);
                            st.hintSticky = `Экспортирую отмеченное: ${done + failed} из ${sel.length}…`;
                            st.setExportProgress(true, done + failed, sel.length);
                            st.renderHint?.();
                            continue;
                        }
                        try {
                            const writeDir = e.folder ? await st.ensureDirPath(dirHandle, e.folder) : dirHandle;
                            await st.writeEntryFlat(writeDir, full, namesFor(e.folder || "."));
                            done++;
                        } catch (err) {
                            failed++;
                            if (badNames.length < 5) badNames.push(e.title || e.id);
                        }
                        st.hintSticky = `Экспортирую отмеченное: ${done + failed} из ${sel.length}…`;
                        st.setExportProgress(true, done + failed, sel.length);
                        st.renderHint?.();
                    }
                } finally {
                    st.setExportProgress(false);
                    st.hintSticky = failed
                        ? `Готово: ${done} из ${sel.length}${badNames.length ? `, не удались: ${badNames.join(", ")}` : ""}.`
                        : `Экспортировано: ${done} записей.`;
                    st.renderHint?.();
                }
            };

            // --- HTML-галерея (v1.46, §41) ------------------------------------------
            // Экспорт «Галереей»: html-карточки с превью и параметрами генерации.
            // .md-экспорт (§38/§39) НЕ заменяется — галерея идёт файлом
            // prompt_library.html рядом с превью-картинками (относительные ссылки,
            // как в Fooocus, а не base64 — тяжёлые вставки раздули бы файл).
            // Параметры генерации — из /meta (чанк workflow в превью, §41).
            st.escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
                "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
            }[c]));
            // Относительный путь превью для src/href: сегменты кодируются — в
            // папках/именах бывает кириллица и пробелы.
            st._htmlHref = (relPath) => String(relPath || "").split("/").filter(Boolean)
                .map(encodeURIComponent).join("/");
            // Параметры генерации → строки таблицы (порядок и отбор — намеренный).
            st.metaRows = (meta = {}) => {
                const rows = [];
                // Селектор переключателя не разрешён (v1.49): нода не врёт, что
                // знает активную ветку — модели/LoRA перечислены все.
                if (meta.ambiguous) {
                    rows.push(["Переключатель", "активную ветку определить не удалось — показаны все ветки"]);
                }
                if (meta.model) rows.push(["Модель", meta.model]);
                if (meta.vae) rows.push(["VAE", meta.vae]);
                if (Array.isArray(meta.loras) && meta.loras.length) {
                    rows.push(["LoRA", meta.loras.map((l) => `${l.name}${l.strength != null ? ` (${l.strength})` : ""}`).join(", ")]);
                }
                const semp = [meta.sampler, meta.scheduler].filter(Boolean).join(" / ");
                if (semp) rows.push(["Семплер", semp]);
                if (meta.steps != null) rows.push(["Шаги", meta.steps]);
                if (meta.cfg != null) rows.push(["CFG", meta.cfg]);
                if (meta.denoise != null) rows.push(["Denoise", meta.denoise]);
                if (meta.seed != null) rows.push(["Сид", meta.seed]);
                if (meta.width && meta.height) rows.push(["Разрешение", `${meta.width}×${meta.height}`]);
                return rows;
            };
            st._kvTableHtml = (rows) => rows && rows.length
                ? `<table class="pl-kv">${rows.map(([k, v]) => `<tr><td class="k">${st.escHtml(k)}</td><td>${st.escHtml(v)}</td></tr>`).join("")}</table>`
                : "";
            // Одна html-карточка: превью (относительная ссылка, при ошибке загрузки —
            // блок скрывается onerror'ом) + инфо + промпт в <details> + параметры +
            // кнопка копирования (промпт в data-атрибуте encodeURIComponent — кавычки
            // и переводы строк не ломают разметку).
            st.entryToHtml = (full, meta, relImg) => {
                const title = st.escHtml(full.title || "Без названия");
                const href = st._htmlHref(relImg);
                const img = relImg
                    ? `<div class="pl-thumb"><a href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${title}" loading="lazy" onerror="this.parentNode.style.display='none';"></a></div>`
                    : `<div class="pl-thumb"><div class="pl-noimg">без обложки</div></div>`;
                const info = st._kvTableHtml([
                    ["№", full.id || "—"],
                    ["Категория", full.folder || "Без категории"],
                    ["Создана", full.created_at || ""],
                    ["Тип", full.media === "video" ? "🎬 видео" : full.media === "image" ? "📷 фото" : ""],
                    ["В избранном", full.favorite ? "да" : "нет"],
                ]);
                const gen = st.metaRows(meta || {});
                const genHtml = gen.length ? st._kvTableHtml(gen)
                    : '<div class="pl-nodata">Параметры генерации не сохранились (запись без чанка workflow).</div>';
                const promptEnc = encodeURIComponent(full.prompt || "");
                return ['<div class="pl-card">', img, '<div class="pl-info">',
                    `<div class="pl-title">${title}</div>`, info,
                    `<details class="pl-prompt"><summary>Промпт</summary><pre>${st.escHtml(full.prompt || "")}</pre></details>`,
                    `<details class="pl-gen"><summary>Параметры генерации</summary>${genHtml}</details>`,
                    `<button class="pl-copy" data-prompt="${promptEnc}">📋 Копировать промпт</button>`,
                    "</div></div>",
                ].join("\n");
            };
            // Оболочка html-документа галереи: тёмная тема (как Fooocus), шапка со
            // счётом и датой, карточки, встроенный скрипт копирования. `date` строй.
            st.galleryShell = (count, cardsHtml, scopeLabel) => {
                const date = new Date().toISOString().slice(0, 16).replace("T", " ");
                const scope = st.escHtml(scopeLabel || "Вся библиотека");
                return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Галерея промптов — ${scope}</title>
<style>
:root{color-scheme:dark}
body{background:#121212;color:#e6e6e6;font-family:system-ui,"Segoe UI",Roboto,sans-serif;margin:0}
header{position:sticky;top:0;background:#181818;border-bottom:1px solid #2e2e2e;padding:14px 20px;z-index:5}
h1{margin:0;font-size:22px}
.pl-sub{color:#999;font-size:13px;margin-top:4px}
main{display:flex;flex-direction:column;gap:14px;padding:16px 20px;max-width:1100px;margin:0 auto}
.pl-card{display:flex;gap:14px;background:#1c1c1c;border:1px solid #2e2e2e;border-radius:8px;padding:12px}
.pl-thumb{flex:0 0 220px}
.pl-thumb img{width:220px;height:220px;object-fit:cover;border-radius:6px;background:#222;display:block}
.pl-noimg{width:220px;height:220px;display:flex;align-items:center;justify-content:center;color:#666;font-size:13px;background:#1a1a1a;border:1px dashed #3a3a3a;border-radius:6px}
.pl-info{flex:1;min-width:0}
.pl-title{font-size:16px;font-weight:bold;margin-bottom:6px}
.pl-kv{width:100%;border-collapse:collapse;font-size:13px}
.pl-kv td{padding:2px 6px 2px 0;vertical-align:top}
.pl-kv td.k{color:#999;white-space:nowrap;width:1%}
details{margin-top:8px}
summary{cursor:pointer;color:#9ad;font-size:13px}
pre{background:#141414;border:1px solid #2e2e2e;border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-word;font-size:13px}
.pl-copy{background:#2c4a73;color:#dfe8ff;border:1px solid #4a6a9a;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;margin-top:8px}
.pl-nodata{color:#888;font-size:13px;padding:6px 0}
.pl-sec{font-size:15px;margin:18px 0 8px;padding-bottom:4px;border-bottom:1px solid #2e2e2e;display:flex;align-items:center;gap:8px}
.pl-count{color:#888;font-size:12px;font-weight:normal}
</style>
</head>
<body>
<header><h1>Галерея промптов</h1><div class="pl-sub">${scope} · ${count} записей · ${date}</div></header>
<main>
${cardsHtml}
</main>
<script>
function plCopy(b){var t=decodeURIComponent(b.getAttribute("data-prompt")||"");function done(){var o=b.textContent;b.textContent="Скопировано";setTimeout(function(){b.textContent=o;},1200);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){plFallback(t,done);});}else{plFallback(t,done);}}
function plFallback(t,done){var ta=document.createElement("textarea");ta.value=t;ta.style.cssText="position:fixed;opacity:0;";document.body.appendChild(ta);ta.select();try{document.execCommand("copy");done();}catch(e){}document.body.removeChild(ta);}
document.querySelectorAll("[data-prompt]").forEach(function(b){b.addEventListener("click",function(){plCopy(b);});});
</script>
</body>
</html>`;
            };
            // Разделы по категориям: одна категория в выборке → без заголовков,
            // несколько → каждый раздел начинается со своего пути («📁 Фото/Портреты»)
            // и счётчика; вложенные — с отступом по глубине. Правило: пользователь
            // видит, где кончается одна категория и начинается другая (v1.47).
            st.gallerySections = (items) => {
                const groups = new Map();
                for (const it of items) {
                    const key = it.folder || "";
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key).push(it.html);
                }
                if (groups.size <= 1) return items.map((it) => it.html).join("\n");
                const keys = [...groups.keys()].sort((a, b) => {
                    if (!a) return -1;
                    if (!b) return 1;
                    return a.localeCompare(b, "ru");
                });
                const depthOf = (k) => (k ? k.split("/").length : 1);
                const minDepth = Math.min(...keys.map(depthOf));
                return keys.map((k) => {
                    const label = k ? `📁 ${k}` : "📁 Без категории";
                    const indent = Math.max(0, depthOf(k) - minDepth) * 14;
                    const head = `<h2 class="pl-sec" style="margin-left:${indent}px">${st.escHtml(label)}`
                        + `<span class="pl-count">${groups.get(k).length}</span></h2>`;
                    return head + "\n" + groups.get(k).join("\n");
                }).join("\n");
            };
            // Скачивание превью и запись рядом с html: имя как у .md (уникальное в
            // папке), расширение по blob.type. null — обложки нет/не скачалась.
            st.writeGalleryPreview = async (writeDir, full, used) => {
                if (!full.preview) return null;
                try {
                    const r = await fetch(`/prompt_library/preview?id=${encodeURIComponent(full.id)}`);
                    if (!r.ok) return null;
                    const blob = await r.blob();
                    const ext = String(blob.type || "").includes("jpeg") ? ".jpg" : ".png";
                    const name = `${st.uniqueName(st.sanitizeFileName(full.title), used)}${ext}`;
                    const imgFh = await writeDir.getFileHandle(name, { create: true });
                    const imgWtr = await imgFh.createWritable();
                    await imgWtr.write(blob);
                    await imgWtr.close();
                    return name;
                } catch (e) { return null; }
            };
            // Параллельное получение метаданных (/meta — как loadFulls пулом).
            st.loadMetas = async (ids, limit = 6) => {
                const out = new Map();
                let i = 0;
                const worker = async () => {
                    while (i < ids.length) {
                        const id = ids[i++];
                        try {
                            const r = await fetch(`/prompt_library/meta?id=${encodeURIComponent(id)}`);
                            if (r.ok) { const d = await r.json(); out.set(id, (d && d.meta) || {}); }
                        } catch (e) { /* нет мета — карточка без параметров */ }
                    }
                };
                await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, () => worker()));
                return out;
            };
            // Общий цикл галереи: зеркало категорий (relSub — путь внутри корня
            // экспорта), превью рядом с html, карточки в prompt_library.html в корне.
            st._galleryWrite = async (root, sel, scopeLabel, relSub, hintPrefix) => {
                const fulls = await st.loadFulls(sel.map((e) => e.id));
                const metas = await st.loadMetas(sel.map((e) => e.id));
                const usedByDir = new Map();
                const namesFor = (key) => {
                    if (!usedByDir.has(key)) usedByDir.set(key, new Set());
                    return usedByDir.get(key);
                };
                const cards = [];
                let done = 0, failed = 0;
                const badNames = [];
                try {
                    for (const e of sel) {
                        const full = fulls.get(e.id);
                        if (!full) {
                            failed++;
                            if (badNames.length < 5) badNames.push(e.title || e.id);
                            st.setExportProgress(true, done + failed, sel.length);
                            continue;
                        }
                        try {
                            const sub = relSub(e);
                            const writeDir = sub ? await st.ensureDirPath(root, sub) : root;
                            const imgName = await st.writeGalleryPreview(writeDir, full, namesFor(sub || "."));
                            const relImg = imgName ? (sub ? sub + "/" + imgName : imgName) : "";
                            cards.push({ folder: full.folder || e.folder || "",
                                html: st.entryToHtml(full, metas.get(e.id) || {}, relImg) });
                            done++;
                        } catch (err) {
                            failed++;
                            if (badNames.length < 5) badNames.push(e.title || e.id);
                        }
                        st.hintSticky = `${hintPrefix}: ${done + failed} из ${sel.length}…`;
                        st.setExportProgress(true, done + failed, sel.length);
                        st.renderHint?.();
                    }
                    const html = st.galleryShell(sel.length, st.gallerySections(cards), scopeLabel);
                    const fh = await root.getFileHandle("prompt_library.html", { create: true });
                    const wtr = await fh.createWritable();
                    await wtr.write(html);
                    await wtr.close();
                } finally {
                    st.setExportProgress(false);
                    st.hintSticky = failed
                        ? `Готово: ${done} из ${sel.length}${badNames.length ? `, не удались: ${badNames.join(", ")}` : ""}.`
                        : `${hintPrefix}: ${done} записей → prompt_library.html.`;
                    st.renderHint?.();
                }
                return { done, failed };
            };
            // Галерея по текущей категории / «Всё» / «Избранное» / «Без категории» —
            // та же умная выборка и зеркало, что у .md-экспорта (§39).
            st.exportFolderHtml = async (pathKey) => {
                st.setExportProgress(true, 0, 1);
                if (typeof window.showDirectoryPicker !== "function") {
                    st.setExportProgress(false);
                    st.hintSticky = "Ваш браузер не поддерживает выбор папки — нужен Chrome или Edge.";
                    st.renderHint?.();
                    return;
                }
                let sel;
                if (pathKey === "__all") sel = st.entries;
                else if (pathKey === "__fav") sel = st.entries.filter((e) => e.favorite);
                else if (pathKey === "__root") sel = st.entries.filter((e) => !e.folder);
                else sel = st.entries.filter((e) => e.folder === pathKey || e.folder.startsWith(pathKey + "/"));
                if (!sel.length) {
                    st.setExportProgress(false);
                    st.hintSticky = `В «${pathKey === "__all" ? "Всё" : pathKey === "__fav" ? "Избранное" : pathKey === "__root" ? "Без категории" : pathKey}» ничего для галереи.`;
                    st.renderHint?.();
                    return;
                }
                let dirHandle = null;
                try {
                    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
                } catch (e) {
                    st.setExportProgress(false);
                    if (e && e.name === "AbortError") return;
                    st.hintSticky = "Не удалось открыть выбор папки.";
                    st.renderHint?.();
                    return;
                }
                let root = dirHandle;
                if (!pathKey.startsWith("__")) {
                    const leaf = pathKey.split("/").pop();
                    try {
                        root = await dirHandle.getDirectoryHandle(st.sanitizeFileName(leaf), { create: true });
                    } catch (e) { /* не создалась — пишем в выбранную директорию */ }
                }
                const scopeLabel = pathKey === "__all" ? "Вся библиотека"
                    : pathKey === "__fav" ? "Избранное"
                        : pathKey === "__root" ? "Без категории" : pathKey;
                await st._galleryWrite(root, sel, scopeLabel,
                    (e) => (pathKey.startsWith("__") ? e.folder : st.relFolder(e.folder, pathKey)),
                    `Галерея «${scopeLabel}»`);
            };
            // Галерея отмеченного (bulk-бар): записи + содержимое помеченных папок.
            st.exportMarkedHtml = async () => {
                const ids = [...st.markEntries];
                const paths = [...st.markFolders];
                if (!ids.length && !paths.length) return;
                st.setExportProgress(true, 0, 1);
                if (typeof window.showDirectoryPicker !== "function") {
                    st.setExportProgress(false);
                    st.hintSticky = "Ваш браузер не поддерживает выбор папки — нужен Chrome или Edge.";
                    st.renderHint?.();
                    return;
                }
                const pick = (e) => ids.includes(e.id)
                    || paths.some((p) => e.folder === p || e.folder.startsWith(p + "/"));
                const sel = st.entries.filter(pick);
                if (!sel.length) {
                    st.setExportProgress(false);
                    st.hintSticky = "Помеченного нечего экспортировать.";
                    st.renderHint?.();
                    return;
                }
                let dirHandle = null;
                try {
                    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
                } catch (e) {
                    st.setExportProgress(false);
                    if (e && e.name === "AbortError") return;
                    st.hintSticky = "Не удалось открыть выбор папки.";
                    st.renderHint?.();
                    return;
                }
                await st._galleryWrite(dirHandle, sel, "Отмеченное", (e) => e.folder, "Галерея отмеченного");
            };
            // Галерея одной записи: html + превью в выбранную папку (без зеркала —
            // карточка одна, относительная ссылка плоская).
            st.exportEntryHtml = async () => {
                const full = st.full.get(st.detailId) || {};
                if (!full || !full.id) {
                    st.hintSticky = "Сначала выберите запись — галерею строить не из чего.";
                    st.renderHint?.();
                    return;
                }
                if (typeof window.showDirectoryPicker !== "function") {
                    st.hintSticky = "Ваш браузер не поддерживает выбор папки — нужен Chrome или Edge.";
                    st.renderHint?.();
                    return;
                }
                let dirHandle = null;
                try {
                    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
                } catch (e) {
                    if (e && e.name === "AbortError") return;
                    st.hintSticky = "Не удалось открыть выбор папки.";
                    st.renderHint?.();
                    return;
                }
                try {
                    const used = new Set();
                    const imgName = await st.writeGalleryPreview(dirHandle, full, used);
                    let meta = {};
                    try {
                        const r = await fetch(`/prompt_library/meta?id=${encodeURIComponent(full.id)}`);
                        if (r.ok) { const d = await r.json(); meta = (d && d.meta) || {}; }
                    } catch (e) { /* без параметров */ }
                    const html = st.galleryShell(1, st.entryToHtml(full, meta, imgName || ""), full.title || full.id);
                    const fh = await dirHandle.getFileHandle("prompt_library.html", { create: true });
                    const wtr = await fh.createWritable();
                    await wtr.write(html);
                    await wtr.close();
                    st.hintSticky = imgName
                        ? `Галерея сохранена: ${imgName} + prompt_library.html (выбранная папка).`
                        : "Галерея сохранена: prompt_library.html (без обложки).";
                } catch (err) {
                    console.warn("[PromptLibrary] html gallery error:", err);
                    st.hintSticky = "Ошибка сохранения галереи — файл мог быть занят или папка защищена.";
                }
                st.renderHint?.();
            };

            // --- Сторож цикла: IMAGE подключён + выход куда-то идёт = кольцо в графе ---
            const checkCycle = () => {
                try {
                    const imgLinked = (this.inputs?.find((i) => i.name === "image")?.link ?? null) != null;
                    const outLinked = (this.outputs?.[0]?.links?.length || 0) > 0;
                    const bad = imgLinked && outLinked;
                    let changed = false;
                    if (bad && !st.cycleWarned) {
                        st.cycleWarned = true;
                        changed = true;
                        if (st.origBg === undefined) st.origBg = this.bgcolor || null;
                        this.bgcolor = "#5a2323";
                        try {
                            app.extensionManager.toast.add({
                                severity: "warn",
                                summary: "Prompt Library: кольцо в графе!",
                                detail: "IMAGE подключён и выход идёт вверх по потоку — Queue упадёт. Отключи IMAGE-провод.",
                                life: 6000,
                            });
                        } catch (e) { /* silent */ }
                    } else if (!bad && st.cycleWarned) {
                        st.cycleWarned = false;
                        this.bgcolor = st.origBg || null;
                        changed = true;
                    }
                    // Перерисовку просим ТОЛЬКО при смене состояния: checkCycle
                    // вызывается и из onDrawForeground, а безусловный
                    // setDirtyCanvas там превращается в вечный цикл repaint
                    // (draw → dirty → draw) на видимой ноде.
                    if (changed) this.graph?.setDirtyCanvas(true, true);
                } catch (e) { /* silent */ }
            };
            st.checkCycle = checkCycle;

            // computeLayoutSize отдаёт минимальную высоту — фронтенд сам управляет
            // размером ноды и растягивает виджет (никаких offsetHeight/scrollHeight/plScale).
            // Минимальная ширина: ноду нельзя сжать уже контента.
            try {
                const prevOnResize = this.onResize ? this.onResize.bind(this) : null;
                this.onResize = (size) => {
                    try { if (prevOnResize) prevOnResize(size); } catch (e) { /* silent */ }
                    try {
                        if (this.size[0] < MIN_W) this.setSize([MIN_W, this.size[1]]);
                    } catch (e) { /* silent */ }
                    try { st.unstickWidth?.(); } catch (e) { /* silent */ }
                };
            } catch (e) { /* silent */ }

            // Автосокеты виджетов: фронтенд 1.52 создаёт сокет каждому виджету
            // (getWidgetConfig, тип `*` по умолчанию). Вход `source` у нас
            // подписанный, а вторая точка рядом путает.
            // Удаляем автосокеты технических виджетов (только неподключённые).
            st.dropAutoSockets = () => {
                try {
                    if (typeof this.removeInput !== "function" || !this.inputs) return;
                    for (const n of ["selected", "save_folder", "pickup", "slots_out"]) {
                        const idx = this.inputs.findIndex((i) => i.widget && i.widget.name === n);
                        if (idx >= 0 && this.inputs[idx].link == null) this.removeInput(idx);
                    }
                } catch (e) { /* silent */ }
                try { st.checkCycle?.(); } catch (e) { /* silent */ }
            };
            st.dropAutoSockets();
            requestAnimationFrame(() => { st.dropAutoSockets(); });

            // Безопасный переход в выдачу: предложить отключить IMAGE-провод
            // Возвращает true если переход разрешён, false если отменён
            st.ensureIssueSafe = async () => {
                try {
                    const idx = this.inputs?.findIndex((i) => i.name === "image");
                    if (idx !== undefined && idx >= 0 && this.inputs[idx].link != null) {
                        let ok = false;
                        try {
                            ok = await app.extensionManager.dialog.confirm({
                                title: "Режим выдачи",
                                message: "IMAGE-провод вместе с выходом в CLIP создаст цикл и Queue упадёт. Отключить IMAGE-провод?",
                            });
                        } catch (e) {
                            ok = confirm("IMAGE-провод вместе с выходом в CLIP создаст цикл. Отключить IMAGE-провод?");
                        }
                        if (ok) {
                            this.disconnectInput(idx);
                        } else {
                            return false;
                        }
                    }
                } catch (e) { /* silent */ }
                checkCycle();
                return true;
            };

            const modeW = this.widgets?.find((w) => w.name === "mode");
            if (modeW) {
                modeW.callback = async (val) => {
                    // Оба выдающих режима (v1.24) несут текст в CLIP — кольцо
                    // с IMAGE-проводом нужно предупредить до Queue.
                    if (val === "📤 Выдача" || val === "📤📥 Выдача + запись") {
                        const ok = await st.ensureIssueSafe();
                        if (!ok) {
                            modeW.value = "📥 Запись";
                        }
                    } else {
                        checkCycle();
                    }
                };
            }

            requestAnimationFrame(() => { st.checkCycle?.(); st.refreshPickupOptions?.(); });

            const browserWidget = this.addDOMWidget("pl_browser", "custom", root, {
                serialize: false,
                getValue: () => null,
                setValue: () => {},
            });
            // options.serialize сюда не пробрасывается (в файле лишний 4-й value
            // pl_browser:"") — ставим свойство явно, иначе позиционный маппинг
            // widgets_values хрупок при добавлении виджетов.
            try { browserWidget.serialize = false; } catch (e) { /* silent */ }
            // КОРЕНЬ зажатия контента (v1.32, §37): панель свойств рендерит
            // каждый виджет узла, а для типа `custom` (наш pl_browser) в реестре
            // компонентов нет — панель монтирует WidgetLegacy.vue, который в
            // draw() пишет `widgetInstance.width = canvasEl.parentElement.clientWidth`,
            // т.е. ШИРИНУ ПАНЕЛИ — прямо в наш живой объект виджета. Дальше
            // DomWidgets.vue каждый кадр считает ширину обёртки как
            // `(widget.width ?? node.width) - 2*margin` — чужое число побеждает
            // живую ширину ноды, обёртка застывает на ширине панели, контент
            // зажат навсегда (замерено живьём: width=235 при ноде 1000 → обёртка
            // 215; у пользователя 213 → 193). Лечил только F5 — свежий виджет
            // без чужого width.
            // Лечение — не давать панели вообще рендерить наш DOM-виджет (большой
            // DOM-UI в панели бессмыслен: там он всё равно рисуется пустым
            // canvas-зеркалом). Панель фильтрует по options.hideInPanel
            // (rightSidePanel/shared.ts), остальной фронтенд этот флаг не читает:
            // DOM-оверлей, Nodes 2.0 (WidgetDOM) и сериализация не затронуты.
            try { browserWidget.options.hideInPanel = true; } catch (e) { /* silent */ }
            // Страж (v1.31) остаётся страховкой: у уже заражённых сессий (вкладка,
            // открытая до этой правки) чужое width лежит на виджете, и панель
            // успела его записать до перезагрузки. Сносим чужое — оверлей берёт
            // живую ширину ноды. Только удаление свойства, никаких dirty/layout —
            // петель нет по построению. Мы width не задаём никогда.
            st.unstickWidth = () => {
                try {
                    const w = this.widgets?.find((x) => x && x.name === "pl_browser");
                    if (w && w.width !== undefined) delete w.width;
                } catch (e) { /* silent */ }
            };
            st.unstickWidth();
            // Высота DOM-контента: новый layout API (computeLayoutSize) вместо
            // legacy computeSize. Разница: computeSize = ТОЧНАЯ высота виджета
            // (лишний рост ноды → пустота снизу), computeLayoutSize = МИНИМУМ
            // (minHeight), а всё свободное место distributeSpace отдаёт нам —
            // нода тянется вниз вместе с контентом. Читаем только boolean-стейт
            // (display-флаги), НЕ размеры DOM — feedback loop из SPEC §21
            // здесь невозможен по построению. Никакого offsetHeight/scrollHeight.
            const DETAIL_H = 280;
            // +28 к BASE_H (v1.25): строка подхвата (22px + gap 6px) в root.
            // Пол — ТОЛЬКО здесь (computeLayoutSize), на панелях CSS-пола нет (§28).
            // +28 к BASE_H (v1.48): ряд экспорта/импорта (22px + gap 6px).
            const BASE_H = 652;
            const INPUT_H = 202; // поле названия + textarea + кнопка сохранения + ряд прикрепления превью
            // Единый минимум для обоих режимов (single source of truth).
            st.minH = () => {
                const showDetail = detail && detail.style.display !== "none";
                return BASE_H + (showDetail ? DETAIL_H : 0) + (inputVisible ? INPUT_H : 0);
            };
            st.syncNodeSize = () => {
                try {
                    const need = this.computeSize(this.size[0]);
                    this.setSize([Math.max(this.size[0], need[0]), Math.max(this.size[1], need[1])]);
                } catch (e) { /* silent */ }
            };
            try {
                // ВАЖНО: legacy computeSize НЕ задаём — иначе фронтенд возьмёт
                // точную высоту и stretch не сработает (_arrangeWidgets).
                browserWidget.computeLayoutSize = () => {
                    try {
                        // Единый минимум для обоих режимов (§22.3): только boolean-стейт
                        // (display-флаги), никаких замеров DOM → петель нет по построению.
                        // maxHeight не задаём: в _arrangeWidgets он уходит в prefHeight,
                        // а maxSize по умолчанию Infinity → distributeSpace отдаёт
                        // виджету всё свободное место ноды (растяжение в обоих режимах).
                        return { minHeight: st.minH(), minWidth: MIN_W };
                    } catch (e) { return { minHeight: BASE_H, minWidth: MIN_W }; }
                };
            } catch (e) { /* silent */ }
            // NB (Vue): программного ресайза ноды нет — setSize в Vue-режиме не
            // исполняется (доказано живьём: min-clamp и схлопывания не держатся),
            // размером владеют layout + пользователь. Поэтому здесь только
            // grow-only syncNodeSize (безвреден, если игнорируется) и никаких
            // схлопываний: борьба с layout выглядит как колхоз (дёргание).

            reload();
            // v1.44 (§40): мета выходов снимается СРАЗУ (пока видны все 12 из
            // node def) — с неё восстанавливаем имена/локали, когда привязку
            // создают позже. А сами сокеты правим в rAF: если нода создаётся
            // загрузкой графа, сейчас же придёт configure(), и урезать outputs
            // ДО него нельзя — фронтенд сопоставляет выходы графа с текущими по
            // индексам (`zip(this.outputs, data.outputs)`), лишняя урезка
            // потеряла бы сокеты из сохранённого воркфлоу и порвала провода.
            // rAF идёт ДО отрисовки кадра, так что вспышки «12 сокетов» не видно.
            st.captureOutBase();
            requestAnimationFrame(() => {
                st.hookCanvasDrop?.(); st.enforceMinWidth?.(); st.applyNodeMinWidth?.();
                try { st.applyOutSockets(); } catch (e) { /* silent */ }
                this.graph?.setDirtyCanvas(true, true);
            });
            return ret;
        };

        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const ret = origOnConnectionsChange?.apply(this, arguments);
            try { this._pl?.dropAutoSockets?.(); } catch (e) { /* silent */ }
            try { this._pl?.checkCycle?.(); } catch (e) { /* silent */ }
            return ret;
        };

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const ret = origOnExecuted?.apply(this, arguments);
            try {
                if (message?.entries && this._pl) {
                    this._pl.reload?.();
                }
                // Дубликат после Queue: такой текст уже есть — предупреждаем где лежит.
                // Пустой объект {} (нет дубля) — truthy, поэтому проверяем id.
                // Подсказка о неочевидном выходе (совместимость: «Запись» с проводом)
                const notice = message?.mode_notice && message.mode_notice[0];
                if (notice && this._pl) {
                    this._pl.hintSticky = String(notice);
                    this._pl.renderHint?.();
                }
                const sd = message?.skipped_duplicate;
                if (sd && sd.id && this._pl) {
                    const st = this._pl;
                    const where = sd.folder || "корне";
                    // Стойкое сообщение: hintMsg показывается только при открытой
                    // панели книги, поэтому пишем в отдельное поле — иначе
                    // предупреждение о дубле после Queue вообще не видно.
                    st.hintSticky = `Дубликат не сохранён — такой промпт уже есть в «${where}».`;
                    try {
                        st.toast("warn", "Prompt Library: дубликат",
                            `Такой промпт уже есть в «${where}» — новая запись не создана.`);
                    } catch (e) { /* silent */ }
                    st.renderHint?.();
                }
            } catch (e) { /* silent */ }
            return ret;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const ret = origOnConfigure?.apply(this, arguments);
            // Синхронный restore папки из данных воркфлоу: info несёт
            // widgets_values_named + widgets_values как в файле, ждать
            // hydration виджетов не нужно. Первый рендер после fetch —
            // уже правильная папка, кадра «Всё» нет.
            try {
                const st = this._pl;
                if (st && info) {
                    let v = null;
                    const named = info.widgets_values_named;
                    if (named && typeof named.save_folder === "string") v = named.save_folder;
                    if (v == null && Array.isArray(info.widgets_values)) {
                        // Позиционный фолбэк: порядок INPUT_TYPES required =
                        // [mode, selected, save_folder] (SPEC §10). Совпадает
                        // и со старыми 4-элементными массивами (prompt был 4-м).
                        const pv = info.widgets_values[2];
                        if (typeof pv === "string") v = pv;
                    }
                    if (v) st.selFolder = v;
                }
            } catch (e) { /* silent */ }
            // v1.44 (§40): восстановить привязки слотов из данных воркфлоу и
            // показать занятые сокеты. Читаем столько форм, сколько есть —
            // старые графы без slots_out просто дадут пустой список.
            try {
                const st = this._pl;
                if (st && info) {
                    let sv = null;
                    const named = info.widgets_values_named;
                    if (named && typeof named.slots_out === "string") sv = named.slots_out;
                    if (sv == null && Array.isArray(info.widgets_values) && typeof info.widgets_values[4] === "string") sv = info.widgets_values[4];
                    // Всегда перезаписываем: старые привязки прошлого графа не
                    // должны остаться, если в новом их нет (перезагрузка графа в
                    // уже созданную ноду).
                    let parsedSlots = [];
                    if (sv) {
                        try {
                            const arr = JSON.parse(sv);
                            if (Array.isArray(arr)) parsedSlots = arr;
                        } catch (err) { /* silent */ }
                    }
                    st.slotsOut = parsedSlots;
                    const sw = st.outSlotsWidget?.();
                    if (sw && sw.value !== sv) sw.value = sv || "";
                }
            } catch (e) { /* silent */ }
            requestAnimationFrame(() => {
                try { this._pl?.applyPaneLayout?.(); } catch (e) { /* silent */ }
                try { this._pl?.applyNodeMinWidth?.(); } catch (e) { /* silent */ }
                try { this._pl?.dropAutoSockets?.(); } catch (e) { /* silent */ }
                try { this._pl?.applyOutSockets?.(); } catch (e) { /* silent */ }
                try { this._pl?.checkCycle?.(); } catch (e) { /* silent */ }
                // Список узлов-источников подхвата собирается из живого графа:
                // после загрузки воркфлоу он другой (SPEC §30).
                try { this._pl?.refreshPickupOptions?.(); } catch (e) { /* silent */ }
                try {
                    // Одноразовая сверка после загрузки базы (без таймеров):
                    // виджет (если гидрация донесла) — свежий источник;
                    // иначе держим sync-значение; мусор → корень.
                    // Клики всегда синхронизируют виджет и selFolder, поэтому
                    // эта сверка никогда не спорит с пользователем.
                    this._pl?.reload?.().then(() => {
                        try {
                            const st = this._pl;
                            if (!st) return;
                            const sf = this.widgets?.find((w) => w.name === "save_folder");
                            const wv = ((sf && sf.value) || "").trim();
                            // Валидны: служебные ветки + реальные папки из базы.
                            // Виджет теперь тоже несёт __fav/__root (см. syncSaveFolder).
                            const valid = (f) => !!f && (f === "__all" || f === "__fav" || f === "__root" || f === "__outs" || st.folders.includes(f));
                            let want = null;
                            if (valid(wv)) want = wv;
                            else if (st.selFolder !== "__all" && !valid(st.selFolder)) want = "__all";
                            if (want !== null && want !== st.selFolder) {
                                st.selFolder = want;
                                st.syncSaveFolder?.();
                                st.renderTree?.();
                                st.render?.();
                            }
                        } catch (e) { /* silent */ }
                    }).catch(() => {});
                } catch (e) { /* silent */ }
            });
            return ret;
        };

        const origOnDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            try { this._pl?.checkCycle?.(); } catch (e) { /* silent */ }
            try { this._pl?.unstickWidth?.(); } catch (e) { /* silent */ }
            return origOnDrawForeground?.apply(this, arguments);
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const st = this._pl;
            try { st?.full?.clear?.(); } catch (e) { /* silent */ }
            try { plLiveStates.delete(st); } catch (e) { /* silent */ }
            try { plModeWatchers.delete(st?.onModeChange); } catch (e) { /* silent */ }
            // Снимаем слушатели с ДОЛГОЖИВУЩИХ объектов (app.api / настройки).
            // Без этого удалённая нода не собирается GC и продолжает отвечать
            // reload() на каждый broadcast — запрос /prompt_library/list на каждую
            // выгрузку воркфлоу за сессию.
            try {
                if (st?.apiListener && st.apiTarget?.removeEventListener) {
                    st.apiTarget.removeEventListener("prompt_library/refresh", st.apiListener);
                }
                for (const [name, fn] of (st?.execListeners || [])) {
                    st.apiTarget?.removeEventListener?.(name, fn);
                }
                if (st?._searchTimer) { clearTimeout(st._searchTimer); st._searchTimer = null; }
                st.pendingPreview?.clear?.();
                st.pendingPickup?.clear?.();
                st.runPickupBlocked?.clear?.();
                st.runTexts?.clear?.();
                st.runImages?.clear?.();
                st.previewStamp?.clear?.();
                st.deepIds = null;
            } catch (e) { /* silent */ }
            try {
                if (st?.settingsListener && st.settingsTarget?.removeEventListener) {
                    st.settingsTarget.removeEventListener("Comfy.VueNodes.Enabled.change", st.settingsListener);
                }
            } catch (e) { /* silent */ }
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
