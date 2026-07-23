import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import fse from "fs-extra";

import type { KioskDownloader } from "../..";
import type { DownloadCollectionRow } from "./types";

type StoredExtendedManifest = {
    renames: Record<string, string>;
    selectedPaths?: string[];
    splitFiles: Array<{
        path: string;
        size: number;
        sha256?: string;
        pieces: Array<{
            sourceIndex: number;
            remoteFileId: string;
            offset: number;
            length: number;
            remoteOffset?: number;
        }>;
    }>;
};

type MultiPieceState = {
    path: string;
    size: number;
    sha256: string | undefined;
    pieces: Array<{
        sourceIndex: number;
        remoteFileId: string;
        offset: number;
        length: number;
        sourceOffset: number;
    }>;
    nextIndex: number;
    ready: Set<number>;
    hash: ReturnType<typeof createHash>;
    assembledBytes: number;
    partPath: string;
    finalPath: string;
    published: boolean;
};

type PackEntry = {
    splitPath: string;
    finalPath: string;
    sourceOffset: number;
    length: number;
    sha256: string | undefined;
    published: boolean;
};

type PackState = {
    remoteId: string;
    sourceIndex: number;
    filePath: string;
    entries: PackEntry[];
    published: boolean;
};

export type BundleReassemblyResult = {
    publishedPaths: string[];
};

/**
 * Incrementally processes bundle split files as each physical piece finishes
 * downloading, instead of waiting for the entire bundle to complete.
 *
 * Two modes:
 * - Multi-piece split files: appends pieces in offset order into a visible
 *   `.part` file at the final path, updates SHA-256 incrementally, and
 *   deletes each consumed piece file so peak disk usage stays near ~1x.
 * - Small-file-pack entries: when a pack file finishes downloading, every
 *   logical file packed inside it is immediately extracted to its final
 *   path, and the pack file is deleted.
 */
export class BundleReassemblyCoordinator {
    private readonly multiPieceFiles: Map<string, MultiPieceState> = new Map();
    private readonly packFiles: Map<string, PackState> = new Map();
    private readonly collectionIdToSourceIndex = new Map<string, number>();
    private readonly remoteIdToMultiPieces = new Map<
        string,
        Array<{ splitPath: string; pieceIndex: number }>
    >();
    private readonly remoteIdToPack = new Map<string, string>();
    private flushLock: Promise<unknown> = Promise.resolve();
    private tornDown = false;
    private readonly asciiFilenames: boolean;

    public constructor(
        private readonly kd: KioskDownloader,
        bundleId: string,
        private readonly savePath: string,
        manifest: StoredExtendedManifest,
        collections: DownloadCollectionRow[],
        private readonly resolvePieceFilePath: (piece: {
            sourceIndex: number;
            remoteFileId: string;
        }) => string | null,
    ) {
        this.asciiFilenames = collections[0]?.asciiFilenames === 1;

        for (const collection of collections) {
            this.collectionIdToSourceIndex.set(collection.id, collection.ordinal);
        }

        for (const splitFile of manifest.splitFiles) {
            if (manifest.selectedPaths && !manifest.selectedPaths.includes(splitFile.path)) {
                continue;
            }

            const pieces = splitFile.pieces.toSorted((left, right) => left.offset - right.offset);
            const safePath = this.kd.lib.fs.getSafeRelativePath(splitFile.path, {
                asciiFilenames: this.asciiFilenames,
            });
            const finalPath = path.join(savePath, safePath);

            if (pieces.length > 1) {
                this.registerMultiPiece(splitFile, pieces, safePath, finalPath, collections);
            } else {
                this.registerPackEntry(splitFile, pieces[0]!, finalPath, collections);
            }
        }
    }

    private registerMultiPiece(
        splitFile: StoredExtendedManifest["splitFiles"][number],
        pieces: Array<StoredExtendedManifest["splitFiles"][number]["pieces"][number]>,
        safePath: string,
        finalPath: string,
        collections: DownloadCollectionRow[],
    ): void {
        const allSourcesAvailable = pieces.every((piece) =>
            collections.some((c) => c.ordinal === piece.sourceIndex),
        );
        if (!allSourcesAvailable) return;

        const partPath = `${finalPath}.part`;
        const state: MultiPieceState = {
            path: splitFile.path,
            size: splitFile.size,
            sha256: splitFile.sha256,
            pieces: pieces.map((piece) => ({
                sourceIndex: piece.sourceIndex,
                remoteFileId: piece.remoteFileId,
                offset: piece.offset,
                length: piece.length,
                sourceOffset: piece.remoteOffset ?? 0,
            })),
            nextIndex: 0,
            ready: new Set<number>(),
            hash: createHash("sha256"),
            assembledBytes: 0,
            partPath,
            finalPath,
            published: false,
        };

        this.multiPieceFiles.set(splitFile.path, state);
        for (let index = 0; index < pieces.length; index += 1) {
            const remoteId = pieces[index]!.remoteFileId;
            const entries = this.remoteIdToMultiPieces.get(remoteId) ?? [];
            entries.push({ splitPath: splitFile.path, pieceIndex: index });
            this.remoteIdToMultiPieces.set(remoteId, entries);
        }
    }

    private registerPackEntry(
        splitFile: StoredExtendedManifest["splitFiles"][number],
        piece: StoredExtendedManifest["splitFiles"][number]["pieces"][number],
        finalPath: string,
        collections: DownloadCollectionRow[],
    ): void {
        const collection = collections.find((c) => c.ordinal === piece.sourceIndex);
        if (!collection) return;

        const filePath = this.resolvePieceFilePath({
            sourceIndex: piece.sourceIndex,
            remoteFileId: piece.remoteFileId,
        });
        if (!filePath) return;

        const packKey = `${piece.sourceIndex}:${piece.remoteFileId}`;
        let pack = this.packFiles.get(packKey);
        if (!pack) {
            pack = {
                remoteId: piece.remoteFileId,
                sourceIndex: piece.sourceIndex,
                filePath,
                entries: [],
                published: false,
            };
            this.packFiles.set(packKey, pack);
            this.remoteIdToPack.set(piece.remoteFileId, packKey);
        }

        pack.entries.push({
            splitPath: splitFile.path,
            finalPath,
            sourceOffset: piece.remoteOffset ?? 0,
            length: piece.length,
            sha256: splitFile.sha256,
            published: false,
        });
    }

    public hasManagedFiles() {
        return this.multiPieceFiles.size > 0 || this.packFiles.size > 0;
    }

    public getManagedSplitPaths(): Set<string> {
        const paths = new Set<string>(this.multiPieceFiles.keys());
        for (const pack of this.packFiles.values()) {
            for (const entry of pack.entries) {
                paths.add(entry.splitPath);
            }
        }
        return paths;
    }

    public isPieceManaged(collectionId: string, remoteId: string): boolean {
        const sourceIndex = this.collectionIdToSourceIndex.get(collectionId);
        if (sourceIndex === undefined) return false;

        const multiEntries = this.remoteIdToMultiPieces.get(remoteId);
        if (multiEntries) {
            return multiEntries.some((entry) => {
                const state = this.multiPieceFiles.get(entry.splitPath);
                return state && !state.published;
            });
        }

        const packKey = this.remoteIdToPack.get(remoteId);
        if (packKey) {
            const pack = this.packFiles.get(packKey);
            return pack !== undefined && !pack.published;
        }

        return false;
    }

    public onPieceFileSettled(
        collectionId: string,
        remoteId: string,
    ): Promise<BundleReassemblyResult> {
        const sourceIndex = this.collectionIdToSourceIndex.get(collectionId);
        if (sourceIndex === undefined) return Promise.resolve({ publishedPaths: [] });

        const multiEntries = this.remoteIdToMultiPieces.get(remoteId);
        if (multiEntries) {
            for (const entry of multiEntries) {
                const state = this.multiPieceFiles.get(entry.splitPath);
                if (!state || state.published) continue;
                state.ready.add(entry.pieceIndex);
            }
        }

        const packKey = this.remoteIdToPack.get(remoteId);
        if (packKey) {
            const pack = this.packFiles.get(packKey);
            if (pack && !pack.published) {
                pack.published = true;
            }
        }

        return this.runFlush();
    }

    private runFlush(): Promise<BundleReassemblyResult> {
        const run = async (): Promise<BundleReassemblyResult> => {
            if (this.tornDown) return { publishedPaths: [] };
            const published: string[] = [];

            for (const pack of this.packFiles.values()) {
                if (!pack.published) continue;
                for (const entry of pack.entries) {
                    if (entry.published) continue;
                    await this.extractPackEntry(pack, entry);
                    entry.published = true;
                    published.push(entry.finalPath);
                }
                await fse.remove(pack.filePath).catch(() => undefined);
            }

            for (const state of this.multiPieceFiles.values()) {
                if (state.published) continue;

                while (state.ready.has(state.nextIndex)) {
                    const piece = state.pieces[state.nextIndex]!;
                    const filePath = this.resolvePieceFilePath({
                        sourceIndex: piece.sourceIndex,
                        remoteFileId: piece.remoteFileId,
                    });
                    if (!filePath) break;

                    const sourceOffset = piece.sourceOffset;
                    const stat = await fse.stat(filePath).catch(() => null);
                    if (!stat || sourceOffset + piece.length > stat.size) {
                        throw new Error(
                            `재조립 조각 파일이 준비되지 않았습니다: ${state.path} #${state.nextIndex}`,
                        );
                    }

                    await fse.ensureDir(path.dirname(state.partPath));

                    if (piece.length === 0) {
                        if (state.nextIndex === 0) {
                            await fse.writeFile(state.partPath, "");
                        }
                    } else {
                        await pipeline(
                            createReadStream(filePath, {
                                start: sourceOffset,
                                end: sourceOffset + piece.length - 1,
                            }),
                            createWriteStream(state.partPath, {
                                flags: state.nextIndex === 0 ? "w" : "a",
                            }),
                        );

                        if (state.sha256) {
                            await updateHashFromRange(
                                state.hash,
                                state.partPath,
                                state.assembledBytes,
                                piece.length,
                            );
                        }
                    }

                    state.assembledBytes += piece.length;
                    state.ready.delete(state.nextIndex);
                    const consumedIndex = state.nextIndex;
                    state.nextIndex += 1;

                    await this.releasePieceFileIfConsumed(state, consumedIndex);
                }

                if (!state.published && state.nextIndex === state.pieces.length) {
                    if (state.assembledBytes !== state.size) {
                        throw new Error("재조립 파일 크기가 일치하지 않습니다.");
                    }
                    if (state.sha256) {
                        const digest = state.hash.digest("hex");
                        if (digest !== state.sha256) {
                            throw new Error("재조립 파일 해시가 일치하지 않습니다.");
                        }
                    }
                    await fse.ensureDir(path.dirname(state.finalPath));
                    await fse.move(state.partPath, state.finalPath, { overwrite: true });
                    state.published = true;
                    published.push(state.finalPath);
                }
            }

            return { publishedPaths: published };
        };

        const next = this.flushLock.then(run, run);
        this.flushLock = next.catch(() => undefined);
        return next;
    }

    private async extractPackEntry(pack: PackState, entry: PackEntry): Promise<void> {
        if (entry.length === 0) {
            if (entry.sha256) {
                const digest = createHash("sha256").update("").digest("hex");
                if (digest !== entry.sha256) {
                    throw new Error(`팩 추출 파일 해시가 일치하지 않습니다: ${entry.splitPath}`);
                }
            }
            await fse.ensureDir(path.dirname(entry.finalPath));
            await fse.outputFile(entry.finalPath, "");
            return;
        }

        const stat = await fse.stat(pack.filePath).catch(() => null);
        if (!stat || entry.sourceOffset + entry.length > stat.size) {
            throw new Error(`팩 파일이 준비되지 않았습니다: ${entry.splitPath}`);
        }

        const hash = entry.sha256 ? createHash("sha256") : null;
        const tempPath = `${entry.finalPath}.pack-extract.tmp`;
        await fse.ensureDir(path.dirname(entry.finalPath));
        await fse.remove(tempPath);
        try {
            await pipeline(
                createReadStream(pack.filePath, {
                    start: entry.sourceOffset,
                    end: entry.sourceOffset + entry.length - 1,
                }),
                new Transform({
                    transform(chunk, _encoding, callback) {
                        hash?.update(chunk as Buffer);
                        callback(null, chunk);
                    },
                }),
                createWriteStream(tempPath),
            );
            if (hash && hash.digest("hex") !== entry.sha256) {
                throw new Error(`팩 추출 파일 해시가 일치하지 않습니다: ${entry.splitPath}`);
            }
            const written = await fse.stat(tempPath);
            if (written.size !== entry.length) {
                throw new Error(`팩 추출 파일 크기가 일치하지 않습니다: ${entry.splitPath}`);
            }
            await fse.move(tempPath, entry.finalPath, { overwrite: true });
        } catch (error) {
            await fse.remove(tempPath).catch(() => undefined);
            throw error;
        }
    }

    private async releasePieceFileIfConsumed(
        state: MultiPieceState,
        consumedIndex: number,
    ): Promise<void> {
        const piece = state.pieces[consumedIndex]!;
        const remoteId = piece.remoteFileId;

        const allConsumed = this.isRemoteIdFullyConsumed(remoteId);
        if (!allConsumed) return;

        const filePath = this.resolvePieceFilePath({
            sourceIndex: piece.sourceIndex,
            remoteFileId: remoteId,
        });
        if (!filePath) return;
        await fse.remove(filePath).catch(() => undefined);
    }

    private isRemoteIdFullyConsumed(remoteId: string): boolean {
        const entries = this.remoteIdToMultiPieces.get(remoteId);
        if (!entries) return false;
        return entries.every((entry) => {
            const state = this.multiPieceFiles.get(entry.splitPath);
            if (!state) return true;
            if (state.published) return true;
            return entry.pieceIndex < state.nextIndex;
        });
    }

    public isComplete(): boolean {
        for (const state of this.multiPieceFiles.values()) {
            if (!state.published) return false;
        }
        for (const pack of this.packFiles.values()) {
            if (!pack.published) return false;
            for (const entry of pack.entries) {
                if (!entry.published) return false;
            }
        }
        return true;
    }

    public async whenIdle(): Promise<void> {
        await this.flushLock.catch(() => undefined);
    }

    public async teardown(): Promise<void> {
        this.tornDown = true;
        await this.flushLock.catch(() => undefined);
        for (const state of this.multiPieceFiles.values()) {
            if (!state.published) {
                await fse.remove(state.partPath).catch(() => undefined);
            }
        }
    }
}

async function updateHashFromRange(
    hash: ReturnType<typeof createHash>,
    filePath: string,
    start: number,
    length: number,
): Promise<void> {
    if (length === 0) return;
    const stream = createReadStream(filePath, { start, end: start + length - 1 });
    for await (const chunk of stream) {
        hash.update(chunk);
    }
}
