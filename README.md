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

**GitHub Pages (recommended)** — free GitHub accounts can only use Pages on a *public* repo
(Settings → General → Danger Zone → Change visibility). The repo holds only the app's code; your tasks, calendar
and location never leave your phone's browser storage. Alternatively host the folder on Cloudflare Pages / Netlify.
1. In the repo go to *Settings → Pages*, set *Source* to **Deploy from a branch**, choose branch **main** and folder **/ (root)**, and save.
2. After a minute the app is live at `https://<user>.github.io/<repo>/`. Open that on your phone.
3. Updates: push to `main` and Pages redeploys automatically.
4. **Android (Chrome):** tap the **Install** banner at the top of the app (or menu ⋮ → **Install app**). It gets a home-screen icon and opens full-screen like any other app.
5. When Chrome asks for location, choose **Allow** so the weather follows you as you move.
   (iPhone: Safari → Share → Add to Home Screen.)

### Built for glancing while you're out

- Opens instantly from the phone's cache, even with no signal; it updates itself in the background.
- Shows the last-known weather when offline and refreshes it when you open the app (if it's over 10 minutes old) and when the connection comes back.
- If you used "Use my current location", the weather location follows you automatically (only after you've granted permission).

**Try it locally**: `python3 -m http.server 8000`, then open `http://localhost:8000` (or `http://<computer-ip>:8000` on the same Wi-Fi; location and install need HTTPS, but everything else works).

## Live Google Calendar (one-time setup, about 5 minutes, free)

A web app can't read Google Calendar directly, so a tiny relay sits in between. It keeps your calendar's
private link secret, fetches it for you, and only answers requests that carry your access key. After setup the app
syncs automatically every time you open it (and every 15 minutes while it's open).

1. **Get your calendar's private link.** On a computer: Google Calendar → ⚙ Settings → under *Settings for my calendars*
   click the calendar → **Integrate calendar** → copy **Secret address in iCal format**. Repeat for any other calendars
   you want. Treat these links like passwords.
2. **Create the relay.** Sign up at <https://dash.cloudflare.com> (free) → *Workers & Pages* → *Create* → *Create Worker*
   → name it `my-day-calendar` → *Deploy* → *Edit code* → replace everything with the contents of
   [`worker/calendar-proxy.js`](worker/calendar-proxy.js) → *Deploy*.
3. **Add its settings.** Worker → *Settings* → *Variables and Secrets* → add:
   - `CALENDAR_URLS` (type *Secret*): the link(s) from step 1, separated by spaces
   - `ACCESS_KEY` (type *Secret*): any long random string (e.g. 30+ random letters and digits)
   - `ALLOWED_ORIGIN` (type *Text*): the address your app is hosted at, e.g. `https://brendandutton.github.io`

   then *Deploy* again.
4. **Connect the app.** In My Day, in the Schedule card tap **Google Calendar sync** and paste
   `https://my-day-calendar.<your-subdomain>.workers.dev/?key=<your ACCESS_KEY>` → **Save & sync**.

Notes: Google serves its private feed with some delay, so a brand-new event can take a while to appear (usually minutes).
Anyone who has the sync link can read your calendar, so don't share it; to revoke access, change `ACCESS_KEY` in
Cloudflare. The synced events are cached on the phone, so your schedule still shows with no signal.

## Calendar details

Handled: all-day events, UTC and time-zone (`TZID`) times, durations, repeats (daily, weekly with `BYDAY`, monthly by date or
"2nd Tuesday", yearly; `INTERVAL`, `COUNT`, `UNTIL`), deleted occurrences (`EXDATE`), and edited or cancelled single
occurrences. Not handled: `BYSETPOS`/multi-day monthly rules, and repeating events whose time zone differs from your
phone's across a daylight-saving change (they can be off by an hour on those days).

You can also use **Import .ics** to load a one-off calendar file exported from any calendar app; re-importing replaces the
previous import.
