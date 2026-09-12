#!/usr/bin/env node
/* Unit tests for the parts that do not need a running Zotero: the resolver's
 * metadata extraction, reference matching and edge building, run against a
 * minimal mock of the Zotero API. `node scripts/test.mjs`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- mock Zotero
class MockItem {
	constructor({ id, key, libraryID = 1, fields = {}, tags = [], related = [], creators = [], notes = [] }) {
		this.id = id; this.key = key; this.libraryID = libraryID; this.deleted = false;
		this._fields = fields; this._tags = tags; this.relatedItems = related; this._creators = creators; this._notes = notes;
		this.itemTypeID = 1;
	}
	isRegularItem() { return true; }
	isEditable() { return true; }
	getField(name) { return this._fields[name] || ""; }
	getTags() { return this._tags.map(t => ({ tag: t })); }
	getCreators() { return this._creators; }
	getNotes() { return this._notes; }
	getCollections() { return []; }
}
const items = new Map();
const Zotero = {
	debug() {},
	logError(e) { throw e; },
	Prefs: { get: () => undefined },
	DataDirectory: { dir: "/tmp" },
	Date: { strToDate: s => ({ year: (String(s).match(/\d{4}/) || [])[0] }) },
	Items: {
		get: id => (Array.isArray(id) ? id.map(i => items.get(i)) : items.get(id)),
		getByLibraryAndKey: (lib, key) => [...items.values()].find(i => i.libraryID === lib && i.key === key) || false
	},
	CreatorTypes: { getPrimaryIDForType: () => 1 }
};
const context = vm.createContext({ Zotero, IOUtils: {}, PathUtils: { join: (...p) => p.join("/") }, setTimeout, URL, console });
vm.runInContext(readFileSync(join(root, "src/resolver.js"), "utf8"), context, { filename: "resolver.js" });
const R = context.CitationGraphResolver;

// ---------------------------------------------------------------- fixtures
const gector = new MockItem({ id: 1, key: "AAAA0001", fields: { title: "GECToR – Grammatical Error Correction: Tag, Not Rewrite", DOI: "https://doi.org/10.18653/v1/2020.bea-1.16", date: "2020-07-10" } });
const pie = new MockItem({ id: 2, key: "AAAA0002", fields: { title: "Parallel Iterative Edit Models for Local Sequence Transduction", date: "2019", extra: "DOI: 10.18653/v1/D19-1435" } });
const laser = new MockItem({ id: 3, key: "AAAA0003", fields: { title: "Encode, Tag, Realize: High-Precision Text Editing", date: "2019" }, related: ["AAAA0001"] });
const lone = new MockItem({ id: 4, key: "AAAA0004", fields: { title: "An unrelated paper about something else entirely", date: "2021" } });
[gector, pie, laser, lone].forEach(i => items.set(i.id, i));

R._cache = { version: 1, items: {} };
R._cache.items["1/AAAA0001"] = {
	openalex: { id: "https://openalex.org/W1", ids: ["https://openalex.org/W1", "https://openalex.org/W1arxiv"], doi: "10.18653/v1/2020.bea-1.16", referenced_works: ["https://openalex.org/W2", "https://openalex.org/W999"] },
	s2: { id: "s2-gector", externalIds: { DOI: "10.18653/V1/2020.BEA-1.16" }, references: [{ paperId: "s2-other", title: "Encode, Tag, Realize: High-Precision Text Editing", doi: "", year: 2019 }] }
};
R._cache.items["1/AAAA0002"] = { openalex: { id: "https://openalex.org/W2", ids: ["https://openalex.org/W2"], doi: "10.18653/v1/d19-1435", referenced_works: [] }, s2: null };
R._cache.items["1/AAAA0003"] = { openalex: null, s2: { id: "s2-laser", externalIds: {}, references: [{ paperId: "x", title: "", doi: "10.18653/v1/D19-1435", year: 2019 }] } };

// ---------------------------------------------------------------- tests
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test("meta: DOI from field, prefix stripped and lower-cased", () => {
	assert.equal(R.meta(gector).doi, "10.18653/v1/2020.bea-1.16");
	assert.equal(R.meta(gector).year, 2020);
});
test("meta: DOI from Extra", () => {
	assert.equal(R.meta(pie).doi, "10.18653/v1/d19-1435");
});
test("isResolved", () => {
	assert.equal(R.isResolved(gector), true);
	assert.equal(R.isResolved(lone), false);
});
test("edges: OpenAlex ID, S2 title, S2 DOI and related links", () => {
	const edges = R.buildEdges([gector, pie, laser, lone]);
	const key = e => `${e.source}>${e.target}:${e.via.join("+")}`;
	const got = new Set(edges.map(key));
	// GECToR cites PIE (OpenAlex ID) and LaserTagger (S2 title); LaserTagger cites PIE (S2 DOI);
	// LaserTagger is "related" to GECToR -> older (2019) -> newer (2020)
	assert.ok(got.has("2>1:openalex"), "PIE -> GECToR via OpenAlex");
	assert.ok(got.has("3>1:related+semanticscholar"), "LaserTagger -> GECToR via S2 title + related");
	assert.ok(got.has("2>3:semanticscholar"), "PIE -> LaserTagger via S2 DOI");
	assert.equal(edges.filter(e => e.source === "4" || e.target === "4" || e.source === 4 || e.target === 4).length, 0, "the unrelated item has no edges");
	assert.equal(edges.length, 3);
});
test("edges: no self-citations, no edges to items outside the set", () => {
	const edges = R.buildEdges([gector]);
	assert.equal(edges.length, 0);
});
test("libraryEdges is memoised until the cache changes", () => {
	const a = R.libraryEdges(1);
	const b = R.libraryEdges(1);
	assert.equal(a, b);
	R._stamp++;
	assert.notEqual(R.libraryEdges(1), a);
});
test("OpenAlex abstract is rebuilt from the inverted index", () => {
	const w = R._oaWork({ id: "W", abstract_inverted_index: { the: [0, 3], cat: [1], sat: [2], mat: [4] }, referenced_works: [] });
	assert.equal(w.abstract, "the cat sat the mat");
});
console.log(`\n${n} tests passed`);
