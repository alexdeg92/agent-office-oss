-- Unknown historical agent outputs may contain privileged project context.
ALTER TABLE project_comments ADD COLUMN provenance_json TEXT CHECK(provenance_json IS NULL OR json_valid(provenance_json));
UPDATE project_comments SET provenance_json='[{"resource":"logs","level":"read"},{"resource":"flows","level":"read"},{"resource":"settings.runtimes","level":"read"}]' WHERE author_kind='agent';
