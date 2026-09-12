import js from "@eslint/js";
import globals from "globals";

export default [
	js.configs.recommended,
	{
		ignores: ["content/lib/**", "build/**", "dev/sample-host.js"]
	},
	{
		files: ["bootstrap.js", "src/**/*.js", "content/preferences.js"],
		languageOptions: {
			sourceType: "script",
			globals: {
				...globals.browser,
				Zotero: "readonly", Services: "readonly", IOUtils: "readonly", PathUtils: "readonly",
				ChromeUtils: "readonly", Components: "readonly",
				CitationGraph: "writable", CitationGraphResolver: "writable", CitationGraphPrefs: "writable"
			}
		},
		rules: { "no-unused-vars": ["warn", { args: "none" }], "no-empty": ["error", { allowEmptyCatch: true }] }
	},
	{
		files: ["content/graph.js"],
		languageOptions: { sourceType: "script", globals: { ...globals.browser, d3: "readonly" } }
	},
	{
		files: ["scripts/**/*.mjs", "eslint.config.js"],
		languageOptions: { sourceType: "module", globals: globals.node }
	}
];
