import { toErrorMessage } from "@shared/utils";

import type { Logger } from "../logger";

export function logCaughtError(
    logger: Logger,
    where: string,
    context: Record<string, unknown>,
    error: unknown,
) {
    logger.error(
        {
            ...sanitizeLogContext(context),
            message: toErrorMessage(error),
            // Only the stack is added: other enumerable fields and `cause` can carry request URLs
            // with credentials or tokens that sanitizeLogContext never sees.
            stack: error instanceof Error ? error.stack : undefined,
        },
        where,
    );
}

export async function withLoggedError<T>(
    logger: Logger,
    where: string,
    context: Record<string, unknown>,
    fn: () => Promise<T> | T,
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        logCaughtError(logger, where, context, error);
        throw error;
    }
}

function sanitizeLogContext(context: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(context).map(([key, value]) => [
            key,
            typeof value === "string" && key.toLowerCase().includes("url")
                ? sanitizeUrl(value)
                : value,
        ]),
    );
}

function sanitizeUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
    } catch {
        return "[invalid URL]";
    }
}
