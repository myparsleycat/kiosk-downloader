import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import { tryParseTransferUrl } from "@shared/share-url";
import type { LoadCollectionPayload } from "@shared/types";
import { toErrorMessage } from "@shared/utils";
import pLimit from "p-limit";

import type { KioskDownloader } from "../..";
import type { DownloadCollectionRow, LoadedTransferCollection } from "./types";

import {
    assertMegaResult,
    megaErrorMessage,
    type MegaApiRequestOptions,
    requestMegaApi,
} from "../mega/mega-api";
import { buildMegaTree, type MegaNode } from "./mega-node-tree";
import {
    COLLECTION_EXPIRES_NEVER,
    TRANSFER_SEGMENT_SIZE,
    base64urlDecode,
    decodeTransferTitle,
    deriveTransferPassword,
} from "./transfer-it-crypto";

const API_OPTIONS = {
    apiBase: "https://bt7.api.mega.co.nz/cs",
    origin: "https://transfer.it",
    label: "Transfer",
} satisfies Partial<MegaApiRequestOptions>;

type XiResponse = {
    pw?: number;
    t?: string;
    z?: string;
    size?: number[];
};

export const TRANSFER_RATE_LIMIT_ERROR =
    "Transfer 서버가 다운로드 요청을 제한했습니다. 잠시 후 다시 시도해 주세요.";

function extractTransferId(url: string) {
    const xh = tryParseTransferUrl(url);
    if (!xh) {
        throw new Error("Invalid transfer.it share URL.");
    }
    return xh;
}

export class TransferItApiClient {
    private readonly controlPlane = pLimit(4);

    public constructor(private readonly kd: KioskDownloader) {}

    public async loadCollection(
        payload: LoadCollectionPayload & { signal?: AbortSignal },
    ): Promise<LoadedTransferCollection> {
        const xh = extractTransferId(payload.url);
        const xi = await this.xi(xh, payload.signal);
        const passwordProtected = xi.pw === 1;
        let authPw: string | undefined;

        if (passwordProtected) {
            if (!payload.password?.trim()) {
                throw new Error(COLLECTION_PASSWORD_REQUIRED_ERROR);
            }
            authPw = deriveTransferPassword(xh, payload.password);
            const xv = await this.megaApi({ a: "xv", xh, pw: authPw }, {}, payload.signal);
            if (xv !== 1) {
                throw new Error(COLLECTION_INVALID_PASSWORD_ERROR);
            }
        }

        const query: Record<string, string> = { x: xh };
        if (authPw) {
            query.pw = authPw;
        }
        const fResp = assertMegaResult(
            await this.megaApi({ a: "f", c: 1, r: 1 }, query, payload.signal),
            "f",
            API_OPTIONS,
        ) as {
            f?: MegaNode[];
        };
        if (!Array.isArray(fResp.f)) {
            throw new Error("Transfer file list failed.");
        }

        const { tree, nodeKeys, rootName } = buildMegaTree(fResp.f, {
            excludeHandle: xi.z,
            resolveNodeKey: (node) => (node.k ? base64urlDecode(node.k) : null),
            onNodeError: (nodeHandle, error) =>
                this.kd.logger.error(
                    { nodeHandle, message: toErrorMessage(error) },
                    "TransferItApiClient:decryptNode",
                ),
        });
        const name = decodeTransferTitle(xi.t, rootName || xh);

        return {
            provider: "transfer",
            collection: {
                shareId: xh,
                name,
                expires: COLLECTION_EXPIRES_NEVER,
                segmentSize: TRANSFER_SEGMENT_SIZE,
                passwordProtected,
                provider: "transfer",
                tree,
            },
            rootId: xh,
            passwordProtected,
            authPw,
            nodeKeys,
        };
    }

    public deriveAuthPw(row: DownloadCollectionRow) {
        if (!row.passwordPlain) {
            return undefined;
        }
        return deriveTransferPassword(row.shareId, row.passwordPlain);
    }

    public async getDownloadUrl(
        xh: string,
        nodeHandle: string,
        authPw?: string,
        signal?: AbortSignal,
    ) {
        const query: Record<string, string> = { x: xh };
        if (authPw) {
            query.pw = authPw;
        }
        const g = assertMegaResult(
            await this.megaApi({ a: "g", n: nodeHandle, g: 1, ssl: 2 }, query, signal),
            "g",
            API_OPTIONS,
        ) as { e?: number; g?: string; s?: number };

        if (typeof g.e === "number") {
            throw new Error(megaErrorMessage(g.e, API_OPTIONS.label));
        }
        if (typeof g.g !== "string" || !/^https?:\/\//i.test(g.g)) {
            throw new Error("Transfer CDN URL missing.");
        }
        return { url: g.g, size: typeof g.s === "number" ? g.s : undefined };
    }

    private async xi(xh: string, signal?: AbortSignal) {
        const xi = assertMegaResult(
            await this.megaApi({ a: "xi", xh }, {}, signal),
            "xi",
            API_OPTIONS,
        );
        if (!xi || typeof xi !== "object") {
            throw new Error("Transfer info failed.");
        }
        return xi as XiResponse;
    }

    private async megaApi(
        payload: Record<string, unknown>,
        query: Record<string, string> = {},
        signal?: AbortSignal,
    ) {
        return await this.controlPlane(async () => {
            signal?.throwIfAborted();
            return await requestMegaApi(this.kd.http, payload, {
                ...API_OPTIONS,
                query,
                signal,
                rateLimitMessage: TRANSFER_RATE_LIMIT_ERROR,
                solveHashcash: (challenge, hashcashSignal) =>
                    this.kd.service.mega.solveHashcash(challenge, hashcashSignal),
            });
        });
    }
}
