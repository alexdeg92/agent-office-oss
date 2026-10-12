-- Pending summary identity is internal state: claiming/releasing does not revise the project.
ALTER TABLE projects ADD COLUMN summary_turn TEXT;
-- Retain the identity already stored by pre-migration comment deliveries.
UPDATE projects SET summary_turn = (
  SELECT json_extract(d.value, '$.follow.summary.turnId')
  FROM project_comments c, json_each(CASE WHEN json_valid(c.delivery_json) THEN c.delivery_json ELSE '[]' END) d
  WHERE c.project_id = projects.id
    AND c.kind = 'event'
    AND (json_extract(d.value, '$.status') IN ('pending', 'working')
      OR json_extract(d.value, '$.follow.phase') = 'tracking')
    AND json_type(d.value, '$.follow.summary.turnId') = 'text'
    AND json_extract(d.value, '$.follow.summary.turnId') != ''
  ORDER BY c.rowid DESC LIMIT 1
);
