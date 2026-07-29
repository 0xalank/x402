import { defineConfig } from "tsup";

const base = {
  entry: {
    index: "src/index.ts",
    "client/index": "src/client/index.ts",
    "server/index": "src/server/index.ts",
    "facilitator/index": "src/facilitator/index.ts",
  },
  dts: { resolve: true },
  sourcemap: true,
  target: "es2020",
};

export default defineConfig([
  { ...base, format: "esm", outDir: "dist/esm", clean: true },
  { ...base, format: "cjs", outDir: "dist/cjs", clean: true },
]);
