/* eslint-disable no-unused-vars */
import * as internals from "./playerController.js";

export function createPlayerControllerMethods09() {
  const { Platform, logTizenAvPlayDebug, isTizenAvPlayDebugEnabled } = internals;

  return {
    playWithAvPlay(url, requestHeaders = {}, _sourceType = null, playToken = null) {
      if (!this.canUseAvPlay()) {
        return false;
      }
      if (!this.isPlaybackRequestActive(playToken, url)) {
        return false;
      }

      const avplay = this.getAvPlay();
      if (!avplay) {
        return false;
      }

      this.teardownAvPlay();

      this.avplayUrl = String(url || "");
      this.avplayReady = false;
      this.avplayEnded = false;
      this.avplayCurrentTimeMs = 0;
      this.avplayTimelinePolledAt = 0;
      this.avplayDurationMs = 0;
      this.avplaySubtitleDiagnosticCallbackPendingAt = 0;
      this.lastPlaybackErrorCode = 0;
      this.playbackEngine = this.getPlatformAvplayEngineName();
      this.emitVideoEvent("waiting", { playbackEngine: this.playbackEngine });

      try {
        avplay.open(this.avplayUrl);
        // Do not expose the AVPlay session to resize/focus callbacks until open
        // has moved the native object out of NONE and into IDLE.
        this.avplayActive = true;
        this.configureAvPlayForSource(requestHeaders);
        this.configureAvPlayBuffering();
      } catch (error) {
        this.lastPlaybackErrorCode = this.mapAvPlayErrorToMediaCode([error?.name, error?.message].filter(Boolean).join(": ") || error);
        this.teardownAvPlay();
        this.playbackEngine = "none";
        return false;
      }

      try {
        avplay.setListener?.({
          onbufferingstart: () => {
            if (!this.isPlaybackRequestActive(playToken, url)) {
              return;
            }
            if (!this.avplayBufferingStartedAt) {
              this.avplayBufferingStartedAt = Date.now();
            }
            this.avplayBufferingProgress = 0;
            this.avplayReady = false;
            this.emitVideoEvent("waiting", { playbackEngine: this.playbackEngine });
            this.emitVideoEvent("progress", { playbackEngine: this.playbackEngine, bufferingProgress: 0 });
          },
          onbufferingprogress: (percent) => {
            if (!this.isPlaybackRequestActive(playToken, url)) {
              return;
            }
            const numericPercent = Number(percent);
            if (Number.isFinite(numericPercent)) {
              this.avplayBufferingProgress = Math.max(0, Math.min(100, numericPercent));
              this.emitVideoEvent("progress", {
                playbackEngine: this.playbackEngine,
                bufferingProgress: this.avplayBufferingProgress
              });
            }
            // Fired per percent; getState() is a bridge call, so build the
            // log object only when AVPlay diagnostics are on (issue #1208).
            if (typeof isTizenAvPlayDebugEnabled !== "function" || isTizenAvPlayDebugEnabled()) {
              logTizenAvPlayDebug("Tizen AVPlay buffering progress", {
                percent: this.avplayBufferingProgress,
                state: this.getAvPlayState(),
                currentTimeMs: this.avplayCurrentTimeMs
              });
            }
          },
          onbufferingcomplete: () => {
            if (!this.isPlaybackRequestActive(playToken, url)) {
              return;
            }
            if (this.avplayBufferingStartedAt) {
              this.avplayLastBufferingDurationMs = Math.max(0, Date.now() - this.avplayBufferingStartedAt);
            }
            this.avplayBufferingStartedAt = 0;
            this.avplayBufferingProgress = 100;
            if (this.avplaySeekInFlight) {
              return;
            }
            this.avplayReady = true;
            this.reapplyAvPlayPlaybackRate();
            this.retryPendingAvPlayStartupAudioTrackSelection();
            this.applyAvPlayExternalSubtitleDelay();
            this.emitVideoEvent("progress", { playbackEngine: this.playbackEngine, bufferingProgress: 100 });
            this.emitVideoEvent("canplay", { playbackEngine: this.playbackEngine });
          },
          oncurrentplaytime: (currentTimeMs) => {
            if (!this.isPlaybackRequestActive(playToken, url)) {
              return;
            }
            if (this.avplaySeekInFlight) {
              return;
            }
            const value = Number(currentTimeMs || 0);
            if (Number.isFinite(value) && value >= 0) {
              this.avplayCurrentTimeMs = value;
            }
            this.retryPendingAvPlayStartupAudioTrackSelection();
            this.applyAvPlayExternalSubtitleDelay();
            if (globalThis.__NUVIO_LITE_MODE__ === true) {
              const now = Date.now();
              if (now - Number(this.avplayLastTimeUpdateEmitAt || 0) < 450) {
                return;
              }
              this.avplayLastTimeUpdateEmitAt = now;
            }
            this.emitVideoEvent("timeupdate", { playbackEngine: this.playbackEngine });
          },
          onstreamcompleted: () => {
            if (!this.isPlaybackRequestActive(playToken, url)) {
              return;
            }
            this.avplayEnded = true;
            this.isPlaying = false;
            this.syncWebOsPlaybackKeepAwake();
            this.stopAvPlayTickTimer();
            this.refreshAvPlayTimeline();
            const completedDurationMs = Number(this.avplayDurationMs || 0);
            if (Number.isFinite(completedDurationMs) && completedDurationMs > 0) {
              this.avplayCurrentTimeMs = Math.max(Number(this.avplayCurrentTimeMs || 0), completedDurationMs);
            }
            this.emitVideoEvent("ended", { playbackEngine: this.playbackEngine });
            try {
              avplay.stop?.();
            } catch (_) {
              // Ignore stream-complete stop failures.
            }
          },
          onsubtitlechange: (duration, subtitles, type, attributes) => {
            if (!this.isPlaybackRequestActive(playToken, url)) {
              return;
            }
            const diagnosticSelectionAt = Number(this.avplaySubtitleDiagnosticCallbackPendingAt || 0);
            if (diagnosticSelectionAt > 0) {
              this.avplaySubtitleDiagnosticCallbackPendingAt = 0;
              const captureStartedAt = Number(globalThis.__NUVIO_DEBUG_TIZEN_AVPLAY_STARTED_AT__ || 0);
              if (globalThis.__NUVIO_DEBUG_TIZEN_AVPLAY__ === true && diagnosticSelectionAt >= captureStartedAt) {
                const subtitlePayload = String(subtitles || "");
                logTizenAvPlayDebug("Tizen AVPlay subtitle callback received", {
                  elapsedSinceSelectionMs: Math.max(0, Date.now() - diagnosticSelectionAt),
                  durationMs: Number(duration || 0) || 0,
                  type: String(type ?? ""),
                  attributeCount: Array.isArray(attributes) ? attributes.length : attributes == null ? 0 : 1,
                  hasPayload: subtitlePayload.length > 0,
                  payloadLength: subtitlePayload.length,
                  current: this.getAvPlaySubtitleDiagnosticSnapshot(),
                  selectedTrackIndex: Number(this.selectedAvPlaySubtitleTrackIndex),
                  outputDisabled: Boolean(this.avplaySubtitlesSilent),
                  renderMode: this.avplaySubtitleRenderMode,
                  nativeRendering: Boolean(this.avplayNativeSubtitleRendering)
                });
              }
            }
            this.emitVideoEvent("avplaysubtitlechange", {
              playbackEngine: this.playbackEngine,
              diagnosticSelectionAt,
              duration,
              subtitles,
              type,
              attributes
            });
          },
          onerror: (errorValue) => {
            if (!this.isPlaybackRequestActive(playToken, url)) {
              return;
            }
            const avplayErrorDetail = this.getLastAvPlayErrorDiagnostic();
            const avplaySnapshot = this.getAvPlayDiagnosticSnapshot();
            this.clearAvPlaySeekTimeout();
            if (this.avplaySeekInFlight) {
              this.avplaySeekInFlight = false;
              this.avplaySeekRequestToken = Number(this.avplaySeekRequestToken || 0) + 1;
            }
            this.avplayReady = false;
            this.isPlaying = false;
            this.syncWebOsPlaybackKeepAwake();
            this.avplayBufferingStartedAt = 0;
            this.lastPlaybackErrorCode = this.mapAvPlayErrorToMediaCode(errorValue);
            this.stopAvPlayTickTimer();
            this.emitVideoEvent("error", {
              playbackEngine: this.playbackEngine,
              mediaErrorCode: this.lastPlaybackErrorCode,
              avplayError: String(errorValue || ""),
              avplayErrorDetail,
              avplaySnapshot
            });
          },
          onerrormsg: (errorType, errorMessage) => {
            if (!this.isPlaybackRequestActive(playToken, url)) {
              return;
            }
            const detail = this.normalizeAvPlayErrorDiagnostic(errorType, errorMessage);
            this.avplayLastErrorDiagnostic = detail;
            if (Platform.isTizen() && detail) {
              console.warn("[Nuvio AVPlay error detail]", detail);
            }
          }
        });
      } catch (_) {
        // Ignore listener setup failures; prepareAsync/play may still work.
      }

      // Samsung recommends installing the listener while AVPlay is IDLE before
      // configuring the display and starting prepareAsync.
      this.setAvPlayDisplayRect();

      const onPrepared = () => {
        if (!this.isUsingAvPlay() || !this.isPlaybackRequestActive(playToken, url)) {
          return;
        }
        this.avplayReady = true;
        this.avplayEnded = false;
        this.reapplyTizenAvPlayDisplayRect();
        this.refreshAvPlayTimeline();
        this.syncAvPlayTrackInfo({ force: true });
        this.emitVideoEvent("loadedmetadata", { playbackEngine: this.playbackEngine });
        this.emitVideoEvent("loadeddata", { playbackEngine: this.playbackEngine });
        this.emitVideoEvent("canplay", { playbackEngine: this.playbackEngine });
        this.emitVideoEvent("avplaytrackschanged", { playbackEngine: this.playbackEngine });
        // Apply a seek that was requested while prepareAsync() was running
        // (normally the resume position). AVPlay is READY now, where seekTo()
        // is valid; the playback start below waits for it to settle.
        const deferredSeekMs = Number(this.avplayDeferredSeekMs || 0);
        this.avplayDeferredSeekMs = 0;
        if (deferredSeekMs > 0 && !this.avplaySeekInFlight) {
          this.seekAvPlayTo(deferredSeekMs);
        }
        if (this.startupAudioGateActive) {
          return;
        }
        this.startPreparedAvPlayPlayback({ syncTracks: true });
        this.reapplyTizenAvPlayDisplayRect(250);
      };

      const onPrepareError = (errorValue) => {
        if (!this.isPlaybackRequestActive(playToken, url)) {
          return;
        }
        const avplayErrorDetail = this.getLastAvPlayErrorDiagnostic();
        const avplaySnapshot = this.getAvPlayDiagnosticSnapshot();
        this.lastPlaybackErrorCode = this.mapAvPlayErrorToMediaCode(errorValue);
        this.isPlaying = false;
        this.syncWebOsPlaybackKeepAwake();
        this.teardownAvPlay();
        this.playbackEngine = "none";
        this.emitVideoEvent("error", {
          playbackEngine: this.getPlatformAvplayEngineName(),
          mediaErrorCode: this.lastPlaybackErrorCode,
          avplayError: String(errorValue || ""),
          avplayErrorDetail,
          avplaySnapshot
        });
      };

      try {
        if (typeof avplay.prepareAsync === "function") {
          avplay.prepareAsync(onPrepared, onPrepareError);
        } else if (typeof avplay.prepare === "function") {
          avplay.prepare();
          onPrepared();
        } else {
          onPrepareError("prepare_not_supported");
        }
      } catch (error) {
        onPrepareError([error?.name, error?.message].filter(Boolean).join(": ") || error);
      }

      return true;
    },
    getCurrentTimeSeconds() {
      if (this.isUsingAvPlay()) {
        this.refreshAvPlayTimeline();
        return Math.max(0, Number(this.avplayCurrentTimeMs || 0) / 1000);
      }
      return Math.max(0, Number(this.video?.currentTime || 0));
    },
    getDurationSeconds() {
      let durationSeconds = 0;
      if (this.isUsingAvPlay()) {
        this.refreshAvPlayTimeline();
        durationSeconds = Number(this.avplayDurationMs || 0) / 1000;
      } else {
        durationSeconds = Number(this.video?.duration || 0);
      }
      if (Number.isFinite(durationSeconds) && durationSeconds > Number(this.lastKnownDurationSeconds || 0)) {
        this.lastKnownDurationSeconds = durationSeconds;
      }
      return Math.max(0, Number(this.lastKnownDurationSeconds || 0));
    },
    getLiveBufferMetrics() {
      const result = {
        bufferingPercent: null,
        bufferedAheadSeconds: null,
        positionRatio: null,
        bufferedRatio: null,
        isBuffering: false
      };
      if (this.isUsingAvPlay()) {
        const pct = Number(this.avplayBufferingProgress);
        const isBuffering = Boolean(this.avplayBufferingStartedAt > 0 || (Number.isFinite(pct) && pct >= 0 && pct < 100));
        result.isBuffering = isBuffering;
        if (Number.isFinite(pct) && pct >= 0) {
          result.bufferingPercent = Math.max(0, Math.min(100, Math.round(pct)));
        }
        try {
          const avplay = this.getAvPlay();
          const rawLiveDuration =
            avplay && this.avplayReady && !this.avplaySeekInFlight
              ? String(avplay.getStreamingProperty?.("GET_LIVE_DURATION") || "")
              : "";
          const parts = rawLiveDuration.split("|");
          if (parts.length === 2) {
            const startMs = Number(parts[0]);
            const endMs = Number(parts[1]);
            const currentMs = Number(this.avplayCurrentTimeMs || 0);
            if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
              const windowMs = endMs - startMs;
              const clampedCurrent = Math.max(startMs, Math.min(endMs, currentMs));
              result.bufferedAheadSeconds = Math.max(0, (endMs - clampedCurrent) / 1000);
              result.positionRatio = Math.max(0, Math.min(1, (clampedCurrent - startMs) / windowMs));
              result.bufferedRatio = 1;
            }
          }
        } catch (_) {
          // GET_LIVE_DURATION is optional for raw MPEG-TS live streams.
        }
        return result;
      }

      try {
        const video = this.video;
        const ranges = video?.buffered;
        const current = Number(video?.currentTime || 0);
        if (ranges && ranges.length > 0 && Number.isFinite(current)) {
          const start = Number(ranges.start(0));
          let end = Number(ranges.end(ranges.length - 1));
          for (let i = 0; i < ranges.length; i += 1) {
            const s = Number(ranges.start(i));
            const e = Number(ranges.end(i));
            if (s <= current + 0.5 && e >= current) {
              end = e;
              break;
            }
          }
          if (Number.isFinite(end) && end >= current) {
            result.bufferedAheadSeconds = Math.max(0, end - current);
            const span = Math.max(1, end - Math.min(start, current));
            result.positionRatio = Math.max(0, Math.min(1, (current - Math.min(start, current)) / span));
            result.bufferedRatio = 1;
          }
        }
      } catch (_) {}
      return result;
    },
    getBufferedTimeSeconds() {
      // AVPlay reports buffering-operation progress, not a buffered media
      // timestamp. Returning no value prevents the UI from presenting that
      // percentage as playable time.
      if (this.isUsingAvPlay()) {
        return null;
      }

      try {
        const video = this.video;
        const durationSeconds = Number(video?.duration || 0);
        const currentSeconds = Number(video?.currentTime || 0);
        const ranges = video?.buffered;
        if (
          !ranges ||
          !Number.isFinite(durationSeconds) ||
          durationSeconds <= 0 ||
          !Number.isFinite(currentSeconds) ||
          currentSeconds < 0
        ) {
          return null;
        }

        const rangeCount = Number(ranges.length || 0);
        if (!Number.isFinite(rangeCount) || rangeCount <= 0) {
          return null;
        }
        for (let index = 0; index < rangeCount; index += 1) {
          const startSeconds = Number(ranges.start(index));
          const endSeconds = Number(ranges.end(index));
          if (
            Number.isFinite(startSeconds) &&
            Number.isFinite(endSeconds) &&
            startSeconds >= 0 &&
            endSeconds >= startSeconds &&
            startSeconds <= currentSeconds &&
            endSeconds >= currentSeconds
          ) {
            return Math.max(0, Math.min(endSeconds, durationSeconds));
          }
        }
      } catch (_) {
        // TimeRanges can change while it is being read on older TV engines.
      }

      return null;
    }
  };
}
