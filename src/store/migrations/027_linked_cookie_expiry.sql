-- Capture verified cookie expiry when linking token-mode login to a prior same-user cookie.
-- NULL historical values keep their conservative permanent revocation tombstone.
ALTER TABLE auth_families ADD COLUMN linked_cookie_expires_at INTEGER
  CHECK(linked_cookie_expires_at IS NULL OR linked_cookie_expires_at>created_at);
