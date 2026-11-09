-- Durable proof computation/storage only. No game or financial authority is added.
-- Applied migrations 006/007/008 and existing chess profiles remain unchanged.
CREATE TABLE chess_proof_work (
  id uuid PRIMARY KEY,
  root_key text NOT NULL CHECK (length(root_key) BETWEEN 1 AND 256),
  kernel_engine text NOT NULL CHECK (length(kernel_engine) BETWEEN 1 AND 128),
  kernel_rules text NOT NULL CHECK (length(kernel_rules) BETWEEN 1 AND 128),
  format text NOT NULL CHECK (length(format) BETWEEN 1 AND 128),
  attempt_no numeric(128,0) NOT NULL CHECK (attempt_no>0),
  stage text NOT NULL DEFAULT 'searching' CHECK(stage IN ('searching','exporting','sealed','rejected')),
  next_discovery numeric(128,0) NOT NULL DEFAULT 0 CHECK(next_discovery>=0),
  witness_tip text CHECK(length(witness_tip) BETWEEN 1 AND 256),
  witness_cursor text CHECK(length(witness_cursor) BETWEEN 1 AND 256),
  witness_ready boolean NOT NULL DEFAULT false,
  proof_kind text CHECK(proof_kind IN ('reachable-mate','closed-movement-graph')),
  header_json text CHECK(length(header_json) BETWEEN 1 AND 2048),
  export_cursor text CHECK(length(export_cursor)<=256),
  chunk_count numeric(128,0) NOT NULL DEFAULT 0 CHECK(chunk_count>=0),
  byte_count numeric(128,0) NOT NULL DEFAULT 0 CHECK(byte_count>=0),
  chain_digest bytea CHECK(octet_length(chain_digest)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,root_key,kernel_engine,kernel_rules,format),
  UNIQUE(root_key,kernel_engine,kernel_rules,format,attempt_no),
  CHECK((witness_tip IS NULL AND witness_cursor IS NULL AND NOT witness_ready) OR (witness_tip IS NOT NULL AND witness_cursor IS NOT NULL)),
  CHECK ((stage='searching' AND proof_kind IS NULL AND header_json IS NULL AND export_cursor IS NULL AND chain_digest IS NULL AND chunk_count=0 AND byte_count=0)
    OR (stage<>'searching' AND proof_kind IS NOT NULL AND header_json IS NOT NULL AND export_cursor IS NOT NULL AND chain_digest IS NOT NULL))
);
CREATE UNIQUE INDEX chess_proof_one_active_attempt ON chess_proof_work(root_key,kernel_engine,kernel_rules,format) WHERE stage<>'rejected';

CREATE TABLE chess_proof_search_nodes (
  work_id uuid NOT NULL REFERENCES chess_proof_work(id),
  key text NOT NULL CHECK(length(key) BETWEEN 1 AND 256),
  fen text NOT NULL CHECK(length(fen) BETWEEN 1 AND 256),
  parent_key text,
  parent_move text CHECK(parent_move ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  discovery_seq numeric(128,0) NOT NULL DEFAULT 0 CHECK(discovery_seq>=0),
  classification text NOT NULL DEFAULT 'pending' CHECK(classification IN ('pending','branch','mate','stalemate','material','locked','king-corridor','temporal')),
  expanded boolean NOT NULL DEFAULT false,
  witness_next text,
  PRIMARY KEY(work_id,key),
  UNIQUE(work_id,discovery_seq),
  FOREIGN KEY(work_id,parent_key) REFERENCES chess_proof_search_nodes(work_id,key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(work_id,witness_next) REFERENCES chess_proof_search_nodes(work_id,key),
  CHECK((parent_key IS NULL)=(parent_move IS NULL)),
  CHECK(expanded=(classification<>'pending'))
);
CREATE INDEX chess_proof_search_fifo ON chess_proof_search_nodes(work_id,discovery_seq) WHERE NOT expanded;
ALTER TABLE chess_proof_work ADD FOREIGN KEY(id,witness_tip) REFERENCES chess_proof_search_nodes(work_id,key) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE chess_proof_work ADD FOREIGN KEY(id,witness_cursor) REFERENCES chess_proof_search_nodes(work_id,key) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE chess_proof_search_edges (
  work_id uuid NOT NULL,
  from_key text NOT NULL,
  to_key text NOT NULL,
  PRIMARY KEY(work_id,from_key,to_key),
  FOREIGN KEY(work_id,from_key) REFERENCES chess_proof_search_nodes(work_id,key),
  FOREIGN KEY(work_id,to_key) REFERENCES chess_proof_search_nodes(work_id,key)
);

CREATE TABLE chess_proof_chunks (
  work_id uuid NOT NULL REFERENCES chess_proof_work(id),
  ordinal numeric(128,0) NOT NULL CHECK(ordinal>=0),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 1048576),
  digest bytea NOT NULL CHECK(octet_length(digest)=32 AND digest=sha256(payload)),
  previous_chain bytea NOT NULL CHECK(octet_length(previous_chain)=32),
  chain_digest bytea NOT NULL CHECK(octet_length(chain_digest)=32),
  PRIMARY KEY(work_id,ordinal),
  CHECK(chain_digest=sha256(previous_chain || convert_to(ordinal::text || ':' || octet_length(payload)::text || ':','UTF8') || digest))
);

CREATE TABLE chess_proof_check_runs (
  id uuid PRIMARY KEY,
  work_id uuid NOT NULL,
  root_key text NOT NULL,
  kernel_engine text NOT NULL,
  kernel_rules text NOT NULL,
  format text NOT NULL,
  proof_kind text NOT NULL CHECK(proof_kind IN ('reachable-mate','closed-movement-graph')),
  stage text NOT NULL DEFAULT 'registering' CHECK(stage IN ('registering','checking','complete','failed')),
  cursor_chunk numeric(128,0) NOT NULL DEFAULT 0 CHECK(cursor_chunk>=0),
  cursor_offset integer NOT NULL DEFAULT 0 CHECK(cursor_offset BETWEEN 0 AND 1048576),
  registered_count numeric(128,0) NOT NULL DEFAULT 0 CHECK(registered_count>=0),
  next_queue numeric(128,0) NOT NULL DEFAULT 0 CHECK(next_queue>=0),
  queued_count numeric(128,0) NOT NULL DEFAULT 0 CHECK(queued_count>=0),
  claimed_count numeric(128,0) NOT NULL DEFAULT 0 CHECK(claimed_count>=0),
  checked_count numeric(128,0) NOT NULL DEFAULT 0 CHECK(checked_count>=0),
  records numeric(128,0) CHECK(records>=0),
  nodes numeric(128,0) CHECK(nodes>=0),
  edges numeric(128,0) CHECK(edges>=0),
  moves numeric(128,0) CHECK(moves>=0),
  verdict text CHECK(verdict IN ('dead','not-dead')),
  failure_kind text CHECK(failure_kind IN ('invalid-proof','resource','cancelled','storage')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,work_id),
  FOREIGN KEY(work_id,root_key,kernel_engine,kernel_rules,format) REFERENCES chess_proof_work(id,root_key,kernel_engine,kernel_rules,format),
  CHECK(checked_count<=claimed_count AND claimed_count<=registered_count AND queued_count<=registered_count),
  CHECK((stage='complete')=(verdict IS NOT NULL AND records IS NOT NULL AND nodes IS NOT NULL AND edges IS NOT NULL AND moves IS NOT NULL)),
  CHECK((stage='failed')=(failure_kind IS NOT NULL))
);
CREATE TABLE chess_proof_check_nodes (
  run_id uuid NOT NULL,
  work_id uuid NOT NULL,
  key text NOT NULL CHECK(length(key) BETWEEN 1 AND 256),
  registration_id uuid NOT NULL,
  chunk_ordinal numeric(128,0) NOT NULL,
  record_offset integer NOT NULL CHECK(record_offset BETWEEN 0 AND 1048575),
  record_bytes integer NOT NULL CHECK(record_bytes BETWEEN 1 AND 1048576),
  record_digest bytea NOT NULL CHECK(octet_length(record_digest)=32),
  mark text NOT NULL DEFAULT 'unseen' CHECK(mark IN ('unseen','claimed','checked')),
  queued boolean NOT NULL DEFAULT false,
  queue_seq numeric(128,0),
  PRIMARY KEY(run_id,key),
  UNIQUE(run_id,registration_id),
  FOREIGN KEY(run_id,work_id) REFERENCES chess_proof_check_runs(id,work_id),
  FOREIGN KEY(work_id,chunk_ordinal) REFERENCES chess_proof_chunks(work_id,ordinal),
  CHECK(NOT queued OR (mark='unseen' AND queue_seq IS NOT NULL))
);
CREATE INDEX chess_proof_check_fifo ON chess_proof_check_nodes(run_id,queue_seq) WHERE queued;

CREATE TABLE chess_proof_artifacts (
  manifest_digest bytea PRIMARY KEY CHECK(octet_length(manifest_digest)=32),
  manifest bytea NOT NULL CHECK(octet_length(manifest) BETWEEN 1 AND 16384 AND manifest_digest=sha256(manifest)),
  work_id uuid NOT NULL UNIQUE,
  check_run_id uuid NOT NULL UNIQUE,
  root_key text NOT NULL,
  kernel_engine text NOT NULL,
  kernel_rules text NOT NULL,
  format text NOT NULL,
  proof_kind text NOT NULL CHECK(proof_kind IN ('reachable-mate','closed-movement-graph')),
  verdict text NOT NULL CHECK(verdict IN ('dead','not-dead')),
  chain_digest bytea NOT NULL CHECK(octet_length(chain_digest)=32),
  chunk_count numeric(128,0) NOT NULL CHECK(chunk_count>=0),
  byte_count numeric(128,0) NOT NULL CHECK(byte_count>=0),
  records numeric(128,0) NOT NULL CHECK(records>=0),
  nodes numeric(128,0) NOT NULL CHECK(nodes>=0),
  edges numeric(128,0) NOT NULL CHECK(edges>=0),
  moves numeric(128,0) NOT NULL CHECK(moves>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(work_id,root_key,kernel_engine,kernel_rules,format) REFERENCES chess_proof_work(id,root_key,kernel_engine,kernel_rules,format),
  FOREIGN KEY(check_run_id,work_id) REFERENCES chess_proof_check_runs(id,work_id),
  UNIQUE(manifest_digest,root_key,kernel_engine,kernel_rules,format),
  CHECK((proof_kind='reachable-mate' AND verdict='not-dead' AND nodes=0 AND edges=moves AND records=moves)
    OR (proof_kind='closed-movement-graph' AND verdict='dead' AND nodes>0 AND moves=0 AND records=nodes))
);
CREATE TABLE match_chess_proof_refs (
  table_id uuid NOT NULL,
  game_revision integer NOT NULL CHECK(game_revision>0),
  decision_revision integer NOT NULL CHECK(decision_revision>=0),
  artifact_id bytea NOT NULL,
  root_key text NOT NULL,
  kernel_engine text NOT NULL,
  kernel_rules text NOT NULL,
  format text NOT NULL,
  PRIMARY KEY(table_id,decision_revision),
  FOREIGN KEY(table_id,game_revision) REFERENCES match_events(table_id,revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(artifact_id,root_key,kernel_engine,kernel_rules,format) REFERENCES chess_proof_artifacts(manifest_digest,root_key,kernel_engine,kernel_rules,format)
);

-- DML grants alone cannot bypass immutable proof payloads or their bindings.
CREATE TRIGGER chess_proof_chunk_immutable BEFORE UPDATE OR DELETE ON chess_proof_chunks FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER chess_proof_edge_immutable BEFORE UPDATE OR DELETE ON chess_proof_search_edges FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER chess_proof_artifact_immutable BEFORE UPDATE OR DELETE ON chess_proof_artifacts FOR EACH ROW EXECUTE FUNCTION credit_immutable();
CREATE TRIGGER match_chess_proof_ref_immutable BEFORE UPDATE OR DELETE ON match_chess_proof_refs FOR EACH ROW EXECUTE FUNCTION credit_immutable();

CREATE FUNCTION chess_proof_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h jsonb; parent text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Proof attempts are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.stage<>'searching' OR NEW.next_discovery<>0 OR NEW.witness_tip IS NOT NULL OR NEW.witness_cursor IS NOT NULL OR NEW.witness_ready OR NEW.proof_kind IS NOT NULL OR NEW.header_json IS NOT NULL OR NEW.export_cursor IS NOT NULL OR NEW.chain_digest IS NOT NULL OR NEW.chunk_count<>0 OR NEW.byte_count<>0 THEN
      RAISE EXCEPTION 'Proof attempts begin with an empty searching frontier' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.root_key,NEW.kernel_engine,NEW.kernel_rules,NEW.format,NEW.attempt_no,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.root_key,OLD.kernel_engine,OLD.kernel_rules,OLD.format,OLD.attempt_no,OLD.created_at) THEN
    RAISE EXCEPTION 'Proof question binding is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.stage='rejected' OR (OLD.stage='sealed' AND NEW.stage<>'rejected')
    OR (NEW.stage<>OLD.stage AND NOT ((OLD.stage='searching' AND NEW.stage='exporting') OR (OLD.stage='exporting' AND NEW.stage='sealed') OR (OLD.stage='sealed' AND NEW.stage='rejected'))) THEN
    RAISE EXCEPTION 'Proof stage cannot be reopened' USING ERRCODE='23514';
  END IF;
  IF (NEW.witness_tip,NEW.witness_cursor,NEW.witness_ready) IS DISTINCT FROM (OLD.witness_tip,OLD.witness_cursor,OLD.witness_ready) THEN
    IF OLD.stage<>'searching' OR NEW.stage<>'searching' OR OLD.witness_ready THEN RAISE EXCEPTION 'Witness ancestry is frozen' USING ERRCODE='23514'; END IF;
    IF OLD.witness_tip IS NULL THEN
      IF NEW.witness_cursor IS DISTINCT FROM NEW.witness_tip OR NEW.witness_ready IS DISTINCT FROM (NEW.witness_tip=NEW.root_key)
        OR NOT EXISTS(SELECT 1 FROM chess_proof_search_nodes WHERE work_id=NEW.id AND key=NEW.witness_tip AND classification='mate') THEN
        RAISE EXCEPTION 'Witness ancestry begins at a discovered mate' USING ERRCODE='23514';
      END IF;
    ELSE
      SELECT parent_key INTO parent FROM chess_proof_search_nodes WHERE work_id=NEW.id AND key=OLD.witness_cursor;
      IF NEW.witness_tip IS DISTINCT FROM OLD.witness_tip OR parent IS NULL OR NEW.witness_cursor IS DISTINCT FROM parent OR NEW.witness_ready IS DISTINCT FROM (parent=NEW.root_key)
        OR NOT EXISTS(SELECT 1 FROM chess_proof_search_nodes WHERE work_id=NEW.id AND key=parent AND witness_next=OLD.witness_cursor) THEN
        RAISE EXCEPTION 'Witness cursor must follow the fixed first-parent chain' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  IF NEW.stage='rejected' AND (EXISTS(SELECT 1 FROM chess_proof_artifacts WHERE work_id=OLD.id)
    OR NOT EXISTS(SELECT 1 FROM chess_proof_check_runs WHERE work_id=OLD.id AND stage='failed' AND failure_kind='invalid-proof')) THEN
    RAISE EXCEPTION 'Only independently invalid unpublished transport may be rejected' USING ERRCODE='23514';
  END IF;
  IF OLD.stage<>'searching' AND NEW.next_discovery<>OLD.next_discovery THEN
    RAISE EXCEPTION 'Exported search graph is frozen' USING ERRCODE='23514';
  END IF;
  IF NEW.next_discovery<>OLD.next_discovery AND (pg_trigger_depth()<2 OR NEW.next_discovery<>OLD.next_discovery+1) THEN
    RAISE EXCEPTION 'Discovery counters belong to inserted nodes' USING ERRCODE='23514';
  END IF;
  IF OLD.stage<>'searching' AND (NEW.proof_kind,NEW.header_json) IS DISTINCT FROM (OLD.proof_kind,OLD.header_json) THEN
    RAISE EXCEPTION 'Export header is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.stage='searching' AND NEW.stage='exporting' THEN
    IF NEW.witness_tip IS NOT NULL AND (NOT NEW.witness_ready OR NEW.proof_kind<>'reachable-mate') THEN RAISE EXCEPTION 'Witness ancestry must finish before export' USING ERRCODE='23514'; END IF;
    h:=NEW.header_json::jsonb;
    IF jsonb_typeof(h) IS DISTINCT FROM 'object' OR h->>'root' IS DISTINCT FROM NEW.root_key OR h->>'engineVersion' IS DISTINCT FROM NEW.kernel_engine OR h->>'rulesVersion' IS DISTINCT FROM NEW.kernel_rules OR h->>'format' IS DISTINCT FROM NEW.format OR h->>'kind' IS DISTINCT FROM NEW.proof_kind THEN
      RAISE EXCEPTION 'Export header must bind its exact proof question' USING ERRCODE='23514';
    END IF;
    IF NEW.chain_digest<>sha256(convert_to('skillbetting.chess.stream-chain.v1:' || NEW.header_json,'UTF8'))
      OR NEW.chunk_count<>0 OR NEW.byte_count<>0 THEN
      RAISE EXCEPTION 'Invalid initial chunk chain' USING ERRCODE='23514';
    END IF;
  ELSIF (NEW.chunk_count,NEW.byte_count,NEW.chain_digest) IS DISTINCT FROM (OLD.chunk_count,OLD.byte_count,OLD.chain_digest)
    AND (OLD.stage<>'exporting' OR NEW.stage<>'exporting' OR pg_trigger_depth()<2 OR NEW.chunk_count<>OLD.chunk_count+1 OR NEW.byte_count<=OLD.byte_count) THEN
    RAISE EXCEPTION 'Chunk counters belong to immutable chunk appends' USING ERRCODE='23514';
  END IF;
  IF OLD.stage IN ('sealed','rejected') AND NEW.export_cursor IS DISTINCT FROM OLD.export_cursor THEN
    RAISE EXCEPTION 'Sealed export cursor is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_work_guard BEFORE INSERT OR UPDATE OR DELETE ON chess_proof_work FOR EACH ROW EXECUTE FUNCTION chess_proof_work_guard();

CREATE FUNCTION chess_proof_search_node_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w chess_proof_work%ROWTYPE; existing_seq numeric(128,0); parent_seq numeric(128,0);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Search nodes are retained' USING ERRCODE='23514'; END IF;
  SELECT * INTO w FROM chess_proof_work WHERE id=NEW.work_id FOR UPDATE;
  IF w.stage IS DISTINCT FROM 'searching' THEN RAISE EXCEPTION 'Search graph is frozen' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.expanded OR NEW.classification<>'pending' OR NEW.witness_next IS NOT NULL THEN RAISE EXCEPTION 'New discoveries start pending' USING ERRCODE='23514'; END IF;
    SELECT discovery_seq INTO existing_seq FROM chess_proof_search_nodes WHERE work_id=NEW.work_id AND key=NEW.key;
    NEW.discovery_seq:=coalesce(existing_seq,w.next_discovery);
    IF existing_seq IS NULL THEN
      IF NEW.key=w.root_key THEN
        IF NEW.parent_key IS NOT NULL OR w.next_discovery<>0 THEN RAISE EXCEPTION 'Root must be the first parentless discovery' USING ERRCODE='23514'; END IF;
      ELSE
        SELECT discovery_seq INTO parent_seq FROM chess_proof_search_nodes WHERE work_id=NEW.work_id AND key=NEW.parent_key;
        IF parent_seq IS NULL OR parent_seq>=w.next_discovery THEN RAISE EXCEPTION 'A new node requires its earlier discovered parent' USING ERRCODE='23514'; END IF;
      END IF;
      -- Allocate here, not in an AFTER ROW trigger: AFTER events are queued
      -- until statement end, whereas a multi-row INSERT needs each next FIFO
      -- number immediately. Ignored existing-key proposals allocate nothing.
      UPDATE chess_proof_work SET next_discovery=next_discovery+1 WHERE id=NEW.work_id;
    END IF;
  ELSIF NEW.witness_next IS DISTINCT FROM OLD.witness_next THEN
    IF OLD.witness_next IS NOT NULL OR NEW.witness_next IS NULL OR w.witness_cursor IS DISTINCT FROM NEW.witness_next
      OR (NEW.work_id,NEW.key,NEW.fen,NEW.parent_key,NEW.parent_move,NEW.discovery_seq,NEW.expanded,NEW.classification)
        IS DISTINCT FROM (OLD.work_id,OLD.key,OLD.fen,OLD.parent_key,OLD.parent_move,OLD.discovery_seq,OLD.expanded,OLD.classification)
      OR NOT EXISTS(SELECT 1 FROM chess_proof_search_nodes WHERE work_id=NEW.work_id AND key=NEW.witness_next AND parent_key=NEW.key AND discovery_seq>NEW.discovery_seq) THEN
      RAISE EXCEPTION 'Witness next must follow one actual immutable child relation' USING ERRCODE='23514';
    END IF;
  ELSIF (NEW.work_id,NEW.key,NEW.fen,NEW.parent_key,NEW.parent_move,NEW.discovery_seq)
    IS DISTINCT FROM (OLD.work_id,OLD.key,OLD.fen,OLD.parent_key,OLD.parent_move,OLD.discovery_seq)
    OR OLD.expanded OR NOT NEW.expanded THEN
    RAISE EXCEPTION 'Search node binding/expansion is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_search_node_guard BEFORE INSERT OR UPDATE OR DELETE ON chess_proof_search_nodes FOR EACH ROW EXECUTE FUNCTION chess_proof_search_node_guard();
CREATE FUNCTION chess_proof_edge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stage text; done boolean;
BEGIN
  SELECT w.stage,n.expanded INTO stage,done FROM chess_proof_work w JOIN chess_proof_search_nodes n ON n.work_id=w.id AND n.key=NEW.from_key WHERE w.id=NEW.work_id FOR UPDATE OF w;
  IF stage IS DISTINCT FROM 'searching' OR done IS DISTINCT FROM false THEN RAISE EXCEPTION 'Edges belong to one atomic expansion' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_edge_guard BEFORE INSERT ON chess_proof_search_edges FOR EACH ROW EXECUTE FUNCTION chess_proof_edge_guard();

CREATE FUNCTION chess_proof_chunk_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w chess_proof_work%ROWTYPE;
BEGIN
  SELECT * INTO w FROM chess_proof_work WHERE id=NEW.work_id FOR UPDATE;
  IF w.stage IS DISTINCT FROM 'exporting' OR NEW.ordinal<>w.chunk_count OR NEW.previous_chain<>w.chain_digest THEN
    RAISE EXCEPTION 'Chunks must extend the current unsealed chain contiguously' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_chunk_guard BEFORE INSERT ON chess_proof_chunks FOR EACH ROW EXECUTE FUNCTION chess_proof_chunk_guard();
CREATE FUNCTION chess_proof_chunk_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chess_proof_work SET chunk_count=chunk_count+1,byte_count=byte_count+octet_length(NEW.payload),chain_digest=NEW.chain_digest WHERE id=NEW.work_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_chunk_added AFTER INSERT ON chess_proof_chunks FOR EACH ROW EXECUTE FUNCTION chess_proof_chunk_added();

CREATE FUNCTION chess_proof_check_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w chess_proof_work%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Check runs are retained' USING ERRCODE='23514'; END IF;
  SELECT * INTO w FROM chess_proof_work WHERE id=NEW.work_id FOR SHARE;
  IF w.stage IS DISTINCT FROM 'sealed' OR w.proof_kind<>NEW.proof_kind THEN RAISE EXCEPTION 'Checking requires immutable sealed transport' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.stage<>'registering' OR NEW.registered_count<>0 OR NEW.next_queue<>0 OR NEW.queued_count<>0 OR NEW.claimed_count<>0 OR NEW.checked_count<>0 OR NEW.cursor_chunk<>0 OR NEW.cursor_offset<>0 THEN
      RAISE EXCEPTION 'Checks start with a fresh namespace' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.id,NEW.work_id,NEW.root_key,NEW.kernel_engine,NEW.kernel_rules,NEW.format,NEW.proof_kind,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.work_id,OLD.root_key,OLD.kernel_engine,OLD.kernel_rules,OLD.format,OLD.proof_kind,OLD.created_at)
      OR OLD.stage IN ('complete','failed')
      OR (NEW.stage<>OLD.stage AND NOT ((OLD.stage='registering' AND NEW.stage IN ('checking','failed')) OR (OLD.stage='checking' AND NEW.stage IN ('complete','failed')))) THEN
      RAISE EXCEPTION 'Check binding/progress is immutable' USING ERRCODE='23514';
    END IF;
    IF (NEW.registered_count,NEW.next_queue,NEW.queued_count,NEW.claimed_count,NEW.checked_count)
      IS DISTINCT FROM (OLD.registered_count,OLD.next_queue,OLD.queued_count,OLD.claimed_count,OLD.checked_count)
      AND pg_trigger_depth()<2 THEN RAISE EXCEPTION 'Check counters belong to private workset operations' USING ERRCODE='23514'; END IF;
    IF (NEW.cursor_chunk,NEW.cursor_offset)<(OLD.cursor_chunk,OLD.cursor_offset) OR (OLD.stage<>'registering' AND (NEW.cursor_chunk,NEW.cursor_offset) IS DISTINCT FROM (OLD.cursor_chunk,OLD.cursor_offset)) THEN
      RAISE EXCEPTION 'Registration cursor cannot rewind' USING ERRCODE='23514';
    END IF;
    IF NEW.stage='complete' AND (NEW.queued_count<>0 OR NEW.claimed_count<>NEW.checked_count
      OR (NEW.proof_kind='closed-movement-graph' AND (NEW.registered_count<>NEW.nodes OR NEW.checked_count<>NEW.nodes OR NEW.records<>NEW.nodes OR NEW.nodes<1 OR NEW.moves<>0 OR NEW.verdict<>'dead'))
      OR (NEW.proof_kind='reachable-mate' AND (NEW.registered_count<>0 OR NEW.nodes<>0 OR NEW.edges<>NEW.moves OR NEW.records<>NEW.moves OR NEW.verdict<>'not-dead'))) THEN
      RAISE EXCEPTION 'Completed check bookkeeping is inconsistent' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_check_run_guard BEFORE INSERT OR UPDATE OR DELETE ON chess_proof_check_runs FOR EACH ROW EXECUTE FUNCTION chess_proof_check_run_guard();

CREATE FUNCTION chess_proof_check_node_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r chess_proof_check_runs%ROWTYPE; chunk bytea;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Check membership is retained' USING ERRCODE='23514'; END IF;
  SELECT * INTO r FROM chess_proof_check_runs WHERE id=NEW.run_id AND work_id=NEW.work_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF r.stage IS DISTINCT FROM 'registering' OR NEW.mark<>'unseen' OR NEW.queued OR NEW.queue_seq IS NOT NULL THEN
      RAISE EXCEPTION 'Membership registration requires a fresh checking namespace' USING ERRCODE='23514';
    END IF;
    SELECT payload INTO chunk FROM chess_proof_chunks WHERE work_id=NEW.work_id AND ordinal=NEW.chunk_ordinal;
    IF chunk IS NULL OR NEW.record_offset+NEW.record_bytes>octet_length(chunk)
      OR sha256(substring(chunk FROM NEW.record_offset+1 FOR NEW.record_bytes))<>NEW.record_digest THEN
      RAISE EXCEPTION 'Check membership must locate exact sealed bytes' USING ERRCODE='23514';
    END IF;
  ELSE
    IF r.stage IS DISTINCT FROM 'checking' OR (NEW.run_id,NEW.work_id,NEW.key,NEW.registration_id,NEW.chunk_ordinal,NEW.record_offset,NEW.record_bytes,NEW.record_digest)
      IS DISTINCT FROM (OLD.run_id,OLD.work_id,OLD.key,OLD.registration_id,OLD.chunk_ordinal,OLD.record_offset,OLD.record_bytes,OLD.record_digest)
      OR (NEW.mark<>OLD.mark AND NOT ((OLD.mark='unseen' AND NEW.mark='claimed') OR (OLD.mark='claimed' AND NEW.mark='checked')))
      OR (NEW.mark=OLD.mark AND NEW.queued=OLD.queued) THEN
      RAISE EXCEPTION 'Check membership/marks cannot be rewritten' USING ERRCODE='23514';
    END IF;
    IF NEW.queued AND NOT OLD.queued THEN NEW.queue_seq:=r.next_queue;
    ELSIF NEW.queue_seq IS DISTINCT FROM OLD.queue_seq THEN RAISE EXCEPTION 'Queue sequence is private' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_check_node_guard BEFORE INSERT OR UPDATE OR DELETE ON chess_proof_check_nodes FOR EACH ROW EXECUTE FUNCTION chess_proof_check_node_guard();
CREATE FUNCTION chess_proof_check_node_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN UPDATE chess_proof_check_runs SET registered_count=registered_count+1 WHERE id=NEW.run_id;
  ELSE UPDATE chess_proof_check_runs SET
    queued_count=queued_count+(CASE WHEN NEW.queued THEN 1 ELSE 0 END)-(CASE WHEN OLD.queued THEN 1 ELSE 0 END),
    next_queue=next_queue+(CASE WHEN NEW.queued AND NOT OLD.queued THEN 1 ELSE 0 END),
    claimed_count=claimed_count+(CASE WHEN NEW.mark='claimed' AND OLD.mark='unseen' THEN 1 ELSE 0 END),
    checked_count=checked_count+(CASE WHEN NEW.mark='checked' AND OLD.mark='claimed' THEN 1 ELSE 0 END)
    WHERE id=NEW.run_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_check_node_changed AFTER INSERT OR UPDATE ON chess_proof_check_nodes FOR EACH ROW EXECUTE FUNCTION chess_proof_check_node_changed();

CREATE FUNCTION chess_proof_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w chess_proof_work%ROWTYPE; r chess_proof_check_runs%ROWTYPE; m jsonb;
BEGIN
  SELECT * INTO w FROM chess_proof_work WHERE id=NEW.work_id FOR UPDATE;
  SELECT * INTO r FROM chess_proof_check_runs WHERE id=NEW.check_run_id AND work_id=NEW.work_id FOR SHARE;
  IF w.stage IS DISTINCT FROM 'sealed' OR r.stage IS DISTINCT FROM 'complete'
    OR (NEW.proof_kind,NEW.verdict,NEW.records,NEW.nodes,NEW.edges,NEW.moves) IS DISTINCT FROM (r.proof_kind,r.verdict,r.records,r.nodes,r.edges,r.moves)
    OR (NEW.chain_digest,NEW.chunk_count,NEW.byte_count) IS DISTINCT FROM (w.chain_digest,w.chunk_count,w.byte_count) THEN
    RAISE EXCEPTION 'Publication requires its exact completed independent check' USING ERRCODE='23514';
  END IF;
  m:=convert_from(NEW.manifest,'UTF8')::jsonb;
  IF m->>'format' IS DISTINCT FROM 'skillbetting.chess.proof-artifact.v1'
    OR m->>'root' IS DISTINCT FROM NEW.root_key OR m->>'kernelEngineVersion' IS DISTINCT FROM NEW.kernel_engine OR m->>'kernelRulesVersion' IS DISTINCT FROM NEW.kernel_rules
    OR m->>'streamFormat' IS DISTINCT FROM NEW.format OR m->>'kind' IS DISTINCT FROM NEW.proof_kind OR m->>'verdict' IS DISTINCT FROM NEW.verdict
    OR m->>'headerSha256' IS DISTINCT FROM encode(sha256(convert_to(w.header_json,'UTF8')),'hex') OR m->>'chunkChainSha256' IS DISTINCT FROM encode(NEW.chain_digest,'hex')
    OR m->>'chunks' IS DISTINCT FROM NEW.chunk_count::text OR m->>'bytes' IS DISTINCT FROM NEW.byte_count::text
    OR m->>'records' IS DISTINCT FROM NEW.records::text OR m->>'nodes' IS DISTINCT FROM NEW.nodes::text OR m->>'edges' IS DISTINCT FROM NEW.edges::text OR m->>'moves' IS DISTINCT FROM NEW.moves::text THEN
    RAISE EXCEPTION 'Artifact digest manifest does not bind its complete checked transport' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_proof_artifact_guard BEFORE INSERT ON chess_proof_artifacts FOR EACH ROW EXECUTE FUNCTION chess_proof_artifact_guard();

-- The new artifact profile is a separate version. Existing inline snapshots are
-- untouched. A board receipt is linked in the SAME state/event transaction;
-- no generic application hook or client-supplied verified flag is needed.
CREATE FUNCTION chess_link_artifact_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_count integer:=0; new_count integer; old_rev integer:=0; old_ply integer:=0;
  new_rev integer; new_ply integer; prefix jsonb; receipt jsonb; fields integer;
BEGIN
  IF NEW.engine_version<>'0.4.0-strict.2' THEN RETURN NEW; END IF;
  IF NEW.rules_version<>'skillbetting.chess.fide-2023.strict-proof-artifacts.v1'
    OR NEW.state->>'engineVersion' IS DISTINCT FROM '0.4.0-strict.2' OR NEW.state->>'schemaVersion' IS DISTINCT FROM '3'
    OR NEW.state->>'rulesVersion' IS DISTINCT FROM NEW.rules_version OR NEW.state->>'game' IS DISTINCT FROM 'chess'
    OR NEW.state#>>'{initial,mode}' IS DISTINCT FROM 'standard'
    OR jsonb_typeof(NEW.state->'decisions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.state->'history') IS DISTINCT FROM 'array'
    OR coalesce(NEW.state->>'revision','') !~ '^(0|[1-9][0-9]*)$'
    OR coalesce(NEW.state->>'ply','') !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'Artifact profile requires its exact versioned state contract' USING ERRCODE='23514';
  END IF;
  new_rev:=(NEW.state->>'revision')::integer; new_ply:=(NEW.state->>'ply')::integer;
  new_count:=jsonb_array_length(NEW.state->'decisions');
  IF jsonb_array_length(NEW.state->'history')<>new_rev THEN RAISE EXCEPTION 'Engine history revision does not reconcile' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    old_count:=jsonb_array_length(OLD.state->'decisions');
    old_rev:=(OLD.state->>'revision')::integer; old_ply:=(OLD.state->>'ply')::integer;
    SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO prefix
      FROM jsonb_array_elements(NEW.state->'decisions') WITH ORDINALITY e(value,ordinality) WHERE ordinality<=old_count;
    IF prefix IS DISTINCT FROM OLD.state->'decisions' OR new_count NOT IN (old_count,old_count+1)
      OR new_rev NOT IN (old_rev,old_rev+1) OR new_ply NOT IN (old_ply,old_ply+1)
      OR ((new_ply=old_ply+1) IS DISTINCT FROM (new_count=old_count+1))
      OR (new_count=old_count+1 AND new_rev<>old_rev+1) THEN
      RAISE EXCEPTION 'Artifact decision history is append-only and board-bound' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.revision<>1 OR new_rev<>0 OR new_ply<>0 OR new_count<>1 THEN
    RAISE EXCEPTION 'A new artifact game requires its initial decision' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' OR new_count=old_count+1 THEN
    receipt:=NEW.state->'decisions'->(new_count-1);
    SELECT count(*) INTO fields FROM jsonb_object_keys(receipt);
    IF fields<>6 OR jsonb_typeof(receipt->'revision') IS DISTINCT FROM 'number'
      OR receipt->>'revision'<>new_rev::text OR coalesce(receipt->>'artifactId','') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(receipt->'root') IS DISTINCT FROM 'string' OR jsonb_typeof(receipt->'kernelEngineVersion') IS DISTINCT FROM 'string'
      OR jsonb_typeof(receipt->'kernelRulesVersion') IS DISTINCT FROM 'string' OR jsonb_typeof(receipt->'format') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Malformed artifact decision reference' USING ERRCODE='23514';
    END IF;
    INSERT INTO match_chess_proof_refs(table_id,game_revision,decision_revision,artifact_id,root_key,kernel_engine,kernel_rules,format)
      VALUES(NEW.table_id,NEW.revision,new_rev,decode(receipt->>'artifactId','hex'),receipt->>'root',receipt->>'kernelEngineVersion',receipt->>'kernelRulesVersion',receipt->>'format');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chess_link_artifact_decision AFTER INSERT OR UPDATE ON table_games FOR EACH ROW EXECUTE FUNCTION chess_link_artifact_decision();

CREATE FUNCTION chess_artifact_refs_reconciled() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid; g table_games%ROWTYPE; expected integer;
BEGIN
  tid:=NEW.table_id;
  SELECT * INTO g FROM table_games WHERE table_id=tid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF g.engine_version<>'0.4.0-strict.2' THEN
    IF EXISTS(SELECT 1 FROM match_chess_proof_refs WHERE table_id=tid) THEN RAISE EXCEPTION 'Artifact refs require the separate artifact profile' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  expected:=jsonb_array_length(g.state->'decisions');
  IF (SELECT count(*) FROM match_chess_proof_refs WHERE table_id=tid)<>expected
    OR expected<>1+(SELECT count(*) FROM jsonb_array_elements(g.state->'history') h WHERE h#>>'{action,type}'='move')
    OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(g.state->'decisions') d
      LEFT JOIN match_chess_proof_refs r ON r.table_id=tid AND r.decision_revision=(d->>'revision')::integer
      LEFT JOIN match_events e ON e.table_id=r.table_id AND e.revision=r.game_revision
      WHERE r.table_id IS NULL OR r.artifact_id<>decode(d->>'artifactId','hex') OR r.root_key<>d->>'root'
        OR r.kernel_engine<>d->>'kernelEngineVersion' OR r.kernel_rules<>d->>'kernelRulesVersion' OR r.format<>d->>'format'
        OR r.game_revision<>r.decision_revision+1
        OR (r.decision_revision=0 AND e.kind IS DISTINCT FROM 'start')
        OR (r.decision_revision>0 AND (e.kind IS DISTINCT FROM 'action' OR e.payload#>>'{action,type}' IS DISTINCT FROM 'move'
          OR e.payload->'action' IS DISTINCT FROM g.state->'history'->(r.decision_revision-1)->'action'
          OR e.actor_user_id::text IS DISTINCT FROM g.state->'history'->(r.decision_revision-1)->>'playerId'))
    ) THEN RAISE EXCEPTION 'Artifact receipt/event history does not reconcile' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER chess_game_artifact_refs_reconciled AFTER INSERT OR UPDATE ON table_games DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chess_artifact_refs_reconciled();
CREATE CONSTRAINT TRIGGER chess_match_artifact_refs_reconciled AFTER INSERT ON match_chess_proof_refs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chess_artifact_refs_reconciled();

-- Restore-time TRANSPORT audit, never a chess verdict. Each chunk is checked
-- separately (at most 1 MiB); no graph or vector of chunk hashes is assembled.
-- Cold application replay must still run the independent mathematical checker.
CREATE FUNCTION chess_proof_integrity_errors() RETURNS TABLE(kind text, identity text) LANGUAGE plpgsql STABLE AS $$
DECLARE w chess_proof_work%ROWTYPE; c chess_proof_chunks%ROWTYPE;
  a chess_proof_artifacts%ROWTYPE; r chess_proof_check_runs%ROWTYPE;
  g table_games%ROWTYPE; h jsonb; m jsonb; d jsonb; ref match_chess_proof_refs%ROWTYPE;
  ordinal numeric(128,0); bytes numeric(128,0); chain bytea; bad boolean; n numeric(128,0);
BEGIN
  FOR w IN SELECT * FROM chess_proof_work LOOP
    IF w.stage='searching' THEN
      IF EXISTS(SELECT 1 FROM chess_proof_chunks WHERE work_id=w.id) THEN
        kind:='searching-chunks'; identity:=w.id::text; RETURN NEXT;
      END IF;
    ELSE
      bad:=false;
      BEGIN
        h:=w.header_json::jsonb;
        bad:=jsonb_typeof(h) IS DISTINCT FROM 'object' OR h->>'root' IS DISTINCT FROM w.root_key
          OR h->>'engineVersion' IS DISTINCT FROM w.kernel_engine OR h->>'rulesVersion' IS DISTINCT FROM w.kernel_rules
          OR h->>'format' IS DISTINCT FROM w.format OR h->>'kind' IS DISTINCT FROM w.proof_kind;
      EXCEPTION WHEN OTHERS THEN bad:=true; END;
      IF bad THEN kind:='work-header'; identity:=w.id::text; RETURN NEXT; END IF;
      ordinal:=0; bytes:=0; chain:=sha256(convert_to('skillbetting.chess.stream-chain.v1:' || w.header_json,'UTF8'));
      FOR c IN SELECT * FROM chess_proof_chunks WHERE work_id=w.id ORDER BY chess_proof_chunks.ordinal LOOP
        IF c.ordinal<>ordinal OR c.previous_chain<>chain OR c.digest<>sha256(c.payload)
          OR octet_length(c.payload) NOT BETWEEN 1 AND 1048576
          OR c.chain_digest<>sha256(chain || convert_to(ordinal::text || ':' || octet_length(c.payload)::text || ':','UTF8') || sha256(c.payload)) THEN
          kind:='chunk-chain'; identity:=w.id::text || ':' || c.ordinal::text; RETURN NEXT;
        END IF;
        chain:=c.chain_digest; ordinal:=ordinal+1; bytes:=bytes+octet_length(c.payload);
      END LOOP;
      IF (ordinal,bytes,chain) IS DISTINCT FROM (w.chunk_count,w.byte_count,w.chain_digest) THEN
        kind:='work-transport-counts'; identity:=w.id::text; RETURN NEXT;
      END IF;
    END IF;
    SELECT count(*) INTO n FROM chess_proof_search_nodes WHERE work_id=w.id;
    IF n<>w.next_discovery OR NOT EXISTS(SELECT 1 FROM chess_proof_search_nodes WHERE work_id=w.id AND key=w.root_key AND parent_key IS NULL AND discovery_seq=0)
      OR EXISTS(SELECT 1 FROM chess_proof_search_nodes child LEFT JOIN chess_proof_search_nodes parent ON parent.work_id=child.work_id AND parent.key=child.parent_key
        WHERE child.work_id=w.id AND child.key<>w.root_key AND (parent.key IS NULL OR parent.discovery_seq>=child.discovery_seq)) THEN
      kind:='search-discovery'; identity:=w.id::text; RETURN NEXT;
    END IF;
  END LOOP;
  FOR a IN SELECT * FROM chess_proof_artifacts LOOP
    SELECT * INTO w FROM chess_proof_work WHERE id=a.work_id;
    SELECT * INTO r FROM chess_proof_check_runs WHERE id=a.check_run_id;
    bad:=w.id IS NULL OR r.id IS NULL OR w.stage IS DISTINCT FROM 'sealed' OR r.stage IS DISTINCT FROM 'complete'
      OR a.manifest_digest<>sha256(a.manifest)
      OR (a.root_key,a.kernel_engine,a.kernel_rules,a.format,a.proof_kind,a.chain_digest,a.chunk_count,a.byte_count)
        IS DISTINCT FROM (w.root_key,w.kernel_engine,w.kernel_rules,w.format,w.proof_kind,w.chain_digest,w.chunk_count,w.byte_count)
      OR (a.work_id,a.root_key,a.kernel_engine,a.kernel_rules,a.format,a.proof_kind,a.verdict,a.records,a.nodes,a.edges,a.moves)
        IS DISTINCT FROM (r.work_id,r.root_key,r.kernel_engine,r.kernel_rules,r.format,r.proof_kind,r.verdict,r.records,r.nodes,r.edges,r.moves);
    BEGIN
      m:=convert_from(a.manifest,'UTF8')::jsonb;
      bad:=bad OR jsonb_typeof(m) IS DISTINCT FROM 'object' OR m->>'format' IS DISTINCT FROM 'skillbetting.chess.proof-artifact.v1'
        OR m->>'root' IS DISTINCT FROM a.root_key OR m->>'kernelEngineVersion' IS DISTINCT FROM a.kernel_engine OR m->>'kernelRulesVersion' IS DISTINCT FROM a.kernel_rules
        OR m->>'streamFormat' IS DISTINCT FROM a.format OR m->>'kind' IS DISTINCT FROM a.proof_kind OR m->>'verdict' IS DISTINCT FROM a.verdict
        OR m->>'headerSha256' IS DISTINCT FROM encode(sha256(convert_to(w.header_json,'UTF8')),'hex') OR m->>'chunkChainSha256' IS DISTINCT FROM encode(a.chain_digest,'hex')
        OR m->>'chunks' IS DISTINCT FROM a.chunk_count::text OR m->>'bytes' IS DISTINCT FROM a.byte_count::text
        OR m->>'records' IS DISTINCT FROM a.records::text OR m->>'nodes' IS DISTINCT FROM a.nodes::text OR m->>'edges' IS DISTINCT FROM a.edges::text OR m->>'moves' IS DISTINCT FROM a.moves::text;
    EXCEPTION WHEN OTHERS THEN bad:=true; END;
    IF bad THEN kind:='artifact-manifest'; identity:=encode(a.manifest_digest,'hex'); RETURN NEXT; END IF;
  END LOOP;
  FOR r IN SELECT * FROM chess_proof_check_runs LOOP
    SELECT count(*) INTO n FROM chess_proof_check_nodes WHERE run_id=r.id;
    IF n<>r.registered_count OR r.queued_count<>(SELECT count(*) FROM chess_proof_check_nodes WHERE run_id=r.id AND queued)
      OR r.claimed_count<>(SELECT count(*) FROM chess_proof_check_nodes WHERE run_id=r.id AND mark IN ('claimed','checked'))
      OR r.checked_count<>(SELECT count(*) FROM chess_proof_check_nodes WHERE run_id=r.id AND mark='checked') THEN
      kind:='check-membership-counts'; identity:=r.id::text; RETURN NEXT;
    END IF;
  END LOOP;
  FOR g IN SELECT * FROM table_games WHERE engine_version='0.4.0-strict.2' LOOP
    bad:=false;
    BEGIN
      bad:=g.rules_version IS DISTINCT FROM 'skillbetting.chess.fide-2023.strict-proof-artifacts.v1'
        OR g.state->>'schemaVersion' IS DISTINCT FROM '3' OR jsonb_typeof(g.state->'decisions') IS DISTINCT FROM 'array'
        OR (SELECT count(*) FROM match_chess_proof_refs WHERE table_id=g.table_id)<>jsonb_array_length(g.state->'decisions')
        OR jsonb_array_length(g.state->'decisions')<>1+(SELECT count(*) FROM jsonb_array_elements(g.state->'history') z WHERE z#>>'{action,type}'='move');
      FOR d IN SELECT value FROM jsonb_array_elements(g.state->'decisions') LOOP
        SELECT * INTO ref FROM match_chess_proof_refs WHERE table_id=g.table_id AND decision_revision=(d->>'revision')::integer;
        bad:=bad OR ref.table_id IS NULL OR (encode(ref.artifact_id,'hex'),ref.root_key,ref.kernel_engine,ref.kernel_rules,ref.format)
          IS DISTINCT FROM (d->>'artifactId',d->>'root',d->>'kernelEngineVersion',d->>'kernelRulesVersion',d->>'format')
          OR ref.game_revision<>ref.decision_revision+1
          OR NOT EXISTS(SELECT 1 FROM match_events e WHERE e.table_id=ref.table_id AND e.revision=ref.game_revision
            AND ((ref.decision_revision=0 AND e.kind='start') OR (ref.decision_revision>0 AND e.kind='action' AND e.payload#>>'{action,type}'='move'
              AND e.payload->'action'=g.state->'history'->(ref.decision_revision-1)->'action'
              AND e.actor_user_id::text=g.state->'history'->(ref.decision_revision-1)->>'playerId')));
      END LOOP;
    EXCEPTION WHEN OTHERS THEN bad:=true; END;
    IF bad THEN kind:='match-receipts'; identity:=g.table_id::text; RETURN NEXT; END IF;
  END LOOP;
  FOR ref IN SELECT x.* FROM match_chess_proof_refs x LEFT JOIN table_games games ON games.table_id=x.table_id
    LEFT JOIN chess_proof_artifacts artifacts ON (artifacts.manifest_digest,artifacts.root_key,artifacts.kernel_engine,artifacts.kernel_rules,artifacts.format)=(x.artifact_id,x.root_key,x.kernel_engine,x.kernel_rules,x.format)
    WHERE games.table_id IS NULL OR games.engine_version<>'0.4.0-strict.2' OR artifacts.manifest_digest IS NULL LOOP
    kind:='orphan-receipt'; identity:=ref.table_id::text || ':' || ref.decision_revision::text; RETURN NEXT;
  END LOOP;
END;
$$;
