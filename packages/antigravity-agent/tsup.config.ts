import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
    },
    format: ["esm"],
    platform: "node",
    dts: true,
    clean: true,
    skipNodeModulesBundle: true,
    onSuccess: "cp src/schemas.json src/mcp-bridge.mjs dist/",
});
