/* Citation Graph — resolver.
 *
 * Finds every Zotero item in OpenAlex and Semantic Scholar, stores the two
 * reference lists in a cache file in the Zotero data directory, and turns
 * them into "A is cited by B" edges between items of the library.
 *
 * Runs inside Zotero's privileged plugin scope (Zotero, IOUtils, PathUtils
 * are globals there). No item is ever modified by this file.
 */

/* global Zotero, IOUtils, PathUtils */

"use strict";

var CitationGraphResolver = {
	CACHE_VERSION: 1,
	OPENALEX: "https://api.openalex.org",
	S2: "https://api.semanticscholar.org/graph/v1",
	OA_SELECT: "id,doi,title,publication_year,cited_by_count,referenced_works,abstract_inverted_index,primary_location,authorships",
	S2_FIELDS: "paperId,title,year,citationCount,externalIds,references.paperId,references.title,references.year,references.externalIds",
	OA_BATCH: 40,
	S2_BATCH: 50,

	_cache: null,
	_stamp: 0,           // bumped on every cache change; indexes compare against it
	_libraryIndex: new Map(),
	_saving: null,

	log(msg) {
		Zotero.debug(`Citation Graph: ${msg}`);
	},

	pref(name, fallback) {
		let value = Zotero.Prefs.get(`citationgraph.${name}`);
		return value === undefined || value === null || value === "" ? fallback : value;
	},

	// ------------------------------------------------------------------ cache
	get dir() {
		return PathUtils.join(Zotero.DataDirectory.dir, "citation-graph");
	},

	get path() {
		return PathUtils.join(this.dir, "cache.json");
	},

	async load() {
		if (this._cache) return this._cache;
		try {
			if (await IOUtils.exists(this.path)) {
				let cache = await IOUtils.readJSON(this.path);
				if (cache && cache.version === this.CACHE_VERSION && cache.items) {
					this._cache = cache;
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		if (!this._cache) {
			this._cache = { version: this.CACHE_VERSION, items: {} };
		}
		this._stamp++;
		return this._cache;
	},

	async save() {
		// Serialise concurrent saves so a slow disk never interleaves two writes
		this._saving = (this._saving || Promise.resolve()).then(async () => {
			await IOUtils.makeDirectory(this.dir, { ignoreExisting: true });
			await IOUtils.writeJSON(this.path, this._cache);
		}).catch(e => Zotero.logError(e));
		return this._saving;
	},

	async clear() {
		this._cache = { version: this.CACHE_VERSION, items: {} };
		this._stamp++;
		this._libraryIndex.clear();
		await this.save();
	},

	get size() {
		return this._cache ? Object.keys(this._cache.items).length : 0;
	},

	idOf(item) {
		return `${item.libraryID}/${item.key}`;
	},

	entry(item) {
		return (this._cache && this._cache.items[this.idOf(item)]) || null;
	},

	isResolved(item) {
		let e = this.entry(item);
		return !!(e && (e.openalex || e.s2));
	},

	/** Items of a library that have a cache entry (resolved or attempted). */
	cachedItems(libraryID) {
		let items = [];
		if (!this._cache) return items;
		for (let id of Object.keys(this._cache.items)) {
			let [lib, key] = id.split("/");
			if (parseInt(lib) !== libraryID) continue;
			let item = Zotero.Items.getByLibraryAndKey(libraryID, key);
			if (item && !item.deleted && item.isRegularItem()) items.push(item);
		}
		return items;
	},

	// ------------------------------------------------------------------ item metadata
	normTitle(t) {
		return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	},

	normDOI(doi) {
		return (doi || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
	},

	meta(item) {
		let doi = "";
		try {
			doi = item.getField("DOI") || "";
		}
		catch (e) {
			doi = "";
		}
		if (!doi) {
			let m = (item.getField("extra") || "").match(/^\s*DOI:\s*(\S+)/im);
			if (m) doi = m[1];
		}
		let year = null;
		try {
			let date = Zotero.Date.strToDate(item.getField("date"));
			if (date && date.year) year = parseInt(date.year);
		}
		catch (e) {
			year = null;
		}
		return { title: item.getField("title") || "", doi: this.normDOI(doi), year };
	},

	// ------------------------------------------------------------------ HTTP
	// Waits before retrying a 429. With successCodes: false Zotero.HTTP never throws, so its own
	// errorDelayIntervals retry never runs; rate limits have to be retried here.
	RETRY_DELAYS: [2000, 5000, 15000, 30000],

	async getJSON(url, options = {}) {
		let headers = Object.assign({ Accept: "application/json" }, options.headers || {});
		let xhr;
		for (let attempt = 0; ; attempt++) {
			xhr = await Zotero.HTTP.request(options.method || "GET", url, {
				headers,
				body: options.body,
				responseType: "json",
				timeout: 60000,
				successCodes: false,
				errorDelayIntervals: [2000, 5000, 15000],
				errorDelayMax: 90000
			});
			if (xhr.status !== 429 || attempt >= this.RETRY_DELAYS.length) break;
			let retryAfter = parseInt(xhr.getResponseHeader("Retry-After")) * 1000;
			let delay = retryAfter > 0 ? retryAfter : this.RETRY_DELAYS[attempt];
			this.log(`HTTP 429 for ${url}, retrying in ${delay} ms`);
			await this.sleep(delay);
		}
		if (xhr.status === 404) return null;
		if (xhr.status < 200 || xhr.status >= 300) {
			throw new Error(`HTTP ${xhr.status} for ${url}`);
		}
		return xhr.response;
	},

	sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	},

	oaURL(path, params) {
		let url = new URL(this.OPENALEX + path);
		for (let [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		let mailto = this.pref("openalexMailto", "");
		if (mailto) url.searchParams.set("mailto", mailto);
		return url.href;
	},

	s2Headers() {
		let key = this.pref("s2ApiKey", "");
		return key ? { "x-api-key": key } : {};
	},

	// Semantic Scholar allows 1 request per second, with or without an API key (the key only
	// moves the requests off the pool shared by all anonymous users).
	get s2Pause() {
		return 1100;
	},

	// ------------------------------------------------------------------ OpenAlex
	_oaWork(w) {
		let abstract = null;
		let inv = w.abstract_inverted_index;
		if (inv) {
			let pos = [];
			for (let [word, positions] of Object.entries(inv)) {
				for (let p of positions) pos[p] = word;
			}
			abstract = pos.filter(Boolean).join(" ");
		}
		return {
			id: w.id,
			ids: [w.id],
			doi: this.normDOI(w.doi),
			title: w.title || w.display_name || "",
			year: w.publication_year || null,
			cited_by_count: w.cited_by_count || 0,
			referenced_works: w.referenced_works || [],
			abstract,
			venue: (((w.primary_location || {}).source) || {}).display_name || null,
			authors: (w.authorships || []).map(a => (a.author || {}).display_name).filter(Boolean)
		};
	},

	/** Resolve a set of items in OpenAlex: batched DOI lookup, then one title search per item
	 *  (fallback for items without DOI and source of alias IDs for the arXiv/venue duplicates). */
	async resolveOpenAlex(items, metas, report) {
		let works = new Map();   // itemID -> work
		let withDOI = items.filter(it => metas.get(it.id).doi);
		for (let i = 0; i < withDOI.length; i += this.OA_BATCH) {
			let chunk = withDOI.slice(i, i + this.OA_BATCH);
			let filter = "doi:" + chunk.map(it => metas.get(it.id).doi).join("|");
			let byDOI = new Map();
			try {
				let res = await this.getJSON(this.oaURL("/works", { filter, "per-page": 50, select: this.OA_SELECT }));
				for (let w of (res && res.results) || []) {
					let work = this._oaWork(w);
					if (work.doi) byDOI.set(work.doi, work);
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
			for (let it of chunk) {
				let w = byDOI.get(metas.get(it.id).doi);
				if (w) works.set(it.id, w);
			}
			report(`OpenAlex: ${Math.min(i + this.OA_BATCH, withDOI.length)} of ${withDOI.length} DOIs looked up`);
			await this.sleep(150);
		}
		let n = 0;
		for (let it of items) {
			n++;
			let meta = metas.get(it.id);
			if (!meta.title) continue;
			let query = meta.title.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);
			if (!query) continue;
			try {
				let res = await this.getJSON(this.oaURL("/works", { search: query, "per-page": 12, select: this.OA_SELECT }));
				let nt = this.normTitle(meta.title);
				let matches = [];
				for (let w of (res && res.results) || []) {
					let ct = this.normTitle(w.title || w.display_name);
					if (!ct) continue;
					let sameTitle = ct === nt || (nt.length >= 25 && ct.slice(0, 50) === nt.slice(0, 50));
					let yearOK = !meta.year || !w.publication_year || Math.abs(w.publication_year - meta.year) <= 2;
					if (sameTitle && yearOK) matches.push(this._oaWork(w));
				}
				let work = works.get(it.id);
				if (!work && matches.length) {
					work = matches[0];
					works.set(it.id, work);
				}
				if (work) {
					for (let m of matches) {
						if (!work.ids.includes(m.id)) work.ids.push(m.id);
						if (!work.referenced_works.length && m.referenced_works.length) work.referenced_works = m.referenced_works;
						if (!work.abstract && m.abstract) work.abstract = m.abstract;
					}
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
			report(`OpenAlex: ${n} of ${items.length} titles searched`);
			await this.sleep(150);
		}
		return works;
	},

	// ------------------------------------------------------------------ Semantic Scholar
	_s2Paper(p) {
		return {
			id: p.paperId,
			title: p.title || "",
			year: p.year || null,
			citationCount: p.citationCount || 0,
			externalIds: p.externalIds || {},
			references: (p.references || []).filter(r => r && r.paperId).map(r => ({
				paperId: r.paperId,
				title: r.title || "",
				year: r.year || null,
				doi: this.normDOI(((r.externalIds || {}).DOI) || ""),
				arxiv: ((r.externalIds || {}).ArXiv) || null
			}))
		};
	},

	async s2Batch(ids) {
		let out = new Map();
		for (let i = 0; i < ids.length; i += this.S2_BATCH) {
			let chunk = ids.slice(i, i + this.S2_BATCH);
			try {
				let res = await this.getJSON(`${this.S2}/paper/batch?fields=${encodeURIComponent(this.S2_FIELDS)}`, {
					method: "POST",
					headers: Object.assign({ "Content-Type": "application/json" }, this.s2Headers()),
					body: JSON.stringify({ ids: chunk })
				});
				(res || []).forEach((p, j) => {
					if (p && p.paperId) out.set(chunk[j], this._s2Paper(p));
				});
			}
			catch (e) {
				Zotero.logError(e);
			}
			await this.sleep(this.s2Pause);
		}
		return out;
	},

	async resolveSemanticScholar(items, metas, report) {
		let papers = new Map();   // itemID -> paper
		let withDOI = items.filter(it => metas.get(it.id).doi);
		if (withDOI.length) {
			report(`Semantic Scholar: looking up ${withDOI.length} DOIs`);
			let found = await this.s2Batch(withDOI.map(it => "DOI:" + metas.get(it.id).doi));
			for (let it of withDOI) {
				let p = found.get("DOI:" + metas.get(it.id).doi);
				if (p) papers.set(it.id, p);
			}
		}
		let missing = items.filter(it => !papers.has(it.id) && metas.get(it.id).title);
		let foundByTitle = [];
		let n = 0;
		for (let it of missing) {
			n++;
			let meta = metas.get(it.id);
			let query = meta.title.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 150);
			try {
				let res = await this.getJSON(`${this.S2}/paper/search?query=${encodeURIComponent(query)}&fields=paperId,title,year&limit=5`, { headers: this.s2Headers() });
				let nt = this.normTitle(meta.title);
				let hit = ((res && res.data) || []).find((p) => {
					let ct = this.normTitle(p.title);
					let sameTitle = ct === nt || (nt.length >= 25 && ct.slice(0, 50) === nt.slice(0, 50));
					return sameTitle && (!meta.year || !p.year || Math.abs(p.year - meta.year) <= 2);
				});
				if (hit) foundByTitle.push([it, hit.paperId]);
			}
			catch (e) {
				Zotero.logError(e);
			}
			report(`Semantic Scholar: ${n} of ${missing.length} titles searched`);
			await this.sleep(this.s2Pause);
		}
		if (foundByTitle.length) {
			let found = await this.s2Batch(foundByTitle.map(([, id]) => id));
			for (let [it, id] of foundByTitle) {
				let p = found.get(id);
				if (p) papers.set(it.id, p);
			}
		}
		return papers;
	},

	// ------------------------------------------------------------------ driver
	/**
	 * Resolve items against the two APIs and store the results.
	 * @param {Zotero.Item[]} items
	 * @param {Object} [options]
	 * @param {boolean} [options.force] - re-fetch items that are already resolved
	 * @param {Function} [options.progress] - progress(fraction 0..1, text)
	 * @returns {Promise<{ attempted: number, resolved: number }>}
	 */
	async resolveItems(items, { force = false, progress = null } = {}) {
		await this.load();
		let todo = items.filter(it => it.isRegularItem() && !it.deleted && (force || !this.isResolved(it)));
		if (!todo.length) return { attempted: 0, resolved: 0 };
		let metas = new Map(todo.map(it => [it.id, this.meta(it)]));
		let stage = 0;
		let stages = this.pref("useSemanticScholar", true) ? 2 : 1;
		let report = (text) => {
			if (progress) progress(Math.min(0.95, (stage + 0.5) / stages), text);
		};

		let works = await this.resolveOpenAlex(todo, metas, report);
		stage = 1;
		let papers = new Map();
		if (stages === 2) {
			papers = await this.resolveSemanticScholar(todo, metas, report);
		}

		let resolved = 0;
		for (let it of todo) {
			let meta = metas.get(it.id);
			let entry = {
				title: meta.title,
				doi: meta.doi,
				year: meta.year,
				openalex: works.get(it.id) || null,
				s2: papers.get(it.id) || null,
				updated: new Date().toISOString()
			};
			if (entry.openalex || entry.s2) resolved++;
			this._cache.items[this.idOf(it)] = entry;
		}
		this._stamp++;
		this._libraryIndex.clear();
		await this.save();
		if (progress) progress(1, `${resolved} of ${todo.length} items found`);
		return { attempted: todo.length, resolved };
	},

	// ------------------------------------------------------------------ edges
	/**
	 * Citation edges between the given items: { source: citedItemID, target: citingItemID, via: [...] }.
	 * A reference is matched by OpenAlex ID (including the duplicates collected as aliases),
	 * Semantic Scholar ID, DOI, or normalised title.
	 */
	buildEdges(items) {
		let oa = new Map(), s2 = new Map(), dois = new Map(), titles = new Map();
		let metas = new Map();
		for (let it of items) {
			let meta = this.meta(it);
			metas.set(it.id, meta);
			let e = this.entry(it);
			if (meta.doi) dois.set(meta.doi, it.id);
			if (e && e.openalex) {
				for (let a of e.openalex.ids || [e.openalex.id]) oa.set(a, it.id);
				if (e.openalex.doi) dois.set(e.openalex.doi, it.id);
			}
			if (e && e.s2) {
				s2.set(e.s2.id, it.id);
				let d = this.normDOI((e.s2.externalIds || {}).DOI || "");
				if (d) dois.set(d, it.id);
			}
			let t = this.normTitle(meta.title);
			if (t.length >= 20) titles.set(t, it.id);
		}
		let edges = new Map();
		let add = (citing, cited, via) => {
			if (citing === cited) return;
			let k = `${cited}>${citing}`;
			if (!edges.has(k)) edges.set(k, { source: cited, target: citing, via: new Set() });
			edges.get(k).via.add(via);
		};
		for (let it of items) {
			let e = this.entry(it);
			if (!e) continue;
			for (let r of (e.openalex && e.openalex.referenced_works) || []) {
				let t = oa.get(r);
				if (t) add(it.id, t, "openalex");
			}
			for (let r of (e.s2 && e.s2.references) || []) {
				let t = s2.get(r.paperId) || (r.doi && dois.get(this.normDOI(r.doi))) || titles.get(this.normTitle(r.title));
				if (t) add(it.id, t, "semanticscholar");
			}
		}
		if (this.pref("includeRelated", true)) {
			// Zotero's own "Related" links, directed from the older to the newer item
			let ids = new Map(items.map(it => [it.key, it]));
			for (let it of items) {
				let related = [];
				try {
					related = it.relatedItems || [];
				}
				catch (e) {
					related = [];                             // relations not loaded for this item
				}
				for (let key of related) {
					let other = ids.get(key);
					if (!other) continue;
					let ya = metas.get(it.id).year || 0, yb = metas.get(other.id).year || 0;
					if (ya < yb || (ya === yb && it.id < other.id)) add(other.id, it.id, "related");
					else add(it.id, other.id, "related");
				}
			}
		}
		return [...edges.values()].map(e => ({ source: e.source, target: e.target, via: [...e.via].sort() }));
	},

	/** Edges among all cached items of a library, memoised until the cache changes. */
	libraryEdges(libraryID) {
		let idx = this._libraryIndex.get(libraryID);
		if (idx && idx.stamp === this._stamp) return idx;
		let items = this.cachedItems(libraryID);
		idx = { stamp: this._stamp, items, edges: this.buildEdges(items) };
		this._libraryIndex.set(libraryID, idx);
		return idx;
	}
};
