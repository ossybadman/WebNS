/**
 * Aptos Names (.apt) chain module for webns
 *
 * Provides 10 tools:
 * - 5 query tools: resolve_name, reverse_lookup, get_name_record, check_availability, get_account_domains
 * - 5 transaction tools: build_register_tx, build_renew_tx, build_create_subname_tx,
 *   build_set_target_address_tx, build_set_default_name_tx
 */

import { z } from 'zod';
import {
    Aptos,
    AptosConfig,
    Network,
    AccountAddress,
} from '@aptos-labs/ts-sdk';
import { mcpResponse } from '../lib/helpers.mjs';

// Initialize Aptos client
const config = new AptosConfig({ network: Network.MAINNET });
const aptos = new Aptos(config);


/**
 * Register all Aptos Names tools with the MCP server
 * @param {McpServer} server - The MCP server instance
 */
export function registerAptTools(server) {
    // ==================== QUERY TOOLS ====================

    server.tool('apt_resolve_name',
        'Resolve a .apt name to an Aptos wallet address',
        { name: z.string().describe('The .apt name to resolve e.g. alice.apt') },
        async ({ name }) => {
            try {
                // Remove .apt suffix and normalize
                const domain = name.toLowerCase().replace(/\.apt$/, '');

                const result = await aptos.ans.getName({ name: domain });

                if (!result || (!result.registered_address && !result.owner_address)) {
                    return mcpResponse({ error: `Name "${name}" not found` });
                }

                return mcpResponse({
                    name: `${domain}.apt`,
                    address: result.registered_address || result.owner_address,
                    owner: result.owner_address,
                    expiration: result.expiration_timestamp,
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('apt_reverse_lookup',
        'Find the primary .apt name for an Aptos wallet address',
        { address: z.string().describe('The Aptos wallet address to look up') },
        async ({ address }) => {
            try {
                const primaryName = await aptos.ans.getPrimaryName({ address });

                if (!primaryName) {
                    return mcpResponse({ error: `No primary .apt name found for "${address}"` });
                }

                return mcpResponse({
                    address,
                    primaryName: `${primaryName}.apt`,
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('apt_get_name_record',
        'Get full details of a .apt name including expiry, owner, and target address',
        { name: z.string().describe('The .apt name to get details for') },
        async ({ name }) => {
            try {
                const domain = name.toLowerCase().replace(/\.apt$/, '');

                const result = await aptos.ans.getName({ name: domain });

                if (!result) {
                    return mcpResponse({ error: `Name "${name}" not found` });
                }

                // Calculate human-readable expiration
                const expirationDate = result.expiration_timestamp
                    ? new Date(Number(result.expiration_timestamp) * 1000).toISOString()
                    : null;

                return mcpResponse({
                    name: `${domain}.apt`,
                    owner: result.owner_address,
                    targetAddress: result.registered_address,
                    expiration: result.expiration_timestamp,
                    expirationDate,
                    isSubdomain: !!(result.subdomain && result.subdomain !== ''),
                    isPrimary: result.is_primary,
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('apt_check_availability',
        'Check if a .apt name is available to register',
        { name: z.string().describe('The .apt name to check e.g. myname.apt') },
        async ({ name }) => {
            try {
                const domain = name.toLowerCase().replace(/\.apt$/, '');

                const result = await aptos.ans.getName({ name: domain });

                // Name is available if it doesn't exist or is expired
                const now = Math.floor(Date.now() / 1000);
                const isExpired = result?.expiration_timestamp && Number(result.expiration_timestamp) < now;
                const available = !result || isExpired;

                return mcpResponse({
                    name: `${domain}.apt`,
                    available,
                    ...(isExpired && { note: 'Name is expired and can be re-registered' }),
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('apt_get_account_domains',
        'List all .apt domains owned by an account',
        {
            address: z.string().describe('The Aptos wallet address'),
            limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
            offset: z.number().min(0).default(0).describe('Pagination offset'),
        },
        async ({ address, limit, offset }) => {
            try {
                const names = await aptos.ans.getAccountNames({
                    accountAddress: address,
                    options: {
                        limit,
                        offset,
                    },
                });

                const domains = names.map(n => ({
                    name: n.subdomain && n.subdomain !== ''
                        ? `${n.subdomain}.${n.domain}.apt`
                        : `${n.domain}.apt`,
                    owner: n.owner_address,
                    targetAddress: n.registered_address,
                    expiration: n.expiration_timestamp,
                    isSubdomain: !!(n.subdomain && n.subdomain !== ''),
                    isPrimary: n.is_primary,
                }));

                return mcpResponse({
                    address,
                    domains,
                    count: domains.length,
                    hasMore: domains.length === limit,
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    // ==================== TRANSACTION TOOLS ====================

    server.tool('apt_build_register_tx',
        'Build a transaction to register a new .apt name. Returns unsigned transaction payload.',
        {
            name: z.string().describe('The name to register (without .apt suffix)'),
            owner: z.string().describe('The wallet address that will own the domain'),
            years: z.number().min(1).max(5).default(1).describe('Number of years to register'),
            targetAddress: z.string().optional().describe('Optional: Set a different target address'),
        },
        async ({ name, owner, years, targetAddress }) => {
            try {
                const domain = name.toLowerCase().replace(/\.apt$/, '');
                const target = targetAddress || owner;

                // Build the registration transaction
                const transaction = await aptos.ans.registerName({
                    name: domain,
                    sender: { accountAddress: AccountAddress.fromString(owner) },
                    expiration: { policy: 'domain', years },
                    targetAddress: target,
                });

                // Serialize to BCS bytes
                const txBytes = transaction.bcsToBytes();

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    name: `${domain}.apt`,
                    years,
                    note: 'Sign and submit this transaction with your wallet. Payment is in APT.',
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('apt_build_renew_tx',
        'Build a transaction to renew an existing .apt name. Returns unsigned transaction payload.',
        {
            name: z.string().describe('The name to renew (without .apt suffix)'),
            sender: z.string().describe('The wallet address sending the transaction'),
            years: z.number().min(1).max(5).default(1).describe('Number of years to extend'),
        },
        async ({ name, sender, years }) => {
            try {
                const domain = name.toLowerCase().replace(/\.apt$/, '');

                const transaction = await aptos.ans.renewDomain({
                    name: domain,
                    sender: { accountAddress: AccountAddress.fromString(sender) },
                    years,
                });

                const txBytes = transaction.bcsToBytes();

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    name: `${domain}.apt`,
                    years,
                    note: 'Sign and submit this transaction with your wallet',
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('apt_build_create_subname_tx',
        'Build a transaction to create a subdomain under an existing .apt name. Returns unsigned transaction payload.',
        {
            subdomain: z.string().describe('The subdomain name (e.g. "sub" for sub.domain.apt)'),
            domain: z.string().describe('The parent domain (without .apt suffix)'),
            sender: z.string().describe('The wallet address (must own the parent domain)'),
            targetAddress: z.string().optional().describe('Optional: Set a different target address'),
            expirationPolicy: z.enum(['domain', 'independent']).default('domain')
                .describe('Expiration policy: "domain" follows parent, "independent" has its own'),
            years: z.number().min(1).max(5).optional().describe('Years if using independent expiration'),
        },
        async ({ subdomain, domain, sender, targetAddress, expirationPolicy, years }) => {
            try {
                const parentDomain = domain.toLowerCase().replace(/\.apt$/, '');
                const subName = subdomain.toLowerCase();

                const expiration = expirationPolicy === 'independent'
                    ? { policy: 'subdomain:independent', years: years || 1 }
                    : { policy: 'subdomain:follow-domain' };

                const transaction = await aptos.ans.registerName({
                    name: `${subName}.${parentDomain}`,
                    sender: { accountAddress: AccountAddress.fromString(sender) },
                    expiration,
                    targetAddress: targetAddress || sender,
                });

                const txBytes = transaction.bcsToBytes();

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    name: `${subName}.${parentDomain}.apt`,
                    note: 'Sign and submit this transaction with your wallet',
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('apt_build_set_target_address_tx',
        'Build a transaction to set the target address for a .apt name. Returns unsigned transaction payload.',
        {
            name: z.string().describe('The .apt name (can include subdomain)'),
            address: z.string().describe('The target Aptos wallet address'),
            sender: z.string().describe('The wallet address (must own this name)'),
        },
        async ({ name, address, sender }) => {
            try {
                const domain = name.toLowerCase().replace(/\.apt$/, '');

                const transaction = await aptos.ans.setTargetAddress({
                    name: domain,
                    address,
                    sender: { accountAddress: AccountAddress.fromString(sender) },
                });

                const txBytes = transaction.bcsToBytes();

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and submit this transaction with your wallet',
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('apt_build_set_default_name_tx',
        'Build a transaction to set a .apt name as the primary name for the sender. Returns unsigned transaction payload.',
        {
            name: z.string().describe('The .apt name to set as primary'),
            sender: z.string().describe('The wallet address (must be the target of this name)'),
        },
        async ({ name, sender }) => {
            try {
                const domain = name.toLowerCase().replace(/\.apt$/, '');

                const transaction = await aptos.ans.setPrimaryName({
                    name: domain,
                    sender: { accountAddress: AccountAddress.fromString(sender) },
                });

                const txBytes = transaction.bcsToBytes();

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and submit this transaction with your wallet. Sender must be the target address of this name.',
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
        });
}
