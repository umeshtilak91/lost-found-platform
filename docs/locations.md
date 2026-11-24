# Locations

## Architecture
- **One picker** (`frontend/features/search/LocationPicker.tsx`) is used on the homepage, Lost/Found/Browse (`LocationSearch.tsx`) and report/edit (`ItemForm.tsx`).
  - It is an accessible combobox: suggestions start after 3 characters, typing is debounced by 300 ms, and requests are aborted and sequence-checked.
  - It has loading, empty, error and retry states, plus a country control (India by default).
  - "Use my location" handles every geolocation outcome and never overwrites a newer choice.
- **Server-side proxy.** `backend/src/routes/places.js` calls `backend/src/integrations/places.js`, which talks to Google.
  - Endpoints: `GET /api/places/config`, `/autocomplete`, `/details` and `/reverse`. They are rate limited (60/min).
  - The key stays on the server. The browser never contacts Google.
- **Providers** (`PLACES_PROVIDER`):
  - `google`: Places API (New) Autocomplete and Place Details, plus Geocoding API reverse geocoding.
  - `fixture`: deterministic data for tests and development. It is refused in production.
  - `none`: suggestions are off and typed text still works.
- **Search** (`services/locations.js`) runs on the server.
  - Radius options are 2, 5, 10 and 25 km (50 and 100 are also accepted). "Anywhere" means no location filter.
  - Distance is the haversine on a bounding-box prefilter, with antimeridian and pole handling.
  - Sorting is nearest first, then `created_at DESC, id DESC`, so results are stable and paginated on the server.

## Required Google APIs and key restrictions
- **APIs to enable:** Places API (New) and Geocoding API. The Maps JavaScript API is not used.
- **One server key** (`GOOGLE_MAPS_API_KEY`), restricted as follows:
  - API restrictions: Places API (New) and Geocoding API only.
  - Application restrictions: the server's egress IP addresses (production NAT IPs). No browser key and no HTTP-referrer restriction are needed.
- **Billing:**
  - Autocomplete requests share a session token that the Place Details call closes.
  - Details requests Essentials fields only (`id,location,addressComponents,types,shortFormattedAddress`).
  - Publishing a provider location does one extra server-side Details lookup by place ID.
- **Check a key:** `node backend/scripts/verify-google-places.js` makes 3 live calls and never prints the key.

## Data model (migration 007, additive)
- **Existing columns:**
  - `items.location` stays the label the reporter confirmed.
  - `latitude`/`longitude` stay private and are shown only to the owner and moderators.
- **New columns:**
  - `location_source` (`provider`/`device`/`manual`/`legacy`)
  - `location_provider`, `location_place_id`, `location_country`, `location_admin_area`
  - `location_accuracy_m`, `location_coords_at`
- **Grid columns** `grid_lat`/`grid_lng` are generated at 0.01° (about 1.1 km). Public search and distances use only these, so radius probing can't recover precise positions.
- **Legacy rows:**
  - Text-only rows become `legacy`; rows with coordinates become `device`. Labels are unchanged.
  - Legacy rows are excluded from radius results, shown in "Anywhere" search and matched by text.
  - Owners see an "Improve location" link.

## Storage decisions (review with counsel)
- **Coordinates:**
  - Provider coordinates are never trusted from the client; the server resolves them from the place ID.
  - Google place IDs are kept indefinitely.
  - Google coordinates are cached for at most 30 days (`PLACES_COORDINATE_MAX_AGE_DAYS`). The hourly job refreshes them by place ID, or clears them so the listing becomes text-only.
- **Google content:** Google address components are not stored. The stored label is the reporter's confirmed text.
- **Device positions** are user data, rounded to about 11 m.
- **Public exposure:**
  - Public APIs expose the label, the 0.01° grid, `hasCoordinates` and banded distance ("under 1 km", 0.5 km steps, whole km above 10).
  - Shared URLs round device positions to 2 decimals and omit the device label.
- **Logs** record only the provider error reason, never queries, coordinates or the key.
- **Attribution:** "Google Maps" is shown under Google suggestions.
