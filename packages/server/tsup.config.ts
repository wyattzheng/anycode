import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        cli: "bin/cli.ts",
    },
    format: ["esm"],
    platform: "node",
    dts: true,
    clean: true,
    skipNodeModulesBundle: true,
    external: ["sql.js", "@lydell/node-pty"],
});
