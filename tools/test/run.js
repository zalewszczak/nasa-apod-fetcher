// Runs the built plugin (src/plugin/index.js) in a node vm with a mock of the phone host.
// usage: node tools/test/run.js [fixtureDir] [outDir]
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const fx = process.argv[2] || path.join(__dirname, 'fixtures');
const outDir = process.argv[3] || path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const script = fs.readFileSync(path.join(root, 'src/plugin/index.js'), 'utf8');
let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };

const entry = (date, type, hd) => ({ date, post_id: 1, title: 'Test &amp; Nebula ' + date, permalink: 'https://science.nasa.gov/image-detail/x/', media_type: type,
  explanation: '<p>An <b>explanation</b> &amp; more.</p>', url: 'https://science.nasa.gov/image-detail/x/', hdurl: hd, credit: 'Image Credit: <a href="#">Someone</a>' });

function makeHost(opts) {
  const store = {}; let handler, cfg; const calls = [];
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {} }, atob, btoa, Date, Math, JSON, Uint8Array, Float32Array, Float64Array, Int32Array, ArrayBuffer, Promise, Error, String, Number, Array, Object, RegExp, Infinity, isFinite, parseInt, Map,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    Pebble: { registerSourceHandler: f => { handler = f; }, registerConfigHandler: f => { cfg = f; }, refreshSources: k => { calls.push(['refresh', k]); }, permissions: { query: async () => 'granted' } },
    fetch: async (url, init) => {
      calls.push(url);
      const respond = (status, body, type) => ({ ok: status < 400, status, headers: { get: h => (h.toLowerCase() === 'content-type' ? type : null) }, json: async () => JSON.parse(body.toString()),
        arrayBuffer: async () => {
          let b = Buffer.from(body);
          if (!(init && init.responseType === 'arraybuffer') && !opts.binarySafe) { // emulate the phone's text-decoding bug
            b = Buffer.from(Array.from(b).map(v => (v >= 0x80 ? 0xFD : v)));
          }
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        } });
      if (url.startsWith('https://science.nasa.gov/wp-json/')) {
        const code = /apod-basic\/(\d{6})$/.exec(url);
        if (code) { const e = opts.list.find(x => x.date.slice(2).replace(/-/g, '') === code[1]); return e ? respond(200, JSON.stringify(e), 'application/json') : respond(404, '', 'text/html'); }
        return respond(200, JSON.stringify(opts.list), 'application/json');
      }
      if (url.startsWith('https://img.youtube.com/')) {
        if (!opts.yt || url.includes('maxresdefault')) return respond(404, '', 'text/html');
        return respond(200, fs.readFileSync(path.join(fx, 'small.jpg')), 'image/jpeg');
      }
      if (url.includes('/dynamicimage/')) {
        const w = +(/[?&]w=(\d+)/.exec(url) || [0, 99999])[1];
        const file = opts.dynTiny ? 'tiny.jpg' : (w <= 1100 ? 'small.jpg' : 'big.jpg');
        return respond(200, fs.readFileSync(path.join(fx, file)), 'image/jpeg');
      }
      if (url.includes('/img/')) {
        const name = opts.images[url.split('?')[0]]; if (!name) return respond(404, '', 'text/html');
        const hasW = url.includes('?w='); const file = (hasW && opts.resizerWorks) ? opts.small : name;
        return respond(200, fs.readFileSync(path.join(fx, file)), file.endsWith('png') ? 'image/png' : 'image/jpeg');
      }
      return respond(404, '', 'text/html');
    },
  };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(script, ctx, { filename: 'index.js' });
  return { ctx, calls, store, source: (req) => new Promise(res => handler(req, { data: d => res({ data: d }), error: (c, m) => res({ error: c + ': ' + m }) })), config: (msg) => new Promise(res => cfg(msg, res)) };
}

// Mirrors the phone app's ShapeValidation for bitmaps.
function validBitmap(b, w, h) {
  const px = Buffer.from(b.pixels, 'base64'), pal = Buffer.from(b.palette, 'base64');
  return b.width <= w && b.height <= h && px.length === ((b.width + 1) >> 1) * b.height && pal.length >= 1 && pal.length <= 16 && pal.every(v => (v & 0xC0) === 0xC0);
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const imgs = { 'https://assets.science.nasa.gov/img/big.jpg': 'big.jpg', 'https://assets.science.nasa.gov/img/sq.png': 'square.png', 'https://assets.science.nasa.gov/img/alpha.png': 'alpha.png' };
  const base = { list: [entry('2026-11-08', 'video', 'https://assets.science.nasa.gov/img/big.jpg'), entry('2026-11-07', 'image', 'https://assets.science.nasa.gov/img/big.jpg'), entry('2026-11-06', 'image', 'https://assets.science.nasa.gov/img/sq.png')], images: imgs, small: 'small.jpg', resizerWorks: true };

  // 1. Source handler, resizer honoured, video skipped.
  let h = makeHost(base);
  await h.config({ type: 'save', settings: { skipVideos: true } });
  let r = await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 200, h: 228 } });
  ok(!!r.data, 'source returns data');
  const props = r.data.instances[0].properties;
  ok(props.title.longText.text === 'Test & Nebula 2026-11-07', 'video skipped, entity decoded: ' + props.title.longText.text);
  ok(props.title.shortText.text === props.title.longText.text, 'title shortText carries the full title by default');
  ok(props.date.timestamp.value === Date.UTC(2026, 10, 7) / 1000, 'date timestamp');
  ok(props.explanation.longText.text === 'An explanation & more.', 'explanation stripped');
  ok(props.image && validBitmap(props.image.image, 200, 228), 'image valid 200x228 (' + props.image.image.width + 'x' + props.image.image.height + ')');
  ok(h.calls.some(u => u.includes('?w=1024')), 'asked for resized file first');
  fs.writeFileSync(path.join(outDir, 'emery.json'), JSON.stringify(props.image.image));

  // 2. Property filter + no size => no image fetched.
  const n0 = h.calls.length;
  r = await h.source({ category: 'space', item: 'apod', properties: ['title'] });
  ok(Object.keys(r.data.instances[0].properties).join() === 'title', 'property filter honoured');
  ok(h.calls.length === n0, 'metadata served from cache (no network)');

  // 3. Cached bitmap on second image request.
  const n1 = h.calls.length;
  await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 200, h: 228 } });
  ok(h.calls.length === n1, 'bitmap served from cache');

  // 4. Resizer ignored -> big JPEG decoded; other sizes + modes.
  h = makeHost(Object.assign({}, base, { resizerWorks: false }));
  for (const [w, hh, extra] of [[144, 168, {}], [260, 260, {}], [180, 180, {}]]) {
    const t = Date.now();
    r = await h.source({ category: 'space', item: 'apod', iconPixelSize: { w, h: hh } });
    const b = r.data.instances[0].properties.image && r.data.instances[0].properties.image.image;
    ok(b && validBitmap(b, w, hh), `big.jpg -> ${w}x${hh} valid in ${Date.now() - t} ms`);
    if (b) fs.writeFileSync(path.join(outDir, `big-${w}x${hh}.json`), JSON.stringify(b));
  }

  // 5. PNG + alpha, grayscale, fit, no dither, dim via config.
  for (const [name, date, st] of [['png', '2026-11-06', {}], ['gray', '2026-11-07', { color: 'gray' }], ['fit', '2026-11-07', { fit: 'fit' }], ['nodither', '2026-11-07', { dither: false, dim: 40 }]]) {
    h = makeHost(base);
    await h.config({ type: 'save', settings: st });
    const p = await h.config({ type: 'preview', width: 200, height: 228, date, settings: st });
    ok(p.image && validBitmap(p.image, 200, 228), `preview ${name}: ok ${p.imageError || ''}`);
    if (p.image) fs.writeFileSync(path.join(outDir, `preview-${name}.json`), JSON.stringify(p.image));
  }

  // 6. Binary-mangling phone: our code requests arraybuffer so it works; without it detect + explain.
  h = makeHost(base);
  ok(!!(await h.config({ type: 'preview', width: 100, height: 100 })).image, 'works on a phone that mangles non-arraybuffer bodies');
  h = makeHost(base); h.ctx.fetch = ((orig) => (u, i) => orig(u, Object.assign({}, i, { responseType: undefined })))(h.ctx.fetch);
  const bad = await h.config({ type: 'preview', width: 100, height: 100 });
  ok(!bad.image && /text-decoded|not a JPEG/.test(bad.imageError || ''), 'mangled bytes produce a clear error: ' + bad.imageError);

  // 7. alpha PNG small -> upscale path.
  h = makeHost(Object.assign({}, base, { list: [entry('2026-11-08', 'image', 'https://assets.science.nasa.gov/img/alpha.png')] }));
  const up = await h.config({ type: 'preview', width: 260, height: 260 });
  ok(up.image && validBitmap(up.image, 260, 260), 'upscaling path valid');

  // 8. Error paths.
  h = makeHost(Object.assign({}, base, { list: [] }));
  r = await h.source({ category: 'space', item: 'apod' });
  ok(!!r.error, 'empty list -> error: ' + r.error);
  h = makeHost(base); r = await h.source({ category: 'x', item: 'y' }); ok(/PLUGIN_UNAVAILABLE/.test(r.error), 'wrong source rejected');
  const init = await makeHost(base).config({ type: 'init' });
  ok(init.version && init.settings.fit === 'fill' && Array.isArray(init.missingPermissions), 'config init');

  // 9. NASA resizer URLs: rewrite w/h to a watch-sized thumbnail (hdurl already carries w/h/crop).
  const dyn = 'https://assets.science.nasa.gov/dynamicimage/assets/science/cds/apod/apod/2026/november/big.jpg?w=4000&h=2600&fit=clip&crop=faces%2Cfocalpoint';
  h = makeHost(Object.assign({}, base, { list: [entry('2026-11-08', 'image', dyn)] }));
  r = await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 200, h: 228 } });
  const want = 'big.jpg?w=702&h=456&fit=clip';
  ok(h.calls.includes('https://assets.science.nasa.gov/dynamicimage/assets/science/cds/apod/apod/2026/november/' + want), 'resizer URL rewritten to ' + want + ' (calls: ' + h.calls.slice(1).join(' | ') + ')');
  ok(!h.calls.some(u => /w=.*w=/.test(u)), 'no duplicated w parameter');
  ok(!h.calls.some(u => u.includes('w=4000')), 'huge rendition never downloaded');
  ok(validBitmap(r.data.instances[0].properties.image.image, 200, 228), 'thumbnail converted');
  const dam = 'https://assets.science.nasa.gov/content/dam/science/cds/apod/apod/2026/november/big.jpg';
  h = makeHost(Object.assign({}, base, { list: [entry('2026-11-08', 'image', dam)] }));
  await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 144, h: 168 } });
  ok(h.calls.some(u => u.includes('/dynamicimage/assets/science/cds/apod/apod/2026/november/big.jpg?w=1024&fit=clip')), 'content/dam original mapped to resizer');
  // known-huge hdurl whose thumbnail fails is not downloaded as-is
  const huge = 'https://assets.science.nasa.gov/dynamicimage/assets/x/huge.jpg?w=9000&h=6000&fit=clip';
  h = makeHost(Object.assign({}, base, { list: [entry('2026-11-08', 'image', huge)] }));
  h.ctx.fetch = ((o) => async (u, i) => (u.includes('huge.jpg') ? { ok: false, status: 500, headers: { get: () => null } } : o(u, i)))(h.ctx.fetch);
  const hp = await h.config({ type: 'preview', width: 200, height: 228 });
  ok(!hp.image && hp.entry && !(hp.log || []).some(l => /GET .*huge\.jpg$/.test(l)), 'oversized hdurl is not fetched raw');

  // 10. Small source: placed 1:1, centred, in the upper two thirds (no enlargement).
  h = makeHost(Object.assign({}, base, { list: [entry('2026-11-08', 'image', dyn)], dynTiny: true }));
  const sm = await h.config({ type: 'preview', width: 200, height: 228, settings: { dither: false } });
  const pxs = Buffer.from(sm.image.pixels, 'base64'), pal = Buffer.from(sm.image.palette, 'base64'), st = 100;
  let x0 = 999, x1 = -1, y0 = 999, y1 = -1;
  for (let y = 0; y < 228; y++) for (let x = 0; x < 200; x++) { const v = pxs[y * st + (x >> 1)], i = (x & 1) ? v & 15 : v >> 4, g = pal[i]; if (((g >> 4) & 3) + ((g >> 2) & 3) + (g & 3) >= 3) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  ok(x0 === 40 && x1 === 159 && y0 === 31 && y1 === 120, `120x90 thumbnail at 1:1: x ${x0}-${x1}, y ${y0}-${y1} (expect 40-159, 31-120: centred in top 152px)`);

  // 11. Title setting.
  h = makeHost(base);
  let t = (await h.source({ category: 'space', item: 'apod', properties: ['title'] })).data.instances[0].properties.title;
  ok(t.shortText.text === t.longText.text && t.longText.text.length > 7, 'full title in shortText by default');
  await h.config({ type: 'save', settings: { titleShort: 'abbrev' } });
  t = (await h.source({ category: 'space', item: 'apod', properties: ['title'] })).data.instances[0].properties.title;
  ok(t.shortText.text.length <= 7 && t.longText.text.startsWith('Test & Nebula'), 'abbreviated short text on request, long text still full');

  // 12. Video days: thumbnail instead of nothing.
  const ytVideo = Object.assign(entry('2026-11-09', 'video', ''), { url: 'https://www.youtube.com/embed/abcDEF12345?rel=0', hdurl: '' });
  const still = entry('2026-11-08', 'image', 'https://assets.science.nasa.gov/img/sq.png');
  // 12a. NASA-provided thumbnail field wins.
  const withThumb = Object.assign(entry('2026-11-09', 'video', ''), { url: 'https://www.youtube.com/embed/abcDEF12345', hdurl: '', thumbnail_url: 'https://assets.science.nasa.gov/img/sq.png' });
  h = makeHost(Object.assign({}, base, { list: [withThumb, still] }));
  let vr = (await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 200, h: 228 } })).data.instances[0].properties;
  ok(vr.image && validBitmap(vr.image.image, 200, 228) && vr.date.timestamp.value === Date.UTC(2026, 10, 9) / 1000, 'video day shows its own thumbnail (NASA thumbnail field)');
  ok(!h.calls.some(u => u.includes('youtube')), 'YouTube not contacted when NASA supplies a thumbnail');
  // 12b. Only a YouTube id: derived still, maxres 404 -> mqdefault.
  h = makeHost(Object.assign({}, base, { list: [ytVideo, still], yt: true }));
  vr = (await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 200, h: 228 } })).data.instances[0].properties;
  ok(vr.image && validBitmap(vr.image.image, 200, 228) && vr.date.timestamp.value === Date.UTC(2026, 10, 9) / 1000, 'video day uses YouTube still');
  ok(h.calls.some(u => u.endsWith('/abcDEF12345/maxresdefault.jpg')) && h.calls.some(u => u.endsWith('/abcDEF12345/mqdefault.jpg')), 'tried maxres then mq');
  // 12c. No thumbnail obtainable: fall back to the latest still, never empty.
  h = makeHost(Object.assign({}, base, { list: [ytVideo, still], yt: false }));
  vr = (await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 200, h: 228 } })).data.instances[0].properties;
  ok(vr.image && validBitmap(vr.image.image, 200, 228), 'falls back to a still picture when the thumbnail fails');
  // 12d. Video with no thumbnail source at all: pickEntry skips to the still.
  const bare = Object.assign(entry('2026-11-09', 'video', ''), { url: 'https://vimeo.com/123', hdurl: '' });
  h = makeHost(Object.assign({}, base, { list: [bare, still] }));
  vr = (await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 200, h: 228 } })).data.instances[0].properties;
  ok(vr.image && vr.date.timestamp.value === Date.UTC(2026, 10, 8) / 1000, 'no thumbnail at all -> latest still');
  // 12e. Repeat request for the same picture is served from the bitmap cache.
  const a = entry('2026-11-09', 'image', 'https://assets.science.nasa.gov/img/sq.png');
  h = makeHost(Object.assign({}, base, { list: [a] }));
  await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 100, h: 100 } });
  const nImg = h.calls.filter(u => u.includes('/img/')).length;
  await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 100, h: 100 } });
  ok(h.calls.filter(u => u.includes('/img/')).length === nImg, 'same picture: served from cache');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
