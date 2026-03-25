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
    onSuccess: "cp src/codex-mcp-bridge.cjs dist/codex-mcp-bridge.cjs",
});
