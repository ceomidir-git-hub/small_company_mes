/**
 * HeatPro MES 공통 미사용 자동 로그아웃
 * 파일명: mes_inactivity_timeout.js
 *
 * 사용 예:
 * await window.startMesInactivityTimeout({
 *   supabaseClient: sb,
 *   loginPageUrl: "../index.html",
 *   timeoutMinutes: 20
 * });
 */
(function (global) {
  "use strict";

  const DEFAULT_STORAGE_KEY = "heatpro_mes_inactivity_state_v1";
  const DEFAULT_TIMEOUT_MINUTES = 20;
  const DEFAULT_CHECK_INTERVAL_MS = 5000;
  const DEFAULT_ACTIVITY_THROTTLE_MS = 1000;

  let currentController = null;

  function normalizePositiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function tokenFingerprint(token) {
    const text = String(token || "");
    let hash = 2166136261;

    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16);
  }

  function readState(storageKey) {
    try {
      const raw = global.localStorage.getItem(storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      console.warn("[MES inactivity] 저장값 읽기 실패:", error);
      return null;
    }
  }

  function writeState(storageKey, state) {
    try {
      global.localStorage.setItem(storageKey, JSON.stringify(state));
      return true;
    } catch (error) {
      console.warn("[MES inactivity] 저장값 기록 실패:", error);
      return false;
    }
  }

  function redirectToLogin(loginPageUrl) {
    global.location.replace(loginPageUrl);
  }

  async function getCurrentSession(supabaseClient) {
    const result = await supabaseClient.auth.getSession();

    if (result.error) {
      throw result.error;
    }

    return result.data?.session || null;
  }

  /**
   * 공통 미사용 타이머를 시작합니다.
   *
   * @param {Object} options
   * @param {Object} options.supabaseClient Supabase createClient 결과
   * @param {string} options.loginPageUrl 로그아웃 후 이동할 로그인 페이지
   * @param {number} [options.timeoutMinutes=20] 미사용 제한시간(분)
   * @param {string} [options.storageKey] 여러 MES 화면에서 공유할 localStorage 키
   * @returns {Promise<{stop: Function, reset: Function, checkNow: Function}>}
   */
  global.startMesInactivityTimeout = async function startMesInactivityTimeout(options = {}) {
    if (currentController && typeof currentController.stop === "function") {
      currentController.stop();
    }

    const supabaseClient = options.supabaseClient;
    const loginPageUrl = String(options.loginPageUrl || "../index.html");
    const timeoutMinutes = normalizePositiveNumber(
      options.timeoutMinutes,
      DEFAULT_TIMEOUT_MINUTES
    );
    const checkIntervalMs = normalizePositiveNumber(
      options.checkIntervalMs,
      DEFAULT_CHECK_INTERVAL_MS
    );
    const activityThrottleMs = normalizePositiveNumber(
      options.activityThrottleMs,
      DEFAULT_ACTIVITY_THROTTLE_MS
    );
    const storageKey = String(options.storageKey || DEFAULT_STORAGE_KEY);

    if (
      !supabaseClient ||
      !supabaseClient.auth ||
      typeof supabaseClient.auth.getSession !== "function" ||
      typeof supabaseClient.auth.signOut !== "function"
    ) {
      throw new Error("유효한 Supabase 클라이언트가 필요합니다.");
    }

    const session = await getCurrentSession(supabaseClient);

    if (!session?.user?.id) {
      redirectToLogin(loginPageUrl);
      throw new Error("로그인 세션이 없습니다.");
    }

    const userId = session.user.id;
    const sessionFingerprint = tokenFingerprint(session.access_token);
    const timeoutMs = timeoutMinutes * 60 * 1000;

    let stopped = false;
    let loggingOut = false;
    let intervalId = null;
    let lastStorageWriteAt = 0;
    let lastActivityAt = Date.now();

    const listeners = [];

    function buildState(activityTime, extra = {}) {
      return {
        version: 1,
        userId,
        sessionFingerprint,
        lastActivityAt: activityTime,
        ...extra
      };
    }

    function isSameSession(state) {
      return Boolean(
        state &&
        state.userId === userId &&
        state.sessionFingerprint === sessionFingerprint
      );
    }

    function saveLastActivity(force = false) {
      if (stopped || loggingOut) return;

      const now = Date.now();

      if (!force && now - lastStorageWriteAt < activityThrottleMs) {
        return;
      }

      lastStorageWriteAt = now;
      writeState(storageKey, buildState(lastActivityAt));
    }

    function recordActivity() {
      if (stopped || loggingOut) return;

      lastActivityAt = Date.now();
      saveLastActivity(false);
    }

    async function performLogout(reason = "inactivity") {
      if (stopped || loggingOut) return;

      loggingOut = true;

      writeState(
        storageKey,
        buildState(lastActivityAt, {
          expiredAt: Date.now(),
          reason
        })
      );

      cleanup();

      try {
        await supabaseClient.auth.signOut({ scope: "local" });
      } catch (error) {
        console.error("[MES inactivity] 로그아웃 처리 실패:", error);
      } finally {
        redirectToLogin(loginPageUrl);
      }
    }

    function refreshFromSharedState() {
      const sharedState = readState(storageKey);

      if (!isSameSession(sharedState)) return;

      if (sharedState.expiredAt) {
        void performLogout("shared_expiration");
        return;
      }

      const sharedLastActivity = Number(sharedState.lastActivityAt);

      if (
        Number.isFinite(sharedLastActivity) &&
        sharedLastActivity > lastActivityAt
      ) {
        lastActivityAt = sharedLastActivity;
      }
    }

    function checkTimeout() {
      if (stopped || loggingOut) return true;

      refreshFromSharedState();

      if (Date.now() - lastActivityAt >= timeoutMs) {
        void performLogout("inactivity");
        return true;
      }

      return false;
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;

      const expired = checkTimeout();

      if (!expired) {
        recordActivity();
      }
    }

    function handleStorage(event) {
      if (event.key !== storageKey) return;
      refreshFromSharedState();
      checkTimeout();
    }

    function handlePageHide() {
      saveLastActivity(true);
    }

    function addListener(target, eventName, handler, optionsValue) {
      target.addEventListener(eventName, handler, optionsValue);
      listeners.push(() => {
        target.removeEventListener(eventName, handler, optionsValue);
      });
    }

    function cleanup() {
      if (stopped) return;

      stopped = true;

      if (intervalId !== null) {
        global.clearInterval(intervalId);
        intervalId = null;
      }

      while (listeners.length) {
        const removeListener = listeners.pop();
        try {
          removeListener();
        } catch (_) {
          // 제거 중 오류는 무시합니다.
        }
      }
    }

    const savedState = readState(storageKey);

    if (isSameSession(savedState) && !savedState.expiredAt) {
      const savedActivity = Number(savedState.lastActivityAt);

      if (Number.isFinite(savedActivity) && savedActivity > 0) {
        lastActivityAt = savedActivity;
      }
    } else {
      lastActivityAt = Date.now();
      writeState(storageKey, buildState(lastActivityAt));
      lastStorageWriteAt = lastActivityAt;
    }

    if (Date.now() - lastActivityAt >= timeoutMs) {
      await performLogout("inactivity_on_page_load");
      return {
        stop: cleanup,
        reset: recordActivity,
        checkNow: checkTimeout
      };
    }

    const activityEvents = [
      "pointerdown",
      "pointermove",
      "keydown",
      "touchstart",
      "wheel",
      "scroll"
    ];

    activityEvents.forEach(eventName => {
      addListener(
        document,
        eventName,
        recordActivity,
        eventName === "scroll" || eventName === "wheel" || eventName === "touchstart"
          ? { passive: true }
          : false
      );
    });

    addListener(document, "visibilitychange", handleVisibilityChange, false);
    addListener(global, "storage", handleStorage, false);
    addListener(global, "pagehide", handlePageHide, false);
    addListener(global, "pageshow", checkTimeout, false);
    addListener(global, "focus", checkTimeout, false);

    intervalId = global.setInterval(checkTimeout, checkIntervalMs);

    currentController = {
      stop: cleanup,
      reset: recordActivity,
      checkNow: checkTimeout
    };

    return currentController;
  };

  global.stopMesInactivityTimeout = function stopMesInactivityTimeout() {
    if (currentController && typeof currentController.stop === "function") {
      currentController.stop();
    }
    currentController = null;
  };
})(window);
