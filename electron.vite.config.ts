import { resolve } from "node:path";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

import { ipcGeneratorPlugin } from "./plugins/ipc-generator";

export default defineConfig({
    main: {
        // build: {
        //     externalizeDeps: {
        //         exclude: [],
        //     },
        // },
        resolve: {
            alias: {
                "@native": resolve("native"),
                "@shared": resolve("src/shared"),
                "@main": resolve("src/main"),
                "@preload": resolve("src/preload"),
                "@": resolve("src"),
                "@backend": resolve("../backend/src"),
            },
        },
        plugins: [ipcGeneratorPlugin()],
    },
    preload: {
        build: {
            rollupOptions: {
                external: ["electron"],
            },
        },
        resolve: {
            alias: {
                "@shared": resolve("src/shared"),
                "@main": resolve("src/main"),
                "@preload": resolve("src/preload"),
                "@": resolve("src"),
            },
        },
    },
    renderer: {
        resolve: {
            alias: {
                "@renderer": resolve("src/renderer/src"),
                "@shared": resolve("src/shared"),
                "@": resolve("src"),
            },
        },
        plugins: [
            react(),
            babel({ presets: [reactCompilerPreset()] } as Parameters<typeof babel>[0]),
            tailwindcss(),
        ],
    },
});
