(function () {
  const RADAR_STORAGE_KEY = "airlogRadarSettings";
  const ADSB_PROXY_URL = "https://airlog-flight.fts1109.workers.dev/adsb";
  const ADSB_DIRECT_ENDPOINTS = [
    {
      name: "adsb.lol",
      buildUrl: function (lat, lon, dist) {
        return "https://api.adsb.lol/v2/lat/" + lat + "/lon/" + lon + "/dist/" + dist;
      },
    },
    {
      name: "adsb.fi",
      buildUrl: function (lat, lon, dist) {
        return "https://opendata.adsb.fi/api/v2/lat/" + lat + "/lon/" + lon + "/dist/" + dist;
      },
    },
  ];
  const RADAR_IDLE_MS = 15000;
  const RADAR_SLIDESHOW_MS = 3000;
  const RADAR_MAP_PROMPT_MS = 3000;
  const ADSB_FETCH_TIMEOUT_MS = 12000;

  const state = {
    initialized: false,
    map: null,
    centerMarker: null,
    rangeCircle: null,
    flightLayer: null,
    hasPendingMapChange: false,
    activeRequestId: 0,
    center: { lat: 42.36, lon: -71.06 },
    rangeNm: 10,
    flights: [],
    markerByHex: new Map(),
    hasScanResponse: false,
    screensaverMode: false,
    idleTimer: null,
    slideshowTimer: null,
    showMapPromptTimer: null,
    slideshowIndex: 0,
    locationLabel: "",
    cardsPanelVisible: false,
  };

  const els = {};

  function toFixedNum(num, digits = 4) {
    return Number(num).toFixed(digits);
  }

  function nmToMeters(nm) {
    return Number(nm) * 1852;
  }

  function escapeHtml(value) {
    return (value || "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getFlightCallsign(ac) {
    return (ac.flight || "").trim() || (ac.r || "").trim() || ac.hex || "Unknown";
  }

  function getAircraftTypeText(ac) {
    const description = (ac.desc || "").toString().trim();
    const designator = (ac.t || "").toString().trim();
    const genericType = (ac.type || "").toString().trim();

    if (description && designator) {
      return description + " (" + designator + ")";
    }
    if (description) {
      return description;
    }
    if (designator) {
      return designator;
    }
    if (genericType) {
      return genericType;
    }
    return "Unknown";
  }

  function getAirlineIcaoFromFlight(ac) {
    const flight = (ac.flight || "").trim().toUpperCase();
    const m = flight.match(/^([A-Z]{3})\d/);
    return m ? m[1] : "";
  }

  function getAirlineName(icao) {
    if (!icao || typeof airlineDataMap === "undefined" || !airlineDataMap.has(icao)) {
      return "Unknown Airline";
    }
    return airlineDataMap.get(icao).name || "Unknown Airline";
  }

  function hasAirlineLogo(f) {
    return !!(f.airlineIcao &&
      typeof airlineDataMap !== "undefined" &&
      airlineDataMap.has(f.airlineIcao));
  }

  function getAirlineLogoPath(icao) {
    if (!icao) return "";
    return "./assets/airline_logos/" + icao + ".png";
  }

  function normalizeIata(value) {
    const code = (value || "").toString().trim().toUpperCase();
    return /^[A-Z]{3}$/.test(code) ? code : "";
  }

  function getRouteIata(ac) {
    const dep =
      normalizeIata(ac.dep_iata) ||
      normalizeIata(ac.from) ||
      normalizeIata(ac.origin);
    const arr =
      normalizeIata(ac.arr_iata) ||
      normalizeIata(ac.to) ||
      normalizeIata(ac.destination);

    if (dep || arr) {
      return {
        departureIata: dep,
        arrivalIata: arr,
      };
    }

    const route = (ac.route || "").toString().trim().toUpperCase();
    const m = route.match(/([A-Z]{3})\s*[-/]\s*([A-Z]{3})/);
    if (m) {
      return {
        departureIata: m[1],
        arrivalIata: m[2],
      };
    }

    return {
      departureIata: "",
      arrivalIata: "",
    };
  }

  function readSettings() {
    try {
      const raw = localStorage.getItem(RADAR_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        Number.isFinite(parsed.lat) &&
        Number.isFinite(parsed.lon) &&
        Number.isFinite(parsed.rangeNm)
      ) {
        state.center.lat = parsed.lat;
        state.center.lon = parsed.lon;
        state.rangeNm = Math.min(50, Math.max(0, parsed.rangeNm));
      }
    } catch (err) {
      console.warn("WARN: Cannot read radar settings.", err);
    }
  }

  function writeSettings() {
    try {
      localStorage.setItem(
        RADAR_STORAGE_KEY,
        JSON.stringify({
          lat: state.center.lat,
          lon: state.center.lon,
          rangeNm: state.rangeNm,
        })
      );
    } catch (err) {
      console.warn("WARN: Cannot persist radar settings.", err);
    }
  }

  function setStatus(message, tone) {
    els.status.textContent = message;
    els.status.classList.remove("info", "warn", "error");
    if (tone) {
      els.status.classList.add(tone);
    }
  }

  function updateRangeUi() {
    els.rangeInput.value = String(state.rangeNm);
    els.rangeLabel.textContent = state.rangeNm + " NM";
  }

  function setCardsPanelVisible(visible) {
    state.cardsPanelVisible = !!visible;
    els.layout.classList.toggle("radar-show-cards", state.cardsPanelVisible);
    if (state.map) {
      state.map.invalidateSize();
    }
  }

  function updateMapGeometry() {
    const latlng = [state.center.lat, state.center.lon];
    state.centerMarker.setLatLng(latlng);
    state.rangeCircle.setLatLng(latlng);
    state.rangeCircle.setRadius(nmToMeters(state.rangeNm));
    writeSettings();
  }

  function markDirty(reason) {
    state.hasPendingMapChange = true;
    if (!state.hasScanResponse) {
      setCardsPanelVisible(false);
    }
    setStatus("Map updated \u2014 scan to refresh.", "warn");
  }

  function getDistanceNm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const km = R * c;
    return km * 0.539957;
  }

  function buildPopup(ac, airlineName, distNm) {
    const heading = Number.isFinite(ac.track) ? Math.round(ac.track) + "°" : "--";
    const alt = ac.alt_baro == null ? "--" : String(ac.alt_baro);
    const speed = Number.isFinite(ac.gs) ? Math.round(ac.gs) + " kt" : "--";
    const callsign = escapeHtml(getFlightCallsign(ac));
    const line2 = escapeHtml(airlineName);
    return (
      "<b>" +
      callsign +
      "</b><br/>" +
      line2 +
      "<br/>Alt: " +
      alt +
      " | GS: " +
      speed +
      " | HDG: " +
      heading +
      "<br/>Distance: " +
      distNm.toFixed(1) +
      " NM"
    );
  }

  function sortFlightsByDistance(list) {
    list.sort(function (a, b) {
      return a.distanceNm - b.distanceNm;
    });
  }

  async function fetchJsonWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, ADSB_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      return response.json();
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error("timeout");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchAdsbPayload(lat, lon, dist) {
    const proxyUrl =
      ADSB_PROXY_URL +
      "?lat=" + encodeURIComponent(lat) +
      "&lon=" + encodeURIComponent(lon) +
      "&dist=" + encodeURIComponent(dist);

    // Try worker proxy; retry once on transient failure before falling back.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const payload = await fetchJsonWithTimeout(proxyUrl);
        return { payload: payload, source: payload.source || "worker" };
      } catch (err) {
        console.warn("WARN: worker attempt " + (attempt + 1) + " failed:", err.message);
        if (attempt === 0) {
          await new Promise(function (r) { setTimeout(r, 500); });
        }
      }
    }

    // Direct provider fallbacks (may be blocked by CORS in browser).
    for (let i = 0; i < ADSB_DIRECT_ENDPOINTS.length; i++) {
      const provider = ADSB_DIRECT_ENDPOINTS[i];
      try {
        const payload = await fetchJsonWithTimeout(provider.buildUrl(lat, lon, dist));
        return { payload: payload, source: provider.name };
      } catch (err) {
        console.warn("WARN: " + provider.name + " failed:", err.message);
      }
    }

    throw new Error("unavailable");
  }

  function selectFlight(hex) {
    const flight = state.flights.find(function (f) {
      return f.hex === hex;
    });
    if (!flight) return;
    const marker = state.markerByHex.get(hex);
    if (marker) {
      marker.openPopup();
      state.map.panTo([flight.lat, flight.lon], { animate: true });
    }
  }

  function clearIdleTimer() {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  function clearSlideshowTimer() {
    if (state.slideshowTimer) {
      clearInterval(state.slideshowTimer);
      state.slideshowTimer = null;
    }
  }

  function clearShowMapPromptTimer() {
    if (state.showMapPromptTimer) {
      clearTimeout(state.showMapPromptTimer);
      state.showMapPromptTimer = null;
    }
  }

  function hideShowMapPrompt() {
    clearShowMapPromptTimer();
    els.layout.classList.remove("radar-show-map-prompt");
  }

  function revealShowMapPrompt() {
    if (!state.screensaverMode) {
      return;
    }
    els.layout.classList.add("radar-show-map-prompt");
    clearShowMapPromptTimer();
    state.showMapPromptTimer = setTimeout(function () {
      els.layout.classList.remove("radar-show-map-prompt");
      state.showMapPromptTimer = null;
    }, RADAR_MAP_PROMPT_MS);
  }

  function exitScreensaverMode() {
    if (!state.screensaverMode) {
      return;
    }
    state.screensaverMode = false;
    hideShowMapPrompt();
    clearSlideshowTimer();
    els.layout.classList.remove("radar-screensaver");
    renderCards();
    if (state.map) {
      // Delay past the 0.35s grid column CSS transition so Leaflet
      // measures the correct expanded container width.
      setTimeout(function () { state.map.invalidateSize(); }, 380);
    }
  }

  function startSlideshowTimer() {
    clearSlideshowTimer();
    state.slideshowTimer = setInterval(function () {
      if (!state.screensaverMode) return;
      var slides = state.flights.filter(hasAirlineLogo);
      if (slides.length < 2) return;
      state.slideshowIndex = (state.slideshowIndex + 1) % slides.length;
      renderCards();
    }, RADAR_SLIDESHOW_MS);
  }

  function enterScreensaverMode() {
    var slides = state.flights.filter(hasAirlineLogo);
    if (state.screensaverMode || !state.hasScanResponse || slides.length < 1) {
      return;
    }
    setCardsPanelVisible(true);
    state.screensaverMode = true;
    hideShowMapPrompt();
    state.slideshowIndex = 0;
    els.layout.classList.add("radar-screensaver");
    renderCards();
    startSlideshowTimer();
  }

  function resetIdleModeTimer() {
    clearIdleTimer();
    if (!state.hasScanResponse || state.flights.length < 1) {
      return;
    }
    state.idleTimer = setTimeout(function () {
      enterScreensaverMode();
    }, RADAR_IDLE_MS);
  }

  function onMapRefocus() {
    if (state.screensaverMode) {
      revealShowMapPrompt();
      return;
    }
    resetIdleModeTimer();
  }

  function getFlightCardHtml(f) {
    const logo = f.airlineIcao
      ? '<img class="radar-airline-logo" src="' +
        getAirlineLogoPath(f.airlineIcao) +
        '" alt="' +
        escapeHtml(f.airlineIcao) +
        '" onerror="this.style.display=\'none\';" />'
      : '<div class="radar-airline-badge">--</div>';

    const altText = f.altText || "--";
    const spdText = f.speedText || "--";
    const hdgText = f.headingText || "--";
    const depText = f.departureIata || "---";
    const arrText = f.arrivalIata || "---";
    const aircraftText = f.aircraftType || "Unknown";

    return (
      '<article class="radar-card" data-hex="' +
      escapeHtml(f.hex) +
      '">' +
      '<div class="radar-card-top">' +
      logo +
      '<div>' +
      '<h3>' +
      escapeHtml(f.callsign) +
      '</h3>' +
      '<p class="radar-airline-name">' +
      escapeHtml(f.airlineName) +
      '</p>' +
      '</div>' +
      '</div>' +
      '<div class="radar-metrics">' +
      '<span class="radar-route-row">Route: <b>' +
      escapeHtml(depText) +
      ' -> ' +
      escapeHtml(arrText) +
      '</b></span>' +
      '<span class="radar-route-row">Aircraft: <b>' +
      escapeHtml(aircraftText) +
      '</b></span>' +
      '<span>Alt: <b>' +
      escapeHtml(altText) +
      '</b></span>' +
      '<span>GS: <b>' +
      escapeHtml(spdText) +
      '</b></span>' +
      '<span>HDG: <b>' +
      escapeHtml(hdgText) +
      '</b></span>' +
      '<span>Dist: <b>' +
      f.distanceNm.toFixed(1) +
      ' NM</b></span>' +
      '</div>' +
      '</article>'
    );
  }

  function getSlideshowCardHtml(f) {
    const locationHtml = '<div class="radar-led-location">@ ' +
      escapeHtml(state.locationLabel || '\u00b7\u00b7\u00b7') + '</div>';

    const logoHtml = f.airlineIcao
      ? '<img class="radar-airline-logo" src="' +
        getAirlineLogoPath(f.airlineIcao) +
        '" alt="' + escapeHtml(f.airlineIcao) +
        '" onerror="this.style.display=\'none\';"/>' :
        '<div class="radar-airline-badge">' + escapeHtml(f.airlineIcao || '?') + '</div>';

    const depText = f.departureIata || '---';
    const arrText = f.arrivalIata || '---';

    return (
      '<article class="radar-led-card" data-hex="' + escapeHtml(f.hex) + '">' +
      locationHtml +
      '<div class="radar-led-upper">' +
        '<div class="radar-led-logo-col">' + logoHtml + '</div>' +
        '<div class="radar-led-info-col">' +
          '<div class="radar-led-callsign">' + escapeHtml(f.callsign) + '</div>' +
          '<div class="radar-led-route">' + escapeHtml(depText) + ' &#x2192; ' + escapeHtml(arrText) + '</div>' +
          '<div class="radar-led-aircraft">' + escapeHtml(f.aircraftType || 'Unknown') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="radar-led-lower">' +
        '<div class="radar-led-metric"><span>ALT</span><b>' + escapeHtml(f.altText) + '</b></div>' +
        '<div class="radar-led-metric"><span>GSPD</span><b>' + escapeHtml(f.speedText) + '</b></div>' +
        '<div class="radar-led-metric"><span>HDG</span><b>' + escapeHtml(f.headingText) + '</b></div>' +
        '<div class="radar-led-metric"><span>DIST</span><b>' + f.distanceNm.toFixed(1) + ' NM</b></div>' +
      '</div>' +
      '</article>'
    );
  }

  function renderCards() {
    var slides = state.flights.filter(hasAirlineLogo);
    els.slideshowWrapper.style.display =
      (state.hasScanResponse && slides.length > 0 && !state.screensaverMode) ? "flex" : "none";

    if (!state.flights.length) {
      els.cards.innerHTML = '<p class="radar-empty">No flights in range.</p>';
      return;
    }

    if (state.screensaverMode) {
      if (!slides.length) {
        els.cards.innerHTML = '<p class="radar-empty">No airline flights in range.</p>';
        return;
      }
      const idx = state.slideshowIndex % slides.length;
      const current = slides[idx];
      const progress =
        '<div class="radar-slideshow-progress">Flight ' +
        (idx + 1) +
        " / " +
        slides.length +
        "</div>";
      els.cards.innerHTML =
        '<div class="radar-slideshow-card">' + getSlideshowCardHtml(current) + progress + "</div>";
    } else {
      const html = state.flights.map(getFlightCardHtml).join("");
      els.cards.innerHTML = html;
    }

    const items = els.cards.querySelectorAll(".radar-card");
    items.forEach(function (item) {
      item.addEventListener("click", function () {
        selectFlight(item.getAttribute("data-hex"));
      });
    });
  }

  function renderMapFlights() {
    state.flightLayer.clearLayers();
    state.markerByHex.clear();

    state.flights.forEach(function (f) {
      const marker = L.circleMarker([f.lat, f.lon], {
        radius: 5,
        color: "#074f3c",
        weight: 1,
        fillColor: "#13a67b",
        fillOpacity: 0.8,
      });
      marker.bindPopup(buildPopup(f.raw, f.airlineName, f.distanceNm));
      marker.addTo(state.flightLayer);
      state.markerByHex.set(f.hex, marker);
    });
  }

  function normalizeFlights(rawAircraft) {
    const normalized = [];
    for (let i = 0; i < rawAircraft.length; i++) {
      const ac = rawAircraft[i];
      if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon) || !ac.hex) {
        continue;
      }

      const distanceNm = getDistanceNm(
        state.center.lat,
        state.center.lon,
        ac.lat,
        ac.lon
      );
      const airlineIcao = getAirlineIcaoFromFlight(ac);
      const airlineName = getAirlineName(airlineIcao);
      const route = getRouteIata(ac);

      normalized.push({
        hex: String(ac.hex),
        lat: Number(ac.lat),
        lon: Number(ac.lon),
        callsign: getFlightCallsign(ac),
        airlineIcao: airlineIcao,
        airlineName: airlineName,
        departureIata: route.departureIata,
        arrivalIata: route.arrivalIata,
        aircraftType: getAircraftTypeText(ac),
        distanceNm: distanceNm,
        altText: ac.alt_baro == null ? "--" : String(ac.alt_baro),
        speedText: Number.isFinite(ac.gs) ? Math.round(ac.gs) + " kt" : "--",
        headingText: Number.isFinite(ac.track) ? Math.round(ac.track) + "°" : "--",
        raw: ac,
      });
    }

    sortFlightsByDistance(normalized);
    return normalized;
  }

  async function scanFlights() {
    const requestId = ++state.activeRequestId;
    exitScreensaverMode();
    clearIdleTimer();
    state.hasPendingMapChange = false;
    setStatus("Scanning live ADS-B flights...", "info");

    const lat = toFixedNum(state.center.lat, 5);
    const lon = toFixedNum(state.center.lon, 5);
    // Worker validates dist >= 1; keep UI allowing 0 NM for a "center-only" feel.
    const dist = String(Math.max(1, state.rangeNm));

    try {
      const result = await fetchAdsbPayload(lat, lon, dist);
      const payload = result.payload;
      if (requestId !== state.activeRequestId) {
        return;
      }

      const list = Array.isArray(payload.ac) ? payload.ac : [];
      state.flights = normalizeFlights(list).filter(function (f) {
        return f.distanceNm <= state.rangeNm;
      });
      state.hasScanResponse = true;
      state.slideshowIndex = 0;
      fetchLocationLabel(state.center.lat, state.center.lon);

      renderMapFlights();
      renderCards();
      setCardsPanelVisible(true);

      if (payload.stale) {
        setStatus(state.flights.length + " flights (cached data)", "warn");
      } else {
        setStatus(state.flights.length + " flights in range", "info");
      }
      resetIdleModeTimer();
    } catch (err) {
      if (requestId !== state.activeRequestId) {
        return;
      }
      console.error("ERROR: radar scan failed.", err);
      if (!state.hasScanResponse) {
        setCardsPanelVisible(false);
      }
      setStatus("Scan failed. Please try again.", "error");
      clearIdleTimer();
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setStatus("Geolocation is not available in this browser.", "error");
      return;
    }

    setStatus("Getting your location...", "info");
    navigator.geolocation.getCurrentPosition(
      function (position) {
        state.center = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        updateMapGeometry();
        state.map.setView([state.center.lat, state.center.lon], 9);
        markDirty("Current location updated.");
        fetchLocationLabel(state.center.lat, state.center.lon);
      },
      function (error) {
        setStatus("Location denied/unavailable: " + error.message, "error");
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
      }
    );
  }

  async function fetchLocationLabel(lat, lon) {
    try {
      const url = "https://nominatim.openstreetmap.org/reverse" +
        "?lat=" + encodeURIComponent(lat.toFixed(5)) +
        "&lon=" + encodeURIComponent(lon.toFixed(5)) +
        "&format=json&zoom=10&addressdetails=1";
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, 5000);
      let resp;
      try {
        resp = await fetch(url, { signal: controller.signal, headers: { "Accept-Language": "en" } });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        console.warn("Geocoding HTTP error:", resp.status);
        return;
      }
      const data = await resp.json();
      const a = data.address || {};
      const city = a.city || a.town || a.municipality || a.village || a.county || "";
      let region = "";
      if (a.country_code === "us") {
        const sub = a["ISO3166-2-lvl4"] || "";
        region = sub.split("-")[1] || "US";
      } else {
        region = (a.country_code || "").toUpperCase();
      }
      const label = city && region
        ? city.toUpperCase() + ", " + region
        : (city || region).toUpperCase();
      if (label) state.locationLabel = label;
    } catch (err) {
      console.warn("Geocoding error:", err);
    }
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function requestFullscreen(el) {
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  }

  function exitFullscreen() {
    if (!isFullscreen()) return;
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }

  function syncFullscreenIcon() {
    var fs = isFullscreen();
    els.fullscreenButton.textContent = fs ? "\u2715" : "\u26F6";
    els.fullscreenButton.title = fs ? "Exit fullscreen" : "Toggle fullscreen";
    els.layout.classList.toggle("radar-in-fullscreen", fs);
  }

  function bindEvents() {
    els.scanButton.addEventListener("click", scanFlights);
    els.fullscreenButton.addEventListener("click", function () {
      if (isFullscreen()) {
        exitFullscreen();
      } else {
        requestFullscreen(document.documentElement);
      }
    });
    document.addEventListener("fullscreenchange", syncFullscreenIcon);
    document.addEventListener("webkitfullscreenchange", syncFullscreenIcon);

    els.slideshowButton.addEventListener("click", enterScreensaverMode);

    els.showMapButton.addEventListener("click", function () {
      exitScreensaverMode();
      exitFullscreen();
      resetIdleModeTimer();
    });

    els.locateButton.addEventListener("click", function () {
      onMapRefocus();
      useMyLocation();
    });

    els.rangeInput.addEventListener("input", function () {
      const next = Number(els.rangeInput.value);
      if (!Number.isFinite(next)) return;
      state.rangeNm = next;
      updateRangeUi();
      updateMapGeometry();
      markDirty("Range changed.");
      onMapRefocus();
    });

    els.layout.addEventListener("mousemove", onMapRefocus);
    els.layout.addEventListener("mouseenter", function () {
      if (!state.screensaverMode) resetIdleModeTimer();
    });

    state.map.on("moveend", function () {
      if (state.screensaverMode) return;
      const c = state.map.getCenter();
      state.center = { lat: c.lat, lon: c.lng };
      updateMapGeometry();
      markDirty("Map center changed.");
      onMapRefocus();
    });

    state.centerMarker.on("dragend", function () {
      if (state.screensaverMode) return;
      const ll = state.centerMarker.getLatLng();
      state.center = { lat: ll.lat, lon: ll.lng };
      updateMapGeometry();
      markDirty("Center marker moved.");
      onMapRefocus();
    });
  }

  function cacheElements() {
    els.scanButton = document.getElementById("radarScanButton");
    els.locateButton = document.getElementById("radarLocateButton");
    els.status = document.getElementById("radarStatus");
    els.rangeInput = document.getElementById("radarRangeInput");
    els.rangeLabel = document.getElementById("radarRangeLabel");
    els.cards = document.getElementById("radarCards");
    els.slideshowButton = document.getElementById("radarSlideshowButton");
    els.slideshowWrapper = document.getElementById("radarSlideshowWrapper");
    els.layout = document.getElementById("radarLayout");
    els.mapPanel = document.getElementById("radarMapPanel");
    els.showMapButton = document.getElementById("radarShowMapButton");
    els.fullscreenButton = document.getElementById("radarFullscreenButton");
  }

  function initMap() {
    state.map = L.map("radarMap", {
      center: [state.center.lat, state.center.lon],
      zoom: 7,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors | ADS-B: adsb.lol',
    }).addTo(state.map);

    state.flightLayer = L.layerGroup().addTo(state.map);
    state.centerMarker = L.marker([state.center.lat, state.center.lon], {
      draggable: true,
      title: "Radar Center",
    }).addTo(state.map);

    state.rangeCircle = L.circle([state.center.lat, state.center.lon], {
      radius: nmToMeters(state.rangeNm),
      color: "#f49f0a",
      weight: 2,
      fillColor: "#f49f0a",
      fillOpacity: 0.12,
    }).addTo(state.map);
  }

  function initializeRadar() {
    if (state.initialized) {
      state.map.invalidateSize();
      return;
    }

    readSettings();
    cacheElements();
    updateRangeUi();
    setCardsPanelVisible(false);

    initMap();
    bindEvents();

    state.initialized = true;

    // Try user location first; if denied, keep default center and let user scan manually.
    useMyLocation();
  }

  window.initRadarTab = initializeRadar;
})();