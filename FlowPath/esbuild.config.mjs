import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// styles.css is generated: every file in css/ concatenated in name order.
function buildCss() {
  const dir = "css";
  const parts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .sort()
    .map((f) => `/* ---- ${f} ---- */\n` + fs.readFileSync(path.join(dir, f), "utf8"));
  fs.writeFileSync("styles.css", parts.join("\n\n"));
}

const cssPlugin = {
  name: "css-concat",
  setup(build) {
    build.onEnd(() => buildCss());
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  plugins: [cssPlugin],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
