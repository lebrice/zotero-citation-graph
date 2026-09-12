# Architecture

Three parts, two of them privileged.

```
┌──────────────────────── Zotero (privileged) ────────────────────────┐
│ bootstrap.js  ──loadSubScript──▶ src/resolver.js, src/plugin.js      │
│                                                                      │
│ plugin.js   registers  Tools/context menus   (Zotero.MenuManager)    │
│                        "Citations" section   (Zotero.ItemPaneManager)│
│                        settings pane         (Zotero.PreferencePanes)│
│             opens      a tab of type "citationgraph" (Zotero_Tabs)   │
│             builds     graph JSON from Zotero items + resolver cache │
│                                                                      │
│ resolver.js OpenAlex / Semantic Scholar lookups (Zotero.HTTP)        │
│             cache.json in the data directory (IOUtils)               │
│             buildEdges(): references → arrows between items          │
└──────────────┬──────────────────────────────────────┬────────────────┘
               │ <browser> (tab)                       │ <browser> (item pane body)
      ┌────────▼────────┐                     ┌────────▼────────┐
      │ graph.html#full │                     │ graph.html#ego  │
      │ graph.js: Full  │                     │ graph.js: Ego   │
      └─────────────────┘                     └─────────────────┘
```

## The host API

The page never touches Zotero objects. It is served from `resource://citationgraph/` (registered in `bootstrap.js`) so it runs with an ordinary content principal, and it talks to the plugin by `postMessage` on its own window: the plugin listens there, answers `{cg:"call", id, method, args}` with `{cgReply:id, ok, result|error}`, and sends `{cg:"start"}` / `{cg:"refresh"}` when the page should (re)load. Graph data crosses as JSON strings:

| method | returns |
|---|---|
| `getGraph()` | graph JSON for the tab's scope, or the ego graph of the section's item |
| `fetch(force)` | resolves the scope's (or the item's) citations with a progress window, then the new graph |
| `fetchItem(id)` | resolves one item, then the new graph |
| `selectItem(id)` | selects the item in the library tab |
| `setStatus(id, status)` | replaces the item's status tag, then the new graph |
| `openFull()` | (ego only) opens the tab for the item's first collection |
| `openURL(url)` | opens a link in the system browser |
| `setHeight(px)` | (ego only) resizes the section's iframe |

## Graph JSON

```jsonc
{
  "mode": "full" | "ego",
  "name": "…", "scope": { "type": "collection" | "library" | "items", … },
  "groups":   [{ "name": "20 Tagging and Insertion", "color": "#2563a8" }],
  "statuses": ["adopted", "tested", "open", "background"],
  "nodes": [{ "id": "1234", "key": "ABCD1234", "title": "…", "authors": ["Last, First"], "first_author": "Last",
              "year": 2020, "venue": "…", "doi": "…", "abstract": "…", "notes": ["…"], "group": "…",
              "status": "adopted", "editable": true, "resolved": true,
              "citations": { "openalex": 404, "semanticscholar": 410 }, "refs_found": { "openalex": 23, "semanticscholar": 28 } }],
  "edges": [{ "source": "1234", "target": "5678", "via": ["openalex", "semanticscholar"] }],   // 5678 cites 1234
  "unresolved": 3,
  "focus": "1234"            // ego only
}
```

## Scopes and groups

A *scope* names the items of a graph: a collection (all descendants), a library (all top-level regular items) or a list of item IDs. Colours come from the immediate subcollections of the collection (items placed directly in it get the collection's own colour) and, for a library or a selection, from the top-level collections.

## Cache

`cache.json` maps `"<libraryID>/<itemKey>"` to the OpenAlex work (ID, alias IDs, DOI, year, citation count, `referenced_works`, abstract, venue, authors) and the Semantic Scholar paper (ID, external IDs, citation count, references with paperId/DOI/title/year). `buildEdges()` indexes the items of a graph by all of these identifiers and walks the reference lists. The per-library edge set used by the ego view is memoised until the cache changes.

## Session restore

Zotero persists open tabs and restores them at startup, but has no restore hook for plugin tab types; an unknown type would abort the restoration of the remaining tabs. The plugin therefore removes its tabs from the saved session state after Zotero initialises, registers a no-op restore hook in every main window, and closes its tabs on shutdown.
