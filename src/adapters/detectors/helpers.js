'use strict';
const path = require('path');
const { safePath, exists, read, binary, executable } = require('../../ops/local-files');
function presence({ runtime, name, directories, executable, env, home }) {
  const found = directories.some(d => exists(path.join(home, d), env)) || !!binary(executable, env);
  return { runtime, name, found, checkedPaths: directories.map(d => path.join(home, d)), reason: found ? 'presence' : 'none', confidence: found ? 'presence' : 'none', agents: [], connection: null };
}
module.exports = { safePath, exists, read, binary, executable, presence };
