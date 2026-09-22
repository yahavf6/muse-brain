PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS node (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('thought','action','rule','conclusion')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  why TEXT NOT NULL DEFAULT '',
  project TEXT,
  status TEXT CHECK (status IS NULL OR status IN ('open','validated','refuted','proposed','approved','retired')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('good','bad','mixed')),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  props TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  approved_by TEXT, approved_on TEXT,
  agent TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_to TEXT,
  CHECK (kind NOT IN ('action','rule') OR length(why) > 0),
  CHECK ((kind = 'conclusion') = (verdict IS NOT NULL)),
  CHECK (kind <> 'thought' OR status IN ('open','validated','refuted')),
  CHECK (kind <> 'rule'    OR status IN ('proposed','approved','retired'))
) STRICT;

CREATE TABLE IF NOT EXISTS edge (
  src INTEGER NOT NULL REFERENCES node(id), dst INTEGER NOT NULL REFERENCES node(id),
  type TEXT NOT NULL, agent TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (src, type, dst)
) STRICT;
CREATE INDEX IF NOT EXISTS edge_rev ON edge(dst, type, src);

CREATE TABLE IF NOT EXISTS edge_rule (type TEXT, src_kind TEXT, dst_kind TEXT, PRIMARY KEY (type, src_kind, dst_kind)) STRICT;
INSERT OR IGNORE INTO edge_rule (type, src_kind, dst_kind) VALUES
  ('derived_from',   'thought', 'conclusion'),
  ('motivated_by',   'action',  'thought'),
  ('complies_with',  'action',  'rule'),
  ('follows',        'action',  'action'),
  ('supersedes',     'rule',    'rule'),
  ('derived_from',   'rule',    'conclusion'),
  ('evaluates',      'conclusion', 'action'),
  ('supports',       'conclusion', 'thought'),
  ('refutes',        'conclusion', 'thought');

CREATE TABLE IF NOT EXISTS node_file (
  path TEXT NOT NULL, project TEXT, node_id INTEGER NOT NULL REFERENCES node(id),
  PRIMARY KEY (path, node_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS rule_live ON node(project) WHERE kind='rule' AND status='approved' AND valid_to IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  title, why, props,
  content='node', content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS node_fts_ai AFTER INSERT ON node BEGIN
  INSERT INTO node_fts(rowid, title, why, props) VALUES (new.id, new.title, new.why, new.props);
END;
CREATE TRIGGER IF NOT EXISTS node_fts_ad AFTER DELETE ON node BEGIN
  INSERT INTO node_fts(node_fts, rowid, title, why, props) VALUES ('delete', old.id, old.title, old.why, old.props);
END;
CREATE TRIGGER IF NOT EXISTS node_fts_au AFTER UPDATE ON node BEGIN
  INSERT INTO node_fts(node_fts, rowid, title, why, props) VALUES ('delete', old.id, old.title, old.why, old.props);
  INSERT INTO node_fts(rowid, title, why, props) VALUES (new.id, new.title, new.why, new.props);
END;

CREATE TRIGGER IF NOT EXISTS edge_endpoints BEFORE INSERT ON edge BEGIN
  SELECT RAISE(ABORT, 'illegal edge endpoints')
  WHERE NOT EXISTS (
    SELECT 1 FROM edge_rule er
    JOIN node ns ON ns.id = NEW.src
    JOIN node nd ON nd.id = NEW.dst
    WHERE er.type = NEW.type AND er.src_kind = ns.kind AND er.dst_kind = nd.kind
  );
END;

CREATE TRIGGER IF NOT EXISTS complies_needs_approved BEFORE INSERT ON edge WHEN NEW.type = 'complies_with' BEGIN
  SELECT RAISE(ABORT, 'complies_with needs an approved rule')
  WHERE NOT EXISTS (
    SELECT 1 FROM node WHERE id = NEW.dst AND kind = 'rule' AND status = 'approved' AND valid_to IS NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS rule_starts_proposed BEFORE INSERT ON node WHEN NEW.kind = 'rule' BEGIN
  SELECT RAISE(ABORT, 'a new rule must start proposed')
  WHERE NEW.status IS NOT 'proposed';
END;

CREATE TRIGGER IF NOT EXISTS rule_approve_guard BEFORE UPDATE ON node WHEN NEW.kind = 'rule' AND NEW.status = 'approved' BEGIN
  SELECT RAISE(ABORT, 'approved rule needs approved_by')
  WHERE NEW.approved_by IS NULL OR trim(NEW.approved_by) = '';
  SELECT RAISE(ABORT, 'rule is not a proposed, current rule')
  WHERE NOT (OLD.status = 'proposed' AND OLD.valid_to IS NULL);
END;

CREATE TRIGGER IF NOT EXISTS supersedes_needs_live_dst BEFORE INSERT ON edge WHEN NEW.type = 'supersedes' BEGIN
  SELECT RAISE(ABORT, 'supersedes needs an approved, current rule')
  WHERE NOT EXISTS (
    SELECT 1 FROM node WHERE id = NEW.dst AND kind = 'rule' AND status = 'approved' AND valid_to IS NULL
  );
END;

-- supersede_closes only retires dst once the src rule is itself approved (or src isn't a rule);
-- a freshly-proposed superseding rule does not retire anything until supersede_on_approve fires.
CREATE TRIGGER IF NOT EXISTS supersede_closes AFTER INSERT ON edge WHEN NEW.type = 'supersedes' BEGIN
  UPDATE node SET valid_to = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status = 'retired'
  WHERE id = NEW.dst AND valid_to IS NULL
    AND EXISTS (SELECT 1 FROM node s WHERE s.id = NEW.src AND (s.kind <> 'rule' OR s.status = 'approved'));
END;

CREATE TRIGGER IF NOT EXISTS supersede_on_approve AFTER UPDATE OF status ON node WHEN NEW.kind = 'rule' AND NEW.status = 'approved' BEGIN
  UPDATE node SET valid_to = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status = 'retired'
  WHERE valid_to IS NULL AND id IN (SELECT dst FROM edge WHERE src = NEW.id AND type = 'supersedes');
END;

CREATE TRIGGER IF NOT EXISTS conclusion_resolves AFTER INSERT ON edge WHEN NEW.type IN ('supports', 'refutes') BEGIN
  -- ponytail: last verdict wins; Jev-weighted scoring later
  UPDATE node SET status = CASE NEW.type WHEN 'supports' THEN 'validated' ELSE 'refuted' END
  WHERE id = NEW.dst AND kind = 'thought' AND valid_to IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS guard_frozen BEFORE UPDATE ON node WHEN OLD.kind = 'rule' AND OLD.status = 'approved' BEGIN
  SELECT RAISE(ABORT, 'guard_frozen: an approved rule guard cannot change')
  WHERE json_extract(NEW.props, '$.guard') IS NOT json_extract(OLD.props, '$.guard');
END;
