-- Staged index identity is private; only a retained resource pointer authorizes public access.
ALTER TABLE projection_sets ADD COLUMN owner_ref compact_object NOT NULL DEFAULT '{}';
ALTER TABLE projection_sets ADD COLUMN manifest_ref compact_object;
CREATE INDEX projection_rows_ordinal_page ON projection_rows(session_id,workspace_id,resource_kind,resource_id,sort_key COLLATE "C",row_key COLLATE "C");
CREATE TABLE projection_values (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, id uuid NOT NULL, resource_kind text NOT NULL, resource_id uuid NOT NULL,
  row_key text NOT NULL CHECK(length(row_key) BETWEEN 1 AND 500), byte_length bigint NOT NULL CHECK(byte_length>0),
  sha256 sha256_hex NOT NULL, media_type text NOT NULL CHECK(media_type IN ('application/json','text/plain; charset=utf-8')),
  part_count integer NOT NULL CHECK(part_count>0), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,workspace_id,id),
  FOREIGN KEY(session_id,workspace_id,resource_kind,resource_id) REFERENCES projection_sets(session_id,workspace_id,resource_kind,resource_id)
);
CREATE INDEX projection_values_index ON projection_values(session_id,workspace_id,resource_kind,resource_id,row_key);
CREATE TABLE projection_value_parts (
  session_id uuid NOT NULL, workspace_id uuid NOT NULL, value_id uuid NOT NULL, part_index integer NOT NULL CHECK(part_index>=0),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 196608), sha256 sha256_hex NOT NULL, canonical_ref compact_object NOT NULL,
  PRIMARY KEY(session_id,workspace_id,value_id,part_index),
  FOREIGN KEY(session_id,workspace_id,value_id) REFERENCES projection_values(session_id,workspace_id,id)
);
