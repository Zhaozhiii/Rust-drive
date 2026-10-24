const { chromium } = require('@playwright/test');
const fs = require('fs'), path = require('path'), assert = require('assert'), crypto = require('crypto');
const base = process.argv[2] || 'https://drive.zhiii.top';
const staging = base.includes(':18443');
const artifacts = path.resolve(__dirname,'../artifacts');
const fixture = path.join(artifacts,'ui-fixture.bin');
fs.mkdirSync(artifacts,{recursive:true});fs.writeFileSync(fixture,Buffer.alloc(2*1024*1024+17,71));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
 const browser = await chromium.launch({channel:'msedge',headless:true,args:staging?['--host-resolver-rules=MAP drive.zhiii.top 127.0.0.1']:[]});
 const records=[];
 try {
 for (const mobile of [false,true]) {
 const context = await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,acceptDownloads:true});
 const page=await context.newPage(), errors=[], requests=[];
 page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(30000);
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),type:r.resourceType()}));page.on('dialog',d=>d.accept());
 const name='_drive_ui_'+Date.now()+(mobile?'_mobile':'_desktop');let created=false;
 try {
 await page.goto(base,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'云盘',exact:true}).waitFor();
 await page.getByRole('button',{name:'新建文件夹',exact:true}).click();await page.getByLabel('文件夹名称').fill(name);await page.getByRole('button',{name:'创建',exact:true}).click();
 await page.getByRole('button',{name:'[目录] '+name,exact:true}).waitFor();created=true;await page.getByRole('button',{name:'[目录] '+name,exact:true}).click();await page.getByText('空目录',{exact:true}).waitFor();
 let failures=0;
 await page.route('**/chunk/**',route=>{failures++;return route.abort('connectionfailed');});
 await page.locator('#file').setInputFiles(fixture);await page.waitForFunction(()=>document.getElementById('error').textContent.length>0,{},{timeout:30000});
 assert(failures>=3,'three retry attempts');
 await page.getByRole('button',{name:'取消上传',exact:true}).click();await page.waitForFunction(()=>document.getElementById('upload').hidden);
 await page.locator('#file').setInputFiles(fixture);await page.waitForFunction(()=>document.getElementById('error').textContent.length>0,{},{timeout:30000});
 await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'选择原文件续传',exact:true}).first().waitFor();await page.unroute('**/chunk/**');
 await page.locator('#file').setInputFiles(fixture);await page.getByRole('cell',{name:'ui-fixture.bin',exact:true}).waitFor({timeout:60000});
 const download=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'下载',exact:true}).click()]);
 const saved=path.join(artifacts,mobile?'mobile-download.bin':'desktop-download.bin');await download[0].saveAs(saved);assert.equal(sha(fs.readFileSync(saved)),sha(fs.readFileSync(fixture)));
 // Upload the same name again and verify atomic replacement through the UI.
 await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['replacement'],'ui-fixture.bin',{lastModified:123}));document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});
 await page.waitForFunction(()=>document.getElementById('upload').hidden && document.querySelector('#entries').textContent.includes('11 B'));
 // Drag/drop uses a real File and a stable lastModified value.
 await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['drag text'],'拖拽 & ?#%.txt',{lastModified:123}));document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});
 await page.getByRole('cell',{name:'拖拽 & ?#%.txt',exact:true}).waitFor();
 const result=await page.evaluate(async()=>{const path=new URLSearchParams(location.search).get('path');const r=await fetch('/api/clouddrive/download?path='+encodeURIComponent(path+'/拖拽 & ?#%.txt'),{headers:{Range:'bytes=0-3'}});return {status:r.status,text:await r.text(),range:r.headers.get('Content-Range')};});
 assert.equal(result.status,206);assert.equal(result.text,'drag');assert.equal(result.range,'bytes 0-3/9');
 await page.screenshot({path:path.join(artifacts,mobile?'frontend-mobile.png':'frontend-desktop.png'),fullPage:true});
 assert.equal(await page.locator('img,svg,canvas,video').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
 assert.deepEqual(errors,[]);assert(requests.every(r=>!['image','font','stylesheet'].includes(r.type)));assert(requests.every(r=>new URL(r.url).origin===new URL(base).origin));
 await page.getByRole('row').filter({hasText:'拖拽 & ?#%.txt'}).getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('cell',{name:'拖拽 & ?#%.txt',exact:true}).waitFor({state:'detached'});
 await page.getByRole('button',{name:'返回上级目录',exact:true}).click();await page.getByRole('button',{name:'[目录] '+name,exact:true}).waitFor();
 await page.getByRole('row').filter({has:page.getByRole('button',{name:'[目录] '+name,exact:true})}).getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('button',{name:'[目录] '+name,exact:true}).waitFor({state:'detached'});created=false;
 records.push({device:mobile?'mobile':'desktop',checks:['create/navigate directory','upload retry','cancel upload','reload resume','download checksum','overwrite','drag/drop','special filename','Range 206','delete file/directory','return to parent','no image/font/external requests','no horizontal overflow','no page errors'],retryAttempts:failures,requests:requests.length});
 } finally {
 if(created) await page.evaluate(async name=>{const r=await fetch('/api/clouddrive/remove?path='+encodeURIComponent(name),{method:'DELETE'});if(!r.ok)throw new Error('fixture cleanup failed');},name);
 await context.close();
 }
 }
 fs.writeFileSync(path.join(artifacts,'frontend-results.json'),JSON.stringify({base,records},null,2));console.log(JSON.stringify({base,records},null,2));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
