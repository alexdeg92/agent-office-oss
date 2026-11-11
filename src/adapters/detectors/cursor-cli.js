'use strict';
const path = require('node:path');
const { exists, binary } = require('./helpers');
// Runtime id matches the registered adapter (`cursor`) so Settings can enable it.
const runtime = 'cursor', name = 'Cursor';
const detect = ({ env, home }) => {
  const cursorHome = env.CURSOR_HOME || path.join(home, '.cursor');
  const chats = path.join(cursorHome, 'chats');
  const found = exists(cursorHome, env) || !!binary('cursor-agent', env);
  return {
    runtime, name, found, checkedPaths: [chats], reason: found ? 'presence' : 'none',
    confidence: found ? 'presence' : 'none', agents: [], connection: null, home: cursorHome,
  };
};
module.exports = { runtime, name, detect };
