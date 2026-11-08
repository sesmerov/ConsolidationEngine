-- Each physical allocation owns distinct state/file, Blob and SQL reservations.
CREATE TABLE physical_object_reservations (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, object_id uuid NOT NULL, reservation_id uuid NOT NULL,
  PRIMARY KEY(session_id,workspace_id,object_id,reservation_id),
  FOREIGN KEY(session_id,workspace_id,object_id) REFERENCES physical_objects(session_id,workspace_id,id),
  FOREIGN KEY(session_id,reservation_id) REFERENCES quota_reservations(session_id,id)
);
-- Provisional roots protect shared blocks while another live worker may still need them.
CREATE TABLE canonical_claims (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, operation_id uuid NOT NULL, block_id uuid NOT NULL,
  job_id uuid, attempt_id uuid, fence bigint, expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','retained','released')),
  PRIMARY KEY(session_id,workspace_id,operation_id,block_id),
  FOREIGN KEY(session_id,workspace_id,block_id) REFERENCES canonical_blocks(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id),
  CHECK((job_id IS NULL AND attempt_id IS NULL AND fence IS NULL) OR (job_id IS NOT NULL AND attempt_id IS NOT NULL AND fence>0))
);
CREATE INDEX canonical_claims_expiry ON canonical_claims(state,expires_at,operation_id);

-- One publication can point to several roots sharing descendants; each descendant is counted once.
CREATE TABLE canonical_retention_links (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, publication_id uuid NOT NULL, block_id uuid NOT NULL,
  job_id uuid NOT NULL, attempt_id uuid NOT NULL, fence bigint NOT NULL CHECK(fence>0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(session_id,workspace_id,publication_id,block_id),
  FOREIGN KEY(session_id,workspace_id,block_id) REFERENCES canonical_blocks(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id)
);
CREATE INDEX canonical_retention_block ON canonical_retention_links(session_id,workspace_id,block_id);
