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

    const pieces = files.flatMap((file, sourceIndex) =>
        createPieces(file, sourceIndex, mode, limits.maxBytes),
    );

    return {
        ok: true,
        mode,
        collections: packPieces(pieces, limits),
        oversizedFiles: [],
    };
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

function packPieces(pieces: ExtendedUploadPiece[], limits: ExtendedUploadLimits) {
    const collections: ExtendedUploadCollection[] = [];
    const sortedPieces = pieces.toSorted(comparePieces);

    for (const piece of sortedPieces) {
        const collection = collections
            .filter(
                (candidate) =>
                    candidate.pieces.length < limits.maxFiles &&
                    candidate.totalSize + piece.length <= limits.maxBytes,
            )
            .reduce<ExtendedUploadCollection | undefined>((best, candidate) => {
                if (!best) return candidate;
                const candidateRemaining = limits.maxBytes - candidate.totalSize - piece.length;
                const bestRemaining = limits.maxBytes - best.totalSize - piece.length;
                return candidateRemaining < bestRemaining ? candidate : best;
            }, undefined);

        if (collection) {
            collection.pieces.push(piece);
            collection.totalSize += piece.length;
            continue;
        }

        collections.push({ index: collections.length, totalSize: piece.length, pieces: [piece] });
    }

    return collections;
}

function comparePieces(left: ExtendedUploadPiece, right: ExtendedUploadPiece) {
    if (left.length !== right.length) return right.length - left.length;
    if (left.sourcePath !== right.sourcePath) return left.sourcePath < right.sourcePath ? -1 : 1;
    if (left.offset !== right.offset) return left.offset - right.offset;
    return left.sourceIndex - right.sourceIndex;
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
