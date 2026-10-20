-- Private durable provenance for stored conversation links. Public VMs expose
-- only their canonical source descriptor, never this metadata or native keys.
ALTER TABLE project_sources ADD COLUMN connector_ids_json TEXT
  CHECK (connector_ids_json IS NULL OR
    (json_valid(connector_ids_json) AND json_type(connector_ids_json)='array' AND json_array_length(connector_ids_json) BETWEEN 1 AND 20));

-- Migration 019 introduced canonical runtime namespaces. Links already present
-- before that checkpoint belonged to its one legacy instance; sessions may have
-- since expired. Later unresolved links are deliberately left unstamped.
UPDATE project_sources SET connector_ids_json='["legacy"]'
WHERE kind='sessionGroup'
  AND CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.addedAt') END
      <= (SELECT applied_at FROM schema_migrations WHERE version=19);
