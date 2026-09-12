/* Citation Graph — Zotero bootstrap entry point.
 *
 * Zotero loads this file into a privileged sandbox and calls the lifecycle
 * functions below. The real code lives in src/; it is loaded into the same
 * scope with loadSubScript so that the plugin object survives between calls.
 */

/* global Components, Services, Zotero, CitationGraph */

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
	// resource://citationgraph/… serves the pages. A resource: document gets an ordinary content
	// principal (a chrome: one would be system-privileged, where innerHTML is sanitised), so the
	// page behaves like a web page and talks to the plugin through postMessage.
	var resProto = Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsISubstitutingProtocolHandler);
	var contentURI = Services.io.newURI(rootURI + "content/");
	if (resProto.setSubstitutionWithFlags) {
		resProto.setSubstitutionWithFlags("citationgraph", contentURI, resProto.ALLOW_CONTENT_ACCESS);
	}
	else {
		resProto.setSubstitution("citationgraph", contentURI);
	}
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
	try {
		Services.io.getProtocolHandler("resource").QueryInterface(Components.interfaces.nsISubstitutingProtocolHandler).setSubstitution("citationgraph", null);
	}
	catch (e) {
		log("could not remove the resource substitution: " + e);
	}
}

function uninstall() {
	log("uninstalled");
}
