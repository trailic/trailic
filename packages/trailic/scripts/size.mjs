// What a page really carries for the component: bundled, minified and gzipped, with React left to the page.
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const measure = async (entry) => {
  const { outputFiles } = await build({ entryPoints: [entry], bundle: true, minify: true, format: "esm", write: false, external: ["react", "react/jsx-runtime"], target: "es2019" });
  const code = outputFiles[0].contents;
  return { bytes: code.length, gzipped: gzipSync(code).length };
};

console.log("trailic", await measure("src/index.ts"));
console.log("trailic/vitals", await measure("src/vitals.tsx"));
console.log("trailic/opt-out", await measure("src/opt-out.tsx"));
