/**
 * Basenames (.base.eth) chain module for webns
 *
 * Basenames uses ENS infrastructure deployed on Base L2 (chain ID 8453).
 *
 * Provides 10 tools:
 * - 5 query tools: resolve_name, reverse_lookup, get_name_record, check_availability, get_pricing
 * - 5 transaction tools: build_register_tx, build_renew_tx, build_set_target_address_tx,
 *   build_set_default_name_tx, build_set_metadata_tx
 */

import { z } from 'zod';
import {
    createPublicClient,
    http,
    encodeFunctionData,
    formatEther,
} from 'viem';
import { namehash, normalize } from 'viem/ens';
import { base } from 'viem/chains';
import { mcpResponse, mcpErrorResponse } from '../lib/helpers.mjs';
import { withRetry } from '../lib/retry.mjs';

// Basenames contract addresses on Base mainnet
const L2_RESOLVER = '0x426fA03fB86E510d0Dd9F70335Cf102a98b10875';
const REGISTRAR_CONTROLLER = '0x4cCb0BB02FCABA27e82a56646E81d8c5bC4119a5';
const REVERSE_REGISTRAR = '0x79EA96012eEa67A83431F1701B3dFf7e37F9E282';
const BASE_REGISTRY = '0xB94704422c2a1E396835A571837Aa5AE53285a95';

// ABIs
const REGISTRAR_ABI = [
    {
        name: 'available',
        type: 'function',
        inputs: [{ name: 'name', type: 'string' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'view',
    },
    {
        name: 'registerPrice',
        type: 'function',
        inputs: [{ name: 'name', type: 'string' }, { name: 'duration', type: 'uint256' }],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
    },
    {
        name: 'register',
        type: 'function',
        inputs: [
            { name: 'request', type: 'tuple', components: [
                { name: 'name', type: 'string' },
                { name: 'owner', type: 'address' },
                { name: 'duration', type: 'uint256' },
                { name: 'resolver', type: 'address' },
                { name: 'data', type: 'bytes[]' },
                { name: 'reverseRecord', type: 'bool' },
            ]},
        ],
        outputs: [],
        stateMutability: 'payable',
    },
    {
        name: 'renew',
        type: 'function',
        inputs: [{ name: 'name', type: 'string' }, { name: 'duration', type: 'uint256' }],
        outputs: [],
        stateMutability: 'payable',
    },
];

const RESOLVER_ABI = [
    {
        name: 'addr',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }],
        outputs: [{ type: 'address' }],
        stateMutability: 'view',
    },
    {
        name: 'text',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
        outputs: [{ type: 'string' }],
        stateMutability: 'view',
    },
    {
        name: 'contenthash',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }],
        outputs: [{ type: 'bytes' }],
        stateMutability: 'view',
    },
    {
        name: 'name',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }],
        outputs: [{ type: 'string' }],
        stateMutability: 'view',
    },
    {
        name: 'setAddr',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }, { name: 'a', type: 'address' }],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        name: 'setText',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        name: 'setContenthash',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }, { name: 'hash', type: 'bytes' }],
        outputs: [],
        stateMutability: 'nonpayable',
    },
];

const REGISTRY_ABI = [
    {
        name: 'resolver',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }],
        outputs: [{ type: 'address' }],
        stateMutability: 'view',
    },
    {
        name: 'owner',
        type: 'function',
        inputs: [{ name: 'node', type: 'bytes32' }],
        outputs: [{ type: 'address' }],
        stateMutability: 'view',
    },
];

const REVERSE_REGISTRAR_ABI = [
    {
        name: 'setName',
        type: 'function',
        inputs: [{ name: 'name', type: 'string' }],
        outputs: [{ type: 'bytes32' }],
        stateMutability: 'nonpayable',
    },
];

// Initialize viem client for Base
const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
});

// Duration constants
const SECONDS_PER_YEAR = 31536000n;

// Helper to compute reverse node for an address
function computeReverseNode(address) {
    const reverseLabel = address.toLowerCase().slice(2); // remove 0x
    const reverseNode = namehash(`${reverseLabel}.addr.reverse`);
    return reverseNode;
}

// Helper to get resolver address for a name
async function getResolver(name) {
    const node = namehash(normalize(name));
    try {
        const resolverAddress = await withRetry(
            () => publicClient.readContract({ address: BASE_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [node] }),
            { maxAttempts: 4, baseDelayMs: 200, label: 'base_getResolver' }
        );
        return resolverAddress;
    } catch {
        return L2_RESOLVER; // Fall back to default resolver
    }
}

/**
 * Register all Basenames tools with the MCP server
 * @param {McpServer} server - The MCP server instance
 */
export function registerBaseTools(server) {
    // ==================== QUERY TOOLS ====================

    server.tool('base_resolve_name',
        'Resolve a .base.eth name to a wallet address',
        { name: z.string().describe('The .base.eth name to resolve e.g. alice.base.eth') },
        async ({ name }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);

                const resolverAddress = await getResolver(normalizedName);
                if (resolverAddress === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" has no resolver set`, chain: 'base' } });
                }

                const address = await withRetry(
                    () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'addr', args: [node] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'base_resolve_name' }
                );

                if (!address || address === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" not found or has no address`, chain: 'base' } });
                }

                return mcpResponse({ name: normalizedName, address });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    server.tool('base_reverse_lookup',
        'Find the primary .base.eth name for a Base wallet address',
        { address: z.string().describe('The Base/Ethereum address to look up (0x...)') },
        async ({ address }) => {
            try {
                const reverseNode = computeReverseNode(address);

                const name = await withRetry(
                    () => publicClient.readContract({ address: L2_RESOLVER, abi: RESOLVER_ABI, functionName: 'name', args: [reverseNode] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'base_reverse_lookup' }
                );

                if (!name) {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `No primary Basename found for "${address}"`, chain: 'base' } });
                }

                return mcpResponse({ address, name });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    server.tool('base_get_name_record',
        'Get full details of a .base.eth name including owner and text records',
        { name: z.string().describe('The .base.eth name to get details for') },
        async ({ name }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);

                const resolverAddress = await getResolver(normalizedName);
                if (resolverAddress === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" has no resolver set`, chain: 'base' } });
                }

                // Get owner
                let owner = null;
                try {
                    owner = await withRetry(
                        () => publicClient.readContract({ address: BASE_REGISTRY, abi: REGISTRY_ABI, functionName: 'owner', args: [node] }),
                        { maxAttempts: 4, baseDelayMs: 200, label: 'base_get_name_record_owner' }
                    );
                } catch {}

                // Get address
                let address = null;
                try {
                    address = await withRetry(
                        () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'addr', args: [node] }),
                        { maxAttempts: 4, baseDelayMs: 200, label: 'base_get_name_record_addr' }
                    );
                } catch {}

                // Get common text records
                const textKeys = ['avatar', 'description', 'url', 'twitter', 'github', 'email'];
                const textRecords = {};
                for (const key of textKeys) {
                    try {
                        const value = await withRetry(
                            () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'text', args: [node, key] }),
                            { maxAttempts: 4, baseDelayMs: 200, label: `base_get_name_record_text_${key}` }
                        );
                        if (value) textRecords[key] = value;
                    } catch {}
                }

                // Get contenthash
                let contenthash = null;
                try {
                    const hash = await withRetry(
                        () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'contenthash', args: [node] }),
                        { maxAttempts: 4, baseDelayMs: 200, label: 'base_get_name_record_contenthash' }
                    );
                    if (hash && hash !== '0x') contenthash = hash;
                } catch {}

                return mcpResponse({
                    name: normalizedName,
                    owner,
                    resolver: resolverAddress,
                    address,
                    textRecords,
                    contenthash,
                    chain: 'Base (8453)',
                });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    server.tool('base_check_availability',
        'Check if a .base.eth name is available to register',
        { name: z.string().describe('The name to check (without .base.eth suffix)') },
        async ({ name }) => {
            try {
                const label = name.toLowerCase().replace(/\.base\.eth$/, '');

                const available = await withRetry(
                    () => publicClient.readContract({ address: REGISTRAR_CONTROLLER, abi: REGISTRAR_ABI, functionName: 'available', args: [label] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'base_check_availability' }
                );

                return mcpResponse({
                    name: `${label}.base.eth`,
                    available,
                });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    server.tool('base_get_pricing',
        'Get Basenames registration pricing for a name',
        {
            name: z.string().describe('The name to get pricing for (without .base.eth suffix)'),
            years: z.number().min(1).max(10).default(1).describe('Number of years'),
        },
        async ({ name, years }) => {
            try {
                const label = name.toLowerCase().replace(/\.base\.eth$/, '');
                const duration = BigInt(years) * SECONDS_PER_YEAR;

                const price = await withRetry(
                    () => publicClient.readContract({ address: REGISTRAR_CONTROLLER, abi: REGISTRAR_ABI, functionName: 'registerPrice', args: [label, duration] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'base_get_pricing' }
                );

                return mcpResponse({
                    name: `${label}.base.eth`,
                    years,
                    price: formatEther(price),
                    currency: 'ETH',
                    chain: 'Base',
                    note: 'Price is in ETH on Base L2',
                });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    // ==================== TRANSACTION TOOLS ====================

    server.tool('base_build_register_tx',
        'Build a transaction to register a new .base.eth name on Base. Returns unsigned tx data.',
        {
            name: z.string().describe('The name to register (without .base.eth suffix)'),
            owner: z.string().describe('The address that will own the name'),
            years: z.number().min(1).max(10).default(1),
            setReverseRecord: z.boolean().default(true).describe('Set this name as primary for the owner'),
        },
        async ({ name, owner, years, setReverseRecord }) => {
            try {
                const label = name.toLowerCase().replace(/\.base\.eth$/, '');
                const duration = BigInt(years) * SECONDS_PER_YEAR;

                // Get the price
                const price = await withRetry(
                    () => publicClient.readContract({ address: REGISTRAR_CONTROLLER, abi: REGISTRAR_ABI, functionName: 'registerPrice', args: [label, duration] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'base_build_register_tx_price' }
                );

                // Add 5% buffer
                const valueWithBuffer = (price * 105n) / 100n;

                const request = {
                    name: label,
                    owner,
                    duration,
                    resolver: L2_RESOLVER,
                    data: [],
                    reverseRecord: setReverseRecord,
                };

                const data = encodeFunctionData({
                    abi: REGISTRAR_ABI,
                    functionName: 'register',
                    args: [request],
                });

                return mcpResponse({
                    to: REGISTRAR_CONTROLLER,
                    data,
                    value: valueWithBuffer.toString(),
                    valueEth: formatEther(valueWithBuffer),
                    chain: 'Base (8453)',
                    note: 'Send this transaction on Base L2 with the specified ETH value',
                });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    server.tool('base_build_renew_tx',
        'Build a transaction to renew a .base.eth name. Returns unsigned tx data.',
        {
            name: z.string().describe('The name to renew (without .base.eth suffix)'),
            years: z.number().min(1).max(10).default(1),
        },
        async ({ name, years }) => {
            try {
                const label = name.toLowerCase().replace(/\.base\.eth$/, '');
                const duration = BigInt(years) * SECONDS_PER_YEAR;

                // Get the price
                const price = await withRetry(
                    () => publicClient.readContract({ address: REGISTRAR_CONTROLLER, abi: REGISTRAR_ABI, functionName: 'registerPrice', args: [label, duration] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'base_build_renew_tx_price' }
                );

                // Add 5% buffer
                const valueWithBuffer = (price * 105n) / 100n;

                const data = encodeFunctionData({
                    abi: REGISTRAR_ABI,
                    functionName: 'renew',
                    args: [label, duration],
                });

                return mcpResponse({
                    to: REGISTRAR_CONTROLLER,
                    data,
                    value: valueWithBuffer.toString(),
                    valueEth: formatEther(valueWithBuffer),
                    chain: 'Base (8453)',
                    note: 'Send this transaction on Base L2 with the specified ETH value',
                });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    server.tool('base_build_set_target_address_tx',
        'Build a transaction to set the address for a .base.eth name. Returns unsigned tx data.',
        {
            name: z.string().describe('The .base.eth name'),
            address: z.string().describe('The target wallet address'),
        },
        async ({ name, address }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);

                const data = encodeFunctionData({
                    abi: RESOLVER_ABI,
                    functionName: 'setAddr',
                    args: [node, address],
                });

                return mcpResponse({
                    to: L2_RESOLVER,
                    data,
                    value: '0',
                    chain: 'Base (8453)',
                    note: 'Send this transaction on Base L2',
                });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    server.tool('base_build_set_default_name_tx',
        'Build a transaction to set a .base.eth name as the primary name for the sender. Returns unsigned tx data.',
        { name: z.string().describe('The .base.eth name to set as primary') },
        async ({ name }) => {
            try {
                const normalizedName = normalize(name);

                const data = encodeFunctionData({
                    abi: REVERSE_REGISTRAR_ABI,
                    functionName: 'setName',
                    args: [normalizedName],
                });

                return mcpResponse({
                    to: REVERSE_REGISTRAR,
                    data,
                    value: '0',
                    chain: 'Base (8453)',
                    note: 'Send this transaction on Base L2. Sender must be the target of this name.',
                });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });

    server.tool('base_build_set_metadata_tx',
        'Build a transaction to set text records or contenthash on a .base.eth name. Returns unsigned tx data.',
        {
            name: z.string().describe('The .base.eth name'),
            key: z.string().describe('The record key (e.g. avatar, twitter, github, url, description, email, contenthash)'),
            value: z.string().describe('The value to set'),
        },
        async ({ name, key, value }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);

                let data;
                if (key === 'contenthash') {
                    data = encodeFunctionData({
                        abi: RESOLVER_ABI,
                        functionName: 'setContenthash',
                        args: [node, value],
                    });
                } else {
                    data = encodeFunctionData({
                        abi: RESOLVER_ABI,
                        functionName: 'setText',
                        args: [node, key, value],
                    });
                }

                return mcpResponse({
                    to: L2_RESOLVER,
                    data,
                    value: '0',
                    chain: 'Base (8453)',
                    note: `Send this transaction on Base L2 to set the ${key} record`,
                });
            } catch (e) { return mcpErrorResponse(e, 'base'); }
        });
}
