# Lawn Seeding Tracker — Static

A fully static version of the soil tracker dashboard that runs entirely in the browser. No backend, no build step.

## Files

- `index.html` — markup and component scaffolding
- `style.css` — theme (light + dark), layout, component styles
- `app.js` — all logic: Open-Meteo fetch, status computation, gauges, Chart.js trend

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo (either at the repo root, or in a `/docs` folder).
2. Settings → Pages → choose branch + `/ (root)` (or `/docs`).
3. Open the published URL.

The dashboard calls the [Open-Meteo forecast API](https://open-meteo.com/) directly from the browser. Open-Meteo supports CORS and requires no key.

## Data

- Location: southern Ontario, Canada (approximate coordinates, rounded to 0.1 degree)
- Soil temperatures at 0, 6, 18 cm (current + past 14 days + 7-day forecast)
- Daily high / low air temperatures
- Auto-refresh every 10 minutes
