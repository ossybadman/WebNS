/**
 * Retry with exponential backoff and jitter for webns
 */

const RETRYABLE = (msg) =>
    /429|rate.?limit|too many request|econnreset|econnrefused|etimedout|network|socket hang up|fetch failed|timeout/i.test(msg);

const NOT_RETRYABLE = (msg) =>
    /not found|does not exist|invalid|normalize|unsupported|ownership|kiosk|insufficient|missing param/i.test(msg);

/**
 * Execute fn with exponential backoff retries.
 * Retries on: HTTP 429, rate limit messages, network errors, timeouts.
 * Does not retry on: not-found, invalid params, ownership errors.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} options
 * @param {number} options.maxAttempts - Maximum number of attempts (default 4)
 * @param {number} options.baseDelayMs - Base delay in ms before first retry (default 200)
 * @param {string} options.label - Label for logging (default '')
 * @returns {Promise<*>} Result of fn
 */
export async function withRetry(fn, { maxAttempts = 4, baseDelayMs = 200, label = '' } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const msg = err?.message || '';

            // Never retry on business-logic errors
            if (NOT_RETRYABLE(msg)) throw err;

            // Only retry on known transient errors
            if (!RETRYABLE(msg)) throw err;

            // Last attempt — don't sleep, just throw
            if (attempt === maxAttempts) break;

            // Exponential backoff: base * 2^(attempt-1), ±30% jitter
            const base = baseDelayMs * Math.pow(2, attempt - 1);
            const jitter = base * 0.3 * (Math.random() * 2 - 1);
            const delay = Math.max(0, Math.round(base + jitter));
            console.warn(`[retry] ${label} attempt ${attempt} failed: ${msg} — retrying in ${delay}ms`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
