import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { D1TransactionStore, oauthStateHash } from '../d1-store.mjs';

const errorCode = (code) => (error) => error.code === code;
const input = {
  transactionId: 'a'.repeat(43), oauthState: 'b'.repeat(43),
  codeChallenge: 'c'.repeat(43), clientState: 'd'.repeat(43),
};

test('D1 login state uses real local SQL transactions', { timeout: 60000 }, async (t) => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("local D1 test"); } };',
    compatibilityDate: '2026-11-16',
    d1Databases: { DB: 'local-auth-store-tests' },
    cf: false,
  }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DB');
  const migration = await readFile(new URL('../migrations/0001_auth_transactions.sql', import.meta.url), 'utf8');
  await db.batch(migration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  let nextNamespace = 0;

  function fixture(namespace = `test_${nextNamespace++}`) {
    let time = Date.now();
    const first = new D1TransactionStore({ db, namespace, now: () => time });
    const second = new D1TransactionStore({ db, namespace, now: () => time });
    const record = { ...input, expiresAt: time + 600000 };
    return {
      namespace, first, second, record,
      advance(milliseconds) { time += milliseconds; },
      now: () => time,
      get: () => db.prepare('SELECT * FROM auth_transactions WHERE namespace = ? AND transaction_id = ?')
        .bind(namespace, input.transactionId).first(),
      async authorize() {
        await first.create(record);
        await second.callback(record.oauthState, { code: 'one-use-code', denied: false });
      },
    };
  }

  await t.test('only explicit state fields are persisted and the claimed code is removed before it is returned', async () => {
    const f = fixture();
    await f.first.create({ ...f.record, codeVerifier: 'private-verifier', accessToken: 'private-access', refreshToken: 'private-refresh', clientSecret: 'private-secret' });
    const stored = await f.get();
    assert.equal(stored.oauth_state_hash, await oauthStateHash(input.oauthState));
    assert.equal(stored.expires_at, f.record.expiresAt);
    const serialized = JSON.stringify(stored);
    for (const excluded of [input.oauthState, 'private-verifier', 'private-access', 'private-refresh', 'private-secret']) assert.ok(!serialized.includes(excluded));
    assert.deepEqual(await f.second.callback(input.oauthState, { code: 'one-use-code', denied: false }), {
      transactionId: input.transactionId, clientState: input.clientState,
    });
    assert.equal((await f.get()).code, 'one-use-code');
    assert.deepEqual(await f.first.claim(input.transactionId, input.codeChallenge), { code: 'one-use-code', denied: false });
    assert.equal((await f.get()).code, null);
    assert.equal((await f.get()).status, 'consuming');
    await f.second.finish(input.transactionId);
    assert.equal(await f.get(), null);
  });

  await t.test('competing callbacks across independent stores cannot replace the accepted code', async () => {
    const f = fixture();
    await f.first.create(f.record);
    const outcomes = await Promise.allSettled([
      f.first.callback(input.oauthState, { code: 'first-code', denied: false }),
      f.second.callback(input.oauthState, { code: 'second-code', denied: false }),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'transaction_consumed');
    const winner = outcomes[0].status === 'fulfilled' ? 'first-code' : 'second-code';
    assert.equal((await f.first.claim(input.transactionId, input.codeChallenge)).code, winner);
  });

  await t.test('two stores can return a code only once, including a newly constructed store', async () => {
    const f = fixture();
    await f.authorize();
    const outcomes = await Promise.allSettled([
      f.first.claim(input.transactionId, input.codeChallenge),
      f.second.claim(input.transactionId, input.codeChallenge),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(result => result.status === 'fulfilled').value.code, 'one-use-code');
    assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'transaction_consumed');
    const restarted = new D1TransactionStore({ db, namespace: f.namespace, now: f.now });
    await assert.rejects(restarted.claim(input.transactionId, input.codeChallenge), errorCode('transaction_consumed'));
    await assert.rejects(restarted.cancel(input.transactionId, input.codeChallenge), errorCode('transaction_consumed'));
    assert.equal((await f.get()).code, null);
  });

  await t.test('pending completion and incorrect proofs preserve a login for its owner', async () => {
    const f = fixture();
    await f.first.create(f.record);
    await assert.rejects(f.second.claim(input.transactionId, input.codeChallenge), errorCode('authorization_pending'));
    await assert.rejects(f.second.claim(input.transactionId, 'wrong-challenge'), errorCode('invalid_proof'));
    await assert.rejects(f.second.cancel(input.transactionId, 'wrong-challenge'), errorCode('invalid_proof'));
    await f.first.finish(input.transactionId);
    assert.equal((await f.get()).status, 'pending');
    await f.first.callback(input.oauthState, { code: 'one-use-code', denied: false });
    assert.equal((await f.second.claim(input.transactionId, input.codeChallenge)).code, 'one-use-code');
  });

  await t.test('denial is consumed once without returning a code', async () => {
    const f = fixture();
    await f.first.create(f.record);
    await f.second.callback(input.oauthState, { code: null, denied: true });
    assert.deepEqual(await f.first.claim(input.transactionId, input.codeChallenge), { denied: true });
    assert.equal((await f.get()).code, null);
    await assert.rejects(f.second.claim(input.transactionId, input.codeChallenge), errorCode('transaction_consumed'));
  });

  await t.test('cancellation removes both transaction and callback lookup', async () => {
    const f = fixture();
    await f.first.create(f.record);
    await f.second.cancel(input.transactionId, input.codeChallenge);
    assert.equal(await f.get(), null);
    await assert.rejects(f.first.callback(input.oauthState, { code: 'late-code', denied: false }), errorCode('transaction_not_found'));
    await assert.rejects(f.first.claim(input.transactionId, input.codeChallenge), errorCode('transaction_not_found'));
  });

  await t.test('racing cancellation and completion have exactly one winner', async () => {
    const f = fixture();
    await f.authorize();
    const [claim, cancel] = await Promise.allSettled([
      f.first.claim(input.transactionId, input.codeChallenge),
      f.second.cancel(input.transactionId, input.codeChallenge),
    ]);
    assert.equal([claim, cancel].filter(result => result.status === 'fulfilled').length, 1);
    if (claim.status === 'fulfilled') {
      assert.equal(cancel.reason.code, 'transaction_consumed');
      assert.equal((await f.get()).code, null);
    } else {
      assert.equal(claim.reason.code, 'transaction_not_found');
      assert.equal(await f.get(), null);
    }
  });

  await t.test('expiry is enforced even while expired rows remain in D1', async () => {
    const f = fixture();
    await f.authorize();
    f.advance(600000);
    assert.ok(await f.get());
    await assert.rejects(f.first.claim(input.transactionId, input.codeChallenge), errorCode('transaction_not_found'));
    await assert.rejects(f.second.cancel(input.transactionId, input.codeChallenge), errorCode('transaction_not_found'));
    await assert.rejects(f.second.callback(input.oauthState, { code: 'late-code', denied: false }), errorCode('transaction_not_found'));
    assert.equal((await f.get()).status, 'authorized');
  });

  await t.test('expiry while awaiting a committed claim never returns its code', async () => {
    const f = fixture();
    await f.authorize();
    const delayed = new D1TransactionStore({ namespace: f.namespace, now: f.now, db: {
      prepare: (sql) => db.prepare(sql),
      async batch(statements) {
        const result = await db.batch(statements);
        f.advance(600000);
        return result;
      },
    } });
    await assert.rejects(delayed.claim(input.transactionId, input.codeChallenge), errorCode('transaction_not_found'));
    assert.equal((await f.get()).status, 'consuming');
    assert.equal((await f.get()).code, null);
  });

  await t.test('uncertain commit acknowledgement never releases a claimed code for retry', async () => {
    const f = fixture();
    await f.authorize();
    const uncertain = new D1TransactionStore({ namespace: f.namespace, now: f.now, db: {
      prepare: (sql) => db.prepare(sql),
      async batch(statements) {
        await db.batch(statements);
        throw new Error('mock acknowledgement lost');
      },
    } });
    let returnedCodes = 0;
    await assert.rejects(uncertain.claim(input.transactionId, input.codeChallenge).then(() => returnedCodes++), /acknowledgement/);
    assert.equal(returnedCodes, 0);
    await assert.rejects(f.second.claim(input.transactionId, input.codeChallenge), errorCode('transaction_consumed'));
    assert.equal((await f.get()).code, null);
  });

  await t.test('a failing statement rolls back the full claim batch', async () => {
    const f = fixture();
    await f.authorize();
    const failing = new D1TransactionStore({ namespace: f.namespace, now: f.now, db: {
      prepare: (sql) => db.prepare(sql),
      batch: (statements) => db.batch([...statements, db.prepare('INSERT INTO auth_transactions (namespace) VALUES (NULL)')]),
    } });
    await assert.rejects(failing.claim(input.transactionId, input.codeChallenge));
    assert.equal((await f.get()).status, 'authorized');
    assert.equal((await f.get()).code, 'one-use-code');
    assert.equal((await f.second.claim(input.transactionId, input.codeChallenge)).code, 'one-use-code');
  });

  await t.test('namespaces isolate matching transaction IDs and OAuth states', async () => {
    const first = fixture(), other = fixture();
    await first.authorize();
    await assert.rejects(other.first.claim(input.transactionId, input.codeChallenge), errorCode('transaction_not_found'));
    await assert.rejects(other.first.callback(input.oauthState, { code: 'foreign-code', denied: false }), errorCode('transaction_not_found'));
    await other.first.create(other.record);
    await other.first.cancel(input.transactionId, input.codeChallenge);
    assert.equal((await first.first.claim(input.transactionId, input.codeChallenge)).code, 'one-use-code');
  });

  await t.test('a duplicate OAuth state cannot overwrite its original transaction', async () => {
    const f = fixture();
    await f.first.create(f.record);
    await assert.rejects(f.second.create({ ...f.record, transactionId: 'e'.repeat(43) }));
    const result = await db.prepare('SELECT COUNT(*) AS total FROM auth_transactions WHERE namespace = ?').bind(f.namespace).first();
    assert.equal(result.total, 1);
    assert.equal((await f.get()).status, 'pending');
  });

  await t.test('cleanup is indexed, bounded, and restricted to expired rows in its namespace', async () => {
    const f = fixture(), other = fixture();
    for (let index = 0; index < 5; index++) {
      await f.first.create({ ...f.record, transactionId: `expired_${index}`, oauthState: `state_${index}`, expiresAt: f.now() + 1000 });
    }
    await f.first.create(f.record);
    await other.first.create({ ...other.record, expiresAt: other.now() + 1000 });
    f.advance(1000);
    other.advance(1000);
    const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT transaction_id FROM auth_transactions WHERE namespace = ? AND expires_at <= ? ORDER BY expires_at, transaction_id LIMIT ?')
      .bind(f.namespace, f.now(), 2).all();
    assert.match(JSON.stringify(plan.results), /auth_transactions_expiry/);
    assert.equal(await f.first.cleanup({ limit: 2 }), 2);
    assert.equal(await f.second.cleanup({ limit: 2 }), 2);
    assert.equal(await f.first.cleanup({ limit: 2 }), 1);
    assert.equal(await f.first.cleanup({ limit: 2 }), 0);
    assert.ok(await f.get());
    assert.ok(await other.get());
    await assert.rejects(f.first.cleanup({ limit: 1001 }), /Cleanup limit/);
  });

  await t.test('namespace cannot inject an SQL identifier or escape the environment boundary', () => {
    assert.throws(() => new D1TransactionStore({ db, namespace: "app'; DROP TABLE auth_transactions;--" }), /namespace/);
    assert.throws(() => new D1TransactionStore({ db: null }), /binding/);
  });
});
