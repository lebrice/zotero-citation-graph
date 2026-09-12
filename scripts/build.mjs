#!/usr/bin/env node
/* Build the .xpi (a zip of the plugin files) and the updates.json that Zotero
 * polls for new versions. No dependencies beyond node and the `zip` CLI.
 *
 *   node scripts/build.mjs            -> build/citation-graph-<version>.xpi, build/updates.json
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const { version } = manifest;
const id = manifest.applications.zotero.id;
const repo = "julianschelb/zotero-citation-graph";

const INCLUDE = ["manifest.json", "bootstrap.js", "prefs.js", "locale", "content", "src", "LICENSE"];

const out = join(root, "build");
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });

const xpi = join(out, `citation-graph-${version}.xpi`);
execFileSync("zip", ["-r", "-X", "-q", xpi, ...INCLUDE, "-x", "*.DS_Store", "-x", "*/.DS_Store"], { cwd: root, stdio: "inherit" });
copyFileSync(xpi, join(out, "citation-graph.xpi"));

const updates = {
	addons: {
		[id]: {
			updates: [{
				version,
				update_link: `https://github.com/${repo}/releases/download/v${version}/citation-graph-${version}.xpi`,
				applications: { zotero: { strict_min_version: manifest.applications.zotero.strict_min_version } }
			}]
		}
	}
};
writeFileSync(join(out, "updates.json"), JSON.stringify(updates, null, "\t") + "\n");
writeFileSync(join(root, "updates.json"), JSON.stringify(updates, null, "\t") + "\n");

console.log(`built ${xpi}`);
