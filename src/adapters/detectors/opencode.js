'use strict';
const { presence } = require('./helpers');
const runtime = 'opencode', name = 'opencode';
const detect = ({ env, home }) => presence({ runtime, name, directories: ['.config/opencode', '.local/share/opencode'], executable: 'opencode', env, home });
module.exports = { runtime, name, detect };
