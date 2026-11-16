export class StoreError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function oauthStateHash(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function live(record, now) {
  if (!record || !Number.isSafeInteger(record.expires_at) || record.expires_at <= now) {
    throw new StoreError(404, 'transaction_not_found');
  }
}

function proof(record, challenge) {
  const expected = record.code_challenge;
  let difference = expected.length ^ challenge.length;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ (challenge.charCodeAt(index) || 0);
  if (difference !== 0) throw new StoreError(403, 'invalid_proof');
}

function rows(result) {
  if (!result?.success || !Array.isArray(result.results)) throw new StoreError(503, 'unavailable');
  return result.results;
}

/** 요청 데이터는 바인딩하고, 로그인 상태 변경은 원자적 SQL 또는 batch로 처리한다. */
export class D1TransactionStore {
  constructor({ db, namespace = 'image_paste_auth', now = Date.now }) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(namespace)) throw new Error('Invalid D1 namespace.');
    if (!db?.prepare || !db?.batch) throw new Error('A D1 database binding is required.');
    this.db = db;
    this.namespace = namespace;
    this.now = now;
  }

  async create(input) {
    const hash = await oauthStateHash(input.oauthState);
    live({ expires_at: input.expiresAt }, this.now());
    const result = await this.db.prepare(`
      INSERT INTO auth_transactions
        (namespace, transaction_id, oauth_state_hash, code_challenge, client_state, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
      RETURNING transaction_id
    `).bind(this.namespace, input.transactionId, hash, input.codeChallenge, input.clientState, input.expiresAt).all();
    if (rows(result).length !== 1) throw new StoreError(503, 'unavailable');
    live({ expires_at: input.expiresAt }, this.now());
  }

  async callback(state, { code, denied }) {
    const hash = await oauthStateHash(state);
    const result = await this.db.prepare(`
      UPDATE auth_transactions SET status = ?, code = ?
      WHERE namespace = ? AND oauth_state_hash = ? AND status = 'pending' AND expires_at > ?
      RETURNING transaction_id, client_state, expires_at
    `).bind(denied ? 'denied' : 'authorized', denied ? null : code, this.namespace, hash, this.now()).all();
    const changed = rows(result)[0];
    if (changed) {
      live(changed, this.now());
      return { transactionId: changed.transaction_id, clientState: changed.client_state };
    }
    const record = await this.db.prepare(`
      SELECT status, expires_at FROM auth_transactions WHERE namespace = ? AND oauth_state_hash = ?
    `).bind(this.namespace, hash).first();
    live(record, this.now());
    throw new StoreError(409, 'transaction_consumed');
  }

  async claim(id, challenge) {
    const time = this.now();
    // D1 batch 전체가 커밋된 뒤에만 조회한 code를 반환한다. JS에서 교환하거나 재시도하지 않는다.
    const results = await this.db.batch([
      this.db.prepare(`
        SELECT status, expires_at, code_challenge,
          CASE WHEN code_challenge = ? THEN code ELSE NULL END AS code
        FROM auth_transactions WHERE namespace = ? AND transaction_id = ?
      `).bind(challenge, this.namespace, id),
      this.db.prepare(`
        UPDATE auth_transactions SET status = 'consuming', code = NULL
        WHERE namespace = ? AND transaction_id = ? AND code_challenge = ? AND expires_at > ?
          AND status IN ('authorized', 'denied')
        RETURNING transaction_id
      `).bind(this.namespace, id, challenge, time),
    ]);
    if (!Array.isArray(results) || results.length !== 2) throw new StoreError(503, 'unavailable');
    const record = rows(results[0])[0];
    const changed = rows(results[1]);
    // DB 대기 중 만료되어도 코드를 반환하지 않는다. 이미 소비된 상태는 되돌리지 않는다.
    live(record, this.now());
    proof(record, challenge);
    if (record.status === 'pending') throw new StoreError(409, 'authorization_pending');
    if (!['authorized', 'denied'].includes(record.status)) throw new StoreError(409, 'transaction_consumed');
    if (changed.length !== 1 || (record.status === 'authorized' && typeof record.code !== 'string')) {
      throw new StoreError(503, 'unavailable');
    }
    return record.status === 'denied' ? { denied: true } : { code: record.code, denied: false };
  }

  async cancel(id, challenge) {
    const result = await this.db.prepare(`
      DELETE FROM auth_transactions
      WHERE namespace = ? AND transaction_id = ? AND code_challenge = ? AND expires_at > ? AND status != 'consuming'
      RETURNING transaction_id
    `).bind(this.namespace, id, challenge, this.now()).all();
    if (rows(result).length === 1) return;
    const record = await this.db.prepare(`
      SELECT status, expires_at, code_challenge FROM auth_transactions WHERE namespace = ? AND transaction_id = ?
    `).bind(this.namespace, id).first();
    live(record, this.now());
    proof(record, challenge);
    throw new StoreError(409, 'transaction_consumed');
  }

  async finish(id) {
    const result = await this.db.prepare(`
      DELETE FROM auth_transactions WHERE namespace = ? AND transaction_id = ? AND status = 'consuming'
      RETURNING transaction_id
    `).bind(this.namespace, id).all();
    rows(result);
  }

  async cleanup({ limit = 200 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Cleanup limit must be between 1 and 1000.');
    const result = await this.db.prepare(`
      DELETE FROM auth_transactions WHERE namespace = ? AND transaction_id IN (
        SELECT transaction_id FROM auth_transactions
        WHERE namespace = ? AND expires_at <= ? ORDER BY expires_at, transaction_id LIMIT ?
      ) RETURNING transaction_id
    `).bind(this.namespace, this.namespace, this.now(), limit).all();
    return rows(result).length;
  }
}
