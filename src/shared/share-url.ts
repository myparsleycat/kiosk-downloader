export const SHARE_HOST = "kio.ac";
export const SHARE_PATH_PREFIX = "/c/";
export const SHARE_ID_LENGTH = 22;

const UUID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
const UUID_DECODE_TABLE = new Map(UUID_ALPHABET.split("").map((char, index) => [char, index]));

export function tryExtractShareId(url: string) {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        return null;
    }

    if (parsed.hostname !== SHARE_HOST && parsed.hostname !== `www.${SHARE_HOST}`) {
        return null;
    }
    if (!parsed.pathname.startsWith(SHARE_PATH_PREFIX)) {
        return null;
    }

    const shareId = parsed.pathname.slice(SHARE_PATH_PREFIX.length).split("/")[0];
    if (!shareId || shareId.length !== SHARE_ID_LENGTH) {
        return null;
    }

    return shareId;
}

export function shareIdToUuidBytes(shareId: string) {
    if (shareId.length !== SHARE_ID_LENGTH) {
        throw new Error(`Invalid share id length ${shareId.length} (expected ${SHARE_ID_LENGTH}).`);
    }

    const bytes = new Uint8Array(16);
    let bitPos = 0;
    let bytePos = 0;

    for (let sourceIndex = SHARE_ID_LENGTH - 1; sourceIndex >= 0; sourceIndex -= 1) {
        const char = shareId[sourceIndex];
        const value = UUID_DECODE_TABLE.get(char);
        if (value == null) {
            throw new Error(`Invalid character "${char}" in share id.`);
        }

        for (let charBit = 0; charBit < 6 && bytePos < 16; charBit += 1) {
            const bit = (value >> charBit) & 1;
            bytes[bytePos] |= bit << bitPos;
            bitPos += 1;
            if (bitPos === 8) {
                bitPos = 0;
                bytePos += 1;
            }
        }
    }

    return bytes;
}

export function tryParseShareUrl(url: string) {
    const shareId = tryExtractShareId(url);
    if (!shareId) {
        return null;
    }

    try {
        shareIdToUuidBytes(shareId);
    } catch {
        return null;
    }

    return shareId;
}
