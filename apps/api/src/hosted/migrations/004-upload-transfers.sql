CREATE TABLE upload_batch_reservations (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, batch_id uuid NOT NULL,
  session_bytes_id uuid NOT NULL, blob_bytes_id uuid NOT NULL,
  PRIMARY KEY(session_id,workspace_id,batch_id),
  FOREIGN KEY(session_id,workspace_id,batch_id) REFERENCES upload_batches(session_id,workspace_id,id),
  FOREIGN KEY(session_id,session_bytes_id) REFERENCES quota_reservations(session_id,id),
  FOREIGN KEY(session_id,blob_bytes_id) REFERENCES quota_reservations(session_id,id)
);
CREATE TABLE upload_part_claims (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, batch_id uuid NOT NULL, file_id uuid NOT NULL,
  part_index integer NOT NULL CHECK(part_index BETWEEN 0 AND 3), size integer NOT NULL CHECK(size BETWEEN 1 AND 3145728), sha256 sha256_hex NOT NULL,
  session_bytes_id uuid NOT NULL, blob_bytes_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','recorded','cancelled')),
  PRIMARY KEY(session_id,workspace_id,file_id,part_index),
  FOREIGN KEY(session_id,workspace_id,batch_id) REFERENCES upload_batches(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,file_id) REFERENCES stored_files(session_id,workspace_id,id),
  FOREIGN KEY(session_id,session_bytes_id) REFERENCES quota_reservations(session_id,id),
  FOREIGN KEY(session_id,blob_bytes_id) REFERENCES quota_reservations(session_id,id)
);
ALTER TABLE upload_batches ADD COLUMN seal_job_id uuid;
ALTER TABLE upload_batches ADD FOREIGN KEY(session_id,workspace_id,seal_job_id) REFERENCES jobs(session_id,workspace_id,id);
