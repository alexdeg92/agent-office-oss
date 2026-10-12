'use strict';
// One identifier for the owning process, shared by public meta and owner restart.
module.exports = { BOOT_ID: require('node:crypto').randomUUID() };
