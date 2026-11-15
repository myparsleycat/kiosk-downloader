import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptMegaMasterKey, decryptMegaSessionId } from "./mega-auth";

describe("MEGA login session decryption", () => {
    it.each([
        { name: "valid session", length: 255, userHandle: "abcdefghijk", valid: true },
        {
            name: "session id starting with a zero byte",
            length: 255,
            userHandle: "abcdefghijk",
            valid: true,
            firstByte: 0,
        },
        { name: "43-byte plaintext", length: 43, userHandle: "abcdefghijk", valid: false },
        { name: "254-byte plaintext", length: 254, userHandle: "abcdefghijk", valid: false },
        { name: "256-byte plaintext", length: 256, userHandle: "abcdefghijk", valid: false },
        { name: "wrong user handle", length: 255, userHandle: "abcdefghijL", valid: false },
        { name: "short user handle", length: 255, userHandle: "abcdefghij", valid: false },
        { name: "long user handle", length: 255, userHandle: "abcdefghijkl", valid: false },
    ])(
        "validates $name before returning the session id",
        ({ length, userHandle, valid, firstByte }) => {
            const { privateKey } = generateKeyPairSync("rsa", {
                modulusLength: 2048,
                publicExponent: 65537,
            });
            const jwk = privateKey.export({ format: "jwk" });
            const p = fromB64(jwk.p!);
            const q = fromB64(jwk.q!);
            const d = fromB64(jwk.d!);
            const n = p * q;

            const passwordKey = randomBytes(16);
            const masterKey = randomBytes(16);
            const sidBytes = Buffer.concat([
                Buffer.from([firstByte ?? 0x7f]),
                randomBytes(15),
                Buffer.from("abcdefghijk"),
                randomBytes(16),
            ]);
            const message = BigInt(
                `0x${Buffer.concat([sidBytes, randomBytes(length - sidBytes.length)]).toString("hex")}`,
            );
            const csid = mpi(modPow(message, 65537n, n));
            const privk = Buffer.concat([mpi(p), mpi(q), mpi(d), mpi(modInverse(p, q))]);

            const k = ecbEncrypt(masterKey, passwordKey).toString("base64url");
            const recoveredMaster = decryptMegaMasterKey(k, passwordKey);
            expect(recoveredMaster).toEqual(masterKey);
            const decryptSession = () =>
                decryptMegaSessionId(
                    csid.toString("base64url"),
                    ecbEncrypt(pad16(privk), masterKey).toString("base64url"),
                    recoveredMaster,
                    userHandle,
                );
            if (valid) {
                expect(decryptSession()).toBe(sidBytes.toString("base64url"));
                return;
            }
            expect(decryptSession).toThrow("Invalid MEGA session id.");
        },
    );
});

function fromB64(value: string) {
    return BigInt(`0x${Buffer.from(value, "base64url").toString("hex")}`);
}

function toBytes(value: bigint) {
    const hex = value.toString(16);
    return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
}

function mpi(value: bigint) {
    const bytes = toBytes(value);
    const header = Buffer.alloc(2);
    header.writeUInt16BE(value.toString(2).length);
    return Buffer.concat([header, bytes]);
}

function pad16(data: Buffer) {
    return Buffer.concat([data, Buffer.alloc((16 - (data.length % 16)) % 16)]);
}

function ecbEncrypt(data: Buffer, key: Buffer) {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint) {
    let result = 1n;
    let b = base % modulus;
    for (let e = exponent; e > 0n; e >>= 1n) {
        if (e & 1n) result = (result * b) % modulus;
        b = (b * b) % modulus;
    }
    return result;
}

function modInverse(a: bigint, m: bigint) {
    let [oldR, r] = [a % m, m];
    let [oldS, s] = [1n, 0n];
    while (r !== 0n) {
        const quotient = oldR / r;
        [oldR, r] = [r, oldR - quotient * r];
        [oldS, s] = [s, oldS - quotient * s];
    }
    return ((oldS % m) + m) % m;
}
