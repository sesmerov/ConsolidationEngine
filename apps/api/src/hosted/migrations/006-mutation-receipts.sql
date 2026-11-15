-- Small synchronous manual mutations do not allocate a CPU job merely to recover an acknowledgement.
CREATE TABLE mutation_receipts (
  session_id uuid NOT NULL REFERENCES demo_sessions(id), key_hash sha256_hex NOT NULL,
  method text NOT NULL CHECK(method IN ('POST','PATCH','DELETE')),
  path text NOT NULL CHECK(length(path) BETWEEN 1 AND 500), request_fingerprint sha256_hex NOT NULL,
  expected_base text NOT NULL CHECK(length(expected_base)<=150), workspace_id uuid,
  response_status integer NOT NULL CHECK(response_status IN (200,201,204)),
  response compact_object NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(session_id,key_hash),
  FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id)
);
CREATE INDEX mutation_receipts_workspace ON mutation_receipts(session_id,workspace_id);
