import { syncPlayerPlaybackBadges } from "./playerPlaybackBadges.js";
import { syncHtmlSubtitleClearance } from "./subtitleOverlayClearance.js";
import { MediaServerScrobbleService } from "../../../data/mediaserver/mediaServerScrobbleService.js";
/* eslint-disable no-unused-vars */
import * as internals from "./playerScreenContext.js";

// Playback progress arrives from several sources at once (native timeupdate at
// ~4 Hz, the AVPlay time callback plus its 1 s poll, the screen heartbeat and
// progress events). Each used to run a full UI tick. Coalesce them to one tick
// per interval; the heartbeat still guarantees a tick every second. Issue #1208.
const UI_TICK_MIN_INTERVAL_MS = 250;

function uiTickNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function createPlayerScreenMethods32() {
  const {
    renderPlayerImageBadgeChip,
    getTrackLanguageLabel,
    PlayerController,
    PlayerSettingsStore,
    deltaMsForKeyRepeat,
    calculateRemainingPlaybackMilliseconds,
    t,
    formatTime,
    formatClock,
    formatEndsAt,
    clamp
  } = internals;

  return {
    requestUiTick() {
      const now = uiTickNow();
      const elapsed = now - Number(this.lastUiTickAt || 0);
      const isLite = globalThis.__NUVIO_LITE_MODE__ === true;
      const osdVisible = Boolean(this.controlsVisible || this.pauseOverlayVisible || this.seekOverlayVisible);
      const minInterval = isLite ? (osdVisible ? 350 : 1000) : UI_TICK_MIN_INTERVAL_MS;
      if (!this.lastUiTickAt || elapsed >= minInterval) {
        this.updateUiTick();
        return;
      }
      if (this.uiTickPendingTimer != null) {
        return;
      }
      // Trailing edge: the newest position is never dropped, only delayed.
      this.uiTickPendingTimer = setTimeout(
        () => {
          this.uiTickPendingTimer = null;
          this.updateUiTick();
        },
        Math.max(0, minInterval - elapsed)
      );
    },
    cancelPendingUiTick() {
      if (this.uiTickPendingTimer != null) {
        clearTimeout(this.uiTickPendingTimer);
        this.uiTickPendingTimer = null;
      }
    },
    updateUiTick() {
      this.lastUiTickAt = uiTickNow();
      this.cancelPendingUiTick?.();
      if (this.playerRouteActive) MediaServerScrobbleService.update(this.buildScrobbleContext());
      if (this.isExternalFrameMode()) {
        return;
      }
      this.syncHdrPresentation?.();
      this.syncChaptersPanelHighlight?.();
      this.syncStartupGateAndParentalGuide?.();
      if (
        (PlayerSettingsStore.get().skipIntroEnabled || PlayerSettingsStore.get().chaptersEnabled === true) &&
        !this.chapterSkipIntervalsLoaded &&
        !this.chaptersFetchInFlight &&
        this.hasPresentedPlaybackFrame &&
        Number(this.getPlaybackDurationSeconds() || 0) > 0 &&
        Date.now() >= Number(this.chapterSkipIntervalsRetryAt || 0)
      ) {
        this.chapterSkipIntervalsRetryAt = Date.now() + 5000;
        void this.refreshChapterSkipIntervals?.();
      }
      const isLite = globalThis.__NUVIO_LITE_MODE__ === true;
      const osdVisible = Boolean(
        this.controlsVisible || this.pauseOverlayVisible || this.seekOverlayVisible || this.loadingVisible
      );
      if (!isLite || osdVisible) {
        syncPlayerPlaybackBadges(this, PlayerController, renderPlayerImageBadgeChip, getTrackLanguageLabel);
      }
      const isLivePlayback = this.isLivePlayback();
      const watchedMs = this.liveWatchClock.update(
        isLivePlayback,
        PlayerController.isPlaying && !this.paused && !this.isBufferingForPauseOverlay()
      );
      if (this.uiRefs?.progressShell) {
        this.uiRefs.progressShell.classList.remove("hidden");
        this.uiRefs.progressShell.classList.toggle("is-live", isLivePlayback);
      }
      if (isLivePlayback && this.seekPreviewSeconds != null) this.cancelSeekPreview();
      this.ensureNextEpisodeStreamsPrefetch();
      this.shouldShowNextEpisodeCard();
      if (!isLite) {
        void this.refreshLoadingOverlayProgress();
      }
      const current = this.getPlaybackCurrentSeconds();
      this.updateActiveSkipInterval(current);
      this.updateSkipIntroCountdown(Date.now());
      const displayCurrent = this.getPlaybackDisplayCurrentSeconds();
      const duration = this.getPlaybackDisplayDurationSeconds();
      this.evaluatePostPlayRecommendation();
      const uiRefs = this.uiRefs || {};
      const uiState = this.lastUiTickState || (this.lastUiTickState = {});
      if (!isLite || osdVisible) {
        const progressBuffered = uiRefs.progressBuffered;
        if (progressBuffered) {
          const bufferedSeconds = this.getPlaybackBufferedSeconds();
          let bufferedVisible = Number.isFinite(bufferedSeconds) && duration > 0 && bufferedSeconds > current + 0.25;
          let bufferedProgress = bufferedVisible ? clamp(bufferedSeconds / duration, 0, 1) : 0;
          if (isLivePlayback) {
            const liveMetrics =
              typeof PlayerController.getLiveBufferMetrics === "function"
                ? PlayerController.getLiveBufferMetrics()
                : null;
            if (liveMetrics?.isBuffering && liveMetrics.bufferingPercent != null) {
              bufferedVisible = true;
              bufferedProgress = clamp(liveMetrics.bufferingPercent / 100, 0, 1);
            } else if (liveMetrics?.bufferedAheadSeconds != null) {
              bufferedVisible = true;
              // Visualize real buffered headroom (0s..15s fills the buffer track).
              bufferedProgress = clamp(liveMetrics.bufferedAheadSeconds / 15, 0.08, 1);
            } else if (liveMetrics?.bufferingPercent != null) {
              bufferedVisible = true;
              bufferedProgress = clamp(liveMetrics.bufferingPercent / 100, 0, 1);
            } else {
              bufferedVisible = false;
              bufferedProgress = 0;
            }
          }
          const nextBufferedWidth = `${Math.round(bufferedProgress * 10000) / 100}%`;
          if (uiState.bufferedWidth !== nextBufferedWidth) {
            progressBuffered.style.width = nextBufferedWidth;
            uiState.bufferedWidth = nextBufferedWidth;
          }
          if (uiState.bufferedVisible !== bufferedVisible) {
            progressBuffered.classList.toggle("is-visible", bufferedVisible);
            uiState.bufferedVisible = bufferedVisible;
          }
        }
        this.renderProgressPosition();
      }
      this.syncSkipIntroButtonProgress();
      this.renderSkipIntroButton();
      if (!isLite || osdVisible) {
        this.syncPlayerOverlayLayoutState();
      }
      this.renderBitmapSubtitleAtCurrentTime();
      this.maybeAutoplayNextEpisode();

      const clock = uiRefs.clock;
      if (clock && (!isLite || osdVisible)) {
        const now = new Date();
        const nextClockMinuteKey = `${now.getHours()}:${now.getMinutes()}`;
        if (uiState.clockMinuteKey !== nextClockMinuteKey) {
          const nextClockText = formatClock(now, this.webOsClockLocaleInfo);
          clock.textContent = nextClockText;
          uiState.clockText = nextClockText;
          uiState.clockMinuteKey = nextClockMinuteKey;
        }
      }

      const endsAt = uiRefs.endsAt;
      if (endsAt) {
        const playbackSpeed = this.getPlaybackSpeed();
        // Keep this clock based on the full media duration. Outro intervals are
        // handled independently by skip/autoplay, as they are on Android TV.
        // Android derives this from the timeline position, which is the preview target while seeking.
        const endsAtPosition = this.seekPreviewSeconds != null ? Number(this.seekPreviewSeconds) : displayCurrent;
        const remainingMs = isLivePlayback ? null : calculateRemainingPlaybackMilliseconds(endsAtPosition, duration, playbackSpeed);
        const nextEndsAtMinuteBucket = remainingMs == null ? -1 : Math.floor((Date.now() + remainingMs) / 60000);
        endsAt.classList.toggle("hidden", isLivePlayback);
        if (uiState.endsAtMinuteBucket !== nextEndsAtMinuteBucket) {
          const nextEndsAtText = isLivePlayback
            ? ""
            : t("player_ends_at", [formatEndsAt(endsAtPosition, duration, this.webOsClockLocaleInfo, playbackSpeed)], "Ends at %1$s");
          endsAt.textContent = nextEndsAtText;
          uiState.endsAtText = nextEndsAtText;
          uiState.endsAtMinuteBucket = nextEndsAtMinuteBucket;
        }
      }

      if (this.pauseOverlayVisible) {
        const overlayClock = this.uiRefs?.pauseOverlay?.querySelector(".player-pause-overlay-clock");
        if (overlayClock && overlayClock.textContent !== uiState.clockText) {
          overlayClock.textContent = uiState.clockText || "--:--";
        }
        const overlayEndsAt = this.uiRefs?.pauseOverlay?.querySelector(".player-pause-overlay-ends-at");
        if (overlayEndsAt && overlayEndsAt.textContent !== uiState.endsAtText) {
          overlayEndsAt.textContent = uiState.endsAtText || t("player_ends_at", ["--:--"], "Ends at %1$s");
        }
      }

      const timeLabel = uiRefs.timeLabel;
      if (timeLabel && isLivePlayback) {
        const liveMetrics =
          typeof PlayerController.getLiveBufferMetrics === "function"
            ? PlayerController.getLiveBufferMetrics()
            : null;
        const baseLiveLabel = t("player_live_watched", [formatTime(watchedMs / 1000)], "LIVE  %1$s");
        let bufferSuffix = "";
        if (liveMetrics?.isBuffering && liveMetrics.bufferingPercent != null) {
          bufferSuffix = `  ·  Buffer %${liveMetrics.bufferingPercent}`;
        } else if (liveMetrics?.bufferedAheadSeconds != null) {
          bufferSuffix = `  ·  Buffer ${Math.round(liveMetrics.bufferedAheadSeconds)}s`;
        } else if (liveMetrics?.bufferingPercent != null) {
          bufferSuffix = `  ·  Buffer %${liveMetrics.bufferingPercent}`;
        }
        const nextTimeLabel = `${baseLiveLabel}${bufferSuffix}`;
        if (uiState.timeLabelText !== nextTimeLabel) {
          timeLabel.textContent = nextTimeLabel;
          uiState.timeLabelText = nextTimeLabel;
        }
      }

      this.syncPauseOverlayState();
      this.renderNextEpisodeCard();
      syncHtmlSubtitleClearance(this);

      if (this.seekOverlayVisible && this.seekPreviewSeconds == null) {
        this.renderSeekOverlay();
      }
    },
    renderProgressPosition() {
      // Android shows a pending preview seek wherever the timeline is drawn
      // (pendingPreviewSeekPosition ?: position) and redraws it on every step.
      // The UI tick runs once a second, so a held seek must redraw here too or
      // the bar and time trail the preview.
      const uiRefs = this.uiRefs || {};
      const uiState = this.lastUiTickState || (this.lastUiTickState = {});
      if (this.isLivePlayback()) {
        const progressFill = uiRefs.progressFill;
        const progressShell = uiRefs.progressShell;
        const liveMetrics =
          typeof PlayerController.getLiveBufferMetrics === "function"
            ? PlayerController.getLiveBufferMetrics()
            : null;
        const isBuffering = Boolean(
          liveMetrics?.isBuffering ||
            this.loadingVisible ||
            !this.hasPresentedPlaybackFrame ||
            this.isBufferingForPauseOverlay?.()
        );
        const liveDuration = this.getPlaybackDisplayDurationSeconds();
        const livePos = this.getPlaybackDisplayCurrentSeconds();
        let nextWidth = "0%";
        if (isBuffering && liveMetrics?.bufferingPercent != null) {
          nextWidth = `${Math.max(0, Math.min(100, liveMetrics.bufferingPercent))}%`;
        } else if (liveMetrics?.positionRatio != null) {
          nextWidth = `${Math.round(clamp(liveMetrics.positionRatio, 0, 1) * 10000) / 100}%`;
        } else if (liveDuration > 0 && livePos >= 0) {
          nextWidth = `${Math.round(clamp(livePos / liveDuration, 0, 1) * 10000) / 100}%`;
        } else if (liveMetrics?.bufferedAheadSeconds != null) {
          nextWidth = `${Math.round(clamp(liveMetrics.bufferedAheadSeconds / 15, 0.05, 1) * 100)}%`;
        } else if (liveMetrics?.bufferingPercent != null) {
          nextWidth = `${Math.max(0, Math.min(100, liveMetrics.bufferingPercent))}%`;
        } else if (this.hasPresentedPlaybackFrame) {
          nextWidth = "100%";
        }
        if (progressShell) {
          progressShell.classList.toggle("is-live-loading", isBuffering);
        }
        if (progressFill && uiState.progressWidth !== nextWidth) {
          progressFill.style.width = nextWidth;
          uiState.progressWidth = nextWidth;
        }
        return;
      }
      const duration = this.getPlaybackDisplayDurationSeconds();
      const position = this.seekPreviewSeconds != null ? Number(this.seekPreviewSeconds) : this.getPlaybackDisplayCurrentSeconds();
      const progress = duration > 0 ? clamp(position / duration, 0, 1) : 0;
      this.renderPlayerChapterMarks?.();
      this.syncPlayerChapterTitle?.(position);
      const progressFill = uiRefs.progressFill;
      if (progressFill) {
        const nextWidth = `${Math.round(progress * 10000) / 100}%`;
        if (uiState.progressWidth !== nextWidth) {
          progressFill.style.width = nextWidth;
          uiState.progressWidth = nextWidth;
        }
      }
      const timeLabel = uiRefs.timeLabel;
      if (timeLabel) {
        const nextTimeLabel = `${formatTime(position)} / ${formatTime(duration)}`;
        if (uiState.timeLabelText !== nextTimeLabel) {
          timeLabel.textContent = nextTimeLabel;
          if (uiRefs.progressShell) {
            uiRefs.progressShell.setAttribute("aria-valuemax", String(Math.max(0, duration)));
            uiRefs.progressShell.setAttribute("aria-valuenow", String(clamp(position, 0, Math.max(0, duration))));
            uiRefs.progressShell.setAttribute("aria-valuetext", nextTimeLabel);
          }
          uiState.timeLabelText = nextTimeLabel;
        }
      }
    },
    renderSeekOverlay() {
      this.renderProgressPosition();
      const overlay = this.uiRefs?.seekOverlay;
      const directionNode = this.uiRefs?.seekDirection;
      const previewNode = this.uiRefs?.seekPreview;
      const fillNode = this.uiRefs?.seekFill;
      if (!overlay || !directionNode || !previewNode || !fillNode) {
        return;
      }

      const duration = this.getPlaybackDisplayDurationSeconds();
      const currentPreview = this.seekPreviewSeconds != null ? Number(this.seekPreviewSeconds) : this.getPlaybackDisplayCurrentSeconds();

      const shouldShowOverlay = this.seekOverlayVisible && !this.controlsVisible && !this.isLivePlayback();
      overlay.classList.toggle("hidden", !shouldShowOverlay);
      const uiState = this.lastUiTickState || (this.lastUiTickState = {});
      const nextPreviewText = `${formatTime(currentPreview)} / ${formatTime(duration)}`;
      const nextDirectionText = this.seekPreviewDirection < 0 ? "<<" : this.seekPreviewDirection > 0 ? ">>" : "";
      if (uiState.seekPreviewText !== nextPreviewText) {
        previewNode.textContent = nextPreviewText;
        uiState.seekPreviewText = nextPreviewText;
      }
      if (uiState.seekDirectionText !== nextDirectionText) {
        directionNode.textContent = nextDirectionText;
        uiState.seekDirectionText = nextDirectionText;
      }

      syncHtmlSubtitleClearance(this);
      const percent = duration > 0 ? clamp(currentPreview / duration, 0, 1) : 0;
      const nextSeekWidth = `${Math.round(percent * 10000) / 100}%`;
      if (uiState.seekWidth !== nextSeekWidth) {
        fillNode.style.width = nextSeekWidth;
        uiState.seekWidth = nextSeekWidth;
      }
    },
    seekLiveForward(stepSeconds = 5) {
      if (!this.isLivePlayback()) {
        return false;
      }
      const didSeek =
        typeof PlayerController.seekLiveForward === "function"
          ? Boolean(PlayerController.seekLiveForward(stepSeconds))
          : false;
      if (didSeek) {
        this.setControlsVisible(true, { focus: false });
        this.resetControlsAutoHide();
        this.updateUiTick();
      }
      return didSeek;
    },
    beginSeekPreview(direction, isRepeat = false, commitOnRelease = false) {
      if (this.isLivePlayback()) {
        if (direction > 0) {
          this.seekLiveForward(5);
        }
        return;
      }
      if (!this.isSeekBarAvailable()) {
        return;
      }
      const currentTime = this.getPlaybackCurrentSeconds();
      if (Number.isNaN(currentTime)) {
        return;
      }

      if (direction !== this.seekPreviewDirection || !isRepeat) {
        this.seekRepeatCount = 0;
      }
      this.seekPreviewDirection = direction;
      this.seekRepeatCount += 1;

      const deltaSeconds = deltaMsForKeyRepeat(this.seekRepeatCount - 1, direction > 0) / 1000;
      const duration = this.getPlaybackDurationSeconds();
      const base = this.seekPreviewSeconds == null ? currentTime : Number(this.seekPreviewSeconds);
      let next = base + deltaSeconds;
      if (duration > 0) {
        next = clamp(next, 0, duration);
      } else {
        next = Math.max(0, next);
      }

      this.seekPreviewSeconds = next;
      this.seekOverlayVisible = !this.controlsVisible;
      this.renderSeekOverlay();

      if (this.seekOverlayTimer) {
        clearTimeout(this.seekOverlayTimer);
        this.seekOverlayTimer = null;
      }

      if (commitOnRelease) {
        clearTimeout(this.seekCommitTimer);
        this.seekCommitTimer = null;
      } else {
        this.scheduleSeekPreviewCommit();
      }
    },
    scheduleSeekPreviewCommit() {
      if (this.seekCommitTimer) {
        clearTimeout(this.seekCommitTimer);
      }
      this.seekCommitTimer = setTimeout(() => {
        this.commitSeekPreview();
      }, 1000);
    },
    commitSeekPreview() {
      if (this.isLivePlayback()) {
        this.cancelSeekPreview();
        return;
      }
      if (!PlayerController.video) {
        this.cancelSeekPreview({ commit: false });
        return;
      }

      // AVPlay cannot accept a second seek until the previous one settles.
      // Keep the preview target instead of dropping a released-key command.
      if (this.seekPreviewSeconds != null && PlayerController.avplaySeekInFlight) {
        clearTimeout(this.seekCommitTimer);
        this.seekCommitTimer = setTimeout(() => this.commitSeekPreview(), 100);
        return;
      }

      if (this.seekPreviewSeconds != null) {
        const requestedMs = Math.round(Number(this.seekPreviewSeconds) * 1000);
        const targetMs = this.partyUserSeekTarget ? this.partyUserSeekTarget(requestedMs) : requestedMs;
        if (targetMs != null) {
          this.suppressControlsForHiddenSeek();
          this.seekPlaybackSeconds(targetMs / 1000);
          this.publishPartyPlayback?.({ positionMs: targetMs });
        }
      }

      if (this.stickyProgressFocus && this.controlsVisible) {
        this.focusProgressBar();
        this.scheduleProgressBarRefocus();
      }

      this.seekPreviewSeconds = null;
      this.seekRepeatCount = 0;
      if (this.seekCommitTimer) {
        clearTimeout(this.seekCommitTimer);
        this.seekCommitTimer = null;
      }

      this.seekOverlayVisible = !this.controlsVisible;
      this.renderSeekOverlay();

      if (this.seekOverlayTimer) {
        clearTimeout(this.seekOverlayTimer);
      }
      this.seekOverlayTimer = setTimeout(() => {
        this.seekOverlayVisible = false;
        this.seekPreviewDirection = 0;
        this.renderSeekOverlay();
        if (this.autoHideControlsAfterSeek && this.controlsVisible) {
          this.autoHideControlsAfterSeek = false;
          this.stickyProgressFocus = false;
          this.setControlsVisible(false);
          return;
        }
        if (this.stickyProgressFocus && this.controlsVisible) {
          this.focusProgressBar();
          this.scheduleProgressBarRefocus();
        }
        this.resetControlsAutoHide();
      }, 700);
    },
    cancelSeekPreview({ commit = false } = {}) {
      if (commit) {
        this.commitSeekPreview();
        return;
      }

      if (this.seekCommitTimer) {
        clearTimeout(this.seekCommitTimer);
        this.seekCommitTimer = null;
      }
      if (this.seekOverlayTimer) {
        clearTimeout(this.seekOverlayTimer);
        this.seekOverlayTimer = null;
      }

      this.seekPreviewSeconds = null;
      this.seekPreviewDirection = 0;
      this.seekRepeatCount = 0;
      this.seekOverlayVisible = false;
      this.autoHideControlsAfterSeek = false;
      this.seekOverlaySuppressControlsUntil = 0;
      this.renderSeekOverlay();
    },
    togglePause({ focusControls = true } = {}) {
      const preserveProgressFocus = this.controlFocusZone === "progress";
      if (this.isExternalFrameMode()) {
        return;
      }
      if (this.isPartyControlLocked?.()) {
        this.toggleOwnPlayback();
        this.renderControlButtons();
        return;
      }
      const wasPaused = this.getPlaybackControlPaused();
      this.togglePauseLocally({ focusControls, preserveProgressFocus });
      this.publishPartyPlayback?.({ paused: !wasPaused });
    },
    togglePauseLocally({ focusControls = true, preserveProgressFocus = false } = {}) {
      if (this.getPlaybackControlPaused()) {
        this.dismissPauseOverlay();
        PlayerController.resume();
        this.paused = false;
        this.updateMediaSessionPlaybackState();
        this.setControlsVisible(true, { focus: false });
        if (preserveProgressFocus) {
          this.controlFocusZone = "progress";
        }
        this.renderControlButtons();
        return;
      }

      PlayerController.pause();
      this.paused = true;
      this.updateMediaSessionPlaybackState();
      if (!focusControls && !preserveProgressFocus) {
        this.controlFocusZone = "";
      }
      this.setControlsVisible(true, { focus: focusControls && !preserveProgressFocus });
      if (preserveProgressFocus) {
        this.controlFocusZone = "progress";
      }
      this.renderControlButtons();
      this.schedulePauseOverlay();
    }
  };
}
