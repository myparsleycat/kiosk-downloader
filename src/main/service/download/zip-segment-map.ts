export type SegmentByteRange = {
    segmentIndex: number;
    localStart: number;
    localEnd: number;
    length: number;
};

export type ZipEntrySegmentChunk = {
    chunkIndex: number;
    offset: number;
    size: number;
    segmentIndex: number;
    localStart: number;
    localEnd: number;
};

/** Split a ZIP payload absolute range into part-file chunks aligned to CDN segments. */
export function buildZipEntrySegmentChunks(
    dataOffset: number,
    compressedSize: number,
    segmentSize: number,
    archiveSize: number,
): ZipEntrySegmentChunk[] {
    const ranges = mapAbsoluteRangeToSegments(dataOffset, compressedSize, segmentSize, archiveSize);
    let offset = 0;
    return ranges.map((range, chunkIndex) => {
        const chunk = {
            chunkIndex,
            offset,
            size: range.length,
            segmentIndex: range.segmentIndex,
            localStart: range.localStart,
            localEnd: range.localEnd,
        };
        offset += range.length;
        return chunk;
    });
}

export function supportsZipEntryPoolDownload(meta: {
    encrypted: boolean;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
}) {
    if (meta.encrypted || meta.compressedSize <= 0) {
        return false;
    }
    if (meta.compressionMethod === 0) {
        return meta.compressedSize === meta.uncompressedSize;
    }
    return meta.compressionMethod === 8;
}

export function mapAbsoluteRangeToSegments(
    absoluteOffset: number,
    length: number,
    segmentSize: number,
    fileSize: number,
): SegmentByteRange[] {
    if (!Number.isFinite(segmentSize) || segmentSize < 1) {
        throw new Error(`Invalid segment size: ${segmentSize}.`);
    }
    if (length <= 0) {
        return [];
    }
    if (absoluteOffset < 0 || absoluteOffset >= fileSize) {
        throw new Error(`Absolute offset ${absoluteOffset} is outside file size ${fileSize}.`);
    }

    const end = Math.min(absoluteOffset + length, fileSize);
    const ranges: SegmentByteRange[] = [];
    let cursor = absoluteOffset;

    while (cursor < end) {
        const segmentIndex = Math.floor(cursor / segmentSize);
        const segmentStart = segmentIndex * segmentSize;
        const segmentEnd = Math.min(segmentStart + segmentSize, fileSize);
        const localStart = cursor - segmentStart;
        const localEnd = Math.min(end, segmentEnd) - segmentStart;
        ranges.push({
            segmentIndex,
            localStart,
            localEnd,
            length: localEnd - localStart,
        });
        cursor = segmentStart + localEnd;
    }

    return ranges;
}

export function readUint16LE(bytes: Uint8Array, offset: number) {
    return bytes[offset] + bytes[offset + 1] * 256;
}

/** Local file header: signature(4) + ... + fileNameLen at +26, extraLen at +28; data starts at +30+name+extra. */
export function computeStoredDataOffset(
    localHeaderOffset: number,
    nameAndExtraLengths: Uint8Array,
) {
    if (nameAndExtraLengths.length < 4) {
        throw new Error("Local header length fields require 4 bytes.");
    }
    return (
        localHeaderOffset +
        30 +
        readUint16LE(nameAndExtraLengths, 0) +
        readUint16LE(nameAndExtraLengths, 2)
    );
}
