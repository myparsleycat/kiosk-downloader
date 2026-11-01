import fs from "node:fs";
import path from "node:path";

import fse from "fs-extra";
import originalFs from "original-fs";

/*
 * Electron patches `fs` so that any path with a `*.asar` segment is opened as an archive.
 * Downloaded files can legitimately be named that way (e.g. an Electron game's
 * `resources/app.asar`), and moving or checking them then fails with "Invalid package".
 * For such paths these helpers run the plain filesystem calls synchronously with
 * `process.noAsar` set, so the switch never leaks into other concurrent work.
 * Paths without an `.asar` segment keep the original fs-extra behaviour.
 */
const ASAR_SEGMENT = /\.asar(?:[\\/]|$)/i;

export function isAsarPath(filePath: string) {
    return ASAR_SEGMENT.test(filePath);
}

function withoutAsar<T>(fn: () => T): T {
    const previous = process.noAsar;
    process.noAsar = true;
    try {
        return fn();
    } finally {
        process.noAsar = previous;
    }
}

function hasErrorCode(error: unknown, code: string) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/** Moves a file onto `dest`, replacing it, creating parent directories as needed. */
export async function moveFileOverwrite(src: string, dest: string) {
    if (!isAsarPath(src) && !isAsarPath(dest)) {
        await fse.ensureDir(path.dirname(dest));
        await fse.move(src, dest, { overwrite: true });
        return;
    }
    withoutAsar(() => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
            fs.renameSync(src, dest);
        } catch (error) {
            if (!hasErrorCode(error, "EXDEV")) {
                throw error;
            }
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
        }
    });
}

/** Creates (or truncates) an empty file, creating parent directories as needed. */
export async function writeEmptyFile(filePath: string) {
    if (!isAsarPath(filePath)) {
        await fse.outputFile(filePath, "");
        return;
    }
    withoutAsar(() => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "");
    });
}

/** `stat` that returns null when the path cannot be read. */
export async function statOrNull(filePath: string): Promise<fs.Stats | null> {
    if (!isAsarPath(filePath)) {
        return fse.stat(filePath).catch(() => null);
    }
    return withoutAsar(() => {
        try {
            return fs.statSync(filePath);
        } catch {
            return null;
        }
    });
}

export async function pathExists(filePath: string) {
    return (await statOrNull(filePath)) !== null;
}

/**
 * Recursively removes a directory that may hold `*.asar` files. Patched fs walks into a valid
 * archive as if it were a directory, so removal would fail with ENOTEMPTY and leave it behind.
 */
export async function removeTree(dirPath: string) {
    await originalFs.promises.rm(dirPath, { recursive: true, force: true });
}
