import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryTransactionStore, createStoreFromEnvironment, oauthStateHash } from '../transaction-store.mjs';
import { FirestoreTransactionStore } from '../firestore-store.mjs';

const startTime = 1700000000000;
const input = {
  transactionId: 'a'.repeat(43), oauthState: 'b'.repeat(43), codeChallenge: 'c'.repeat(43), clientState: 'd'.repeat(43),
  expiresAt: startTime + 600000,
};
const errorCode = (code) => (error) => error.code === code;

// Each attempted transaction receives its own writes; a retry discards the previous attempt.
function fakeFirestore() {
  const records = new Map();
  let retry = null;
  let afterCommit = null;
  return {
    records,
    collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }) }),
    retryOnce(callback) { retry = callback; },
    afterCommitOnce(callback) { afterCommit = callback; },
    async runTransaction(callback) {
      const attempt = async () => {
        const writes = [];
        const tx = {
          get: async (ref) => ({ data: () => structuredClone(records.get(ref.path)) }),
          create(ref, value) {
            if (records.has(ref.path)) throw new Error('already exists');
            writes.push(() => records.set(ref.path, structuredClone(value)));
          },
          set: (ref, value) => writes.push(() => records.set(ref.path, structuredClone(value))),
          delete: (ref) => writes.push(() => records.delete(ref.path)),
        };
        const result = await callback(tx);
        return { result, writes };
      };
      let attemptResult = await attempt();
      if (retry) {
        const change = retry;
        retry = null;
        change();
        attemptResult = await attempt();
      }
      for (const write of attemptResult.writes) write();
      if (afterCommit) {
        const failure = afterCommit;
        afterCommit = null;
        failure();
      }
      return attemptResult.result;
    },
    async terminate() {},
  };
}

test('stored fields exclude raw state, verifier, tokens, and client secret, while authorization code is removed on claim', async () => {
  const firestore = fakeFirestore();
  const store = new FirestoreTransactionStore({ firestore, now: () => startTime });
  await store.create({ ...input, codeVerifier: 'never-store-verifier', accessToken: 'never-store-access', refreshToken: 'never-store-refresh', clientSecret: 'never-store-secret' });
  const txPath = `image_paste_auth_transactions/${input.transactionId}`;
  const statePath = `image_paste_auth_states/${oauthStateHash(input.oauthState)}`;
  assert.equal(firestore.records.size, 2);
  assert.ok(firestore.records.has(statePath));
  assert.ok(firestore.records.get(txPath).expireAt instanceof Date);
  assert.ok(firestore.records.get(statePath).expireAt instanceof Date);
  const stored = JSON.stringify([...firestore.records]);
  for (const forbidden of [input.oauthState, 'never-store-verifier', 'never-store-access', 'never-store-refresh', 'never-store-secret']) assert.ok(!stored.includes(forbidden));
  await store.callback(input.oauthState, { code: 'short-lived-code', denied: false });
  assert.equal(firestore.records.get(txPath).code, 'short-lived-code');
  assert.deepEqual(await store.claim(input.transactionId, input.codeChallenge), { code: 'short-lived-code', denied: false });
  assert.equal(firestore.records.get(txPath).status, 'consuming');
  assert.equal(firestore.records.get(txPath).code, undefined);
  await assert.rejects(store.claim(input.transactionId, input.codeChallenge), errorCode('transaction_consumed'));
  await store.finish(input.transactionId);
  assert.equal(firestore.records.size, 0);
});

test('Firestore retry checks expiry again and does not commit the previous claim attempt', async () => {
  const firestore = fakeFirestore();
  let time = startTime;
  const store = new FirestoreTransactionStore({ firestore, now: () => time });
  await store.create(input);
  await store.callback(input.oauthState, { code: 'one-use-code', denied: false });
  firestore.retryOnce(() => { time = input.expiresAt; });
  await assert.rejects(store.claim(input.transactionId, input.codeChallenge), errorCode('transaction_not_found'));
  assert.equal(firestore.records.get(`image_paste_auth_transactions/${input.transactionId}`).status, 'authorized');
});

test('Firestore callback retry rechecks pending state rather than overwriting a competing callback', async () => {
  const firestore = fakeFirestore();
  const store = new FirestoreTransactionStore({ firestore, now: () => startTime });
  await store.create(input);
  firestore.retryOnce(() => {
    firestore.records.get(`image_paste_auth_transactions/${input.transactionId}`).status = 'denied';
  });
  await assert.rejects(store.callback(input.oauthState, { code: 'late-code', denied: false }), errorCode('transaction_consumed'));
  assert.equal(firestore.records.get(`image_paste_auth_transactions/${input.transactionId}`).code, undefined);
});

test('uncertain Firestore claim commit remains consumed after reconnecting with a new store', async () => {
  const firestore = fakeFirestore();
  const store = new FirestoreTransactionStore({ firestore, now: () => startTime });
  await store.create(input);
  await store.callback(input.oauthState, { code: 'one-use-code', denied: false });
  firestore.afterCommitOnce(() => { throw new Error('commit acknowledgement was lost'); });
  await assert.rejects(store.claim(input.transactionId, input.codeChallenge), /acknowledgement/);
  const reconnected = new FirestoreTransactionStore({ firestore, now: () => startTime });
  await assert.rejects(reconnected.claim(input.transactionId, input.codeChallenge), errorCode('transaction_consumed'));
  assert.equal(firestore.records.get(`image_paste_auth_transactions/${input.transactionId}`).code, undefined);
});

test('both stores reject expired records even when TTL deletion has not happened', async () => {
  for (const kind of ['memory', 'firestore']) {
    let time = startTime;
    const store = kind === 'memory'
      ? new MemoryTransactionStore({ now: () => time })
      : new FirestoreTransactionStore({ firestore: fakeFirestore(), now: () => time });
    await store.create(input);
    time = input.expiresAt;
    await assert.rejects(store.callback(input.oauthState, { code: 'expired-code', denied: false }), errorCode('transaction_not_found'));
    await assert.rejects(store.claim(input.transactionId, input.codeChallenge), errorCode('transaction_not_found'));
    await assert.rejects(store.cancel(input.transactionId, input.codeChallenge), errorCode('transaction_not_found'));
  }
});

test('wrong proof cannot cancel or claim a transaction, and valid cancellation deletes both documents', async () => {
  const firestore = fakeFirestore();
  const store = new FirestoreTransactionStore({ firestore, now: () => startTime });
  await store.create(input);
  await assert.rejects(store.claim(input.transactionId, 'wrong-challenge'), errorCode('invalid_proof'));
  await assert.rejects(store.cancel(input.transactionId, 'wrong-challenge'), errorCode('invalid_proof'));
  assert.equal(firestore.records.size, 2);
  await store.cancel(input.transactionId, input.codeChallenge);
  assert.equal(firestore.records.size, 0);
});

test('Cloud Run rejects memory state and emulator configuration instead of silently using process-local storage', async () => {
  await assert.rejects(createStoreFromEnvironment({ K_SERVICE: 'relay' }), /requires/);
  await assert.rejects(createStoreFromEnvironment({ K_SERVICE: 'relay', SESSION_STORE: 'memory' }), /requires/);
  await assert.rejects(createStoreFromEnvironment({ SESSION_STORE: 'unknown' }), /requires/);
  await assert.rejects(createStoreFromEnvironment({ K_SERVICE: 'relay', SESSION_STORE: 'firestore', FIRESTORE_EMULATOR_HOST: 'localhost:8787' }), /emulator/);
  const local = await createStoreFromEnvironment({ SESSION_STORE: 'memory' });
  assert.ok(local instanceof MemoryTransactionStore);
  await local.close();
});

test('Firestore namespaces are explicit, separate, and cannot inject document paths', () => {
  const firestore = fakeFirestore();
  assert.throws(() => new FirestoreTransactionStore({ firestore, collectionPrefix: 'other/path' }), /prefix/);
  const first = new FirestoreTransactionStore({ firestore, collectionPrefix: 'development' });
  const second = new FirestoreTransactionStore({ firestore, collectionPrefix: 'production' });
  assert.notEqual(first.transactions.doc('id').path, second.transactions.doc('id').path);
});
