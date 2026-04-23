/**
 * Cross-chain convenience tools for webns
 *
 * Provides 2 tools that auto-detect chain from TLD:
 * - resolve_any: Universal name resolution
 * - reverse_lookup_any: Universal reverse lookup
 */

import { z } from 'zod';
import { mcpResponse, mcpErrorResponse, detectChainFromName } from '../lib/helpers.mjs';
import { withLogging } from '../lib/logger.mjs';


/**
 * Register cross-chain convenience tools with the MCP server
 * @param {McpServer} server - The MCP server instance
 */
export function registerCrossChainTools(server) {

    server.tool('resolve_any',
        'Resolve any blockchain name (.sui, .eth, .sol, .apt, .base.eth) to its address. Auto-detects chain from TLD.',
        { name: z.string().describe('The name to resolve (e.g. vitalik.eth, bonfida.sol, alice.sui, bob.apt, shrek.base.eth)') },
        withLogging('resolve_any', async ({ name }) => {
            try {
                const chain = detectChainFromName(name);

                if (!chain) {
                    return mcpResponse({ error: { code: 'UNSUPPORTED_CHAIN', message: `Unknown TLD. Supported: .sui, .eth, .sol, .apt, .base.eth`, chain: null } });
                }

                // Resolve using chain-specific logic
                // We use direct SDK calls here instead of tool invocations
                let result;

                switch (chain) {
                    case 'sui': {
                        const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import('@mysten/sui/jsonRpc');
                        const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet') });
                        const address = await client.resolveNameServiceAddress({ name });
                        if (!address) {
                            result = { error: `Name "${name}" not found` };
                        } else {
                            result = { name, address, chain: 'Sui' };
                        }
                        break;
                    }

                    case 'ens': {
                        const { createPublicClient, http } = await import('viem');
                        const { normalize } = await import('viem/ens');
                        const { mainnet } = await import('viem/chains');
                        const ethRpc = process.env.ETHEREUM_RPC_URL;
                        if (!ethRpc) throw new Error('ETHEREUM_RPC_URL is not configured');
                        const client = createPublicClient({ chain: mainnet, transport: http(ethRpc) });
                        const address = await client.getEnsAddress({
                            name: normalize(name),
                            universalResolverAddress: '0xeeeeeeee14d718c2b47d9923deab1335e144eeee',
                            gatewayUrls: ['https://ccip.ens.xyz'],
                        });
                        if (!address) {
                            result = { error: `Name "${name}" not found` };
                        } else {
                            result = { name, address, chain: 'Ethereum' };
                        }
                        break;
                    }

                    case 'sol': {
                        const { resolve } = await import('@bonfida/spl-name-service');
                        const { Connection, clusterApiUrl } = await import('@solana/web3.js');
                        const connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');
                        const domain = name.toLowerCase().replace(/\.sol$/, '');
                        try {
                            const owner = await resolve(connection, domain);
                            result = { name, address: owner.toBase58(), chain: 'Solana' };
                        } catch {
                            result = { error: `Name "${name}" not found` };
                        }
                        break;
                    }

                    case 'apt': {
                        const { Aptos, AptosConfig, Network } = await import('@aptos-labs/ts-sdk');
                        const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));
                        const domain = name.toLowerCase().replace(/\.apt$/, '');
                        const ans = await aptos.ans.getName({ name: domain });
                        const address = ans?.registered_address || ans?.owner_address;
                        if (!ans || !address) {
                            result = { error: `Name "${name}" not found` };
                        } else {
                            result = { name, address, chain: 'Aptos' };
                        }
                        break;
                    }

                    case 'base': {
                        const { createPublicClient, http } = await import('viem');
                        const { namehash, normalize } = await import('viem/ens');
                        const { base } = await import('viem/chains');
                        const baseRpc = process.env.BASE_RPC_URL;
                        if (!baseRpc) throw new Error('BASE_RPC_URL is not configured');
                        const client = createPublicClient({ chain: base, transport: http(baseRpc) });
                        const normalizedName = normalize(name);
                        const node = namehash(normalizedName);
                        const BASE_REGISTRY = '0xB94704422c2a1E396835A571837Aa5AE53285a95';
                        const ZERO = '0x0000000000000000000000000000000000000000';
                        const registryAbi = [{ name: 'resolver', type: 'function', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }], stateMutability: 'view' }];
                        const resolverAbi = [{ name: 'addr', type: 'function', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }], stateMutability: 'view' }];
                        try {
                            const resolverAddress = await client.readContract({ address: BASE_REGISTRY, abi: registryAbi, functionName: 'resolver', args: [node] });
                            if (!resolverAddress || resolverAddress === ZERO) {
                                result = { error: `Name "${name}" not found` };
                                break;
                            }
                            const address = await client.readContract({ address: resolverAddress, abi: resolverAbi, functionName: 'addr', args: [node] });
                            if (!address || address === ZERO) {
                                result = { error: `Name "${name}" not found` };
                            } else {
                                result = { name, address, chain: 'Base' };
                            }
                        } catch {
                            result = { error: `Name "${name}" not found` };
                        }
                        break;
                    }

                    default:
                        result = { error: `Chain "${chain}" not supported` };
                }

                return mcpResponse(result);
            } catch (e) { return mcpErrorResponse(e, null); }
        }));

    server.tool('reverse_lookup_any',
        'Find the primary name for an address on any supported chain',
        {
            address: z.string().describe('The wallet address to look up'),
            chain: z.enum(['sui', 'ens', 'sol', 'apt', 'base']).describe('The chain to search on'),
        },
        withLogging('reverse_lookup_any', async ({ address, chain }) => {
            try {
                let result;

                switch (chain) {
                    case 'sui': {
                        const { SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import('@mysten/sui/jsonRpc');
                        const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet') });
                        const names = await client.resolveNameServiceNames({ address });
                        if (!names?.data?.length) {
                            result = { error: `No .sui name found for "${address}"` };
                        } else {
                            result = { address, names: names.data, primaryName: names.data[0], chain: 'Sui' };
                        }
                        break;
                    }

                    case 'ens': {
                        const { createPublicClient, http } = await import('viem');
                        const { mainnet } = await import('viem/chains');
                        const ethRpc = process.env.ETHEREUM_RPC_URL;
                        if (!ethRpc) throw new Error('ETHEREUM_RPC_URL is not configured');
                        const client = createPublicClient({ chain: mainnet, transport: http(ethRpc) });
                        const name = await client.getEnsName({
                            address,
                            universalResolverAddress: '0xeeeeeeee14d718c2b47d9923deab1335e144eeee',
                            gatewayUrls: ['https://ccip.ens.xyz'],
                        });
                        if (!name) {
                            result = { error: `No .eth name found for "${address}"` };
                        } else {
                            result = { address, primaryName: name, chain: 'Ethereum' };
                        }
                        break;
                    }

                    case 'sol': {
                        const { getAllDomains, reverseLookup, getFavoriteDomain } = await import('@bonfida/spl-name-service');
                        const { Connection, clusterApiUrl, PublicKey } = await import('@solana/web3.js');
                        const connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');
                        const pubkey = new PublicKey(address);

                        // Try favorite first
                        let favorite = null;
                        try {
                            const fav = await getFavoriteDomain(connection, pubkey);
                            if (fav?.domain) favorite = `${fav.domain}.sol`;
                        } catch {}

                        // Get all domains
                        const domainKeys = await getAllDomains(connection, pubkey);
                        if (!domainKeys?.length) {
                            result = { error: `No .sol name found for "${address}"` };
                        } else {
                            const names = await Promise.all(
                                domainKeys.map(async (key) => {
                                    try {
                                        const n = await reverseLookup(connection, key);
                                        return `${n}.sol`;
                                    } catch { return null; }
                                })
                            );
                            const validNames = names.filter(Boolean);
                            result = {
                                address,
                                names: validNames,
                                primaryName: favorite || validNames[0],
                                chain: 'Solana',
                            };
                        }
                        break;
                    }

                    case 'apt': {
                        const { Aptos, AptosConfig, Network } = await import('@aptos-labs/ts-sdk');
                        const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));
                        const primaryName = await aptos.ans.getPrimaryName({ address });
                        if (!primaryName) {
                            result = { error: `No .apt name found for "${address}"` };
                        } else {
                            result = { address, primaryName: `${primaryName}.apt`, chain: 'Aptos' };
                        }
                        break;
                    }

                    case 'base': {
                        const { createPublicClient, http } = await import('viem');
                        const { namehash } = await import('viem/ens');
                        const { base } = await import('viem/chains');
                        const baseRpc = process.env.BASE_RPC_URL;
                        if (!baseRpc) throw new Error('BASE_RPC_URL is not configured');
                        const client = createPublicClient({ chain: base, transport: http(baseRpc) });
                        const reverseLabel = address.toLowerCase().slice(2);
                        const reverseNode = namehash(`${reverseLabel}.addr.reverse`);
                        const L2_RESOLVER = '0x426fA03fB86E510d0Dd9F70335Cf102a98b10875';
                        try {
                            const name = await client.readContract({
                                address: L2_RESOLVER,
                                abi: [{ name: 'name', type: 'function', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'string' }], stateMutability: 'view' }],
                                functionName: 'name',
                                args: [reverseNode],
                            });
                            if (!name) {
                                result = { error: `No .base.eth name found for "${address}"` };
                            } else {
                                result = { address, primaryName: name, chain: 'Base' };
                            }
                        } catch {
                            result = { error: `No .base.eth name found for "${address}"` };
                        }
                        break;
                    }

                    default:
                        result = { error: `Chain "${chain}" not supported` };
                }

                return mcpResponse(result);
            } catch (e) { return mcpErrorResponse(e, null); }
        }));
}
