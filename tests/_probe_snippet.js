/* Диагностика залипшей раскладки ноды PromptLibrary — вставить в F12 → Console.
 *
 * Зачем: glitch «внутренний контент сузился и остался зажатым» не воспроизводится
 * на чистом старте (проверено живым замером: tests/_probe_live_dom.py — Vue и
 * канвас, панель свойств, растягивание мышью через CDP). Значит, состояние
 * залипания живёт только в конкретной сессии — сниппет читает ИМЕННО его.
 *
 * Ничего не меняет, только печатает JSON. Зависит только от публичных полей
 * LiteGraph (`node.widgets[].element`), поэтому работает и на загруженной ранее
 * версии расширения (классы .pl-* для него не нужны).
 */
(() => {
  const px = (v) => Math.round(v * 100) / 100;
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: px(r.width), h: px(r.height), x: px(r.x), y: px(r.y) };
  };
  const css = (el, props) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs[p];
    return out;
  };
  const chain = (el, depth) => {
    const out = [];
    for (let e = el, i = 0; e && e !== document.body && i < (depth || 8); e = e.parentElement, i++) {
      out.push({
        tag: e.tagName,
        cls: String(e.className || "").split(" ").slice(0, 3).join("."),
        testid: (e.dataset && e.dataset.testid) || null,
        node: (e.dataset && e.dataset.nodeId) || null,
        rect: rect(e),
        css: css(e, ["display", "flex", "width", "minWidth", "maxWidth", "overflowX", "gridTemplateColumns"]),
      });
    }
    return out;
  };
  const kids = (el, limit) => {
    if (!el) return null;
    const out = [];
    for (const c of Array.from(el.children).slice(0, limit || 8)) {
      out.push({
        tag: c.tagName,
        cls: String(c.className || "").split(" ").slice(0, 2).join("."),
        rect: rect(c),
        inline: (c.getAttribute("style") || "").slice(0, 120),
      });
    }
    return out;
  };

  const app = window.app;
  const report = {
    js: (window.app && window.app.ui && window.app.ui.lastVersion) || null,
    renderMode: window.LiteGraph && window.LiteGraph.vueNodesMode ? "vue" : "canvas",
    zoom: app && app.canvas && app.canvas.ds ? app.canvas.ds.scale : null,
    panelOpen: !!document.querySelector('[data-testid="properties-panel"]'),
    nodes: {},
  };

  const nodes = ((app && app.graph && app.graph._nodes) || []).filter(
    (n) => String((n && n.type) || "").toLowerCase() === "promptlibrary"
  );

  for (const n of nodes) {
    const info = { id: n.id, size: { w: px(n.size[0]), h: px(n.size[1]) }, pos: { x: n.pos[0], y: n.pos[1] } };
    const w = (n.widgets || []).find((x) => x.name === "pl_browser");
    info.widget = w ? { computedHeight: w.computedHeight, lastY: w.last_y, hidden: !!w.hidden } : null;
    const el = w && w.element;
    // el — ЭТО и есть наш root (движок отдаёт виджету наш корневой элемент)
    info.root = el ? {
      rect: rect(el),
      inline: (el.getAttribute("style") || "").slice(0, 240),
      css: css(el, ["width", "minWidth", "maxWidth", "height", "display", "flex", "overflow"]),
      children: kids(el, 6),
    } : null;
    if (el) info.parents = chain(el.parentElement, 7);
    const nodeEl = document.querySelector(`[data-node-id="${n.id}"]`);
    if (nodeEl) {
      const cs = getComputedStyle(nodeEl);
      info.cssVars = {
        nodeWidth: cs.getPropertyValue("--node-width").trim(),
        nodeHeight: cs.getPropertyValue("--node-height").trim(),
        minNodeWidth: cs.getPropertyValue("--min-node-width").trim(),
        inlineMinWidth: nodeEl.style.minWidth,
      };
      info.nodeEl = { rect: rect(nodeEl) };
      info.nodeChain = chain(nodeEl.firstElementChild, 4);
    }
    report.nodes[n.id] = info;
  }

  console.log(JSON.stringify(report, null, 2));
  return "готово: JSON выше (скопировать целиком)";
})();
