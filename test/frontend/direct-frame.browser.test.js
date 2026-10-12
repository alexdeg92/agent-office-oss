import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createApp } = require('../../src/api/http');
const { launch, findChrome } = require('../office/helpers/browser');
const skip = !findChrome() ? 'Chrome unavailable' : false;
test('S03-02: browser refuses same-origin framing while current import maps still load', { skip, timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-frame-')), root = path.join(tmp,'v2'); fs.mkdirSync(root);
  const template = fs.readFileSync(path.join(import.meta.dirname, '../../public/v2/index.html'),'utf8');
  const scripts = '<script type="importmap">{"imports":{"inert":"./inert.js"}}</script><script type="module" src="./entry.js"></script>';
  const shell = template.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace('</head>', scripts + '</head>').replace('</body>', '<div id="frame-marker">Inert</div></body>');
  fs.writeFileSync(path.join(root,'index.html'),shell); fs.writeFileSync(path.join(root,'inert.js'),'export const value="loaded";');
  fs.writeFileSync(path.join(root,'entry.js'),'import {value} from "inert"; window.__map=value;');
  const app = createApp({ readonly: false, publicDir: tmp, mountRoutes() {} });
  // Isolate an inert same-origin parent in front of the direct UI handler.
  const server = http.createServer((req,res) => {
    if (req.url === '/inert-frame-parent') { res.writeHead(200,{'content-type':'text/html'}); res.end('<iframe src="/v2/" id="child"></iframe>'); }
    else app(req,res);
  });
  let browser; await new Promise(r => server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    browser=await launch(); const direct=await browser.page(origin+'/v2/'); await direct.waitFor('window.__map === "loaded"');
    const parent=await browser.page(origin+'/inert-frame-parent'); await parent.waitFor('!!document.querySelector("#child")');
    await new Promise(r=>setTimeout(r,300));
    assert.equal(await parent.eval('try { return !!document.querySelector("#child").contentDocument?.querySelector("#frame-marker"); } catch { return false; }'),false);
    assert.equal(await parent.eval('try { return document.querySelector("#child").contentWindow.__map === "loaded"; } catch { return false; }'),false);
    assert.equal(await direct.eval('return window.__map;'),'loaded');
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); fs.rmSync(tmp,{recursive:true,force:true}); }
});
