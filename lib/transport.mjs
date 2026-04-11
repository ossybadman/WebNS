/**
 * Shared HTTP transport and session handling for webns
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Create and start the HTTP server with MCP transport
 * @param {Function} createServer - Function that creates and returns an McpServer instance
 * @param {object} options - Server options
 * @param {string} options.name - Server name for health endpoint
 * @param {string} options.version - Server version
 * @param {number} [options.port] - Port to listen on (default: process.env.PORT || 3000)
 */
export function startHttpServer(createServer, options) {
    const { name, version, port = parseInt(process.env.PORT || '3000') } = options;

    // Map of sessionId -> transport for stateful multi-session support
    const sessions = new Map();

    const httpServer = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', name, version }));
            return;
        }

        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(`${name} v${version} running`);
            return;
        }

        if (req.url?.startsWith('/mcp')) {
            try {
                console.log(`Incoming MCP ${req.method} request:`, req.url);
                const sessionId = req.headers['mcp-session-id'];

                let transport;

                if (sessionId && sessions.has(sessionId)) {
                    transport = sessions.get(sessionId);
                } else if (!sessionId && req.method === 'POST') {
                    // New session — create a fresh server + transport
                    const server = createServer();
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => crypto.randomUUID(),
                        onsessioninitialized: (id) => {
                            sessions.set(id, transport);
                            // Clean up session when it closes
                            transport.onclose = () => sessions.delete(id);
                        },
                    });
                    await server.connect(transport);
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Bad request: unknown session' }));
                    return;
                }

                await transport.handleRequest(req, res);
            } catch (err) {
                console.error('MCP error:', err);
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end('Internal Server Error');
                }
            }
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    });

    httpServer.listen(port, '0.0.0.0', () => {
        console.log(`${name} HTTP server running on port ${port}`);
    });

    httpServer.on('error', (err) => {
        console.error('Server error:', err);
    });

    return httpServer;
}
