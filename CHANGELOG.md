# Changelog

## 2.0.1 - 2026-11-13

- `theme: auto` now goes by the theme's own card background
  (`--ha-card-background`, then `--card-background-color`, then
  `--primary-background-color`), and falls back to Home Assistant's dark mode
  only when it can't read one. Dark-only themes, which have no light/dark
  `modes`, leave dark mode off, so 2.0.0 drew a white card on them. A
  see-through card background is skipped in favour of the page background.

## 2.0.0 - 2026-11-11

First public release, for Companion App for iOS 2026.10.3.

- `device:` option. Pick the iPhone and the card finds active energy, exercise
  time, stand hours and the three goal sensors by the app's unique IDs. Renamed
  entities still resolve. Non-admins fall back to entity ID suffixes.
- Goals follow the watch: goal entity, then a fixed number, then the device's goal
  sensor, then Apple's defaults (Exercise 30 min, Stand 12 h; Move 500 kcal).
- The 7-day strip measures each day against the goal in force that day.
- Visual editor: device picker first. Sensors the device provides show up but
  aren't saved, so the YAML stays one line. Switching device drops overrides
  that belonged to the old one.
- Removed `stand_placeholder` and the built-in example entity IDs. A missing
  sensor now reads "No Stand sensor on this device".
- Packaged for HACS, with unit tests and CI.

Fixes found in the pre-release review:

- Units: `Cal` (food Calorie) is read as kcal, not 1/1000 kcal. Added J, MJ,
  Wh, kWh and Mcal for Move, days for Exercise, and seconds or days for Stand.
- `colors:` accepts a bare string (`move: "#00c8ff"`), short hex, named and
  `rgb()` colours. Setting only `color` paints the whole ring and its
  light-theme text, instead of mixing it with Apple's gradient ends. Unusable
  values keep Apple's colour instead of breaking the ring track.
- `tap_action` also accepts Home Assistant's `{ action: none }` form.
- Rings no longer stay half-drawn when the card is detached mid-animation
  (switching views) and shown again.
- The 7-day strip reloads when the card is reconfigured, or its sensors are
  re-resolved, while history is loading. A failed load is retried after 5
  minutes instead of leaving the strip empty until midnight.
- A failed unique ID lookup is no longer cached for the whole session.
- Unique IDs are looked up when the config arrives after `hass`.
- The "Synced" time follows the 12/24-hour setting in the user's profile.
- Tappable rings and rows can be focused and opened with Enter or Space.

## 1.0.0

Internal release: Move / Exercise / Stand rings with explicit entity options.
