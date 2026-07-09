import path from "node:path";

import type { CreateUploadPayload, UploadTreeFile } from "@shared/types";
import { normalizePath } from "@shared/utils";
import fse from "fs-extra";

import type { KioskDownloader } from "../..";

import { rh } from "../helper";

async function expandPaths(inputs: string[]): Promise<UploadTreeFile[]> {
    const out: UploadTreeFile[] = [];

    for (const input of inputs) {
        const stat = await fse.stat(input);
        if (stat.isFile()) {
            out.push({
                path: path.basename(input),
                name: path.basename(input),
                size: stat.size,
                fsPath: input,
            });
            continue;
        }

        const rootName = path.basename(input);
        await walkDir(input, rootName, out);
    }

    return out;
}

async function walkDir(dirPath: string, treePrefix: string, out: UploadTreeFile[]) {
    const entries = await fse.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const treePath = normalizePath(`${treePrefix}/${entry.name}`);

        if (entry.isFile()) {
            const stat = await fse.stat(fullPath);
            out.push({ path: treePath, name: entry.name, size: stat.size, fsPath: fullPath });
        } else if (entry.isDirectory()) {
            await walkDir(fullPath, treePath, out);
        }
    }
}

export function registerUploadHandlers(kd: KioskDownloader) {
    rh("upload:solveTurnstile", () => kd.service.upload.solveTurnstile());
    rh("upload:create", (payload: CreateUploadPayload) => kd.service.upload.create(payload));
    rh("upload:list", () => kd.service.upload.list());
    rh("upload:pause", (collectionId: string) => kd.service.upload.pauseUpload(collectionId));
    rh("upload:resume", (collectionId: string, options?: { force?: boolean }) =>
        kd.service.upload.resumeUpload(collectionId, options ?? {}),
    );
    rh("upload:remove", (collectionId: string) => kd.service.upload.remove(collectionId));
    rh("upload:copyLink", (collectionId: string) => kd.service.upload.copyLink(collectionId));
    rh("upload:expandPaths", (paths: string[]) => expandPaths(paths));
}
