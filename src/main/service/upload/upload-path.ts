import { validateNodeName } from "@shared/tree-rename";

export function isKioskCompatiblePath(filePath: string) {
    return filePath.split("/").every((segment) => validateNodeName(segment) == null);
}
