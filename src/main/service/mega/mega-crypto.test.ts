import { createCipheriv, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

import fse from "fs-extra";
import { afterEach, describe, expect, it } from "vitest";

import { computeMegaMetaMac, decodeMegaEncodedLink, verifyMegaFileMac } from "./mega-crypto";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fse.remove(dir)));
});

describe("MEGA file MAC", () => {
    // Sizes straddle the growing chunk boundaries (128K, 384K, ... 4608K) and the 1 MiB tail.
    it.each([0, 1, 16, 131_071, 131_073, 393_216, 4_718_592 + 17])(
        "verifies a %i-byte file and rejects a corrupted copy",
        async (size) => {
            const plain = randomBytes(size);
            const aesKey = randomBytes(16);
            const nonce = randomBytes(8);
            const mac = referenceMetaMac(plain, aesKey, nonce);
            const key32 = Buffer.concat([xor(aesKey, Buffer.concat([nonce, mac])), nonce, mac]);
            const file = await writeTemp(plain);

            await expect(computeMegaMetaMac(file, key32)).resolves.toEqual(mac);
            await expect(verifyMegaFileMac(file, key32)).resolves.toBeUndefined();
            if (size > 0) {
                plain[size - 1] = plain[size - 1]! ^ 1;
                await fse.writeFile(file, plain);
                await expect(verifyMegaFileMac(file, key32)).rejects.toMatchObject({
                    name: "MegaMacMismatchError",
                });
            }
        },
    );
});

describe("decodeMegaEncodedLink", () => {
    const fileKey = "A".repeat(43);

    it("decodes a legacy static-IV enc link", () => {
        const payload = encryptLinkPayload(`!abcd1234!${fileKey}`, v1Key(), LEGACY_IV, false);
        expect(
            decodeMegaEncodedLink({ type: "encoded", kind: "file", version: 1, payload }),
        ).toEqual({ type: "public", kind: "file", handle: "abcd1234", key: fileKey });
    });

    it("falls back to the enc2 key and reads the random-IV framing", () => {
        const folderKey = "B".repeat(22);
        const payload = encryptLinkPayload(
            `!root1234!${folderKey}`,
            v2Key(),
            randomBytes(16),
            true,
        );
        expect(
            decodeMegaEncodedLink({ type: "encoded", kind: "folder", version: 2, payload }),
        ).toEqual({ type: "public", kind: "folder", handle: "root1234", key: folderKey });
    });
});

// Word-by-word formulation of the MEGA SDK chunk MAC, independent of the CBC shortcut.
function referenceMetaMac(data: Buffer, aesKey: Buffer, nonce: Buffer) {
    const cipher = createCipheriv("aes-128-ecb", aesKey, null);
    cipher.setAutoPadding(false);
    const encrypt = (block: Buffer) => cipher.update(block);
    let fileMac = Buffer.alloc(16);
    let offset = 0;
    for (let chunk = 1; offset < data.length; chunk++) {
        const end = Math.min(data.length, offset + (chunk <= 8 ? chunk * 131_072 : 1_048_576));
        let mac = Buffer.concat([nonce, nonce]);
        for (let block = offset; block < end; block += 16) {
            const bytes = Buffer.alloc(16);
            data.copy(bytes, 0, block, Math.min(end, block + 16));
            mac = encrypt(xor(mac, bytes));
        }
        fileMac = encrypt(xor(fileMac, mac));
        offset = end;
    }
    return Buffer.concat([
        xor(fileMac.subarray(0, 4), fileMac.subarray(4, 8)),
        xor(fileMac.subarray(8, 12), fileMac.subarray(12, 16)),
    ]);
}

function xor(a: Buffer, b: Buffer) {
    return Buffer.from(a.map((value, index) => value ^ b[index]!));
}

async function writeTemp(data: Buffer) {
    const dir = await fse.mkdtemp(path.join(os.tmpdir(), "mega-mac-"));
    tempDirs.push(dir);
    const file = path.join(dir, "file.bin");
    await fse.writeFile(file, data);
    return file;
}

// MegaDownloader link-obfuscation format (URLExtractor.vb / Criptografia.vb), used to build fixtures.
const LEGACY_IV = Buffer.from([121, 241, 10, 1, 132, 74, 11, 39, 255, 91, 45, 78, 14, 211, 22, 62]);

function v1Key() {
    return Buffer.from("k1o6Al-1kz?!z05yXXXXXXXXXXXXXXXX", "ascii");
}

function v2Key() {
    const key = Buffer.from("nYrXa@9Q?1&hCWM\\9(731Bp?t42=!k3.", "ascii");
    const xorBytes = [12, 57, 251, 120, 18, 75, 6, 250, 85];
    for (let i = 0; i < 160; i++) {
        key[i % 32] = key[i % 32]! ^ xorBytes[i % 9]!;
    }
    return key;
}

function encryptLinkPayload(link: string, key: Buffer, iv: Buffer, framed: boolean) {
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(link, "ascii"), cipher.final()]);
    return (framed ? Buffer.concat([Buffer.from([1]), iv, encrypted]) : encrypted).toString(
        "base64url",
    );
}
