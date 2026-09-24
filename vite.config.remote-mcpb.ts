import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    outDir: "remote-mcpb-dist",
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: { index: path.resolve(__dirname, "src/remoteMcpb.ts") },
      formats: ["es"],
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { entryFileNames: "[name].js" },
    },
    target: "node22",
    ssr: true,
  },
});
