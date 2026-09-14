const { app } = window.comfyAPI.app;

// Лёгкая проекция серверной записи для списка
function plMap(e) {
    return {
        id: e.id,
        title: e.title || "",
        head: (e.prompt || "").slice(0, 120),
        folder: e.folder || "",
        favorite: !!e.favorite,
        created_at: e.created_at || "",
        last_used: e.last_used || null,
        has_preview: !!e.preview,
    };
}

app.registerExtension({
    name: "PromptLibrary",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PromptLibrary") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = origOnNodeCreated?.apply(this, arguments);

            // Скрыть технические selected/save_folder (ими управляет дерево и список)
            const selWidget = this.widgets?.find((w) => w.name === "selected");
            if (selWidget) {
                selWidget.hidden = true;
                selWidget.computeSize = () => [0, -4];
            }
            const saveFolderW = this.widgets?.find((w) => w.name === "save_folder");
            if (saveFolderW) {
                saveFolderW.hidden = true;
                saveFolderW.computeSize = () => [0, -4];
            }


            // --- DOM: библиотека ---
            const root = document.createElement("div");
            root.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:400px;";
            // Ноду нельзя сжать уже контента, иначе дерево вылезает за границу.
            // (Само присвоение — ниже, после this._pl = st, иначе TDZ-ошибка.)
            const MIN_W = 470;

            // Тулбар: поиск + сортировка (как картотека)
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
                <option value="used">Недавно выданные</option>`;
            // Режимы вида как в проводнике Windows
            const viewSel = document.createElement("select");
            viewSel.title = "Вид списка";
            viewSel.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px;max-width:130px;";
            viewSel.innerHTML = `
                <option value="large">🖼 Крупные</option>
                <option value="medium">🎞 Средние</option>
                <option value="list">📋 Список</option>`;
            try {
                const savedView = localStorage.getItem("promptLibrary.view");
                if (savedView) viewSel.value = savedView;
            } catch (e) { /* silent */ }
            if (!["large", "medium", "list"].includes(viewSel.value)) viewSel.value = "large";
            toolbar.appendChild(search);
            toolbar.appendChild(sortSel);
            toolbar.appendChild(viewSel);

            // Кнопка сохранения — внутри нашего DOM (не нативная): пара
            // «DOM-окно + нативная кнопка» даёт щель при ресайзе (апстрим issue #7942).
            const saveDomBtn = document.createElement("button");
            saveDomBtn.textContent = "💾 Сохранить промпт в открытую категорию";
            saveDomBtn.title = "Сохранить без запуска Queue";
            saveDomBtn.style.cssText = "width:100%;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:5px;cursor:pointer;font-size:12px;";

            // Ряд: дерево папок | список книг
            const main = document.createElement("div");
            main.style.cssText = "display:flex;gap:6px;min-height:0;";

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
            newFolderBtn.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;";
            treeHead.appendChild(treeTitle);
            treeHead.appendChild(newFolderBtn);
            const tree = document.createElement("div");
            tree.style.cssText = "display:flex;flex-direction:column;gap:2px;height:320px;overflow-y:auto;border:1px solid #333;border-radius:4px;padding:4px;background:#191919;";
            treeBox.appendChild(treeHead);
            treeBox.appendChild(tree);

            const list = document.createElement("div");
            list.style.cssText = "min-width:0;display:flex;flex-direction:column;gap:4px;height:320px;overflow-y:auto;";

            // Слева список книг, справа проводник категорий
            main.appendChild(list);
            main.appendChild(treeBox);

            const hint = document.createElement("div");
            hint.style.cssText = "color:#888;font-size:11px;";
            hint.textContent = "Запустите Queue или нажмите «Сохранить промпт» — записи появятся здесь.";

            // --- Панель книги: название, полка, полный текст ---
            const detail = document.createElement("div");
            detail.style.cssText = "display:none;flex-direction:column;gap:4px;border:1px solid #4a9eff;border-radius:4px;padding:6px;background:#16202f;";

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
            dText.rows = 5;
            dText.style.cssText = "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:4px;font-size:11px;resize:vertical;";
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
            dBtns.appendChild(bCopy);
            dBtns.appendChild(bEdit);
            dBtns.appendChild(bSave);

            detail.appendChild(dTitle);
            detail.appendChild(dFolder);
            detail.appendChild(dText);
            detail.appendChild(dMeta);
            detail.appendChild(dBtns);

            root.appendChild(saveDomBtn);
            root.appendChild(toolbar);
            root.appendChild(main);
            root.appendChild(detail);
            root.appendChild(hint);

            const st = {
                root, search, sortSel, viewSel, tree, list, hint, detail,
                dTitle, dFolder, dText, dMeta, bSave,
                entries: [], folders: [], full: new Map(),
                detailId: null, selFolder: "__all",
            };
            this._pl = st;

            st.enforceMinWidth = () => {
                try {
                    if (this.size[0] < MIN_W) this.setSize([MIN_W, this.size[1]]);
                } catch (e) { /* silent */ }
            };

            // Папка сохранения = выбранная в дереве; персистится через скрытый save_folder
            st.syncSaveFolder = () => {
                try {
                    const v = (st.selFolder && !st.selFolder.startsWith("__")) ? st.selFolder : "";
                    if (saveFolderW && saveFolderW.value !== v) saveFolderW.value = v;
                } catch (e) { /* silent */ }
            };

            const reload = async () => {
                try {
                    const r = await fetch("/prompt_library/list");
                    if (!r.ok) return;
                    const data = await r.json();
                    st.entries = (data.entries || []).map(plMap);
                    st.folders = data.folders || [];
                    renderTree();
                    render();
                    // fitNode удалён: computeSize отдаёт высоту, фронтенд сам управляет размером.
                } catch (e) { /* silent */ }
            };
            st.reload = reload;

            // --- Drag & Drop: книги → на категории, категории → в другие категории (или в корень) ---
            st.plDrop = async (d, target) => {
                if (!d) return;
                try {
                    if (d.kind === "entry") {
                        const dest = target && !target.startsWith("__") ? target : (target === "__root" ? "" : null);
                        if (dest === null) return;
                        const e = st.entries.find((x) => x.id === d.id);
                        if (!e || e.folder === dest) return;
                        await fetch("/prompt_library/update", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: d.id, folder: dest }),
                        });
                        st.full.delete(d.id);
                        await reload();
                    } else if (d.kind === "folder") {
                        const src = d.path;
                        const dest = (!target || target === "__all" || target === "__root")
                            ? src.split("/").pop()
                            : target + "/" + src.split("/").pop();
                        if (dest === src || dest.startsWith(src + "/")) return;
                        const r = await fetch("/prompt_library/folder_rename", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ old: src, new: dest }),
                        });
                        if (r.ok) {
                            if (st.selFolder === src || st.selFolder.startsWith(src + "/")) {
                                st.selFolder = dest + st.selFolder.slice(src.length);
                            }
                            st.syncSaveFolder();
                            await reload();
                        }
                    }
                } catch (e) { /* silent */ }
            };

            // Фон списка — тоже дроп-зона: книга переезжает в открытую полку
            list.ondragover = (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; };
            list.ondrop = async (ev) => {
                ev.preventDefault();
                let d = null;
                try { d = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch (e) { /* silent */ }
                if (d && d.kind === "entry" && st.selFolder && !st.selFolder.startsWith("__")) {
                    await st.plDrop(d, st.selFolder);
                }
            };

            // --- Дерево полок ---
            const folderRow = (key, label, depth, isFolder) => {
                const row = document.createElement("div");
                const active = st.selFolder === key;
                row.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:4px;cursor:pointer;font-size:11px;color:${active ? "#fff" : "#ccc"};background:${active ? "#2c4a73" : "transparent"};padding-left:${4 + depth * 14}px;`;
                const name = document.createElement("span");
                name.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                name.textContent = label;
                name.title = isFolder ? key : label;
                row.appendChild(name);
                // Папки можно таскать; любая строка — дроп-зона
                row.draggable = isFolder;
                if (isFolder) {
                    row.ondragstart = (ev) => {
                        ev.dataTransfer.setData("text/plain", JSON.stringify({ kind: "folder", path: key }));
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
                    const rn = document.createElement("button");
                    rn.textContent = "✏️"; rn.title = "Переименовать категорию";
                    rn.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    rn.onclick = async (ev) => {
                        ev.stopPropagation();
                        const leaf = key.split("/").pop();
                        const next = prompt("Новое название категории:", leaf);
                        if (!next || !next.trim() || next.trim() === leaf) return;
                        const parent = key.split("/").slice(0, -1).join("/");
                        const newPath = parent ? `${parent}/${next.trim()}` : next.trim();
                        try {
                            const r = await fetch("/prompt_library/folder_rename", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ old: key, new: newPath }),
                            });
                            if (r.ok) {
                                if (st.selFolder === key) st.selFolder = newPath;
                                st.syncSaveFolder();
                                await reload();
                            } else alert("Не удалось переименовать.");
                        } catch (e) { alert("Не удалось переименовать."); }
                    };
                    const del = document.createElement("button");
                    del.textContent = "🗑"; del.title = "Удалить категорию (записи переедут в корень)";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:11px;padding:0 2px;";
                    del.onclick = async (ev) => {
                        ev.stopPropagation();
                        if (!confirm(`Удалить категорию «${key}» с подкатегориями? Записи не пропадут — переедут в корень.`)) return;
                        try {
                            const r = await fetch("/prompt_library/folder_delete", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ path: key }),
                            });
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
                row.onclick = () => { st.selFolder = key; st.syncSaveFolder(); renderTree(); render(); };
                return row;
            };

            const renderTree = () => {
                st.tree.innerHTML = "";
                st.tree.appendChild(folderRow("__all", "📚 Всё", 0, false));
                st.tree.appendChild(folderRow("__fav", "★ Избранное", 0, false));
                st.tree.appendChild(folderRow("__root", "📥 Без категории", 0, false));
                const all = [...new Set([...st.folders, ...st.entries.map((e) => e.folder).filter(Boolean)])].sort();
                const kids = new Map(); // parent -> [childPath]
                for (const f of all) {
                    const parent = f.split("/").slice(0, -1).join("/");
                    if (!kids.has(parent)) kids.set(parent, []);
                    kids.get(parent).push(f);
                }
                const walk = (parent, depth) => {
                    for (const f of (kids.get(parent) || [])) {
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
                try {
                    const r = await fetch("/prompt_library/folder_create", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ parent, name: name.trim() }),
                    });
                    if (r.ok) {
                        const data = await r.json();
                        st.selFolder = data.path;
                        st.syncSaveFolder();
                        await reload();
                    }
                } catch (e) { /* silent */ }
            };

            // --- Список книг ---
            const sortedFiltered = () => {
                const q = (st.search.value || "").toLowerCase();
                let arr = st.entries.filter((e) => {
                    if (st.selFolder === "__fav" && !e.favorite) return false;
                    else if (st.selFolder === "__root" && e.folder) return false;
                    else if (st.selFolder && !st.selFolder.startsWith("__") && e.folder !== st.selFolder) return false;
                    if (q && !((e.title || "") + "\n" + (e.head || "") + "\n" + (e.folder || "")).toLowerCase().includes(q)) return false;
                    return true;
                });
                const by = st.sortSel.value;
                const ts = (s) => s || "";
                if (by === "title") arr = [...arr].sort((a, b) => (a.title || a.head).localeCompare(b.title || b.head, "ru"));
                else if (by === "old") arr = [...arr].sort((a, b) => ts(a.created_at) < ts(b.created_at) ? -1 : 1);
                else if (by === "used") arr = [...arr].sort((a, b) => ts(b.last_used || "") < ts(a.last_used || "") ? -1 : 1);
                else arr = [...arr].sort((a, b) => ts(b.created_at) < ts(a.created_at) ? -1 : 1);
                return arr;
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
                for (const e of sortedFiltered()) {
                    const card = document.createElement("div");
                    card.draggable = true;
                    card.ondragstart = (ev) => {
                        ev.dataTransfer.setData("text/plain", JSON.stringify({ kind: "entry", id: e.id }));
                        ev.dataTransfer.effectAllowed = "move";
                    };
                    card.style.cssText = grid
                        ? `display:flex;flex-direction:column;gap:4px;width:${imgSize + 12}px;padding:4px;border-radius:4px;cursor:pointer;border:1px solid ${e.id === selVal ? "#4a9eff" : "#333"};background:${e.id === selVal ? "#1e2c44" : "#1e1e1e"};flex-shrink:0;`
                        : `display:flex;gap:6px;align-items:center;padding:4px;border-radius:4px;cursor:pointer;border:1px solid ${e.id === selVal ? "#4a9eff" : "#333"};background:${e.id === selVal ? "#1e2c44" : "#1e1e1e"};`;

                    const img = document.createElement("img");
                    img.style.cssText = `width:${imgSize}px;height:${imgSize}px;object-fit:cover;border-radius:3px;background:#222;flex-shrink:0;`;
                    if (e.has_preview) img.src = `/prompt_library/preview?id=${encodeURIComponent(e.id)}&t=${Date.now()}`;
                    else img.style.display = "none";

                    const body = document.createElement("div");
                    body.style.cssText = grid ? "min-width:0;text-align:center;" : "flex:1;min-width:0;";
                    const title = document.createElement("div");
                    title.style.cssText = "color:#fff;font-size:12px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                    title.textContent = e.title || e.head || "(без названия)";
                    title.title = e.title || e.head || "";
                    body.appendChild(title);
                    if (!grid) {
                        const t = document.createElement("div");
                        t.style.cssText = "color:#bbb;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                        t.textContent = e.head || "";
                        body.appendChild(t);
                    }
                    const meta = document.createElement("div");
                    meta.style.cssText = "color:#888;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                    meta.textContent = grid
                        ? (e.folder || "Без категории")
                        : `${e.folder || "Без категории"} · ${e.created_at || ""}${e.last_used ? " · выдана " + e.last_used : ""}`;
                    body.appendChild(meta);

                    const fav = document.createElement("button");
                    fav.textContent = e.favorite ? "★" : "☆";
                    fav.title = "В избранное";
                    fav.style.cssText = "background:none;border:none;color:#e8c33a;cursor:pointer;font-size:14px;flex-shrink:0;";
                    fav.onclick = async (ev) => {
                        ev.stopPropagation();
                        try {
                            await fetch("/prompt_library/favorite", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: e.id, favorite: !e.favorite }),
                            });
                            e.favorite = !e.favorite;
                            render();
                        } catch (err) { /* silent */ }
                    };

                    const rn = document.createElement("button");
                    rn.textContent = "✏️";
                    rn.title = "Переименовать";
                    rn.style.cssText = "background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;";
                    rn.onclick = async (ev) => {
                        ev.stopPropagation();
                        const next = prompt("Новое название:", e.title || e.head || "");
                        if (!next || !next.trim() || next.trim() === (e.title || "")) return;
                        try {
                            await fetch("/prompt_library/update", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: e.id, title: next.trim() }),
                            });
                            e.title = next.trim();
                            st.full.delete(e.id);
                            render();
                        } catch (err) { /* silent */ }
                    };

                    const del = document.createElement("button");
                    del.textContent = "🗑";
                    del.title = "Удалить книгу";
                    del.style.cssText = "background:none;border:none;cursor:pointer;font-size:13px;flex-shrink:0;";
                    del.onclick = async (ev) => {
                        ev.stopPropagation();
                        if (!confirm(`Удалить «${e.title || e.head}»?`)) return;
                        try {
                            await fetch("/prompt_library/delete", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: e.id }),
                            });
                            st.entries = st.entries.filter((x) => x.id !== e.id);
                            if (st.detailId === e.id) { st.detailId = null; st.detail.style.display = "none"; }
                            renderTree(); render();
                        } catch (err) { /* silent */ }
                    };

                    card.onclick = async () => {
                        if (selWidget) selWidget.value = e.id;
                        try {
                            if (!st.full.has(e.id)) {
                                const r = await fetch(`/prompt_library/entry?id=${encodeURIComponent(e.id)}`);
                                if (r.ok) st.full.set(e.id, await r.json());
                            }
                            const full = st.full.get(e.id);
                            if (full) {
                                st.detailId = e.id;
                                st.dTitle.value = full.title || "";
                                st.dFolder.value = full.folder || "";
                                st.dText.value = full.prompt || "";
                                for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = true;
                                st.bSave.style.display = "none";
                                st.dMeta.textContent = `№ ${full.id} · создана ${full.created_at || "—"} · выдана ${full.last_used || "—"}`;
                                st.detail.style.display = "flex";
                                st.hint.textContent = "Режим «📤 Выдача» включён — текст пойдёт в CLIP при Queue.";
                            }
                        } catch (err) { /* silent */ }
                        const modeW = this.widgets?.find((w) => w.name === "mode");
                        if (modeW) modeW.value = "📤 Выдача";
                        await this._pl?.ensureIssueSafe?.();
                        render();
                        this.graph?.setDirtyCanvas(true, true);
                    };

                    // В сетке кнопки — рядком под названием, в списке — сбоку (display:contents)
                    const actions = document.createElement("div");
                    actions.style.cssText = grid ? "display:flex;gap:2px;justify-content:center;" : "display:contents;";
                    actions.appendChild(fav);
                    actions.appendChild(rn);
                    actions.appendChild(del);
                    card.appendChild(img);
                    card.appendChild(body);
                    card.appendChild(actions);
                    st.list.appendChild(card);
                    shown++;
                }
                if (!st.detailId) st.hint.textContent = shown ? `Записей в категории: ${shown}` : "Пусто. Запустите Queue или нажмите «Сохранить промпт».";
            };
            st.render = render;
            search.oninput = render;
            sortSel.onchange = render;
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
                st.dTitle.focus();
            };
            bSave.onclick = async () => {
                if (!st.detailId) return;
                try {
                    await fetch("/prompt_library/update", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: st.detailId, title: st.dTitle.value, prompt: st.dText.value, folder: st.dFolder.value }),
                    });
                    st.full.delete(st.detailId);
                    for (const el of [st.dTitle, st.dFolder, st.dText]) el.readOnly = true;
                    st.bSave.style.display = "none";
                    await reload();
                } catch (err) { /* silent */ }
            };

            // Окно промпта — единственное поле (штатный виджет, ничего не прячем).
            // Провод, брошенный на окно, подключается к нему штатно (как в CLIP Text Encode).

            // --- Сторож цикла: IMAGE подключён + выход куда-то идёт = кольцо в графе ---
            const checkCycle = () => {
                try {
                    const imgLinked = (this.inputs?.find((i) => i.name === "image")?.link ?? null) != null;
                    const outLinked = (this.outputs?.[0]?.links?.length || 0) > 0;
                    const bad = imgLinked && outLinked;
                    if (bad && !st.cycleWarned) {
                        st.cycleWarned = true;
                        if (st.origBg === undefined) st.origBg = this.bgcolor;
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
                        try { this.bgcolor = st.origBg; } catch (e) { /* silent */ }
                    }
                    this.graph?.setDirtyCanvas(true, true);
                } catch (e) { /* silent */ }
            };
            st.checkCycle = checkCycle;

            // Высота ноды: в окне при проводе только голова текста (стабильно ~5 строк),
            // полный текст — в базе и панели книги. Только публичный widget.value.
            // Списки фиксированы (320px, внутренний скролл); рамка обнимает контент
            // Никаких подгонок под ресайз, CSS и таймеров.
            st.HEAD_CHARS = 300;
            st.lastFullText = "";
            try { console.log("[PromptLibrary] build 20260915-audit"); } catch (e) {}
            // Высоту окна держим контентом (голова текста при проводе, см. onExecuted).
            // computeSize отдаёт визуальную высоту — фронтенд сам управляет размером ноды.
            // plScale удалён: computeSize отдаёт CSS-пиксели, canvas-трансформация — фронтенду.
            // Минимальная ширина: ноду нельзя сжать уже контента.
            try {
                const prevOnResize = this.onResize ? this.onResize.bind(this) : null;
                this.onResize = (size) => {
                    try { if (prevOnResize) prevOnResize(size); } catch (e) { /* silent */ }
                    try {
                        if (this.size[0] < MIN_W) this.setSize([MIN_W, this.size[1]]);
                    } catch (e) { /* silent */ }
                };
            } catch (e) { /* silent */ }

            // Автосокеты виджетов: фронтенд 1.52 создаёт сокет каждому виджету
            // (getWidgetConfig, тип `*` по умолчанию). У окна промпта он лишний —
            // вход у нас подписанный (`source`), а вторая точка рядом путает.
            // Удаляем автосокеты технических виджетов и окна (только неподключённые).
            st.dropAutoSockets = () => {
                try {
                    if (typeof this.removeInput !== "function" || !this.inputs) return;
                    for (const n of ["prompt", "selected", "save_folder"]) {
                        const idx = this.inputs.findIndex((i) => i.widget && i.widget.name === n);
                        if (idx >= 0 && this.inputs[idx].link == null) this.removeInput(idx);
                    }
                } catch (e) { /* silent */ }
            };
            st.dropAutoSockets();
            requestAnimationFrame(() => { st.dropAutoSockets(); });

            // Безопасный переход в выдачу: предложить отключить IMAGE-провод
            st.ensureIssueSafe = async () => {
                try {
                    const idx = this.inputs?.findIndex((i) => i.name === "image");
                    if (idx !== undefined && idx >= 0 && this.inputs[idx].link != null) {
                        let ok = false;
                        try {
                            ok = await app.extensionManager.dialog.confirm({
                                title: "Режим «📤 Выдача»",
                                message: "IMAGE-провод вместе с выходом в CLIP создаст цикл и Queue упадёт. Отключить IMAGE-провод?",
                            });
                        } catch (e) {
                            ok = confirm("IMAGE-провод вместе с выходом в CLIP создаст цикл. Отключить IMAGE-провод?");
                        }
                        if (ok) this.disconnectInput(idx);
                    }
                } catch (e) { /* silent */ }
                checkCycle();
            };

            const modeW = this.widgets?.find((w) => w.name === "mode");
            if (modeW) {
                modeW.callback = async (val) => {
                    if (val === "📤 Выдача") await st.ensureIssueSafe();
                    else checkCycle();
                };
            }

            // Сохранение без запуска Queue — та же логика, кнопка теперь в DOM.
            saveDomBtn.onclick = async () => {
                const pw = this.widgets?.find((w) => w.name === "prompt");
                const dest = (st.selFolder && !st.selFolder.startsWith("__")) ? st.selFolder : "";
                const linked = (this.inputs?.find((i) => i.name === "source")?.link ?? null) != null;
                const text = ((linked && st.lastFullText ? st.lastFullText : (pw?.value || "")).trim());
                const base = "💾 Сохранить промпт в открытую категорию";
                if (!text) {
                    saveDomBtn.textContent = "⚠️ Пусто — нечего сохранять";
                    setTimeout(() => { saveDomBtn.textContent = base; }, 1500);
                    return;
                }
                saveDomBtn.textContent = "⏳ Сохраняю...";
                try {
                    const r = await fetch("/prompt_library/add", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ prompt: text, folder: dest }),
                    });
                    if (r.ok) { await reload(); saveDomBtn.textContent = "✅ Сохранено"; }
                    else saveDomBtn.textContent = "❌ Ошибка";
                } catch (err) { saveDomBtn.textContent = "❌ Ошибка"; }
                setTimeout(() => { saveDomBtn.textContent = base; }, 1500);
            };

            requestAnimationFrame(() => { st.checkCycle?.(); });

            const browserWidget = this.addDOMWidget("pl_browser", "custom", root, {
                serialize: false,
                getValue: () => null,
                setValue: () => {},
            });
            // computeSize НЕ переопределяем: фронтенд 1.52 сам вычисляет высоту
            // DOM-виджета (как для CLIP Text Encode и любого штатного multiline).
            // Наше вмешательство создавало обратную связь при зуме/resize.

            reload();
            requestAnimationFrame(() => { st.enforceMinWidth?.(); this.graph?.setDirtyCanvas(true, true); });
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
                if (message?.text?.[0] !== undefined) {
                    const full = message.text[0] || "";
                    const st = this._pl;
                    if (st) st.lastFullText = full;
                    const promptWidget = this.widgets?.find((w) => w.name === "prompt");
                    if (promptWidget) {
                        const linked = (this.inputs?.find((i) => i.name === "source")?.link ?? null) != null;
                        const head = (linked && full.length > (st?.HEAD_CHARS || 300))
                            ? full.slice(0, st.HEAD_CHARS) + "\n…(полный текст — в панели книги)"
                            : full;
                        if (head !== promptWidget.value) promptWidget.value = head;
                    }
                }
                if (message?.entries && this._pl) {
                    // Полное обновление списка и дерева (renderTree живёт в замыкании onNodeCreated)
                    this._pl.reload?.();
                }
                if (message?.selected !== undefined) {
                    const w = this.widgets?.find((w) => w.name === "selected");
                    if (w && message.selected) w.value = message.selected;
                }
            } catch (e) { /* silent */ }
            return ret;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const ret = origOnConfigure?.apply(this, arguments);
            requestAnimationFrame(() => {
                try { this._pl?.dropAutoSockets?.(); } catch (e) { /* silent */ }
                // fitNode удалён.
                try { this._pl?.checkCycle?.(); } catch (e) { /* silent */ }
                try {
                    this._pl?.reload?.().then(() => {
                        // Восстановить открытую категорию из персистентного save_folder
                        const st = this._pl;
                        const sf = this.widgets?.find((w) => w.name === "save_folder");
                        if (st && sf?.value && st.folders.includes(sf.value)) {
                            st.selFolder = sf.value;
                            st.syncSaveFolder?.();
                            st.renderTree?.();
                            st.render?.();
                        }
                    }).catch(() => {});
                } catch (e) { /* silent */ }
            });
            return ret;
        };
    },
});
