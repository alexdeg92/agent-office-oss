import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Legacy migration baseline. Each exception is a pre-existing product surface,
// pinned to its reviewed ceiling. New UI and Settings/shared helpers must use
// public/v2/components/bureau; moving a native control into a generic helper
// cannot evade this recursive scan.
const legacyCeilings = new Map(Object.entries({
  // Common shell helpers keep their reviewed native-button ceilings rather than importing
  // the lazy Bureau forms chunk on every route and pushing first paint over budget.
  'components/ui.js':4, 'components/modal.js':1,
  'components/order.js':1, 'components/restart.js':3, 'components/shell.js':3,
  'office/animations.js':15, 'office/boutique.js':18, 'office/editor.js':37,
  'office/mobile-roster.js':3, 'office/page.js':12, 'office/placement.js':6,
  'office/setup-characters.js':8, 'office/surprise-setting.js':1, 'office/themes-panel.js':6,
  'pages/about.js':1, 'pages/access.js':4, 'pages/chat.js':4, 'pages/flow.js':7,
  'pages/flows.js':11, 'pages/health.js':6, 'pages/import.js':13,
  'pages/interlocutor.js':1, 'pages/journaux.js':8, 'pages/login.js':3,
  'pages/placeholder.js':1, 'pages/project-comments.js':8, 'pages/project.js':25,
  'pages/projects.js':16, 'pages/session.js':2,
  'pages/setup-identities.js':1, 'pages/setup-onboarding.js':14, 'pages/setup.js':18,
  'pages/skill.js':3, 'pages/skills.js':6,
}));
const nativeControl = /<\s*(?:input|select|textarea|button)\b/g;

async function walk(directory, root = directory) {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if(entry.isDirectory()) {
      if(relative(root,path).replaceAll('\\','/')==='components/bureau'||relative(root,path).replaceAll('\\','/').startsWith('components/bureau/'))continue;
      if(relative(root,path).replaceAll('\\','/').startsWith('vendor/'))continue;
      files.push(...await walk(path,root));
    } else if(entry.isFile()&&entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

test('native controls use the Bureau library; legacy surfaces cannot grow raw controls', async () => {
  const root=join(process.cwd(),'public/v2'), counts=new Map();
  for(const file of await walk(root)) {
    const source=await readFile(file,'utf8'), matches=source.match(nativeControl);
    if(matches?.length)counts.set(relative(root,file).replaceAll('\\','/'),matches.length);
  }
  const unexpected=[...counts.keys()].filter(file=>!legacyCeilings.has(file));
  assert.deepEqual(unexpected,[],`raw controls appeared outside the reviewed legacy set: ${unexpected.join(', ')}`);
  const grown=[...counts].filter(([file,count])=>count>legacyCeilings.get(file));
  assert.deepEqual(grown,[],`legacy raw-control counts increased: ${grown.map(([file,count])=>`${file} ${count}/${legacyCeilings.get(file)}`).join(', ')}`);
  for(const file of ['pages/settings.js','pages/settings-frame.js','pages/settings-views.js','pages/settings-fix-all.js','pages/design-system.js'])
    assert.equal(counts.has(file),false,`${file} must compose shared Bureau controls`);
});
