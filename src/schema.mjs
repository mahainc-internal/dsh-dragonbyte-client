// A JSON Schema subset validator, shipped rather than depended on.
//
// ⚠ THE THREE HALVES RUN IN DIFFERENT IMAGES AND MUST AGREE. The bridge
// container copies `src` and `server` from this package and nothing else; the
// tenant side is a store-linked bundle that resolves `/opt/dsh/node_modules`.
// A dependency reachable from one and not the other means two validators that
// disagree about what is valid, which is the failure a shared schema exists to
// prevent. So the schema and this reader travel with the package.
//
// Supported keywords, and nothing more: type, required, properties,
// additionalProperties, items, enum, const, pattern, minLength, maxLength,
// minimum, maximum, minItems, maxItems. Anything else is a bug in the schema and
// THROWS rather than being skipped — a silently ignored `anyOf` is a schema that
// does not do what its author believes.

const KEYWORDS = new Set([
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'enum', 'const', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'minItems', 'maxItems',
  'title', 'description', '$id', 'examples', 'default',
  // ⚠ NOT A JSON SCHEMA KEYWORD. `frames` groups the per-direction property
  // and requirement lists in protocol.v1.json so one artifact can describe
  // three hops; it is read by `frameSchema` and never by `validate`.
  'frames',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(token, value) {
  const actual = typeOf(value);
  if (token === 'number') return actual === 'integer' || actual === 'number';
  return actual === token;
}

function check(schema, value, path, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword)) throw new TypeError(`unsupported schema keyword at ${path || '/'}: ${keyword}`);
  }
  if (schema.type !== undefined) {
    const tokens = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!tokens.some((token) => typeMatches(token, value))) {
      errors.push({ path, message: `expected ${tokens.join(' or ')}, got ${typeOf(value)}` });
      // Every keyword below assumes the type held.
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push({ path, message: `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}` });
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push({ path, message: `must match ${schema.pattern}` });
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `must have at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `must have at most ${schema.maxItems} items` });
    if (schema.items !== undefined) value.forEach((item, index) => check(schema.items, item, `${path}/${index}`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push({ path: `${path}/${key}`, message: 'is required' });
    }
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) check(subschema, value[key], `${path}/${key}`, errors);
    }
    // Absent means true — see protocol.v1.json. Never set false on a frame.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push({ path: `${path}/${key}`, message: 'is not a known field' });
      }
    }
  }
}

/** @returns {string|null} the first failure, or null when `value` conforms. */
export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', errors);
  if (!errors.length) return null;
  const [first] = errors;
  return `${first.path || '/'} ${first.message}`;
}

/**
 * The property map for one frame of one hop.
 *
 * `protocol.v1.json` groups requirement and property lists by direction, so a
 * receiver asks for exactly the frame it accepts instead of validating against
 * the union of everything the protocol can carry. An unknown direction or frame
 * THROWS: a typo here is a programming error, not an input to tolerate.
 *
 * @param {object} protocol the parsed protocol.v1.json
 * @param {string} direction e.g. `host-to-bridge`
 * @param {string} frame e.g. `catalog`
 * @returns {object} a JSON Schema describing that frame
 */
export function frameSchema(protocol, direction, frame) {
  const hop = protocol.frames?.[direction];
  if (hop === undefined) throw new TypeError(`unknown frame direction ${JSON.stringify(direction)}`);
  const entry = hop[frame];
  if (entry === undefined) throw new TypeError(`unknown frame ${JSON.stringify(frame)} in ${direction}`);
  return {
    type: 'object',
    required: entry.required,
    properties: Object.fromEntries(entry.properties.map((name) => [name, protocol.properties[name]])),
  };
}
