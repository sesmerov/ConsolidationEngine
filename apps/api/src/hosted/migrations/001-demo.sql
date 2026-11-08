-- PostgreSQL 17. Authority metadata only: heavy content belongs to private immutable blocks.
-- tokenHash único y creationNonceHash único; never store either visitor secret in cleartext.
CREATE DOMAIN sha256_hex AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN compact_object AS jsonb CHECK (jsonb_typeof(VALUE)='object' AND octet_length(VALUE::text)<=65536);

CREATE TABLE demo_sessions (
  id uuid PRIMARY KEY, token_hash sha256_hex NOT NULL UNIQUE, creation_nonce_hash sha256_hex NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked','expired','cleanup_pending','deleted')),
  created_at timestamptz NOT NULL, last_meaningful_activity_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz,
  reason text CHECK(length(reason)<=100), quota_usage compact_object NOT NULL DEFAULT '{}',
  CHECK(created_at<=last_meaningful_activity_at AND last_meaningful_activity_at<=expires_at AND expires_at<=absolute_expires_at),
  CHECK(absolute_expires_at<=created_at+interval '24 hours'),
  CHECK(expires_at<=last_meaningful_activity_at+interval '60 minutes'),
  CHECK((state='active' AND revoked_at IS NULL) OR state<>'active')
);
CREATE INDEX demo_sessions_expiry ON demo_sessions(expires_at,id) WHERE state='active';
CREATE INDEX demo_sessions_created ON demo_sessions(created_at,id);

CREATE TABLE workspaces (
  session_id uuid NOT NULL REFERENCES demo_sessions(id), id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  current_version_id uuid, current_basis_id uuid, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  status text NOT NULL DEFAULT 'empty' CHECK(status IN ('empty','ready','closed')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,id)
);
-- un conjunto activo por sesión
CREATE UNIQUE INDEX one_active_workspace_per_session ON workspaces(session_id) WHERE status<>'closed';

CREATE TABLE validation_bases (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
  catalog_ref compact_object NOT NULL, data_ref compact_object NOT NULL, contexts_ref compact_object NOT NULL,
  profile_ids jsonb NOT NULL CHECK(jsonb_typeof(profile_ids)='array' AND octet_length(profile_ids::text)<=8192),
  hashes compact_object NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,workspace_id,id), FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id)
);
CREATE TABLE workspace_versions (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, parent_id uuid, basis_id uuid NOT NULL,
  directions_ref compact_object NOT NULL, content_manifest_ref compact_object NOT NULL, content_hash sha256_hex NOT NULL,
  config_version sha256_hex, profile_id text CHECK(length(profile_id)<=200), catalog_version text CHECK(length(catalog_version)<=200),
  report_version text CHECK(length(report_version)<=200), summary compact_object NOT NULL DEFAULT '{}',
  -- Razón import/configuration/application; máximo 20 snapshots retenidos
  reason text NOT NULL CHECK(reason IN ('import','configuration','application')),
  created_at timestamptz NOT NULL DEFAULT now(), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), retained boolean NOT NULL DEFAULT true,
  PRIMARY KEY(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,basis_id) REFERENCES validation_bases(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,parent_id) REFERENCES workspace_versions(session_id,workspace_id,id)
);
CREATE INDEX workspace_versions_history ON workspace_versions(session_id,workspace_id,created_at,id) WHERE retained;
CREATE FUNCTION enforce_snapshot_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.retained AND (TG_OP='INSERT' OR NOT OLD.retained OR OLD.session_id<>NEW.session_id) THEN
    -- Serialize against all publications for this session, including independent API pools.
    PERFORM 1 FROM demo_sessions WHERE id=NEW.session_id FOR UPDATE;
    IF (SELECT count(*) FROM workspace_versions WHERE session_id=NEW.session_id AND retained)>=20 THEN
      RAISE EXCEPTION 'SNAPSHOT_LIMIT' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_limit BEFORE INSERT OR UPDATE OF retained,session_id ON workspace_versions FOR EACH ROW EXECUTE FUNCTION enforce_snapshot_limit();
ALTER TABLE workspaces ADD FOREIGN KEY(session_id,id,current_version_id) REFERENCES workspace_versions(session_id,workspace_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE workspaces ADD FOREIGN KEY(session_id,id,current_basis_id) REFERENCES validation_bases(session_id,workspace_id,id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE validation_runs (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, version_id uuid NOT NULL, basis_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled','timed_out')),
  summary compact_object NOT NULL DEFAULT '{}', result_index_ref compact_object, diagnostics_ref compact_object,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz, profile_id text CHECK(length(profile_id)<=200),
  PRIMARY KEY(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,basis_id) REFERENCES validation_bases(session_id,workspace_id,id)
);
CREATE INDEX validation_runs_basis ON validation_runs(session_id,workspace_id,basis_id,status,created_at DESC,id);
CREATE TABLE direction_reviews (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, basis_id uuid NOT NULL, source_run_id uuid NOT NULL, base_version_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>=0),
  state text NOT NULL CHECK(state IN ('preparing','ready','committing','committed','discarded','expired','obsolete','failed')),
  config_changed boolean NOT NULL DEFAULT false, dirty_count integer NOT NULL DEFAULT 0 CHECK(dirty_count>=0), base_config_version sha256_hex,
  preparation_job_id uuid, pending_job_id uuid, ready_at timestamptz, receipt compact_object,
  counts compact_object NOT NULL DEFAULT '{}', choices_ref compact_object, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,basis_id) REFERENCES validation_bases(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,source_run_id) REFERENCES validation_runs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,base_version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  CHECK(revision>0 OR state IN ('preparing','failed'))
);
CREATE INDEX direction_reviews_basis ON direction_reviews(session_id,workspace_id,basis_id,base_version_id,created_at DESC,id);

CREATE TABLE jobs (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('import','inspect-import','prepare-directions','commit-directions','recalculation-operation','validate','preview','select-proposals','apply','export','seal-upload')),
  input_refs compact_object NOT NULL, base_version_id uuid, expected_revision bigint CHECK(expected_revision>0),
  accepted_at timestamptz NOT NULL, queue_expires_at timestamptz NOT NULL, started_at timestamptz, deadline_at timestamptz, terminal_at timestamptz,
  status text NOT NULL CHECK(status IN ('queued','dispatch_pending','running','succeeded','failed','cancelled','timed_out')),
  cancel_requested_at timestamptz, fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), attempt_id uuid,
  result_refs compact_object, diagnostics compact_object NOT NULL DEFAULT '{}', progress compact_object NOT NULL DEFAULT '{}',
  PRIMARY KEY(session_id,workspace_id,id), FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id),
  FOREIGN KEY(session_id,workspace_id,base_version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  CHECK(queue_expires_at>accepted_at AND queue_expires_at<=accepted_at+interval '10 minutes'),
  CHECK((started_at IS NULL AND deadline_at IS NULL) OR (started_at IS NOT NULL AND deadline_at IS NOT NULL AND deadline_at<=started_at+interval '60 seconds')),
  CHECK(result_refs IS NULL OR status='succeeded'),
  CHECK((status IN ('succeeded','failed','cancelled','timed_out'))=(terminal_at IS NOT NULL))
);
CREATE INDEX jobs_queue ON jobs(status,queue_expires_at,accepted_at,id) WHERE status IN ('queued','dispatch_pending');
CREATE INDEX jobs_workspace ON jobs(session_id,workspace_id,status,accepted_at,id);
CREATE UNIQUE INDEX one_running_job_per_workspace ON jobs(session_id,workspace_id) WHERE status='running';
ALTER TABLE direction_reviews ADD FOREIGN KEY(session_id,workspace_id,preparation_job_id) REFERENCES jobs(session_id,workspace_id,id);
ALTER TABLE direction_reviews ADD FOREIGN KEY(session_id,workspace_id,pending_job_id) REFERENCES jobs(session_id,workspace_id,id);

CREATE TABLE recalculation_operations (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, request_fingerprint sha256_hex NOT NULL,
  input_version_id uuid NOT NULL, basis_id uuid NOT NULL, run_id uuid NOT NULL, review_id uuid NOT NULL, review_revision bigint NOT NULL CHECK(review_revision>0),
  reserved_effective_version_id uuid NOT NULL, config_changed boolean NOT NULL, reserved_preview_id uuid NOT NULL, reserved_selection_id uuid, job_id uuid NOT NULL,
  phase text NOT NULL CHECK(phase IN ('queued','dispatch_pending','running','succeeded','failed','cancelled','timed_out')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,workspace_id,id), UNIQUE(session_id,workspace_id,job_id),
  FOREIGN KEY(session_id,workspace_id,input_version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,basis_id) REFERENCES validation_bases(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,run_id) REFERENCES validation_runs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,review_id) REFERENCES direction_reviews(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id)
);
CREATE TABLE previews (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, version_id uuid NOT NULL, basis_id uuid NOT NULL,
  source_run_id uuid NOT NULL, manifest_refs compact_object NOT NULL, counters compact_object NOT NULL DEFAULT '{}',
  content_hash sha256_hex NOT NULL, state text NOT NULL CHECK(state IN ('ready','applied','discarded','obsolete','expired')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,basis_id) REFERENCES validation_bases(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,source_run_id) REFERENCES validation_runs(session_id,workspace_id,id)
);
CREATE TABLE proposal_selections (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, preview_id uuid NOT NULL, version_id uuid NOT NULL, basis_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>=0), mask_ref compact_object NOT NULL, counters compact_object NOT NULL DEFAULT '{}',
  selection_hash sha256_hex NOT NULL, state text NOT NULL CHECK(state IN ('preparing','ready','updating','applying','applied','obsolete','discarded','failed','expired')),
  initialization_job_id uuid, pending_job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,workspace_id,id), UNIQUE(session_id,workspace_id,preview_id),
  FOREIGN KEY(session_id,workspace_id,preview_id) REFERENCES previews(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,basis_id) REFERENCES validation_bases(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,initialization_job_id) REFERENCES jobs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,pending_job_id) REFERENCES jobs(session_id,workspace_id,id),
  CHECK(revision>0 OR state IN ('preparing','failed'))
);
CREATE TABLE direction_review_mutations (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, review_id uuid NOT NULL, mutation_id uuid NOT NULL,
  request_fingerprint sha256_hex NOT NULL, applied_revision bigint NOT NULL CHECK(applied_revision>0), response compact_object NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,workspace_id,review_id,mutation_id),
  FOREIGN KEY(session_id,workspace_id,review_id) REFERENCES direction_reviews(session_id,workspace_id,id)
);
CREATE TABLE proposal_selection_mutations (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, selection_id uuid NOT NULL, mutation_id uuid NOT NULL,
  request_fingerprint sha256_hex NOT NULL, applied_revision bigint NOT NULL CHECK(applied_revision>0), response compact_object NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,workspace_id,selection_id,mutation_id),
  FOREIGN KEY(session_id,workspace_id,selection_id) REFERENCES proposal_selections(session_id,workspace_id,id)
);
CREATE TABLE operation_receipts (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, key_hash sha256_hex NOT NULL,
  method text NOT NULL CHECK(method IN ('POST','PUT','PATCH','DELETE')), path text NOT NULL CHECK(length(path) BETWEEN 1 AND 500),
  request_fingerprint sha256_hex NOT NULL, expected_base text NOT NULL CHECK(length(expected_base)<=150),
  response_status integer NOT NULL CHECK(response_status IN (202,503)), job_id uuid NOT NULL, operation_id uuid NOT NULL,
  reservation compact_object, result_refs compact_object, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,key_hash), FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id)
);
CREATE INDEX operation_receipts_operation ON operation_receipts(session_id,operation_id);
CREATE INDEX operation_receipts_job ON operation_receipts(session_id,workspace_id,job_id);
CREATE TABLE outbox_entries (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, job_id uuid NOT NULL,
  dispatch_state text NOT NULL CHECK(dispatch_state IN ('pending','dispatching','uncertain','published','expired','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz NOT NULL,
  published_message_id text CHECK(length(published_message_id)<=500), last_error text CHECK(length(last_error)<=200),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,workspace_id,id), UNIQUE(session_id,workspace_id,job_id),
  FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id)
);
CREATE INDEX outbox_dispatch_due ON outbox_entries(next_attempt_at,id) WHERE dispatch_state IN ('pending','uncertain');

CREATE TABLE cpu_permits (
  scope text NOT NULL CHECK(scope IN ('global','workspace','instance')), scope_key text NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 200),
  session_id uuid, workspace_id uuid, job_id uuid, attempt_id uuid, fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
  claimed_at timestamptz, safe_release_at timestamptz, released_at timestamptz,
  PRIMARY KEY(scope,scope_key), FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id),
  CHECK((session_id IS NULL AND workspace_id IS NULL AND job_id IS NULL) OR (session_id IS NOT NULL AND workspace_id IS NOT NULL AND job_id IS NOT NULL)),
  CHECK((claimed_at IS NULL AND safe_release_at IS NULL) OR safe_release_at>=claimed_at+interval '120 seconds')
);
CREATE TABLE leases (
  scope text NOT NULL CHECK(scope IN ('maintenance','cleanup','outbox')), scope_key text NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 200),
  holder_id uuid, fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0), claimed_at timestamptz, safe_release_at timestamptz,
  PRIMARY KEY(scope,scope_key), CHECK((claimed_at IS NULL AND safe_release_at IS NULL) OR safe_release_at>claimed_at)
);
CREATE TABLE quota_reservations (
  id uuid PRIMARY KEY, session_id uuid REFERENCES demo_sessions(id), workspace_id uuid,
  scope text NOT NULL CHECK(scope IN ('global','session','workspace','maintenance')), resource text NOT NULL CHECK(length(resource) BETWEEN 1 AND 100),
  units bigint NOT NULL CHECK(units>=0), consumed_units bigint NOT NULL DEFAULT 0 CHECK(consumed_units>=0 AND consumed_units<=units),
  operation_id uuid NOT NULL, expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('reserved','consumed','uncertain','released','cleanup_pending')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id,id),
  FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id), CHECK(workspace_id IS NULL OR session_id IS NOT NULL)
);
CREATE INDEX quota_reservations_scope ON quota_reservations(scope,resource,state,expires_at);
CREATE INDEX quota_reservations_owner ON quota_reservations(session_id,workspace_id,resource,state);
CREATE INDEX quota_reservations_operation ON quota_reservations(operation_id,resource);
CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY, session_id uuid REFERENCES demo_sessions(id), workspace_id uuid, reservation_id uuid REFERENCES quota_reservations(id),
  scope text NOT NULL CHECK(scope IN ('global','session','workspace','maintenance')), resource text NOT NULL CHECK(length(resource) BETWEEN 1 AND 100),
  units bigint NOT NULL CHECK(units>=0), operation_id uuid NOT NULL, attempt_id uuid, recorded_at timestamptz NOT NULL,
  category text NOT NULL CHECK(category IN ('reserved','consumed','provisional','orphan','released','maintenance')),
  FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id), CHECK(workspace_id IS NULL OR session_id IS NOT NULL)
);
CREATE INDEX usage_ledger_window ON usage_ledger(resource,recorded_at,scope);
CREATE INDEX usage_ledger_owner ON usage_ledger(session_id,resource,recorded_at);
CREATE TABLE cleanup_tasks (
  id uuid PRIMARY KEY, session_id uuid REFERENCES demo_sessions(id), workspace_id uuid, object_ref compact_object NOT NULL,
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 100), not_before timestamptz NOT NULL, deadline timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), last_error text CHECK(length(last_error)<=200),
  state text NOT NULL CHECK(state IN ('pending','running','retry','completed','failed')), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id), CHECK(workspace_id IS NULL OR session_id IS NOT NULL), CHECK(not_before<=deadline)
);
CREATE INDEX cleanup_tasks_due ON cleanup_tasks(not_before,id) WHERE state IN ('pending','retry');
CREATE INDEX cleanup_tasks_deadline ON cleanup_tasks(deadline,id) WHERE state NOT IN ('completed');

CREATE TABLE upload_batches (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, base_version_id uuid,
  declared_total_bytes bigint NOT NULL CHECK(declared_total_bytes BETWEEN 1 AND 52428800),
  state text NOT NULL CHECK(state IN ('reserved','receiving','sealing','sealed','retained','cleanup_pending','deleted')),
  reservation_id uuid NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,workspace_id,id), FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id),
  FOREIGN KEY(session_id,workspace_id,base_version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,reservation_id) REFERENCES quota_reservations(session_id,id)
);
-- A typed parent gives every part/manifest a real, owner-qualified FK rather than a polymorphic unverified ID.
CREATE TABLE object_resources (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('file','artifact','block')),
  state text NOT NULL CHECK(state IN ('reserved','receiving','sealing','sealed','retained','cleanup_pending','deleted')),
  byte_length bigint NOT NULL CHECK(byte_length>0), sha256 sha256_hex NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,workspace_id,id), FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id)
);
CREATE TABLE stored_files (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, batch_id uuid, client_file_id text,
  role text NOT NULL CHECK(role IN ('catalog','report')), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name !~ '[/\\]'),
  mime text NOT NULL CHECK(length(mime) BETWEEN 1 AND 200), byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1 AND 10485760), sha256 sha256_hex NOT NULL,
  part_count integer NOT NULL CHECK(part_count BETWEEN 1 AND 4), state text NOT NULL CHECK(state IN ('reserved','receiving','sealing','sealed','retained','cleanup_pending','deleted')),
  retained_ref_count integer NOT NULL DEFAULT 0 CHECK(retained_ref_count>=0),
  PRIMARY KEY(session_id,workspace_id,id), UNIQUE(session_id,workspace_id,batch_id,client_file_id),
  FOREIGN KEY(session_id,workspace_id,id) REFERENCES object_resources(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,batch_id) REFERENCES upload_batches(session_id,workspace_id,id)
);
CREATE UNIQUE INDEX one_catalog_per_batch ON stored_files(session_id,workspace_id,batch_id) WHERE role='catalog';
CREATE TABLE snapshot_sources (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, version_id uuid NOT NULL, source_file_id uuid NOT NULL,
  PRIMARY KEY(session_id,workspace_id,version_id,source_file_id),
  FOREIGN KEY(session_id,workspace_id,version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,source_file_id) REFERENCES stored_files(session_id,workspace_id,id)
);
CREATE INDEX snapshot_sources_file ON snapshot_sources(session_id,workspace_id,source_file_id);
CREATE TABLE physical_objects (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL,
  private_object_key text NOT NULL UNIQUE CHECK(length(private_object_key) BETWEEN 1 AND 1000),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 3145728), sha256 sha256_hex NOT NULL,
  status text NOT NULL CHECK(status IN ('reserved','uploading','uncertain','stored','cleanup_pending','deleted')),
  reservation_id uuid NOT NULL, ref_count integer NOT NULL DEFAULT 0 CHECK(ref_count>=0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,workspace_id,id), FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id),
  FOREIGN KEY(session_id,reservation_id) REFERENCES quota_reservations(session_id,id)
);
CREATE INDEX physical_objects_cleanup ON physical_objects(status,updated_at,id) WHERE status IN ('uncertain','cleanup_pending');
CREATE TABLE object_parts (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, resource_id uuid NOT NULL, part_index integer NOT NULL CHECK(part_index BETWEEN 0 AND 33),
  size integer NOT NULL CHECK(size BETWEEN 1 AND 3145728), sha256 sha256_hex NOT NULL, object_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('reserved','uploading','uncertain','stored','cleanup_pending','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,workspace_id,resource_id,part_index),
  FOREIGN KEY(session_id,workspace_id,resource_id) REFERENCES object_resources(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,object_id) REFERENCES physical_objects(session_id,workspace_id,id)
);
CREATE TABLE object_manifests (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, resource_id uuid NOT NULL,
  codec_version integer NOT NULL CHECK(codec_version>0), whole_size bigint NOT NULL CHECK(whole_size BETWEEN 1 AND 104857600), whole_sha256 sha256_hex NOT NULL,
  part_count integer NOT NULL CHECK(part_count BETWEEN 1 AND 34), sealed_at timestamptz, ref_count integer NOT NULL DEFAULT 0 CHECK(ref_count>=0),
  state text NOT NULL CHECK(state IN ('sealing','sealed','retained','cleanup_pending','deleted')),
  PRIMARY KEY(session_id,workspace_id,id), UNIQUE(session_id,workspace_id,resource_id),
  FOREIGN KEY(session_id,workspace_id,resource_id) REFERENCES object_resources(session_id,workspace_id,id),
  CHECK(state NOT IN ('sealed','retained') OR sealed_at IS NOT NULL)
);
CREATE TABLE canonical_blocks (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, codec_version integer NOT NULL CHECK(codec_version>0),
  hash sha256_hex NOT NULL, byte_length bigint NOT NULL CHECK(byte_length>0), manifest_id uuid NOT NULL,
  ref_count integer NOT NULL DEFAULT 0 CHECK(ref_count>=0), reservation_id uuid NOT NULL,
  PRIMARY KEY(session_id,workspace_id,id), UNIQUE(session_id,codec_version,hash),
  FOREIGN KEY(session_id,workspace_id,id) REFERENCES object_resources(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,manifest_id) REFERENCES object_manifests(session_id,workspace_id,id),
  FOREIGN KEY(session_id,reservation_id) REFERENCES quota_reservations(session_id,id)
);
-- Canonical graph references permit reference accounting and cleanup without hydrating private content.
CREATE TABLE canonical_block_edges (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, parent_id uuid NOT NULL, child_id uuid NOT NULL,
  PRIMARY KEY(session_id,workspace_id,parent_id,child_id), CHECK(parent_id<>child_id),
  FOREIGN KEY(session_id,workspace_id,parent_id) REFERENCES canonical_blocks(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,child_id) REFERENCES canonical_blocks(session_id,workspace_id,id)
);
CREATE INDEX canonical_block_edges_child ON canonical_block_edges(session_id,workspace_id,child_id);
CREATE TABLE snapshot_manifests (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, version_id uuid NOT NULL, codec_version integer NOT NULL CHECK(codec_version>0),
  root_refs compact_object NOT NULL, shared_refs compact_object NOT NULL DEFAULT '{}', accounted_bytes bigint NOT NULL CHECK(accounted_bytes>=0),
  PRIMARY KEY(session_id,workspace_id,version_id), FOREIGN KEY(session_id,workspace_id,version_id) REFERENCES workspace_versions(session_id,workspace_id,id)
);
CREATE TABLE export_artifacts (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, version_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('report','results')), run_id uuid, job_id uuid NOT NULL, manifest_id uuid,
  status text NOT NULL CHECK(status IN ('preparing','ready','failed','cancelled','expired','cleanup_pending','deleted')),
  expires_at timestamptz NOT NULL, source_hashes compact_object NOT NULL DEFAULT '{}', filename text CHECK(length(filename)<=200),
  PRIMARY KEY(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,id) REFERENCES object_resources(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,version_id) REFERENCES workspace_versions(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,run_id) REFERENCES validation_runs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,manifest_id) REFERENCES object_manifests(session_id,workspace_id,id),
  CHECK(status<>'ready' OR manifest_id IS NOT NULL), CHECK((kind='results')=(run_id IS NOT NULL))
);
CREATE INDEX export_artifacts_expiry ON export_artifacts(expires_at,id) WHERE status='ready';

CREATE TABLE projection_sets (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, resource_kind text NOT NULL CHECK(resource_kind IN ('catalog','results','decisions','proposals','conflicts','changes','details')),
  resource_id uuid NOT NULL, basis_id uuid, revision bigint NOT NULL CHECK(revision>0), row_count integer NOT NULL CHECK(row_count>=0),
  job_id uuid, attempt_id uuid, fence bigint CHECK(fence>0), created_at timestamptz NOT NULL DEFAULT now(),
  complete boolean NOT NULL DEFAULT false, finished_at timestamptz,
  PRIMARY KEY(session_id,workspace_id,resource_kind,resource_id),
  FOREIGN KEY(session_id,workspace_id) REFERENCES workspaces(session_id,id),
  FOREIGN KEY(session_id,workspace_id,basis_id) REFERENCES validation_bases(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,job_id) REFERENCES jobs(session_id,workspace_id,id),
  CHECK(NOT complete OR finished_at IS NOT NULL),
  CHECK((job_id IS NULL AND attempt_id IS NULL AND fence IS NULL) OR (job_id IS NOT NULL AND attempt_id IS NOT NULL AND fence IS NOT NULL))
);
CREATE TABLE projection_rows (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, resource_kind text NOT NULL, resource_id uuid NOT NULL,
  row_key text NOT NULL CHECK(length(row_key) BETWEEN 1 AND 500), sort_key text NOT NULL CHECK(length(sort_key)<=500),
  rule_code text CHECK(length(rule_code)<=200), status text CHECK(length(status)<=100), payload_ref compact_object NOT NULL,
  summary compact_object NOT NULL DEFAULT '{}', PRIMARY KEY(session_id,workspace_id,resource_kind,resource_id,row_key),
  FOREIGN KEY(session_id,workspace_id,resource_kind,resource_id) REFERENCES projection_sets(session_id,workspace_id,resource_kind,resource_id)
);
CREATE INDEX projection_rows_page ON projection_rows(session_id,workspace_id,resource_kind,resource_id,sort_key,row_key);
CREATE INDEX projection_rows_filter ON projection_rows(session_id,workspace_id,resource_kind,resource_id,status,rule_code,sort_key,row_key);
