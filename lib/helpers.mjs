/**
 * Shared helper utilities for webns
 */

/**
 * Wrap data in MCP response format
 * @param {object} data - The data to return
 * @returns {object} MCP-formatted response
 */
export function mcpResponse(data) {
    return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
    };
}

/**
 * Format SuiNS price list into human-readable object
 * @param {Map} priceList - SuiNS price list map
 * @returns {object} Formatted prices by name length
 */
export function formatSuiPrices(priceList) {
    const map = Object.fromEntries(priceList);
    return {
        '3-letter': Number(map['3,3']) / 1_000_000,
        '4-letter': Number(map['4,4']) / 1_000_000,
        '5+-letter': Number(map['5,63']) / 1_000_000,
    };
}

/**
 * Detect the chain from a name's TLD
 * @param {string} name - The name to detect (e.g., "nick.eth", "alice.sui")
 * @returns {string|null} Chain identifier or null if unknown
 */
export function detectChainFromName(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.sui')) return 'sui';
    if (lower.endsWith('.base.eth')) return 'base';
    if (lower.endsWith('.eth')) return 'ens';
    if (lower.endsWith('.sol')) return 'sol';
    if (lower.endsWith('.apt')) return 'apt';
    return null;
}

/**
 * Format ETH prices (wei to ETH)
 * @param {bigint} wei - Amount in wei
 * @returns {string} Formatted ETH amount
 */
export function formatEthPrice(wei) {
    return (Number(wei) / 1e18).toFixed(6);
}

/**
 * Format Solana prices (lamports to SOL)
 * @param {number} lamports - Amount in lamports
 * @returns {string} Formatted SOL amount
 */
export function formatSolPrice(lamports) {
    return (lamports / 1e9).toFixed(9);
}

/**
 * Format Aptos prices (octas to APT)
 * @param {number} octas - Amount in octas
 * @returns {string} Formatted APT amount
 */
export function formatAptPrice(octas) {
    return (octas / 1e8).toFixed(8);
}
