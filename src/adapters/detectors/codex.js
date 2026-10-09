'use strict';
const { presence } = require('./helpers');
const runtime = 'codex', name = 'Codex';
const detect = ({ env, home }) => presence({ runtime, name, directories: ['.codex'], executable: 'codex', env, home });
module.exports = { runtime, name, detect };
