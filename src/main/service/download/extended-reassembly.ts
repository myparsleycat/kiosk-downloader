import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import fse from "fs-extra";

export async function reassembleExtendedFile(options: {
    pieces: Array<{ path: string; offset: number; size: number; sourceOffset?: number }>;
    partPath: string;
    finalPath: string;
    expectedSize: number;
    expectedSha256?: string;
}) {
    const pieces = options.pieces.toSorted((left, right) => left.offset - right.offset);
    let nextOffset = 0;
    await fse.ensureDir(path.dirname(options.partPath));

    try {
        for (let index = 0; index < pieces.length; index += 1) {
            const piece = pieces[index];
            if (piece.offset !== nextOffset) {
                throw new Error("분할 파일 조각 범위가 연속적이지 않습니다.");
            }
            const stat = await fse.stat(piece.path);
            const sourceOffset = piece.sourceOffset ?? 0;
            if (sourceOffset + piece.size > stat.size) {
                throw new Error("분할 파일 조각 크기가 일치하지 않습니다.");
            }
            if (piece.size === 0) {
                if (index === 0) await fse.writeFile(options.partPath, "");
            } else {
                await pipeline(
                    createReadStream(piece.path, {
                        start: sourceOffset,
                        end: sourceOffset + piece.size - 1,
                    }),
                    createWriteStream(options.partPath, { flags: index === 0 ? "w" : "a" }),
                );
            }
            nextOffset += piece.size;
        }

        if (nextOffset !== options.expectedSize) {
            throw new Error("재조립 파일 크기가 일치하지 않습니다.");
        }
        if (options.expectedSha256) {
            const hash = createHash("sha256");
            await pipeline(createReadStream(options.partPath), hash);
            if (hash.digest("hex") !== options.expectedSha256) {
                throw new Error("재조립 파일 해시가 일치하지 않습니다.");
            }
        }
        await fse.ensureDir(path.dirname(options.finalPath));
        await fse.move(options.partPath, options.finalPath, { overwrite: true });
    } catch (error) {
        await fse.remove(options.partPath);
        throw error;
    }
}
