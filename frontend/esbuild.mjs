import { build, context } from "esbuild";

const options = {
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
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild watching for changes...");
} else {
  await build(options);
}
