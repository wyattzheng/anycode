import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
    },
    format: ["esm"],
    platform: "node",
    dts: true,
    clean: false,
    skipNodeModulesBundle: true,
    external: ["sql.js", "@any-code/agent"],
});
