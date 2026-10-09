'use strict';
const { presence } = require('./helpers');
const runtime = 'hermes', name = 'Hermes';
const detect = ({ env, home }) => presence({ runtime, name, directories: ['.hermes'], executable: 'hermes', env, home });
module.exports = { runtime, name, detect };
