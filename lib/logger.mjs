/**
 * Structured logging for webns tool calls and results
 */

export function logToolCall(tool, args) {
  console.log(JSON.stringify({
    event: 'tool_call',
    tool,
    args,
    ts: new Date().toISOString(),
  }));
}

export function logToolResult(tool, durationMs, error = null) {
  console.log(JSON.stringify({
    event: 'tool_result',
    tool,
    durationMs,
    status: error ? 'error' : 'ok',
    error: error?.message ?? null,
    ts: new Date().toISOString(),
  }));
}

/**
 * Wraps a tool handler with logToolCall / logToolResult on every code path.
 * Works with the existing pattern where errors are returned (not thrown) as
 * mcpErrorResponse — peeks at the returned JSON to detect error responses.
 *
 * @param {string} tool - Tool name
 * @param {Function} fn - The async handler function
 * @returns {Function} Wrapped handler
 */
export function withLogging(tool, fn) {
  return async (args) => {
    logToolCall(tool, args);
    const t = Date.now();
    try {
      const result = await fn(args);
      let logErr = null;
      try {
        const body = JSON.parse(result.content[0].text);
        if (body.error) logErr = { message: body.error.message ?? JSON.stringify(body.error) };
      } catch {}
      logToolResult(tool, Date.now() - t, logErr);
      return result;
    } catch (err) {
      logToolResult(tool, Date.now() - t, err);
      throw err;
    }
  };
}
