CREATE TABLE auth_transactions (
  namespace TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  oauth_state_hash TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  client_state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'authorized', 'denied', 'consuming')),
  code TEXT,
  PRIMARY KEY (namespace, transaction_id),
  UNIQUE (namespace, oauth_state_hash),
  CHECK ((status = 'authorized' AND code IS NOT NULL) OR (status != 'authorized' AND code IS NULL))
);

CREATE INDEX auth_transactions_expiry
  ON auth_transactions (namespace, expires_at, transaction_id);
