// @vitest-environment node
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/** What a page carries for this library: measured, so it can't creep up unnoticed. */
const LARGEST_GZIPPED_BYTES = 1_700;

async function gzippedSize(entry: string): Promise<number> {
  const { outputFiles } = await build({ entryPoints: [entry], bundle: true, minify: true, format: "esm", write: false, external: ["react", "react/jsx-runtime"], target: "es2019" });
  return gzipSync(outputFiles[0].contents).length;
}

describe("the client bundle", () => {
  it(`stays under ${LARGEST_GZIPPED_BYTES} bytes gzipped`, async () => {
    expect(await gzippedSize("src/index.ts")).toBeLessThan(LARGEST_GZIPPED_BYTES);
  });

  it("carries no dependency beyond React", async () => {
    const { metafile } = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false, metafile: true, format: "esm", external: ["react", "react/jsx-runtime"] });
    const imported = Object.values(metafile.outputs).flatMap(({ imports }) => imports.map(({ path }) => path));
    expect(imported.filter((path) => !path.startsWith("react"))).toEqual([]);
  });
});
