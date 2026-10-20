-- Persist the exact orchestrator member that owns a pane-backed Discuter session.
-- The live identity link may disappear while the stored transcript still exists.
ALTER TABLE chat_v3_sessions ADD COLUMN pane_member_id TEXT;
CREATE INDEX chat_v3_sessions_pane_member ON chat_v3_sessions(pane_member_id) WHERE pane_member_id IS NOT NULL;
CREATE INDEX chat_v3_sessions_owner_agent_pane ON chat_v3_sessions(principal_scope,agent_id,pane_member_id) WHERE pane_member_id IS NOT NULL;

-- Member-backed targets were pane identities before the explicit session marker
-- existed. Do not classify every adapter-native ref as a pane: ordinary legacy
-- adapter conversations also carry native session refs.
UPDATE chat_v3_sessions
SET pane_member_id='legacy:unresolved'
WHERE native_session_ref <> ('portal-chat:user:' || principal_scope || ':session:' || session_id)
  AND EXISTS (
    SELECT 1 FROM chat_v3_targets target
    WHERE target.target_id=chat_v3_sessions.agent_id
      AND target.principal_scope=chat_v3_sessions.principal_scope
      AND target.target_kind='agent'
      AND target.source_ref GLOB 'member:*'
  );
