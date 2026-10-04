/**
 * pg-boss treats an extraction attempt still running after this long as failed (and retries it).
 * Below the recovery sweep's 10-minute threshold, so a hung attempt is retried before it is
 * swept. No imports, so config validation can check the provider timeout against it.
 */
export const EXTRACT_EXPIRE_SECONDS = 5 * 60;
