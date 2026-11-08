/*
 * NASA Astronomy Picture of the Day - PebbleOS plugin (source: space/apod, instance "today").
 *
 * This file is bundled together with the vendored JPEG/PNG decoders into
 * src/plugin/index.js by tools/build-plugin.js. Plugin scripts are evaluated as a plain
 * script by the phone app (no module loader, no bundling), so NEVER add import/export here;
 * use require('...') only for the modules registered in the build script.
 *
 * Globals provided by the host: Pebble, fetch, localStorage, console, atob/btoa.
 */
'use strict';

var jpegDecode = require('jpeg-decoder');
var UPNG = require('upng-js');

var VERSION = '1.1.0';
var SOURCE_KEY = 'space/apod';
var ENDPOINT = 'https://science.nasa.gov/wp-json/wp/v2/apod-basic/';
var LIST_COUNT = 10;

var META_KEY = 'apod.meta.v2';
var SETTINGS_KEY = 'apod.settings.v1';
var IMG_INDEX_KEY = 'apod.imgindex.v1';
var IMG_PREFIX = 'apod.img.v1:';
var ERROR_KEY = 'apod.lasterror.v1';

var META_TTL_MS = 60 * 60 * 1000;
var STALE_TTL_MS = 10 * 60 * 1000;
var MAX_CACHED_BITMAPS = 6;
var DOWNLOAD_WIDTH = 1024;
var MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
var MAX_DECODE_PIXELS = 12000000;
var BACKGROUND = [5, 8, 18];
var REQUIRED_HOSTS = ['science.nasa.gov', 'assets.science.nasa.gov'];

var DEFAULTS = {
  fit: 'fill',          // 'fill' crops to cover the screen, 'fit' letterboxes
  color: 'color',       // 'color' = best 16 of the 64 Pebble colours, 'gray' = 4 grays
  dither: true,
  dim: 0,               // 0..70 percent darkening, so watchface text stays readable
  smallDownload: true,  // ask NASA's image CDN for a ~1024px wide file first
  skipVideos: true      // when today's APOD is a video, use the latest still image
};

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- small helpers

function makeLog() {
  var lines = [];
  var t0 = Date.now();
  function log(message) {
    lines.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + message);
    try { console.log('APOD: ' + message); } catch (e) { /* ignore */ }
  }
  log.lines = lines;
  return log;
}

function errText(e) {
  return (e && e.message) ? String(e.message) : String(e);
}

function storeGet(key) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

function storeRemove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

function clampInt(v, lo, hi, fallback) {
  var n = Math.round(Number(v));
  if (!isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function decodeEntities(s) {
  var named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', ndash: '-',
    mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: '(c)', deg: '°'
  };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, body) {
    if (body.charAt(0) === '#') {
      var code = body.charAt(1).toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    var v = named[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function stripHtml(html) {
  var s = String(html == null ? '' : html);
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function textOf(v) {
  if (v && typeof v === 'object') return v.rendered != null ? v.rendered : '';
  return v == null ? '' : v;
}

/** A short form for tiny slots: whole words up to ~7 characters, else a hard cut. */
function fitShort(text, max) {
  var s = oneLine(text);
  if (s.length <= max) return s;
  var words = s.split(' ');
  var out = '';
  for (var i = 0; i < words.length; i++) {
    var next = out ? out + ' ' + words[i] : words[i];
    if (next.length > max) break;
    out = next;
  }
  return out || s.slice(0, max);
}

function cleanImageUrl(url) {
  var s = String(url == null ? '' : url).trim();
  if (!/^https:\/\/[^\/]+\.nasa\.gov(\/|$)/i.test(s) && !/^https:\/\/nasa\.gov(\/|$)/i.test(s)) return '';
  return s;
}

function hostOf(url) {
  var m = /^https?:\/\/([^\/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

function looksLikeImageUrl(url) {
  return /\.(jpe?g|png)(\?|$)/i.test(String(url || ''));
}

// ---------------------------------------------------------------- settings

function sanitizeSettings(s) {
  s = s || {};
  return {
    fit: s.fit === 'fit' ? 'fit' : 'fill',
    color: s.color === 'gray' ? 'gray' : 'color',
    dither: s.dither === undefined ? DEFAULTS.dither : !!s.dither,
    dim: clampInt(s.dim, 0, 70, DEFAULTS.dim),
    smallDownload: s.smallDownload === undefined ? DEFAULTS.smallDownload : !!s.smallDownload,
    skipVideos: s.skipVideos === undefined ? DEFAULTS.skipVideos : !!s.skipVideos
  };
}

function loadSettings() {
  return sanitizeSettings(storeGet(SETTINGS_KEY));
}

// ---------------------------------------------------------------- NASA metadata

function dateCode(iso) {
  // The per-date endpoint takes the legacy YYMMDD form.
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? m[1].slice(2) + m[2] + m[3] : null;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var date = String(raw.date || '').slice(0, 10);
  var title = oneLine(stripHtml(textOf(raw.title)));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) return null;
  var type = String(raw.media_type || 'image').toLowerCase();
  var still = !/video|iframe|youtube|embed/.test(type);
  var image = cleanImageUrl(raw.hdurl);
  if (!image && looksLikeImageUrl(raw.url)) image = cleanImageUrl(raw.url);
  var credit = oneLine(stripHtml(raw.credit || raw.copyright || ''));
  return {
    date: date,
    title: title,
    explanation: stripHtml(textOf(raw.explanation)),
    credit: credit,
    media_type: type,
    page_url: String(raw.permalink || raw.url || ''),
    image_url: still ? image : '',
    thumb_url: image,
    alt: oneLine(stripHtml(raw.alt || ''))
  };
}

async function fetchEntries(date, log) {
  var url = date ? ENDPOINT + dateCode(date) : ENDPOINT + '?per_page=' + LIST_COUNT;
  log('GET ' + url);
  var response = await fetch(url);
  if (!response.ok) {
    if (response.status === 404 || response.status === 400) {
      throw new Error(date ? 'No APOD found for ' + date + ' (HTTP ' + response.status + ')' : 'NASA returned HTTP ' + response.status);
    }
    throw new Error('NASA API returned HTTP ' + response.status);
  }
  var data = await response.json();
  var list = Array.isArray(data) ? data : (data && data.date ? [data] : []);
  var entries = [];
  for (var i = 0; i < list.length; i++) {
    var e = normalizeEntry(list[i]);
    if (e) entries.push(e);
  }
  if (!entries.length) throw new Error('NASA API returned no usable entries');
  entries.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  log('got ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + ', newest ' + entries[0].date);
  return entries;
}

function pickEntry(entries, settings, specificDate) {
  if (specificDate || !settings.skipVideos) return { entry: entries[0], skipped: 0 };
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].image_url) return { entry: entries[i], skipped: i };
  }
  return { entry: entries[0], skipped: 0 };
}

/** Returns {entry, skipped, stale}. Serves a cached entry when NASA can't be reached. */
async function loadApod(settings, log, opts) {
  opts = opts || {};
  var cached = storeGet(META_KEY);
  var fresh = cached && cached.skipVideos === settings.skipVideos && (Date.now() - cached.savedAt) < META_TTL_MS;
  if (!opts.date && !opts.force && fresh) {
    log('metadata from cache (' + cached.entry.date + ')');
    return { entry: cached.entry, skipped: cached.skipped || 0, stale: false };
  }
  try {
    var entries = await fetchEntries(opts.date || null, log);
    var picked = pickEntry(entries, settings, opts.date);
    if (!opts.date) {
      storeSet(META_KEY, { savedAt: Date.now(), skipVideos: settings.skipVideos, entry: picked.entry, skipped: picked.skipped });
    }
    return { entry: picked.entry, skipped: picked.skipped, stale: false };
  } catch (e) {
    if (!opts.date && cached && cached.entry) {
      log('NASA unreachable (' + errText(e) + '); using cached ' + cached.entry.date);
      return { entry: cached.entry, skipped: cached.skipped || 0, stale: true };
    }
    throw e;
  }
}

// ---------------------------------------------------------------- image download

function hex(bytes, n) {
  var out = [];
  for (var i = 0; i < Math.min(n, bytes.length); i++) out.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
  return out.join(' ');
}

function sniffFormat(b) {
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  for (var i = 0; i < Math.min(b.length, 16); i++) {
    if (b[i] === 0x3C) return 'html';
    if (b[i] > 0x20) break;
  }
  return 'unknown';
}

function imageSize(b, fmt) {
  if (fmt === 'png' && b.length > 24) {
    return { w: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0,
             h: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
  }
  if (fmt === 'jpeg') {
    var i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      var m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}

/**
 * Download an image as REAL bytes. The phone app's fetch() only returns binary-safe data when
 * asked with responseType: 'arraybuffer'; without it the body is decoded as text and every
 * byte >= 0x80 is destroyed (PNG's 0x89 arrives as 0xFD).
 */
async function downloadImage(url, log) {
  var started = Date.now();
  log('GET ' + url);
  var response = await fetch(url, { responseType: 'arraybuffer' });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + hostOf(url));
  var length = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0) || 0;
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('file is ' + Math.round(length / 1048576) + ' MB, too large');
  var type = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
  var buffer = await response.arrayBuffer();
  var bytes = new Uint8Array(buffer);
  var fmt = sniffFormat(bytes);
  log('downloaded ' + bytes.length + ' bytes in ' + (Date.now() - started) + ' ms, content-type "' + type + '", looks like ' + fmt + ', first bytes: ' + hex(bytes, 8));
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('file too large');
  if (fmt !== 'jpeg' && fmt !== 'png') {
    var hint = '';
    if (bytes.length > 2 && bytes[0] === 0xFD && bytes[1] === 0xFD) {
      hint = ' (bytes look text-decoded: this phone app ignored responseType:"arraybuffer")';
    } else if (fmt === 'webp') {
      hint = ' (WebP is not supported)';
    }
    throw new Error('not a JPEG/PNG image: ' + fmt + hint);
  }
  return { bytes: bytes, buffer: buffer, format: fmt, contentType: type };
}

function decodeImage(file, log) {
  var started = Date.now();
  var size = imageSize(file.bytes, file.format);
  if (size) {
    log('image is ' + size.w + 'x' + size.h + ' (' + (size.w * size.h / 1e6).toFixed(1) + ' MP)');
    if (size.w * size.h > MAX_DECODE_PIXELS) {
      throw new Error('image is ' + size.w + 'x' + size.h + ', too big to decode on the phone');
    }
  }
  var out;
  if (file.format === 'jpeg') {
    var j = jpegDecode(file.bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true,
      maxResolutionInMP: 14, maxMemoryUsageInMB: 160 });
    out = { width: j.width, height: j.height, data: j.data };
  } else {
    var png = UPNG.decode(file.buffer);
    var frames = UPNG.toRGBA8(png);
    out = { width: png.width, height: png.height, data: new Uint8Array(frames[0]) };
  }
  log('decoded in ' + (Date.now() - started) + ' ms');
  return out;
}

// ---------------------------------------------------------------- scaling + quantising

/** Area-average downscale (bilinear when enlarging) into tw x th RGB, cover or letterbox. */
function scaleToTarget(img, tw, th, fit) {
  var src = img.data, sw = img.width, sh = img.height;
  var out = new Uint8Array(tw * th * 3);
  for (var i = 0; i < out.length; i += 3) { out[i] = BACKGROUND[0]; out[i + 1] = BACKGROUND[1]; out[i + 2] = BACKGROUND[2]; }

  var scale, srcX0, srcY0, srcW, srcH, dstX0, dstY0, dstW, dstH;
  if (fit === 'fit') {
    scale = Math.min(tw / sw, th / sh);
    dstW = Math.max(1, Math.round(sw * scale)); dstH = Math.max(1, Math.round(sh * scale));
    dstX0 = Math.floor((tw - dstW) / 2); dstY0 = Math.floor((th - dstH) / 2);
    srcX0 = 0; srcY0 = 0; srcW = sw; srcH = sh;
  } else {
    scale = Math.max(tw / sw, th / sh);
    srcW = Math.min(sw, tw / scale); srcH = Math.min(sh, th / scale);
    srcX0 = (sw - srcW) / 2; srcY0 = (sh - srcH) / 2;
    dstX0 = 0; dstY0 = 0; dstW = tw; dstH = th;
  }

  function put(dx, dy, r, g, b, a) {
    var o = ((dstY0 + dy) * tw + dstX0 + dx) * 3;
    if (a < 255) {
      var k = a / 255;
      r = r * k + BACKGROUND[0] * (1 - k); g = g * k + BACKGROUND[1] * (1 - k); b = b * k + BACKGROUND[2] * (1 - k);
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
  }

  var x, y;
  if (scale >= 1) {
    // Enlarging: bilinear sampling.
    for (y = 0; y < dstH; y++) {
      var fy = srcY0 + (y + 0.5) * srcH / dstH - 0.5;
      var y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy))), y1 = Math.min(sh - 1, y0 + 1), wy = Math.max(0, Math.min(1, fy - y0));
      for (x = 0; x < dstW; x++) {
        var fx = srcX0 + (x + 0.5) * srcW / dstW - 0.5;
        var x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx))), x1 = Math.min(sw - 1, x0 + 1), wx = Math.max(0, Math.min(1, fx - x0));
        var p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4, p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
        var ch = [0, 0, 0, 0];
        for (var c = 0; c < 4; c++) {
          ch[c] = (src[p00 + c] * (1 - wx) + src[p10 + c] * wx) * (1 - wy) + (src[p01 + c] * (1 - wx) + src[p11 + c] * wx) * wy;
        }
        put(x, y, ch[0], ch[1], ch[2], ch[3]);
      }
    }
    return out;
  }

  // Shrinking: every source pixel in the region is added to the target cell its centre falls in.
  var sums = new Float32Array(dstW * dstH * 3);
  var counts = new Float32Array(dstW * dstH);
  var colMap = new Int32Array(sw);
  var xs0 = Math.max(0, Math.floor(srcX0)), xs1 = Math.min(sw, Math.ceil(srcX0 + srcW));
  var ys0 = Math.max(0, Math.floor(srcY0)), ys1 = Math.min(sh, Math.ceil(srcY0 + srcH));
  for (x = xs0; x < xs1; x++) {
    var cx = Math.floor((x + 0.5 - srcX0) * dstW / srcW);
    colMap[x] = (cx < 0 || cx >= dstW) ? -1 : cx;
  }
  for (y = ys0; y < ys1; y++) {
    var cy = Math.floor((y + 0.5 - srcY0) * dstH / srcH);
    if (cy < 0 || cy >= dstH) continue;
    var rowBase = y * sw;
    for (x = xs0; x < xs1; x++) {
      var cell = colMap[x];
      if (cell < 0) continue;
      var p = (rowBase + x) * 4;
      var a = src[p + 3] / 255;
      var t = (cy * dstW + cell);
      sums[t * 3] += src[p] * a + BACKGROUND[0] * (1 - a);
      sums[t * 3 + 1] += src[p + 1] * a + BACKGROUND[1] * (1 - a);
      sums[t * 3 + 2] += src[p + 2] * a + BACKGROUND[2] * (1 - a);
      counts[t] += 1;
    }
  }
  for (y = 0; y < dstH; y++) {
    for (x = 0; x < dstW; x++) {
      var q = y * dstW + x;
      if (counts[q] > 0) put(x, y, sums[q * 3] / counts[q], sums[q * 3 + 1] / counts[q], sums[q * 3 + 2] / counts[q], 255);
    }
  }
  return out;
}

function gcolor(r2, g2, b2) { return 0xC0 | (r2 << 4) | (g2 << 2) | b2; }

var GRAY_PALETTE = [gcolor(0, 0, 0), gcolor(1, 1, 1), gcolor(2, 2, 2), gcolor(3, 3, 3)];

function colorOf(byte) {
  return [((byte >> 4) & 3) * 85, ((byte >> 2) & 3) * 85, (byte & 3) * 85];
}

function dist(r1, g1, b1, r2, g2, b2) {
  var dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return 3 * dr * dr + 6 * dg * dg + db * db;
}

/** Greedily pick the n colours (out of the watch's 64) that best represent the image. */
function choosePalette(rgb, n) {
  var counts = new Float64Array(4096), sr = new Float64Array(4096), sg = new Float64Array(4096), sb = new Float64Array(4096);
  var i;
  for (i = 0; i < rgb.length; i += 3) {
    var k = ((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4);
    counts[k]++; sr[k] += rgb[i]; sg[k] += rgb[i + 1]; sb[k] += rgb[i + 2];
  }
  var bins = [];
  for (i = 0; i < 4096; i++) if (counts[i] > 0) bins.push({ w: counts[i], r: sr[i] / counts[i], g: sg[i] / counts[i], b: sb[i] / counts[i] });
  var cands = [];
  for (var c = 0; c < 64; c++) {
    var byte = gcolor(c >> 4, (c >> 2) & 3, c & 3);
    var col = colorOf(byte);
    cands.push({ byte: byte, r: col[0], g: col[1], b: col[2], used: false });
  }
  var best = new Float64Array(bins.length);
  for (i = 0; i < best.length; i++) best[i] = Infinity;
  var palette = [];
  for (var round = 0; round < n; round++) {
    var bestGain = -1, bestIdx = -1;
    for (var ci = 0; ci < cands.length; ci++) {
      if (cands[ci].used) continue;
      var gain = 0;
      for (i = 0; i < bins.length; i++) {
        var d = dist(bins[i].r, bins[i].g, bins[i].b, cands[ci].r, cands[ci].g, cands[ci].b);
        if (best[i] === Infinity) gain += bins[i].w * (1e6 - d); else if (d < best[i]) gain += bins[i].w * (best[i] - d);
      }
      if (gain > bestGain) { bestGain = gain; bestIdx = ci; }
    }
    if (bestIdx < 0 || (round > 0 && bestGain <= 0)) break;
    var pick = cands[bestIdx];
    pick.used = true;
    palette.push(pick.byte);
    for (i = 0; i < bins.length; i++) {
      var dd = dist(bins[i].r, bins[i].g, bins[i].b, pick.r, pick.g, pick.b);
      if (dd < best[i]) best[i] = dd;
    }
  }
  return palette;
}

/** Map RGB to palette indices, optionally with serpentine Floyd-Steinberg error diffusion. */
function quantize(rgb, w, h, paletteBytes, dither) {
  var pal = paletteBytes.map(colorOf);
  var idx = new Uint8Array(w * h);
  var buf = new Float32Array(rgb.length);
  for (var i = 0; i < rgb.length; i++) buf[i] = rgb[i];
  function nearest(r, g, b) {
    var bi = 0, bd = Infinity;
    for (var p = 0; p < pal.length; p++) {
      var d = dist(r, g, b, pal[p][0], pal[p][1], pal[p][2]);
      if (d < bd) { bd = d; bi = p; }
    }
    return bi;
  }
  for (var y = 0; y < h; y++) {
    var ltr = !dither || (y % 2 === 0);
    for (var s = 0; s < w; s++) {
      var x = ltr ? s : w - 1 - s;
      var o = (y * w + x) * 3;
      var r = Math.max(0, Math.min(255, buf[o])), g = Math.max(0, Math.min(255, buf[o + 1])), b = Math.max(0, Math.min(255, buf[o + 2]));
      var pi = nearest(r, g, b);
      idx[y * w + x] = pi;
      if (!dither) continue;
      var er = r - pal[pi][0], eg = g - pal[pi][1], eb = b - pal[pi][2];
      var dir = ltr ? 1 : -1;
      diffuse(buf, w, h, x + dir, y, 7 / 16, er, eg, eb);
      diffuse(buf, w, h, x - dir, y + 1, 3 / 16, er, eg, eb);
      diffuse(buf, w, h, x, y + 1, 5 / 16, er, eg, eb);
      diffuse(buf, w, h, x + dir, y + 1, 1 / 16, er, eg, eb);
    }
  }
  return idx;
}

function diffuse(buf, w, h, px, py, f, er, eg, eb) {
  if (px < 0 || px >= w || py >= h) return;
  var q = (py * w + px) * 3;
  buf[q] += er * f; buf[q + 1] += eg * f; buf[q + 2] += eb * f;
}

function toBase64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 4096) {
    var chunk = bytes.subarray(i, Math.min(bytes.length, i + 4096));
    var part = '';
    for (var j = 0; j < chunk.length; j++) part += String.fromCharCode(chunk[j]);
    s += part;
  }
  return btoa(s);
}

function packBitmap(idx, w, h, paletteBytes) {
  var stride = (w + 1) >> 1;
  var pixels = new Uint8Array(stride * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var v = idx[y * w + x] & 15;
      var o = y * stride + (x >> 1);
      pixels[o] |= (x & 1) ? v : (v << 4);
    }
  }
  return { pixels: toBase64(pixels), palette: toBase64(new Uint8Array(paletteBytes)), width: w, height: h };
}

function convert(img, w, h, settings, log) {
  var started = Date.now();
  var rgb = scaleToTarget(img, w, h, settings.fit);
  var i;
  if (settings.dim > 0) {
    var k = 1 - settings.dim / 100;
    for (i = 0; i < rgb.length; i++) rgb[i] = rgb[i] * k;
  }
  if (settings.color === 'gray') {
    for (i = 0; i < rgb.length; i += 3) {
      var l = rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = l;
    }
  }
  var palette = settings.color === 'gray' ? GRAY_PALETTE.slice() : choosePalette(rgb, 16);
  var idx = quantize(rgb, w, h, palette, settings.dither);
  var bitmap = packBitmap(idx, w, h, palette);
  log('converted to ' + w + 'x' + h + ', ' + palette.length + ' colours in ' + (Date.now() - started) + ' ms');
  return bitmap;
}

// ---------------------------------------------------------------- bitmap cache + pipeline

function bitmapKey(entry, w, h, s) {
  return IMG_PREFIX + [entry.date, w, h, s.fit, s.color, s.dither ? 1 : 0, s.dim, s.smallDownload ? 1 : 0].join('|');
}

function cacheBitmap(key, value) {
  var index = storeGet(IMG_INDEX_KEY) || [];
  index = index.filter(function (k) { return k !== key; });
  index.push(key);
  while (index.length > MAX_CACHED_BITMAPS) storeRemove(index.shift());
  if (!storeSet(key, value)) {
    // Quota: drop everything older and retry once.
    while (index.length > 1) storeRemove(index.shift());
    storeSet(key, value);
  }
  storeSet(IMG_INDEX_KEY, index);
}

function clearBitmapCache() {
  var index = storeGet(IMG_INDEX_KEY) || [];
  for (var i = 0; i < index.length; i++) storeRemove(index[i]);
  storeRemove(IMG_INDEX_KEY);
  storeRemove(META_KEY);
}

function resizedUrl(url) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'w=' + DOWNLOAD_WIDTH;
}

/** Returns {bitmap, info}. */
async function getBitmap(entry, w, h, settings, log, opts) {
  opts = opts || {};
  var key = bitmapKey(entry, w, h, settings);
  if (!opts.force) {
    var hit = storeGet(key);
    if (hit && hit.bitmap) { log('bitmap from cache'); return { bitmap: hit.bitmap, info: hit.info, cached: true }; }
  }
  var urls = [];
  if (settings.smallDownload) urls.push(resizedUrl(entry.image_url));
  urls.push(entry.image_url);
  var lastError = null;
  for (var i = 0; i < urls.length; i++) {
    try {
      var file = await downloadImage(urls[i], log);
      var img = decodeImage(file, log);
      var bitmap = convert(img, w, h, settings, log);
      var info = { url: urls[i], bytes: file.bytes.length, format: file.format, sourceWidth: img.width, sourceHeight: img.height };
      cacheBitmap(key, { bitmap: bitmap, info: info });
      return { bitmap: bitmap, info: info, cached: false };
    } catch (e) {
      lastError = e;
      log('failed: ' + errText(e));
      if (e && e.name === 'NotAllowedError') break;
    }
  }
  throw lastError || new Error('image download failed');
}

// ---------------------------------------------------------------- source properties

function isoToParts(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

function propertiesFor(entry, wants) {
  var p = {};
  var parts = isoToParts(entry.date);
  if (wants('name')) p.name = { shortText: { text: 'APOD' }, longText: { text: 'NASA Astronomy Picture of the Day' } };
  if (wants('title')) p.title = { shortText: { text: fitShort(entry.title, 7) }, longText: { text: entry.title } };
  if (wants('date') && parts) {
    p.date = {
      shortText: { text: MONTHS[parts.m - 1] + ' ' + parts.d },
      longText: { text: parts.d + ' ' + MONTHS_LONG[parts.m - 1] + ' ' + parts.y },
      timestamp: { value: Math.floor(Date.UTC(parts.y, parts.m - 1, parts.d) / 1000) }
    };
  }
  if (wants('explanation') && entry.explanation) p.explanation = { longText: { text: entry.explanation } };
  if (wants('credit') && entry.credit) p.credit = { longText: { text: entry.credit } };
  if (wants('alt') && entry.alt) p.alt = { longText: { text: entry.alt } };
  if (wants('media_type')) p.media_type = { shortText: { text: entry.media_type } };
  if (wants('image_url') && entry.image_url) p.image_url = { longText: { text: entry.image_url } };
  if (wants('page_url') && entry.page_url) p.page_url = { longText: { text: entry.page_url } };
  return p;
}

// ---------------------------------------------------------------- source handler

Pebble.registerSourceHandler(async function (request, respond) {
  if (request.category !== 'space' || request.item !== 'apod') {
    respond.error('PLUGIN_UNAVAILABLE', 'this plugin only serves ' + SOURCE_KEY);
    return;
  }
  var log = makeLog();
  var settings = loadSettings();
  var apod;
  try {
    apod = await loadApod(settings, log, {});
  } catch (e) {
    storeSet(ERROR_KEY, { at: Date.now(), message: errText(e) });
    respond.error(e && e.name === 'NotAllowedError' ? 'PERMISSION_DENIED' : 'UNKNOWN', errText(e));
    return;
  }
  var wants = function (name) { return !request.properties || request.properties.indexOf(name) >= 0; };
  var props = propertiesFor(apod.entry, wants);
  var size = request.iconPixelSize;
  if (wants('image') && size && apod.entry.image_url) {
    try {
      var w = clampInt(size.w, 1, 260, 144), h = clampInt(size.h, 1, 260, 168);
      var result = await getBitmap(apod.entry, w, h, settings, log, {});
      props.image = { image: result.bitmap };
      storeRemove(ERROR_KEY);
    } catch (e) {
      storeSet(ERROR_KEY, { at: Date.now(), message: errText(e), log: log.lines.slice(-8) });
      console.error('APOD image failed: ' + errText(e));
    }
  }
  respond.data({
    validUntilMs: Date.now() + (apod.stale ? STALE_TTL_MS : META_TTL_MS),
    instances: [{ instanceId: 'today', properties: props }]
  });
});

// ---------------------------------------------------------------- config page conversation

async function missingPermissions() {
  var perms = Pebble.permissions;
  if (!perms || typeof perms.query !== 'function') return null;
  var missing = [];
  for (var i = 0; i < REQUIRED_HOSTS.length; i++) {
    try {
      var state = await perms.query('Internet/' + REQUIRED_HOSTS[i]);
      var value = state && typeof state === 'object' ? (state.state || state.status) : state;
      if (value && value !== 'granted') missing.push(REQUIRED_HOSTS[i]);
    } catch (e) { /* unknown: don't nag */ }
  }
  return missing;
}

Pebble.registerConfigHandler(async function (message, respond) {
  var type = message && message.type;
  var log = makeLog();
  try {
    if (type === 'init') {
      respond({
        version: VERSION,
        settings: loadSettings(),
        defaults: sanitizeSettings({}),
        lastError: storeGet(ERROR_KEY),
        missingPermissions: await missingPermissions()
      });
    } else if (type === 'save') {
      var s = sanitizeSettings(message.settings);
      storeSet(SETTINGS_KEY, s);
      try { Pebble.refreshSources([SOURCE_KEY]); } catch (e) { /* ignore */ }
      respond({ ok: true, settings: s });
    } else if (type === 'clearCache') {
      clearBitmapCache();
      storeRemove(ERROR_KEY);
      respond({ ok: true });
    } else if (type === 'preview') {
      var settings = sanitizeSettings(message.settings || loadSettings());
      var w = clampInt(message.width, 1, 260, 144), h = clampInt(message.height, 1, 260, 168);
      var date = /^\d{4}-\d{2}-\d{2}$/.test(message.date || '') ? message.date : null;
      var res = { version: VERSION, width: w, height: h };
      try {
        var apod = await loadApod(settings, log, { date: date, force: true });
        res.entry = apod.entry;
        res.skipped = apod.skipped;
        res.stale = apod.stale;
        if (!apod.entry.image_url) {
          res.imageError = 'This entry is a ' + apod.entry.media_type + ', not a still image.';
        } else {
          try {
            var r = await getBitmap(apod.entry, w, h, settings, log, { force: true });
            res.image = r.bitmap;
            res.info = r.info;
            storeRemove(ERROR_KEY);
          } catch (e) {
            res.imageError = errText(e);
          }
        }
      } catch (e) {
        res.error = errText(e);
      }
      res.missingPermissions = await missingPermissions();
      res.log = log.lines;
      respond(res);
    } else {
      respond({ error: 'unknown message type: ' + type });
    }
  } catch (e) {
    respond({ error: errText(e), log: log.lines });
  }
});
