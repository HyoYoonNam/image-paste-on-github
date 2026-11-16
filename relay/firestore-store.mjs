import { StoreError, assertLive, assertProof, claimResult, oauthStateHash, storedRecord } from './transaction-store.mjs';

/** Firestore retries these callbacks. Only Firestore reads/writes belong inside them. */
export class FirestoreTransactionStore {
  constructor({ firestore, collectionPrefix = 'image_paste_auth', now = Date.now }) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(collectionPrefix)) throw new Error('Invalid Firestore collection prefix.');
    this.firestore = firestore;
    this.now = now;
    this.transactions = firestore.collection(`${collectionPrefix}_transactions`);
    this.states = firestore.collection(`${collectionPrefix}_states`);
  }

  async create(input) {
    const record = storedRecord(input);
    const transaction = this.transactions.doc(input.transactionId);
    const state = this.states.doc(record.oauthStateHash);
    await this.firestore.runTransaction(async (tx) => {
      assertLive(record, this.now());
      tx.create(transaction, record);
      tx.create(state, { transactionId: input.transactionId, expiresAt: input.expiresAt, expireAt: new Date(input.expiresAt) });
    });
  }

  async callback(state, { code, denied }) {
    const hash = oauthStateHash(state);
    return this.firestore.runTransaction(async (tx) => {
      const index = (await tx.get(this.states.doc(hash))).data();
      assertLive(index, this.now());
      const ref = this.transactions.doc(index.transactionId);
      const record = (await tx.get(ref)).data();
      assertLive(record, this.now());
      if (record.oauthStateHash !== hash) throw new StoreError(404, 'transaction_not_found');
      if (record.status !== 'pending') throw new StoreError(409, 'transaction_consumed');
      tx.set(ref, { ...record, status: denied ? 'denied' : 'authorized', ...(!denied ? { code } : {}) });
      return { transactionId: index.transactionId, clientState: record.clientState };
    });
  }

  async claim(id, challenge) {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.transactions.doc(id);
      const record = (await tx.get(ref)).data();
      assertLive(record, this.now());
      assertProof(record, challenge);
      const result = claimResult(record);
      const consumed = { ...record, status: 'consuming' };
      delete consumed.code;
      tx.set(ref, consumed);
      return result;
    });
  }

  async cancel(id, challenge) {
    await this.firestore.runTransaction(async (tx) => {
      const ref = this.transactions.doc(id);
      const record = (await tx.get(ref)).data();
      assertLive(record, this.now());
      assertProof(record, challenge);
      if (record.status === 'consuming') throw new StoreError(409, 'transaction_consumed');
      tx.delete(ref);
      tx.delete(this.states.doc(record.oauthStateHash));
    });
  }

  async finish(id) {
    await this.firestore.runTransaction(async (tx) => {
      const ref = this.transactions.doc(id);
      const record = (await tx.get(ref)).data();
      if (!record || record.status !== 'consuming') return;
      tx.delete(ref);
      tx.delete(this.states.doc(record.oauthStateHash));
    });
  }

  async close() {
    await this.firestore.terminate();
  }
}
