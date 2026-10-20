import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanupAfterTest} from './test-cleanup.js';

test('cleanup errors are reported without replacing an active test failure',async()=>{
  const testError=new Error('assertion failed'),cleanupErrors=[new Error('browser close failed'),new Error('fixture close failed')];
  let cleanupCount=0;
  const run=async()=>{
    let activeTestError;
    try{throw testError;}
    catch(error){activeTestError={error};throw error;}
    finally{await cleanupAfterTest(activeTestError,cleanupErrors.map(error=>async()=>{cleanupCount++;throw error;}),'cleanup regression');}
  };
  await assert.rejects(run,error=>error===testError);
  assert.equal(cleanupCount,2,'all cleanup functions run even after one fails');
});

test('cleanup errors still fail a test when no test error is active',async()=>{
  const cleanupError=new Error('browser close failed');
  await assert.rejects(cleanupAfterTest(undefined,[()=>{throw cleanupError;}],'cleanup-only regression'),error=>error===cleanupError);
});
