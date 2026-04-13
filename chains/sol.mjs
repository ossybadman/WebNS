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
    reverseLookup,
    getAllDomains,
    getFavoriteDomain,
    getDomainKeySync,
    getRecordV2,
    Record,
    registerDomainNameV2,
    updateRecordV2Instruction,
    registerFavorite,
} from '@bonfida/spl-name-service';
import { mcpResponse } from '../lib/helpers.mjs';

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

async function withRetry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            const is429 = e.message?.includes('429') || e.message?.toLowerCase().includes('too many requests');
            if (is429 && i < retries - 1) {
                await new Promise(r => setTimeout(r, 500 * 2 ** i)); // 500ms → 1s → 2s
            } else {
                throw e;
            }
        }
    }
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
                // Remove .sol suffix if present
                const domain = name.toLowerCase().replace(/\.sol$/, '');
                const { pubkey } = getDomainKeySync(domain);
                const owner = await resolve(connection, domain);

                return mcpResponse({
                    name: `${domain}.sol`,
                    address: owner.toBase58(),
                    domainKey: pubkey.toBase58(),
                });
            } catch (e) {
                if (e.message?.includes('Invalid name account provided')) {
                    return mcpResponse({ error: `Name "${name}" not found` });
                }
                return mcpResponse({ error: e.message });
            }
        });

    server.tool('sol_reverse_lookup',
        'Find the .sol name(s) for a Solana wallet address',
        { address: z.string().describe('The Solana wallet address to look up') },
        async ({ address }) => {
            try {
                const pubkey = new PublicKey(address);
                const domains = await withRetry(() => getAllDomains(connection, pubkey));

                if (!domains || domains.length === 0) {
                    return mcpResponse({ error: `No .sol domains found for "${address}"` });
                }

                // Get the reverse name for each domain
                const names = await Promise.all(
                    domains.map(async (domainKey) => {
                        try {
                            return await withRetry(() => reverseLookup(connection, domainKey));
                        } catch {
                            return null;
                        }
                    })
                );

                const validNames = names.filter(Boolean).map(n => `${n}.sol`);

                return mcpResponse({
                    address,
                    names: validNames,
                    count: validNames.length,
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
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
                    return mcpResponse({ error: `Name "${name}" not found` });
                }
                return mcpResponse({ error: e.message });
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
            } catch (e) { return mcpResponse({ error: e.message }); }
        });

    server.tool('sol_get_favorite_domain',
        'Get the favorite/primary .sol domain for a wallet',
        { address: z.string().describe('The Solana wallet address') },
        async ({ address }) => {
            try {
                const pubkey = new PublicKey(address);
                const favorite = await getFavoriteDomain(connection, pubkey);

                if (!favorite || !favorite.reverse) {
                    return mcpResponse({ error: `No favorite domain set for "${address}"` });
                }

                return mcpResponse({
                    address,
                    favoriteDomain: `${favorite.reverse}.sol`,
                    domainKey: favorite.domain.toBase58(),
                });
            } catch (e) {
                if (e.message?.includes('Favourite domain not found')) {
                    return mcpResponse({ error: `No favorite domain set for "${address}"` });
                }
                return mcpResponse({ error: e.message });
            }
        });

    server.tool('sol_list_domains',
        'List all .sol domains owned by a wallet',
        { address: z.string().describe('The Solana wallet address') },
        async ({ address }) => {
            try {
                const pubkey = new PublicKey(address);
                const domainKeys = await getAllDomains(connection, pubkey);

                if (!domainKeys || domainKeys.length === 0) {
                    return mcpResponse({
                        address,
                        domains: [],
                        count: 0,
                    });
                }

                // Reverse lookup each domain
                const domains = await Promise.all(
                    domainKeys.map(async (key) => {
                        try {
                            const name = await reverseLookup(connection, key);
                            return {
                                name: `${name}.sol`,
                                domainKey: key.toBase58(),
                            };
                        } catch {
                            return {
                                name: null,
                                domainKey: key.toBase58(),
                            };
                        }
                    })
                );

                return mcpResponse({
                    address,
                    domains: domains.filter(d => d.name),
                    count: domains.filter(d => d.name).length,
                });
            } catch (e) { return mcpResponse({ error: e.message }); }
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
            } catch (e) { return mcpResponse({ error: e.message }); }
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
            } catch (e) { return mcpResponse({ error: e.message }); }
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
            } catch (e) { return mcpResponse({ error: e.message }); }
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
                    return mcpResponse({ error: `Unknown record type: ${key}` });
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
            } catch (e) { return mcpResponse({ error: e.message }); }
        });
}
