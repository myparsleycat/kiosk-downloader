import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

import { INFLATE_BUFFER_BYTES_DEFAULT } from "@shared/settings";
import fse from "fs-extra";

/** Scale compressed download bytes onto the uncompressed file size for UI progress. */
export function zipDeflateProgressScale(compressedSize: number, uncompressedSize: number) {
    return {
        sourceTotal: compressedSize,
        displayTotal: uncompressedSize,
    };
}

export async function inflateRawFile(
    stagingPath: string,
    outputPath: string,
    expectedUncompressedSize: number,
    bufferBytes = INFLATE_BUFFER_BYTES_DEFAULT,
    signal?: AbortSignal,
    onProgress?: (bytesWritten: number) => void,
) {
    if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
    }

    await fse.ensureDir(path.dirname(outputPath));
    await fse.remove(outputPath).catch(() => undefined);

    const inflate = createInflateRaw({ chunkSize: bufferBytes });
    const input = createReadStream(stagingPath, { highWaterMark: bufferBytes });
    const output = createWriteStream(outputPath, { highWaterMark: bufferBytes });
    let written = 0;
    const counter = onProgress
        ? new Transform({
              transform(chunk, _encoding, callback) {
                  written += chunk.length;
                  onProgress(written);
                  callback(null, chunk);
              },
          })
        : null;

    const onAbort = () => {
        input.destroy();
        inflate.destroy();
        counter?.destroy();
        output.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
        if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }
        if (counter) {
            await pipeline(input, inflate, counter, output);
            onProgress?.(written);
        } else {
            await pipeline(input, inflate, output);
        }
    } catch (error) {
        output.destroy();
        await fse.remove(outputPath).catch(() => undefined);
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            throw new DOMException("The operation was aborted.", "AbortError");
        }
        throw error;
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }

    const stat = await fse.stat(outputPath);
    if (stat.size !== expectedUncompressedSize) {
        await fse.remove(outputPath).catch(() => undefined);
        throw new Error(`Inflate produced ${stat.size}B, expected ${expectedUncompressedSize}B.`);
    }
}
