
(function () {
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw0JetnREOTgwfAUKebw0pH5pM7UbIkez0r-ExYCttHSINEN4PXOIMsO8SBe3AZ4Tnvcw/exec";

  const DNT_KEY = "victory_exclude_tracking";
  const dntParam = new URLSearchParams(window.location.search).get("dnt");
  if (dntParam === "1") localStorage.setItem(DNT_KEY, "1");
  if (dntParam === "0") localStorage.removeItem(DNT_KEY);
  if (localStorage.getItem(DNT_KEY) === "1") {
    window.victoryTrack = function () {};
    return;
  }

  function getOrCreateId(storage, key) {
    let id = storage.getItem(key);
    if (!id) {
      id = "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
      storage.setItem(key, id);
    }
    return id;
  }

  const visitorId = getOrCreateId(localStorage, "victory_visitor_id");
  const sessionId = getOrCreateId(sessionStorage, "victory_session_id");

  let firstSeen = localStorage.getItem("victory_first_seen");
  if (!firstSeen) {
    firstSeen = new Date().toISOString();
    localStorage.setItem("victory_first_seen", firstSeen);
  }

  function getGeoData() {
    return new Promise(function (resolve) {
      const GEO_TTL_MS = 24 * 3600000; // 24 horas
      const cachedRaw = localStorage.getItem("victory_geo");
      if (cachedRaw) {
        try {
          const cached = JSON.parse(cachedRaw);
          if (cached.cachedAt && (Date.now() - cached.cachedAt) < GEO_TTL_MS) {
            resolve({ country: cached.country || "", city: cached.city || "" });
            return;
          }
        } catch (e) {}
      }
      fetch("https://ipapi.co/json/")
        .then(function (r) { return r.json(); })
        .then(function (geo) {
          const result = {
            country: geo.country_name || "",
            city: geo.city || "",
            cachedAt: Date.now(),
          };
          localStorage.setItem("victory_geo", JSON.stringify(result));
          resolve({ country: result.country, city: result.city });
        })
        .catch(function () {
          localStorage.setItem("victory_geo", JSON.stringify({ country: "", city: "", cachedAt: Date.now() }));
          resolve({ country: "", city: "" });
        });
    });
  }

  function getUTMParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: params.get("utm_source") || "",
      utm_medium: params.get("utm_medium") || "",
      utm_campaign: params.get("utm_campaign") || "",
    };
  }

  function getDeviceType() {
    const ua = navigator.userAgent;
    if (/tablet|ipad/i.test(ua)) return "tablet";
    if (/mobile|android|iphone/i.test(ua)) return "mobile";
    return "desktop";
  }

  function getBrowser() {
    const ua = navigator.userAgent;
    if (ua.includes("Edg/")) return "Edge";
    if (ua.includes("Chrome/") && !ua.includes("Edg/")) return "Chrome";
    if (ua.includes("Safari/") && !ua.includes("Chrome/")) return "Safari";
    if (ua.includes("Firefox/")) return "Firefox";
    return "Other";
  }

  function sendTrackingData(payload) {
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
        navigator.sendBeacon(APPS_SCRIPT_URL, blob);
        return;
      }
      fetch(APPS_SCRIPT_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: body,
      }).catch(function () {});
    } catch (err) {
      console.warn("Tracking error:", err);
    }
  }

  let cachedGeo = { country: "", city: "" };

  function basePayload() {
    const utm = getUTMParams();
    return {
      action: "track",
      eventType: "pageview",
      visitorId: visitorId,
      sessionId: sessionId,
      firstSeen: firstSeen,
      page: window.location.pathname,
      fullUrl: window.location.href,
      referrer: document.referrer || "(directo)",
      utm_source: utm.utm_source,
      utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign,
      device: getDeviceType(),
      browser: getBrowser(),
      language: navigator.language || "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      country: cachedGeo.country,
      city: cachedGeo.city,
      timestamp: new Date().toISOString(),
    };
  }

  const pageLoadTime = Date.now();
  getGeoData().then(function (geo) {
    cachedGeo = geo;
    sendTrackingData(basePayload());
  });

  function sendTimeOnPage() {
    const seconds = Math.round((Date.now() - pageLoadTime) / 1000);
    const payload = basePayload();
    payload.eventType = "time_on_page";
    payload.eventData = String(seconds);
    sendTrackingData(payload);
  }
  window.addEventListener("pagehide", sendTimeOnPage);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") sendTimeOnPage();
  });

  window.victoryTrack = function (eventName, eventData) {
    const payload = basePayload();
    payload.eventType = eventName;
    payload.eventData = eventData ? JSON.stringify(eventData) : "";
    sendTrackingData(payload);
  };
})();
