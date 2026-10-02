-- Apply inside a new, dedicated schema. Retained keys are permanent tombstones.
CREATE TABLE object_keys (
  key uuid PRIMARY KEY,
  retired boolean NOT NULL DEFAULT false
);

CREATE TABLE objects (
  key uuid PRIMARY KEY REFERENCES object_keys(key),
  label text NOT NULL
);

CREATE TABLE object_references (
  id uuid PRIMARY KEY,
  object_key uuid NOT NULL REFERENCES objects(key) ON DELETE RESTRICT
);

CREATE TABLE cleanup_jobs (
  object_key uuid PRIMARY KEY REFERENCES object_keys(key),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  last_error text
);
CREATE INDEX cleanup_ready ON cleanup_jobs(available_at) WHERE completed_at IS NULL;

CREATE FUNCTION protect_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Object keys are permanent and cannot be reused';
  END IF;
  IF NEW.key <> OLD.key OR (OLD.retired AND NOT NEW.retired) THEN
    RAISE EXCEPTION 'Object key identity and retirement are irreversible';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER permanent_key BEFORE UPDATE OR DELETE ON object_keys
  FOR EACH ROW EXECUTE FUNCTION protect_key();

CREATE FUNCTION assert_live_key(requested_key uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE is_retired boolean;
BEGIN
  -- This lock serializes attachment writers with retirement of this generation.
  SELECT retired INTO is_retired FROM object_keys WHERE key = requested_key FOR UPDATE;
  IF is_retired IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Object generation is missing or retired';
  END IF;
END $$;

CREATE FUNCTION guard_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_live_key(NEW.object_key);
  RETURN NEW;
END $$;
CREATE TRIGGER live_reference BEFORE INSERT OR UPDATE OF object_key ON object_references
  FOR EACH ROW EXECUTE FUNCTION guard_reference();

CREATE FUNCTION guard_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'Object generation keys are immutable';
  END IF;
  PERFORM assert_live_key(NEW.key);
  RETURN NEW;
END $$;
CREATE TRIGGER live_object BEFORE INSERT OR UPDATE OF key ON objects
  FOR EACH ROW EXECUTE FUNCTION guard_object();

CREATE FUNCTION schedule_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_live_key(OLD.key);
  UPDATE object_keys SET retired = true WHERE key = OLD.key;
  INSERT INTO cleanup_jobs(object_key) VALUES (OLD.key);
  RETURN OLD;
END $$;
-- FK rejection rolls back BOTH the delete and its manifest/tombstone.
CREATE TRIGGER object_cleanup BEFORE DELETE ON objects
  FOR EACH ROW EXECUTE FUNCTION schedule_cleanup();
