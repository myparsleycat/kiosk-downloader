export const EXTENDED_UPLOAD_DEFAULT_LIMITS = {
    maxFiles: 1_000,
    maxBytes: 50 * 1024 ** 3,
} as const;

export type ExtendedUploadMode = "integrated" | "compatible";

export type ExtendedUploadSourceFile = {
    path: string;
    name: string;
    size: number;
    sourceMtimeMs: number;
};

export type ExtendedUploadLimits = {
    maxFiles: number;
    maxBytes: number;
};

export type ExtendedUploadPiece = {
    sourcePath: string;
    sourceName: string;
    sourceSize: number;
    sourceMtimeMs: number;
    sourceIndex: number;
    pieceIndex: number;
    pieceCount: number;
    offset: number;
    length: number;
};

export type ExtendedUploadCollection = {
    index: number;
    totalSize: number;
    pieces: ExtendedUploadPiece[];
};

export type ExtendedUploadPlanResult =
    | {
          ok: true;
          mode: ExtendedUploadMode;
          collections: ExtendedUploadCollection[];
          oversizedFiles: [];
      }
    | {
          ok: false;
          mode: "compatible";
          collections: [];
          oversizedFiles: ExtendedUploadSourceFile[];
      };

export type SizedPackItem<T> = T & {
    size: number;
    sortKey: string;
};

export type SizedPackCollection<T> = {
    index: number;
    totalSize: number;
    items: T[];
};

export function createExtendedUploadPlan(
    files: ExtendedUploadSourceFile[],
    mode: ExtendedUploadMode,
    limits: ExtendedUploadLimits = EXTENDED_UPLOAD_DEFAULT_LIMITS,
): ExtendedUploadPlanResult {
    validateLimits(limits);
    files.forEach(validateSourceFile);

    const oversizedFiles = files.filter((file) => file.size > limits.maxBytes);
    if (mode === "compatible" && oversizedFiles.length > 0) {
        return { ok: false, mode, collections: [], oversizedFiles };
    }

    const pieces = createExtendedUploadPieces(files, mode, limits.maxBytes);

    return {
        ok: true,
        mode,
        collections: packExtendedPieces(pieces, limits),
        oversizedFiles: [],
    };
}

export function createExtendedUploadPieces(
    files: ExtendedUploadSourceFile[],
    mode: ExtendedUploadMode,
    maxBytes: number = EXTENDED_UPLOAD_DEFAULT_LIMITS.maxBytes,
): ExtendedUploadPiece[] {
    files.forEach(validateSourceFile);
    return files.flatMap((file, sourceIndex) => createPieces(file, sourceIndex, mode, maxBytes));
}

export function packExtendedPieces(
    pieces: ExtendedUploadPiece[],
    limits: ExtendedUploadLimits = EXTENDED_UPLOAD_DEFAULT_LIMITS,
): ExtendedUploadCollection[] {
    validateLimits(limits);
    return packSizedItems(
        pieces.map((piece) => ({
            ...piece,
            size: piece.length,
            sortKey: `${piece.sourcePath}\0${piece.offset}\0${piece.sourceIndex}`,
        })),
        limits,
        comparePieces,
    ).map((collection) => ({
        index: collection.index,
        totalSize: collection.totalSize,
        pieces: collection.items,
    }));
}

/** Best-fit decreasing bin-pack by `size`, with deterministic `sortKey` ties. */
export function packSizedItems<T>(
    items: Array<SizedPackItem<T>>,
    limits: ExtendedUploadLimits,
    compare: (left: SizedPackItem<T>, right: SizedPackItem<T>) => number = compareSizedItems,
): Array<SizedPackCollection<T>> {
    validateLimits(limits);
    const collections: Array<SizedPackCollection<T>> = [];
    const sorted = items.toSorted(compare);

    for (const item of sorted) {
        const collection = collections
            .filter(
                (candidate) =>
                    candidate.items.length < limits.maxFiles &&
                    candidate.totalSize + item.size <= limits.maxBytes,
            )
            .reduce<SizedPackCollection<T> | undefined>((best, candidate) => {
                if (!best) return candidate;
                const candidateRemaining = limits.maxBytes - candidate.totalSize - item.size;
                const bestRemaining = limits.maxBytes - best.totalSize - item.size;
                if (candidateRemaining !== bestRemaining) {
                    return candidateRemaining < bestRemaining ? candidate : best;
                }
                return candidate.index < best.index ? candidate : best;
            }, undefined);

        if (collection) {
            collection.items.push(item);
            collection.totalSize += item.size;
            continue;
        }

        collections.push({ index: collections.length, totalSize: item.size, items: [item] });
    }

    return collections;
}

function createPieces(
    file: ExtendedUploadSourceFile,
    sourceIndex: number,
    mode: ExtendedUploadMode,
    maxBytes: number,
) {
    const pieceCount = mode === "integrated" ? Math.max(1, Math.ceil(file.size / maxBytes)) : 1;

    return Array.from({ length: pieceCount }, (_, pieceIndex): ExtendedUploadPiece => {
        const offset = pieceIndex * maxBytes;
        return {
            sourcePath: file.path,
            sourceName: file.name,
            sourceSize: file.size,
            sourceMtimeMs: file.sourceMtimeMs,
            sourceIndex,
            pieceIndex,
            pieceCount,
            offset,
            length: Math.min(maxBytes, file.size - offset),
        };
    });
}

function comparePieces(
    left: SizedPackItem<ExtendedUploadPiece>,
    right: SizedPackItem<ExtendedUploadPiece>,
) {
    if (left.length !== right.length) return right.length - left.length;
    if (left.sourcePath !== right.sourcePath) return left.sourcePath < right.sourcePath ? -1 : 1;
    if (left.offset !== right.offset) return left.offset - right.offset;
    return left.sourceIndex - right.sourceIndex;
}

function compareSizedItems<T>(left: SizedPackItem<T>, right: SizedPackItem<T>) {
    if (left.size !== right.size) return right.size - left.size;
    if (left.sortKey === right.sortKey) return 0;
    return left.sortKey < right.sortKey ? -1 : 1;
}

function validateLimits(limits: ExtendedUploadLimits) {
    if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles <= 0) {
        throw new Error("maxFiles must be a positive safe integer");
    }
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
        throw new Error("maxBytes must be a positive safe integer");
    }
}

function validateSourceFile(file: ExtendedUploadSourceFile) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
        throw new Error(`File size must be a non-negative safe integer: ${file.path}`);
    }
}
