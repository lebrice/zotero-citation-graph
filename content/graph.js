/* Citation Graph — the page that runs inside the iframe (tab or item pane).
 *
 * Two modes, chosen by the URL hash:
 *   #full  the graph of a collection / library / selection, with force and timeline layouts
 *   #ego   the selected paper with what it cites and what cites it (item pane)
 *
 * The plugin injects a `host` object (window.CitationGraphHost) and calls
 * CitationGraphPage.start(host). Data crosses the boundary as JSON strings.
 */

/* global d3 */

(function () {
	"use strict";

	const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
	const shortTitle = (t, n = 44) => (t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…");
	const wrap = (t, n = 30) => {
		const out = [];
		let line = "";
		t.split(/\s+/).forEach((w) => {
			if ((line + " " + w).trim().length > n && line) {
				out.push(line);
				line = w;
			}
			else line = (line + " " + w).trim();
		});
		if (line) out.push(line);
		return out.slice(0, 4);
	};
	const cites = n => Math.max(n.citations?.openalex ?? 0, n.citations?.semanticscholar ?? 0);
	const viaLabel = via => via.map(v => (v === "semanticscholar" ? "S2" : v === "openalex" ? "OA" : v)).join("+");
	const groupColor = (graph, name) => (graph.groups.find(g => g.name === name) || { color: "#888" }).color;
	const ringClass = (graph, status) => {
		if (!status) return "ring-3";
		const i = graph.statuses.indexOf(status);
		return i < 0 ? "ring-3" : `ring-${i % 4}`;
	};

	// ================================================================== full graph
	const Full = {
		host: null,
		graph: null,
		state: { layout: "force", size: "local", fullTitles: false, rings: true, hidden: new Set(), query: "", active: null, pinned: null },
		el: {},
		sim: null,
		zoom: null,
		nodes: [],
		links: [],
		byID: new Map(),
		buildsOn: new Map(),
		builtOnBy: new Map(),
		W: 800,
		H: 600,
		timelineBox: null,

		async start(host) {
			this.host = host;
			this.render();
			await this.load();
		},

		async load() {
			try {
				this.setGraph(JSON.parse(await this.host.getGraph()));
			}
			catch (e) {
				this.host.log(`load failed: ${e}`);
				this.showNotice("Could not build the graph", String(e));
			}
		},

		async refresh() {
			await this.load();
		},

		render() {
			const app = document.getElementById("app");
			app.hidden = false;
			document.getElementById("boot").hidden = true;
			app.innerHTML = `
				<header class="top">
					<div><h1 id="title">Citation graph</h1><div class="sub" id="sub"></div></div>
					<div class="controls">
						<input id="search" type="search" placeholder="find title or author…" aria-label="Find a paper">
						<div class="seg" role="group" aria-label="Layout"><button id="lay-force" aria-pressed="true">Force</button><button id="lay-time" aria-pressed="false">Timeline</button></div>
						<span class="lab">size</span>
						<div class="seg" role="group" aria-label="Node size"><button id="size-local" aria-pressed="true" title="how many items of this graph cite it">in graph</button><button id="size-global" aria-pressed="false" title="all citations known to OpenAlex / Semantic Scholar, log scale">all citations</button></div>
						<label class="check"><input id="fulltitles" type="checkbox"> full titles</label>
						<label class="check"><input id="rings" type="checkbox" checked> status rings</label>
						<button class="btn" id="fit" title="zoom to fit">⤢ fit</button>
						<button class="btn primary" id="fetch" hidden></button>
						<button class="btn" id="reload" title="rebuild from Zotero and the cache">↻</button>
					</div>
				</header>
				<div class="legend" id="legend"></div>
				<div class="main">
					<div class="canvas">
						<svg class="graph" id="svg" role="img" aria-label="Citation graph"></svg>
						<div class="hint">hover: details · click: pin · drag: move · wheel: zoom · click background: unpin</div>
						<div class="notice" id="notice" hidden></div>
					</div>
					<aside class="panel" id="panel"></aside>
				</div>
				<footer class="footer" id="footer"></footer>`;
			this.el = {
				title: document.getElementById("title"), sub: document.getElementById("sub"), legend: document.getElementById("legend"),
				panel: document.getElementById("panel"), footer: document.getElementById("footer"), notice: document.getElementById("notice"),
				search: document.getElementById("search"), fetch: document.getElementById("fetch")
			};
			this.svg = d3.select("#svg");
			const defs = this.svg.append("defs");
			[["arrow", "var(--edge)"], ["arrow-in", "var(--edge-in)"], ["arrow-out", "var(--edge-out)"]].forEach(([id, color]) => defs.append("marker")
				.attr("id", id).attr("viewBox", "0 -4 8 8").attr("refX", 7).attr("refY", 0).attr("markerWidth", 7).attr("markerHeight", 7).attr("orient", "auto")
				.append("path").attr("d", "M0,-3.5L8,0L0,3.5Z").attr("fill", color));
			this.root = this.svg.append("g");
			this.gLanes = this.root.append("g").attr("class", "lanes");
			this.gAxis = this.root.append("g").attr("class", "yearaxis");
			this.gLinks = this.root.append("g");
			this.gNodes = this.root.append("g");
			this.zoom = d3.zoom().scaleExtent([0.2, 4]).on("zoom", e => this.root.attr("transform", e.transform));
			this.svg.call(this.zoom).on("dblclick.zoom", null);
			this.svg.on("click", () => {
				if (this.state.pinned) {
					this.state.pinned = null;
					this.state.active = null;
					this.paint();
					this.renderPanel(null);
				}
			});
			this.sim = d3.forceSimulation().alphaDecay(0.03);
			this.linkForce = d3.forceLink().id(d => d.id);
			this.bindControls();
			window.addEventListener("resize", () => {
				this.measure();
				if (this.graph) this.layout();
			});
		},

		bindControls() {
			const pressed = (id, on) => document.getElementById(id).setAttribute("aria-pressed", on ? "true" : "false");
			document.getElementById("lay-force").onclick = () => { this.state.layout = "force"; pressed("lay-force", true); pressed("lay-time", false); this.rebuild(); };
			document.getElementById("lay-time").onclick = () => { this.state.layout = "timeline"; pressed("lay-force", false); pressed("lay-time", true); this.rebuild(); };
			document.getElementById("size-local").onclick = () => { this.state.size = "local"; pressed("size-local", true); pressed("size-global", false); this.restyle(); };
			document.getElementById("size-global").onclick = () => { this.state.size = "global"; pressed("size-local", false); pressed("size-global", true); this.restyle(); };
			document.getElementById("fulltitles").onchange = e => { this.state.fullTitles = e.target.checked; this.restyle(); };
			document.getElementById("rings").onchange = e => { this.state.rings = e.target.checked; this.style(); };
			document.getElementById("fit").onclick = () => this.fit();
			document.getElementById("reload").onclick = () => this.load();
			this.el.fetch.onclick = () => this.fetch();
			this.el.search.addEventListener("input", () => { this.state.query = this.el.search.value; this.paint(); });
			this.el.search.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					const q = this.el.search.value.trim().toLowerCase();
					const hit = this.visible().find(n => n.title.toLowerCase().includes(q) || n.authors.join(" ").toLowerCase().includes(q));
					if (hit) this.pin(hit);
				}
				if (e.key === "Escape") { this.el.search.value = ""; this.state.query = ""; this.paint(); }
			});
		},

		async fetch() {
			this.el.fetch.disabled = true;
			this.el.fetch.textContent = "Fetching…";
			try {
				this.setGraph(JSON.parse(await this.host.fetch(false)));
			}
			catch (e) {
				this.host.log(`fetch failed: ${e}`);
			}
			this.el.fetch.disabled = false;
		},

		showNotice(title, text) {
			this.el.notice.hidden = false;
			this.el.notice.innerHTML = `<h2>${esc(title)}</h2><div>${esc(text)}</div>`;
		},

		measure() {
			const r = this.svg.node().getBoundingClientRect();
			this.W = Math.max(300, r.width);
			this.H = Math.max(300, r.height);
		},

		radius(n) {
			return this.state.size === "local" ? 6 + 2.4 * Math.sqrt(this.builtOnBy.get(n.id).length) : 5 + 2.6 * Math.log10(1 + cites(n));
		},

		visible() {
			return this.nodes.filter(n => !this.state.hidden.has(n.group));
		},

		visibleLinks() {
			return this.links.filter(l => !this.state.hidden.has(l.source.group) && !this.state.hidden.has(l.target.group));
		},

		setGraph(graph) {
			const pinnedID = this.state.pinned ? this.state.pinned.id : null;
			const oldPos = new Map(this.nodes.map(n => [n.id, { x: n.x, y: n.y }]));
			this.graph = graph;
			this.nodes = graph.nodes.map(n => Object.assign({}, n, oldPos.get(n.id) || {}));
			this.byID = new Map(this.nodes.map(n => [n.id, n]));
			this.links = graph.edges.filter(e => this.byID.has(e.source) && this.byID.has(e.target))
				.map(e => ({ source: this.byID.get(e.source), target: this.byID.get(e.target), via: e.via }));
			this.builtOnBy = new Map(this.nodes.map(n => [n.id, []]));
			this.buildsOn = new Map(this.nodes.map(n => [n.id, []]));
			this.links.forEach((l) => { this.builtOnBy.get(l.source.id).push(l); this.buildsOn.get(l.target.id).push(l); });
			this.state.pinned = pinnedID ? this.byID.get(pinnedID) || null : null;
			this.state.active = this.state.pinned;
			this.state.hidden = new Set([...this.state.hidden].filter(g => graph.groups.some(x => x.name === g)));
			this.el.notice.hidden = true;
			this.renderHeader();
			this.renderLegend();
			this.renderPanel(this.state.pinned);
			this.measure();
			this.rebuild();
			if (!this.nodes.length) this.showNotice("No items", "This collection has no regular items.");
			else if (!this.links.length && graph.unresolved === this.nodes.length) this.showNotice("No citation data yet", "Click “Fetch citations” to look the items up in OpenAlex and Semantic Scholar.");
		},

		renderHeader() {
			const g = this.graph;
			this.el.title.textContent = `Citation graph — ${g.name}`;
			this.el.sub.textContent = `${this.nodes.length} items, ${this.links.length} citation links · an arrow A → B means B cites A`;
			this.el.fetch.hidden = !g.unresolved;
			this.el.fetch.textContent = `Fetch citations (${g.unresolved} not fetched)`;
			const via = {
				oa: this.links.filter(l => l.via.includes("openalex")).length,
				s2: this.links.filter(l => l.via.includes("semanticscholar")).length,
				rel: this.links.filter(l => l.via.includes("related")).length
			};
			this.el.footer.innerHTML = `Links are the union of the OpenAlex (${via.oa}) and Semantic Scholar (${via.s2}) reference lists of each item, restricted to the items shown${via.rel ? `, plus ${via.rel} Zotero “Related” link(s)` : ""}. A missing arrow can mean a missing reference list, not a missing citation. ${g.unresolved ? `${g.unresolved} item(s) not fetched yet.` : "All items fetched."}`;
		},

		renderLegend() {
			const legend = d3.select(this.el.legend).html("");
			legend.append("span").attr("class", "lab").text("group");
			for (const c of this.graph.groups) {
				const n = this.nodes.filter(x => x.group === c.name).length;
				if (!n) continue;
				legend.append("button").attr("class", "chip").attr("aria-pressed", this.state.hidden.has(c.name) ? "false" : "true").style("--c", c.color).attr("title", c.name)
					.html(`<span class="dot"></span>${esc(shortTitle(c.name, 28))} <span class="n">${n}</span>`)
					.on("click", (event) => {
						const el = event.currentTarget;
						const on = el.getAttribute("aria-pressed") === "true";
						el.setAttribute("aria-pressed", on ? "false" : "true");
						if (on) this.state.hidden.add(c.name); else this.state.hidden.delete(c.name);
						this.rebuild();
					});
			}
			const ring = (dash, w) => `<svg width="18" height="18"><circle cx="9" cy="9" r="6" fill="var(--panel-2)" stroke="var(--pin)" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ""}/></svg>`;
			const styles = ["", "3 2", "1 2.5", ""], widths = [2.4, 1.8, 1.8, 0];
			const items = this.graph.statuses.map((s, i) => `<span>${ring(styles[i % 4], widths[i % 4])}${esc(s)}</span>`).join("");
			legend.append("div").attr("class", "status").html(`<span class="lab">status tag</span>${items}<span><svg width="18" height="18"><circle cx="9" cy="9" r="6" fill="var(--panel-2)" fill-opacity=".4" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="2 2"/></svg>not fetched</span>`);
		},

		// ---------------------------------------------------------------- layout
		rebuild() {
			const vn = this.visible(), vl = this.visibleLinks();
			this.linkSel = this.gLinks.selectAll("path.link").data(vl, l => l.source.id + "|" + l.target.id);
			this.linkSel.exit().remove();
			this.linkSel = this.linkSel.enter().append("path").attr("class", "link").attr("marker-end", "url(#arrow)").merge(this.linkSel);

			this.nodeSel = this.gNodes.selectAll("g.node").data(vn, n => n.id);
			this.nodeSel.exit().remove();
			const ne = this.nodeSel.enter().append("g").attr("class", "node");
			ne.append("circle").attr("class", "halo");
			ne.append("circle").attr("class", "body");
			ne.append("circle").attr("class", "hit");
			ne.append("text").attr("class", "t");
			ne.append("text").attr("class", "a");
			ne.call(d3.drag()
				.on("start", (e, d) => { if (this.state.layout === "timeline") return; if (!e.active) this.sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
				.on("drag", (e, d) => { if (this.state.layout === "timeline") { d.x = e.x; d.y = e.y; this.tick(); return; } d.fx = e.x; d.fy = e.y; })
				.on("end", (e, d) => { if (this.state.layout === "timeline") return; if (!e.active) this.sim.alphaTarget(0); }));
			ne.on("mouseenter", (e, d) => { if (!this.state.pinned) { this.state.active = d; this.paint(); this.renderPanel(d); } })
				.on("mouseleave", () => { if (!this.state.pinned) { this.state.active = null; this.paint(); this.renderPanel(null); } })
				.on("click", (e, d) => { e.stopPropagation(); this.pin(this.state.pinned === d ? null : d); });
			this.nodeSel = ne.merge(this.nodeSel);
			this.style();
			this.layout();
			this.sim.on("tick", () => this.tick());
		},

		pin(node) {
			this.state.pinned = node;
			this.state.active = node;
			this.paint();
			this.renderPanel(node);
		},

		restyle() {
			this.style();
			if (this.state.layout === "timeline") this.layoutTimeline(this.visible());
			else this.sim.alpha(0.3).restart();
		},

		layout() {
			const vn = this.visible(), vl = this.visibleLinks();
			if (this.state.layout === "timeline") { this.layoutTimeline(vn); return; }
			this.svg.classed("timeline", false);
			this.gLanes.selectAll("*").remove();
			this.gAxis.selectAll("*").remove();
			this.sim.nodes(vn)
				.force("link", this.linkForce.links(vl).distance(l => 120 + this.radius(l.source) + this.radius(l.target)).strength(0.35))
				.force("charge", d3.forceManyBody().strength(-900).distanceMax(600))
				.force("collide", d3.forceCollide().radius(n => this.radius(n) + 46).strength(0.9).iterations(2))
				.force("x", d3.forceX(this.W / 2).strength(0.05)).force("y", d3.forceY(this.H / 2).strength(0.08))
				.force("center", d3.forceCenter(this.W / 2, this.H / 2));
			vn.forEach((n) => { n.fx = null; n.fy = null; });
			this.sim.alpha(1).stop();
			this.sim.tick(320);                         // settle synchronously, then show the finished layout
			this.tick();
			this.fit(true);
			this.sim.alpha(0.05).restart();
		},

		// Timeline: a deterministic swimlane chart. One column per year that has an item, one lane
		// per group; inside a lane the items are packed into rows so that no two labels overlap.
		layoutTimeline(vn) {
			this.sim.stop();
			this.svg.classed("timeline", true);
			const groups = this.graph.groups.filter(c => !this.state.hidden.has(c.name) && vn.some(n => n.group === c.name));
			const yrs = [...new Set(vn.map(n => n.year).filter(Boolean))].sort((a, b) => a - b);
			const left = 190, colW = Math.max(72, (this.W - left - 90) / Math.max(1, yrs.length));
			const x = y => left + colW * yrs.indexOf(y);
			const TL = 30;
			const lines = n => (this.state.fullTitles ? wrap(n.title, TL).length : 1);
			const labelW = n => 5.7 * Math.max(this.state.fullTitles ? Math.min(TL, n.title.length) : shortTitle(n.title, TL).length, (n.first_author + " · " + n.year).length * 0.85);
			const lanePos = [];
			let top = 46;
			const noYear = vn.filter(n => !n.year);
			for (const c of groups) {
				const ps = vn.filter(n => n.group === c.name && n.year).sort((a, b) => (a.year - b.year) || a.first_author.localeCompare(b.first_author));
				const rowEnd = [];
				ps.forEach((n) => {
					const r = this.radius(n), x0 = x(n.year) - r - 2, x1 = x0 + 2 * r + 8 + labelW(n) + 10;
					let row = rowEnd.findIndex(e => e <= x0);
					if (row < 0) { row = rowEnd.length; rowEnd.push(-Infinity); }
					rowEnd[row] = x1;
					n._row = row;
				});
				const rh = 22 + 13 * (d3.max(ps, lines) || 1);
				const h = Math.max(48, rowEnd.length * rh + 18);
				ps.forEach((n) => { n.x = x(n.year); n.y = top + 9 + rh * n._row + rh / 2; n.fx = null; n.fy = null; n.vx = 0; n.vy = 0; });
				lanePos.push({ c, top, h });
				top += h;
			}
			noYear.forEach((n, i) => { n.x = left / 2; n.y = 70 + i * 34; });      // items without a year sit in the margin
			const totalW = left + colW * Math.max(0, yrs.length - 1) + 230, totalH = top + 26;
			this.timelineBox = { x0: 0, y0: 0, x1: totalW, y1: totalH };
			const lg = this.gLanes.selectAll("g.lane").data(lanePos, d => d.c.name);
			lg.exit().remove();
			const le = lg.enter().append("g").attr("class", "lane");
			le.append("rect");
			le.append("text");
			this.gLanes.selectAll("g.lane").each(function (d, i) {
				const g = d3.select(this);
				g.select("rect").attr("x", 0).attr("y", d.top + 2).attr("width", totalW).attr("height", d.h - 4).attr("rx", 6).attr("fill-opacity", i % 2 ? 0.55 : 0.95);
				g.select("text").attr("x", 12).attr("y", d.top + 18).attr("fill", d.c.color).attr("font-weight", 600).text(shortTitle(d.c.name, 26));
			});
			this.gAxis.selectAll("*").remove();
			const ax = this.gAxis.selectAll("g").data(yrs).enter().append("g").attr("transform", y => `translate(${x(y)},0)`);
			ax.append("line").attr("y1", 40).attr("y2", totalH - 8);
			ax.append("text").attr("y", 30).attr("text-anchor", "middle").text(y => y);
			this.gAxis.append("text").attr("x", totalW - 12).attr("y", totalH - 8).attr("text-anchor", "end").text("columns: the years that have an item, equally spaced · rows: no two labels overlap");
			this.style();
			this.tick();
			this.fit(true);
		},

		fit(immediate) {
			const vn = this.visible();
			if (!vn.length) return;
			let x0, x1, y0, y1;
			if (this.state.layout === "timeline" && this.timelineBox) ({ x0, x1, y0, y1 } = this.timelineBox);
			else { x0 = d3.min(vn, n => n.x) - 90; x1 = d3.max(vn, n => n.x) + 90; y0 = d3.min(vn, n => n.y) - 40; y1 = d3.max(vn, n => n.y) + 60; }
			const k = Math.min(1.6, 0.96 * Math.min(this.W / (x1 - x0), this.H / (y1 - y0)));
			const t = d3.zoomIdentity.translate(this.W / 2 - k * (x0 + x1) / 2, this.H / 2 - k * (y0 + y1) / 2).scale(k);
			if (immediate) this.svg.call(this.zoom.transform, t);
			else this.svg.transition().duration(500).call(this.zoom.transform, t);
		},

		style() {
			const self = this, graph = this.graph, tl = this.state.layout === "timeline";
			this.nodeSel.attr("class", n => `node ${this.state.rings ? ringClass(graph, n.status) : "ring-3"}${n.resolved ? "" : " unresolved"}`)
				.each(function (n) {
					const r = self.radius(n), g = d3.select(this);
					g.select("circle.body").attr("r", r).attr("fill", groupColor(graph, n.group));
					g.select("circle.hit").attr("r", r + 8);
					g.select("circle.halo").attr("r", r + 4.5);
					const lx = tl ? r + 7 : 0, anchor = tl ? "start" : "middle";
					const lines = self.state.fullTitles ? wrap(n.title, tl ? 30 : 30) : [shortTitle(n.title, tl ? 30 : 44)];
					const y0 = tl ? -(lines.length * 13 + 11) / 2 + 11 : r + 14;
					const t = g.select("text.t").attr("text-anchor", anchor);
					t.selectAll("tspan").remove();
					lines.forEach((ln, i) => t.append("tspan").attr("x", lx).attr("y", y0 + i * 13).text(ln));
					g.select("text.a").attr("x", lx).attr("y", y0 + lines.length * 13).attr("text-anchor", anchor).text(`${n.first_author || "?"} · ${n.year ?? "?"}`);
				});
			this.paint();
		},

		paint() {
			const a = this.state.active || this.state.pinned;
			const q = this.state.query.trim().toLowerCase();
			const match = n => !q || n.title.toLowerCase().includes(q) || n.authors.join(" ").toLowerCase().includes(q) || String(n.year).includes(q);
			const nb = a ? new Set([a.id, ...this.builtOnBy.get(a.id).map(l => l.target.id), ...this.buildsOn.get(a.id).map(l => l.source.id)]) : null;
			this.nodeSel.classed("active", n => n === a).classed("pinned", n => n === this.state.pinned)
				.classed("dim", n => (nb ? !nb.has(n.id) : !match(n)));
			this.linkSel.classed("in", l => a && l.target.id === a.id)
				.classed("out", l => a && l.source.id === a.id)
				.classed("dim", l => (a ? (l.target.id !== a.id && l.source.id !== a.id) : (q && !(match(l.source) && match(l.target)))))
				.attr("marker-end", l => (a && l.target.id === a.id ? "url(#arrow-in)" : a && l.source.id === a.id ? "url(#arrow-out)" : "url(#arrow)"));
		},

		tick() {
			const self = this;
			this.linkSel.attr("d", (l) => {
				const s = l.source, t = l.target, dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
				const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
				const bend = Math.min(26, len * 0.18);
				const sx = s.x + ux * (self.radius(s) + 1), sy = s.y + uy * (self.radius(s) + 1);
				const tx = t.x - ux * (self.radius(t) + 5), ty = t.y - uy * (self.radius(t) + 5);
				const cx = (sx + tx) / 2 + nx * bend, cy = (sy + ty) / 2 + ny * bend;
				return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
			});
			this.nodeSel.attr("transform", n => `translate(${n.x},${n.y})`);
		},

		// ---------------------------------------------------------------- side panel
		renderPanel(n) {
			const panel = this.el.panel, graph = this.graph;
			if (!n) {
				panel.innerHTML = `<div class="empty"><h2>Hover an item</h2><p>The panel shows title, authors, abstract, Zotero notes and the items it builds on and is built on by — within this graph.</p>
					<ul><li><b>Colour</b> — subcollection (or top-level collection).</li><li><b>Size</b> — how many items of the graph cite it, or all citations.</li><li><b>Ring</b> — the item's status tag (${esc(graph.statuses.join(", "))}).</li><li><b>Timeline</b> — columns are years, rows are groups: read the arrows left to right.</li></ul>
					<p>Click an item to pin it, then use the buttons. “Select in Zotero” jumps to the item in the library.</p></div>`;
				return;
			}
			const relList = (list, dir) => (list.length ? `<ul class="rel">${list.map((l) => {
				const other = dir === "in" ? l.source : l.target;
				return `<li><span class="dot" style="--c:${groupColor(graph, other.group)}"></span><button data-id="${esc(other.id)}">${esc(other.first_author)} ${esc(other.year ?? "")} — ${esc(shortTitle(other.title, 60))}</button><span class="via">${esc(viaLabel(l.via))}</span></li>`;
			}).join("")}</ul>` : "<p class=\"muted\" style=\"color:var(--muted)\">none within this graph</p>");
			const statusSelect = n.editable ? `<select id="status" aria-label="status tag"><option value="">status: —</option>${graph.statuses.map(s => `<option value="${esc(s)}" ${s === n.status ? "selected" : ""}>status: ${esc(s)}</option>`).join("")}</select>` : "";
			panel.innerHTML = `
				<div><span class="badge" style="--c:${groupColor(graph, n.group)}"><span class="dot"></span>${esc(shortTitle(n.group, 40))}</span>${n.status ? `<span class="pill">${esc(n.status)}</span>` : ""}</div>
				<h2 class="title">${esc(n.title)}</h2>
				<div class="authors">${esc(n.authors.join("; "))}</div>
				<div class="venue">${esc([n.venue, n.year].filter(Boolean).join(" · "))}${cites(n) ? ` · ${cites(n).toLocaleString()} citations` : ""}</div>
				<div class="links">
					<button class="btn" id="select">Select in Zotero</button>
					${n.doi ? `<button class="btn" id="doi">DOI</button>` : (n.url ? `<button class="btn" id="url">Link</button>` : "")}
					<button class="btn" id="fetchone">${n.resolved ? "Re-fetch" : "Fetch citations"}</button>
					${statusSelect}
				</div>
				${n.resolved ? "" : `<p class="warn">Not looked up yet — its own reference list is unknown; arrows into it come from other items' lists.</p>`}
				${n.abstract ? `<h3>Abstract</h3><div class="abstract">${esc(n.abstract)}</div>` : ""}
				${n.notes.length ? `<h3>Notes</h3>${n.notes.map(t => `<div class="note">${esc(t)}</div>`).join("")}` : ""}
				<h3>Builds on <span class="via">(${this.buildsOn.get(n.id).length})</span></h3>${relList(this.buildsOn.get(n.id), "in")}
				<h3>Built on by <span class="via">(${this.builtOnBy.get(n.id).length})</span></h3>${relList(this.builtOnBy.get(n.id), "out")}`;
			panel.querySelectorAll(".rel button").forEach(b => b.addEventListener("click", () => this.pin(this.byID.get(b.dataset.id))));
			panel.querySelector("#select").onclick = () => this.host.selectItem(n.id);
			const doi = panel.querySelector("#doi");
			if (doi) doi.onclick = () => this.host.openURL(`https://doi.org/${n.doi}`);
			const url = panel.querySelector("#url");
			if (url) url.onclick = () => this.host.openURL(n.url);
			panel.querySelector("#fetchone").onclick = async (e) => {
				e.target.disabled = true;
				e.target.textContent = "Fetching…";
				try { this.setGraph(JSON.parse(await this.host.fetchItem(n.id))); }
				catch (err) { this.host.log(`fetchItem failed: ${err}`); }
			};
			const sel = panel.querySelector("#status");
			if (sel) sel.onchange = async () => {
				try { this.setGraph(JSON.parse(await this.host.setStatus(n.id, sel.value))); }
				catch (err) { this.host.log(`setStatus failed: ${err}`); }
			};
			panel.scrollTop = 0;
		}
	};

	// ================================================================== ego view (item pane)
	const Ego = {
		host: null,
		graph: null,

		async start(host) {
			this.host = host;
			const app = document.getElementById("app");
			app.hidden = false;
			document.getElementById("boot").hidden = true;
			app.className = "ego";
			try {
				this.graph = JSON.parse(await host.getGraph());
				this.render();
			}
			catch (e) {
				host.log(`ego load failed: ${e}`);
				app.innerHTML = `<div class="empty">Could not build the citation view: ${esc(String(e))}</div>`;
			}
		},

		async refresh() {
			if (!this.host) return;
			this.graph = JSON.parse(await this.host.getGraph());
			this.render();
		},

		render() {
			const g = this.graph, app = document.getElementById("app");
			const focus = g.nodes.find(n => n.id === g.focus);
			const byID = new Map(g.nodes.map(n => [n.id, n]));
			const citesList = g.edges.filter(e => e.target === g.focus).map(e => ({ node: byID.get(e.source), via: e.via })).filter(x => x.node);
			const citedBy = g.edges.filter(e => e.source === g.focus).map(e => ({ node: byID.get(e.target), via: e.via })).filter(x => x.node);
			const sortY = a => a.sort((p, q) => ((p.node.year || 0) - (q.node.year || 0)) || p.node.first_author.localeCompare(q.node.first_author));
			sortY(citesList);
			sortY(citedBy);
			const rows = Math.max(citesList.length, citedBy.length, 1);
			const rowH = 30, topPad = 26, W = Math.max(300, app.clientWidth || 320), H = topPad + rows * rowH + 10;
			const head = g.resolved
				? `<span>Cites <b>${citesList.length}</b> · cited by <b>${citedBy.length}</b> in this library</span><span class="spacer"></span><button class="btn" id="open">Full graph</button>`
				: `<span>Citations not fetched yet</span><span class="spacer"></span><button class="btn primary" id="fetch">Fetch</button><button class="btn" id="open">Full graph</button>`;
			app.innerHTML = `<div class="head">${head}</div><svg id="ego-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"></svg><div class="foot">${g.resolved ? `${g.refs_total} references and ${g.citations_total.toLocaleString()} citations known to OpenAlex / Semantic Scholar; only items of your library are shown. Click an item to select it.` : "Fetching looks the item up in OpenAlex and Semantic Scholar and stores its reference list locally."}</div>`;
			app.querySelector("#open").onclick = () => this.host.openFull();
			const fetchBtn = app.querySelector("#fetch");
			if (fetchBtn) fetchBtn.onclick = async () => {
				fetchBtn.disabled = true;
				fetchBtn.textContent = "Fetching…";
				try { this.graph = JSON.parse(await this.host.fetch(false)); this.render(); }
				catch (e) { this.host.log(`ego fetch failed: ${e}`); }
			};
			const svg = d3.select("#ego-svg");
			const defs = svg.append("defs");
			[["e-in", "var(--edge-in)"], ["e-out", "var(--edge-out)"]].forEach(([id, color]) => defs.append("marker")
				.attr("id", id).attr("viewBox", "0 -4 8 8").attr("refX", 7).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
				.append("path").attr("d", "M0,-3.5L8,0L0,3.5Z").attr("fill", color));
			const colX = { left: 14, mid: W / 2, right: W - 14 };
			const midY = topPad + (rows * rowH) / 2;
			svg.append("text").attr("class", "col-title").attr("x", colX.left).attr("y", 14).text(`builds on (${citesList.length})`);
			svg.append("text").attr("class", "col-title").attr("x", colX.right).attr("y", 14).attr("text-anchor", "end").text(`built on by (${citedBy.length})`);
			const yOf = (i, n) => topPad + rowH * (i + 0.5) + (rows - n) * rowH / 2;
			const link = (x1, y1, x2, y2, cls) => svg.append("path").attr("class", `link ${cls}`).attr("marker-end", `url(#${cls === "in" ? "e-in" : "e-out"})`)
				.attr("d", `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`);
			const labelText = n => `${n.first_author || "?"} · ${n.year ?? "?"}`;
			const maxChars = Math.max(14, Math.floor((W / 2 - 70) / 5.8));
			const drawNode = (n, x, y, anchor, cls) => {
				const gN = svg.append("g").attr("class", `n ${cls} ${ringClass(g, n.status)}`).attr("transform", `translate(${x},${y})`).on("click", () => this.host.selectItem(n.id));
				gN.append("title").text(`${n.title}\n${n.authors.join("; ")}${n.year ? ` (${n.year})` : ""}`);
				gN.append("circle").attr("r", cls === "focus" ? 8 : 6).attr("fill", groupColor(g, n.group)).attr("fill-opacity", n.resolved ? 1 : 0.4);
				const tx = anchor === "start" ? 12 : anchor === "end" ? -12 : 0;
				gN.append("text").attr("x", tx).attr("y", -1).attr("text-anchor", anchor).text(shortTitle(n.title, maxChars));
				gN.append("text").attr("class", "a").attr("x", tx).attr("y", 11).attr("text-anchor", anchor).text(labelText(n));
				return gN;
			};
			citesList.forEach((x, i) => {
				const y = yOf(i, citesList.length);
				link(colX.left + 8, y, colX.mid - 12, midY, "in");
				drawNode(x.node, colX.left + 6, y, "start", "cites");
			});
			citedBy.forEach((x, i) => {
				const y = yOf(i, citedBy.length);
				link(colX.mid + 12, midY, colX.right - 8, y, "out");
				drawNode(x.node, colX.right - 6, y, "end", "citedby");
			});
			if (focus) {
				const f = svg.append("g").attr("class", `n focus ${ringClass(g, focus.status)}`).attr("transform", `translate(${colX.mid},${midY})`);
				f.append("circle").attr("r", 9).attr("fill", groupColor(g, focus.group));
				f.append("text").attr("x", 0).attr("y", 24).attr("text-anchor", "middle").text(shortTitle(focus.title, Math.max(18, maxChars - 4)));
				f.append("text").attr("class", "a").attr("x", 0).attr("y", 36).attr("text-anchor", "middle").text(labelText(focus));
			}
			if (!citesList.length && !citedBy.length && g.resolved) {
				svg.append("text").attr("class", "col-title").attr("x", colX.mid).attr("y", midY - 20).attr("text-anchor", "middle").text("no citation links to other items of this library");
			}
			this.host.setHeight(H + 64);
		}
	};

	// ================================================================== entry point
	const mode = location.hash.includes("ego") ? "ego" : "full";
	const page = mode === "ego" ? Ego : Full;
	window.CitationGraphPage = {
		mode,
		start: host => page.start(host),
		refresh: () => page.refresh()
	};
	if (window.CitationGraphHost) page.start(window.CitationGraphHost);
})();
