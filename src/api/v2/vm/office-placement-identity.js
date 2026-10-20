'use strict';

// Keep the rollback projector and canonical engine projector on the same
// server-private identity tag so ProjectVM can join the final OfficeVM row by
// stable member ID regardless of which projector built it.
module.exports = require('../../../engine/office/placement-identity');
