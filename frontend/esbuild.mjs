import { build, context } from "esbuild";

const options = {
  entryPoints: ["frontend/src/app.js"],
  bundle: true,
  outdir: "public/dist",
  format: "esm",
  splitting: true,
  minify: process.argv.includes("--minify"),
  sourcemap: process.argv.includes("--watch"),
  target: "esnext",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild watching for changes...");
} else {
  await build(options);
}
