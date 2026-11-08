-- Compact inspection/application authority. Heavy candidate/changes are private canonical/index references.
CREATE TABLE import_inspections (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, base_version_id uuid,
  upload_batch_id uuid NOT NULL, job_id uuid NOT NULL, inspection_hash sha256_hex NOT NULL,
  state text NOT NULL CHECK(state IN ('ready','committing','committed','invalidated','expired','discarded')),
  candidate_ref compact_object, detail_ref compact_object NOT NULL, summary compact_object NOT NULL DEFAULT '{}',
  commit_job_id uuid, committed_version_id uuid, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id),
  FOREIGN KEY(session_id,workspace_id,base_version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,upload_batch_id) REFERENCES upload_batches(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,commit_job_id) REFERENCES jobs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,committed_version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  CHECK(expires_at>created_at), CHECK(state<>'committed' OR committed_version_id IS NOT NULL)
);
CREATE INDEX import_inspections_active ON import_inspections(session_id,workspace_id,created_at DESC,id)
  WHERE state IN ('ready','committing');
CREATE INDEX import_inspections_expiry ON import_inspections(expires_at,id) WHERE state='ready';

CREATE TABLE application_receipts (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, job_id uuid NOT NULL,
  base_version_id uuid NOT NULL, new_version_id uuid NOT NULL, preview_id uuid NOT NULL,
  before_run_id uuid NOT NULL, after_run_id uuid NOT NULL, selection_id uuid NOT NULL, selection_revision bigint NOT NULL CHECK(selection_revision>0),
  closure_hash sha256_hex NOT NULL, accepted_count integer NOT NULL CHECK(accepted_count>0),
  changes_ref compact_object NOT NULL, detail_ref compact_object NOT NULL,
  applied_at timestamptz NOT NULL, PRIMARY KEY(session_id,workspace_id,id), UNIQUE(session_id,workspace_id,job_id),
  FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id),
  FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,base_version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,new_version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,preview_id) REFERENCES previews(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,before_run_id) REFERENCES validation_runs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,after_run_id) REFERENCES validation_runs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,selection_id) REFERENCES proposal_selections(session_id,workspace_id,id)
);
CREATE INDEX application_receipts_version ON application_receipts(session_id,workspace_id,new_version_id,applied_at DESC,id);
