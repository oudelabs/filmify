'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');

test('preview serves only the build and preview roots, including real symlink targets', {timeout:15000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filmify-preview-'));
  let child;
  try {
    for (const dir of ['scripts/preview', 'dist/xhs-tool', 'dist/xhs-tool-secret', 'tmp']) fs.mkdirSync(path.join(root, dir), {recursive:true});
    fs.copyFileSync(path.join(__dirname, '../scripts/dev-server.js'), path.join(root, 'scripts/dev-server.js'));
    for (const [file, data] of [['dist/xhs-tool/index.html','app'], ['scripts/preview/index.html','preview'], ['dist/xhs-tool-secret/key.txt','private'], ['tmp/probe.txt','private']]) fs.writeFileSync(path.join(root,file),data);
    fs.symlinkSync(path.join(root,'dist/xhs-tool-secret/key.txt'),path.join(root,'dist/xhs-tool/link.txt'));
    child = spawn(process.execPath, ['scripts/dev-server.js','--host','127.0.0.1','--port','0'], {cwd:root,stdio:['ignore','pipe','pipe']});
    const port = await new Promise((resolve,reject) => {
      let output='';
      const timer=setTimeout(()=>reject(new Error('preview startup timed out')),5000);
      child.once('error', e=>{clearTimeout(timer);reject(e);});
      child.stdout.on('data', chunk=>{output+=chunk;const m=output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);if(m){clearTimeout(timer);resolve(Number(m[1]));}});
    });
    const request = (url,method='GET') => new Promise((resolve,reject) => {
      const req=http.request({host:'127.0.0.1',port,path:url,method},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body}));});
      req.on('error',reject);req.end();
    });
    assert.deepEqual(await request('/'),{status:200,body:'app'});
    assert.deepEqual(await request('/preview/'),{status:200,body:'preview'});
    assert.deepEqual(await request('/','HEAD'),{status:200,body:''});
    for(const url of ['/../xhs-tool-secret/key.txt','/%2e%2e/xhs-tool-secret/key.txt','/preview/../../dist/xhs-tool-secret/key.txt','/link.txt','/tmp/probe.txt']) assert.equal((await request(url)).status,404,url);
    for(const url of ['/%ZZ','/%00']) assert.equal((await request(url)).status,400,url);
    assert.equal((await request('/','POST')).status,405);
    assert.deepEqual(await request('/'),{status:200,body:'app'});
  } finally {
    if(child && child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    fs.rmSync(root,{recursive:true,force:true});
  }
});
