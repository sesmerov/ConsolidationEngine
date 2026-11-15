-- Bounded mutable decision authority. Reports and validation evidence remain immutable object manifests.
CREATE TABLE review_choice_rows (
 session_id uuid NOT NULL,workspace_id uuid NOT NULL,review_id uuid NOT NULL,row_id text NOT NULL,instance_id text,
 ordinal integer NOT NULL CHECK(ordinal>=0),classification text NOT NULL,options jsonb NOT NULL CHECK(jsonb_typeof(options)='array' AND jsonb_array_length(options)<=2),
 choice text NOT NULL CHECK(length(choice)=1),baseline_token text NOT NULL,current_token text NOT NULL,saved_origin text,
 selected_group text,state text NOT NULL,last_mutation uuid,
 PRIMARY KEY(session_id,workspace_id,review_id,row_id),UNIQUE(session_id,workspace_id,review_id,instance_id),UNIQUE(session_id,workspace_id,review_id,ordinal),
 FOREIGN KEY(session_id,workspace_id,review_id) REFERENCES direction_reviews(session_id,workspace_id,id)
);
CREATE INDEX review_choice_members ON review_choice_rows(session_id,workspace_id,review_id,selected_group);
CREATE TABLE review_choice_groups (
 session_id uuid NOT NULL,workspace_id uuid NOT NULL,review_id uuid NOT NULL,group_id text NOT NULL,ordinal integer NOT NULL,
 observed boolean NOT NULL,omitted boolean NOT NULL DEFAULT false,active_count integer NOT NULL DEFAULT 0,
 PRIMARY KEY(session_id,workspace_id,review_id,group_id),UNIQUE(session_id,workspace_id,review_id,ordinal),
 FOREIGN KEY(session_id,workspace_id,review_id) REFERENCES direction_reviews(session_id,workspace_id,id)
);
ALTER TABLE direction_reviews ADD COLUMN baseline_header_dirty boolean NOT NULL DEFAULT false;
ALTER TABLE projection_rows ADD COLUMN overlay compact_object;
