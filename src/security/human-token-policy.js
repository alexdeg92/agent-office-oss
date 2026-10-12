'use strict';

// The values actually enforced by the human-token repository. Access settings
// must project these effective values instead of treating a saved draft as live.
const HUMAN_TOKEN_SECURITY = Object.freeze({ accessTokenMinutes: 10, refreshIdleHours: 12, refreshAbsoluteDays: 7 });

module.exports = { HUMAN_TOKEN_SECURITY };
