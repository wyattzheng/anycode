import { defineConfig } from "vitest/config"
import path from "path"
import tsconfigPaths from "vite-tsconfig-paths"

const opencodeSrc = path.resolve(__dirname, "../opencode/src")

export default defineConfig({
    plugins: [
        tsconfigPaths({
            projects: [path.resolve(__dirname, "../opencode/tsconfig.json")],
        }),
    ],
    test: {
        testTimeout: 60_000,
        hookTimeout: 60_000,
        pool: "forks",
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
        include: ["tests/**/*.test.ts"],
        setupFiles: ["tests/setup.ts"],
        server: {
            deps: {
                // Externalize fastify and its deps that require Node >= 20
                // These are transitively pulled in by hono-openapi but not needed for agent tests
                external: [
                    "fastify",
                    /fastify/,
                ],
            },
        },
    },
    resolve: {
        alias: {
            // Resolve @any-code/opencode subpath imports
            "@any-code/opencode/plugin": path.join(opencodeSrc, "plugin/index.ts"),
            "@any-code/opencode/session/index": path.join(opencodeSrc, "session/index.ts"),
            "@any-code/opencode/session/message-v2": path.join(opencodeSrc, "session/message-v2.ts"),
            "@any-code/opencode/session/prompt": path.join(opencodeSrc, "session/prompt.ts"),
            "@any-code/opencode/bus/index": path.join(opencodeSrc, "bus/index.ts"),
            "@any-code/opencode/tool/registry": path.join(opencodeSrc, "tool/registry.ts"),
            "@any-code/opencode/tool/tool": path.join(opencodeSrc, "tool/tool.ts"),
            "@any-code/opencode/provider/provider": path.join(opencodeSrc, "provider/provider.ts"),
            "@any-code/opencode/storage/db": path.join(opencodeSrc, "storage/db.ts"),
            "@any-code/opencode/storage/schema": path.join(opencodeSrc, "storage/schema.ts"),
            "@any-code/opencode/project/project.sql": path.join(opencodeSrc, "project/project.sql.ts"),
            "@any-code/opencode/util/installation": path.join(opencodeSrc, "util/installation.ts"),
            "@any-code/opencode/util/flag": path.join(opencodeSrc, "util/flag.ts"),
            "@any-code/opencode/util/markdown": path.join(opencodeSrc, "util/markdown.ts"),
            // drizzle-orm/sql-js adapter — resolve from opencode's pnpm store
            "drizzle-orm/sql-js": path.resolve(__dirname, "../../node_modules/.pnpm/drizzle-orm@1.0.0-beta.16-ea816b6_@opentelemetry+api@1.9.0_@types+better-sqlite3@7.6.13_0f21266a0de314c39cfb891f27e2ae25/node_modules/drizzle-orm/sql-js/index.js"),
        },
    },
})
