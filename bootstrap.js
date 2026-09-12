/* Citation Graph — Zotero bootstrap entry point.
 *
 * Zotero loads this file into a privileged sandbox and calls the lifecycle
 * functions below. The real code lives in src/; it is loaded into the same
 * scope with loadSubScript so that the plugin object survives between calls.
 */

/* global Services, Zotero, CitationGraph */

var CitationGraph;
var CitationGraphResolver;

function log(msg) {
	Zotero.debug("Citation Graph: " + msg);
}

function install() {
	log("installed");
}

async function startup({ id, version, rootURI }) {
	log(`starting ${version}`);
	Services.scriptloader.loadSubScript(rootURI + "src/resolver.js");
	Services.scriptloader.loadSubScript(rootURI + "src/plugin.js");
	await CitationGraph.startup({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
	CitationGraph?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
	CitationGraph?.onMainWindowUnload(window);
}

function shutdown() {
	log("shutting down");
	CitationGraph?.shutdown();
	CitationGraph = undefined;
	CitationGraphResolver = undefined;
}

function uninstall() {
	log("uninstalled");
}
