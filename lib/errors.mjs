/**
 * Standardized error codes and response shapes for webns
 */

/**
 * Wrap data in MCP response format. Defined here (not in helpers.mjs) so
 * mcpErrorResponse can use it without creating a circular dependency.
 * helpers.mjs re-exports this as the single source of truth.
 * @param {object} data
 * @returns {object} MCP-formatted response
 */
export function mcpResponse(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export const ErrorCode = {
    NOT_FOUND: 'NOT_FOUND',
    INVALID_NAME: 'INVALID_NAME',
    RPC_ERROR: 'RPC_ERROR',
    RATE_LIMITED: 'RATE_LIMITED',
    TIMEOUT: 'TIMEOUT',
    UNSUPPORTED_CHAIN: 'UNSUPPORTED_CHAIN',
    OWNERSHIP_ERROR: 'OWNERSHIP_ERROR',
    INVALID_PARAMS: 'INVALID_PARAMS',
    UNKNOWN: 'UNKNOWN',
};

/**
 * Map a raw exception to an ErrorCode by inspecting message and existing code.
 * @param {Error} err
 * @returns {string} One of the ErrorCode values
 */
export function classifyError(err) {
    // Trust explicit codes attached by our own code
    if (err?.code && Object.values(ErrorCode).includes(err.code)) return err.code;

    const msg = (err?.message || '').toLowerCase();

    if (/429|rate.?limit|too many request/.test(msg)) return ErrorCode.RATE_LIMITED;
    if (/timeout|timed.?out|etimedout/.test(msg)) return ErrorCode.TIMEOUT;
    if (/econnreset|econnrefused|network|socket hang up|fetch failed/.test(msg)) return ErrorCode.RPC_ERROR;
    if (/not found|does not exist|no address|no resolver|no primary|invalid name account|domain not found/.test(msg)) return ErrorCode.NOT_FOUND;
    if (/normalize|invalid label|invalid name|invalid tld/.test(msg)) return ErrorCode.INVALID_NAME;
    if (/ownership|kiosk|kioskownercap/.test(msg)) return ErrorCode.OWNERSHIP_ERROR;
    if (/insufficient|missing param|required/.test(msg)) return ErrorCode.INVALID_PARAMS;
    if (/unsupported chain|unknown tld/.test(msg)) return ErrorCode.UNSUPPORTED_CHAIN;

    return ErrorCode.UNKNOWN;
}

/**
 * Build a standardized MCP error response.
 * @param {Error} err - The raw error
 * @param {string|null} chain - Chain identifier (e.g. 'ens', 'sol')
 * @param {string} [overrideCode] - Optional explicit ErrorCode override
 * @returns {object} MCP response with error shape
 */
export function mcpErrorResponse(err, chain, overrideCode) {
    const code = overrideCode || classifyError(err);
    const payload = { code, message: err?.message || String(err) };
    if (chain) payload.chain = chain;
    if (err?.details) payload.details = err.details;
    return mcpResponse({ error: payload });
}
