# NASA APOD – PebbleOS plugin

Serves NASA's **Astronomy Picture of the Day** to other PebbleOS apps and watchfaces as a plugin
source: title, date, explanation, credit, links, and the picture itself as a watch-ready
4-bpp palettised image sized to whatever the subscriber asks for.

| | |
|---|---|
| Source | category `space`, item `apod`, instance `today` |
| Data | `https://science.nasa.gov/wp-json/wp/v2/apod-basic/` – **no API key needed** |
| Config page | live preview of the fetch + conversion, framing/colour/dither/dim options |

## Install

```
pebble build          # plain plugin project: the .pbw only holds the script + config page
```

Install `build/*.pbw` through the Pebble phone app (plugins preview enabled), then:

1. Open the plugin's **permissions** and allow Internet access for `science.nasa.gov`,
   `assets.science.nasa.gov` (and `apod.nasa.gov`, only used for some archive entries).
   Plugins have no network until you do; the config page shows a banner if one is missing.
2. Open the plugin's **settings**. It fetches today's picture right away and shows
   *what a watchface receives* next to the original. Use **Diagnostics** to see each step.
3. Press **Save settings** to apply them to watchfaces.

The script in `src/plugin/index.js` is already built. You only need `npm run build:plugin`
(plain Node, no packages) after editing `tools/plugin/main.js`.

## What was wrong with the previous version, and the fixes

* **`import` statements** – the phone app evaluates a plugin script as a *plain script* and the
  SDK does not bundle it, so `import ... from "jpeg-js"` is a syntax error and the plugin never
  started. The decoders are now bundled at build time into one classic script
  (`tools/build-plugin.js`). `node_modules` is no longer needed or shipped.
* **Wrong property shapes** – values must be wrapped in their shape name
  (`title: { longText: { text } }`); the old code returned bare `{ text }`, which the host drops.
* **Binary downloads are corrupted by default** – the phone's `fetch` only hands back real bytes
  when called with `responseType: 'arraybuffer'`; otherwise the body is text-decoded and masked to
  8 bits (PNG's `0x89` arrives as `0xFD`). The plugin always passes it, checks the magic bytes
  (JPEG `FF D8 FF`, PNG `89 50 4E 47`) and, if the bytes look mangled, says so in the error.
* **Old NASA API** – `api.nasa.gov/planetary/apod?api_key=…` is being retired in favour of the
  `science.nasa.gov` WordPress endpoint, which returns an *array*, needs no key, and uses
  `hdurl` for the image and `url` for the article page. Videos have no usable image.
* **Missing project files** – added `wscript` and `configPage` in `package.json`.
* **Host limits respected** – 20 s per source request (bitmaps and metadata are cached in
  `localStorage`), image no bigger than the requested size (max 260×260), ≤16 palette colours.

## How the image is made

1. NASA's `hdurl` is itself an image-resizer URL, e.g.
   `https://assets.science.nasa.gov/dynamicimage/assets/science/cds/apod/apod/2026/x.jpg?w=1772&h=1182&fit=clip&crop=faces%2Cfocalpoint`,
   so its `w`/`h` tell us the picture size before downloading anything. The plugin rewrites them
   (dropping `crop`) to a **thumbnail just big enough for the watch** (2x oversampled, never
   enlarged) - typically 20-80 KB instead of megabytes. Originals under `/content/dam/` are
   mapped to the same resizer; any other host gets `?w=1024`. If the thumbnail request fails,
   the plain `hdurl` is tried, unless its `w`/`h` show it is over 12 MP.
   (Setting *Ask NASA for a smaller file first* turns this off.)
2. Check magic bytes and header dimensions (refuses > 12 MP rather than crash the phone).
3. Decode JPEG (jpeg-js, incl. progressive) or PNG (UPNG + pako).
4. Area-average downscale to the requested size (fill = crop to cover, or fit = letterbox).
   A picture that is already smaller than the requested size is **not enlarged**: it is placed
   1:1, centred horizontally and within the upper two thirds of the image.
5. Optional dim, optional grayscale.
6. Pick the best 16 of the watch's 64 colours for *this* picture, then map pixels with
   Floyd–Steinberg dithering. Pack two pixels per byte, base64.

## Properties

| property | shapes |
|---|---|
| `name` | shortText, longText |
| `title` | longText = full title; shortText = full title too (setting *Title*), or ~7 chars if set to abbreviated |
| `date` | shortText ("Nov 8"), longText ("8 November 2026"), timestamp |
| `explanation`, `credit`, `alt`, `image_url`, `page_url` | longText |
| `media_type` | shortText |
| `image` | image – only when the subscriber sets `iconPixelSize` |

If today's APOD is a video, the latest still picture is served (setting: *Skip videos*).

The host only *warns* about a `shortText` over ~7 characters and keeps it. A watchface that wants
the title for a wide slot should read `title.longText.text`, which is always the full title.

## Using it from a watchface (PKJS)

```js
Pebble.subscribeToSource({
  category: 'space', item: 'apod',
  properties: ['title', 'image'],
  iconPixelSize: { w: 200, h: 228 },          // your screen; max 260x260
  onData: function (envelope) {
    var p = envelope.instances[0].properties;
    var title = p.title && p.title.longText.text;
    var img = p.image && p.image.image;      // { pixels, palette, width, height } (base64)
  },
  onError: function (err) { console.log(err.code); }
});
```

## Troubleshooting

* **Banner about Internet access** – allow the listed domains in the plugin's permissions.
* **"not a JPEG/PNG image: unknown (bytes look text-decoded…)"** – the phone app ignored
  `responseType`; please report your app version.
* **"image is … too big to decode"** – NASA's resizer didn't answer and the original is huge.
* **"WebP is not supported"** – the CDN returned WebP; turn off *smaller file first*.
* Anything else: Settings → *Diagnostics* shows the timestamped log of the last fetch.

## Layout

```
package.json            manifest (sources, permissions, config page)
src/plugin/index.js     GENERATED single-file plugin (what ships)
src/config.html         settings page with live preview
src/icon.svg            app-selector icon (24x24 line art: watch outline, ringed planet, "APOD")
tools/plugin/main.js    plugin source – edit this, then: npm run build:plugin
tools/vendor/           jpeg-js (Apache-2.0), UPNG.js (MIT), pako (MIT) + licences
tools/test/             mock-phone tests (see run.js / browser.js; fixtures via make-fixtures.py)
```
