'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Manual failing-before replay: only the submitted S34 command/alias boundaries
// are loaded from fa69b1f9. Run solely with multi-isolation-security.test.js,
// whose service-manager/RPC/CLI dependencies are synthetic spies.
const {execFileSync}=require('node:child_process'),Module=require('node:module'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),candidate='fa69b1f952cad567b1e36330938ecd25d97b4044';
for(const relative of ['src/adapters/openclaw/commands.js','src/adapters/openclaw/index.js','src/api/v2/runtime-projection.js','src/api/v2/commands.js','src/api/v2/views.js']) {
 const filename=path.join(root,relative),source=execFileSync('git',['show',candidate+':'+relative],{cwd:root,encoding:'utf8'});
 const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));require.cache[filename]=mod;mod._compile(source,filename);mod.loaded=true;
}
