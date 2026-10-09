'use strict';
const { presence } = require('./helpers');
const runtime = 'claude-code', name = 'Claude Code';
const detect = ({ env, home }) => presence({ runtime, name, directories: ['.claude'], executable: 'claude', env, home });
module.exports = { runtime, name, detect };
