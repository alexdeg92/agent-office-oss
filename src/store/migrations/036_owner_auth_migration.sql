CREATE TABLE owner_auth_migration (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state TEXT NOT NULL CHECK(state IN ('pending','complete','rolled_back')),
  completed_at INTEGER,
  CHECK((state='complete') = (completed_at IS NOT NULL))
);
INSERT INTO owner_auth_migration(singleton,state,completed_at) VALUES (1,'pending',NULL);
