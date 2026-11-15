import { createCipheriv, randomBytes } from "node:crypto";

import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import type { DirNode } from "@shared/types";
import { describe, expect, it, vi } from "vitest";

import type { ControlRequestOptions } from "../../lib/http";

import { MegaApiClient } from "./mega-api-client";

const folderKey = randomBytes(16);
const rootKey = randomBytes(16);
const subKey = randomBytes(16);
const fileKeys = [randomBytes(32), randomBytes(32), randomBytes(32)];

const nodes = [
    folderNode("ROOTHAND", "OWNERPAR", "Root", rootKey),
    folderNode("SUBHANDL", "ROOTHAND", "Sub", subKey),
    fileNode("FILE0001", "ROOTHAND", "a.txt", fileKeys[0]!),
    fileNode("FILE0002", "ROOTHAND", "a.txt", fileKeys[1]!),
    fileNode("FILE0003", "SUBHANDL", "b.bin", fileKeys[2]!),
];

describe("MegaApiClient folder links", () => {
    it("decrypts node keys under the folder key and keeps duplicate names apart", async () => {
        const { client, request } = createClient("SESSION");
        const loaded = await client.loadCollection({ url: folderUrl(folderKey) });

        expect(request.mock.calls[0]?.[0]).toMatch(/[?&]n=LINKHAND(&|$)/);
        expect(request.mock.calls[0]?.[0]).toMatch(/[?&]sid=SESSION(&|$)/);
        expect(loaded.collection.name).toBe("Root");
        expect(loaded.folderHandle).toBe("LINKHAND");
        expect(treeNames(loaded.collection.tree)).toEqual(["Sub/b.bin", "a.txt", "a (1).txt"]);
        expect(loaded.nodeKeys).toEqual(
            new Map([
                ["FILE0001", fileKeys[0]!.toString("base64url")],
                ["FILE0002", fileKeys[1]!.toString("base64url")],
                ["FILE0003", fileKeys[2]!.toString("base64url")],
            ]),
        );
    });

    it("limits a sub-folder link to that folder", async () => {
        const loaded = await createClient().client.loadCollection({
            url: `${folderUrl(folderKey)}/folder/SUBHANDL`,
        });
        expect(loaded.collection.name).toBe("Sub");
        expect(treeNames(loaded.collection.tree)).toEqual(["b.bin"]);
    });

    it("asks for a missing key and rejects a wrong one", async () => {
        const { client } = createClient();
        await expect(
            client.loadCollection({ url: "https://mega.nz/folder/LINKHAND" }),
        ).rejects.toThrow(COLLECTION_PASSWORD_REQUIRED_ERROR);
        await expect(client.loadCollection({ url: folderUrl(randomBytes(16)) })).rejects.toThrow(
            COLLECTION_INVALID_PASSWORD_ERROR,
        );
        const loaded = await client.loadCollection({
            url: "https://mega.nz/folder/LINKHAND",
            password: folderKey.toString("base64url"),
        });
        expect(loaded.passwordProtected).toBe(true);
    });
});

function createClient(sid?: string) {
    const request = vi.fn(
        async (_url: string, _options: ControlRequestOptions) =>
            new Response(JSON.stringify([{ f: nodes }])),
    );
    const kd = {
        http: {
            consumeControlResponse: async <T>(
                url: string,
                options: ControlRequestOptions,
                consume: (response: Response) => Promise<T>,
            ) => consume(await request(url, options)),
        },
        logger: { error: vi.fn() },
        service: { mega: { getSessionId: () => sid, generation: 0 } },
    };
    return { client: new MegaApiClient(kd as never), request };
}

function folderUrl(key: Buffer) {
    return `https://mega.nz/folder/LINKHAND#${key.toString("base64url")}`;
}

function folderNode(h: string, p: string, name: string, key: Buffer) {
    return { h, p, t: 1, a: encryptAttr(name, key), k: `ROOTHAND:${ecb(key)}` };
}

function fileNode(h: string, p: string, name: string, key: Buffer) {
    const attrKey = Buffer.from(key.subarray(0, 16).map((value, i) => value ^ key[16 + i]!));
    return { h, p, t: 0, s: 10, a: encryptAttr(name, attrKey), k: `ROOTHAND:${ecb(key)}` };
}

function ecb(key: Buffer) {
    const cipher = createCipheriv("aes-128-ecb", folderKey, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(key), cipher.final()]).toString("base64url");
}

function encryptAttr(name: string, key: Buffer) {
    const plain = Buffer.from(`MEGA${JSON.stringify({ n: name })}`, "utf8");
    const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64url");
}

function treeNames(dir: DirNode, prefix = ""): string[] {
    return dir.entries.flatMap((entry) =>
        entry.kind === "dir"
            ? treeNames(entry.node as DirNode, `${prefix}${entry.node.name}/`)
            : [`${prefix}${entry.node.name}`],
    );
}
