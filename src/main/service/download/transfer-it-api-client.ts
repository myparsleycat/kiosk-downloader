import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import { tryParseTransferUrl } from "@shared/share-url";
import type {
    DirNode,
    FileNode,
    LoadCollectionPayload,
    ProbeCollectionPayload,
    ProbeCollectionResult,
    TreeEntry,
} from "@shared/types";
import { toErrorMessage } from "@shared/utils";

import type { KioskDownloader } from "../..";
import type { DownloadCollectionRow, LoadedTransferCollection } from "./types";

import {
    COLLECTION_EXPIRES_NEVER,
    TRANSFER_SEGMENT_SIZE,
    base64urlDecode,
    base64urlEncode,
    decodeTransferTitle,
    decryptNodeAttr,
    deriveTransferPassword,
} from "./transfer-it-crypto";

const API_BASE = "https://bt7.api.mega.co.nz/cs";

type MegaNode = {
    h: string;
    p: string;
    t: number;
    a?: string;
    k?: string;
    s?: number;
};

type XiResponse = {
    pw?: number;
    t?: string;
    z?: string;
    size?: number[];
};

function extractTransferId(url: string) {
    const xh = tryParseTransferUrl(url);
    if (!xh) {
        throw new Error("Invalid transfer.it share URL.");
    }
    return xh;
}

function megaErrorMessage(code: number) {
    switch (code) {
        case -2:
            return "Invalid transfer arguments.";
        case -3:
            return "Transfer API temporarily unavailable. Retry later.";
        case -4:
            return "Transfer rate limited. Retry later.";
        case -6:
            return "Too many transfer requests.";
        case -8:
            return "Transfer has expired.";
        case -9:
            return "Transfer not found.";
        case -11:
            return "Transfer access denied.";
        case -14:
            return COLLECTION_INVALID_PASSWORD_ERROR;
        case -16:
            return "Transfer is blocked.";
        case -17:
            return "Transfer bandwidth quota exceeded.";
        case -19:
            return "Too many transfer connections.";
        default:
            return `Transfer API error (${code}).`;
    }
}

function assertMegaResult(value: unknown, stage: string) {
    if (typeof value === "number" && value < 0) {
        throw new Error(megaErrorMessage(value));
    }
    if (value == null) {
        throw new Error(`Transfer ${stage} failed: empty response.`);
    }
    return value;
}

function sanitizeName(name: string) {
    return name.replace(/[\\/:*?"<>|]/g, "_") || "unknown";
}

export class TransferItApiClient {
    public constructor(private readonly kd: KioskDownloader) {}

    public async probeCollection(payload: ProbeCollectionPayload): Promise<ProbeCollectionResult> {
        const xh = extractTransferId(payload.url);
        const xi = await this.xi(xh);
        return { passwordRequired: xi.pw === 1 };
    }

    public async loadCollection(payload: LoadCollectionPayload): Promise<LoadedTransferCollection> {
        const xh = extractTransferId(payload.url);
        const xi = await this.xi(xh);
        const passwordProtected = xi.pw === 1;
        let authPw: string | undefined;

        if (passwordProtected) {
            if (!payload.password?.trim()) {
                throw new Error(COLLECTION_PASSWORD_REQUIRED_ERROR);
            }
            authPw = deriveTransferPassword(xh, payload.password);
            const xv = await this.megaApi({ a: "xv", xh, pw: authPw });
            if (xv !== 1) {
                throw new Error(COLLECTION_INVALID_PASSWORD_ERROR);
            }
        }

        const query: Record<string, string> = { x: xh };
        if (authPw) {
            query.pw = authPw;
        }
        const fResp = assertMegaResult(await this.megaApi({ a: "f", c: 1, r: 1 }, query), "f") as {
            f?: MegaNode[];
        };
        if (!Array.isArray(fResp.f)) {
            throw new Error("Transfer file list failed.");
        }

        const { tree, nodeKeys, rootName } = this.buildTree(fResp.f, xi.z);
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

    public async getDownloadUrl(xh: string, nodeHandle: string, authPw?: string) {
        const query: Record<string, string> = { x: xh };
        if (authPw) {
            query.pw = authPw;
        }
        const g = assertMegaResult(
            await this.megaApi({ a: "g", n: nodeHandle, g: 1, ssl: 2 }, query),
            "g",
        ) as { e?: number; g?: string; s?: number };

        if (typeof g.e === "number") {
            throw new Error(megaErrorMessage(g.e));
        }
        if (typeof g.g !== "string" || !/^https?:\/\//i.test(g.g)) {
            throw new Error("Transfer CDN URL missing.");
        }
        return { url: g.g, size: typeof g.s === "number" ? g.s : undefined };
    }

    private async xi(xh: string) {
        const xi = assertMegaResult(await this.megaApi({ a: "xi", xh }), "xi");
        if (!xi || typeof xi !== "object") {
            throw new Error("Transfer info failed.");
        }
        return xi as XiResponse;
    }

    private async megaApi(payload: Record<string, unknown>, query: Record<string, string> = {}) {
        const qs = new URLSearchParams(query).toString();
        const url = `${API_BASE}?${qs}`;
        const body = JSON.stringify([payload]);

        const response = await this.kd.http.request(url, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain;charset=UTF-8",
                Origin: "https://transfer.it",
                Referer: "https://transfer.it/",
            },
            body,
        });

        if (response.status === 402) {
            throw new Error("Transfer API requires Hashcash challenge (HTTP 402).");
        }
        if (response.status === 509) {
            throw new Error("Transfer bandwidth quota exceeded (HTTP 509).");
        }
        if (!response.ok) {
            throw new Error(`Transfer API HTTP ${response.status}.`);
        }

        let parsed: unknown;
        try {
            parsed = await response.json();
        } catch (error) {
            throw new Error(`Transfer API bad JSON: ${toErrorMessage(error)}`);
        }

        if (!Array.isArray(parsed)) {
            throw new Error(`Unexpected Transfer API response: ${JSON.stringify(parsed)}`);
        }
        return parsed[0];
    }

    private buildTree(nodes: MegaNode[], zipHandle: string | undefined) {
        const byHandle = new Map<string, MegaNode & { name: string; keyB64?: string }>();
        const nodeKeys = new Map<string, string>();
        let rootName = "";

        for (const node of nodes) {
            if (zipHandle && node.h === zipHandle) {
                continue;
            }

            let name = "unknown";
            let keyB64: string | undefined;
            if (typeof node.k === "string" && node.k) {
                try {
                    const keyBytes = base64urlDecode(node.k);
                    keyB64 = base64urlEncode(keyBytes);
                    if (node.a) {
                        const attr = decryptNodeAttr(node.a, keyBytes);
                        if (attr?.n) {
                            name = sanitizeName(attr.n);
                        }
                    }
                    if (node.t === 0) {
                        if (keyBytes.length !== 32) {
                            throw new Error(`Invalid file key length for node ${node.h}.`);
                        }
                        nodeKeys.set(node.h, keyB64);
                    }
                } catch (error) {
                    this.kd.logger.error(
                        { nodeHandle: node.h, message: toErrorMessage(error) },
                        "TransferItApiClient:decryptNode",
                    );
                }
            }

            byHandle.set(node.h, { ...node, name, keyB64 });
            if (node.p === "" && node.t === 1) {
                rootName = name;
            }
        }

        const childrenOf = (parent: string) =>
            [...byHandle.values()].filter((node) => node.p === parent);

        const buildDir = (dirNode: MegaNode & { name: string }): DirNode => {
            const entries: TreeEntry[] = [];
            for (const child of childrenOf(dirNode.h)) {
                if (child.t === 1) {
                    entries.push({ kind: "dir", node: buildDir(child) });
                    continue;
                }
                if (child.t === 0) {
                    const file: FileNode = {
                        type: "file",
                        id: child.h,
                        name: child.name,
                        size: typeof child.s === "number" ? child.s : 0,
                    };
                    entries.push({ kind: "file", node: file });
                }
            }
            return {
                type: "dir",
                id: dirNode.h,
                name: dirNode.name,
                entries,
            };
        };

        const root = [...byHandle.values()].find((node) => node.p === "" && node.t === 1);
        if (root) {
            // Virtual root name must be "" so FileTree / selection keys match kio.ac.
            return {
                tree: { ...buildDir(root), name: "" },
                nodeKeys,
                rootName: root.name || rootName,
            };
        }

        // Flat transfer with no explicit root folder: synthesize a root.
        const entries: TreeEntry[] = [];
        for (const child of childrenOf("")) {
            if (child.t === 1) {
                entries.push({ kind: "dir", node: buildDir(child) });
            } else if (child.t === 0) {
                entries.push({
                    kind: "file",
                    node: {
                        type: "file",
                        id: child.h,
                        name: child.name,
                        size: typeof child.s === "number" ? child.s : 0,
                    },
                });
            }
        }

        return {
            tree: {
                type: "dir" as const,
                id: "root",
                name: "",
                entries,
            },
            nodeKeys,
            rootName,
        };
    }
}
