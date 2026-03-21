import { defineConfig } from "tsup"

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    splitting: true,
    clean: true,
    dts: true,
    // Skip bundling npm dependencies — they're available in node_modules
    // at runtime. Bundling them causes CJS-only packages (e.g. @vercel/oidc,
    // pulled in transitively by ai → @ai-sdk/gateway) to be wrapped in
    // require() shims that break in ESM output.
    skipNodeModulesBundle: true,
})
