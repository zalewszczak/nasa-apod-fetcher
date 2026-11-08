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
  let r = await h.source({ category: 'space', item: 'apod', iconPixelSize: { w: 200, h: 228 } });
  ok(!!r.data, 'source returns data');
  const props = r.data.instances[0].properties;
  ok(props.title.longText.text === 'Test & Nebula 2026-11-07', 'video skipped, entity decoded: ' + props.title.longText.text);
  ok(props.title.shortText.text.length <= 7, 'title shortText short: "' + props.title.shortText.text + '"');
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

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
