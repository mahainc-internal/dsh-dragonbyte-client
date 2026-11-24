// Registering the AI gateway as a DSH model provider.
//
// ⚠ THIS IS THE HALF THAT MAKES MODELS APPEAR. A paired machine already holds a
// device token the gateway accepts, so the only missing step was telling DSH
// about the route: `dsh-llm-pi-ai` ships a dormant openai-completions adapter
// that serves whatever `providers` its config section names, and that is exactly
// what the web Models page writes. This module writes the same section, under a
// route of its own, so it is one more provider in the picker rather than a
// replacement for the ones a person configured by hand.
//
// ⚠ NOTHING HERE INVENTS A CREDENTIAL. The device token goes into the
// credential store under `apiKeyEnv`'s name; pi-ai resolves it per request, so a
// rotated token reaches the next call without touching this section.

/** The gateway's `/v1` root this deployment answers on, when nobody chose another. */
export const GATEWAY_BASE_URL = 'https://io.snapai.app:8443/v1';

/**
 * What a person typed in Settings -> the base URL this module appends to.
 *
 * ⚠ A BARE HOST MEANS THE DEPLOYMENT ROOT, WHICH SERVES `/v1`. Pasting
 * `https://host:8443` is the ordinary mistake; sending `/models` to it would
 * ask a route that does not exist and report "listed no models", which names
 * the symptom rather than the fix.
 *
 * ⚠ THE TOKEN THIS SAVES IS SPENT AT THAT HOST. The bearer sent to `/models` is
 * this machine's `dbt1` device token — the same one the bridge accepts for the
 * server list and pairing state — so a plain `http:` address hands it to every
 * hop in between. Loopback is the one place that is not a downgrade, and it is
 * also how a self-hosted gateway is usually reached on the same machine.
 *
 * @returns the normalized base URL, or `''` for an empty field (meaning: default).
 */
export function normalizeGatewayUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('the AI gateway address is not a URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('the AI gateway address must start with http:// or https://');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) throw new Error('a plain http:// gateway is only accepted on this machine (localhost or 127.0.0.1), because the device token is sent with every request');
  if (url.search || url.hash) throw new Error('the AI gateway address must not carry a query or fragment');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path === '' ? '/v1' : path;
  return url.toString().replace(/\/$/, '');
}

/** `localhost`, `127.0.0.1`, `[::1]` — the names that do not leave this machine. */
function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** The provider route this plugin owns. A stable key is what makes removal possible. */
export const PROVIDER_ROUTE = 'dragonbyte';

/** The credential reference pi-ai resolves for this route. Must match its grammar. */
export const API_KEY_REF = 'DRAGONBYTE_AI_GATEWAY_TOKEN';

/**
 * Context window every advertised model gets.
 *
 * ⚠ THE GATEWAY'S `/v1/models` ANSWERS WITH FOUR FIELDS AND NONE IS A WINDOW.
 * pi-ai would otherwise fall back to its own 262,144 default, which understates
 * every model this deployment serves and silently truncates long sessions.
 */
export const CONTEXT_WINDOW = 400_000;

/** Every model is given both modalities; the gateway does not report per-model input. */
export const INPUT_MODALITIES = ['text', 'image'];

const PROTOCOL = 'openai-completions';

/**
 * Read a gateway's advertised model ids.
 *
 * ⚠ AN EMPTY CATALOG IS A REFUSAL, NOT AN EMPTY ANSWER. An address that answers
 * but lists nothing is not the gateway this machine was paired for, and writing
 * a route that serves no models would leave DSH pointing at a dead provider.
 *
 * @returns the model ids, in the gateway's order, deduplicated.
 */
export function readModelIds(body) {
  const entries = Array.isArray(body?.data) ? body.data : [];
  const seen = new Set();
  const ids = [];
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The `llm-pi-ai` profile for this route. */
export function providerProfile(modelIds, baseURL = GATEWAY_BASE_URL) {
  return {
    api: PROTOCOL,
    baseURL,
    displayName: 'DragonByte',
    apiKeyEnv: API_KEY_REF,
    models: modelIds.map((id) => ({
      id,
      name: id,
      contextWindow: CONTEXT_WINDOW,
      maxTokens: Math.min(CONTEXT_WINDOW, 128_000),
      input: [...INPUT_MODALITIES],
    })),
  };
}

/** Whether a `llm-pi-ai` section already names a route with the same models at the same address. */
export function sameModels(current, modelIds, baseURL = GATEWAY_BASE_URL) {
  if (current?.baseURL !== baseURL) return false;
  const models = Array.isArray(current?.models) ? current.models : [];
  if (models.length !== modelIds.length) return false;
  return models.every((model, index) => model?.id === modelIds[index]);
}

/**
 * Ask the gateway what this device token may use.
 *
 * @returns `{ models }` on success; throws with a human-readable message otherwise.
 */
export async function fetchGatewayModels(token, { baseURL = GATEWAY_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const url = `${baseURL}/models`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`could not reach ${url}: ${error?.message || error}`);
  }
  if (response.status === 401 || response.status === 403) throw new Error('the gateway refused this machine\'s device token');
  if (!response.ok) throw new Error(`the gateway answered HTTP ${response.status}`);
  const ids = readModelIds(await response.json().catch(() => null));
  if (!ids.length) throw new Error(`${url} listed no models`);
  return { models: ids };
}

/**
 * Register, refresh, or withdraw this plugin's provider route.
 *
 * ⚠ ONE WRITE, ONE SECTION, AND ONLY WHEN IT CHANGED. `settings.update` deep-merges
 * into the `llm-pi-ai` config, so another provider in the same section is left
 * alone. Skipping an identical write matters because each write is a profile
 * document edit and a Loader reconcile — a startup that rewrote an unchanged
 * section every launch would be churn for no change in behaviour.
 *
 * @returns `'applied' | 'unchanged' | 'removed' | 'absent'`.
 */
export async function syncProvider({ settings, credentials, token, models, baseURL = GATEWAY_BASE_URL }) {
  if (!token || !Array.isArray(models) || models.length === 0) return removeProvider({ settings, credentials });
  const current = (await settings.describe())?.find((row) => row.ns === 'llm-pi-ai');
  const existing = current?.value?.providers?.[PROVIDER_ROUTE];
  const needsCredential = await credentialNeedsWrite(credentials);
  if (existing && sameModels(existing, models, baseURL) && !needsCredential) return 'unchanged';
  await credentials.set(API_KEY_REF, token);
  await settings.update('llm-pi-ai', { providers: { [PROVIDER_ROUTE]: providerProfile(models, baseURL) } });
  return 'applied';
}

/** Withdraw the route and its credential. Tolerates an already-absent route. */
export async function removeProvider({ settings, credentials }) {
  const current = (await settings.describe())?.find((row) => row.ns === 'llm-pi-ai');
  const existing = current?.value?.providers?.[PROVIDER_ROUTE];
  await credentials.unset(API_KEY_REF).catch(() => {});
  if (!existing) return 'absent';
  // ⚠ `null` UNSETS THE KEY. `settings.mutate` removes a dict member by path;
  // writing `{}` would leave an empty route that pi-ai still tries to resolve.
  await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', PROVIDER_ROUTE] }]);
  return 'removed';
}

async function credentialNeedsWrite(credentials) {
  const described = await credentials.describe(API_KEY_REF).catch(() => null);
  return !described?.configured;
}
