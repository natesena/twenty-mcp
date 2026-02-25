#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { TwentyClient } from './client/twenty-client.js';
import { registerPersonTools, registerCompanyTools, registerTaskTools, registerOpportunityTools, registerActivityTools, registerMetadataTools, registerRelationshipTools } from './tools/index.js';
import { WellKnownRoutes } from './routes/well-known.js';
import { AuthMiddleware, AuthenticatedRequest } from './auth/middleware.js';
import { TokenValidator } from './auth/token-validator.js';
import { ClerkClient } from './auth/clerk-client.js';
import { getKeyStorageService } from './auth/key-storage.js';
import { ApiKeyRoutes } from './routes/api-keys.js';
import { IPMiddleware } from './auth/ip-middleware.js';

async function main() {
  const port = parseInt(process.env.PORT || '3000');
  const authEnabled = process.env.AUTH_ENABLED === 'true';
  const wellKnownRoutes = new WellKnownRoutes();
  const ipMiddleware = new IPMiddleware();
  
  // Initialize auth components only if auth is enabled
  let clerkClient: ClerkClient | null = null;
  let tokenValidator: TokenValidator | null = null;
  let authMiddleware: AuthMiddleware | null = null;
  let keyStorage: any = null;
  let apiKeyRoutes: ApiKeyRoutes | null = null;
  
  if (authEnabled) {
    clerkClient = new ClerkClient();
    tokenValidator = new TokenValidator(clerkClient);
    authMiddleware = new AuthMiddleware(tokenValidator);
    keyStorage = getKeyStorageService();
    apiKeyRoutes = new ApiKeyRoutes();
  }
  
  // Parse configuration from multiple sources
  async function parseConfig(url: string, userId?: string) {
    const urlObj = new URL(url, `http://localhost:${port}`);
    const params = urlObj.searchParams;
    
    // Check for user-specific stored API key first
    let apiKey = params.get('apiKey');
    let baseUrl = params.get('baseUrl');
    
    if (authEnabled && userId && !apiKey && keyStorage) {
      const storedKey = await keyStorage.getApiKey(userId);
      if (storedKey) {
        apiKey = storedKey.twentyApiKey;
        baseUrl = storedKey.twentyBaseUrl || baseUrl;
      }
    }
    
    // Priority: URL params > User stored key > Environment variables > Smithery config
    return {
      apiKey: apiKey || 
              process.env.TWENTY_API_KEY || 
              process.env.SMITHERY_CONFIG_APIKEY || 
              process.env.apiKey,
      baseUrl: baseUrl || 
               process.env.TWENTY_BASE_URL || 
               process.env.SMITHERY_CONFIG_BASEURL || 
               process.env.baseUrl ||
               'https://api.twenty.com',
    };
  }

  // Session storage: maps session IDs to their transports
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // Factory function to create a configured MCP server with all tools
  function createMcpServer(config: { apiKey: string; baseUrl: string }) {
    const server = new McpServer({
      name: 'twenty-mcp-server',
      version: '1.0.0',
    }, {
      capabilities: {
        tools: {},
        experimental: {
          authentication: {
            type: 'oauth2',
            required: authEnabled && process.env.REQUIRE_AUTH === 'true',
            enabled: authEnabled,
            discoveryEndpoints: authEnabled ? {
              protectedResource: '/.well-known/oauth-protected-resource',
              authorizationServer: '/.well-known/oauth-authorization-server'
            } : undefined
          }
        }
      }
    });

    const client = new TwentyClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });

    // Register all 7 tool modules (parity with stdio index.ts)
    registerPersonTools(server, client);
    registerCompanyTools(server, client);
    registerTaskTools(server, client);
    registerOpportunityTools(server, client);
    registerActivityTools(server, client);
    registerMetadataTools(server, client);
    registerRelationshipTools(server, client);

    return server;
  }

  // Create HTTP server
  const httpServer = createServer(async (req, res) => {
    // Check IP allowlist first (before any other processing)
    if (!await ipMiddleware.checkAccess(req, res)) {
      return; // IP middleware already sent response
    }
    
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
      await wellKnownRoutes.handleOptions(req, res);
      return;
    }
    
    // Handle health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'healthy', 
        service: 'twenty-mcp-server', 
        authEnabled,
        ipProtection: ipMiddleware.getConfig().enabled
      }));
      return;
    }
    
    // Handle API key management endpoints
    if (req.url?.startsWith('/api/keys')) {
      if (!authEnabled || !authMiddleware || !apiKeyRoutes) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const authReq = req as AuthenticatedRequest;
      if (!await authMiddleware.authenticate(authReq, res)) {
        return;
      }
      await apiKeyRoutes.handle(authReq, res);
      return;
    }
    
    // Handle OAuth discovery endpoints
    if (req.url === '/.well-known/oauth-protected-resource') {
      if (!authEnabled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      await wellKnownRoutes.handleProtectedResource(req, res);
      return;
    }
    
    if (req.url === '/.well-known/oauth-authorization-server') {
      if (!authEnabled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      await wellKnownRoutes.handleAuthorizationServer(req, res);
      return;
    }

    // Only handle /mcp endpoint
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    try {
      // Authenticate request if auth is enabled
      const authReq = req as AuthenticatedRequest;
      if (authEnabled && authMiddleware) {
        if (!await authMiddleware.authenticate(authReq, res)) {
          return; // Auth middleware already sent response
        }
      }

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existingTransport = sessionId ? sessions.get(sessionId) : undefined;

      // For GET and DELETE, we must have an existing session
      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!existingTransport) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session. Send an initialize request first.' },
            id: null,
          }));
          return;
        }
        await existingTransport.handleRequest(req, res);
        return;
      }

      // POST: parse body first so we can check isInitializeRequest
      let body: any = undefined;
      if (req.method === 'POST') {
        body = await new Promise<any>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const bodyText = Buffer.concat(chunks).toString();
              resolve(bodyText.trim() ? JSON.parse(bodyText) : undefined);
            } catch (error) {
              reject(error);
            }
          });
          req.on('error', reject);
        });
      }

      // If we have an existing session, delegate to its transport
      if (existingTransport) {
        await existingTransport.handleRequest(req, res, body);
        return;
      }

      // No existing session — only allow initialize requests
      if (!body || !isInitializeRequest(body)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session. Send an initialize request first.' },
          id: null,
        }));
        return;
      }

      // New session: resolve config and create server
      const userId = authReq.auth?.userId;
      const config = await parseConfig(req.url!, userId);

      if (!config.apiKey) {
        if (authEnabled && userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'No API key configured',
            error_description: 'Please configure your Twenty API key first'
          }));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Missing required apiKey parameter'
        }));
        return;
      }

      const mcpServer = createMcpServer({ apiKey: config.apiKey!, baseUrl: config.baseUrl });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, transport);
          console.log(`Session created: ${newSessionId} (active sessions: ${sessions.size})`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
          console.log(`Session closed: ${sid} (active sessions: ${sessions.size})`);
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error('Error handling request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error'
        }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.log(`Twenty MCP Server running at http://localhost:${port}/mcp`);
    console.log(`Health check available at http://localhost:${port}/health`);
    
    // Log configuration source for debugging
    if (process.env.SMITHERY_CONFIG_APIKEY) {
      console.log('Running in Smithery environment');
    } else if (process.env.TWENTY_API_KEY) {
      console.log('Using environment variables for configuration');
    } else {
      console.log(`Example: http://localhost:${port}/mcp?apiKey=YOUR_API_KEY&baseUrl=https://api.twenty.com`);
    }
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});