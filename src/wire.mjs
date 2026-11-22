// The one contract both halves import. The host validates what it sends; the
// tenant side validates what it receives; the server forwards without reading,
// so a version skew between an old host and a new tenant fails here with
// `bad_message` instead of inside a tool call.
//
// A breaking change is a new `v`, never a mutated field. Adding an optional
// field is the only additive change allowed.

export const WIRE_VERSION = 1;

// ⚠ THE FRAMES ARE A SHARED ARTIFACT, NOT A CONVENTION. Each hop used to check
// its own fields ad hoc, so an unknown `type` was answered `unknown message X`
// only after the receiver had already switched on it, and a malformed field was
// described by whichever branch happened to read it. One JSON file now names
// every frame in every direction, and each receiver validates the frame it
// accepts before reading a single field.
export { frameSchema, validate as validateSchema } from './schema.mjs';
import PROTOCOL from './protocol.v1.json' with { type: 'json' };
import { frameSchema, validate as validateSchema } from './schema.mjs';

export const MAX_CATALOG_BYTES = 256 * 1024;
export const MAX_ARGS_BYTES = 512 * 1024;
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;
export const MAX_FRAME_BYTES = MAX_RESULT_BYTES + 64 * 1024;

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
// Mirrors the `mcp__<server>__<tool>` shape dsh-mcp-oauth already publishes, so
// a model's habit of reading that prefix as "an MCP tool" stays true.
const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message) {
  const error = new Error(message);
  error.code = 'bad_message';
  return error;
}

export function publicToolName(server, tool) {
  return `mcp__dragonbyte_${server}__${tool}`;
}

/** The wire name a public tool name maps back to, or null when it is not ours. */
export function parsePublicToolName(name) {
  const match = /^mcp__dragonbyte_([a-z][a-z0-9-]{0,31})__(.+)$/.exec(String(name || ''));
  if (!match || !TOOL_NAME.test(match[2])) return null;
  return { server: match[1], tool: match[2] };
}

/** Throws `bad_message` rather than returning false: every caller would throw. */
export function assertEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(value)) throw invalid('invalid email');
  return value;
}

/**
 * Validate one frame of one hop against the shared schema.
 *
 * ⚠ THE VERSION CHECK COMES FIRST AND IS DELIBERATELY NOT `const: 1` IN THE
 * SCHEMA. Version skew between a laptop, a bridge and an immutable tenant
 * bundle is normal, so it must fail with a message that names it rather than
 * with a field-by-field complaint from a schema that assumed today's version.
 *
 * @param {object} message the decoded frame
 * @param {string} direction e.g. `host-to-bridge`
 * @param {string} frame e.g. `catalog`
 * @returns {object} the same message, for chaining
 */
export function assertFrame(message, direction, frame) {
  if (message?.v !== WIRE_VERSION) throw invalid(`unsupported wire version ${JSON.stringify(message?.v)}`);
  const problem = validateSchema(frameSchema(PROTOCOL, direction, frame), message);
  if (problem !== null) throw invalid(`${direction} ${frame}: ${problem}`);
  return message;
}

export function validateCatalog(catalog) {
  if (!isObject(catalog) || !Array.isArray(catalog.servers)) throw invalid('catalog.servers must be an array');
  if (catalog.servers.length > 32) throw invalid('catalog names more than 32 servers');
  const seenServers = new Set();
  let tools = 0;
  const servers = catalog.servers.map((server) => {
    if (!isObject(server) || !SERVER_NAME.test(server.name || '')) throw invalid('invalid server name');
    if (seenServers.has(server.name)) throw invalid(`duplicate server ${server.name}`);
    seenServers.add(server.name);
    if (!Array.isArray(server.tools)) throw invalid(`server ${server.name} has no tools array`);
    const seenTools = new Set();
    const entries = server.tools.map((tool) => {
      if (!isObject(tool) || !TOOL_NAME.test(tool.name || '')) throw invalid(`invalid tool name on ${server.name}`);
      if (seenTools.has(tool.name)) throw invalid(`duplicate tool ${server.name}/${tool.name}`);
      seenTools.add(tool.name);
      if (tool.description !== undefined && typeof tool.description !== 'string') throw invalid('tool description must be a string');
      // ⚠ NOT validated further on purpose. An MCP input schema is whatever the
      // server said, and this bridge does not re-implement JSON Schema: a
      // stricter check here would reject a valid server and a looser one would
      // give the model a schema the server never agreed to.
      if (!isObject(tool.inputSchema ?? {})) throw invalid('tool inputSchema must be an object');
      tools += 1;
      return { name: tool.name, description: String(tool.description ?? ''), inputSchema: tool.inputSchema ?? { type: 'object' } };
    });
    return { name: server.name, label: String(server.label ?? server.name).slice(0, 80), tools: entries };
  });
  if (tools === 0) throw invalid('catalog carries no tools');
  if (tools > 256) throw invalid('catalog carries more than 256 tools');
  const value = { servers };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CATALOG_BYTES) throw invalid('catalog exceeds 256 KiB');
  return value;
}

export function validateArgs(args) {
  if (!isObject(args)) throw invalid('tool arguments must be an object');
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) throw invalid('tool arguments exceed 512 KiB');
  return args;
}

export function validateResult(result) {
  if (!isObject(result) || !Array.isArray(result.content)) throw invalid('result.content must be an array');
  for (const item of result.content) {
    if (!isObject(item) || typeof item.type !== 'string') throw invalid('result content item has no type');
  }
  if (result.structuredContent !== undefined && !isObject(result.structuredContent)) throw invalid('structuredContent must be an object');
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw invalid('result exceeds 4 MiB');
  return {
    content: result.content,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(result.isError === true ? { isError: true } : {}),
  };
}
