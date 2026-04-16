/**
 * ENS (.eth) chain module for webns
 *
 * Provides 13 tools:
 * - 5 query tools: resolve_name, reverse_lookup, get_name_record, check_availability, get_pricing
 * - 6 transaction tools: build_commit_tx, build_register_tx, build_renew_tx,
 *   build_set_target_address_tx, build_set_default_name_tx, build_set_metadata_tx
 * - 2 chain-specific: get_text_record, get_contenthash
 */

import { z } from 'zod';
import {
    createPublicClient,
    http,
    encodeFunctionData,
    formatEther,
    toHex,
} from 'viem';
import { namehash, normalize } from 'viem/ens';
import { mainnet } from 'viem/chains';
import { mcpResponse, mcpErrorResponse } from '../lib/helpers.mjs';
import { withRetry } from '../lib/retry.mjs';

// ENS Contract addresses on mainnet
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ETH_REGISTRAR_CONTROLLER = '0x253553366Da8546fC250F225fe3d25d0C782303b';
const PUBLIC_RESOLVER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63';
const REVERSE_REGISTRAR = '0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb';

// ABIs (minimal for our needs)
const CONTROLLER_ABI = [
    {
        name: 'available',
        type: 'function',
        inputs: [{ name: 'name', type: 'string' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'view',
    },
    {
        name: 'rentPrice',
        type: 'function',
        inputs: [{ name: 'name', type: 'string' }, { name: 'duration', type: 'uint256' }],
        outputs: [{ name: 'base', type: 'uint256' }, { name: 'premium', type: 'uint256' }],
        stateMutability: 'view',
    },
    {
        name: 'makeCommitment',
        type: 'function',
        inputs: [
            { name: 'name', type: 'string' },
            { name: 'owner', type: 'address' },
            { name: 'duration', type: 'uint256' },
            { name: 'secret', type: 'bytes32' },
            { name: 'resolver', type: 'address' },
            { name: 'data', type: 'bytes[]' },
            { name: 'reverseRecord', type: 'bool' },
            { name: 'ownerControlledFuses', type: 'uint16' },
        ],
        outputs: [{ type: 'bytes32' }],
        stateMutability: 'pure',
    },
    {
        name: 'commit',
        type: 'function',
        inputs: [{ name: 'commitment', type: 'bytes32' }],
        outputs: [],
        stateMutability: 'nonpayable',
    },
    {
        name: 'register',
        type: 'function',
        inputs: [
            { name: 'name', type: 'string' },
            { name: 'owner', type: 'address' },
            { name: 'duration', type: 'uint256' },
            { name: 'secret', type: 'bytes32' },
            { name: 'resolver', type: 'address' },
            { name: 'data', type: 'bytes[]' },
            { name: 'reverseRecord', type: 'bool' },
            { name: 'ownerControlledFuses', type: 'uint16' },
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

// Initialize viem client
const rpcUrl = process.env.ETHEREUM_RPC_URL || process.env.ETH_RPC_URL || 'https://cloudflare-eth.com';
const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
});

// Helper to get resolver address for a name
async function getResolver(name) {
    const node = namehash(normalize(name));
    const resolverAddress = await withRetry(
        () => publicClient.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [node] }),
        { maxAttempts: 4, baseDelayMs: 200, label: 'ens_getResolver' }
    );
    return resolverAddress;
}

// Duration constants
const SECONDS_PER_YEAR = 31536000n;

/**
 * Register all ENS tools with the MCP server
 * @param {McpServer} server - The MCP server instance
 */
export function registerEnsTools(server) {
    // ==================== QUERY TOOLS ====================

    server.tool('ens_resolve_name',
        'Resolve a .eth name to an Ethereum wallet address',
        { name: z.string().describe('The .eth name to resolve e.g. vitalik.eth') },
        async ({ name }) => {
            try {
                const address = await withRetry(
                    () => publicClient.getEnsAddress({ name: normalize(name) }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'ens_resolve_name' }
                );
                if (!address) return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" not found or has no address`, chain: 'ens' } });
                return mcpResponse({ name, address });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_reverse_lookup',
        'Find the primary .eth name for an Ethereum address',
        { address: z.string().describe('The Ethereum address to look up (0x...)') },
        async ({ address }) => {
            try {
                // Use direct registry lookup to avoid ENSIP-19 batch-gateway issues
                const reverseNode = namehash(`${address.toLowerCase().slice(2)}.addr.reverse`);
                const resolverAddress = await withRetry(
                    () => publicClient.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [reverseNode] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'ens_reverse_lookup_resolver' }
                );
                if (!resolverAddress || resolverAddress === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `No primary ENS name found for "${address}"`, chain: 'ens' } });
                }
                const name = await withRetry(
                    () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'name', args: [reverseNode] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'ens_reverse_lookup_name' }
                );
                if (!name) return mcpResponse({ error: { code: 'NOT_FOUND', message: `No primary ENS name found for "${address}"`, chain: 'ens' } });
                return mcpResponse({ address, name });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_get_name_record',
        'Get full details of an .eth name including resolver, owner, and common text records',
        { name: z.string().describe('The .eth name to get details for') },
        async ({ name }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);

                // Get resolver
                const resolverAddress = await getResolver(normalizedName);
                if (resolverAddress === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" has no resolver set`, chain: 'ens' } });
                }

                // Get owner from registry (or NameWrapper)
                const owner = await withRetry(
                    () => publicClient.readContract({ address: ENS_REGISTRY, abi: REGISTRY_ABI, functionName: 'owner', args: [node] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'ens_get_name_record_owner' }
                );

                // Get address
                let address = null;
                try {
                    address = await withRetry(
                        () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'addr', args: [node] }),
                        { maxAttempts: 4, baseDelayMs: 200, label: 'ens_get_name_record_addr' }
                    );
                } catch {}

                // Get common text records
                const textKeys = ['avatar', 'description', 'url', 'twitter', 'github', 'email'];
                const textRecords = {};
                for (const key of textKeys) {
                    try {
                        const value = await withRetry(
                            () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'text', args: [node, key] }),
                            { maxAttempts: 4, baseDelayMs: 200, label: `ens_get_name_record_text_${key}` }
                        );
                        if (value) textRecords[key] = value;
                    } catch {}
                }

                // Get contenthash
                let contenthash = null;
                try {
                    const hash = await withRetry(
                        () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'contenthash', args: [node] }),
                        { maxAttempts: 4, baseDelayMs: 200, label: 'ens_get_name_record_contenthash' }
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
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_check_availability',
        'Check if a .eth name is available to register',
        { name: z.string().describe('The .eth name to check (without .eth suffix, e.g. "myname" not "myname.eth")') },
        async ({ name }) => {
            try {
                // Remove .eth suffix if present
                const label = name.toLowerCase().replace(/\.eth$/, '');
                const available = await withRetry(
                    () => publicClient.readContract({ address: ETH_REGISTRAR_CONTROLLER, abi: CONTROLLER_ABI, functionName: 'available', args: [label] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'ens_check_availability' }
                );
                return mcpResponse({ name: `${label}.eth`, available });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_get_pricing',
        'Get ENS registration and renewal pricing for a name',
        {
            name: z.string().describe('The name to get pricing for (without .eth suffix)'),
            years: z.number().min(1).max(10).default(1).describe('Number of years'),
        },
        async ({ name, years }) => {
            try {
                const label = name.toLowerCase().replace(/\.eth$/, '');
                const duration = BigInt(years) * SECONDS_PER_YEAR;

                const [base, premium] = await withRetry(
                    () => publicClient.readContract({ address: ETH_REGISTRAR_CONTROLLER, abi: CONTROLLER_ABI, functionName: 'rentPrice', args: [label, duration] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'ens_get_pricing' }
                );

                const total = base + premium;

                return mcpResponse({
                    name: `${label}.eth`,
                    years,
                    basePrice: formatEther(base),
                    premium: formatEther(premium),
                    totalPrice: formatEther(total),
                    currency: 'ETH',
                    note: premium > 0n ? 'This name has a premium due to recent expiration' : undefined,
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    // ==================== CHAIN-SPECIFIC QUERY TOOLS ====================

    server.tool('ens_get_text_record',
        'Get a specific text record from an .eth name',
        {
            name: z.string().describe('The .eth name'),
            key: z.string().describe('The text record key (e.g. avatar, twitter, github, url, description, email)'),
        },
        async ({ name, key }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);
                const resolverAddress = await getResolver(normalizedName);

                if (resolverAddress === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" has no resolver set`, chain: 'ens' } });
                }

                const value = await withRetry(
                    () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'text', args: [node, key] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'ens_get_text_record' }
                );

                return mcpResponse({ name: normalizedName, key, value: value || null });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_get_contenthash',
        'Get the contenthash (IPFS/IPNS/Swarm) from an .eth name',
        { name: z.string().describe('The .eth name') },
        async ({ name }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);
                const resolverAddress = await getResolver(normalizedName);

                if (resolverAddress === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" has no resolver set`, chain: 'ens' } });
                }

                const hash = await withRetry(
                    () => publicClient.readContract({ address: resolverAddress, abi: RESOLVER_ABI, functionName: 'contenthash', args: [node] }),
                    { maxAttempts: 4, baseDelayMs: 200, label: 'ens_get_contenthash' }
                );

                return mcpResponse({
                    name: normalizedName,
                    contenthash: hash && hash !== '0x' ? hash : null,
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    // ==================== TRANSACTION TOOLS ====================

    server.tool('ens_build_commit_tx',
        'Build the commit transaction (step 1 of 2-step ENS registration). Returns unsigned tx data.',
        {
            name: z.string().describe('The name to register (without .eth suffix)'),
            owner: z.string().describe('The address that will own the name'),
            years: z.number().min(1).max(10).default(1),
            secret: z.string().optional().describe('32-byte hex secret (optional, will be generated if not provided)'),
            setReverseRecord: z.boolean().default(true).describe('Set this name as primary for the owner'),
        },
        async ({ name, owner, years, secret, setReverseRecord }) => {
            try {
                const label = name.toLowerCase().replace(/\.eth$/, '');
                const duration = BigInt(years) * SECONDS_PER_YEAR;

                // Generate or use provided secret
                const secretBytes = secret || toHex(crypto.getRandomValues(new Uint8Array(32)));

                // Create commitment
                const commitment = await publicClient.readContract({
                    address: ETH_REGISTRAR_CONTROLLER,
                    abi: CONTROLLER_ABI,
                    functionName: 'makeCommitment',
                    args: [
                        label,
                        owner,
                        duration,
                        secretBytes,
                        PUBLIC_RESOLVER,
                        [],
                        setReverseRecord,
                        0,
                    ],
                });

                // Encode commit function call
                const data = encodeFunctionData({
                    abi: CONTROLLER_ABI,
                    functionName: 'commit',
                    args: [commitment],
                });

                return mcpResponse({
                    to: ETH_REGISTRAR_CONTROLLER,
                    data,
                    value: '0',
                    secret: secretBytes,
                    commitment,
                    note: 'After executing this transaction, wait at least 60 seconds before calling ens_build_register_tx with the same secret',
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_build_register_tx',
        'Build the register transaction (step 2 of 2-step ENS registration). Must be called 60+ seconds after commit.',
        {
            name: z.string().describe('The name to register (without .eth suffix)'),
            owner: z.string().describe('The address that will own the name'),
            years: z.number().min(1).max(10).default(1),
            secret: z.string().describe('The same 32-byte hex secret used in the commit step'),
            setReverseRecord: z.boolean().default(true),
        },
        async ({ name, owner, years, secret, setReverseRecord }) => {
            try {
                const label = name.toLowerCase().replace(/\.eth$/, '');
                const duration = BigInt(years) * SECONDS_PER_YEAR;

                // Get the price
                const [base, premium] = await publicClient.readContract({
                    address: ETH_REGISTRAR_CONTROLLER,
                    abi: CONTROLLER_ABI,
                    functionName: 'rentPrice',
                    args: [label, duration],
                });
                const total = base + premium;
                // Add 10% buffer for price fluctuations
                const valueWithBuffer = (total * 110n) / 100n;

                // Encode register function call
                const data = encodeFunctionData({
                    abi: CONTROLLER_ABI,
                    functionName: 'register',
                    args: [
                        label,
                        owner,
                        duration,
                        secret,
                        PUBLIC_RESOLVER,
                        [],
                        setReverseRecord,
                        0,
                    ],
                });

                return mcpResponse({
                    to: ETH_REGISTRAR_CONTROLLER,
                    data,
                    value: valueWithBuffer.toString(),
                    valueEth: formatEther(valueWithBuffer),
                    note: 'Send this transaction with the specified ETH value. Excess ETH will be refunded.',
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_build_renew_tx',
        'Build a transaction to renew an existing .eth name. Returns unsigned tx data.',
        {
            name: z.string().describe('The name to renew (without .eth suffix)'),
            years: z.number().min(1).max(10).default(1),
        },
        async ({ name, years }) => {
            try {
                const label = name.toLowerCase().replace(/\.eth$/, '');
                const duration = BigInt(years) * SECONDS_PER_YEAR;

                // Get the price
                const [base, premium] = await publicClient.readContract({
                    address: ETH_REGISTRAR_CONTROLLER,
                    abi: CONTROLLER_ABI,
                    functionName: 'rentPrice',
                    args: [label, duration],
                });
                const total = base + premium;
                // Add 5% buffer for price fluctuations
                const valueWithBuffer = (total * 105n) / 100n;

                const data = encodeFunctionData({
                    abi: CONTROLLER_ABI,
                    functionName: 'renew',
                    args: [label, duration],
                });

                return mcpResponse({
                    to: ETH_REGISTRAR_CONTROLLER,
                    data,
                    value: valueWithBuffer.toString(),
                    valueEth: formatEther(valueWithBuffer),
                    note: 'Send this transaction with the specified ETH value. Excess ETH will be refunded.',
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_build_set_target_address_tx',
        'Build a transaction to set the ETH address for an .eth name. Returns unsigned tx data.',
        {
            name: z.string().describe('The .eth name'),
            address: z.string().describe('The target Ethereum address'),
        },
        async ({ name, address }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);
                const resolverAddress = await getResolver(normalizedName);

                if (resolverAddress === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" has no resolver set`, chain: 'ens' } });
                }

                const data = encodeFunctionData({
                    abi: RESOLVER_ABI,
                    functionName: 'setAddr',
                    args: [node, address],
                });

                return mcpResponse({
                    to: resolverAddress,
                    data,
                    value: '0',
                    note: 'Sign and send this transaction to update the address record',
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_build_set_default_name_tx',
        'Build a transaction to set a .eth name as the primary name for the sender. Returns unsigned tx data.',
        { name: z.string().describe('The .eth name to set as primary') },
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
                    note: 'Sign and send this transaction to set your primary ENS name. The sender address must be the target of this name.',
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });

    server.tool('ens_build_set_metadata_tx',
        'Build a transaction to set text records or contenthash on an .eth name. Returns unsigned tx data.',
        {
            name: z.string().describe('The .eth name'),
            key: z.string().describe('The record key (e.g. avatar, twitter, github, url, description, email, contenthash)'),
            value: z.string().describe('The value to set'),
        },
        async ({ name, key, value }) => {
            try {
                const normalizedName = normalize(name);
                const node = namehash(normalizedName);
                const resolverAddress = await getResolver(normalizedName);

                if (resolverAddress === '0x0000000000000000000000000000000000000000') {
                    return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" has no resolver set`, chain: 'ens' } });
                }

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
                    to: resolverAddress,
                    data,
                    value: '0',
                    note: `Sign and send this transaction to set the ${key} record`,
                });
            } catch (e) { return mcpErrorResponse(e, 'ens'); }
        });
}
