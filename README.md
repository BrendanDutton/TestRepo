# My Day

A phone-friendly daily dashboard: to-do list, calendar/schedule, weather and a few stats for the day.
It's a plain static web app (installable PWA) with no build step, no accounts and no API keys.

## What it shows

- **Stats row**: task completion ring, events today, current temperature, time until your next event.
- **Weather**: current conditions, high/low, rain chance, wind, humidity, sunrise/sunset and the next 8 hours (via [Open-Meteo](https://open-meteo.com)). Uses your location or a city search; works from cache offline.
- **Schedule**: browse day by day. Add events by hand or import a `.ics` file.
- **To-do**: add, tick off, delete. Tasks you finish disappear the next day.
- **Last 7 days**: tasks completed per day.

Everything you enter is stored in the browser's `localStorage` on your device only.

## Get it on your phone

The app needs to be served over HTTPS for "Add to Home Screen" and location to work.

**GitHub Pages (recommended)**
1. Merge this branch into `main`.
2. In the repo go to *Settings → Pages* and set *Source* to **GitHub Actions**.
3. The included workflow publishes the app; open `https://<user>.github.io/<repo>/` on your phone.
4. iPhone: Safari → Share → **Add to Home Screen**. Android: Chrome menu → **Install app**.

**Try it locally**: `python3 -m http.server 8000`, then open `http://localhost:8000` (or `http://<computer-ip>:8000` on the same Wi-Fi; location and install need HTTPS, but everything else works).

## Calendar notes

Live Google/Apple calendar sync needs OAuth credentials and a backend, so this version imports a
calendar file instead: export an `.ics` from your calendar app and use **Import calendar (.ics)**.
Re-importing replaces the previously imported events. Supported: all-day events, UTC/local times and simple
repeats (daily/weekly/monthly/yearly with interval, `BYDAY`, `COUNT`, `UNTIL`). Not supported: time-zone
conversion for `TZID` times (treated as local), excluded dates and edited single occurrences of a repeating event.
