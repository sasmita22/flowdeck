CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE flow_versions (
  flow_id TEXT NOT NULL REFERENCES flows(id),
  version INTEGER NOT NULL,
  session TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, version)
);

CREATE TABLE nodes (
  flow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  parent TEXT,
  settings TEXT NOT NULL,
  PRIMARY KEY (flow_id, version, ordinal),
  FOREIGN KEY (flow_id, version) REFERENCES flow_versions(flow_id, version) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE ports (
  flow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (flow_id, version, node_id, ordinal),
  FOREIGN KEY (flow_id, version) REFERENCES flow_versions(flow_id, version) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE wires (
  flow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  from_node TEXT NOT NULL,
  from_port TEXT NOT NULL,
  to_node TEXT NOT NULL,
  to_port TEXT NOT NULL,
  file TEXT,
  PRIMARY KEY (flow_id, version, ordinal),
  FOREIGN KEY (flow_id, version) REFERENCES flow_versions(flow_id, version) DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER flow_versions_no_update BEFORE UPDATE ON flow_versions
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER flow_versions_no_delete BEFORE DELETE ON flow_versions
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER nodes_no_update BEFORE UPDATE ON nodes
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER nodes_no_delete BEFORE DELETE ON nodes
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER ports_no_update BEFORE UPDATE ON ports
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER ports_no_delete BEFORE DELETE ON ports
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER wires_no_update BEFORE UPDATE ON wires
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER wires_no_delete BEFORE DELETE ON wires
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER flow_versions_no_replace BEFORE INSERT ON flow_versions
WHEN EXISTS (SELECT 1 FROM flow_versions WHERE flow_id = NEW.flow_id AND version = NEW.version)
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER nodes_no_insert BEFORE INSERT ON nodes
WHEN EXISTS (SELECT 1 FROM flow_versions WHERE flow_id = NEW.flow_id AND version = NEW.version)
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER ports_no_insert BEFORE INSERT ON ports
WHEN EXISTS (SELECT 1 FROM flow_versions WHERE flow_id = NEW.flow_id AND version = NEW.version)
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;

CREATE TRIGGER wires_no_insert BEFORE INSERT ON wires
WHEN EXISTS (SELECT 1 FROM flow_versions WHERE flow_id = NEW.flow_id AND version = NEW.version)
BEGIN
  SELECT RAISE(ABORT, 'saved flow versions are locked');
END;
