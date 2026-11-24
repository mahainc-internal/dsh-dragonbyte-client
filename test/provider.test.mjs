/**
 * Registering the gateway as a DSH provider.
 *
 * ⚠ THE POINT OF THESE TESTS IS THE NEGATIVE HALF. Registering a provider that
 * happens to work is uninteresting; what has to hold is that another provider in
 * the same config section survives, that an unchanged list is not rewritten on
 * every launch, and that a refused token removes the route instead of leaving
 * models that every call then fails to use.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_KEY_REF, CONTEXT_WINDOW, GATEWAY_BASE_URL, INPUT_MODALITIES, PROVIDER_ROUTE,
  fetchGatewayModels, normalizeGatewayUrl, providerProfile, readModelIds, removeProvider, sameModels, syncProvider,
} from '../src/provider.mjs';

/** A settings/credentials pair that records writes, with a pre-seeded section. */
function fakeModelServices({ providers = {}, configured = false } = {}) {
  const writes = { updates: [], mutations: [], sets: [], unsets: [] };
  const section = { providers };
  const services = {
    writes,
    settings: {
      async describe() {
        return [{ ns: 'llm-pi-ai', value: { providers: section.providers } }];
      },
      async update(ns, patch) {
        writes.updates.push({ ns, patch });
        Object.assign(section.providers, patch.providers ?? {});
      },
      async mutate(ns, ops) {
        writes.mutations.push({ ns, ops });
        for (const op of ops) if (op.op === 'unset') delete section.providers[op.path.at(-1)];
      },
    },
    credentials: {
      async describe() { return { configured }; },
      async set(ref, value) { writes.sets.push({ ref, value }); configured = true; },
      async unset(ref) { writes.unsets.push(ref); configured = false; },
    },
  };
  return services;
}

test('the gateway address keeps the port that this deployment answers on', () => {
  assert.equal(GATEWAY_BASE_URL, 'https://io.snapai.app:8443/v1');
});

test('a typed gateway address becomes the /v1 root a request can append to', () => {
  // ⚠ A BARE HOST IS THE ORDINARY PASTE, AND IT MEANS THE DEPLOYMENT ROOT.
  // Without this, `/models` would go to `/models` on the origin and come back
  // as an empty catalog — a message about the symptom, not about the address.
  assert.equal(normalizeGatewayUrl('https://io.snapai.app:8443'), 'https://io.snapai.app:8443/v1');
  assert.equal(normalizeGatewayUrl('  https://gw.example.test/v1/  '), 'https://gw.example.test/v1');
  assert.equal(normalizeGatewayUrl('https://gw.example.test/api/openai/'), 'https://gw.example.test/api/openai');
  // ⚠ EMPTY IS THE DEFAULT, NOT AN ERROR: clearing the field is how a person
  // goes back to the deployment's own address.
  assert.equal(normalizeGatewayUrl(''), '');
  assert.equal(normalizeGatewayUrl(null), '');
});

test('an unusable gateway address is refused instead of being sent', () => {
  assert.throws(() => normalizeGatewayUrl('io.snapai.app:8443'), /start with http/);
  assert.throws(() => normalizeGatewayUrl('ftp://gw.example.test'), /http/);
  assert.throws(() => normalizeGatewayUrl('https://gw.example.test/v1?token=x'), /query or fragment/);
});

test('a plain http gateway is only accepted on this machine', () => {
  // ⚠ THE DEVICE TOKEN TRAVELS WITH EVERY REQUEST, so a cleartext address is a
  // token handed to every hop between here and there. Loopback is the one
  // address where there is no hop.
  assert.throws(() => normalizeGatewayUrl('http://gw.example.test:8080/v1'), /only accepted on this machine/);
  assert.throws(() => normalizeGatewayUrl('http://10.0.0.5:8080'), /only accepted on this machine/);
  assert.equal(normalizeGatewayUrl('http://localhost:8080'), 'http://localhost:8080/v1');
  assert.equal(normalizeGatewayUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  // The default deployment is https, so it is unaffected.
  assert.equal(normalizeGatewayUrl('https://gw.example.test'), 'https://gw.example.test/v1');
});

test('model ids are deduplicated and blank entries dropped', () => {
  assert.deepEqual(readModelIds({ data: [{ id: 'a' }, { id: ' a ' }, { id: '' }, { id: 'b' }, {}] }), ['a', 'b']);
  assert.deepEqual(readModelIds(null), []);
});

test('every model gets the deployment window and both modalities', () => {
  // ⚠ THE GATEWAY'S /v1/models ANSWERS WITH NO WINDOW AT ALL. Left to pi-ai's
  // default this would silently be 262,144, understating every served model.
  const profile = providerProfile(['m-1', 'm-2']);
  assert.equal(profile.api, 'openai-completions');
  assert.equal(profile.baseURL, GATEWAY_BASE_URL);
  assert.equal(profile.apiKeyEnv, API_KEY_REF);
  for (const model of profile.models) {
    assert.equal(model.contextWindow, CONTEXT_WINDOW);
    assert.deepEqual(model.input, INPUT_MODALITIES);
    assert.ok(model.maxTokens > 0 && model.maxTokens <= model.contextWindow);
  }
});

test('an unchanged list is not rewritten, and a changed one is', async () => {
  const services = fakeModelServices();
  const first = await syncProvider({ ...services, token: 't', models: ['m-1'] });
  assert.equal(first, 'applied');
  assert.equal(services.writes.updates.length, 1);
  assert.equal(services.writes.sets.length, 1);

  const again = await syncProvider({ ...services, token: 't', models: ['m-1'] });
  assert.equal(again, 'unchanged');
  assert.equal(services.writes.updates.length, 1, 'an identical section must not be rewritten');

  const changed = await syncProvider({ ...services, token: 't', models: ['m-1', 'm-2'] });
  assert.equal(changed, 'applied');
  assert.equal(services.writes.updates.length, 2);
});

test('another provider in the same section survives', async () => {
  const services = fakeModelServices({ providers: { 'remote-openai': { api: 'openai-completions', baseURL: 'https://x/v1' } } });
  await syncProvider({ ...services, token: 't', models: ['m-1'] });
  const written = services.writes.updates[0].patch.providers;
  // ⚠ THE PATCH NAMES ONLY THIS ROUTE. `settings.update` deep-merges, so the
  // other provider stays; sending the whole section would delete it.
  assert.deepEqual(Object.keys(written), [PROVIDER_ROUTE]);
});

test('no token means the route and credential are withdrawn', async () => {
  const services = fakeModelServices({ providers: { [PROVIDER_ROUTE]: providerProfile(['m-1']) }, configured: true });
  const result = await syncProvider({ ...services, token: '', models: ['m-1'] });
  assert.equal(result, 'removed');
  assert.deepEqual(services.writes.unsets, [API_KEY_REF]);
  assert.equal(services.writes.mutations.length, 1);
  assert.deepEqual(services.writes.mutations[0].ops, [{ op: 'unset', path: ['providers', PROVIDER_ROUTE] }]);
});

test('withdrawing an absent route is a no-op, not an error', async () => {
  const services = fakeModelServices();
  assert.equal(await removeProvider(services), 'absent');
  assert.equal(services.writes.mutations.length, 0);
});

test('the same-models check compares ids in order', () => {
  assert.equal(sameModels(providerProfile(['a', 'b']), ['a', 'b']), true);
  assert.equal(sameModels(providerProfile(['a', 'b']), ['b', 'a']), false);
  assert.equal(sameModels(providerProfile(['a']), ['a', 'b']), false);
  assert.equal(sameModels(undefined, ['a']), false);
});

test('a refused token or an empty catalog is an error, never a silent success', async () => {
  const refused = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => fetchGatewayModels('t', { fetchImpl: refused }), /refused this machine/);
  const empty = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  await assert.rejects(() => fetchGatewayModels('t', { fetchImpl: empty }), /listed no models/);
});

test('a changed gateway address rewrites the route, even with the same models', async () => {
  // ⚠ THE ADDRESS IS PART OF THE SECTION, SO IT IS PART OF "UNCHANGED". A
  // comparison on ids alone would leave the old baseURL in the profile and the
  // next model call would go to the old gateway.
  const services = fakeModelServices();
  await syncProvider({ ...services, token: 't', models: ['m-1'] });
  assert.equal(services.writes.updates.at(-1).patch.providers.dragonbyte.baseURL, GATEWAY_BASE_URL);
  const moved = await syncProvider({ ...services, token: 't', models: ['m-1'], baseURL: 'https://gw.example.test/v1' });
  assert.equal(moved, 'applied');
  assert.equal(services.writes.updates.at(-1).patch.providers.dragonbyte.baseURL, 'https://gw.example.test/v1');
  assert.equal(await syncProvider({ ...services, token: 't', models: ['m-1'], baseURL: 'https://gw.example.test/v1' }), 'unchanged');
});

test('the device token is sent as a bearer to the /models route', async () => {
  const seen = [];
  const ok = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm-1' }] }) };
  };
  const { models } = await fetchGatewayModels('dbt1.a.b', { fetchImpl: ok });
  assert.deepEqual(models, ['m-1']);
  assert.deepEqual(seen, [{ url: `${GATEWAY_BASE_URL}/models`, auth: 'Bearer dbt1.a.b' }]);
});

test('a configured gateway is what the model list is asked of', async () => {
  const seen = [];
  const ok = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm-1' }] }) };
  };
  await fetchGatewayModels('dbt1.a.b', { baseURL: 'https://gw.example.test/v1', fetchImpl: ok });
  assert.deepEqual(seen, ['https://gw.example.test/v1/models']);
});
