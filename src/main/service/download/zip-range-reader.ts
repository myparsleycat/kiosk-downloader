import type { KioskDownloader } from "../..";
import type { SegmentDescriptor } from "./types";

import { streamSegmentBytes } from "./kio-api-client";
import { mapAbsoluteRangeToSegments } from "./zip-segment-map";

export type ZipRangeReaderOptions = {
    kd: KioskDownloader;
    segments: SegmentDescriptor[];
    segmentSize: number;
    fileSize: number;
    signal?: AbortSignal;
};

export class ZipRangeReader {
    private readonly kd: KioskDownloader;
    private readonly segments: SegmentDescriptor[];
    private readonly segmentSize: number;
    private readonly fileSize: number;
    private readonly signal?: AbortSignal;

    public constructor(options: ZipRangeReaderOptions) {
        this.kd = options.kd;
        this.segments = options.segments;
        this.segmentSize = options.segmentSize;
        this.fileSize = options.fileSize;
        this.signal = options.signal;
    }

    public get size() {
        return this.fileSize;
    }

    public async readUint8Array(absoluteOffset: number, length: number): Promise<Uint8Array> {
        const ranges = mapAbsoluteRangeToSegments(
            absoluteOffset,
            length,
            this.segmentSize,
            this.fileSize,
        );
        if (ranges.length === 0) {
            return new Uint8Array(0);
        }

        const out = new Uint8Array(ranges.reduce((sum, range) => sum + range.length, 0));
        let writeAt = 0;
        for (const range of ranges) {
            const segment = this.segments[range.segmentIndex];
            if (!segment) {
                throw new Error(`Missing segment ${range.segmentIndex} for ZIP range read.`);
            }
            const bytes = await this.fetchSegmentBytes(segment, range.localStart, range.localEnd);
            out.set(bytes, writeAt);
            writeAt += bytes.length;
        }
        return out;
    }

    public async *streamAbsoluteRange(
        absoluteOffset: number,
        length: number,
    ): AsyncGenerator<Uint8Array> {
        const ranges = mapAbsoluteRangeToSegments(
            absoluteOffset,
            length,
            this.segmentSize,
            this.fileSize,
        );
        for (const range of ranges) {
            const segment = this.segments[range.segmentIndex];
            if (!segment) {
                throw new Error(`Missing segment ${range.segmentIndex} for ZIP range stream.`);
            }
            yield* this.streamSegmentBytes(segment, range.localStart, range.localEnd);
        }
    }

    private async fetchSegmentBytes(
        segment: SegmentDescriptor,
        localStart: number,
        localEnd: number,
    ) {
        const expected = localEnd - localStart;
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const piece of this.streamSegmentBytes(segment, localStart, localEnd)) {
            chunks.push(piece);
            total += piece.length;
        }
        if (total !== expected) {
            throw new Error(`ZIP range read expected ${expected}B, got ${total}B.`);
        }
        if (chunks.length === 1) {
            return chunks[0];
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    private streamSegmentBytes(segment: SegmentDescriptor, localStart: number, localEnd: number) {
        const signal = this.signal ?? new AbortController().signal;
        // Same as pool downloads: full segment GET + local slice. Avoids Range being ignored
        // (HTTP 200 full body) which previously kept downloading after releaseLock().
        return streamSegmentBytes(this.kd, segment, localStart, localEnd, signal, {
            label: "ZIP segment range",
            mode: "slice",
        });
    }
}
