'use strict';
const { presence } = require('./helpers');
const runtime = 'cursor-cli', name = 'Cursor CLI';
const detect = ({ env, home }) => presence({ runtime, name, directories: ['.cursor'], executable: 'cursor-agent', env, home });
module.exports = { runtime, name, detect };
