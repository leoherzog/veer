import { build } from "esbuild";

await build({
  entryPoints: ["frontend/src/app.js"],
  bundle: true,
  outdir: "public/dist",
  format: "esm",
  splitting: true,
  minify: process.argv.includes("--minify"),
  sourcemap: true,
  target: "esnext",
  loader: {
    ".css": "css",
  },
});
