import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        cli: "bin/cli.ts",
    },
    format: ["esm"],
    dts: true,
    clean: true,
    external: ["sql.js"],
});
