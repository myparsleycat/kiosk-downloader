import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import { MEGA_FILE_KEY_LENGTH, MEGA_FOLDER_KEY_LENGTH, tryParseMegaUrl } from "@shared/share-url";
import type { LoadCollectionPayload } from "@shared/types";
import { toErrorMessage } from "@shared/utils";
import pLimit from "p-limit";

import type { KioskDownloader } from "../..";
import type { MegaCdnSpec } from "./mega-cdn-download-runner";
import type { DownloadFileRow, LoadedMegaCollection, MegaFileSourceMeta } from "./types";

import {
    assertMegaResult,
    isMegaErrorCode,
    MEGA_API_BASE,
    MEGA_ERROR,
    MEGA_LABEL,
    MEGA_ORIGIN,
    MegaApiError,
    MegaQuotaExceededError,
    requestMegaApi,
    toMegaError,
} from "../mega/mega-api";
import { decodeMegaEncodedLink, decryptMegaNodeKey } from "../mega/mega-crypto";
import { buildMegaTree, type MegaNode } from "./mega-node-tree";
import {
    COLLECTION_EXPIRES_NEVER,
    TRANSFER_SEGMENT_SIZE,
    base64urlDecode,
    decryptNodeAttr,
} from "./transfer-it-crypto";

export const MEGA_RATE_LIMIT_ERROR =
    "Mega 전송 한도를 초과했습니다. 한도가 복구된 뒤 다시 시도해 주세요.";
export const MEGA_RATE_LIMIT_ANONYMOUS_ERROR =
    "Mega 전송 한도를 초과했습니다. 설정에서 Mega 계정으로 로그인하면 계정 한도로 다운로드할 수 있습니다.";
export const MEGA_SESSION_EXPIRED_ERROR =
    "Mega 세션이 만료되었습니다. 설정에서 다시 로그인한 뒤 재개해 주세요.";

const FATAL_ERROR_CODES = new Set<number>([
    MEGA_ERROR.ENOENT,
    MEGA_ERROR.EACCESS,
    MEGA_ERROR.EKEY,
    MEGA_ERROR.ESID,
    MEGA_ERROR.EBLOCKED,
]);

export type MegaApiClientOptions = {
    /** Called synchronously when a download hits the exhausted MEGA transfer quota. */
    onQuotaExceeded?: (error: MegaQuotaExceededError) => void;
};

export class MegaApiClient {
    private readonly controlPlane = pLimit(4);

    public constructor(
        private readonly kd: KioskDownloader,
        private readonly options: MegaApiClientOptions = {},
    ) {}

    public async loadCollection(
        payload: LoadCollectionPayload & { signal?: AbortSignal },
    ): Promise<LoadedMegaCollection> {
        const parsed = tryParseMegaUrl(payload.url);
        if (!parsed) {
            throw new Error("Invalid Mega link.");
        }
        const link = parsed.type === "encoded" ? decodeMegaEncodedLink(parsed) : parsed;
        const keyText = link.key ?? payload.password?.trim();
        if (!keyText) {
            throw new Error(COLLECTION_PASSWORD_REQUIRED_ERROR);
        }
        const expectedKeyLength =
            link.kind === "folder" ? MEGA_FOLDER_KEY_LENGTH : MEGA_FILE_KEY_LENGTH;
        if (!/^[\w-]+$/.test(keyText) || keyText.length !== expectedKeyLength) {
            throw new Error(COLLECTION_INVALID_PASSWORD_ERROR);
        }
        const key = base64urlDecode(keyText);
        const passwordProtected = link.key === undefined;

        if (link.kind === "file") {
            return await this.loadFile(link.handle, key, passwordProtected, payload.signal);
        }
        return await this.loadFolder(
            link.handle,
            key,
            passwordProtected,
            { subFolderId: link.subFolderId, subFileId: link.subFileId },
            payload.signal,
        );
    }

    public async getDownloadUrl(
        file: Pick<DownloadFileRow, "remoteId">,
        meta: MegaFileSourceMeta,
        signal?: AbortSignal,
    ) {
        const result = assertMegaResult(
            await this.api(
                meta.folderHandle
                    ? { a: "g", g: 1, ssl: 2, n: file.remoteId }
                    : { a: "g", g: 1, ssl: 2, p: file.remoteId },
                meta.folderHandle ? { n: meta.folderHandle } : {},
                signal,
            ),
            "g",
            this.apiOptions(),
        ) as { e?: number; g?: string };
        if (typeof result.e === "number") {
            throw this.toError(result.e);
        }
        if (typeof result.g !== "string" || !/^https?:\/\//i.test(result.g)) {
            throw new Error("Mega CDN URL missing.");
        }
        return result.g;
    }

    public createSpec(file: DownloadFileRow): MegaCdnSpec {
        const meta = parseMegaFileSourceMeta(file.sourceMetaJson);
        return {
            provider: "mega",
            providerId: "mega-download",
            cohortKey: "mega-cdn",
            label: "Mega CDN",
            rateLimitMessage: this.apiOptions().rateLimitMessage,
            resolveDownloadUrl: (signal) => this.getDownloadUrl(file, meta, signal),
            generation: () => this.kd.service.mega.generation,
            isFatal: (error) => error instanceof MegaApiError && FATAL_ERROR_CODES.has(error.code),
            onQuotaExceeded: (error) => this.options.onQuotaExceeded?.(error),
        };
    }

    private async loadFile(
        handle: string,
        key: Buffer,
        passwordProtected: boolean,
        signal: AbortSignal | undefined,
    ): Promise<LoadedMegaCollection> {
        const info = assertMegaResult(
            await this.api({ a: "g", p: handle, ssl: 2 }, {}, signal),
            "g",
            this.apiOptions(),
        ) as { e?: number; s?: number; at?: string };
        if (typeof info.e === "number") {
            throw this.toError(info.e);
        }
        const attr = info.at ? decryptNodeAttr(info.at, key) : null;
        if (!attr) {
            throw new Error(COLLECTION_INVALID_PASSWORD_ERROR);
        }
        const { tree, nodeKeys, rootName } = buildMegaTree(
            [{ h: handle, p: "", t: 0, a: info.at, s: info.s }],
            {
                onlyFileHandle: handle,
                resolveNodeKey: () => key,
                onNodeError: (nodeHandle, error) => this.logNodeError(nodeHandle, error),
            },
        );
        return {
            provider: "mega",
            collection: this.collection(handle, rootName || handle, passwordProtected, tree),
            rootId: handle,
            passwordProtected,
            nodeKeys,
        };
    }

    private async loadFolder(
        handle: string,
        folderKey: Buffer,
        passwordProtected: boolean,
        sub: { subFolderId?: string; subFileId?: string },
        signal: AbortSignal | undefined,
    ): Promise<LoadedMegaCollection> {
        const response = assertMegaResult(
            await this.api({ a: "f", c: 1, r: 1, ca: 1 }, { n: handle }, signal),
            "f",
            this.apiOptions(),
        ) as { f?: MegaNode[] };
        if (!Array.isArray(response.f)) {
            throw new Error("Mega folder listing failed.");
        }
        const nodes = response.f;
        const rootHandle = findFolderRootHandle(nodes);
        if (!rootHandle) {
            throw new Error("Mega folder root not found.");
        }
        const resolveNodeKey = (node: MegaNode) => {
            const encrypted = pickNodeKey(node.k, rootHandle);
            return encrypted ? decryptMegaNodeKey(encrypted, folderKey) : null;
        };

        // A wrong folder key still decrypts to bytes; only the root attribute's "MEGA" prefix tells.
        const root = nodes.find((node) => node.h === rootHandle)!;
        const rootKey = resolveNodeKey(root);
        if (!rootKey || !root.a || !decryptNodeAttr(root.a, rootKey)) {
            throw new Error(COLLECTION_INVALID_PASSWORD_ERROR);
        }

        const { tree, nodeKeys, rootName } = buildMegaTree(nodes, {
            rootHandle: sub.subFolderId ?? rootHandle,
            onlyFileHandle: sub.subFileId,
            resolveNodeKey,
            onNodeError: (nodeHandle, error) => this.logNodeError(nodeHandle, error),
        });
        return {
            provider: "mega",
            collection: this.collection(handle, rootName || handle, passwordProtected, tree),
            rootId: handle,
            passwordProtected,
            nodeKeys,
            folderHandle: handle,
        };
    }

    private collection(
        shareId: string,
        name: string,
        passwordProtected: boolean,
        tree: LoadedMegaCollection["collection"]["tree"],
    ): LoadedMegaCollection["collection"] {
        return {
            shareId,
            name,
            expires: COLLECTION_EXPIRES_NEVER,
            segmentSize: TRANSFER_SEGMENT_SIZE,
            passwordProtected,
            provider: "mega",
            tree,
        };
    }

    private apiOptions() {
        return {
            label: MEGA_LABEL,
            rateLimitMessage: this.kd.service.mega.getSessionId()
                ? MEGA_RATE_LIMIT_ERROR
                : MEGA_RATE_LIMIT_ANONYMOUS_ERROR,
        };
    }

    private toError(code: number) {
        return code === MEGA_ERROR.EOVERQUOTA
            ? new MegaQuotaExceededError()
            : toMegaError(code, this.apiOptions());
    }

    private logNodeError(nodeHandle: string, error: unknown) {
        this.kd.logger.error(
            { nodeHandle, message: toErrorMessage(error) },
            "MegaApiClient:decryptNode",
        );
    }

    /** Sends a request with the logged-in session when there is one; ESID logs that session out. */
    private async api(
        payload: Record<string, unknown>,
        query: Record<string, string>,
        signal?: AbortSignal,
    ) {
        return await this.controlPlane(async () => {
            signal?.throwIfAborted();
            const sid = this.kd.service.mega.getSessionId();
            const result = await requestMegaApi(this.kd.http, payload, {
                apiBase: MEGA_API_BASE,
                origin: MEGA_ORIGIN,
                ...this.apiOptions(),
                query: sid ? { ...query, sid } : query,
                signal,
                solveHashcash: (challenge, hashcashSignal) =>
                    this.kd.service.mega.solveHashcash(challenge, hashcashSignal),
            });
            if (sid && isMegaErrorCode(result) && result === MEGA_ERROR.ESID) {
                await this.kd.service.mega.invalidateSession(sid);
                throw new MegaApiError(result, MEGA_SESSION_EXPIRED_ERROR);
            }
            if (result === MEGA_ERROR.EOVERQUOTA) {
                throw new MegaQuotaExceededError();
            }
            return result;
        });
    }
}

export function parseMegaFileSourceMeta(sourceMetaJson: string | null): MegaFileSourceMeta {
    if (!sourceMetaJson) {
        throw new Error("Missing Mega file metadata.");
    }
    const parsed = JSON.parse(sourceMetaJson) as Partial<MegaFileSourceMeta>;
    if (typeof parsed.nodeKey !== "string" || !parsed.nodeKey) {
        throw new Error("Mega file node key missing.");
    }
    return {
        nodeKey: parsed.nodeKey,
        ...(typeof parsed.folderHandle === "string" ? { folderHandle: parsed.folderHandle } : {}),
    };
}

/**
 * The shared root carries its own key (`<rootHandle>:<key>` in its `k`); every other node's key is
 * encrypted under that share key. Fall back to the folder whose parent is outside the listing.
 */
function findFolderRootHandle(nodes: MegaNode[]) {
    const selfKeyed = nodes.find(
        (node) => node.t === 1 && node.k?.split("/").some((pair) => pair.startsWith(`${node.h}:`)),
    );
    if (selfKeyed) {
        return selfKeyed.h;
    }
    const handles = new Set(nodes.map((node) => node.h));
    return nodes.find((node) => node.t === 1 && !handles.has(node.p))?.h;
}

function pickNodeKey(k: string | undefined, rootHandle: string) {
    if (!k) {
        return null;
    }
    const pairs = k.split("/").map((pair) => {
        const separator = pair.indexOf(":");
        return separator < 0
            ? { handle: "", key: pair }
            : { handle: pair.slice(0, separator), key: pair.slice(separator + 1) };
    });
    return (
        pairs.find((pair) => pair.handle === rootHandle && pair.key)?.key ??
        pairs.find((pair) => pair.key)?.key ??
        null
    );
}
