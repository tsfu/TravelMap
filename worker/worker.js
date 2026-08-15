// AirLog Cloudflare Worker
// Handles two features:
// 1) Flight autofill proxy -> AeroDataBox (RapidAPI)
// 2) Radar ADS-B proxy + optional route enrichment

// -----------------------------------------------------------------------------
// Shared configuration and constants
// -----------------------------------------------------------------------------

// Allowed origins for browser access.
// Production is pinned; localhost/127.0.0.1 with any port is allowed for local dev.
const ALLOWED_ORIGINS = new Set(["https://tsfu.github.io"]);
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Flight autofill validation + cache settings.
const FLIGHT_RE = /^[A-Z0-9]{2,3}\d{1,4}$/; // e.g. UA123, DLH400
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD
const FLIGHT_CACHE_TTL = 86400; // 24h

// Radar cache + enrichment settings.
const ADSB_CACHE_TTL = 20; // seconds
const ADSB_STALE_CACHE_TTL = 300; // 5 minutes
const ADSB_ROUTE_CACHE_TTL = 600; // 10 minutes
const ADSBDB_LOOKUP_CAP = 20; // cap route lookups per scan

// -----------------------------------------------------------------------------
// Entry point and request routing
// -----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const requestOrigin = request.headers.get("Origin") || "";
    const cors = corsHeaders(requestOrigin);

    // Browser preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, cors);
    }

    const url = new URL(request.url);

    // Radar endpoint (no secret/API key needed).
    if (url.pathname === "/adsb") {
      return handleRadarAdsbRequest(url, cors, ctx);
    }

    // Default endpoint is flight autofill.
    return handleFlightAutofillRequest(url, cors, env, ctx);
  },
};

// -----------------------------------------------------------------------------
// Feature 1: Flight autofill proxy (AeroDataBox)
// -----------------------------------------------------------------------------

async function handleFlightAutofillRequest(url, cors, env, ctx) {
  const flightNo = (url.searchParams.get("no") || "")
    .toUpperCase()
    .replace(/\s+/g, "");
  const date = url.searchParams.get("date") || "";

  if (!FLIGHT_RE.test(flightNo)) {
    return json({ error: "bad_flight_number" }, 400, cors);
  }
  if (!DATE_RE.test(date)) {
    return json({ error: "bad_date" }, 400, cors);
  }

  const cache = caches.default;
  const cacheKey = buildFlightCacheKey(url.origin, flightNo, date);
  const hit = await cache.match(cacheKey);
  if (hit) {
    return json(await hit.json(), 200, cors, "HIT");
  }

  if (!env.RAPIDAPI_KEY) {
    return json({ error: "server_misconfigured" }, 500, cors);
  }

  const api =
    `https://aerodatabox.p.rapidapi.com/flights/number/${flightNo}/${date}` +
    `?withAircraftImage=false&withLocation=false`;

  let upstream;
  try {
    upstream = await fetch(api, {
      headers: {
        "X-RapidAPI-Key": env.RAPIDAPI_KEY,
        "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
      },
    });
  } catch {
    return json({ error: "upstream_unreachable" }, 502, cors);
  }

  if (upstream.status === 404) {
    return json({ flightNo, date, legs: [] }, 200, cors);
  }
  if (!upstream.ok) {
    return json({ error: "upstream_error", status: upstream.status }, 502, cors);
  }

  const raw = await upstream.json();
  const payload = {
    flightNo,
    date,
    legs: (Array.isArray(raw) ? raw : []).map(normalizeAutofillLeg),
  };

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(payload), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${FLIGHT_CACHE_TTL}`,
        },
      })
    )
  );

  return json(payload, 200, cors, "MISS");
}

// Maps AeroDataBox response to only fields used by the trip form.
function normalizeAutofillLeg(f) {
  const dep = f.departure || {};
  const arr = f.arrival || {};
  const ac = f.aircraft || {};
  const city = (a) => a?.municipalityName || a?.shortName || a?.name || "";

  return {
    departureIATA: dep.airport?.iata || "",
    departureCity: city(dep.airport),
    arrivalIATA: arr.airport?.iata || "",
    arrivalCity: city(arr.airport),
    takeOffTime: toLocalInput(dep.scheduledTime?.local),
    landingTime: toLocalInput(arr.scheduledTime?.local),
    airlineIATA: f.airline?.iata || "",
    airlineICAO: f.airline?.icao || "", // AirLog stores airline by ICAO
    airlineName: f.airline?.name || "",
    aircraft: ac.model || "", // frontend maps model -> app aircraft value
    tailNumber: ac.reg || "",
    isCargo: !!f.isCargo,
  };
}

// "2026-07-25 07:45+01:00" -> "2026-07-25T07:45" for datetime-local input.
function toLocalInput(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : "";
}

// -----------------------------------------------------------------------------
// Feature 2: Radar ADS-B proxy
// -----------------------------------------------------------------------------

async function handleRadarAdsbRequest(url, cors, ctx) {
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const dist = Number(url.searchParams.get("dist"));

  // Keep input strict to avoid malformed upstream requests.
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return json({ error: "bad_lat" }, 400, cors);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return json({ error: "bad_lon" }, 400, cors);
  }
  if (!Number.isFinite(dist) || dist < 1 || dist > 250) {
    return json({ error: "bad_dist" }, 400, cors);
  }

  const latKey = lat.toFixed(4);
  const lonKey = lon.toFixed(4);
  const distKey = Math.round(dist);

  const cache = caches.default;
  const cacheKey = buildRadarSnapshotCacheKey(url.origin, latKey, lonKey, distKey);
  const staleCacheKey = buildRadarStaleSnapshotCacheKey(
    url.origin,
    latKey,
    lonKey,
    distKey
  );

  const hit = await cache.match(cacheKey);
  if (hit) {
    return json(await hit.json(), 200, cors, "HIT");
  }

  const upstreams = [
    {
      source: "adsb.lol",
      url: `https://api.adsb.lol/v2/lat/${latKey}/lon/${lonKey}/dist/${distKey}`,
    },
    {
      source: "adsb.fi",
      url: `https://opendata.adsb.fi/api/v2/lat/${latKey}/lon/${lonKey}/dist/${distKey}`,
    },
  ];

  let lastErr = "upstream_unreachable";
  const errList = [];

  for (const upstream of upstreams) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      let response;
      try {
        response = await fetch(upstream.url, {
          headers: { Accept: "application/json" },
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        lastErr = `${upstream.source}:http_${response.status}`;
        errList.push(lastErr);
        continue;
      }

      const payload = await response.json();

      // Provider shape compatibility: some use `ac`, others use `aircraft`.
      const aircraft = Array.isArray(payload?.ac)
        ? payload.ac
        : Array.isArray(payload?.aircraft)
          ? payload.aircraft
          : null;

      if (!aircraft) {
        lastErr = `${upstream.source}:bad_payload`;
        errList.push(lastErr);
        continue;
      }

      // Best effort: attach dep/arr route fields by callsign when available.
      let enrichedAircraft = aircraft;
      try {
        enrichedAircraft = await enrichRadarRoutes(aircraft, cache, url.origin, ctx);
      } catch (err) {
        // Keep main ADS-B response alive even if enrichment fails.
        console.warn("WARN: ADS-B route enrichment failed.", err);
      }

      const wrapped = {
        source: upstream.source,
        now: payload.now || null,
        total: Number.isFinite(payload.total)
          ? payload.total
          : enrichedAircraft.length,
        ac: enrichedAircraft,
        stale: false,
      };

      ctx.waitUntil(
        Promise.all([
          cache.put(
            cacheKey,
            new Response(JSON.stringify(wrapped), {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `max-age=${ADSB_CACHE_TTL}`,
              },
            })
          ),
          // Keep a longer backup snapshot so transient upstream blocks don't break the UI.
          cache.put(
            staleCacheKey,
            new Response(JSON.stringify(wrapped), {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `max-age=${ADSB_STALE_CACHE_TTL}`,
              },
            })
          ),
        ])
      );

      return json(wrapped, 200, cors, "MISS");
    } catch {
      lastErr = `${upstream.source}:fetch_failed`;
      errList.push(lastErr);
    }
  }

  // Upstreams failed; try a recent stale snapshot before returning hard failure.
  const staleHit = await cache.match(staleCacheKey);
  if (staleHit) {
    const stalePayload = await staleHit.json();
    return json(
      {
        ...stalePayload,
        stale: true,
        upstreamError: lastErr,
        attempts: errList,
      },
      200,
      cors,
      "STALE"
    );
  }

  return json(
    { error: "upstream_error", detail: lastErr, attempts: errList },
    502,
    cors
  );
}

// -----------------------------------------------------------------------------
// Feature 2a: Radar route enrichment (ADSBDB)
// -----------------------------------------------------------------------------

function normalizeCallsign(value) {
  return (value || "")
    .toString()
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// Limits lookups to airline-like flight IDs (e.g., DAL123, UAL1).
function extractRouteLookupCallsign(ac) {
  const callsign = normalizeCallsign(ac?.flight);
  return /^[A-Z]{3}\d{1,4}[A-Z]?$/.test(callsign) ? callsign : "";
}

function sanitizeIata(value) {
  const code = (value || "").toString().trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

// Cached callsign -> route lookup against ADSBDB.
async function getRouteByCallsignCached(callsign, cache, origin, ctx) {
  const cacheKey = buildRadarRouteCacheKey(origin, callsign);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const cached = await hit.json();
    return cached && cached.miss ? null : cached;
  }

  let route = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2500);
    let response;
    try {
      response = await fetch(
        `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
        {
          headers: { Accept: "application/json" },
          signal: ac.signal,
        }
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      const payload = await response.json();
      const fr = payload?.response?.flightroute;
      const dep = sanitizeIata(fr?.origin?.iata_code);
      const arr = sanitizeIata(fr?.destination?.iata_code);

      if (dep || arr) {
        route = {
          dep_iata: dep,
          arr_iata: arr,
          airline_icao: (fr?.airline?.icao || "").toString().toUpperCase(),
          airline_iata: (fr?.airline?.iata || "").toString().toUpperCase(),
          callsign_iata: (fr?.callsign_iata || "").toString().toUpperCase(),
        };
      }
    }
  } catch {
    route = null;
  }

  // Cache misses too, to avoid repeated failed lookups.
  const cachePayload = route || { miss: true };
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(cachePayload), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `max-age=${ADSB_ROUTE_CACHE_TTL}`,
        },
      })
    )
  );

  return route;
}

// Batch-enriches aircraft list while capping external lookups.
async function enrichRadarRoutes(aircraftList, cache, origin, ctx) {
  if (!Array.isArray(aircraftList) || aircraftList.length < 1) {
    return Array.isArray(aircraftList) ? aircraftList : [];
  }

  const callsigns = [];
  const seen = new Set();
  for (const ac of aircraftList) {
    const cs = extractRouteLookupCallsign(ac);
    if (!cs || seen.has(cs)) continue;
    seen.add(cs);
    callsigns.push(cs);
    if (callsigns.length >= ADSBDB_LOOKUP_CAP) break;
  }

  const routeMap = new Map();
  await Promise.all(
    callsigns.map(async (cs) => {
      const route = await getRouteByCallsignCached(cs, cache, origin, ctx);
      if (route) routeMap.set(cs, route);
    })
  );

  return aircraftList.map((ac) => {
    const cs = extractRouteLookupCallsign(ac);
    const route = cs ? routeMap.get(cs) : null;
    if (!route) return ac;

    return {
      ...ac,
      dep_iata: ac.dep_iata || route.dep_iata,
      arr_iata: ac.arr_iata || route.arr_iata,
      airline_icao: ac.airline_icao || route.airline_icao,
      airline_iata: ac.airline_iata || route.airline_iata,
      callsign_iata: ac.callsign_iata || route.callsign_iata,
    };
  });
}

// -----------------------------------------------------------------------------
// Shared response helpers
// -----------------------------------------------------------------------------

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN_RE.test(origin);
}

function corsHeaders(origin) {
  const h = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (isAllowedOrigin(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function json(obj, status, cors, cacheState) {
  const headers = { "Content-Type": "application/json", ...cors };
  if (cacheState) headers["X-Cache"] = cacheState;
  return new Response(JSON.stringify(obj), { status, headers });
}

function buildFlightCacheKey(origin, flightNo, date) {
  return new Request(`${origin}/c/${flightNo}/${date}`);
}

function buildRadarSnapshotCacheKey(origin, latKey, lonKey, distKey) {
  return new Request(`${origin}/c/adsb/${latKey}/${lonKey}/${distKey}`);
}

function buildRadarStaleSnapshotCacheKey(origin, latKey, lonKey, distKey) {
  return new Request(`${origin}/c/adsb-stale/${latKey}/${lonKey}/${distKey}`);
}

function buildRadarRouteCacheKey(origin, callsign) {
  return new Request(`${origin}/c/adsbdb/route/${callsign}`);
}
