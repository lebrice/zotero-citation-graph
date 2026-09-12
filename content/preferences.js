/* Citation Graph — settings pane logic. Runs in Zotero's preferences window;
 * the plugin object is reachable as Zotero.CitationGraph. */

/* global Zotero, document */

var CitationGraphPrefs = {
	init() {
		this.updateCacheInfo();
	},

	updateCacheInfo() {
		let plugin = Zotero.CitationGraph;
		let label = document.getElementById("cg-cache-info");
		if (!plugin || !label) return;
		let resolver = plugin.resolver();
		label.value = `${resolver.size} item(s) in the cache · ${resolver.path}`;
	},

	async clearCache() {
		let plugin = Zotero.CitationGraph;
		if (!plugin) return;
		await plugin.clearCache();
		this.updateCacheInfo();
	}
};
