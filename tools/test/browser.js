// Loads src/config.html in headless Chromium with the real plugin bundle behind a mock Pebble host.
// usage: node tools/test/browser.js <fixtureDir> <screenshotDir>
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..', '..');
const fx = process.argv[2], shots = process.argv[3];
const mock = `
  (function(){ var src=null,cfg=null,ready=[];
    window.Pebble = { registerSourceHandler:function(f){src=f}, registerConfigHandler:function(f){cfg=f}, refreshSources:function(){},
      permissions:{ query:function(){ return Promise.resolve(window.__denied||'granted'); } },
      sendMessage:function(t,m){ return new Promise(function(res){ cfg(m,res); }); },
      addEventListener:function(ev,fn){ if(ev==='ready') setTimeout(function(){ fn({target:'plugin'}); },50); } };
  })();`;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const cors = { 'access-control-allow-origin': '*' };
  const e = (d, t) => ({ date: d, title: 'The Cat’s Paw &amp; Friends', permalink: 'https://science.nasa.gov/x/', media_type: t, explanation: '<p>A long explanation.</p>', hdurl: 'https://assets.science.nasa.gov/img/big.jpg', credit: 'Image Credit: <a>NASA</a>' });
  const today = new Date().toISOString().slice(0, 10);
  await page.route('https://science.nasa.gov/wp-json/**', r => r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify([e(today, 'image')]) }));
  await page.route('https://assets.science.nasa.gov/img/**', r => r.fulfill({ status: 200, headers: cors, contentType: 'image/jpeg', body: fs.readFileSync(path.join(fx, r.request().url().includes('?w=') ? 'small.jpg' : 'big.jpg')) }));
  await page.addInitScript({ content: mock });
  await page.addInitScript({ content: fs.readFileSync(path.join(root, 'src/plugin/index.js'), 'utf8') });
  await page.goto('file://' + path.join(root, 'src/config.html'));
  await page.waitForFunction(() => /^Works/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  console.log('status:', await page.textContent('#status'));
  console.log('canvas:', await page.evaluate(() => { const c = document.getElementById('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return c.width + 'x' + c.height + ' lit px ' + n; }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'config-light.png'), fullPage: true });
  await page.selectOption('#preset', '260x260'); await page.selectOption('#color', 'gray'); await page.click('#fetch');
  await page.waitForFunction(() => /260/.test(document.getElementById('canvasCap').textContent), null, { timeout: 15000 });
  await page.click('#save'); await page.waitForFunction(() => /^Saved/.test(document.getElementById('status').textContent));
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shots, 'config-dark-round-gray.png'), fullPage: true });
  console.log('page errors:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
