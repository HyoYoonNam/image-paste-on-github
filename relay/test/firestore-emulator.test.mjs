import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createRelayServer } from '../server.mjs';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (process.env.REQUIRE_FIRESTORE_EMULATOR === '1' && !emulatorHost) {
  throw new Error('FIRESTORE_EMULATOR_HOST is required for test:firestore. Start the local Firestore emulator first.');
}
if (emulatorHost) {
  const address = new URL(`http://${emulatorHost}`);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) && address.port &&
    address.pathname === '/' && !address.username && !address.password && !address.search && !address.hash,
  'These tests only connect to a local Firestore emulator.');
}

const CONFIG = {
  clientId: 'Iv1.emulator-test', clientSecret: 'mock-server-secret', appSlug: 'image-paste-test',
  publicBaseUrl: 'https://auth.example.test',
};
const PAIR = {
  access_token: 'mock-emulator-access', token_type: 'bearer', expires_in: 28800,
  refresh_token: 'mock-emulator-refresh', refresh_token_expires_in: 15897600,
};
const verifier = 'a'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const clientState = randomBytes(32).toString('base64url');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('Firestore emulator shares one-use login state across independent relay instances', {
  skip: !emulatorHost && 'Set FIRESTORE_EMULATOR_HOST to run the real Firestore integration tests.',
  timeout: 180000,
}, async (t) => {
  process.env.METADATA_SERVER_DETECTION = 'none';
  const { Firestore } = await import('@google-cloud/firestore');
  const { FirestoreTransactionStore } = await import('../firestore-store.mjs');

  async function fixture(t, options = {}) {
    let time = Date.now();
    const prefix = `image_paste_test_${randomBytes(8).toString('hex')}`;
    const calls = [], instances = [];
    async function addInstance(collectionPrefix = prefix) {
      const db = new Firestore({ projectId: 'demo-image-paste-auth' });
      const store = new FirestoreTransactionStore({ firestore: db, collectionPrefix, now: () => time });
      const server = createRelayServer(CONFIG, {
        store, now: () => time,
        fetch: async (url, init) => {
          calls.push({ url, ...init });
          return options.fetch ? options.fetch(url, init) : Response.json(PAIR);
        },
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = `http://127.0.0.1:${server.address().port}`;
      const instance = {
        db, store, server, base, collectionPrefix,
        post: (path, body) => fetch(`${base}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
        callback: (transaction, suffix = 'code=mock-github-code') => {
          const state = new URL(transaction.authorizationUrl).searchParams.get('state');
          return fetch(`${base}/auth/callback?state=${state}&${suffix}`);
        },
      };
      instances.push(instance);
      return instance;
    }
    t.after(async () => {
      for (const { server } of instances) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      if (instances.length) {
        for (const collectionPrefix of new Set(instances.map(instance => instance.collectionPrefix))) {
          for (const suffix of ['transactions', 'states']) {
            await instances[0].db.recursiveDelete(instances[0].db.collection(`${collectionPrefix}_${suffix}`));
          }
        }
      }
      for (const { store } of instances) await store.close();
    });
    const first = await addInstance(), second = await addInstance();
    return {
      first, second, calls, prefix, addInstance,
      advance: (milliseconds) => { time += milliseconds; },
      async start(instance = first) {
        const response = await instance.post('/auth/start', { codeChallenge: challenge, clientState });
        assert.equal(response.status, 200);
        return response.json();
      },
      proof: (transaction) => ({ transactionId: transaction.transactionId, codeVerifier: verifier }),
    };
  }

  await t.test('start, callback, and complete can reach different instances without returning secrets in HTML', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    const callback = await f.second.callback(transaction);
    assert.equal(callback.status, 200);
    const html = await callback.text();
    assert.match(html, new RegExp(`transaction_id=${transaction.transactionId}&amp;state=${clientState}`));
    assert.doesNotMatch(html, /mock-github-code|mock-server-secret|mock-emulator-access|mock-emulator-refresh/);
    assert.ok(!html.includes(verifier));
    const complete = await f.first.post('/auth/complete', f.proof(transaction));
    assert.equal(complete.status, 200);
    assert.deepEqual(await complete.json(), PAIR);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://github.com/login/oauth/access_token');
    assert.equal(new URLSearchParams(f.calls[0].body).get('code'), 'mock-github-code');
  });

  await t.test('concurrent callbacks are accepted only once across instances', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    const callbacks = await Promise.all([
      f.first.callback(transaction, 'code=first-code'),
      f.second.callback(transaction, 'code=second-code'),
    ]);
    assert.deepEqual(callbacks.map(response => response.status).sort(), [200, 409]);
    const winner = callbacks[0].status === 200 ? 'first-code' : 'second-code';
    const complete = await f.second.post('/auth/complete', f.proof(transaction));
    assert.equal(complete.status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(new URLSearchParams(f.calls[0].body).get('code'), winner);
  });

  await t.test('concurrent complete claims allow one exchange, including a new relay instance', async (t) => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { fetch: async () => { entered.resolve(); await release.promise; return Response.json(PAIR); } });
    const transaction = await f.start();
    assert.equal((await f.second.callback(transaction)).status, 200);
    const first = f.first.post('/auth/complete', f.proof(transaction));
    const second = f.second.post('/auth/complete', f.proof(transaction));
    try {
      await entered.promise;
      const duplicate = await Promise.race([first, second]);
      assert.equal(duplicate.status, 409);
      assert.equal((await duplicate.json()).error, 'transaction_consumed');
      const restarted = await f.addInstance();
      assert.equal((await restarted.post('/auth/complete', f.proof(transaction))).status, 409);
      assert.equal((await f.second.post('/auth/cancel', f.proof(transaction))).status, 409);
      assert.equal(f.calls.length, 1);
    } finally {
      release.resolve();
      assert.deepEqual((await Promise.all([first, second])).map(response => response.status).sort(), [200, 409]);
    }
    assert.ok([404, 409].includes((await f.second.post('/auth/complete', f.proof(transaction))).status));
    assert.equal(f.calls.length, 1);
  });

  await t.test('cancellation on another instance prevents callback and token exchange', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    assert.equal((await f.second.post('/auth/cancel', f.proof(transaction))).status, 204);
    assert.equal((await f.first.callback(transaction)).status, 404);
    assert.equal((await f.first.post('/auth/complete', f.proof(transaction))).status, 404);
    const restarted = await f.addInstance();
    assert.equal((await restarted.post('/auth/complete', f.proof(transaction))).status, 404);
    assert.equal(f.calls.length, 0);
  });

  await t.test('racing cancel and complete cannot both succeed', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    assert.equal((await f.second.callback(transaction)).status, 200);
    const [complete, cancel] = await Promise.all([
      f.first.post('/auth/complete', f.proof(transaction)),
      f.second.post('/auth/cancel', f.proof(transaction)),
    ]);
    if (cancel.status === 204) {
      assert.equal(complete.status, 404);
      assert.equal(f.calls.length, 0);
    } else {
      assert.equal(complete.status, 200);
      assert.ok([404, 409].includes(cancel.status));
      assert.equal(f.calls.length, 1);
    }
    assert.equal((await f.second.post('/auth/complete', f.proof(transaction))).status, 404);
  });

  await t.test('an incorrect proof on another instance does not consume the login', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    assert.equal((await f.first.callback(transaction)).status, 200);
    const wrong = { transactionId: transaction.transactionId, codeVerifier: 'b'.repeat(64) };
    assert.equal((await f.second.post('/auth/complete', wrong)).status, 403);
    assert.equal((await f.second.post('/auth/cancel', wrong)).status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.first.post('/auth/complete', f.proof(transaction))).status, 200);
    assert.equal(f.calls.length, 1);
  });

  await t.test('expired records are rejected even before Firestore TTL deletes them', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    assert.equal((await f.first.callback(transaction)).status, 200);
    f.advance(600000);
    const pending = await f.first.db.collection(`${f.prefix}_transactions`).doc(transaction.transactionId).get();
    assert.equal(pending.exists, true);
    assert.ok(pending.get('expireAt').toDate() instanceof Date);
    const complete = await f.second.post('/auth/complete', f.proof(transaction));
    assert.equal(complete.status, 404);
    assert.equal((await complete.json()).error, 'transaction_not_found');
    assert.equal(f.calls.length, 0);
  });

  await t.test('upstream failure cannot be retried through a fresh relay instance', async (t) => {
    const f = await fixture(t, { fetch: async () => Response.json({ error: 'bad_verification_code' }) });
    const transaction = await f.start();
    assert.equal((await f.second.callback(transaction)).status, 200);
    assert.equal((await f.first.post('/auth/complete', f.proof(transaction))).status, 502);
    const restarted = await f.addInstance();
    assert.equal((await restarted.post('/auth/complete', f.proof(transaction))).status, 404);
    assert.equal((await restarted.callback(transaction)).status, 404);
    assert.equal(f.calls.length, 1);
  });

  await t.test('an uncertain claim response does not exchange or release the committed claim', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    assert.equal((await f.second.callback(transaction)).status, 200);
    const claim = f.first.store.claim.bind(f.first.store);
    f.first.store.claim = async (...arguments_) => {
      await claim(...arguments_);
      throw new Error('mock connection lost after Firestore commit');
    };
    const uncertain = await f.first.post('/auth/complete', f.proof(transaction));
    assert.equal(uncertain.status, 503);
    assert.equal((await uncertain.json()).error, 'unavailable');
    assert.equal(f.calls.length, 0);
    const restarted = await f.addInstance();
    const retry = await restarted.post('/auth/complete', f.proof(transaction));
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).error, 'transaction_consumed');
    assert.equal(f.calls.length, 0);
  });

  await t.test('OAuth state is indexed by its hash and pending records carry an explicit TTL', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    const oauthState = new URL(transaction.authorizationUrl).searchParams.get('state');
    const documents = await f.second.db.collection(`${f.prefix}_states`).get();
    assert.equal(documents.size, 1);
    assert.equal(documents.docs[0].id, createHash('sha256').update(oauthState).digest('hex'));
    assert.ok(!JSON.stringify(documents.docs[0].data()).includes(oauthState));
    assert.equal(documents.docs[0].get('expireAt').toMillis(), transaction.expiresAt);
    const stored = await f.second.db.collection(`${f.prefix}_transactions`).doc(transaction.transactionId).get();
    assert.equal(stored.get('expireAt').toMillis(), transaction.expiresAt);
    assert.doesNotMatch(JSON.stringify(stored.data()), /mock-server-secret|mock-emulator-access|mock-emulator-refresh/);
  });

  await t.test('separate environment collection prefixes cannot consume each other\'s logins', async (t) => {
    const f = await fixture(t);
    const transaction = await f.start();
    const anotherEnvironment = await f.addInstance(`${f.prefix}_other`);
    assert.equal((await anotherEnvironment.callback(transaction)).status, 404);
    assert.equal((await anotherEnvironment.post('/auth/complete', f.proof(transaction))).status, 404);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.second.callback(transaction)).status, 200);
    assert.equal((await f.first.post('/auth/complete', f.proof(transaction))).status, 200);
    assert.equal(f.calls.length, 1);
  });
});
