import path from "node:path";
import type { Readable } from "node:stream";

import { normalizePath } from "@shared/utils";
import fg from "fast-glob";
import type { Entry } from "fast-glob";
import originalFs from "original-fs";

import type { UploadSourceFile } from "./types";

const IGNORED_FOLDER_SCAN_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function isIgnoredFolderScanFile(fileName: string) {
    return IGNORED_FOLDER_SCAN_BASENAMES.has(fileName.toLowerCase());
}

export async function collectUploadSources(
    inputs: string[],
    maxFiles: number,
): Promise<{ sources: UploadSourceFile[]; truncated: boolean }> {
    const out: UploadSourceFile[] = [];
    const seen = new Set<string>();
    let truncated = false;

    for (const input of inputs) {
        if (out.length >= maxFiles) {
            truncated = true;
            break;
        }

        // Electron's patched fs reports a valid `*.asar` as a directory and walks into it,
        // and fails on an invalid one, so user files named that way need the unpatched fs.
        const stat = await originalFs.promises.stat(input);
        if (stat.isFile()) {
            const treePath = path.basename(input);
            assertUniqueTreePath(seen, treePath);
            out.push({
                path: treePath,
                name: treePath,
                size: stat.size,
                fsPath: input,
                sourceMtimeMs: Math.trunc(stat.mtimeMs),
            });
            continue;
        }

        const rootName = path.basename(input);
        const stream = fg.stream("**/*", {
            cwd: input,
            onlyFiles: true,
            dot: true,
            absolute: true,
            stats: true,
            followSymbolicLinks: false,
            fs: originalFs,
        }) as Readable;

        try {
            for await (const raw of stream) {
                if (out.length >= maxFiles) {
                    truncated = true;
                    break;
                }
                const entry = raw as Entry;
                const name = path.basename(entry.path);
                if (isIgnoredFolderScanFile(name)) continue;
                const relative = path.relative(input, entry.path);
                const treePath = normalizePath(`${rootName}/${relative}`);
                assertUniqueTreePath(seen, treePath);
                out.push({
                    path: treePath,
                    name,
                    size: entry.stats?.size ?? 0,
                    fsPath: entry.path,
                    sourceMtimeMs: Math.trunc(entry.stats?.mtimeMs ?? 0),
                });
            }
        } finally {
            stream.destroy();
        }
    }

    return { sources: out, truncated };
}

function assertUniqueTreePath(seen: Set<string>, treePath: string) {
    if (seen.has(treePath)) {
        throw new Error(`같은 업로드 경로에 두 파일을 추가할 수 없습니다: ${treePath}`);
    }
    seen.add(treePath);
}
