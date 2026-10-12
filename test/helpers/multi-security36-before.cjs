'use strict';
require('./scratch-home.cjs').refuseEntry(__filename);   // T-0073 P0: never runs against the real HOME (test/helpers/scratch-home.cjs)
// Replays the exact reviewed public metadata boundaries with synthetic HTTP fixtures.
const {execFileSync}=require('node:child_process'),Module=require('node:module'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),candidate='9a1678136dfbc2f4add14d73b020d607fa4ec425';
for(const relative of ['src/api/v2/vm/meta.js','src/api/v2/routes.js']) {
 const filename=path.join(root,relative),source=execFileSync('git',['show',candidate+':'+relative],{cwd:root,encoding:'utf8'});
 const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));require.cache[filename]=mod;mod._compile(source,filename);mod.loaded=true;
}
