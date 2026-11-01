CREATE TRIGGER events_no_replace BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM events WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
