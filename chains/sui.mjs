/**
 * SuiNS (.sui) chain module for webns
 *
 * Provides 17 tools:
 * - 6 query tools: resolve_name, reverse_lookup, get_name_record, check_availability, get_pricing, get_renewal_pricing
 * - 11 transaction tools: register, renew, create_subname, create_leaf_subname, remove_leaf_subname,
 *   set_target_address, set_default_name, edit_subname_setup, extend_expiration, set_metadata, burn_expired
 */

import { z } from 'zod';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { SuinsClient, SuinsTransaction, ALLOWED_METADATA } from '@mysten/suins';
import { Transaction } from '@mysten/sui/transactions';
import { kiosk, KioskTransaction } from '@mysten/kiosk';
import { mcpResponse, formatSuiPrices, mcpErrorResponse } from '../lib/helpers.mjs';
import { withLogging } from '../lib/logger.mjs';

// Initialize Sui clients
const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet') }).$extend(kiosk());
const suinsClient = new SuinsClient({ client: suiClient, network: 'mainnet' });

// SuiNS NFT type for kiosk operations
const SUINS_NFT_TYPE = `${suinsClient.config.packageIdV1}::registration::SuinsRegistration`;

/**
 * Auto-detect if NFT is kiosk-owned and resolve ownership details
 */
async function resolveNftOwnership(nftId, sender) {
    const obj = await suiClient.getObject({
        id: nftId,
        options: { showOwner: true }
    });
    const owner = obj.data?.owner;

    if (owner?.AddressOwner) {
        return { isKiosk: false };
    }

    if (owner?.ObjectOwner) {
        const kioskId = owner.ObjectOwner;
        const caps = await suiClient.getOwnedObjects({
            owner: sender,
            filter: { StructType: '0x2::kiosk::KioskOwnerCap' },
            options: { showContent: true }
        });
        const cap = caps.data.find(c =>
            c.data?.content?.fields?.for === kioskId
        );
        if (!cap) return {
            error: `NFT is kiosk-owned but no KioskOwnerCap found in sender wallet for kiosk ${kioskId}`
        };
        return {
            isKiosk: true,
            kioskId,
            kioskOwnerCapId: cap.data.objectId
        };
    }

    return { error: 'Unable to determine NFT ownership' };
}

/**
 * Register all SuiNS tools with the MCP server
 * @param {McpServer} server - The MCP server instance
 */
export function registerSuiTools(server) {
    // ==================== QUERY TOOLS ====================

    server.tool('sui_resolve_name',
        'Resolve a .sui name to a wallet address',
        { name: z.string().describe('The .sui name to resolve e.g. ossy.sui') },
        withLogging('sui_resolve_name', async ({ name }) => {
            try {
                const address = await suiClient.resolveNameServiceAddress({ name });
                if (!address) return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" not found or has no address`, chain: 'sui' } });
                return mcpResponse({ name, address });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_reverse_lookup',
        'Find the .sui name(s) for a wallet address',
        { address: z.string().describe('The Sui wallet address to look up') },
        withLogging('sui_reverse_lookup', async ({ address }) => {
            try {
                const result = await suiClient.resolveNameServiceNames({ address });
                if (!result?.data?.length) return mcpResponse({ error: { code: 'NOT_FOUND', message: `No .sui name found for "${address}"`, chain: 'sui' } });
                return mcpResponse({ address, names: result.data });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_get_name_record',
        'Get full details of a .sui name including expiry, avatar, and content hash',
        { name: z.string().describe('The .sui name to get details for') },
        withLogging('sui_get_name_record', async ({ name }) => {
            try {
                const record = await suinsClient.getNameRecord(name);
                if (!record) return mcpResponse({ error: { code: 'NOT_FOUND', message: `Name "${name}" not found`, chain: 'sui' } });
                return mcpResponse({
                    name: record.name,
                    address: record.targetAddress,
                    expiration: record.expirationTimestampMs,
                    avatar: record.avatar,
                    contentHash: record.contentHash,
                    walrusSiteId: record.walrusSiteId,
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_check_availability',
        'Check if a .sui name is available to register',
        { name: z.string().describe('The .sui name to check e.g. myname.sui') },
        withLogging('sui_check_availability', async ({ name }) => {
            try {
                const record = await suinsClient.getNameRecord(name);
                return mcpResponse({ name, available: !record });
            } catch {
                return mcpResponse({ name, available: true });
            }
        }));

    server.tool('sui_get_pricing',
        'Get current SuiNS registration pricing by name length in USDC, NS, and SUI',
        {},
        withLogging('sui_get_pricing', async () => {
            try {
                const priceList = await suinsClient.getPriceList();
                const USDC = formatSuiPrices(priceList);
                return mcpResponse({
                    USDC,
                    SUI: 'calculated by Pyth oracle at tx execution time',
                    NS: 'calculated by Pyth oracle at tx execution time (25% discount applied)',
                    note: 'Only USDC prices are fixed. SUI and NS amounts are determined on-chain.',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_get_renewal_pricing',
        'Get current SuiNS renewal pricing by name length in USDC, NS, and SUI',
        {},
        withLogging('sui_get_renewal_pricing', async () => {
            try {
                const priceList = await suinsClient.getRenewalPriceList();
                const USDC = formatSuiPrices(priceList);
                return mcpResponse({
                    USDC,
                    SUI: 'calculated by Pyth oracle at tx execution time',
                    NS: 'calculated by Pyth oracle at tx execution time (25% discount applied)',
                    note: 'Only USDC prices are fixed. SUI and NS amounts are determined on-chain.',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    // ==================== TRANSACTION TOOLS ====================

    server.tool('sui_build_register_tx',
        'Build a transaction to register a new .sui name. Returns unsigned tx bytes to be signed and executed by the caller.',
        {
            name: z.string(),
            years: z.number().min(1).max(5),
            coinType: z.enum(['USDC', 'SUI', 'NS']).default('USDC'),
            recipient: z.string(),
            sender: z.string(),
        },
        withLogging('sui_build_register_tx', async ({ name, years, coinType, recipient, sender }) => {
            try {
                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);
                const coinConfig = suinsClient.config.coins[coinType];

                let priceInfoObjectId;
                if (coinType !== 'USDC') {
                    priceInfoObjectId = (await suinsClient.getPriceInfoObject(tx, coinConfig.feed))[0];
                }

                let coin;
                if (coinType === 'SUI') {
                    coin = tx.gas;
                } else {
                    const coins = await suiClient.getCoins({ owner: sender, coinType: coinConfig.type });
                    const best = coins.data.sort((a, b) => Number(b.balance) - Number(a.balance))[0];
                    if (!best) {
                        return mcpResponse({ error: { code: 'INVALID_PARAMS', message: `No ${coinType} coins found in sender wallet`, chain: 'sui' } });
                    }
                    const priceList = await suinsClient.getPriceList();
                    const nameLen = name.replace('.sui', '').length;
                    const priceKey = nameLen <= 3 ? '3,3' : nameLen === 4 ? '4,4' : '5,63';
                    const requiredMist = [...priceList].find(([k]) => k.join(',') === priceKey)?.[1] * years;
                    if (Number(best.balance) < Number(requiredMist)) {
                        return mcpResponse({
                            error: `Insufficient ${coinType} balance. Wallet has ${Number(best.balance) / 1_000_000} ${coinType}, need ${Number(requiredMist) / 1_000_000} ${coinType}`,
                        });
                    }
                    coin = best.coinObjectId;
                }

                const nft = suinsTx.register({
                    domain: name,
                    years,
                    coinConfig,
                    coin,
                    ...(priceInfoObjectId && { priceInfoObjectId }),
                });

                tx.transferObjects([nft], tx.pure.address(recipient));
                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_renew_tx',
        'Build a transaction to renew an existing .sui name. Returns unsigned tx bytes.',
        {
            name: z.string(),
            nftId: z.string(),
            years: z.number().min(1).max(5),
            coinType: z.enum(['USDC', 'SUI', 'NS']).default('USDC'),
            sender: z.string(),
        },
        withLogging('sui_build_renew_tx', async ({ name, nftId, years, coinType, sender }) => {
            try {
                const ownership = await resolveNftOwnership(nftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);
                const coinConfig = suinsClient.config.coins[coinType];

                let priceInfoObjectId;
                if (coinType !== 'USDC') {
                    priceInfoObjectId = (await suinsClient.getPriceInfoObject(tx, coinConfig.feed))[0];
                }

                let coin;
                if (coinType === 'SUI') {
                    coin = tx.gas;
                } else {
                    const coins = await suiClient.getCoins({ owner: sender, coinType: coinConfig.type });
                    const best = coins.data.sort((a, b) => Number(b.balance) - Number(a.balance))[0];
                    if (!best) {
                        return mcpResponse({ error: { code: 'INVALID_PARAMS', message: `No ${coinType} coins found in sender wallet`, chain: 'sui' } });
                    }
                    const priceList = await suinsClient.getRenewalPriceList();
                    const nameLen = name.replace('.sui', '').length;
                    const priceKey = nameLen <= 3 ? '3,3' : nameLen === 4 ? '4,4' : '5,63';
                    const requiredMist = [...priceList].find(([k]) => k.join(',') === priceKey)?.[1] * years;
                    if (Number(best.balance) < Number(requiredMist)) {
                        return mcpResponse({
                            error: `Insufficient ${coinType} balance. Wallet has ${Number(best.balance) / 1_000_000} ${coinType}, need ${Number(requiredMist) / 1_000_000} ${coinType}`,
                        });
                    }
                    coin = best.coinObjectId;
                }

                let nftArg = nftId;
                let kioskTx;
                let borrowPromise;
                if (ownership.isKiosk) {
                    kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                    nftArg = borrowedNft;
                    borrowPromise = promise;
                }

                suinsTx.renew({
                    nft: nftArg,
                    years,
                    coinConfig,
                    coin,
                    ...(priceInfoObjectId && { priceInfoObjectId }),
                });

                if (kioskTx && borrowPromise) {
                    kioskTx.return({ itemType: SUINS_NFT_TYPE, item: nftArg, promise: borrowPromise });
                    kioskTx.finalize();
                }

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_create_subname_tx',
        'Build a transaction to create a node subname (has its own NFT). Returns unsigned tx bytes.',
        {
            subname: z.string(),
            parentNftId: z.string(),
            expirationMs: z.number(),
            recipient: z.string(),
            allowChildCreation: z.boolean().default(true),
            allowTimeExtension: z.boolean().default(true),
            sender: z.string(),
        },
        withLogging('sui_build_create_subname_tx', async ({ subname, parentNftId, expirationMs, recipient, allowChildCreation, allowTimeExtension, sender }) => {
            try {
                const ownership = await resolveNftOwnership(parentNftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                let parentNftArg = parentNftId;
                let kioskTx;
                let borrowPromise;
                if (ownership.isKiosk) {
                    kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: parentNftId });
                    parentNftArg = borrowedNft;
                    borrowPromise = promise;
                }

                const nft = suinsTx.createSubName({
                    parentNft: parentNftArg,
                    name: subname,
                    expirationTimestampMs: expirationMs,
                    allowChildCreation,
                    allowTimeExtension,
                });

                if (kioskTx && borrowPromise) {
                    kioskTx.return({ itemType: SUINS_NFT_TYPE, item: parentNftArg, promise: borrowPromise });
                    kioskTx.finalize();
                }

                tx.transferObjects([nft], tx.pure.address(recipient));
                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_create_leaf_subname_tx',
        'Build a transaction to create a leaf subname (no NFT, controlled by parent). Returns unsigned tx bytes.',
        {
            subname: z.string(),
            parentNftId: z.string(),
            targetAddress: z.string(),
            sender: z.string(),
        },
        withLogging('sui_build_create_leaf_subname_tx', async ({ subname, parentNftId, targetAddress, sender }) => {
            try {
                const ownership = await resolveNftOwnership(parentNftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                let parentNftArg = parentNftId;
                let kioskTx;
                let borrowPromise;
                if (ownership.isKiosk) {
                    kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: parentNftId });
                    parentNftArg = borrowedNft;
                    borrowPromise = promise;
                }

                suinsTx.createLeafSubName({
                    parentNft: parentNftArg,
                    name: subname,
                    targetAddress,
                });

                if (kioskTx && borrowPromise) {
                    kioskTx.return({ itemType: SUINS_NFT_TYPE, item: parentNftArg, promise: borrowPromise });
                    kioskTx.finalize();
                }

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_remove_leaf_subname_tx',
        'Build a transaction to remove a leaf subname. Returns unsigned tx bytes.',
        {
            subname: z.string(),
            parentNftId: z.string(),
            sender: z.string(),
        },
        withLogging('sui_build_remove_leaf_subname_tx', async ({ subname, parentNftId, sender }) => {
            try {
                const ownership = await resolveNftOwnership(parentNftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                let parentNftArg = parentNftId;
                let kioskTx;
                let borrowPromise;
                if (ownership.isKiosk) {
                    kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: parentNftId });
                    parentNftArg = borrowedNft;
                    borrowPromise = promise;
                }

                suinsTx.removeLeafSubName({
                    parentNft: parentNftArg,
                    name: subname,
                });

                if (kioskTx && borrowPromise) {
                    kioskTx.return({ itemType: SUINS_NFT_TYPE, item: parentNftArg, promise: borrowPromise });
                    kioskTx.finalize();
                }

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_set_target_address_tx',
        'Build a transaction to set the target address for a .sui name. Returns unsigned tx bytes.',
        {
            nftId: z.string(),
            address: z.string(),
            isSubname: z.boolean().default(false),
            sender: z.string(),
        },
        withLogging('sui_build_set_target_address_tx', async ({ nftId, address, isSubname, sender }) => {
            try {
                const ownership = await resolveNftOwnership(nftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                let nftArg = nftId;
                let kioskTx;
                let borrowPromise;
                if (ownership.isKiosk) {
                    kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                    nftArg = borrowedNft;
                    borrowPromise = promise;
                }

                suinsTx.setTargetAddress({
                    nft: nftArg,
                    address,
                    isSubname,
                });

                if (kioskTx && borrowPromise) {
                    kioskTx.return({ itemType: SUINS_NFT_TYPE, item: nftArg, promise: borrowPromise });
                    kioskTx.finalize();
                }

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_set_default_name_tx',
        'Build a transaction to set a .sui name as the default for the signer address. Returns unsigned tx bytes.',
        { name: z.string(), sender: z.string() },
        withLogging('sui_build_set_default_name_tx', async ({ name, sender }) => {
            try {
                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                suinsTx.setDefault(name);

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet. Signer must be the target address of this name.',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_edit_subname_setup_tx',
        'Build a transaction to edit a subname setup (child creation / time extension). Returns unsigned tx bytes.',
        {
            name: z.string(),
            parentNftId: z.string(),
            allowChildCreation: z.boolean(),
            allowTimeExtension: z.boolean(),
            sender: z.string(),
        },
        withLogging('sui_build_edit_subname_setup_tx', async ({ name, parentNftId, allowChildCreation, allowTimeExtension, sender }) => {
            try {
                const ownership = await resolveNftOwnership(parentNftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                let parentNftArg = parentNftId;
                let kioskTx;
                let borrowPromise;
                if (ownership.isKiosk) {
                    kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: parentNftId });
                    parentNftArg = borrowedNft;
                    borrowPromise = promise;
                }

                suinsTx.editSetup({
                    name,
                    parentNft: parentNftArg,
                    allowChildCreation,
                    allowTimeExtension,
                });

                if (kioskTx && borrowPromise) {
                    kioskTx.return({ itemType: SUINS_NFT_TYPE, item: parentNftArg, promise: borrowPromise });
                    kioskTx.finalize();
                }

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_extend_expiration_tx',
        'Build a transaction to extend a SUBNAME expiration (SubDomainRegistration NFT only). Returns unsigned tx bytes.',
        {
            nftId: z.string(),
            expirationMs: z.number(),
            sender: z.string(),
        },
        withLogging('sui_build_extend_expiration_tx', async ({ nftId, expirationMs, sender }) => {
            try {
                const ownership = await resolveNftOwnership(nftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                let nftArg = nftId;
                let kioskTx;
                let borrowPromise;
                if (ownership.isKiosk) {
                    kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                    nftArg = borrowedNft;
                    borrowPromise = promise;
                }

                suinsTx.extendExpiration({
                    nft: nftArg,
                    expirationTimestampMs: expirationMs,
                });

                if (kioskTx && borrowPromise) {
                    kioskTx.return({ itemType: SUINS_NFT_TYPE, item: nftArg, promise: borrowPromise });
                    kioskTx.finalize();
                }

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_set_metadata_tx',
        'Build a transaction to set metadata on a .sui name (avatar, content hash, walrus site ID). Returns unsigned tx bytes.',
        {
            nftId: z.string(),
            isSubname: z.boolean().default(false),
            avatar: z.string().optional(),
            contentHash: z.string().optional(),
            walrusSiteId: z.string().optional(),
            sender: z.string(),
        },
        withLogging('sui_build_set_metadata_tx', async ({ nftId, isSubname, avatar, contentHash, walrusSiteId, sender }) => {
            try {
                const ownership = await resolveNftOwnership(nftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                let nftArg = nftId;
                let kioskTx;
                let borrowPromise;
                if (ownership.isKiosk) {
                    kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    const [borrowedNft, promise] = kioskTx.borrow({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                    nftArg = borrowedNft;
                    borrowPromise = promise;
                }

                if (avatar) {
                    suinsTx.setUserData({ nft: nftArg, key: ALLOWED_METADATA.avatar, value: avatar, isSubname });
                }
                if (contentHash) {
                    suinsTx.setUserData({ nft: nftArg, key: ALLOWED_METADATA.contentHash, value: contentHash, isSubname });
                }
                if (walrusSiteId) {
                    suinsTx.setUserData({ nft: nftArg, key: ALLOWED_METADATA.walrusSiteId, value: walrusSiteId, isSubname });
                }

                if (kioskTx && borrowPromise) {
                    kioskTx.return({ itemType: SUINS_NFT_TYPE, item: nftArg, promise: borrowPromise });
                    kioskTx.finalize();
                }

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));

    server.tool('sui_build_burn_expired_tx',
        'Build a transaction to burn an expired .sui name and reclaim storage rebates. Returns unsigned tx bytes.',
        {
            nftId: z.string(),
            isSubname: z.boolean().default(false),
            sender: z.string(),
        },
        withLogging('sui_build_burn_expired_tx', async ({ nftId, isSubname, sender }) => {
            try {
                const ownership = await resolveNftOwnership(nftId, sender);
                if (ownership.error) return mcpResponse({ error: ownership.error });

                const tx = new Transaction();
                tx.setSender(sender);
                const suinsTx = new SuinsTransaction(suinsClient, tx);

                let nftArg = nftId;
                if (ownership.isKiosk) {
                    const kioskTx = new KioskTransaction({ transaction: tx, kioskClient: suiClient.kiosk });
                    kioskTx.setKiosk(tx.object(ownership.kioskId)).setKioskCap(tx.object(ownership.kioskOwnerCapId));
                    nftArg = kioskTx.take({ itemType: SUINS_NFT_TYPE, itemId: nftId });
                    kioskTx.finalize();
                }

                suinsTx.burnExpired({
                    nft: nftArg,
                    isSubname,
                });

                const txBytes = await tx.build({ client: suiClient });

                return mcpResponse({
                    txBytes: Buffer.from(txBytes).toString('base64'),
                    note: 'Sign and execute these tx bytes with your wallet',
                });
            } catch (e) { return mcpErrorResponse(e, 'sui'); }
        }));
}
