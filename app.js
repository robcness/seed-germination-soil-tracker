// ===== Lowville Soil Tracker — static (GitHub Pages) =====
// All data fetching, computation, and rendering run in the browser.
// No backend, no build step. Open-Meteo supports CORS.

const LAT = 43.431;
const LON = -79.904;
const TZ = "America/Toronto";

const REFRESH_MS = 10 * 60 * 1000; // 10 minutes
const TICK_MS = 30 * 1000; // update "X ago" label

// ---------- Helpers ----------
function tempColor(c) {
  if (c == null || Number.isNaN(c)) return "hsl(var(--muted-foreground))";
  if (c <= -5) return "#1e40af";
  if (c <= 0) return "#2563eb";
  if (c <= 5) return "#0ea5e9";
  if (c < 10) return "#0891b2";
  if (c <= 18) return "#16a34a";
  if (c <= 22) return "#65a30d";
  if (c <= 26) return "#f59e0b";
  return "#dc2626";
}

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr${hr === 1 ? "" : "s"} ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function fmtShortDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

function dayLabel(iso, i) {
  if (i === 0) return "Today";
  if (i === 1) return "Tomorrow";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-CA", {
    weekday: "short", month: "short", day: "numeric",
  });
}

function nearestHourIndex(times) {
  const now = Date.now();
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]).getTime();
    const d = Math.abs(t - now);
    if (d < bestDiff) { bestDiff = d; bestIdx = i; }
  }
  return bestIdx;
}

function todayIndex(dates) {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const idx = dates.indexOf(today);
  return idx >= 0 ? idx : 0;
}

// ---------- Domain logic (mirrors server/routes.ts) ----------
function computeStatus({ soil6, overnightLow, daytimeHigh, frost }) {
  const noGo = [];
  if (frost) noGo.push("Frost / freeze risk in forecast");
  if (soil6 < 8) noGo.push(`Soil @ 6cm = ${soil6.toFixed(1)}°C — need ≥8°C to start warming`);
  if (overnightLow < 0) noGo.push(`Overnight low ${overnightLow.toFixed(1)}°C — below freezing`);
  if (noGo.length > 0) return { status: "NO-GO", reasons: noGo, goFactors: [] };

  const goChecks = [
    { ok: soil6 >= 10,         msg: `Soil @ 6cm ${soil6.toFixed(1)}°C ≥ 10°C` },
    { ok: overnightLow >= 3,   msg: `Overnight low ${overnightLow.toFixed(1)}°C ≥ 3°C` },
    { ok: daytimeHigh >= 12,   msg: `Daytime high ${daytimeHigh.toFixed(0)}°C ≥ 12°C` },
    { ok: !frost,              msg: "No frost in outlook" },
  ];
  if (goChecks.every(c => c.ok)) {
    return { status: "GO!", reasons: [], goFactors: goChecks.map(c => c.msg) };
  }
  const almost = [];
  if (soil6 >= 8 && soil6 < 10) almost.push(`Soil @ 6cm ${soil6.toFixed(1)}°C — warming, need ≥10°C`);
  if (overnightLow >= 0 && overnightLow < 3) almost.push(`Overnight low ${overnightLow.toFixed(1)}°C — need ≥3°C`);
  if (daytimeHigh >= 7 && daytimeHigh < 12) almost.push(`Daytime high ${daytimeHigh.toFixed(0)}°C — need ≥12°C`);
  if (almost.length === 0) almost.push("Close to ready — keep monitoring");
  return { status: "GET READY", reasons: almost, goFactors: goChecks.filter(c => c.ok).map(c => c.msg) };
}

function detectFrost(dailyLows) {
  const window = dailyLows.slice(0, 10);
  const minLow = Math.min(...window);
  const keywords = [];
  if (minLow <= 0) keywords.push("freeze");
  else if (minLow <= 2) keywords.push("frost");
  return { frost: minLow <= 2, keywords };
}

async function fetchSoilData() {
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=soil_temperature_0cm,soil_temperature_6cm,soil_temperature_18cm` +
    `&daily=temperature_2m_max,temperature_2m_min&temperature_unit=celsius` +
    `&timezone=${encodeURIComponent(TZ)}`;
  const currentUrl = base + "&forecast_days=7";
  const trendUrl = base + "&past_days=14&forecast_days=7";

  const [currentRes, trendRes] = await Promise.all([
    fetch(currentUrl),
    fetch(trendUrl),
  ]);
  if (!currentRes.ok) throw new Error(`Open-Meteo current failed: ${currentRes.status}`);
  if (!trendRes.ok) throw new Error(`Open-Meteo trend failed: ${trendRes.status}`);
  const current = await currentRes.json();
  const trend = await trendRes.json();
  return buildPayload(current, trend);
}

function buildPayload(current, trend) {
  const hourly = current.hourly;
  const daily = current.daily;
  const nowIdx = nearestHourIndex(hourly.time);
  const todayIdx = todayIndex(daily.time);

  const soilSurface = hourly.soil_temperature_0cm[nowIdx];
  const soil6       = hourly.soil_temperature_6cm[nowIdx];
  const soil18      = hourly.soil_temperature_18cm[nowIdx];
  const airHigh     = daily.temperature_2m_max[todayIdx];
  const airLow      = daily.temperature_2m_min[todayIdx];
  const hour = new Date().getHours();
  const tonightLow = (hour >= 12 && daily.temperature_2m_min[todayIdx + 1] !== undefined)
    ? daily.temperature_2m_min[todayIdx + 1]
    : daily.temperature_2m_min[todayIdx];

  const frostRes = detectFrost(daily.temperature_2m_min);
  const status = computeStatus({
    soil6, overnightLow: tonightLow, daytimeHigh: airHigh, frost: frostRes.frost,
  });

  // Consecutive-days-above-10 streak from trend hourly data
  let consecutiveSoilGoDays = 0;
  if (trend.hourly) {
    const byDate = new Map();
    for (let i = 0; i < trend.hourly.time.length; i++) {
      const d = trend.hourly.time[i].slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(trend.hourly.soil_temperature_6cm[i]);
    }
    const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    const dates = Array.from(byDate.keys()).filter(d => d <= todayLocal).sort();
    for (let i = dates.length - 1; i >= 0; i--) {
      const arr = byDate.get(dates[i]);
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      if (mean >= 10) consecutiveSoilGoDays++;
      else break;
    }
  }

  // Daily trend (14:00 reading each day)
  const dailyTrend = [];
  if (trend.hourly) {
    const byDate = new Map();
    for (let i = 0; i < trend.hourly.time.length; i++) {
      const t = trend.hourly.time[i];
      const d = t.slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push({ idx: i, t });
    }
    const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    const sortedDates = Array.from(byDate.keys()).sort();
    for (const d of sortedDates) {
      const entries = byDate.get(d);
      let pick = entries.find(e => e.t.endsWith("T14:00"));
      if (!pick) pick = entries[Math.floor(entries.length / 2)];
      dailyTrend.push({
        date: d,
        surface: trend.hourly.soil_temperature_0cm[pick.idx],
        soil6:   trend.hourly.soil_temperature_6cm[pick.idx],
        soil18:  trend.hourly.soil_temperature_18cm[pick.idx],
        isForecast: d > todayLocal,
      });
    }
  }

  const forecast = daily.time.map((d, i) => ({
    date: d,
    high: daily.temperature_2m_max[i],
    low:  daily.temperature_2m_min[i],
  }));

  return {
    location: { name: "Lowville / North Burlington, ON", lat: LAT, lon: LON },
    current: { soilSurface, soil6, soil18, airHigh, airLow, tonightLow },
    status,
    frost: frostRes,
    conditions: {
      soil6Above10For5Days: consecutiveSoilGoDays >= 5,
      consecutiveSoilGoDays,
      overnightLowAbove3: tonightLow >= 3,
      noFrostIn10Day: !frostRes.frost,
      soilWorkable: null,
      turfSurfaceAbove10: null,
    },
    trend: dailyTrend,
    forecast,
    generatedAt: new Date().toISOString(),
  };
}

// ---------- Rendering: gauges ----------
function renderGauge(containerId, value, label, subLabel, opts = {}) {
  const container = document.getElementById(containerId);
  const { markerAt, markerLabel, min = -10, max = 30 } = opts;
  const size = 220;
  const stroke = 14;
  const cx = size / 2;
  const cy = size / 2 + 20;
  const r = size / 2 - stroke - 6;

  const clamp = n => Math.max(min, Math.min(max, n));
  const toAngle = v => 180 + ((clamp(v) - min) / (max - min)) * 180;
  const polar = (ang, radius) => {
    const a = (ang * Math.PI) / 180;
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
  };
  const arcPath = (s, e, radius) => {
    const sp = polar(s, radius), ep = polar(e, radius);
    const large = e - s > 180 ? 1 : 0;
    return `M ${sp.x} ${sp.y} A ${radius} ${radius} 0 ${large} 1 ${ep.x} ${ep.y}`;
  };

  const trackPath = arcPath(180, 360, r);
  const valueEnd = toAngle(value);
  const valuePath = arcPath(180, valueEnd, r);
  const gradId = `grad-${containerId}`;
  const color = tempColor(value);

  // Ticks
  let ticks = "";
  for (let t = min; t <= max; t += 5) {
    const ang = toAngle(t);
    const inner = polar(ang, r - 4), outer = polar(ang, r + 4);
    const major = t % 10 === 0;
    ticks += `<line x1="${inner.x}" y1="${inner.y}" x2="${outer.x}" y2="${outer.y}" stroke="hsl(var(--muted-foreground))" stroke-opacity="${major ? 0.55 : 0.25}" stroke-width="${major ? 1.25 : 1}"/>`;
  }

  // Marker
  let markerSvg = "";
  if (markerAt != null) {
    const mAng = toAngle(markerAt);
    const mi = polar(mAng, r - 10), mo = polar(mAng, r + 10), ml = polar(mAng, r + 24);
    markerSvg = `
      <line x1="${mi.x}" y1="${mi.y}" x2="${mo.x}" y2="${mo.y}" stroke="hsl(142 72% 42%)" stroke-width="2.5" stroke-linecap="round"/>
      <text x="${ml.x}" y="${ml.y}" text-anchor="middle" dominant-baseline="middle" font-size="9" font-weight="600" fill="hsl(142 72% 35%)">${markerLabel || ""}</text>
    `;
  }
  const minPos = polar(180, r);
  const maxPos = polar(360, r);

  const svg = `
    <svg class="gauge-svg" width="${size}" height="${size * 0.72}" viewBox="0 0 ${size} ${size * 0.82}">
      <defs>
        <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#2563eb"/>
          <stop offset="25%" stop-color="#0891b2"/>
          <stop offset="45%" stop-color="#16a34a"/>
          <stop offset="65%" stop-color="#22c55e"/>
          <stop offset="82%" stop-color="#f59e0b"/>
          <stop offset="100%" stop-color="#dc2626"/>
        </linearGradient>
      </defs>
      <path d="${trackPath}" fill="none" stroke="hsl(var(--muted))" stroke-width="${stroke}" stroke-linecap="round"/>
      ${ticks}
      <path d="${valuePath}" fill="none" stroke="url(#${gradId})" stroke-width="${stroke}" stroke-linecap="round" style="filter: drop-shadow(0 0 6px rgba(0,0,0,0.15))"/>
      ${markerSvg}
      <text x="${cx}" y="${cy - 12}" text-anchor="middle" font-size="38" font-weight="600" font-family="var(--font-sans)" style="fill: ${color}; font-variant-numeric: tabular-nums;">${value.toFixed(1)}</text>
      <text x="${cx}" y="${cy + 10}" text-anchor="middle" font-size="11" font-weight="500" fill="hsl(var(--muted-foreground))">°C</text>
      <text x="${minPos.x - 4}" y="${minPos.y + 16}" text-anchor="middle" font-size="9" fill="hsl(var(--muted-foreground))">${min}°</text>
      <text x="${maxPos.x + 4}" y="${maxPos.y + 16}" text-anchor="middle" font-size="9" fill="hsl(var(--muted-foreground))">${max}°</text>
    </svg>
  `;

  container.innerHTML = `
    <span class="gauge-title">${label}</span>
    ${subLabel ? `<span class="gauge-sublabel">${subLabel}</span>` : ""}
    ${svg}
  `;
}

// ---------- Rendering: status, air, checklist, forecast, chart ----------
const STATUS_META = {
  "NO-GO": {
    color: "#dc2626",
    pulse: "pulse-red",
    blurb: "Hold off seeding — conditions are not yet safe.",
  },
  "GET READY": {
    color: "#f59e0b",
    pulse: "pulse-amber",
    blurb: "Trending toward seeding — prep materials, watch daily.",
  },
  "GO!": {
    color: "#16a34a",
    pulse: "pulse-green",
    blurb: "Conditions met — safe to seed. Go now.",
  },
};

function renderStatus(status, generatedAt) {
  const meta = STATUS_META[status.status];
  const circle = document.getElementById("status-circle");
  circle.className = `status-circle ${meta.pulse}`;
  circle.style.background = `radial-gradient(circle at 30% 30%, ${meta.color}ee, ${meta.color}88)`;
  circle.style.border = `3px solid ${meta.color}`;
  document.getElementById("status-label").textContent = status.status;
  document.getElementById("status-blurb").textContent = meta.blurb;

  const reasonsEl = document.getElementById("status-reasons");
  const shown = status.status !== "GO!" ? status.reasons : status.goFactors;
  reasonsEl.innerHTML = shown.slice(0, 3).map(r => `
    <li>
      <span class="bullet" style="background:${meta.color}"></span>
      <span>${escapeHtml(r)}</span>
    </li>
  `).join("");

  updateRelativeTime(generatedAt);
}

function updateRelativeTime(iso) {
  document.getElementById("status-updated").textContent = `Last updated · ${relativeTime(iso)}`;
}

function renderAir(current) {
  const hi = document.getElementById("air-high");
  const lo = document.getElementById("air-low");
  hi.style.color = tempColor(current.airHigh);
  lo.style.color = tempColor(current.airLow);
  hi.innerHTML = `${current.airHigh.toFixed(0)}<span class="air-unit">°</span>`;
  lo.innerHTML = `${current.airLow.toFixed(0)}<span class="air-unit">°</span>`;
  document.getElementById("air-tonight").textContent = `${current.tonightLow.toFixed(1)}°C`;
}

function renderChecklist(conditions, current) {
  const items = [
    {
      label: "Soil @ 6cm ≥ 10°C for 5+ days",
      sub: `Current: ${current.soil6.toFixed(1)}°C · streak ${conditions.consecutiveSoilGoDays} day${conditions.consecutiveSoilGoDays === 1 ? "" : "s"}`,
      state: conditions.soil6Above10For5Days ? "yes" : "no",
    },
    {
      label: "Overnight low ≥ 3°C",
      sub: `Tonight: ${current.tonightLow.toFixed(1)}°C`,
      state: conditions.overnightLowAbove3 ? "yes" : "no",
    },
    {
      label: "No frost in 10-day outlook",
      sub: "Checks for freeze / frost keywords across forecast",
      state: conditions.noFrostIn10Day ? "yes" : "no",
    },
    {
      label: "Soil workable (not muddy)",
      sub: "Manual check · walk the site",
      state: conditions.soilWorkable == null ? "unknown" : (conditions.soilWorkable ? "yes" : "no"),
    },
    {
      label: "Turf surface > 10°C at 8 AM",
      sub: "Use your laser thermometer",
      state: conditions.turfSurfaceAbove10 == null ? "unknown" : (conditions.turfSurfaceAbove10 ? "yes" : "no"),
    },
  ];
  const iconMap = {
    yes: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    no:  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    unknown: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  };
  const met = items.filter(i => i.state === "yes").length;
  document.getElementById("checklist-met").textContent = met;
  document.getElementById("checklist-total").textContent = items.length;
  document.getElementById("checklist").innerHTML = items.map((it, i) => `
    <li class="check-item" data-idx="${i}">
      <div class="check-icon ${it.state}">${iconMap[it.state]}</div>
      <div class="check-body">
        <div class="check-label">${escapeHtml(it.label)}</div>
        ${it.sub ? `<div class="check-sub">${escapeHtml(it.sub)}</div>` : ""}
      </div>
    </li>
  `).join("");
}

function forecastIconSvg(high, low) {
  if (low <= 0) {
    // snowflake
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/></svg>`;
  }
  if (low <= 3) {
    // cloud-snow
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25"/><line x1="8" y1="19" x2="8" y2="21"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="16" y1="19" x2="16" y2="21"/><line x1="16" y1="13" x2="16" y2="15"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="12" y1="15" x2="12" y2="17"/></svg>`;
  }
  if (high >= 18) {
    // sun
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>`;
  }
  if (high >= 10) {
    // cloud
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
  }
  // cloud-rain
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="16" y1="13" x2="16" y2="21"/><line x1="8" y1="13" x2="8" y2="21"/><line x1="12" y1="15" x2="12" y2="23"/><path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/></svg>`;
}

function renderForecast(forecast) {
  const list = forecast.slice(0, 7).map((d, i) => {
    const cold = d.low <= 0;
    return `
      <li class="forecast-item">
        <div class="forecast-icon ${cold ? "cold" : "warm"}">${forecastIconSvg(d.high, d.low)}</div>
        <div class="forecast-body">
          <div class="forecast-day">${escapeHtml(dayLabel(d.date, i))}</div>
          ${cold ? `<div class="forecast-tag">Frost risk</div>` : ""}
        </div>
        <div class="forecast-temps">
          <span class="forecast-high" style="color:${tempColor(d.high)}">${d.high.toFixed(0)}°</span>
          <span class="forecast-sep">/</span>
          <span class="forecast-low" style="color:${tempColor(d.low)}">${d.low.toFixed(0)}°</span>
        </div>
      </li>
    `;
  }).join("");
  document.getElementById("forecast-list").innerHTML = list;
}

// ---------- Chart.js trend ----------
let chartInstance = null;

function getCssHsl(varName) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return `hsl(${v})`;
}

function renderTrend(trend) {
  const canvas = document.getElementById("trend-chart");
  const ctx = canvas.getContext("2d");
  const labels = trend.map(t => t.date);
  const surface = trend.map(t => t.surface);
  const soil6 = trend.map(t => t.soil6);
  const soil18 = trend.map(t => t.soil18);

  const firstForecastIdx = trend.findIndex(t => t.isForecast);
  const lastHistIdx = firstForecastIdx > 0 ? firstForecastIdx - 1 : trend.length - 1;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const mutedFg = getCssHsl("--muted-foreground");
  const borderCol = getCssHsl("--border");
  const popover = getCssHsl("--popover");
  const foreground = getCssHsl("--foreground");

  if (chartInstance) chartInstance.destroy();

  // Custom plugin: forecast shading + labels + today line + threshold line
  const annotationsPlugin = {
    id: "annotations",
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const xScale = scales.x;
      const yScale = scales.y;

      // Forecast region stripes
      if (firstForecastIdx > 0) {
        const xStart = xScale.getPixelForValue(firstForecastIdx);
        const xEnd = chartArea.right;
        ctx.save();
        ctx.fillStyle = isDark ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.035)";
        ctx.fillRect(xStart, chartArea.top, xEnd - xStart, chartArea.bottom - chartArea.top);
        // Diagonal stripes
        ctx.save();
        ctx.beginPath();
        ctx.rect(xStart, chartArea.top, xEnd - xStart, chartArea.bottom - chartArea.top);
        ctx.clip();
        ctx.strokeStyle = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
        ctx.lineWidth = 1;
        const step = 8;
        for (let x = xStart - (chartArea.bottom - chartArea.top); x < xEnd; x += step) {
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x + (chartArea.bottom - chartArea.top), chartArea.bottom);
          ctx.stroke();
        }
        ctx.restore();
        // Forecast label
        ctx.fillStyle = mutedFg;
        ctx.font = "500 11px 'General Sans', Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("Forecast", xStart + 8, chartArea.top + 6);
        ctx.restore();
      }

      // 10°C threshold line
      const thresholdY = yScale.getPixelForValue(10);
      if (thresholdY >= chartArea.top && thresholdY <= chartArea.bottom) {
        ctx.save();
        ctx.strokeStyle = "hsl(142, 72%, 42%)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, thresholdY);
        ctx.lineTo(chartArea.right, thresholdY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "hsl(142, 72%, 35%)";
        ctx.font = "600 11px 'General Sans', Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText("Seeding Threshold · 10°C", chartArea.left + 8, thresholdY - 3);
        ctx.restore();
      }

      // Today vertical line
      if (firstForecastIdx > 0) {
        const xToday = xScale.getPixelForValue(lastHistIdx);
        ctx.save();
        ctx.strokeStyle = foreground;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(xToday, chartArea.top);
        ctx.lineTo(xToday, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = foreground;
        ctx.font = "600 11px 'General Sans', Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText("↓ Today", xToday, chartArea.top - 2);
        ctx.restore();
      }
    },
  };

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Soil surface",
          data: surface,
          borderColor: "hsl(30, 55%, 45%)",
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
        },
        {
          label: "Soil @ 6cm · seed zone",
          data: soil6,
          borderColor: "hsl(152, 48%, 35%)",
          backgroundColor: "hsl(152, 48%, 35%)",
          borderWidth: 3,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          pointBackgroundColor: "hsl(152, 48%, 35%)",
          tension: 0.3,
        },
        {
          label: "Soil @ 18cm",
          data: soil18,
          borderColor: "hsl(25, 40%, 30%)",
          borderWidth: 1.75,
          borderDash: [1, 3],
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 24, right: 16, left: 0, bottom: 0 } },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          position: "bottom",
          align: "center",
          labels: {
            usePointStyle: false,
            color: mutedFg,
            font: { size: 12, family: "'General Sans', Inter, sans-serif" },
            padding: 12,
            boxWidth: 24,
            boxHeight: 2,
          },
        },
        tooltip: {
          backgroundColor: popover,
          titleColor: foreground,
          bodyColor: foreground,
          borderColor: borderCol,
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          titleFont: { size: 12, weight: "600", family: "'General Sans', Inter, sans-serif" },
          bodyFont: { size: 12, family: "'General Sans', Inter, sans-serif" },
          callbacks: {
            title: items => fmtShortDate(items[0].label),
            label: ctx => `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(1)}°C`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: borderCol },
          ticks: {
            color: mutedFg,
            font: { size: 11, family: "'General Sans', Inter, sans-serif" },
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 20,
            callback: function (val, idx) {
              return fmtShortDate(labels[idx]);
            },
          },
        },
        y: {
          grid: { color: borderCol, drawBorder: false },
          border: { display: false },
          min: -10,
          ticks: {
            color: mutedFg,
            font: { size: 11, family: "'General Sans', Inter, sans-serif" },
            callback: v => `${v}°`,
            stepSize: 10,
          },
        },
      },
    },
    plugins: [annotationsPlugin],
  });
}

// ---------- Render Dashboard ----------
function renderDashboard(data) {
  document.getElementById("loading").style.display = "none";
  document.getElementById("error").style.display = "none";
  document.getElementById("content").style.display = "";

  renderStatus(data.status, data.generatedAt);
  renderGauge("gauge-surface", data.current.soilSurface, "Soil Surface", "0 cm");
  renderGauge("gauge-seed", data.current.soil6, "Seed Zone", "6 cm · key metric", { markerAt: 10, markerLabel: "10°" });
  renderGauge("gauge-root", data.current.soil18, "Root Zone", "18 cm");
  renderAir(data.current);
  renderTrend(data.trend);
  renderChecklist(data.conditions, data.current);
  renderForecast(data.forecast);
}

// ---------- Escape helper ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Load / refresh cycle ----------
let currentData = null;

async function load({ silent = false } = {}) {
  if (!silent) {
    setRefreshing(true);
  }
  try {
    const data = await fetchSoilData();
    currentData = data;
    renderDashboard(data);
  } catch (err) {
    console.error("Soil data load failed:", err);
    if (!currentData) {
      document.getElementById("loading").style.display = "none";
      document.getElementById("content").style.display = "none";
      document.getElementById("error").style.display = "";
    }
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(v) {
  const btn = document.getElementById("btn-refresh");
  const icon = document.getElementById("refresh-icon");
  btn.disabled = v;
  icon.classList.toggle("spin-slow", v);
}

// ---------- Theme toggle ----------
// Theme preference persisted via localStorage. Initial theme follows
// the user's system preference via `prefers-color-scheme`.
let themePref = null;
try { themePref = localStorage.getItem("theme"); } catch(e) {}

function initTheme() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(themePref || (prefersDark ? "dark" : "light"));
}
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  document.getElementById("theme-icon-moon").style.display = t === "dark" ? "none" : "";
  document.getElementById("theme-icon-sun").style.display = t === "dark" ? "" : "none";
  // Redraw chart with new theme colors
  if (currentData) renderTrend(currentData.trend);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  themePref = next;
  try { localStorage.setItem("theme", next); } catch(e) {}
  setTheme(next);
}

// ---------- Bootstrap ----------
function init() {
  initTheme();
  document.getElementById("btn-refresh").addEventListener("click", () => load());
  document.getElementById("btn-theme").addEventListener("click", toggleTheme);
  document.getElementById("btn-retry").addEventListener("click", () => {
    document.getElementById("error").style.display = "none";
    document.getElementById("loading").style.display = "";
    load();
  });
  load();
  setInterval(() => load({ silent: true }), REFRESH_MS);
  setInterval(() => {
    if (currentData) updateRelativeTime(currentData.generatedAt);
  }, TICK_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
