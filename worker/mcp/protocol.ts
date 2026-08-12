// JSON-RPC 2.0 + MCP plumbing for the read-only MCP endpoint (sprint 9,
// VISION.md phase-2 item 5). Minimal-compliant stateless Streamable HTTP:
// one POST = one JSON response, no SSE, no sessions (Mcp-Session-Id is
// ignored, as the spec allows for stateless servers), and single messages
// only — batch arrays are rejected with -32600 (pinned in docs + tests).
//
// Pure module — no D1, no env, no bindings. worker/index.ts binds the tool
// registry (worker/mcp/tools.ts) to the live env and routes through here;
// tests exercise everything directly.
import { isRecord } from '../util';

/** The protocol revision this server speaks (docs/MCP.md). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * serverInfo for `initialize`. The version mirrors package.json "version"
 * (tsconfig has no resolveJsonModule, so the value is pinned here — keep the
 * two in step).
 */
export const MCP_SERVER_INFO = { name: 'ledgerly', version: '0.1.0' } as const;

// JSON-RPC 2.0 reserved error codes.
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
// Server-defined codes (JSON-RPC reserves -32000..-32099): transport-level
// refusals that still carry a JSON-RPC-shaped body, so MCP clients only ever
// parse one error shape on this endpoint.
export const MCP_NOT_ALLOWED = -32000;
export const MCP_UNAUTHORIZED = -32001;
export const MCP_FORBIDDEN_ORIGIN = -32002;

/** MCP request ids are strings or numbers — never null (spec tightening). */
export type JsonRpcId = string | number;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * One POST body, classified. `invalid` carries the ready error response
 * (HTTP 400 at the transport); `notification` gets no response at all
 * (HTTP 202); `request` flows through handleMcpMessage.
 */
export type ParsedMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> | undefined }
  | { kind: 'notification'; method: string }
  | { kind: 'invalid'; response: JsonRpcResponse };

function invalid(code: number, message: string): ParsedMessage {
  return { kind: 'invalid', response: rpcError(null, code, message) };
}

/**
 * Parse + validate one raw POST body as a single JSON-RPC 2.0 message.
 * Malformed JSON → -32700; anything that is not one well-formed message
 * object (batch arrays included — v1 is single-message only) → -32600.
 * A message without an id is a notification by definition.
 */
export function parseJsonRpcMessage(raw: string): ParsedMessage {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid(RPC_PARSE_ERROR, 'The request body is not valid JSON.');
  }
  if (Array.isArray(body)) {
    return invalid(
      RPC_INVALID_REQUEST,
      'Batch arrays are not supported — send one JSON-RPC message per request.',
    );
  }
  if (!isRecord(body)) return invalid(RPC_INVALID_REQUEST, 'Send a single JSON-RPC 2.0 message object.');
  if (body.jsonrpc !== '2.0') return invalid(RPC_INVALID_REQUEST, 'jsonrpc must be the string "2.0".');
  const method = body.method;
  if (typeof method !== 'string' || method === '') {
    return invalid(RPC_INVALID_REQUEST, 'method must be a non-empty string.');
  }
  const params = body.params;
  if (params !== undefined && !isRecord(params)) {
    return invalid(RPC_INVALID_REQUEST, 'params must be an object when present.');
  }
  if (!('id' in body) || body.id === undefined) return { kind: 'notification', method };
  const id = body.id;
  // MCP tightens JSON-RPC here: a request id must be a string or a number —
  // a null id is neither a usable request nor a notification.
  if (typeof id !== 'string' && typeof id !== 'number') {
    return invalid(RPC_INVALID_REQUEST, 'id must be a string or a number.');
  }
  return { kind: 'request', id, method, params };
}

/**
 * A readable tool-level failure (bad arguments, honest domain refusals).
 * MCP semantics, pinned: JSON-RPC errors are for PROTOCOL problems
 * (malformed message, unknown method, unknown tool); anything that goes
 * wrong INSIDE a tool is reported as a tool result with isError:true so the
 * calling model can read the message and correct course.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** draft-07-flavored object schema — the only shape these tools use. */
export interface McpInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties: false;
}

/** One registered tool, already bound to whatever it needs (tools.ts). */
export interface McpToolHandle {
  name: string;
  description: string;
  inputSchema: McpInputSchema;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * The MCP method router. Returns the JSON-RPC response for a request, or
 * null when the message deserves no response body (notifications, and
 * unknown `notifications/*` strays — ignored per spec even when a confused
 * client attaches an id).
 */
export async function handleMcpMessage(
  message: ParsedMessage,
  tools: readonly McpToolHandle[],
): Promise<JsonRpcResponse | null> {
  if (message.kind === 'invalid') return message.response;
  if (message.kind === 'notification') return null;
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      // Whatever protocolVersion the client offered, respond with ours — a
      // stateless single-response server has nothing to negotiate (v1 pin).
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call':
      return callTool(id, params, tools);
    default:
      if (method.startsWith('notifications/')) return null;
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

async function callTool(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  tools: readonly McpToolHandle[],
): Promise<JsonRpcResponse> {
  const name = params?.name;
  if (typeof name !== 'string' || !name) {
    return rpcError(id, RPC_INVALID_PARAMS, 'params.name must be the tool name.');
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) return rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
  const args = params?.arguments ?? {};
  if (!isRecord(args)) return rpcError(id, RPC_INVALID_PARAMS, 'params.arguments must be an object.');
  try {
    const result = await tool.invoke(args);
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    });
  } catch (err) {
    if (err instanceof ToolError) {
      return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
    }
    // Message only — never arguments or financial data (spec §20).
    console.error('[ledgerly] mcp tool failed:', err instanceof Error ? err.message : 'unknown');
    return rpcResult(id, {
      content: [{ type: 'text', text: 'The tool failed unexpectedly. Try again.' }],
      isError: true,
    });
  }
}
