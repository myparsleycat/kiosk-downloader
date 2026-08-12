import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Electron Undici compatibility", () => {
    it("pins npm Undici to Electron's bundled version and preserves its dispatcher", async () => {
        const electron = path.resolve(
            process.platform === "win32"
                ? "node_modules/electron/dist/electron.exe"
                : "node_modules/.bin/electron",
        );
        const script = String.raw`
            (async () => {
                const legacy = Symbol.for("undici.globalDispatcher.1");
                const current = Symbol.for("undici.globalDispatcher.2");
                await globalThis.fetch("data:,");
                const beforeLegacy = globalThis[legacy];
                const beforeCurrent = globalThis[current];
                const undici = await import("undici");
                const socks = await import("fetch-socks");
                console.log(JSON.stringify({
                    bundledVersion: process.versions.undici,
                    packageVersion: require("undici/package.json").version,
                    legacyPreserved: beforeLegacy === globalThis[legacy],
                    currentPreserved: beforeCurrent === globalThis[current],
                    packageDidNotOwnDispatcher: !(beforeLegacy instanceof undici.Agent),
                    socksDispatcherAvailable: typeof socks.socksDispatcher === "function",
                }));
            })().catch((error) => {
                console.error(error);
                process.exitCode = 1;
            });
        `;

        const { stdout } = await execFileAsync(electron, ["-e", script], {
            cwd: process.cwd(),
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });

        expect(JSON.parse(stdout.trim())).toEqual({
            bundledVersion: "7.28.0",
            packageVersion: "7.28.0",
            legacyPreserved: true,
            currentPreserved: true,
            packageDidNotOwnDispatcher: true,
            socksDispatcherAvailable: true,
        });
    });
});
