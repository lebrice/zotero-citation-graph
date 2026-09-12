# Changelog

## 0.1.0 — 2026-09-12

- Citation graph of a collection, a subcollection, a whole library or a selection of items in a Zotero tab: force layout and year × group timeline, colour by subcollection, size by in-graph or global citations, status-tag rings, search, detail panel with abstract and notes.
- "Citations" section in the item pane: the selected paper with the library items it cites and the items citing it; click to navigate.
- Fetching from inside Zotero (Tools menu, collection and item context menus, section and page buttons): OpenAlex (batched DOI lookup + title search) and Semantic Scholar (batch endpoint), cached in the data directory.
- Developer self-test (`citationgraph.selfTest` pref) and `status.json` in the cache directory.
- Settings pane: Semantic Scholar on/off and API key, OpenAlex polite-pool e-mail, status tag prefix and values, related-item edges, section height, clear cache.
