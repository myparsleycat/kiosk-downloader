import { resolve } from "node:path";

import { crx } from "@crxjs/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import manifest from "./manifest.config.ts";

export default defineConfig({
    resolve: {
        alias: {
            "@ext": resolve(import.meta.dirname, "src"),
            "@renderer": resolve(import.meta.dirname, "../src/renderer/src"),
            "@shared": resolve(import.meta.dirname, "../src/shared"),
        },
        // UI components are imported from the app's source tree; keep a single React instance.
        dedupe: ["react", "react-dom"],
    },
    plugins: [
        react(),
        babel({ presets: [reactCompilerPreset()] } as Parameters<typeof babel>[0]),
        tailwindcss(),
        crx({ manifest }),
    ],
    build: {
        rollupOptions: {
            // crxjs copies HTML listed only in web_accessible_resources verbatim, without bundling it.
            input: { popover: resolve(import.meta.dirname, "src/popover/index.html") },
        },
    },
    server: {
        cors: { origin: [/chrome-extension:\/\//] },
    },
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
    },
});
