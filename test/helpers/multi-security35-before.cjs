'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Manual S35 replay substitutes the reviewed b53e9bae namespace/admission/store
// boundaries only. Current tests use temporary SQLite stores and fake adapters;
// no service manager, real runtime home or external request is available.
const {execFileSync}=require('node:child_process'),Module=require('node:module'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),candidate='b53e9bae31d6e93ef2a98116371bb41a93ff6cc8';
for(const relative of ['src/runtime-ids.js','src/store/index.js','src/engine/sessions-registry.js','src/engine/index.js','src/engine/multi.js','src/multi-runtime-controller.js','src/settings/runtime-rows.js']) {
 const filename=path.join(root,relative),source=execFileSync('git',['show',candidate+':'+relative],{cwd:root,encoding:'utf8'});
 const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));require.cache[filename]=mod;mod._compile(source,filename);mod.loaded=true;
}
