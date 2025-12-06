#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";
import { parse as shellParseArgs } from "shell-quote";
import nodeFetch, { Headers as NodeHeaders } from "node-fetch";

// Type-compatible wrappers for node-fetch to work with browser-style types
const fetch = nodeFetch;
const Headers = NodeHeaders;

import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express from "express";
import { findActualExecutable } from "spawn-rx";
import mcpProxy from "./mcpProxy.js";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import { existsSync, statSync } from 'fs';

const DEFAULT_MCP_PROXY_LISTEN_PORT = "6277";

const defaultEnvironment = {
  ...getDefaultEnvironment(),
  ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    env: { type: "string", default: "" },
    args: { type: "string", default: "" },
    command: { type: "string", default: "" },
    transport: { type: "string", default: "" },
    "server-url": { type: "string", default: "" },
  },
});

// Function to get HTTP headers.
const getHttpHeaders = (req: express.Request): Record<string, string> => {
  const headers: Record<string, string> = {};

  // Iterate over all headers in the request
  for (const key in req.headers) {
    const lowerKey = key.toLowerCase();

    // Check if the header is one we want to forward
    if (
      lowerKey.startsWith("mcp-") ||
      lowerKey === "authorization" ||
      lowerKey === "last-event-id"
    ) {
      // Exclude the proxy's own authentication header and the Client <-> Proxy session ID header
      if (lowerKey !== "x-mcp-proxy-auth" && lowerKey !== "mcp-session-id") {
        const value = req.headers[key];

        if (typeof value === "string") {
          // If the value is a string, use it directly
          headers[key] = value;
        } else if (Array.isArray(value)) {
          // If the value is an array, use the last element
          const lastValue = value.at(-1);
          if (lastValue !== undefined) {
            headers[key] = lastValue;
          }
        }
        // If value is undefined, it's skipped, which is correct.
      }
    }
  }

  // Handle the custom auth header separately. We expect `x-custom-auth-header`
  // to be a string containing the name of the actual authentication header.
  const customAuthHeaderName = req.headers["x-custom-auth-header"];
  if (typeof customAuthHeaderName === "string") {
    const lowerCaseHeaderName = customAuthHeaderName.toLowerCase();
    const value = req.headers[lowerCaseHeaderName];

    if (typeof value === "string") {
      headers[customAuthHeaderName] = value;
    } else if (Array.isArray(value)) {
      // If the actual auth header was sent multiple times, use the last value.
      const lastValue = value.at(-1);
      if (lastValue !== undefined) {
        headers[customAuthHeaderName] = lastValue;
      }
    }
  }

  // Handle multiple custom headers (new approach)
  if (req.headers["x-custom-auth-headers"] !== undefined) {
    try {
      const customHeaderNames = JSON.parse(
        req.headers["x-custom-auth-headers"] as string,
      ) as string[];
      if (Array.isArray(customHeaderNames)) {
        customHeaderNames.forEach((headerName) => {
          const lowerCaseHeaderName = headerName.toLowerCase();
          if (req.headers[lowerCaseHeaderName] !== undefined) {
            const value = req.headers[lowerCaseHeaderName];
            headers[headerName] = Array.isArray(value)
              ? value[value.length - 1]
              : value;
          }
        });
      }
    } catch (error) {
      console.warn("Failed to parse x-custom-auth-headers:", error);
    }
  }
  return headers;
};

/**
 * Updates a headers object in-place, preserving the original Accept header.
 * This is necessary to ensure that transports holding a reference to the headers
 * object see the updates.
 * @param currentHeaders The headers object to update.
 * @param newHeaders The new headers to apply.
 */
const updateHeadersInPlace = (
  currentHeaders: Record<string, string>,
  newHeaders: Record<string, string>,
) => {
  // Preserve the Accept header, which is set at transport creation and
  // is not present in subsequent client requests.
  const accept = currentHeaders["Accept"];

  // Clear the old headers and apply the new ones.
  Object.keys(currentHeaders).forEach((key) => delete currentHeaders[key]);
  Object.assign(currentHeaders, newHeaders);

  // Restore the Accept header.
  if (accept) {
    currentHeaders["Accept"] = accept;
  }
};

const app = express();
app.use(cors());
// Only parse JSON for our custom API endpoints, not for MCP SDK endpoints
app.use('/api/bt4', express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  next();
});

const webAppTransports: Map<string, Transport> = new Map<string, Transport>(); // Web app transports by web app sessionId
const serverTransports: Map<string, Transport> = new Map<string, Transport>(); // Server Transports by web app sessionId
const sessionHeaderHolders: Map<string, { headers: HeadersInit }> = new Map(); // For dynamic header updates

// Use provided token from environment or generate a new one
const sessionToken =
  process.env.MCP_PROXY_AUTH_TOKEN || randomBytes(32).toString("hex");
const authDisabled = !!process.env.DANGEROUSLY_OMIT_AUTH;

// Origin validation middleware to prevent DNS rebinding attacks
const originValidationMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const origin = req.headers.origin;

  // Default origins based on CLIENT_PORT or use environment variable
  const clientPort = process.env.CLIENT_PORT || "6274";
  const defaultOrigin = `http://localhost:${clientPort}`;
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
    defaultOrigin,
  ];

  if (origin && !allowedOrigins.includes(origin)) {
    console.error(`Invalid origin: ${origin}`);
    res.status(403).json({
      error: "Forbidden - invalid origin",
      message:
        "Request blocked to prevent DNS rebinding attacks. Configure allowed origins via environment variable.",
    });
    return;
  }
  next();
};

const authMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (authDisabled) {
    return next();
  }

  const sendUnauthorized = () => {
    res.status(401).json({
      error: "Unauthorized",
      message:
        "Authentication required. Use the session token shown in the console when starting the server.",
    });
  };

  const authHeader = req.headers["x-mcp-proxy-auth"];
  const authHeaderValue = Array.isArray(authHeader)
    ? authHeader[0]
    : authHeader;

  if (!authHeaderValue || !authHeaderValue.startsWith("Bearer ")) {
    sendUnauthorized();
    return;
  }

  const providedToken = authHeaderValue.substring(7); // Remove 'Bearer ' prefix
  const expectedToken = sessionToken;

  // Convert to buffers for timing-safe comparison
  const providedBuffer = Buffer.from(providedToken);
  const expectedBuffer = Buffer.from(expectedToken);

  // Check length first to prevent timing attacks
  if (providedBuffer.length !== expectedBuffer.length) {
    sendUnauthorized();
    return;
  }

  // Perform timing-safe comparison
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    sendUnauthorized();
    return;
  }

  next();
};

/**
 * Converts a Node.js ReadableStream to a web-compatible ReadableStream
 * This is necessary for the EventSource polyfill which expects web streams
 */
const createWebReadableStream = (nodeStream: any): ReadableStream => {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk: any) => {
        controller.enqueue(chunk);
      });
      nodeStream.on("end", () => {
        controller.close();
      });
      nodeStream.on("error", (err: any) => {
        controller.error(err);
      });
    },
  });
};

/**
 * Creates a `fetch` function that merges dynamic session headers with the
 * headers from the actual request, ensuring that request-specific headers like
 * `Content-Type` are preserved. For SSE requests, it also converts Node.js
 * streams to web-compatible streams.
 */
const createCustomFetch = (headerHolder: { headers: HeadersInit }) => {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Determine the headers from the original request/init.
    // The SDK may pass a Request object or a URL and an init object.
    const originalHeaders =
      input instanceof Request ? input.headers : init?.headers;

    // Start with our dynamic session headers.
    const finalHeaders = new Headers(headerHolder.headers);

    // Merge the SDK's request-specific headers, letting them overwrite.
    // This is crucial for preserving Content-Type on POST requests.
    new Headers(originalHeaders).forEach((value, key) => {
      finalHeaders.set(key, value);
    });

    // Convert Headers to a plain object for node-fetch compatibility
    const headersObject: Record<string, string> = {};
    finalHeaders.forEach((value, key) => {
      headersObject[key] = value;
    });

    // Get the response from node-fetch (cast input and init to handle type differences)
    const response = await fetch(
      input as any,
      { ...init, headers: headersObject } as any,
    );

    // Check if this is an SSE request by looking at the Accept header
    const acceptHeader = finalHeaders.get("Accept");
    const isSSE = acceptHeader?.includes("text/event-stream");

    if (isSSE && response.body) {
      // For SSE requests, we need to convert the Node.js stream to a web ReadableStream
      // because the EventSource polyfill expects web-compatible streams
      const webStream = createWebReadableStream(response.body);

      // Create a new response with the web-compatible stream
      // Convert node-fetch headers to plain object for web Response compatibility
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value: string, key: string) => {
        responseHeaders[key] = value;
      });

      return new Response(webStream, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      }) as Response;
    }

    // For non-SSE requests, return the response as-is (cast to handle type differences)
    return response as unknown as Response;
  };
};

// Create a filtered STDIO transport that only passes valid JSON-RPC messages
const createFilteredStdioTransport = async (
  command: string,
  args: string[],
  env: Record<string, string>
): Promise<StdioClientTransport> => {
  console.log(`🔍 DEBUG createFilteredStdioTransport: command=${command}, args=${JSON.stringify(args)}`);
  console.log(`🔍 DEBUG createFilteredStdioTransport: command type=${typeof command}, command value="${command}"`);
  
  if (!command) {
    throw new Error(`Command is undefined or empty in createFilteredStdioTransport: ${command}`);
  }
  
  // Use the standard StdioClientTransport constructor with command, args, and env
  const transport = new StdioClientTransport({
    command: command,
    args: args,
    env,
  });

  await transport.start();
  return transport;
};

const createTransport = async (
  req: express.Request,
): Promise<{
  transport: Transport;
  headerHolder?: { headers: HeadersInit };
}> => {
  const query = req.query;
  console.log("Query parameters:", JSON.stringify(query));

  const transportType = query.transportType as string;

  if (transportType === "stdio") {
    const rawCommand = (query.command as string).trim();
    // Resolve relative paths from OI_PROJECT_PATH or fallback to relative resolution
    const bt4Root = process.env.OI_PROJECT_PATH || 
      (() => {
        // Fallback: try to find project root by going up from inspector/server/build/
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        return resolve(__dirname, '../../../');
      })();
    const command = rawCommand.startsWith('./') ? 
      resolve(bt4Root, rawCommand) : rawCommand;
    
    console.log(`Raw command: ${rawCommand}, Resolved command: ${command}`);
    console.log(`📁 Using project root: ${bt4Root}`);
    
    // Handle args as either JSON string, regular string, or pre-parsed array
    let origArgs: string[];
    if (typeof query.args === 'string') {
      // Try to parse as JSON first (from frontend)
      try {
        const parsed = JSON.parse(query.args);
        origArgs = Array.isArray(parsed) ? parsed : [];
      } catch {
        // Fallback to shell parsing for non-JSON strings
        origArgs = shellParseArgs(query.args) as string[];
      }
    } else if (Array.isArray(query.args)) {
      origArgs = query.args.map(arg => String(arg));
    } else {
      origArgs = [];
    }
    
    // Resolve relative paths in args as well
    origArgs = origArgs.map(arg => {
      // Resolve paths that start with ./ or MCP-servers/
      if (arg.startsWith('./') || arg.startsWith('MCP-servers/')) {
        return resolve(bt4Root, arg);
      }
      return arg;
    });
    
    const queryEnv = query.env ? JSON.parse(query.env as string) : {};
    const env = { ...defaultEnvironment, ...process.env, ...queryEnv };

    // Use findActualExecutable to resolve the command properly
    // Handle both array and JSON string formats
    let args;
    console.log(`🔍 DEBUG: origArgs type: ${typeof origArgs}, value: ${origArgs}`);
    console.log(`🔍 DEBUG: Array.isArray(origArgs): ${Array.isArray(origArgs)}`);
    console.log(`🔍 DEBUG: origArgs constructor: ${origArgs?.constructor?.name}`);
    
    if (Array.isArray(origArgs)) {
      // Check if it's a single-element array with a comma-separated string
      if (origArgs.length === 1 && typeof origArgs[0] === 'string' && origArgs[0].includes(',')) {
        args = origArgs[0].split(',');
        console.log(`🔍 DEBUG: Single-element array with comma-separated string, split: ${args}`);
      } else {
        args = origArgs;
        console.log(`🔍 DEBUG: Using array directly: ${args}`);
      }
    } else if (typeof origArgs === 'string') {
      // Try to parse as JSON first
      try {
        const parsed = JSON.parse(origArgs);
        console.log(`🔍 DEBUG: JSON parsed successfully: ${JSON.stringify(parsed)}`);
        if (Array.isArray(parsed)) {
          args = parsed;
          console.log(`🔍 DEBUG: Using parsed JSON array: ${args}`);
        } else {
          // Single string argument
          args = [origArgs];
          console.log(`🔍 DEBUG: Single string, wrapped in array: ${args}`);
        }
      } catch (e) {
        // Not JSON, treat as comma-separated string
        args = String(origArgs).split(',');
        console.log(`🔍 DEBUG: Not JSON, split by comma: ${args}`);
      }
    } else if (typeof origArgs === 'object' && origArgs !== null) {
      // Handle object case - check if it's a comma-separated string
      const stringValue = String(origArgs);
      if (stringValue.includes(',')) {
        args = stringValue.split(',');
        console.log(`🔍 DEBUG: Object with comma-separated string, split: ${args}`);
      } else {
        args = [stringValue];
        console.log(`🔍 DEBUG: Object with single value, wrapped: ${args}`);
      }
    } else {
      // Fallback to empty array
      args = [];
      console.log(`🔍 DEBUG: Fallback to empty array`);
    }
    
    // Ensure args is always an array
    if (!Array.isArray(args)) {
      args = [];
      console.log(`🔍 DEBUG: Forced to empty array`);
    }
    
    console.log(`🔍 DEBUG: Final args: ${JSON.stringify(args)}, type: ${typeof args}, isArray: ${Array.isArray(args)}`);

    // Resolve the actual executable using findActualExecutable
    const { cmd: actualCommand, args: actualArgs } = findActualExecutable(
      command,
      args
    );

    console.log(`STDIO transport: command=${actualCommand}, args=${actualArgs}`);
    console.log(`Command type: ${typeof actualCommand}, Args type: ${typeof actualArgs}, Args length: ${Array.isArray(actualArgs) ? actualArgs.length : 'not array'}`);

    // Apply stdout filtering for MCP protocol compliance
    console.log(`🔍 DEBUG: About to create transport with cmd=${actualCommand}, args=${JSON.stringify(actualArgs)}`);
    console.log(`🔍 DEBUG: cmd type: ${typeof actualCommand}, cmd value: ${actualCommand}`);
    console.log(`🔍 DEBUG: args type: ${typeof actualArgs}, args isArray: ${Array.isArray(actualArgs)}, args length: ${actualArgs?.length}`);
    
    if (!actualCommand) {
      throw new Error('Command is undefined or empty');
    }
    if (!Array.isArray(actualArgs)) {
      throw new Error(`Args must be an array, got ${typeof actualArgs}: ${JSON.stringify(actualArgs)}`);
    }
    
    // Create transport with proper parameters including stderr
    console.log(`🔍 DEBUG: Creating StdioClientTransport with cmd=${actualCommand}, args=${JSON.stringify(actualArgs)}`);
    const transport = new StdioClientTransport({
      command: actualCommand,
      args: actualArgs,
      env,
      stderr: "pipe"
    });
    await transport.start();
    return { transport };
  } else if (transportType === "sse") {
    const url = query.url as string;

    const headers = getHttpHeaders(req);
    headers["Accept"] = "text/event-stream";
    const headerHolder = { headers };

    console.log(
      `SSE transport: url=${url}, headers=${JSON.stringify(headers)}`,
    );

    const transport = new SSEClientTransport(new URL(url), {
      eventSourceInit: {
        fetch: createCustomFetch(headerHolder),
      },
      requestInit: {
        headers: headerHolder.headers,
      },
    });
    await transport.start();
    return { transport, headerHolder };
  } else if (transportType === "streamable-http") {
    const headers = getHttpHeaders(req);
    headers["Accept"] = "text/event-stream, application/json";
    const headerHolder = { headers };

    const transport = new StreamableHTTPClientTransport(
      new URL(query.url as string),
      {
        // Pass a custom fetch to inject the latest headers on each request
        fetch: createCustomFetch(headerHolder),
      },
    );
    await transport.start();
    return { transport, headerHolder };
  } else {
    console.error(`Invalid transport type: ${transportType}`);
    throw new Error("Invalid transport type specified");
  }
};

app.get(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    console.log(`Received GET message for sessionId ${sessionId}`);

    const headerHolder = sessionHeaderHolders.get(sessionId);
    if (headerHolder) {
      updateHeadersInPlace(
        headerHolder.headers as Record<string, string>,
        getHttpHeaders(req),
      );
    }

    try {
      const transport = webAppTransports.get(
        sessionId,
      ) as StreamableHTTPServerTransport;
      if (!transport) {
        res.status(404).end("Session not found");
        return;
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (error) {
      console.error("Error in /mcp route:", error);
      res.status(500).json(error);
    }
  },
);

app.post(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      console.log(`Received POST message for sessionId ${sessionId}`);
      const headerHolder = sessionHeaderHolders.get(sessionId);
      if (headerHolder) {
        updateHeadersInPlace(
          headerHolder.headers as Record<string, string>,
          getHttpHeaders(req),
        );
      }

      try {
        const transport = webAppTransports.get(
          sessionId,
        ) as StreamableHTTPServerTransport;
        if (!transport) {
          res.status(404).end("Transport not found for sessionId " + sessionId);
        } else {
          await (transport as StreamableHTTPServerTransport).handleRequest(
            req,
            res,
          );
        }
      } catch (error) {
        console.error("Error in /mcp route:", error);
        res.status(500).json(error);
      }
    } else {
      console.log("New StreamableHttp connection request");
      try {
        const { transport: serverTransport, headerHolder } =
          await createTransport(req);

        const webAppTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sessionId) => {
            webAppTransports.set(sessionId, webAppTransport);
            serverTransports.set(sessionId, serverTransport!); // eslint-disable-line @typescript-eslint/no-non-null-assertion
            if (headerHolder) {
              sessionHeaderHolders.set(sessionId, headerHolder);
            }
            console.log("Client <-> Proxy  sessionId: " + sessionId);
          },
          onsessionclosed: (sessionId) => {
            webAppTransports.delete(sessionId);
            serverTransports.delete(sessionId);
            sessionHeaderHolders.delete(sessionId);
          },
        });
        console.log("Created StreamableHttp client transport");

        await webAppTransport.start();

        mcpProxy({
          transportToClient: webAppTransport,
          transportToServer: serverTransport,
        });

        await (webAppTransport as StreamableHTTPServerTransport).handleRequest(
          req,
          res,
          req.body,
        );
      } catch (error) {
        if (error instanceof SseError && error.code === 401) {
          console.error(
            "Received 401 Unauthorized from MCP server:",
            error.message,
          );
          res.status(401).json(error);
          return;
        }
        console.error("Error in /mcp POST route:", error);
        res.status(500).json(error);
      }
    }
  },
);

app.delete(
  "/mcp",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    console.log(`Received DELETE message for sessionId ${sessionId}`);
    if (sessionId) {
      try {
        const serverTransport = serverTransports.get(
          sessionId,
        ) as StreamableHTTPClientTransport;
        if (!serverTransport) {
          res.status(404).end("Transport not found for sessionId " + sessionId);
        } else {
          await serverTransport.terminateSession();
          webAppTransports.delete(sessionId);
          serverTransports.delete(sessionId);
          sessionHeaderHolders.delete(sessionId);
          console.log(`Transports removed for sessionId ${sessionId}`);
        }
        res.status(200).end();
      } catch (error) {
        console.error("Error in /mcp route:", error);
        res.status(500).json(error);
      }
    }
  },
);

app.get(
  "/stdio",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      console.log("New STDIO connection request");
      const { transport: serverTransport } = await createTransport(req);

      const proxyFullAddress = (req.query.proxyFullAddress as string) || "";
      const prefix = proxyFullAddress || "";
      const endpoint = `${prefix}/message`;

      const webAppTransport = new SSEServerTransport(endpoint, res);
      webAppTransports.set(webAppTransport.sessionId, webAppTransport);
      console.log("Created client transport");

      serverTransports.set(webAppTransport.sessionId, serverTransport);
      console.log("Created server transport");

      await webAppTransport.start();

      const stderr = (serverTransport as StdioClientTransport).stderr;
      if (stderr && stderr.on) {
        stderr.on("data", (chunk) => {
        if (chunk.toString().includes("MODULE_NOT_FOUND")) {
          // Server command not found, remove transports
          const message = "Command not found, transports removed";
          webAppTransport.send({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: {
              level: "emergency",
              logger: "proxy",
              data: {
                message,
              },
            },
          });
          webAppTransport.close();
          serverTransport.close();
          webAppTransports.delete(webAppTransport.sessionId);
          serverTransports.delete(webAppTransport.sessionId);
          sessionHeaderHolders.delete(webAppTransport.sessionId);
          console.error(message);
        } else {
          // Inspect message and attempt to assign a RFC 5424 Syslog Protocol level
          let level;
          let message = chunk.toString().trim();
          let ucMsg = chunk.toString().toUpperCase();
          if (ucMsg.includes("DEBUG")) {
            level = "debug";
          } else if (ucMsg.includes("INFO")) {
            level = "info";
          } else if (ucMsg.includes("NOTICE")) {
            level = "notice";
          } else if (ucMsg.includes("WARN")) {
            level = "warning";
          } else if (ucMsg.includes("ERROR")) {
            level = "error";
          } else if (ucMsg.includes("CRITICAL")) {
            level = "critical";
          } else if (ucMsg.includes("ALERT")) {
            level = "alert";
          } else if (ucMsg.includes("EMERGENCY")) {
            level = "emergency";
          } else if (ucMsg.includes("SIGINT")) {
            message = "SIGINT received. Server shutdown.";
            level = "emergency";
          } else if (ucMsg.includes("SIGHUP")) {
            message = "SIGHUP received. Server shutdown.";
            level = "emergency";
          } else if (ucMsg.includes("SIGTERM")) {
            message = "SIGTERM received. Server shutdown.";
            level = "emergency";
          } else {
            level = "info";
          }
          // Check if transport is still connected before sending
          try {
            if (webAppTransports.has(webAppTransport.sessionId)) {
              webAppTransport.send({
                jsonrpc: "2.0",
                method: "notifications/message",
                params: {
                  level,
                  logger: "stdio",
                  data: {
                    message,
                  },
                },
              });
            }
          } catch (error) {
            // Ignore "Not connected" errors to prevent crashes
            console.log('Transport send failed (connection closed):', error instanceof Error ? error.message : String(error));
          }
        }
        });
      }

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: serverTransport,
      });
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server. Authentication failure.",
        );
        res.status(401).json(error);
        return;
      }
      console.error("Error in /stdio route:", error);
      res.status(500).json(error);
    }
  },
);

app.get(
  "/sse",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      console.log(
        "New SSE connection request. NOTE: The SSE transport is deprecated and has been replaced by StreamableHttp",
      );
      const { transport: serverTransport, headerHolder } =
        await createTransport(req);

      const proxyFullAddress = (req.query.proxyFullAddress as string) || "";
      const prefix = proxyFullAddress || "";
      const endpoint = `${prefix}/message`;

      const webAppTransport = new SSEServerTransport(endpoint, res);
      webAppTransports.set(webAppTransport.sessionId, webAppTransport);
      console.log("Created client transport");

      serverTransports.set(webAppTransport.sessionId, serverTransport!); // eslint-disable-line @typescript-eslint/no-non-null-assertion
      if (headerHolder) {
        sessionHeaderHolders.set(webAppTransport.sessionId, headerHolder);
      }
      console.log("Created server transport");

      await webAppTransport.start();

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: serverTransport,
      });
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server. Authentication failure.",
        );
        res.status(401).json(error);
        return;
      } else if (error instanceof SseError && error.code === 404) {
        console.error(
          "Received 404 not found from MCP server. Does the MCP server support SSE?",
        );
        res.status(404).json(error);
        return;
      } else if (JSON.stringify(error).includes("ECONNREFUSED")) {
        console.error("Connection refused. Is the MCP server running?");
        res.status(500).json(error);
      }
      console.error("Error in /sse route:", error);
      res.status(500).json(error);
    }
  },
);

app.post(
  "/message",
  originValidationMiddleware,
  authMiddleware,
  async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      console.log(`Received POST message for sessionId ${sessionId}`);

      const headerHolder = sessionHeaderHolders.get(sessionId);
      if (headerHolder) {
        updateHeadersInPlace(
          headerHolder.headers as Record<string, string>,
          getHttpHeaders(req),
        );
      }

      const transport = webAppTransports.get(sessionId) as SSEServerTransport;
      if (!transport) {
        res.status(404).end("Session not found");
        return;
      }
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("Error in /message route:", error);
      res.status(500).json(error);
    }
  },
);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

app.get("/config", originValidationMiddleware, authMiddleware, (req, res) => {
  try {
    res.json({
      defaultEnvironment,
      defaultCommand: values.command,
      defaultArgs: values.args,
      defaultTransport: values.transport,
      defaultServerUrl: values["server-url"],
    });
  } catch (error) {
    console.error("Error in /config route:", error);
    res.status(500).json(error);
  }
});

// ========================================================================
// 🧠 BRAIN TRUST 4 DATABASE INTEGRATION
// ========================================================================

// Database setup using OI_PROJECT_PATH or fallback to relative path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = process.env.OI_PROJECT_PATH 
  ? resolve(process.env.OI_PROJECT_PATH, 'brain-trust4.db')
  : resolve(__dirname, '../../../brain-trust4.db');

console.log('🧠 Brain Trust 4 Database Integration Starting...');
console.log(`🗄️ Database path: ${dbPath}`);

// Check if database exists
if (!existsSync(dbPath)) {
  console.error(`❌ Brain Trust 4 database not found at: ${dbPath}`);
  console.error('❌ Database integration disabled - using fallback data');
}

// Initialize database connection
let bt4db: sqlite3.Database | null = null;

if (existsSync(dbPath)) {
  try {
    bt4db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
      if (err) {
        console.error('❌ Failed to connect to Brain Trust 4 database:', err.message);
        bt4db = null;
      } else {
        console.log('✅ Connected to Brain Trust 4 database successfully');
        
        // Test database with simple query
        bt4db?.get("SELECT COUNT(*) as count FROM mcp_servers", [], (err, row: any) => {
          if (err) {
            console.error('❌ Database query test failed:', err.message);
            bt4db = null;
          } else {
            console.log(`🎯 Database test successful: Found ${row?.count || 0} MCP servers`);
          }
        });
      }
    });
  } catch (error) {
    console.error('❌ Database connection error:', error);
    bt4db = null;
  }
}

console.log('🧠 Brain Trust 4 database integration initialized');

// API endpoint: Get all servers from BT4 database
app.get('/api/bt4/servers', originValidationMiddleware, (req, res) => {
  console.log('🧠 API Request: /api/bt4/servers');
  
  if (!bt4db) {
    console.log('❌ No database connection - returning fallback data');
    res.json([
      {
        name: "mcp-monitor",
        command: "./MCP-servers/mcp-monitor/bin/mcp-monitor",
        args: ["-transport", "stdio"],
        description: "System monitoring server (fallback)",
        tools_count: 5,
        health_status: "healthy"
      }
    ]);
    return;
  }

  const query = `
    SELECT 
      name, 
      command, 
      args, 
      description,
      (SELECT COUNT(*) FROM tools WHERE server_id = mcp_servers.id) as tools_count,
      health_status
    FROM mcp_servers 
    ORDER BY name
  `;
  
  bt4db.all(query, [], (err, rows: any) => {
    if (err) {
      console.error('❌ Database error fetching servers:', err);
      res.status(500).json({ error: 'Database error' });
      return;
    }
    
    // Parse args from JSON string to array
    const servers = rows.map((row: any) => ({
      ...row,
      args: row.args ? JSON.parse(row.args) : []
    }));
    
    console.log(`✅ Fetched ${servers.length} servers from database`);
    console.log('📋 First 3 servers:', servers.slice(0, 3).map((s: any) => s.name));
    res.json(servers);
  });
});

// API endpoint: Get intent mappings from BT4 database
app.get('/api/bt4/intents', originValidationMiddleware, (req, res) => {
  console.log('🧠 API Request: /api/bt4/intents');
  
  if (!bt4db) {
    console.log('❌ No database connection - returning empty intents');
    res.json([]);
    return;
  }

  const query = `
    SELECT keyword, server_name, tool_name, priority 
    FROM intent_mappings 
    ORDER BY priority DESC, keyword
  `;
  
  bt4db.all(query, [], (err, rows) => {
    if (err) {
      console.error('❌ Database error fetching intent_mappings:', err);
      res.status(500).json({ error: 'Database error' });
      return;
    }
    
    console.log(`✅ Fetched ${rows?.length || 0} intent mappings from database`);
    console.log('📋 First 3 mappings:', rows?.slice(0, 3));
    res.json(rows);
  });
});

// API endpoint: Get analytics from BT4 database
app.get('/api/bt4/analytics', originValidationMiddleware, (req, res) => {
  console.log('🧠 API Request: /api/bt4/analytics');
  
  if (!bt4db) {
    console.log('❌ No database connection - returning fallback analytics');
    res.json({
      servers_count: 0,
      tools_count: 0,
      intents_count: 0,
      status: 'Brain Trust 4 Database Connection Failed'
    });
    return;
  }

  // Get analytics data from multiple tables
  const queries = {
    servers: "SELECT COUNT(*) as count FROM mcp_servers",
    tools: "SELECT COUNT(*) as count FROM tools", 
    intents: "SELECT COUNT(*) as count FROM intent_mappings"
  };
  
  let completed = 0;
  const results: any = {};
  
  Object.entries(queries).forEach(([key, query]) => {
    bt4db!.get(query, [], (err, row: any) => {
      if (err) {
        console.error(`❌ Analytics query error for ${key}:`, err);
        results[`${key}_count`] = 0;
      } else {
        results[`${key}_count`] = row?.count || 0;
      }
      
      completed++;
      if (completed === Object.keys(queries).length) {
        results.status = 'Brain Trust 4 Database Integration Active';
        console.log('✅ Analytics data:', results);
        res.json(results);
      }
    });
  });
});

/*

// API endpoint: Get intent mappings from BT4 database
app.get('/api/bt4/intents', originValidationMiddleware, (req, res) => {
  console.log('🧠 API Request: /api/bt4/intents');
  const query = `
    SELECT keyword, server_name, tool_name, priority 
    FROM intent_mappings 
    ORDER BY priority DESC, keyword
  `;
  
  bt4db.all(query, [], (err, rows) => {
    if (err) {
      console.error('❌ Database error fetching intent_mappings:', err);
      res.status(500).json({ error: 'Database error' });
      return;
    }
    
    console.log(`✅ Fetched ${rows?.length || 0} intent mappings from database`);
    console.log('📋 First 3 mappings:', rows?.slice(0, 3));
    res.json(rows);
  });
});

// API endpoint: Get tools for a specific server
app.get('/api/bt4/servers/:serverName/tools', originValidationMiddleware, (req, res) => {
  const serverName = req.params.serverName;
  
  console.log(`🧠 API Request: /api/bt4/servers/${serverName}/tools`);
  
  const query = `
    SELECT t.name, t.description 
    FROM tools t
    JOIN mcp_servers s ON t.server_id = s.id
    WHERE s.name = ? 
    ORDER BY t.name
  `;
  
  bt4db.all(query, [serverName], (err, rows: any) => {
    if (err) {
      console.error('❌ Database error:', err);
      res.status(500).json({ error: 'Database error' });
      return;
    }
    
    console.log(`✅ Fetched ${rows?.length || 0} tools for server: ${serverName}`);
    console.log('📋 First 3 tools:', rows?.slice(0, 3));
    res.json(rows || []);
  });
});

// API endpoint: Get basic analytics from BT4 database
app.get('/api/bt4/analytics', originValidationMiddleware, (req, res) => {
  // Get server count and tool count
  const serverCountQuery = 'SELECT COUNT(*) as count FROM mcp_servers';
  const toolCountQuery = 'SELECT COUNT(*) as count FROM tools';
  const intentCountQuery = 'SELECT COUNT(*) as count FROM intent_mappings';
  
  bt4db.get(serverCountQuery, [], (err, serverResult: any) => {
    if (err) {
      res.status(500).json({ error: 'Database error' });
      return;
    }
    
    bt4db.get(toolCountQuery, [], (err, toolResult: any) => {
      if (err) {
        res.status(500).json({ error: 'Database error' });
        return;
      }
      
      bt4db.get(intentCountQuery, [], (err, intentResult: any) => {
        if (err) {
          res.status(500).json({ error: 'Database error' });
          return;
        }
        
        res.json({
          servers_count: serverResult.count,
          tools_count: toolResult.count,
          intents_count: intentResult.count,
          status: 'Brain Trust 4 Integration Active'
        });
      });
    });
  });
});

// API endpoint: Add new intent mapping (simple CRUD)
app.post('/api/bt4/intents', originValidationMiddleware, (req, res) => {
  const { keyword, server_name, tool_name, priority } = req.body;
  
  console.log('🧠 API Request: POST /api/bt4/intents', { keyword, server_name, tool_name, priority });
  
  if (!keyword || !server_name || !tool_name) {
    res.status(400).json({ error: 'Missing required fields: keyword, server_name, tool_name' });
    return;
  }
  
  // Set default priority if not provided
  const finalPriority = priority || 5;
  
  // Check if mapping already exists (keyword is PRIMARY KEY)
  const checkQuery = 'SELECT keyword FROM intent_mappings WHERE keyword = ?';
  bt4db.get(checkQuery, [keyword], (err, existingRow) => {
    if (err) {
      console.error('❌ Database error checking existing mapping:', err);
      res.status(500).json({ error: 'Database error checking existing mapping' });
      return;
    }
    
    if (existingRow) {
      res.status(409).json({ error: 'Intent mapping with this keyword already exists' });
      return;
    }
    
    // Insert new intent mapping
    const insertQuery = `
      INSERT INTO intent_mappings (keyword, server_name, tool_name, priority)
      VALUES (?, ?, ?, ?)
    `;
    
    bt4db.run(insertQuery, [keyword, server_name, tool_name, finalPriority], function(err) {
      if (err) {
        console.error('❌ Database error inserting intent mapping:', err);
        res.status(500).json({ error: 'Database error inserting intent mapping' });
        return;
      }
      
      console.log(`✅ Successfully added intent mapping: ${keyword} → ${server_name}::${tool_name} (priority: ${finalPriority})`);
      res.json({ 
        success: true, 
        message: 'Intent mapping added successfully',
        keyword: keyword,
        mapping: { keyword, server_name, tool_name, priority: finalPriority }
      });
    });
  });
});

// API endpoint: Delete intent mapping
app.delete('/api/bt4/intents/:keyword', originValidationMiddleware, (req, res) => {
  const { keyword } = req.params;
  
  console.log('🧠 API Request: DELETE /api/bt4/intents/', keyword);
  
  if (!keyword) {
    res.status(400).json({ error: 'Invalid intent mapping keyword' });
    return;
  }
  
  const deleteQuery = 'DELETE FROM intent_mappings WHERE keyword = ?';
  
  bt4db.run(deleteQuery, [keyword], function(err) {
    if (err) {
      console.error('❌ Database error deleting intent mapping:', err);
      res.status(500).json({ error: 'Database error deleting intent mapping' });
      return;
    }
    
    if (this.changes === 0) {
      res.status(404).json({ error: 'Intent mapping not found' });
      return;
    }
    
    console.log(`✅ Successfully deleted intent mapping with keyword: ${keyword}`);
    res.json({ 
      success: true, 
      message: 'Intent mapping deleted successfully',
      deletedKeyword: keyword
    });
  });
});
*/

const PORT = parseInt(
  process.env.SERVER_PORT || DEFAULT_MCP_PROXY_LISTEN_PORT,
  10,
);
const HOST = process.env.HOST || "localhost";

const server = app.listen(PORT, HOST);
server.on("listening", () => {
  console.log(`⚙️ Proxy server listening on ${HOST}:${PORT}`);
  if (!authDisabled) {
    console.log(
      `🔑 Session token: ${sessionToken}\n   ` +
        `Use this token to authenticate requests or set DANGEROUSLY_OMIT_AUTH=true to disable auth`,
    );
  } else {
    console.log(
      `⚠️  WARNING: Authentication is disabled. This is not recommended.`,
    );
  }
});
server.on("error", (err) => {
  if (err.message.includes(`EADDRINUSE`)) {
    console.error(`❌  Proxy Server PORT IS IN USE at port ${PORT} ❌ `);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
