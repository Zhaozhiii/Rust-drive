const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const base=process.argv[2]||'http://localhost:4175',api='/api/clouddrive';
const artifacts=path.resolve(__dirname,'../artifacts');fs.mkdirSync(artifacts,{recursive:true});
async function swipe(page,context,row,mobile,fraction=1){
  const track=row.locator('.slide-commit__track');
  let box=await track.boundingBox();
  if(!mobile){await page.mouse.move(box.x+box.width-box.height/2,box.y+box.height/2);await page.waitForTimeout(920);box=await track.boundingBox();}
  const start=box.x+box.width-box.height/2,end=box.x+box.height/2-4,y=box.y+box.height/2;
  if(mobile){
    const cdp=await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start,y}]});
    for(let step=1;step<=12;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start+(end-start)*fraction*step/12,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  }else{await page.mouse.move(start,y);await page.mouse.down();await page.mouse.move(start+(end-start)*fraction,y,{steps:12});await page.mouse.up();}
}
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true}),records=[];
  try{
    for(const mobile of [false,true]){
      const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,colorScheme:'light'}),page=await context.newPage();
      const parent=`_folder_confirm_${Date.now()}_${mobile?'mobile':'desktop'}`,target=parent+'/待确认文件夹';
      let deletes=0;const errors=[];page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{if(request.method()==='DELETE'&&request.url().includes('/remove?'))deletes++;});
      try{
        assert.equal((await page.request.post(base+api+'/mkdir',{data:{name:parent}})).status(),200);
        assert.equal((await page.request.post(base+api+'/mkdir?path='+encodeURIComponent(parent),{data:{name:'待确认文件夹'}})).status(),200);
        assert.equal((await page.request.post(base+api+'/mkdir?path='+encodeURIComponent(target),{data:{name:'子文件夹'}})).status(),200);
        const created=await page.request.post(base+api+'/upload-session',{data:{path:target,name:'保留至二次确认.txt',size:4,lastModified:123}}),session=await created.json();
        assert.equal(created.status(),201);
        assert.equal((await page.request.put(`${base}${api}/upload-session/${session.id}/chunk/0`,{data:Buffer.from('test'),headers:{'Content-Type':'application/octet-stream'}})).status(),200);
        assert.equal((await page.request.post(`${base}${api}/upload-session/${session.id}/complete`)).status(),200);
        await page.goto(`${base}/?path=${encodeURIComponent(parent)}`,{waitUntil:'networkidle'});
        await page.waitForFunction(()=>!document.querySelector('#entries tr.new-row'));
        const row=page.getByRole('row').filter({has:page.getByRole('button',{name:'[目录] 待确认文件夹',exact:true})});
        await row.getByRole('button',{name:'删除',exact:true}).click();await page.waitForTimeout(920);
        await swipe(page,context,row,mobile);
        await row.locator('.slide-commit[data-armed]').waitFor();
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('.slide-commit__capsule')).backgroundColor==='rgb(207, 59, 59)');
        assert.equal(deletes,0,'first complete swipe must never send DELETE');
        assert.equal((await page.request.get(base+api+'/list?path='+encodeURIComponent(target)).then(response=>response.json())).entries.length,2);
        const warning=await row.locator('.slide-commit__label').evaluate(label=>({text:label.textContent,size:parseFloat(getComputedStyle(label).fontSize),weight:parseInt(getComputedStyle(label).fontWeight)}));
        assert(warning.text.includes('文件夹类型')&&warning.text.includes('所有文件')&&warning.size>=13&&warning.weight>=700);
        assert.equal(await row.locator('.slide-commit__capsule').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(207, 59, 59)');
        assert.equal(await row.locator('.slide-commit__armed-backdrop').evaluate(element=>getComputedStyle(element).backgroundColor),await page.locator('body').evaluate(element=>getComputedStyle(element).getPropertyValue('--ink').trim()).then(value=>value==='#20201f'?'rgb(32, 32, 31)':value));
        await page.screenshot({path:path.join(artifacts,`folder-confirm-${mobile?'mobile':'desktop'}.png`),fullPage:true});
        await swipe(page,context,row,mobile,.35);
        await page.waitForFunction(()=>document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')==='0');
        assert.equal(deletes,0,'partial second swipe must preserve the folder');
        await row.getByRole('button',{name:'取消删除',exact:true}).click();
        await row.getByRole('button',{name:'删除',exact:true}).click();
        const slider=row.getByRole('slider');await slider.press('End');await slider.press('Enter');
        await row.locator('.slide-commit[data-armed]').waitFor();assert.equal(deletes,0,'reopening starts a fresh first confirmation');
        await page.route('**/api/clouddrive/remove?**',route=>route.fulfill({status:503,json:{message:'模拟删除失败'}}),{times:1});
        await slider.press('End');await slider.press('Enter');await row.locator('.slide-commit[data-phase="error"]').waitFor();
        assert.equal(deletes,1);assert.equal(await row.locator('.slide-commit[data-armed]').count(),1);
        assert.equal((await page.request.get(base+api+'/list?path='+encodeURIComponent(target)).then(response=>response.json())).entries.length,2);
        await page.waitForTimeout(700);await slider.press('Home');
        await swipe(page,context,row,mobile);
        await row.locator('.slide-commit[data-phase="done"]').waitFor();
        assert.equal(deletes,2);await row.waitFor({state:'detached'});
        await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('已删除'));
        assert((await page.locator('#toast').textContent()).includes('已删除'));
        const listing=await page.request.get(base+api+'/list?path='+encodeURIComponent(parent)).then(response=>response.json());
        assert.equal(listing.entries.length,0);assert.deepEqual(errors,[]);
        records.push({device:mobile?'mobile':'desktop',checks:['first slide preserves directory and completed background','larger bold warning and red handle','partial second slide and cancel preserve all contents','failed second confirmation retains directory and allows retry','second full slide deletes the directory and nested contents then shows toast']});
      }finally{await page.request.delete(base+api+'/remove?path='+encodeURIComponent(parent));await context.close();}
    }
    fs.writeFileSync(path.join(artifacts,'folder-delete-results.json'),JSON.stringify({base,records},null,2));console.log(JSON.stringify({base,records},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
