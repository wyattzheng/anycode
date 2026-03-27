import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
    },
    format: ["esm"],
    platform: "node",
    target: "es2022",
    dts: true,
    clean: false,
    skipNodeModulesBundle: true,
});
