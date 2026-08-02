/*
 * Small Company MES - 20분 미사용 자동 로그아웃
 * - 마우스/키보드/터치/스크롤 활동을 기준으로 마지막 사용 시간을 갱신합니다.
 * - 같은 로그인 세션을 사용하는 여러 탭의 활동 시간을 함께 반영합니다.
 * - 20분 동안 활동이 없으면 Supabase 로컬 세션을 종료하고 로그인 화면으로 이동합니다.
 */
(function (global) {
  "use strict";

  const DEFAULT_TIMEOUT_MINUTES = 20;
  const CHECK_INTERVAL_MS = 10 * 1000;
  const ACTIVITY_WRITE_THROTTLE_MS = 5 * 1000;

  function decodeJwtPayload(token) {
    try {
      const payload = String(token || "").split(".")[1];
      if (!payload) return null;
      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
      return JSON.parse(decodeURIComponent(
        Array.prototype.map.call(atob(padded), char =>
          "%" + ("00" + char.charCodeAt(0).toString(16)).slice(-2)
        ).join("")
      ));
    } catch (_) {
      return null;
    }
  }

  async function startMesInactivityTimeout(options) {
    const settings = options || {};
    const supabaseClient = settings.supabaseClient;
    const loginPageUrl = settings.loginPageUrl || "../index.html";
    const timeoutMinutes = Number(settings.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES);
    const timeoutMs = timeoutMinutes * 60 * 1000;

    if (!supabaseClient || !supabaseClient.auth) {
      throw new Error("Supabase 클라이언트가 전달되지 않았습니다.");
    }

    const { data, error } = await supabaseClient.auth.getSession();
    const session = data?.session;

    if (error || !session) {
      window.location.replace(loginPageUrl);
      return null;
    }

    const claims = decodeJwtPayload(session.access_token);
    const sessionId = claims?.session_id || session.user?.id || "unknown";
    const storageKey = "small_company_mes:last_activity:" + sessionId;

    let finished = false;
    let intervalId = null;
    let authSubscription = null;
    let lastWriteAt = 0;

    const activityEvents = [
      "pointerdown",
      "keydown",
      "touchstart",
      "wheel",
      "scroll"
    ];

    function now() {
      return Date.now();
    }

    function readLastActivity() {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved > 0 ? saved : 0;
    }

    function writeLastActivity(timestamp) {
      localStorage.setItem(storageKey, String(timestamp));
      lastWriteAt = timestamp;
    }

    function cleanup() {
      if (intervalId) {
        window.clearInterval(intervalId);
        intervalId = null;
      }

      activityEvents.forEach(eventName => {
        window.removeEventListener(eventName, recordActivity, true);
      });
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("storage", handleStorageChange);

      if (authSubscription?.unsubscribe) {
        authSubscription.unsubscribe();
      }
      authSubscription = null;
    }

    async function forceLogout() {
      if (finished) return;
      finished = true;
      cleanup();
      localStorage.removeItem(storageKey);

      try {
        await supabaseClient.auth.signOut({ scope: "local" });
      } catch (_) {
        // 세션 종료 요청이 실패해도 로그인 화면으로 이동합니다.
      } finally {
        window.alert(timeoutMinutes + "분 동안 사용하지 않아 자동 로그아웃되었습니다. 다시 로그인해 주세요.");
        window.location.replace(loginPageUrl);
      }
    }

    function checkTimeout() {
      if (finished) return true;

      const lastActivity = readLastActivity();
      if (lastActivity > 0 && now() - lastActivity >= timeoutMs) {
        void forceLogout();
        return true;
      }
      return false;
    }

    function recordActivity() {
      if (finished || checkTimeout()) return;

      const current = now();
      if (current - lastWriteAt >= ACTIVITY_WRITE_THROTTLE_MS) {
        writeLastActivity(current);
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (!checkTimeout()) recordActivity();
    }

    function handleStorageChange(event) {
      if (event.key === storageKey) checkTimeout();
    }

    if (!readLastActivity()) {
      writeLastActivity(now());
    }

    if (checkTimeout()) return null;

    activityEvents.forEach(eventName => {
      window.addEventListener(eventName, recordActivity, {
        capture: true,
        passive: true
      });
    });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("storage", handleStorageChange);

    intervalId = window.setInterval(checkTimeout, CHECK_INTERVAL_MS);

    const authStateResult = supabaseClient.auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT") {
        localStorage.removeItem(storageKey);
        cleanup();
      }
    });
    authSubscription = authStateResult?.data?.subscription || null;

    return {
      stop: cleanup,
      checkNow: checkTimeout
    };
  }

  global.startMesInactivityTimeout = startMesInactivityTimeout;
})(window);
