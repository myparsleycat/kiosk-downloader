import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@shared": resolve("src/shared"),
            "@main": resolve("src/main"),
            // original-fs only exists in the Electron runtime.
            ...(process.versions.electron ? {} : { "original-fs": "node:fs" }),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
    },
});
