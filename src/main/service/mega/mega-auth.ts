import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";

import { base64urlDecode, base64urlEncode } from "../download/transfer-it-crypto";

const V1_INITIAL_KEY = Buffer.from([
    0x93, 0xc4, 0x67, 0xe3, 0x7d, 0xb0, 0xc7, 0xa4, 0xd1, 0xbe, 0x3f, 0x81, 0x01, 0x52, 0xcb, 0x56,
]);
const V1_PREPARE_ROUNDS = 65_536;
const V1_STRINGHASH_ROUNDS = 16_384;
const V2_PBKDF2_ROUNDS = 100_000;
const SESSION_ID_BYTES = 43;
const SESSION_PLAINTEXT_BYTES = 255;

export type MegaLoginCredentials = {
    passwordKey: Buffer;
    userHash: string;
};

/** Accounts created or re-keyed since 2018 (`us0` returns `v: 2` and a salt). */
export function deriveMegaV2Credentials(password: string, saltB64: string): MegaLoginCredentials {
    const derived = pbkdf2Sync(
        Buffer.from(password, "utf8"),
        base64urlDecode(saltB64),
        V2_PBKDF2_ROUNDS,
        32,
        "sha512",
    );
    return {
        passwordKey: derived.subarray(0, 16),
        userHash: base64urlEncode(derived.subarray(16, 32)),
    };
}

/** Legacy accounts (`us0` returns `v: 1`): `prepare_key` + `stringhash` from the MEGA web client. */
export function deriveMegaV1Credentials(email: string, password: string): MegaLoginCredentials {
    const passwordBytes = zeroPad16(Buffer.from(password, "utf8"));
    const ciphers = Array.from({ length: passwordBytes.length / 16 }, (_, index) =>
        ecbCipher(passwordBytes.subarray(index * 16, index * 16 + 16)),
    );
    let passwordKey = Buffer.from(V1_INITIAL_KEY);
    for (let round = 0; round < V1_PREPARE_ROUNDS; round++) {
        for (const cipher of ciphers) {
            passwordKey = cipher.update(passwordKey);
        }
    }

    const emailBytes = Buffer.from(email, "utf8");
    let hash = Buffer.alloc(16);
    for (let i = 0; i < emailBytes.length; i++) {
        hash[i % 16] = hash[i % 16]! ^ emailBytes[i]!;
    }
    const hashCipher = ecbCipher(passwordKey);
    for (let round = 0; round < V1_STRINGHASH_ROUNDS; round++) {
        hash = hashCipher.update(hash);
    }
    return {
        passwordKey,
        userHash: base64urlEncode(Buffer.concat([hash.subarray(0, 4), hash.subarray(8, 12)])),
    };
}

export function decryptMegaMasterKey(encryptedMasterKeyB64: string, passwordKey: Buffer) {
    const masterKey = ecbDecrypt(base64urlDecode(encryptedMasterKeyB64), passwordKey);
    if (masterKey.length !== 16) {
        throw new Error(`Unexpected master key length ${masterKey.length}.`);
    }
    return masterKey;
}

/**
 * Recovers the session id from `csid`: the RSA private key (`privk`, AES-ECB under the master key)
 * holds MPIs p, q, d, u; the session id is the first 43 bytes of `csid^d mod pq`.
 */
export function decryptMegaSessionId(
    csidB64: string,
    privkB64: string,
    masterKey: Buffer,
    userHandle: string,
) {
    const privk = ecbDecrypt(base64urlDecode(privkB64), masterKey);
    const reader = mpiReader(privk);
    const p = reader.next();
    const q = reader.next();
    const d = reader.next();
    const ciphertext = mpiReader(base64urlDecode(csidB64)).next();
    const plain = bigIntToBytes(modPow(ciphertext, d, p * q), SESSION_PLAINTEXT_BYTES);
    if (
        plain.length !== SESSION_PLAINTEXT_BYTES ||
        typeof userHandle !== "string" ||
        userHandle.length !== 11 ||
        plain.toString("latin1", 16, 27) !== userHandle
    ) {
        throw new Error("Invalid MEGA session id.");
    }
    return base64urlEncode(plain.subarray(0, SESSION_ID_BYTES));
}

function ecbCipher(key: Buffer) {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(false);
    return cipher;
}

function ecbDecrypt(data: Buffer, key: Buffer) {
    if (data.length === 0 || data.length % 16 !== 0) {
        throw new Error(`Invalid MEGA encrypted key length ${data.length}.`);
    }
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

function zeroPad16(data: Buffer) {
    const padded = Buffer.alloc(Math.max(16, Math.ceil(data.length / 16) * 16));
    data.copy(padded);
    return padded;
}

/** MPI = 2-byte big-endian bit length followed by the value bytes. */
function mpiReader(data: Buffer) {
    let offset = 0;
    return {
        next() {
            if (offset + 2 > data.length) {
                throw new Error("Truncated MPI.");
            }
            const byteLength = Math.ceil(data.readUInt16BE(offset) / 8);
            offset += 2;
            if (offset + byteLength > data.length) {
                throw new Error("Truncated MPI.");
            }
            const value = data.subarray(offset, offset + byteLength);
            offset += byteLength;
            return value.length === 0 ? 0n : BigInt(`0x${value.toString("hex")}`);
        },
    };
}

function modPow(base: bigint, exponent: bigint, modulus: bigint) {
    let result = 1n;
    let b = base % modulus;
    let e = exponent;
    while (e > 0n) {
        if (e & 1n) {
            result = (result * b) % modulus;
        }
        b = (b * b) % modulus;
        e >>= 1n;
    }
    return result;
}

/** Left-pads to `length` bytes: the session id's leading bytes are random and may be zero. */
function bigIntToBytes(value: bigint, length: number) {
    const hex = value.toString(16);
    return Buffer.from(
        hex.padStart(Math.max(length * 2, hex.length + (hex.length % 2)), "0"),
        "hex",
    );
}
