import { createHash } from "node:crypto";

const TOKEN_REPEAT = 262_144;
const TOKEN_BYTES = 48;

/**
 * Solves a MEGA `X-Hashcash: 1:<easiness>:<timestamp>:<token>` challenge: find a 4-byte prefix
 * whose SHA-256 over `prefix || token × 262144` starts with a big-endian uint32 ≤ threshold.
 * Returns the `X-Hashcash` request header value.
 */
export function solveHashcashChallenge(challenge: string) {
    const parts = challenge.split(":");
    if (parts[0] !== "1" || parts.length < 4) {
        throw new Error(`Unsupported Hashcash challenge: ${challenge}`);
    }
    const easiness = Number(parts[1]);
    const token = parts[3]!;
    const tokenBytes = Buffer.from(token, "base64url");
    if (!Number.isInteger(easiness) || easiness < 0 || easiness > 255) {
        throw new Error(`Invalid Hashcash easiness: ${parts[1]}`);
    }
    if (tokenBytes.length !== TOKEN_BYTES) {
        throw new Error(`Invalid Hashcash token length ${tokenBytes.length}.`);
    }

    const threshold = hashcashThreshold(easiness);
    const buffer = Buffer.alloc(4 + TOKEN_REPEAT * TOKEN_BYTES);
    for (let i = 0; i < TOKEN_REPEAT; i++) {
        tokenBytes.copy(buffer, 4 + i * TOKEN_BYTES);
    }

    for (;;) {
        if (createHash("sha256").update(buffer).digest().readUInt32BE(0) <= threshold) {
            return `1:${token}:${buffer.subarray(0, 4).toString("base64url")}`;
        }
        for (let j = 0; j < 4; j++) {
            buffer[j] = (buffer[j]! + 1) & 0xff;
            if (buffer[j] !== 0) {
                break;
            }
        }
    }
}

export function hashcashThreshold(easiness: number) {
    return (((easiness & 63) << 1) + 1) * 2 ** ((easiness >> 6) * 7 + 3);
}
