#!/usr/bin/env node
/**
 * webns - Multi-chain Naming Service MCP Server
 *
 * Unified MCP server for blockchain naming services:
 * - SuiNS (.sui) - 17 tools
 * - ENS (.eth) - 13 tools
 * - SNS (.sol) - 10 tools
 * - Aptos Names (.apt) - 10 tools
 * - Basenames (.base.eth) - 10 tools
 * - Cross-chain - 2 tools
 *
 * Total: 62 tools
 *
 * Endpoint: /mcp
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttpServer } from './lib/transport.mjs';

// Import chain modules
import { registerSuiTools } from './chains/sui.mjs';
import { registerEnsTools } from './chains/ens.mjs';
import { registerSolTools } from './chains/sol.mjs';
import { registerAptTools } from './chains/apt.mjs';
import { registerBaseTools } from './chains/base.mjs';
import { registerCrossChainTools } from './chains/cross.mjs';

const SERVER_NAME = 'webns';
const SERVER_VERSION = '1.0.0';

/**
 * Create and configure the MCP server with all chain tools
 */
function createServer() {
    const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
    });

    // Register all chain tools
    console.log('Registering SuiNS tools...');
    registerSuiTools(server);

    console.log('Registering ENS tools...');
    registerEnsTools(server);

    console.log('Registering SNS tools...');
    registerSolTools(server);

    console.log('Registering Aptos Names tools...');
    registerAptTools(server);

    console.log('Registering Basenames tools...');
    registerBaseTools(server);

    console.log('Registering cross-chain tools...');
    registerCrossChainTools(server);

    console.log('All tools registered successfully');

    return server;
}

// Start the HTTP server
startHttpServer(createServer, {
    name: SERVER_NAME,
    version: SERVER_VERSION,
});
