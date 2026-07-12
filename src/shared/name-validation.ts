// oxlint-disable-next-line no-control-regex
const INVALID_CHARS_REGEX = /[<>:"/\\|?*\u0000-\u001F]/;
const RESERVED_NAMES_REGEX = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const ONLY_DOTS_REGEX = /^\.+$/;

export function validateRenameName(name: string): string | null {
    const trimmed = name.trim();

    if (trimmed.length === 0) {
        return "이름을 입력하세요.";
    }

    if (trimmed.length > 255) {
        return "이름이 너무 깁니다. (최대 255자)";
    }

    if (trimmed.includes("/")) {
        return "이름에 '/'를 사용할 수 없습니다.";
    }

    // oxlint-disable-next-line no-control-regex
    if (INVALID_CHARS_REGEX.test(trimmed)) {
        return '이름에 사용할 수 없는 문자가 있습니다. (\\ / : * ? " < > |)';
    }

    if (ONLY_DOTS_REGEX.test(trimmed)) {
        return "이름이 점(.)으로만 이루어질 수 없습니다.";
    }

    if (trimmed.endsWith(" ") || trimmed.endsWith(".")) {
        return "이름은 공백이나 점으로 끝날 수 없습니다.";
    }

    if (RESERVED_NAMES_REGEX.test(trimmed)) {
        return "예약된 이름은 사용할 수 없습니다. (CON, PRN, AUX, NUL, COM1-9, LPT1-9)";
    }

    return null;
}
