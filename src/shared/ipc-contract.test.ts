import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
    CreateDownloadPayload,
    DownloadItem,
    TitleBarOverlaySyncOptions,
} from "@shared/types";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import type { IpcHandlers } from "./ipc-contract";

import { generateIpc, type IpcGeneratorOptions } from "../../plugins/ipc-generator";

const temporaryDirectories: string[] = [];

function createTempDir() {
    const directory = mkdtempSync(join(tmpdir(), "ipc-generator-"));
    temporaryDirectories.push(directory);
    return directory;
}

function createProjectOptions(directory: string): IpcGeneratorOptions {
    return {
        handlerDir: resolve("src/main/ipc/handlers"),
        contractFile: resolve("src/shared/ipc-contract.ts"),
        sharedTypesFile: resolve("src/shared/types.ts"),
        typesFile: join(directory, "types.gen.ts"),
        runtimeFile: join(directory, "ipc-keys.gen.ts"),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("generateIpc", () => {
    test("bootstraps precise generated files from the tracked contract", () => {
        const directory = createTempDir();
        const options = createProjectOptions(directory);

        expect(() => statSync(options.typesFile)).toThrow();
        expect(() => statSync(options.runtimeFile)).toThrow();

        generateIpc(options);

        const types = readFileSync(options.typesFile, "utf8");
        const contract = readFileSync(options.contractFile, "utf8");
        const runtime = readFileSync(options.runtimeFile, "utf8");
        const handlerSection = runtime.match(/IPC_HANDLER_CHANNELS = \[([\s\S]*?)\] as const;/);

        expect(types).toContain('export type { IpcHandlers } from "./ipc-contract";');
        expect(types).not.toMatch(/\bany\b/);
        expect(contract).not.toMatch(/\bany\b/);
        expect(handlerSection).not.toBeNull();
        expect(handlerSection?.[1].match(/^\s+"/gm)).toHaveLength(50);
    });

    test("reports every missing and extra handler channel", () => {
        const directory = createTempDir();
        const handlerDir = join(directory, "handlers");
        mkdirSync(handlerDir);
        writeFileSync(
            join(handlerDir, "fixture.ts"),
            'rh("alpha:run", () => undefined);\nrh("extra:run", () => undefined);\n',
        );
        writeFileSync(
            join(directory, "ipc-contract.ts"),
            'export type IpcHandlers = {\n    "alpha:run": () => void;\n    "missing:run": () => void;\n};\n',
        );
        writeFileSync(
            join(directory, "types.ts"),
            'export type IpcEvents = {\n    "fixture:event": () => void;\n};\n',
        );

        expect(() =>
            generateIpc({
                handlerDir,
                contractFile: join(directory, "ipc-contract.ts"),
                sharedTypesFile: join(directory, "types.ts"),
                typesFile: join(directory, "types.gen.ts"),
                runtimeFile: join(directory, "ipc-keys.gen.ts"),
            }),
        ).toThrowError(
            "[IPC Gen] Handler/contract channel mismatch.\nMissing handler channels: missing:run\nExtra handler channels: extra:run",
        );
    });

    test("does not rewrite byte-identical output on a stable rerun", () => {
        const directory = createTempDir();
        const options = createProjectOptions(directory);
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

        generateIpc(options);
        const firstTypes = readFileSync(options.typesFile);
        const firstRuntime = readFileSync(options.runtimeFile);
        expect(log).toHaveBeenCalledTimes(2);

        log.mockClear();
        generateIpc(options);

        expect(readFileSync(options.typesFile)).toEqual(firstTypes);
        expect(readFileSync(options.runtimeFile)).toEqual(firstRuntime);
        expect(log).not.toHaveBeenCalled();
    });
});

describe("IpcHandlers", () => {
    test("preserves representative request and response types", () => {
        expectTypeOf<Parameters<IpcHandlers["download:create"]>>().toEqualTypeOf<
            [CreateDownloadPayload]
        >();
        expectTypeOf<
            Awaited<ReturnType<IpcHandlers["download:create"]>>
        >().toEqualTypeOf<DownloadItem | null>();
        expectTypeOf<Parameters<IpcHandlers["window:syncTitleBarOverlay"]>>().toEqualTypeOf<
            [TitleBarOverlaySyncOptions]
        >();
        expectTypeOf<Awaited<ReturnType<IpcHandlers["updater:getStatus"]>>>().toHaveProperty(
            "releaseVersion",
        );
    });
});
