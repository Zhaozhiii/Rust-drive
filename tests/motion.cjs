const { chromium } = require('@playwright/test');
const fs = require('fs'), path = require('path'), assert = require('assert');
const base = process.argv[2] || 'http://localhost:4173';
const smoke = process.argv.includes('--smoke');
const artifacts = path.resolve(__dirname, '../artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const fixture = path.join(artifacts, 'motion-fixture.bin');
if (!smoke) fs.writeFileSync(fixture, Buffer.alloc(34 * 1024 * 1024 + 17, 83));
const api = '/api/clouddrive';

async function seed(page, directory, name, text) {
  const response = await page.request.post(`${base}${api}/upload-session`, { data: { path: directory, name, size: Buffer.byteLength(text), lastModified: 123 } });
  assert.equal(response.status(), 201);
  const session = await response.json();
  assert.equal((await page.request.put(`${base}${api}/upload-session/${session.id}/chunk/0`, { data: Buffer.from(text), headers: { 'Content-Type': 'application/octet-stream' } })).status(), 200);
  assert.equal((await page.request.post(`${base}${api}/upload-session/${session.id}/complete`)).status(), 200);
}
async function drag(page, type, text = '起飞', name = '火箭上传.txt') {
  await page.evaluate(({ type, text, name }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([text], name, { lastModified: 123 }));
    document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 280, clientY: 340 }));
  }, { type, text, name });
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const csp = "default-src 'self'; img-src 'none'; font-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
async function testDevice(browser, mobile) {
  console.log(`Testing ${mobile ? 'mobile' : 'desktop'} interactions`);
  const context = await browser.newContext({ viewport: mobile ? { width:390, height:844 } : { width:1280, height:1050 }, isMobile:mobile, hasTouch:mobile, locale:'zh-CN', timezoneId:'Asia/Shanghai', colorScheme:'light' });
  await context.route(url => url.origin === new URL(base).origin && url.pathname === '/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers:{ ...response.headers(), 'content-security-policy':csp } });
  });
  const page = await context.newPage(), errors = [], requests = [], checks = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Minified React error/i.test(message.text())) errors.push(message.text()); });
  const directory = `_motion2_${Date.now()}_${mobile ? 'mobile' : 'desktop'}`;
  const check = (label, condition) => { assert(condition, label); checks.push(label); };
  const shot = name => page.screenshot({ path:path.join(artifacts, `motion2-${mobile ? 'mobile' : 'desktop'}-${name}.png`), fullPage:true });
  async function settled() { await page.waitForFunction(() => document.getElementById('refresh').getAttribute('aria-busy') === 'false' && !document.querySelector('#entries tr.new-row')); }
  const fileNames = () => page.locator('#entries tr:not(.parent-row)').evaluateAll(rows => rows.map(row => `${row.querySelector('[data-file-kind="folder"]') ? '[目录] ' : ''}${row.querySelector('.file-name').textContent}`));
  try {
    assert.equal((await page.request.post(`${base}${api}/mkdir`, { data:{name:directory} })).status(), 200);
    await seed(page, directory, '样例 A.txt', 'a'); await pause(15);
    await seed(page, directory, '样例 B.txt', 'larger file');
    await page.request.post(`${base}${api}/mkdir?path=${encodeURIComponent(directory)}`, { data:{ name:'子目录' } });
    await page.goto(`${base}/?path=${encodeURIComponent(directory)}`, { waitUntil:'networkidle' }); await settled();
    check('removed hint, filter, dropdown and manual motion switch', await page.locator('#filter,#sort,#motion-toggle,.toolbar-hint').count() === 0);
    check('removed duplicate upload button and chunk progress', await page.locator('#choose,#chunks,#chunk-label,.wake-slider').count() === 0);
    check('removed upload status, round head and header captions', await page.locator('#upload-state,.status-dot,.upload-head,.brand-overline,.header-note,.capacity-label').count() === 0);
    check('upload area has no caption below the folder', await page.locator('#drop .drop-title,#drop .drop-caption').count() === 0);
    check('all directory entries have local SVG type icons', await page.locator('#entries tr:not(.parent-row) .entry-icon svg').count() === 4);
    check('capacity note follows the bottom entry count and uses decimal units', await page.locator('.list-footer #entry-count + .capacity-note').count() === 1 && !/\b[KMGT]iB\b/.test(await page.locator('body').innerText()) && (await page.locator('#capacity-note').textContent()).includes('10.74 GB'));
    check('file actions sit beside the path below the upload area', await page.locator('.list-heading .toolbar #refresh').count() === 1 && await page.locator('.list-heading .toolbar #new-folder').count() === 1 && await page.locator('.list-heading').evaluate(heading => heading.getBoundingClientRect().top >= document.getElementById('drop').getBoundingClientRect().bottom));
    check('default time order is newest first with directories first', (await fileNames())[1] === '样例 B.txt' && (await fileNames())[0].includes('[目录]'));
    const widths = await page.locator('table').evaluate(table => [table.getBoundingClientRect().width,[...table.querySelectorAll('th')].reduce((sum, cell) => sum + cell.getBoundingClientRect().width, 0)]);
    check('headers occupy the whole table at both viewport sizes', Math.abs(widths[0] - widths[1]) < 2);

    await page.locator('#theme-toggle').click();
    await page.locator('#theme-switch.expanded').waitFor();
    await page.waitForTimeout(760); await shot('theme-menu');
    check('theme selector expands left and shows three choices', await page.getByRole('radio').count() === 3 && (await page.locator('#theme-switch').boundingBox()).width >= 280);
    await page.locator('#theme-dark').click(); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.reload({ waitUntil:'networkidle' }); await settled();
    check('explicit theme persists across reload', await page.locator('#theme-dark').getAttribute('aria-checked') === 'true');
    await page.emulateMedia({colorScheme:'light'});
    check('explicit dark ignores system light', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
    await page.locator('#theme-toggle').click(); await page.locator('#theme-system').click();
    await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'system' && document.documentElement.dataset.theme === 'light');
    await page.emulateMedia({colorScheme:'dark'}); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.reload({ waitUntil:'networkidle' }); await settled();
    check('system mode persists and responds to system changes', await page.locator('#theme-system').getAttribute('aria-checked') === 'true');
    await shot('dark');
    await page.locator('#theme-toggle').click(); await page.keyboard.press('Escape');
    check('Escape closes the theme menu and returns focus', await page.locator('#theme-toggle').getAttribute('aria-expanded') === 'false' && await page.locator('#theme-toggle').evaluate(element => document.activeElement === element));
    await page.emulateMedia({colorScheme:'light'});
    await page.locator('#theme-toggle').click(); await page.locator('h1').click();
    check('outside click dismisses theme choices', await page.locator('#theme-toggle').getAttribute('aria-expanded') === 'false');

    for (const key of mobile ? ['name','size'] : ['name','size','modified']) {
      const header = page.locator(`th[data-sort="${key}"]`), button = header.locator('button');
      await button.click(); assert.equal(await header.getAttribute('aria-sort'), 'ascending');
      check(`${key} ascending keeps directories first`, (await fileNames())[0].includes('[目录]') && (await fileNames())[1] === '样例 A.txt');
      await button.click(); assert.equal(await header.getAttribute('aria-sort'), 'descending');
      check(`${key} descending orders files`, (await fileNames())[1] === '样例 B.txt');
      await button.click(); assert.equal(await header.getAttribute('aria-sort'), 'none');
      check(`${key} third click restores newest first`, (await fileNames())[1] === '样例 B.txt');
    }
    let listRequests = 0, capacityRatio = null;
    await page.route('**/api/clouddrive/list?**', async route => {
      listRequests++; const response = await route.fetch(), body = await response.json();
      if (listRequests === 1) await pause(350);
      if (capacityRatio !== null) body.totalSize = Math.floor(body.maxSize * capacityRatio);
      await route.fulfill({ response, json:body });
    });
    await page.locator('#refresh').evaluate(button => { button.click();button.click();button.click(); });
    await page.waitForTimeout(100);
    check('refresh rotates while a single request is active', await page.locator('#refresh').evaluate(button => button.classList.contains('busy') && getComputedStyle(button.querySelector('.refresh-symbol')).animationName === 'spin'));
    check('loading status has its own space above the header', await page.locator('#loading').evaluate(status => status.textContent.includes('正在读取') && status.getBoundingClientRect().bottom <= document.querySelector('thead').getBoundingClientRect().top) && await page.locator('table').getAttribute('aria-busy') === 'true');
    await page.waitForFunction(() => document.querySelectorAll('#entries tr.new-row').length === 4);
    const arrivals = await page.locator('#entries tr').evaluateAll(rows => rows.map(row => {
      const animation = row.getAnimations().find(animation => animation.animationName === 'row-arrive');
      return { delay:animation.effect.getTiming().delay, duration:animation.effect.getTiming().duration, easing:animation.effect.getKeyframes()[0].easing, frames:animation.effect.getKeyframes().map(frame => ({filter:frame.filter,transform:frame.transform,opacity:frame.opacity})) };
    }));
    check('refresh replays a nonlinear blurred cascade on every row', arrivals.length === 4 && arrivals.every((entry,i) => entry.duration === 760 && entry.easing.startsWith('cubic-bezier') && entry.frames[0].filter === 'blur(5px)' && entry.frames[0].transform.includes('-14px') && (!i || entry.delay > arrivals[i-1].delay)));
    await page.waitForTimeout(300); await shot('arrival');
    await settled(); check('repeated refresh clicks coalesce', listRequests === 1);
    check('finished reveal leaves every row sharp and stationary', await page.locator('#entries tr').evaluateAll(rows => rows.every(row => getComputedStyle(row).filter === 'none' && getComputedStyle(row).opacity === '1' && getComputedStyle(row).transform === 'none')));
    for (const ratio of [0,.09,.99]) {
      capacityRatio = ratio; await page.locator('#refresh').click(); await settled(); await page.waitForTimeout(100);
      const meter = Number(await page.locator('#capacity-meter').getAttribute('aria-valuenow'));
      const fill = await page.locator('#drop-capacity-fill').evaluate(element => element.getBoundingClientRect().width / element.parentElement.clientWidth);
      check(`capacity rectangle reflects ${ratio*100}%`, Math.abs(meter / 100 - ratio) < .002 && Math.abs(fill - ratio) < .015);
    }
    capacityRatio = .09; await page.locator('#refresh').click(); await settled();
    if (!mobile) {
      await page.locator('.folder-float__trigger').hover();
      await page.waitForFunction(() => document.querySelector('.folder-float').hasAttribute('data-open'));
      await page.locator('h1').hover();
      await page.waitForFunction(() => !document.querySelector('.folder-float').hasAttribute('data-open'));
      checks.push('folder opens on hover and closes on pointer leave');
    }

    const row = page.getByRole('row').filter({has:page.getByRole('cell',{name:'样例 A.txt',exact:true})});
    if (!mobile) {
      const others = () => page.locator('.page-header,#drop,.list-heading,#entries tr:not(.hovered)').evaluateAll(elements => elements.map(element => ({top:element.getBoundingClientRect().top,transform:getComputedStyle(element).transform})));
      const before = await others();
      const original = await row.boundingBox();
      for (let cycle = 0; cycle < 3; cycle++) {
        await row.hover();
        if (cycle === 0) {
          await page.waitForTimeout(120);
          check('hover lifts gradually with a temporary Gaussian blur', await row.evaluate(row => parseFloat(getComputedStyle(row).transitionDuration) >= .8 && parseFloat(getComputedStyle(row).filter.replace('blur(','')) > .02) && (await row.boundingBox()).y > original.y - 7);
          await shot('depth-moving');
        }
        await page.waitForTimeout(920);
        check(`card hover ${cycle + 1} lifts by at least 7px`, (await row.boundingBox()).y < original.y - 7 && await row.evaluate(row => getComputedStyle(row).boxShadow !== 'none'));
        if (cycle === 0) {
          const box = await row.boundingBox();
          await page.mouse.move(box.x + box.width * .75, box.y + box.height * .6); await page.waitForTimeout(920);
          check('pointer changes the active card tilt', await row.evaluate(row => Math.abs(parseFloat(row.style.getPropertyValue('--row-ry'))) > .2));
          await shot('depth');
          await page.mouse.move(original.x + original.width / 2, original.y + original.height - 2); await page.waitForTimeout(920);
          check('card keeps its hover near the original lower edge', (await row.getAttribute('class')).includes('hovered'));
        }
        check('other surfaces remain stationary', await page.locator('.page-header,#drop,.list-heading,#entries tr:not(.hovered)').evaluateAll(elements => elements.every(element => new DOMMatrix(getComputedStyle(element).transform).isIdentity)));
        await page.locator('h1').hover(); await page.waitForTimeout(920);
        check('card settles on leave without lingering tilt', !(await row.getAttribute('class')).includes('hovered') && Math.abs((await row.boundingBox()).y - original.y) < 1);
      }
      const after = await others();
      check('hover cycles do not shift the header, upload area or list', before.length === after.length && before.every((entry,i) => Math.abs(entry.top-after[i].top)<1 && entry.transform===after[i].transform));
      await page.locator('#theme-toggle').click(); await page.locator('#theme-dark').click();
      await row.hover(); await page.waitForTimeout(920);
      check('dark theme preserves the floating card and stationary background', await row.evaluate(row => getComputedStyle(row).backgroundColor === getComputedStyle(document.getElementById('drop')).backgroundColor && getComputedStyle(document.querySelector('.page-header')).transform === 'none'));
      await shot('depth-dark'); await page.locator('h1').hover();
      await page.locator('#theme-toggle').click(); await page.locator('#theme-light').click();
      const directoryRow = page.getByRole('row').filter({has:page.getByRole('button',{name:'[目录] 子目录',exact:true})});
      await directoryRow.hover(); await page.waitForTimeout(920);
      check('directory card lifts and its folder icon opens', (await directoryRow.getAttribute('class')).includes('hovered') && await directoryRow.locator('.folder-icon-open').evaluate(icon => getComputedStyle(icon).opacity === '1'));
      await page.emulateMedia({ reducedMotion:'reduce' });
      check('reduced motion stops card transforms', await directoryRow.evaluate(row => getComputedStyle(row).transform === 'none'));
      await page.emulateMedia({ reducedMotion:'no-preference' }); await page.locator('h1').hover(); await page.waitForTimeout(920);
    }
    const directoryButton = page.getByRole('button',{name:'[目录] 子目录',exact:true});
    await directoryButton.focus(); await directoryButton.press('Enter');
    await page.getByText('空目录',{exact:true}).waitFor();
    check('folder opens by keyboard and updates the breadcrumb', await page.locator('#breadcrumbs button').last().textContent() === '子目录');
    await page.getByRole('button',{name:'返回上级目录',exact:true}).click();
    await row.waitFor(); await settled();
    if (mobile) check('touch folder navigation leaves no hover card', await page.locator('#entries tr.hovered').count() === 0);
    const restingBox = await row.boundingBox();
    const originalRow = await row.elementHandle();
    const originalEntry = await row.locator('.file-entry').elementHandle();
    await row.getByRole('button',{name:'删除',exact:true}).click();
    await page.waitForTimeout(920);
    check('delete mode lifts the entire card and spans its width', await row.evaluate(row => row.classList.contains('delete-active') && getComputedStyle(row).boxShadow !== 'none' && row.querySelector('.delete-control.open').getBoundingClientRect().width >= row.getBoundingClientRect().width - 2) && (await row.boundingBox()).y < restingBox.y - 7);
    check('trash handle is at the far right and the label says slide left', (await row.getByRole('slider').getAttribute('aria-label')).includes('左滑') && await row.locator('.slide-commit__arrow svg').count() === 1);
    check('delete transforms the original row and keeps the original filename visible', await row.evaluate((row, original) => row === original, originalRow) && await row.locator('.file-entry').evaluate((entry, original) => entry === original && getComputedStyle(entry).opacity === '1', originalEntry));
    check('active deletion has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (!mobile) {
      const activeBox = await row.boundingBox();
      await page.mouse.move(activeBox.x + activeBox.width * .75, activeBox.y + activeBox.height * .6); await page.waitForTimeout(920);
      check('delete card uses the existing pointer tilt with stronger depth', await row.evaluate(row => row.classList.contains('hovered') && Math.abs(parseFloat(row.style.getPropertyValue('--row-ry'))) > .8 && getComputedStyle(row).getPropertyValue('--row-lift') === '-15px'));
      await page.locator('h1').hover(); await page.waitForTimeout(920);
    }
    let slider = row.getByRole('slider'); await slider.press('End');
    await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow') === '100');
    check('End positions the slider without deleting', await row.count() === 1 && await slider.getAttribute('aria-valuenow') === '100');
    await slider.press('Escape'); await row.getByRole('button',{name:'删除',exact:true}).click();
    check('reopened delete slider starts at zero', await slider.getAttribute('aria-valuenow') === '0');
    await page.waitForTimeout(920);
    let box = await row.locator('.slide-commit__track').boundingBox();
    let startX = box.x + box.width - box.height / 2, endX = box.x + box.height / 2 - 2, centerY = box.y + box.height / 2;
    // Only grabbing the trash handle can begin a drag; touching the far endpoint is inert.
    await page.mouse.click(box.x + box.height / 2, centerY);
    check('clicking the left endpoint does not advance or delete', await slider.getAttribute('aria-valuenow') === '0' && await row.count() === 1);
    await page.mouse.move(startX,centerY); await page.mouse.down(); await page.mouse.move(startX - (startX-endX)*.35,centerY,{steps:6}); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow') === '0');
    check('partial drag springs home and preserves file', await row.count() === 1); await shot('slider');
    await slider.press('ArrowLeft');
    await page.waitForFunction(() => Number(document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')) > 0);
    check('left arrow advances toward deletion', Number(await slider.getAttribute('aria-valuenow')) > 0);
    await slider.press('ArrowRight'); await slider.press('Home');
    await row.getByRole('button',{name:'取消删除',exact:true}).click();
    check('cancel restores the regular card', !((await row.getAttribute('class')) || '').includes('delete-active') && await row.getByRole('slider').count() === 0);
    check('cancel returns focus to the original trash button', await row.getByRole('button',{name:'删除',exact:true}).evaluate(button => button === document.activeElement));
    await row.getByRole('button',{name:'删除',exact:true}).click();
    await page.waitForTimeout(920);
    if (mobile) {
      const cdp = await context.newCDPSession(page);
      box = await row.locator('.slide-commit__track').boundingBox();
      startX = box.x + box.width - box.height / 2; endX = box.x + box.height / 2 - 2; centerY = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:startX,y:centerY}]});
      for (let step=1;step<=10;step++) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:startX+(endX-startX)*step/10,y:centerY}]});
      await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow') === '100');
      check('reaching the left edge waits for release', await row.count() === 1 && await row.locator('.slide-commit').getAttribute('data-phase') === 'idle');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
      await page.waitForFunction(() => document.querySelector('[role="slider"]')?.getAttribute('aria-valuenow') === '0');
      check('system-cancelled touch never deletes, even at the endpoint', await row.count() === 1 && await row.locator('.slide-commit').getAttribute('data-phase') === 'idle');
      await cdp.detach();
    }
    await page.route('**/api/clouddrive/remove?**', async route => {
      await page.unroute('**/api/clouddrive/remove?**');
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'模拟删除失败'})});
    });
    await slider.press('End'); await slider.press('Enter');
    await row.locator('.slide-commit[data-phase="error"]').waitFor();
    check('failed deletion preserves row and offers retry', await row.count() === 1); await page.waitForTimeout(650);
    await slider.press('Home');
    await row.locator('.slide-commit').scrollIntoViewIfNeeded();
    box = await row.locator('.slide-commit__track').boundingBox();
    startX = box.x + box.width - box.height / 2; endX = box.x + box.height / 2 - 2; centerY = box.y + box.height / 2;
    if (mobile) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:startX,y:centerY}]});
      for (let step=1;step<=10;step++) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:startX+(endX-startX)*step/10,y:centerY}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    } else {
      await page.mouse.move(startX,centerY); await page.waitForTimeout(920);
      box = await row.locator('.slide-commit__track').boundingBox();
      startX = box.x + box.width - box.height / 2; endX = box.x + box.height / 2 - 4; centerY = box.y + box.height / 2;
      await page.mouse.move(startX,centerY);await page.mouse.down();await page.mouse.move(endX,centerY,{steps:12});await page.mouse.up();
    }
    await row.locator('.slide-commit[data-phase="done"]').waitFor();
    await page.waitForTimeout(240);
    const success = await row.locator('.slide-commit__capsule').evaluate(element => getComputedStyle(element).backgroundColor);
    check('confirmed deletion shows a red success capsule before row removal', await row.getByText('已删除',{exact:true}).first().isVisible() && success === 'rgb(207, 59, 59)');
    await shot('deleted'); await row.waitFor({state:'detached'}); checks.push(mobile ? 'touch slide deletes successfully' : 'mouse slide deletes successfully');

    await page.evaluate(() => { const transfer=new DataTransfer();transfer.setData('text/plain','text');document.body.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer:transfer})); });
    check('text drag does not activate upload animation', !(await page.locator('#drop').getAttribute('class') || '').includes('drag'));
    await drag(page,'dragover');
    await page.waitForFunction(() => document.querySelector('.folder-float')?.hasAttribute('data-open') && document.querySelector('.flying-button__craft'));
    await page.waitForTimeout(350);
    check('file drag opens the original folder and flying capsule', await page.locator('#flight canvas').count() === 1 && await page.locator('#flight .flying-button__pod').count() === 2);
    await shot('flight');
    await page.keyboard.press('Escape'); check('cancelled file drag removes the flight engine', await page.locator('#flight').isHidden());
    await drag(page,'dragover'); await page.waitForTimeout(100); await drag(page,'drop');
    check('release starts the folder docking path', await page.locator('#flight').getAttribute('data-phase') === 'docking');
    await page.getByRole('cell',{name:'火箭上传.txt',exact:true}).waitFor();
    await page.waitForFunction(() => document.getElementById('flight').hidden && !document.querySelector('.folder-float')?.hasAttribute('data-open'));
    checks.push('docking completes and folder closes after real upload');

    if (!smoke) {
      let releaseChunks;
      const chunkGate = new Promise(resolve => { releaseChunks = resolve; });
      await page.route('**/chunk/**',async route => { if (!route.request().url().endsWith('/0')) await chunkGate;try {await route.continue();} catch {} });
      await page.locator('#file').setInputFiles(fixture);
      await page.waitForFunction(async () => {
        const id = localStorage.getItem('clouddrive-pending-upload');
        if (!id) return false;
        const session = await fetch(`/api/clouddrive/upload-session/${id}`).then(response => response.json());
        return session.completed.length === 1;
      });
      await page.waitForFunction(() => {
        const meter = document.getElementById('upload-meter'), value = Number(meter.getAttribute('aria-valuenow'));
        const fill = meter.querySelector('.upload-fill').getBoundingClientRect().width / meter.clientWidth;
        return value > 0 && value < 100 && Math.abs(fill-value/100) < .02;
      });
      const percent = Number(await page.locator('#upload-meter').getAttribute('aria-valuenow'));
      const fillRatio = await page.locator('.upload-fill').evaluate(fill => fill.getBoundingClientRect().width / fill.parentElement.clientWidth);
      check('one slim progress bar follows real upload bytes', percent>0 && percent<100 && Math.abs(fillRatio-percent/100)<.02 && await page.getByRole('progressbar').count() === 1 && (await page.locator('#upload-meter').boundingBox()).height === 22);
      check('upload panel is compact and particles move while uploading', (await page.locator('#upload').boundingBox()).height < (mobile ? 185 : 150) && await page.locator('#upload-particles i').evaluateAll(dots => dots.length === 18 && dots.every(dot => getComputedStyle(dot).animationPlayState === 'running')));
      check('card and bar share the real progress and animated wave mask', await page.locator('.upload-ambience').evaluate(card => {
        const fill = document.querySelector('.upload-fill'), style = getComputedStyle(card);
        return Math.abs(card.getBoundingClientRect().width / card.parentElement.clientWidth - fill.getBoundingClientRect().width / fill.parentElement.clientWidth) < .01 && style.maskImage.includes('radial-gradient') && style.animationPlayState === 'running' && getComputedStyle(fill).animationPlayState === 'running';
      }) && await page.locator('#upload-card-particles i').evaluateAll(dots => dots.length === 18 && dots.every(dot => getComputedStyle(dot).animationPlayState === 'running')));
      check('upload controls are labeled icons and upload bytes use MB', await page.locator('.upload-actions button').evaluateAll(buttons => buttons.every(button => !button.textContent.trim() && button.querySelector('svg') && button.getAttribute('aria-label'))) && (await page.locator('#upload-bytes').textContent()).includes('MB'));
      await shot('upload'); await page.getByRole('button',{name:'暂停上传',exact:true}).click();
      await page.waitForFunction(() => document.getElementById('upload').dataset.state === 'paused');
      const id = await page.evaluate(() => localStorage.getItem('clouddrive-pending-upload'));
      const saved = await page.request.get(`${base}${api}/upload-session/${id}`).then(response => response.json());
      check('pause retains one saved chunk and immediate resume', saved.completed.length === 1 && await page.getByRole('button',{name:'继续上传',exact:true}).isVisible());
      check('paused progress stops particles without a redundant toast', await page.locator('#upload-particles i').evaluateAll(dots => dots.every(dot => getComputedStyle(dot).animationPlayState === 'paused')) && !(await page.locator('#toast').textContent()).includes('已暂停'));
      check('paused card and wave stop together', await page.locator('.upload-flow,.upload-particles i').evaluateAll(elements => elements.every(element => getComputedStyle(element).animationPlayState === 'paused')));
      await page.emulateMedia({ reducedMotion:'reduce' });
      check('reduced motion removes particle and shimmer animations', await page.locator('#upload-particles i').evaluateAll(dots => dots.every(dot => getComputedStyle(dot).animationName === 'none')) && await page.locator('.upload-fill').evaluate(fill => getComputedStyle(fill,'::before').animationName === 'none'));
      await page.emulateMedia({ reducedMotion:'no-preference' });
      await shot('paused');
      releaseChunks(); await page.unroute('**/chunk/**'); await page.getByRole('button',{name:'继续上传',exact:true}).click();
      await page.getByRole('cell',{name:'motion-fixture.bin',exact:true}).waitFor(); checks.push('paused upload resumes and completes');
    }
    const download = page.getByRole('link',{name:'下载',exact:true}).first();
    check('download and delete are labeled SVG icon buttons', await download.locator('svg').count() === 1 && await download.textContent() === '');
    check('no remote assets or downloaded fonts', requests.every(request => new URL(request.url()).origin === new URL(base).origin) && requests.every(request => !['font','stylesheet'].includes(request.resourceType())) && await page.locator('img,video').count() === 0);
    check('no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors,[], 'no page errors or CSP violations'); checks.push('no page errors or CSP violations');
    await shot('light');
    return {device:mobile?'mobile':'desktop',checks};
  } catch (error) {
    console.error('Failure URL',page.url(),'errors',errors);
    console.error('Failure state', await page.locator('.delete-control').evaluateAll(elements => elements.filter(element => element.classList.contains('open')).map(element => ({html:element.outerHTML,rect:element.getBoundingClientRect().toJSON()}))));
    await shot('failure');
    throw error;
  } finally {
    await page.request.delete(`${base}${api}/remove?path=${encodeURIComponent(directory)}`); await context.close();
  }
}
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const records=[];
    for (const mobile of process.argv.includes('--mobile-only') ? [true] : [false,true]) records.push(await testDevice(browser,mobile));
    const iconContext = await browser.newContext({viewport:{width:1000,height:900},colorScheme:'light'}), iconPage = await iconContext.newPage();
    const iconErrors = []; iconPage.on('pageerror', error => iconErrors.push(error.message));
    const samples = ['报告.PDF','数据.xlsx','压缩包.tar.gz','歌曲.mp3','照片.webp','配置.json','模型.pt','应用.exe','陌生格式.qwerty','README','.env','中文<svg>.txt'];
    await iconPage.route('**/api/clouddrive/list?**',route => route.fulfill({json:{sub:'',maxSize:10*1024**3,totalSize:0,entries:samples.map(name => ({name,isDir:false,size:1234,modified:'2026-10-28T00:00:00Z'}))}}));
    await iconPage.goto(base,{waitUntil:'networkidle'});
    for (const name of samples) {
      const sampleRow = iconPage.getByRole('row').filter({has:iconPage.getByRole('cell',{name,exact:true})});
      assert.equal(await sampleRow.locator('.entry-icon > svg').count(),1,name);
      assert.equal(await sampleRow.locator('.file-name').textContent(),name);
    }
    assert.equal(await iconPage.locator('.entry-icon [id^="pageGradient"]').evaluateAll(elements => new Set(elements.map(element => element.id)).size),samples.length);
    assert.deepEqual(iconErrors,[]);
    await iconPage.screenshot({path:path.join(artifacts,'file-icons-preview.png'),fullPage:true});
    await iconContext.close(); records.push({device:'file-icons',checks:['PDF, office, archive, media, code, model and app types render','unknown extensions and extensionless names have fallback icons','uppercase, compound extensions, dotfiles and HTML-like filenames are safe','SVG gradient IDs are unique']});
    const context=await browser.newContext({reducedMotion:'reduce'}),page=await context.newPage();
    await page.addInitScript(() => localStorage.setItem('clouddrive-motion','on'));
    await page.goto(base,{waitUntil:'networkidle'});await drag(page,'dragover');
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.motion),'off');
    assert(await page.locator('#flight').isHidden()); assert.equal(await page.locator('#motion-toggle').count(),0);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.waitForFunction(()=>document.documentElement.dataset.motion === 'on');
    await drag(page,'dragover');
    await page.waitForFunction(()=>!!document.querySelector('.flying-button__craft'));
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>document.documentElement.dataset.motion === 'off');
    assert(await page.locator('#flight').isHidden());
    await context.close();records.push({device:'reduced-motion',checks:['system preference controls animation; stale manual setting is ignored; live changes stop the flight']});
    // Lack of WebGL removes only smoke, not the original flight controller or upload gesture.
    const fallback=await browser.newContext();const fallbackPage=await fallback.newPage();
    await fallbackPage.addInitScript(() => {
      const original=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){return type.startsWith('webgl')?null:original.call(this,type,...args);};
    });
    await fallbackPage.goto(base,{waitUntil:'networkidle'});await drag(fallbackPage,'dragover');
    await fallbackPage.locator('.flying-button__craft').waitFor();
    await fallbackPage.waitForTimeout(100);
    assert((await fallbackPage.locator('.flying-button__craft').boundingBox()).y>0);
    await fallback.close();records.push({device:'no-webgl',checks:['flight controller works without smoke']});
    const preview = await browser.newPage({viewport:{width:1280,height:1050},colorScheme:'light'});
    await preview.goto(base,{waitUntil:'networkidle'});
    await preview.screenshot({path:path.join(artifacts,'round2-preview.png'),fullPage:true});
    await preview.close();
    fs.writeFileSync(path.join(artifacts,'motion-results.json'),JSON.stringify({base,records},null,2));
    console.log(JSON.stringify({base,records},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);if(error.actual)console.error(JSON.stringify(error.actual,null,2));process.exitCode=1;});

