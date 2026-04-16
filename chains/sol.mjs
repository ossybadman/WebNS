/**
 * SNS (.sol) Solana Name Service chain module for webns
 *
 * Provides 10 tools:
 * - 6 query tools: resolve_name, reverse_lookup, get_name_record, check_availability, get_favorite_domain, list_domains
 * - 4 transaction tools: build_register_tx, build_set_target_address_tx, build_set_default_name_tx, build_set_metadata_tx
 *
 * Note: SNS domains are perpetual - no renewal or expiry tools needed.
 */

import { z } from 'zod';
import {
    Connection,
    PublicKey,
    Transaction,
    clusterApiUrl,
} from '@solana/web3.js';
import {
    resolve,
    getDomainKeySync,
    getRecordV2,
    Record,
    registerDomainNameV2,
    updateRecordV2Instruction,
    registerFavorite,
} from '@bonfida/spl-name-service';
import { mcpResponse, mcpErrorResponse } from '../lib/helpers.mjs';

// Initialize Solana connection
const rpcUrl = process.env.SOLANA_RPC_URL || process.env.SOL_RPC_URL || clusterApiUrl('mainnet-beta');
const connection = new Connection(rpcUrl, 'confirmed');

// SNS record types
const RECORD_KEYS = {
    sol: Record.SOL,
    url: Record.Url,
    ipfs: Record.IPFS,
    arweave: Record.Arweave,
    email: Record.Email,
    twitter: Record.Twitter,
    discord: Record.Discord,
    github: Record.Github,
    telegram: Record.Telegram,
    avatar: Record.Pic,
    backpack: Record.Backpack,
};

const BONFIDA_PROXY = 'https://sns-sdk-proxy.bonfida.workers.dev';

async function proxyFetch(path) {
    const res = await fetch(`${BONFIDA_PROXY}${path}`);
    const json = await res.json();
    if (json.s !== 'ok') throw new Error(json.result || 'Proxy error');
    return json.result;
}

/**
 * Register all SNS tools with the MCP server
 * @param {McpServer} server - The MCP server instance
 */
export function registerSolTools(server) {
    // ==================== QUERY TOOLS ====================

    server.tool('sol_resolve_name',
        'Resolve a .sol name to a Solana wallet address',
        { name: z.string().describe('The .sol name to resolve e.g. bonfida.sol') },
        async ({ name }) => {
            try {
                const domain = name.toLowerCase().replace(/\.sol$/, '');
                const address = await proxyFetch(`/resolve/${domain}`);
                const { pubkey } = getDomainKeySync(domain);
                return mcpResponse({
                    name: `${domain}.sol`,
                    address,
                    domainKey: pubkey.toBase58(),
                });
            } catch (e) {
                if (e.message?.includes('Domain not found') || e.message?.includes('Invalid name account')) {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" not found`, chain: 'sol' } });
                }
                return mcpErrorResponse(e, 'sol');
            }
        });

    server.tool('sol_reverse_lookup',
        'Find the .sol name(s) for a Solana wallet address',
        { address: z.string().describe('The Solana wallet address to look up') },
        async ({ address }) => {
            try {
                // Step 1: get all domain names for this wallet
                const domains = await proxyFetch(`/domains/${address}`);
                if (!Array.isArray(domains) || domains.length === 0) {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `No .sol domains found for "${address}"`, chain: 'sol' } });
                }

                // Steps 2+3: for each domain, get its domain key then verify via reverse-lookup
                const names = [];
                for (const domain of domains) {
                    if (typeof domain !== 'string' || domain.length === 0) continue;
                    const label = domain.replace(/\.sol$/, '');
                    try {
                        // Step 2: get the domain account public key
                        const domainKey = await proxyFetch(`/domain-key/${label}`);
                        if (typeof domainKey !== 'string') continue;
                        // Step 3: reverse-lookup the domain key to confirm the name
                        const resolvedName = await proxyFetch(`/reverse-lookup/${domainKey}`);
                        if (typeof resolvedName === 'string' && resolvedName.length > 0) {
                            names.push(resolvedName.endsWith('.sol') ? resolvedName : `${resolvedName}.sol`);
                        }
                    } catch {
                        // domain key or reverse-lookup failed — fall back to the name from /domains
                        names.push(`${label}.sol`);
                    }
                }

                if (names.length === 0) {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `No .sol domains found for "${address}"`, chain: 'sol' } });
                }
                return mcpResponse({ address, names, count: names.length });
            } catch (e) { return mcpErrorResponse(e, 'sol'); }
        });

    server.tool('sol_get_name_record',
        'Get full details of a .sol name including owner and records',
        { name: z.string().describe('The .sol name to get details for') },
        async ({ name }) => {
            try {
                const domain = name.toLowerCase().replace(/\.sol$/, '');
                const { pubkey } = getDomainKeySync(domain);

                // Get owner
                const owner = await resolve(connection, domain);

                // Get common records
                const records = {};
                for (const [key, recordType] of Object.entries(RECORD_KEYS)) {
                    try {
                        const record = await getRecordV2(connection, domain, recordType);
                        if (record?.deserializedContent) {
                            records[key] = record.deserializedContent;
                        }
                    } catch {
                        // Record doesn't exist, skip
                    }
                }

                return mcpResponse({
                    name: `${domain}.sol`,
                    owner: owner.toBase58(),
                    domainKey: pubkey.toBase58(),
                    records,
                    expiration: 'never (perpetual ownership)',
                });
            } catch (e) {
                if (e.message?.includes('Invalid name account provided')) {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" not found`, chain: 'sol' } });
                }
                return mcpErrorResponse(e, 'sol');
            }
        });

    server.tool('sol_check_availability',
        'Check if a .sol name is available to register',
        { name: z.string().describe('The .sol name to check e.g. myname.sol') },
        async ({ name }) => {
            try {
                const domain = name.toLowerCase().replace(/\.sol$/, '');
                const { pubkey } = getDomainKeySync(domain);

                try {
                    await resolve(connection, domain);
                    // If resolve succeeds, the name is taken
                    return mcpResponse({ name: `${domain}.sol`, available: false });
                } catch {
                    // If resolve fails, check if account exists
                    const accountInfo = await connection.getAccountInfo(pubkey);
                    return mcpResponse({
                        name: `${domain}.sol`,
                        available: !accountInfo,
                    });
                }
            } catch (e) { return mcpErrorResponse(e, 'sol'); }
        });

    server.tool('sol_get_favorite_domain',
        'Get the favorite/primary .sol domain for a wallet',
        { address: z.string().describe('The Solana wallet address') },
        async ({ address }) => {
            try {
                const result = await proxyFetch(`/favorite-domain/${address}`);
                // result is a string or null — never assume it's a string
                if (result === null || result === undefined) {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `No favorite domain set for "${address}"`, chain: 'sol' } });
                }
                if (typeof result !== 'string') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `No favorite domain set for "${address}"`, chain: 'sol' } });
                }
                const domain = result;
                const { pubkey } = getDomainKeySync(domain);
                return mcpResponse({
                    address,
                    favoriteDomain: `${domain}.sol`,
                    domainKey: pubkey.toBase58(),
                });
            } catch (e) {
                if (e.message?.includes('favourite') || e.message?.includes('Favourite') || e.message?.includes('not found')) {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `No favorite domain set for "${address}"`, chain: 'sol' } });
                }
                return mcpErrorResponse(e, 'sol');
            }
        });

    server.tool('sol_list_domains',
        'List all .sol domains owned by a wallet',
        { address: z.string().describe('The Solana wallet address') },
        async ({ address }) => {
            try {
                const result = await proxyFetch(`/domains/${address}`);
                // result is an array of strings
                if (!Array.isArray(result) || result.length === 0) {
                    return mcpResponse({ address, domains: [], count: 0 });
                }
                const domains = result
                    .filter(n => typeof n === 'string' && n.length > 0)
                    .map(n => ({
                        name: `${n}.sol`,
                        domainKey: getDomainKeySync(n).pubkey.toBase58(),
                    }));
                return mcpResponse({ address, domains, count: domains.length });
            } catch (e) { return mcpErrorResponse(e, 'sol'); }
        });

    // ==================== TRANSACTION TOOLS ====================

    server.tool('sol_build_register_tx',
        'Build a transaction to register a new .sol name. Returns unsigned transaction bytes.',
        {
            name: z.string().describe('The name to register (without .sol suffix)'),
            owner: z.string().describe('The wallet address that will own the domain'),
            space: z.number().min(1000).max(10000).default(2000).describe('Space to allocate for records (bytes)'),
        },
        async ({ name, owner, space }) => {
            try {
                const domain = name.toLowerCase().replace(/\.sol$/, '');
                const ownerPubkey = new PublicKey(owner);

                // Build the registration instruction
                const [ixs] = await registerDomainNameV2(
                    connection,
                    domain,
                    space,
                    ownerPubkey,
                    ownerPubkey, // payer
                );

                // Create transaction
                const tx = new Transaction();
                tx.add(ixs);
                tx.feePayer = ownerPubkey;

                const latestBlockhash = await connection.getLatestBlockhash();
                tx.recentBlockhash = latestBlockhash.blockhash;

                const serialized = tx.serialize({
                    requireAllSignatures: false,
                    verifySignatures: false,
                });

                return mcpResponse({
                    txBytes: serialized.toString('base64'),
                    note: 'Sign and send this transaction with your wallet. SNS domains are perpetual - no renewal needed.',
                });
            } catch (e) { return mcpErrorResponse(e, 'sol'); }
        });

    server.tool('sol_build_set_target_address_tx',
        'Build a transaction to set the SOL record (wallet address) for a .sol name. Returns unsigned transaction bytes.',
        {
            name: z.string().describe('The .sol name'),
            address: z.string().describe('The target Solana wallet address'),
            owner: z.string().describe('The current owner of the domain (signer)'),
        },
        async ({ name, address, owner }) => {
            try {
                const domain = name.toLowerCase().replace(/\.sol$/, '');
                const ownerPubkey = new PublicKey(owner);
                const targetPubkey = new PublicKey(address);

                // Build instruction to update SOL record
                const ix = updateRecordV2Instruction(
                    domain,
                    Record.SOL,
                    targetPubkey.toBase58(),
                    ownerPubkey,
                    ownerPubkey,
                );

                const tx = new Transaction();
                tx.add(ix);
                tx.feePayer = ownerPubkey;

                const latestBlockhash = await connection.getLatestBlockhash();
                tx.recentBlockhash = latestBlockhash.blockhash;

                const serialized = tx.serialize({
                    requireAllSignatures: false,
                    verifySignatures: false,
                });

                return mcpResponse({
                    txBytes: serialized.toString('base64'),
                    note: 'Sign and send this transaction with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sol'); }
        });

    server.tool('sol_build_set_default_name_tx',
        'Build a transaction to set a .sol name as the favorite/primary name for a wallet. Returns unsigned transaction bytes.',
        {
            name: z.string().describe('The .sol name to set as favorite'),
            owner: z.string().describe('The wallet address (must own this domain)'),
        },
        async ({ name, owner }) => {
            try {
                const domain = name.toLowerCase().replace(/\.sol$/, '');
                const ownerPubkey = new PublicKey(owner);
                const { pubkey: domainKey } = getDomainKeySync(domain);

                // Build instruction to set favorite domain
                const ix = await registerFavorite(
                    connection,
                    domainKey,
                    ownerPubkey,
                );

                const tx = new Transaction();
                tx.add(ix);
                tx.feePayer = ownerPubkey;

                const latestBlockhash = await connection.getLatestBlockhash();
                tx.recentBlockhash = latestBlockhash.blockhash;

                const serialized = tx.serialize({
                    requireAllSignatures: false,
                    verifySignatures: false,
                });

                return mcpResponse({
                    txBytes: serialized.toString('base64'),
                    note: 'Sign and send this transaction with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sol'); }
        });

    server.tool('sol_build_set_metadata_tx',
        'Build a transaction to set a record on a .sol name (URL, IPFS, Twitter, etc). Returns unsigned transaction bytes.',
        {
            name: z.string().describe('The .sol name'),
            key: z.enum(['url', 'ipfs', 'arweave', 'email', 'twitter', 'discord', 'github', 'telegram', 'avatar', 'backpack'])
                .describe('The record type to set'),
            value: z.string().describe('The value to set'),
            owner: z.string().describe('The current owner of the domain (signer)'),
        },
        async ({ name, key, value, owner }) => {
            try {
                const domain = name.toLowerCase().replace(/\.sol$/, '');
                const ownerPubkey = new PublicKey(owner);
                const recordType = RECORD_KEYS[key];

                if (!recordType) {
                    return mcpResponse({ error: { code: 'INVALID_PARAMS', message: `Unknown record type: ${key}`, chain: 'sol' } });
                }

                const ix = updateRecordV2Instruction(
                    domain,
                    recordType,
                    value,
                    ownerPubkey,
                    ownerPubkey,
                );

                const tx = new Transaction();
                tx.add(ix);
                tx.feePayer = ownerPubkey;

                const latestBlockhash = await connection.getLatestBlockhash();
                tx.recentBlockhash = latestBlockhash.blockhash;

                const serialized = tx.serialize({
                    requireAllSignatures: false,
                    verifySignatures: false,
                });

                return mcpResponse({
                    txBytes: serialized.toString('base64'),
                    note: `Sign and send this transaction to set the ${key} record`,
                });
            } catch (e) { return mcpErrorResponse(e, 'sol'); }
        });
}
