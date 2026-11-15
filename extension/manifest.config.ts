import { defineManifest } from "@crxjs/vite-plugin";

import pkg from "./package.json" with { type: "json" };

export default defineManifest({
    manifest_version: 3,
    name: "kioex",
    description: "링크와 브라우저 다운로드를 Kiosk Downloader로 보냅니다.",
    version: pkg.version,
    icons: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        128: "icons/icon-128.png",
    },
    action: {
        default_popup: "src/popup/index.html",
        default_icon: {
            16: "icons/icon-16.png",
            32: "icons/icon-32.png",
        },
    },
    options_page: "src/options/index.html",
    background: {
        service_worker: "src/background/index.ts",
        type: "module",
    },
    content_scripts: [
        {
            matches: ["<all_urls>"],
            js: ["src/content/index.ts"],
            all_frames: true,
            run_at: "document_idle",
        },
    ],
    web_accessible_resources: [
        {
            resources: ["src/popover/index.html"],
            matches: ["<all_urls>"],
        },
    ],
    permissions: ["storage", "downloads", "cookies", "tabs", "webRequest"],
    host_permissions: ["<all_urls>"],
});
