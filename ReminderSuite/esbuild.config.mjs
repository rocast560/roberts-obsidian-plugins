import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const production = process.argv.includes("production");

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
		...builtinModules.map((mod) => `node:${mod}`),
	],
	format: "cjs",
	target: "es2022",
	platform: "browser",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (production) {
	await context.rebuild();
	await context.dispose();
	process.exit(0);
} else {
	await context.watch();
}
