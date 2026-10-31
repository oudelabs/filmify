'use strict';
// Self-contained public checks; no product fixtures or historical native checkout.
const path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),python=process.env.FILMIFY_PYTHON||'python3';
for(const [name,command,args] of [
 ['demo generator and local import contracts',python,['-m','unittest','discover','-s','tests','-p','test_demo_assets.py']],
 ['component, engine and lifecycle contracts',process.execPath,['--test','--test-concurrency=1',...require('../package.json').publicTests.map(name=>'tests/'+name)]],
 ['isolated offline build and real output',python,['scripts/build-minitool.py']],
 ['source/package rendering, controls and cancellation in Chrome/WebKit',process.execPath,['scripts/verify-public-browser.cjs']],
 ['built directory audit',python,['scripts/audit-artifact.py','dist/xhs-tool']],
 ['archive audit',python,['scripts/audit-artifact.py','dist/filmify-demo-tool.zip']]
]){
 console.log('Checking '+name);const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});
 if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
}
console.log('PASS public analytic-demo checks. Native XHS host and device acceptance are separate.');
