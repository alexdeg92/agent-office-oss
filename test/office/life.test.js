const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickActivity, canIdle, reactionFor, LIFE } = require('../../public/v2/office/life.js');
test('life respects idle threshold, weighted availability, cooldowns and no consecutive repetition', () => {
  const input = { now: 100000, idleSince: 0, available: k => ['coffee','book'].includes(k), random: () => 0 };
  assert.equal(pickActivity({...input, now:100}), null);
  assert.equal(pickActivity(input), 'coffee');
  assert.equal(pickActivity({...input,last:'coffee'}), 'book');
  assert.equal(pickActivity({...input,last:'coffee',history:{book:99000}}), null);
  assert.equal(pickActivity({...input,available:()=>false}), null);
  assert.equal(canIdle({state:'working'}),false);
  assert.equal(canIdle({state:'idle',presence:'seen'}),false);
  assert.equal(canIdle({state:'idle',destination:{stationUid:'rack'}}),false);
});
test('reaction mapping never invents success from an idle snapshot', () => {
  assert.equal(reactionFor({state:'working'},{state:'idle'},0),null);
  assert.equal(reactionFor({state:'working'},{state:'error'},0),'error');
  assert.equal(reactionFor({state:'idle'},{state:'working'},0),'message');
  assert.equal(reactionFor({state:'working'},{state:'waiting'},0),'waiting');
  assert.equal(reactionFor({state:'working'},{state:'working',stateSince:0},LIFE.longRunMs),'stretch');
});
