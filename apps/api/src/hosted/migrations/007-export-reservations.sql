CREATE TABLE export_reservations (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, artifact_id uuid NOT NULL,
  session_bytes_id uuid NOT NULL, blob_bytes_id uuid NOT NULL, temporary_bytes_id uuid NOT NULL,
  PRIMARY KEY(session_id,workspace_id,artifact_id),
  FOREIGN KEY(session_id,workspace_id,artifact_id) REFERENCES export_artifacts(session_id,workspace_id,id),
  FOREIGN KEY(session_id,session_bytes_id) REFERENCES quota_reservations(session_id,id),
  FOREIGN KEY(session_id,blob_bytes_id) REFERENCES quota_reservations(session_id,id),
  FOREIGN KEY(session_id,temporary_bytes_id) REFERENCES quota_reservations(session_id,id)
);
