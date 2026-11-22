<div align="center">

  <img src="assets/brand/app_logo_wordmark.png" alt="Nuvio" width="300" />

  <h1>NuvioTVSmart — Tizen 3 Lite</h1>

  <p>
    A lightweight, performance-focused fork of <a href="https://github.com/NuvioMedia/NuvioTVSmart">NuvioMedia/NuvioTVSmart</a> adapted for <strong>Samsung Tizen 3.x (2017) TVs</strong> running Chromium 47 (tested on Samsung UE55MU7400).
  </p>

[Upstream Repository](https://github.com/NuvioMedia/NuvioTVSmart) · [Nuvio Website](https://nuvio.tv)

</div>

## What's Different in Tizen 3 Lite?

Official Nuvio TV builds target **Samsung Tizen 4+ (Chromium 56+)** and do not run properly on 2017 Tizen 3.0 TVs (Chromium 47). This fork adds full Tizen 3.0 compatibility and Lite optimizations:

- **Tizen 3.0 / Chromium 47 Compatibility:**
  - Compiles all browser bundles (`app.bundle.js`, `core-js.bundle.js`, workers, ASS subtitle runtime) to pure **ES5** (`esbuild` + `@swc/core` + `regenerator-runtime`) with `core-js` polyfills targeting Chrome 47.
  - Adds lightweight DOM/Web API polyfills ([legacyDomPolyfills.js](./js/platform/legacyDomPolyfills.js)) for APIs missing in Chromium 47 (`URLSearchParams`, `URL.prototype.searchParams`, `NodeList.prototype.forEach`, `Node.prototype.isConnected`, `Element.prototype` helpers).
  - Resolves CSS custom properties (`var(--...)`) across all stylesheets and generates Flexbox fallbacks for `display: grid` so layouts, sidebars, buttons, and posters render at proper sizes on Chromium 47.
- **Lite Mode (Fluidity & Stability on 2017 Hardware):**
  - Removes P2P/Torrenting (`EngineFsService`), `PluginService`, and unused WASM/QuickJS payloads from the `.wgt` package while keeping `subtitle-autosync-worker.js` for subtitle auto-sync.
  - Disables heavy background tasks in Lite mode (`AmbientMode`, `FrameBudgetSampler`, `PartyEffects`, remote text webfonts) and tightens poster artwork cache/eviction budgets.
  - Eliminates subtitle picker lag via `O(1)` focus tracking, `offsetTop` scrolling, fast sorting, and removing redundant layout measurements/transitions.
- **Improved Playback, Subtitles & Live M3U Streams:**
  - Prioritizes Samsung's hardware **AVPlay** engine for HLS/M3U8 streams on Tizen 3.x instead of software `hls.js` demuxing.
  - Enables `SET_MODE_4K` on UHD panels (`isUdPanelSupported()`) and sets balanced AVPlay prebuffers (`5s/10s` for VOD, low-latency `1s/2s` for live) to prevent periodic frame corruption/macroblocking.
  - Adds a Chromium 47 `response.arrayBuffer()` fallback in `rangeProbe.js` so embedded MKV subtitle/audio track languages (`Turkish`, `English`, `Italian`, etc.) resolve instead of showing `Subtitle 1..15`.
  - Shows a real-time live buffer indicator bar (`Buffer %` / `Buffer Xs`) at the bottom of the player for live / M3U streams and supports **seeking forward toward the live edge** with the remote's Right arrow / Fast-Forward button (`seekLiveForward`).

> **Note on Supported Features:** Torrent/P2P playback and local Node.js `PluginService` are intentionally removed in Tizen 3 Lite. Direct HTTP/HTTPS, Debrid, IPTV/M3U, and Media Server (Jellyfin/Plex) playback work via Samsung AVPlay.

## Build from Source

Requires **Node.js** and **npm**:

```bash
git clone https://github.com/yusufbeyazit/NuvioTVSmart-Tizen3-Lite.git
cd NuvioTVSmart-Tizen3-Lite
npm install
npm run package:tizen3
```

This creates the unsigned Tizen 3 Lite package (`NuvioTV001_<version>.wgt`) in the repository root.

> **Optional (`local.properties`):** To enable official QR sign-in and metadata integrations, create a `local.properties` file based on `local.example.properties` before running `npm run package:tizen3`. Do **not** commit `local.properties` to Git.

## Installing on Samsung Tizen 3.x TV

You can install the generated `.wgt` without manually configuring Tizen Studio by using **[Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung)**:

1. On your Samsung TV, open **Apps**, press **`12345`** on the remote, enable **Developer Mode**, enter your PC's local IP address, and restart the TV.
2. Open **Apps2Samsung** on your PC (on the same Wi-Fi/LAN), select your TV, choose **Custom WGT**, pick the generated `NuvioTV001_<version>.wgt`, and click **Install**.

*(Alternatively, sign and install using Tizen Studio / Tizen CLI.)*

## License

This project is a fork of [NuvioMedia/NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart) and remains licensed under the [GNU General Public License v3.0](./LICENSE).
