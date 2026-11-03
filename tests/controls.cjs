const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.argv[2] || 'http://localhost:4175';
const artifacts = path.resolve(__dirname, '../artifacts');
fs.mkdirSync(artifacts, {recursive:true});
const sample = {sub:'',maxSize:10*1024**3,totalSize:0,entries:[
  {name:'项目文档',isDir:true,size:0,modified:'2026-10-28T00:00:00Z'},
  {name:'交互说明.txt',isDir:false,size:128,modified:'2026-10-28T00:00:00Z'}
]};
const records = [];
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const mobile of [false,true]) {
      const context = await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,colorScheme:'light'});
      const page = await context.newPage(), errors=[];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('clouddrive-theme','light'));
      await page.route('**/api/clouddrive/list?**', route => route.fulfill({json:sample}));
      await page.goto(base,{waitUntil:'networkidle'});
      await page.waitForFunction(() => !document.querySelector('#entries tr.new-row'));
      const tag = mobile?'mobile':'desktop';
      assert(await page.locator('#new-folder').evaluate(button => button.getBoundingClientRect().right < document.getElementById('refresh').getBoundingClientRect().left));
      await page.locator('#new-folder').click();
      await page.waitForTimeout(760);
      const geometry = await page.locator('#mkdir-control').evaluate(control => {
        const rect=control.getBoundingClientRect(), input=document.getElementById('folder-name').getBoundingClientRect(), trigger=document.getElementById('new-folder').getBoundingClientRect(), refresh=document.getElementById('refresh').getBoundingClientRect();
        return {left:rect.left,right:rect.right,width:rect.width,inputLeft:input.left,inputRight:input.right,inputWidth:input.width,triggerLeft:trigger.left,refreshLeft:refresh.left,top:rect.top,inputTop:input.top,inputBottom:input.bottom,bottom:rect.bottom};
      });
      assert(geometry.left>=0 && geometry.right<geometry.refreshLeft && geometry.inputWidth>80 && geometry.inputLeft>geometry.triggerLeft && geometry.inputRight<geometry.right && geometry.inputTop>=geometry.top && geometry.inputBottom<=geometry.bottom, JSON.stringify(geometry));
      assert.equal(await page.locator('#mkdir button svg').count(),2);
      assert.equal(await page.locator('#folder-name').evaluate(input => document.activeElement===input),true);
      await page.locator('#folder-name').fill('新建示例目录');
      await page.screenshot({path:path.join(artifacts,`controls-${tag}-mkdir.png`),fullPage:true});
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#mkdir').evaluate(form => form.inert),true);
      assert.equal(await page.locator('#new-folder').evaluate(button => document.activeElement===button),true);
      await page.locator('#new-folder').click(); await page.locator('#mkdir-cancel').click();
      assert.equal(await page.locator('#new-folder').getAttribute('aria-expanded'),'false');
      await page.locator('#new-folder').click(); await page.locator('h1').click();
      assert.equal(await page.locator('#new-folder').getAttribute('aria-expanded'),'false');

      const original = await page.locator('#theme-icon').boundingBox();
      await page.locator('#theme-toggle').click();
      await page.waitForTimeout(160);
      const moving = await page.locator('#theme-icon').boundingBox();
      assert(moving.x<original.x-5,'current theme icon actually travels left');
      await page.waitForTimeout(650);
      const alignment = await page.locator('#theme-icon').evaluate(icon => {
        const moved=icon.getBoundingClientRect(), slot=document.querySelector('#theme-light span').getBoundingClientRect();
        return {difference:Math.abs(moved.left+moved.width/2-slot.left-slot.width/2),slotVisibility:getComputedStyle(document.querySelector('#theme-light span')).visibility};
      });
      assert(alignment.difference<2 && alignment.slotVisibility==='hidden',JSON.stringify(alignment));
      assert.equal(await page.locator('.lucide-monitor').count(),0);
      assert.equal(await page.locator('#theme-system-icon .lucide-sun-moon').count(),1);
      await page.screenshot({path:path.join(artifacts,`controls-${tag}-theme.png`),fullPage:true});
      await page.locator('#theme-dark').click();
      await page.waitForFunction(() => document.documentElement.dataset.theme==='dark');
      await page.waitForTimeout(780);
      await page.locator('#theme-toggle').click(); await page.waitForTimeout(760);
      const darkAlignment=await page.locator('#theme-icon').evaluate(icon=>{
        const a=icon.getBoundingClientRect(),b=document.querySelector('#theme-dark span').getBoundingClientRect();return Math.abs(a.left+a.width/2-b.left-b.width/2);
      });
      assert(darkAlignment<2);
      await page.keyboard.press('Escape');
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.locator('#new-folder').click();
      assert.equal(await page.locator('#mkdir').evaluate(form=>getComputedStyle(form).filter),'blur(0px)');
      await page.keyboard.press('Escape');
      await page.locator('#theme-toggle').click(); await page.locator('#theme-light').click();
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.waitForTimeout(760);

      for (const viewport of (mobile ? [{width:390,height:844},{width:320,height:568},{width:844,height:390}] : [{width:1280,height:1268},{width:1280,height:900},{width:1280,height:720},{width:1000,height:600},{width:640,height:360}])) {
        await page.setViewportSize(viewport); await page.waitForTimeout(100);
        const bounds=await page.locator('#drop').evaluate(drop=>{
          const box=drop.getBoundingClientRect(),icon=document.querySelector('.folder-float').getBoundingClientRect();
          return {limit:Math.min(innerHeight,visualViewport.height)/3,bottom:box.bottom,iconBottom:icon.bottom,iconTop:icon.top,top:box.top,overflow:document.documentElement.scrollWidth>innerWidth};
        });
        assert(bounds.bottom<=bounds.limit+.5 && bounds.iconBottom<=bounds.limit+.5 && bounds.iconTop>=bounds.top-1 && !bounds.overflow,JSON.stringify({viewport,bounds}));
        records.push({device:tag,viewport,dropBottom:bounds.bottom,maximum:bounds.limit});
      }
      const radii=await page.locator('#drop,#upload,.theme-switch,#theme-toggle,.mkdir-control,#folder-name,#mkdir-submit,#mkdir-cancel,#refresh,.icon-button,.progress-track,.folder-float__front').evaluateAll(elements=>elements.map(element=>({element:element.id||element.className,radius:getComputedStyle(element).borderRadius})));
      assert(radii.every(entry=>entry.radius==='12px'),JSON.stringify(radii));
      assert.deepEqual(errors,[]);
      await context.close();
    }
    fs.writeFileSync(path.join(artifacts,'controls-results.json'),JSON.stringify({base,records,checks:['inline folder editor, icon actions, cancel and focus','active theme icon travels into selected slot','generic sun/moon system icon','viewport upper-third budget in portrait and landscape','uniform 12px corner radius','reduced motion and no script errors']},null,2));
    console.log(JSON.stringify({base,records},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
