/* eslint-disable no-unused-vars */
import * as internals from "./playerController.js";

export function createPlayerControllerMethods08() {
  const {
    Platform,
    AVPLAY_BUFFER_FOR_PLAY_SECONDS,
    AVPLAY_BUFFER_FOR_RESUME_SECONDS,
    AVPLAY_BUFFERING_TIMEOUT_SECONDS,
    TIZEN_AVPLAY_DISPLAY_RECT_STATES,
    normalizeTizenAvPlayDisplayRect,
    syncTizenAvPlayObjectStyle
  } = internals;

  return {
    setAvPlayDisplayRect(rect = null, displayMethod = null, { honorRect = false } = {}) {
      const avplay = this.getAvPlay();
      if (!avplay) {
        return;
      }
      const viewport = this.getAvPlayViewportSize();
      if (Platform.isTizen() && displayMethod === "PLAYER_DISPLAY_MODE_LETTER_BOX" && !honorRect) {
        // AVPlay applies letterboxing inside the display area. Keep that area
        // fullscreen instead of passing an already letterboxed rectangle.
        this.avplayDisplayRect = {
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height
        };
      } else if (rect) {
        this.avplayDisplayRect = {
          x: Math.round(Number(rect.x || 0)),
          y: Math.round(Number(rect.y || 0)),
          width: Math.max(1, Math.round(Number(rect.width || viewport.width))),
          height: Math.max(1, Math.round(Number(rect.height || viewport.height)))
        };
      }
      if (displayMethod) {
        this.avplayDisplayMethod = String(displayMethod);
      }
      // Samsung forbids every other AVPlay call until seekTo() reports back.
      // Keep the desired geometry and apply it when the seek settles.
      if (Platform.isTizen() && this.avplaySeekInFlight) {
        this.avplayDisplayRectDeferred = true;
        return;
      }
      let targetRect = this.avplayDisplayRect || {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height
      };
      if (Platform.isTizen()) {
        targetRect = normalizeTizenAvPlayDisplayRect(targetRect, viewport);
        this.avplayDisplayRect = targetRect;
        syncTizenAvPlayObjectStyle(targetRect);
      }
      if (Platform.isTizen()) {
        let state = "";
        try {
          state = String(avplay.getState?.() || "")
            .trim()
            .toUpperCase();
        } catch (_) {
          return;
        }
        // Samsung rejects setDisplayRect/setDisplayMethod in NONE or other
        // transitional states. Keep the desired rectangle above and apply it
        // on the next IDLE/READY callback instead of issuing an invalid call.
        if (!TIZEN_AVPLAY_DISPLAY_RECT_STATES.has(state)) {
          return;
        }
      }
      try {
        avplay.setDisplayRect?.(targetRect.x, targetRect.y, targetRect.width, targetRect.height);
      } catch (_) {
        // Ignore display-rect failures.
      }
      try {
        avplay.setDisplayMethod?.(this.avplayDisplayMethod || "PLAYER_DISPLAY_MODE_FULL_SCREEN");
      } catch (_) {
        // Ignore display-method failures.
      }
    },
    reapplyTizenAvPlayDisplayRect(delayMs = 0) {
      if (!Platform.isTizen()) {
        return;
      }
      const apply = () => {
        if (this.isUsingAvPlay()) {
          this.setAvPlayDisplayRect();
        }
      };
      if (Number(delayMs || 0) > 0) {
        setTimeout(apply, Number(delayMs || 0));
        return;
      }
      apply();
    },
    teardownAvPlay() {
      this.clearAvPlaySeekTimeout();
      this.avplaySeekRequestToken = Number(this.avplaySeekRequestToken || 0) + 1;
      this.avplaySeekInFlight = false;
      this.avplayDisplayRectDeferred = false;
      this.avplayDeferredSeekMs = 0;
      this.avplayStartAfterSeek = null;
      this.avplaySeekTraceDumped = false;
      const avplay = this.getAvPlay();

      this.stopAvPlayTickTimer();
      if (avplay) {
        try {
          // Clear Samsung's native subtitle plane while AVPlay is still in a
          // state where setSilentSubtitle() is valid. Otherwise a corrupted
          // subtitle surface can remain visible after the player DOM is gone.
          avplay.setSilentSubtitle?.(true);
        } catch (_) {
          // Continue with stop/close even when the firmware rejects the toggle.
        }
        try {
          avplay.setListener?.({});
        } catch (_) {
          // Ignore listener reset failures.
        }
        try {
          const state = String(avplay.getState?.() || "").toUpperCase();
          if (state && state !== "NONE" && state !== "IDLE") {
            avplay.stop?.();
          }
        } catch (_) {
          // Ignore stop failures.
        }
        try {
          avplay.close?.();
        } catch (_) {
          // Ignore close failures.
        }
      }

      this.avplayActive = false;
      this.avplayUrl = "";
      this.avplayAudioTracks = [];
      this.avplaySubtitleTracks = [];
      this.selectedAvPlayAudioTrackIndex = -1;
      this.selectedAvPlaySubtitleTrackIndex = -1;
      this.pendingAvPlayAudioTrackIndex = -1;
      this.desiredAvPlayAudioTrackIndex = -1;
      this.desiredAvPlayAudioTrackUntil = 0;
      this.pendingAvPlaySubtitleTrackIndex = -1;
      this.pendingAvPlaySubtitleReactivation = false;
      this.desiredAvPlaySubtitleTrackIndex = -1;
      this.desiredAvPlaySubtitleTrackUntil = 0;
      this.avplaySubtitleSelectionToken = Number(this.avplaySubtitleSelectionToken || 0) + 1;
      this.avplaySubtitlesSilent = false;
      this.avplayNativeSubtitleRendering = false;
      this.avplaySubtitleRenderMode = "native";
      this.avplayExternalSubtitlePath = "";
      this.avplayExternalSubtitleDelayMs = 0;
      this.appliedAvPlayExternalSubtitleDelayKey = "";
      this.avplayReady = false;
      this.avplayEnded = false;
      this.avplayCurrentTimeMs = 0;
      this.avplayDurationMs = 0;
      this.avplayBufferingProgress = null;
      this.avplayBufferingStartedAt = 0;
      this.avplayLastBufferingDurationMs = 0;
      this.avplayLastErrorDiagnostic = null;
      this.appliedAvPlayPlaybackRate = 1;
    },
    configureAvPlayForSource(requestHeaders = {}) {
      const avplay = this.getAvPlay();
      if (!avplay || typeof avplay.setStreamingProperty !== "function") {
        return;
      }

      const headers = requestHeaders && typeof requestHeaders === "object" ? requestHeaders : {};
      const cookieHeader = Object.entries(headers).find(
        ([key]) =>
          String(key || "")
            .trim()
            .toLowerCase() === "cookie"
      )?.[1];
      const userAgentHeader = Object.entries(headers).find(
        ([key]) =>
          String(key || "")
            .trim()
            .toLowerCase() === "user-agent"
      )?.[1];

      try {
        if (cookieHeader) {
          avplay.setStreamingProperty("COOKIE", String(cookieHeader));
        }
      } catch (_) {
        // Ignore unsupported AVPlay header properties.
      }
      try {
        if (userAgentHeader) {
          avplay.setStreamingProperty("USER_AGENT", String(userAgentHeader));
        }
      } catch (_) {
        // Ignore unsupported AVPlay header properties.
      }
      try {
        if (Platform.isTizen()) {
          const isUhdPanel = Boolean(globalThis.webapis?.productinfo?.isUdPanelSupported?.());
          if (isUhdPanel) {
            // Samsung Tizen 3.0 UHD panels require SET_MODE_4K before prepareAsync
            // to allocate the full UHD hardware decoder pipeline and avoid macroblocking.
            avplay.setStreamingProperty("SET_MODE_4K", "TRUE");
          }
          const urlLower = String(this.avplayUrl || "").toLowerCase();
          const isAdaptive =
            urlLower.includes(".m3u8") ||
            urlLower.includes(".mpd") ||
            this.isLikelyHlsMimeType?.(this.currentPlaybackMediaSourceType) ||
            this.isLikelyDashMimeType?.(this.currentPlaybackMediaSourceType);
          if (isAdaptive) {
            const maxRes = isUhdPanel ? "3840x2160" : "1920x1080";
            avplay.setStreamingProperty("ADAPTIVE_INFO", `FIXED_MAX_RESOLUTION=${maxRes}|STARTBITRATE=AVERAGE`);
          }
        }
      } catch (_) {
        // Ignore on firmware that rejects SET_MODE_4K or ADAPTIVE_INFO.
      }
    },
    configureAvPlayBuffering() {
      const avplay = this.getAvPlay();
      if (!avplay) {
        return;
      }
      if (Platform.isTizen()) {
        if (globalThis.__NUVIO_LITE_MODE__ !== true) {
          // Match Stremio's Tizen AVPlay path on Tizen 4+.
          return;
        }
        // Tizen 3.0's default AVPlay prebuffer is very short (~1-2s), which causes
        // brief frame corruption / macroblocking on network jitter. Give VOD streams
        // a healthier buffer while keeping live streams responsive.
        const isLive = Boolean(this.isLivePlaybackItemType?.());
        const playBufferSec = isLive ? 1 : 5;
        const resumeBufferSec = isLive ? 2 : 10;
        const timeoutSec = isLive ? 12 : 25;
        try {
          avplay.setBufferingParam?.("PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", playBufferSec);
        } catch (_) {}
        try {
          avplay.setBufferingParam?.("PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", resumeBufferSec);
        } catch (_) {}
        try {
          avplay.setTimeoutForBuffering?.(timeoutSec);
        } catch (_) {}
        return;
      }

      try {
        avplay.setBufferingParam?.("PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", AVPLAY_BUFFER_FOR_PLAY_SECONDS);
      } catch (_) {
        // Older firmware can reject custom buffering parameters.
      }
      try {
        avplay.setBufferingParam?.("PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", AVPLAY_BUFFER_FOR_RESUME_SECONDS);
      } catch (_) {
        // Keep AVPlay's default resume buffer when unsupported.
      }
      try {
        avplay.setTimeoutForBuffering?.(AVPLAY_BUFFERING_TIMEOUT_SECONDS);
      } catch (_) {
        // Keep AVPlay's default timeout when unsupported.
      }
    }
  };
}
