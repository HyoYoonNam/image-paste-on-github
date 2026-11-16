import { createHash, timingSafeEqual } from 'node:crypto';

export class StoreError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const oauthStateHash = (state) => createHash('sha256').update(state).digest('hex');

export function assertLive(record, now) {
  if (!record || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now) {
    throw new StoreError(404, 'transaction_not_found');
  }
}

export function assertProof(record, challenge) {
  const expected = Buffer.from(record.codeChallenge);
  const received = Buffer.from(challenge);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new StoreError(403, 'invalid_proof');
  }
}

export function claimResult(record) {
  if (record.status === 'pending') throw new StoreError(409, 'authorization_pending');
  if (record.status !== 'authorized' && record.status !== 'denied') throw new StoreError(409, 'transaction_consumed');
  return record.status === 'denied' ? { denied: true } : { code: record.code, denied: false };
}

export function storedRecord(input) {
  // Explicit fields keep tokens, verifiers, client secrets, and raw OAuth state out of storage.
  return {
    transactionId: input.transactionId,
    oauthStateHash: oauthStateHash(input.oauthState),
    codeChallenge: input.codeChallenge,
    clientState: input.clientState,
    expiresAt: input.expiresAt,
    expireAt: new Date(input.expiresAt),
    status: 'pending',
  };
}

/** Local development store. Methods transition synchronously before returning their promises. */
export class MemoryTransactionStore {
  constructor({ maxTransactions = 1000, now = Date.now } = {}) {
    this.maxTransactions = maxTransactions;
    this.now = now;
    this.transactions = new Map();
    this.states = new Map();
  }

  prune() {
    for (const [id, record] of this.transactions) if (record.expiresAt <= this.now()) this.remove(id);
  }

  remove(id) {
    const record = this.transactions.get(id);
    if (record) this.states.delete(record.oauthStateHash);
    this.transactions.delete(id);
  }

  async create(input) {
    this.prune();
    if (this.transactions.size >= this.maxTransactions) throw new StoreError(429, 'rate_limited');
    const record = storedRecord(input);
    assertLive(record, this.now());
    if (this.transactions.has(input.transactionId) || this.states.has(record.oauthStateHash)) throw new StoreError(503, 'unavailable');
    this.transactions.set(input.transactionId, record);
    this.states.set(record.oauthStateHash, input.transactionId);
  }

  async callback(state, { code, denied }) {
    const record = this.transactions.get(this.states.get(oauthStateHash(state)));
    assertLive(record, this.now());
    if (record.status !== 'pending') throw new StoreError(409, 'transaction_consumed');
    record.status = denied ? 'denied' : 'authorized';
    if (!denied) record.code = code;
    return { transactionId: record.transactionId, clientState: record.clientState };
  }

  async claim(id, challenge) {
    const record = this.transactions.get(id);
    assertLive(record, this.now());
    assertProof(record, challenge);
    const result = claimResult(record);
    record.status = 'consuming';
    delete record.code;
    return result;
  }

  async cancel(id, challenge) {
    const record = this.transactions.get(id);
    assertLive(record, this.now());
    assertProof(record, challenge);
    if (record.status === 'consuming') throw new StoreError(409, 'transaction_consumed');
    this.remove(id);
  }

  async finish(id) {
    if (this.transactions.get(id)?.status === 'consuming') this.remove(id);
  }

  async close() {
    this.transactions.clear();
    this.states.clear();
  }
}

export async function createStoreFromEnvironment(environment = process.env, { now = Date.now } = {}) {
  const kind = environment.SESSION_STORE ?? 'memory';
  if (!['memory', 'firestore'].includes(kind) || (environment.K_SERVICE && kind !== 'firestore')) {
    throw new Error('Cloud Run requires SESSION_STORE=firestore.');
  }
  if (kind === 'memory') return new MemoryTransactionStore({ now });
  if (environment.K_SERVICE && environment.FIRESTORE_EMULATOR_HOST) throw new Error('An emulator is not allowed in Cloud Run.');
  const [{ Firestore }, { FirestoreTransactionStore }] = await Promise.all([
    import('@google-cloud/firestore'), import('./firestore-store.mjs'),
  ]);
  const firestore = new Firestore({
    ...(environment.FIRESTORE_PROJECT_ID ? { projectId: environment.FIRESTORE_PROJECT_ID } : {}),
    databaseId: environment.FIRESTORE_DATABASE_ID || '(default)',
  });
  return new FirestoreTransactionStore({ firestore, collectionPrefix: environment.FIRESTORE_COLLECTION_PREFIX || 'image_paste_auth', now });
}
