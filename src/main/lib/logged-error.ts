import { toErrorMessage } from "@shared/utils";

import type { Logger } from "../logger";

export async function withLoggedError<T>(
    logger: Logger,
    where: string,
    context: Record<string, unknown>,
    fn: () => Promise<T> | T,
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        logger.error({ ...context, message: toErrorMessage(error) }, where);
        throw error;
    }
}
