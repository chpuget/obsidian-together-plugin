import esbuild from "esbuild";
import builtins from "builtin-modules";
import process from "node:process";

const watching = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
  sourcemap: watching ? "inline" : false,
  treeShaking: true,
  outfile: "main.js",
});

if (watching) {
  await context.watch();
} else {
  await context.rebuild();
  process.exit(0);
}
