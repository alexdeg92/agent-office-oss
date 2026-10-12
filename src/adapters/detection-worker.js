'use strict';
const { parentPort, workerData } = require('node:worker_threads');
require('./detection').scanRuntimes(workerData).then(rows => {
  if (rows.length > 32 || Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024) throw Object.assign(Error('discovery capacity exceeded'), { code: 'EDETECTIONLIMIT' });
  parentPort.postMessage({ rows });
}).catch(error => parentPort.postMessage({ error: ['ETESTPATH', 'EDETECTIONLIMIT'].includes(error.code) ? error.code : 'EDETECTIONFAILED' }));
