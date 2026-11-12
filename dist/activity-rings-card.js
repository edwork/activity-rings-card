/*
 * activity-rings-card -- Move / Exercise / Stand activity rings for Home Assistant,
 * fed by the Home Assistant Companion App's Apple Health sensors (iOS app 2026.10.3+).
 *
 * Pick the phone with `device:` and the card finds its sensors:
 *   Move      active energy burned (kcal)   + Move goal
 *   Exercise  exercise time (min)           + Exercise goal
 *   Stand     stand hours (h, needs a watch) + Stand goal
 * Sensors are matched by the app's unique_id (`..._health_apple_stand_hours`), so
 * renamed entities still resolve. Non-admin users can't read unique_ids, so the
 * card falls back to entity_id suffixes. Any `*_entity` set explicitly wins.
 *
 * Layouts: "full" (rings + details + 7-day strip), "ring" (the rings alone),
 * "ring_values" (rings with quiet numbers in the middle).
 * Themes: "auto" (follows HA dark mode), "dark", "light", "transparent".
 *
 * HealthKit totals are "today" values, but HA only hears about them when the
 * phone syncs. A value last reported before local midnight is yesterday's, so
 * it is shown as 0 until the phone's first sync of the day (reset_stale).
 *
 * Rings are drawn on canvas because only canvas has a conic gradient that
 * Safari (the iOS app's WKWebView) renders properly along an arc.
 */

const CARD_VERSION = "2.0.0";
const CARD_TYPE = "activity-rings-card";
const EDITOR_TYPE = `${CARD_TYPE}-editor`;

// Activity ring colours. `color` is the ring's canonical colour, `from` and
// `to` the gradient's tail and tip, `light` a darker shade for text on white
// (lime and cyan text on white is unreadable; the rings stay exact).
const RINGS = {
  move: {
    label: "Move",
    color: "#FA114F",
    from: "#E3053F",
    to: "#FF3A86",
    light: "#E0003F",
    arrow: "single",
  },
  exercise: {
    label: "Exercise",
    color: "#92E82A",
    from: "#6BD600",
    to: "#BCFF3C",
    light: "#4C9E00",
    arrow: "double",
  },
  stand: {
    label: "Stand",
    color: "#1EEAEF",
    from: "#00C1E8",
    to: "#5CFFF2",
    light: "#0094A6",
    arrow: "up",
  },
};
const RING_ORDER = ["move", "exercise", "stand"];

// Apple's own defaults, used only when no goal sensor reports and no number is
// set. Exercise (30 min) and Stand (12 h) are Apple's fixed defaults. Move is
// personalised during watch setup, so there is no universal value; 500 kcal
// is a neutral stand-in.
const APPLE_GOALS = { move: 500, exercise: 30, stand: 12 };

// Companion App sensors. uid: unique_id suffix (stable across renames);
// oid: entity_id suffix, the fallback when unique_ids can't be read.
const SENSORS = {
  move_entity: { uid: "health_active_energy_burned", oid: "active_energy" },
  move_goal_entity: { uid: "health_active_energy_burned_goal", oid: "move_goal" },
  exercise_entity: { uid: "health_apple_exercise_time", oid: "exercise_time" },
  exercise_goal_entity: { uid: "health_apple_exercise_time_goal", oid: "exercise_goal" },
  stand_entity: { uid: "health_apple_stand_hours", oid: "stand_hours" },
  stand_goal_entity: { uid: "health_apple_stand_hours_goal", oid: "stand_goal" },
};
const SENSOR_KEYS = Object.keys(SENSORS);

const DEFAULTS = {
  device: "",
  layout: "full",
  theme: "auto",
  title: "",
  rings: RING_ORDER,
  show_week: true,
  show_footer: true,
  show_arrows: true,
  animate: true,
  reset_stale: true,
  tap_action: "more-info",
  size: 0,
};
// Options from 1.x that no longer do anything; accepted and dropped.
const RETIRED = ["stand_placeholder"];

const LAYOUTS = ["full", "ring", "ring_values"];
const THEMES = ["auto", "dark", "light", "transparent"];
const BAD_STATES = new Set(["unknown", "unavailable", "none", ""]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function num(v, fallback) {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Any opaque CSS colour as "#rrggbb", or null. The canvas can't read CSS
// variables and rgba() above needs hex, so `colors:` values are normalised
// here. Named and rgb() colours are resolved by a scratch canvas.
let colorProbe;
function hexColor(v) {
  const s = String(v ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((ch) => ch + ch).join("")}`;
  if (!s || typeof document === "undefined") return null;
  if (colorProbe === undefined) colorProbe = document.createElement?.("canvas")?.getContext?.("2d") || null;
  if (!colorProbe) return null;
  // An invalid colour leaves fillStyle unchanged, so two different starting
  // values tell valid from invalid.
  colorProbe.fillStyle = "#000000";
  colorProbe.fillStyle = s;
  const a = colorProbe.fillStyle;
  colorProbe.fillStyle = "#ffffff";
  colorProbe.fillStyle = s;
  return a === colorProbe.fillStyle && /^#[0-9a-f]{6}$/i.test(a) ? a : null;
}

// A ring's colours with the `colors.<ring>` override applied. A bare string is
// shorthand for { color }. Setting only `color` paints the whole ring (and its
// light-theme text) in it, rather than mixing it with Apple's gradient ends.
// Unusable values keep Apple's colour.
function ringColors(key, override) {
  const out = { ...RINGS[key] };
  const o = typeof override === "string" ? { color: override }
    : override && typeof override === "object" ? override : {};
  if (typeof o.label === "string" && o.label.trim()) out.label = o.label;
  for (const f of ["color", "from", "to", "light"]) {
    if (o[f] == null || o[f] === "") continue;
    const hex = hexColor(o[f]);
    if (!hex) {
      console.warn(`${CARD_TYPE}: colors.${key}.${f} "${o[f]}" is not a colour, using the default`);
      continue;
    }
    out[f] = hex;
    if (f === "color") {
      for (const g of ["from", "to", "light"]) if (o[g] == null || o[g] === "") out[g] = hex;
    }
  }
  return out;
}

// tap_action: "more-info" / "none", or HA's usual { action: ... } object.
function tapAction(v) {
  const a = v && typeof v === "object" ? v.action : v;
  return a === "none" ? "none" : "more-info";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Every ring is stored in the units its goal is written in: kcal, minutes and
// hours. HA lets a user re-unit a sensor, so convert back from the common ones.
// Energy units are case-sensitive first: "cal" is a small calorie (HA's
// UnitOfEnergy.CALORIE) but "Cal" is the food Calorie, i.e. kcal.
const KCAL_PER = {
  kcal: 1, Cal: 1, cal: 0.001, Mcal: 1000,
  J: 1 / 4184, kJ: 1 / 4.184, MJ: 1000 / 4.184,
  Wh: 0.859845, kWh: 859.845,
};
const KCAL_PER_LOWER = {
  kcal: 1, kj: 1 / 4.184, j: 1 / 4184, mj: 1000 / 4.184, wh: 0.859845, kwh: 859.845,
};
const MIN_PER = {
  ms: 1 / 60000, s: 1 / 60, sec: 1 / 60, secs: 1 / 60, seconds: 1 / 60,
  min: 1, mins: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440,
};

function toRingUnits(key, value, unit) {
  const raw = String(unit || "").trim();
  const u = raw.toLowerCase();
  if (key === "move") return value * (KCAL_PER[raw] ?? KCAL_PER_LOWER[u] ?? 1);
  if (key === "exercise") return value * (MIN_PER[u] ?? 1);
  if (key === "stand" && MIN_PER[u] !== undefined) return (value * MIN_PER[u]) / 60;
  return value;
}

// ---------------------------------------------------------------------------
// Finding a device's sensors
// ---------------------------------------------------------------------------

function deviceSensorIds(hass, deviceId) {
  if (!deviceId) return [];
  return Object.values(hass?.entities || {})
    .filter((e) => e.device_id === deviceId && e.entity_id.startsWith("sensor."))
    .map((e) => e.entity_id);
}

// {move_entity: "sensor...", ...} for one device. `uids` ({entity_id: unique_id})
// is optional: without it only entity_id suffixes are used.
function resolveDevice(hass, deviceId, uids) {
  const ids = deviceSensorIds(hass, deviceId);
  const out = {};
  for (const key of SENSOR_KEYS) {
    const { uid, oid } = SENSORS[key];
    let hit = uids ? ids.find((id) => String(uids[id] || "").endsWith(`_${uid}`)) : undefined;
    if (!hit) {
      hit = ids.filter((id) => id.endsWith(`_${oid}`)).sort((a, b) => a.length - b.length)[0];
    }
    out[key] = hit || "";
  }
  return out;
}

// device_id -> Promise<{entity_id: unique_id} | null>. null when the user isn't
// allowed to read the registry (non-admin); callers then use entity_ids.
const uidCache = new Map();
function fetchUniqueIds(hass, deviceId) {
  const ids = deviceSensorIds(hass, deviceId);
  const key = `${deviceId}|${ids.length}`;
  if (!uidCache.has(key)) {
    // A failure isn't cached, so a dropped connection doesn't pin every card
    // to the entity_id fallback for the rest of the session.
    const p = ids.length && hass.callWS
      ? hass.callWS({ type: "config/entity_registry/get_entries", entity_ids: ids })
        .then((res) => Object.fromEntries(Object.entries(res || {})
          .filter(([, e]) => e).map(([id, e]) => [id, e.unique_id])))
        .catch(() => {
          uidCache.delete(key);
          return null;
        })
      : Promise.resolve(null);
    uidCache.set(key, p);
  }
  return uidCache.get(key);
}

// Explicit `*_entity` options win over what the device provides.
function resolveEntities(hass, config, uids) {
  const auto = config.device ? resolveDevice(hass, config.device, uids) : {};
  const out = {};
  for (const key of SENSOR_KEYS) out[key] = config[key] || auto[key] || "";
  return out;
}

// The first Companion App device that reports active energy.
function findDevice(hass) {
  const e = Object.values(hass?.entities || {}).find((x) => x.platform === "mobile_app"
    && x.device_id && /_active_energy$/.test(x.entity_id));
  return e?.device_id || "";
}

const UNIT_LABEL = { move: "CAL", exercise: "MIN", stand: "HRS" };
const UNIT_WORD = { move: "calories", exercise: "minutes", stand: "hours" };

// ---------------------------------------------------------------------------
// Drawing. One function draws any number of concentric rings at any size; the
// big rings, the centre-values rings and the week's mini rings all use it.
// ---------------------------------------------------------------------------

// Stroke and gap as a fraction of the diameter, by ring count. `thin` leaves
// room in the middle for numbers.
function ringGeometry(count, thin) {
  if (thin) return { stroke: [0, 0.15, 0.11, 0.085][count], gap: 0.012 };
  return { stroke: [0, 0.155, 0.125, 0.104][count], gap: 0.011 };
}

function drawArrow(ctx, kind, x, y, w) {
  ctx.save();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.88)";
  ctx.lineWidth = Math.max(1, w * 0.11);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (kind === "double") {
    const h = w * 0.15;
    for (const dx of [-w * 0.09, w * 0.12]) {
      ctx.moveTo(x + dx - h, y - h);
      ctx.lineTo(x + dx, y);
      ctx.lineTo(x + dx - h, y + h);
    }
  } else if (kind === "up") {
    const a = w * 0.24, h = w * 0.15;
    ctx.moveTo(x, y + a);
    ctx.lineTo(x, y - a);
    ctx.moveTo(x - h, y - a + h);
    ctx.lineTo(x, y - a);
    ctx.lineTo(x + h, y - a + h);
  } else {
    const a = w * 0.24, h = w * 0.15;
    ctx.moveTo(x - a, y);
    ctx.lineTo(x + a, y);
    ctx.moveTo(x + a - h, y - h);
    ctx.lineTo(x + a, y);
    ctx.lineTo(x + a - h, y + h);
  }
  ctx.stroke();
  ctx.restore();
}

function disc(ctx, x, y, r, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

// The tip of a ring, with Apple's shadow falling forward onto the lap below.
function drawTip(ctx, g, angle, grad, color, shadow) {
  const { cx, cy, r, w, dpr } = g;
  const x = cx + r * Math.cos(angle);
  const y = cy + r * Math.sin(angle);
  if (shadow) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + w / 2, 0, TAU);
    ctx.arc(cx, cy, r - w / 2, 0, TAU, true);
    ctx.clip();
    // shadowBlur/offset ignore the canvas transform, so scale them ourselves
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = w * 0.4 * dpr;
    ctx.shadowOffsetX = -Math.sin(angle) * w * 0.2 * dpr;
    ctx.shadowOffsetY = Math.cos(angle) * w * 0.2 * dpr;
    disc(ctx, x, y, w / 2, color);
    ctx.restore();
    // Repaint the tail so the shadow only shows ahead of the tip
    ctx.strokeStyle = grad;
    ctx.lineWidth = w;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle - (w / r) * 1.3, angle);
    ctx.stroke();
  }
  disc(ctx, x, y, w / 2, color);
}

function drawRing(ctx, g, ring, progress, opts) {
  const { cx, cy, r, w } = g;
  const top = -Math.PI / 2;

  ctx.strokeStyle = ring.track;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();

  if (!(progress > 0.0005)) return;
  const arrow = () => {
    if (opts.arrows && w >= 11) drawArrow(ctx, ring.arrow, cx, cy - r, w);
  };

  if (progress < 1) {
    const end = top + TAU * progress;
    const grad = ctx.createConicGradient(top, cx, cy);
    grad.addColorStop(0, ring.from);
    grad.addColorStop(progress / 2, ring.color);
    grad.addColorStop(progress, ring.to);
    ctx.strokeStyle = grad;
    ctx.lineWidth = w;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.arc(cx, cy, r, top, end);
    ctx.stroke();
    // Caps are discs so each takes its own end's colour; a round lineCap at
    // the start would sample the gradient's far end.
    disc(ctx, cx, cy - r, w / 2, ring.from);
    arrow();
    const nearlyClosed = TAU * (1 - progress) * r < w * 2;
    drawTip(ctx, g, end, grad, ring.to, opts.shadow && nearlyClosed);
    return;
  }

  // Past 100%: a full lap shaded so it brightens into the tip, then the tip
  // and its shadow on top, the way Fitness draws a second lap.
  const tip = top + TAU * (progress % 1);
  const grad = ctx.createConicGradient(tip, cx, cy);
  grad.addColorStop(0, ring.from);
  grad.addColorStop(0.5, ring.color);
  grad.addColorStop(1, ring.to);
  ctx.strokeStyle = grad;
  ctx.lineWidth = w;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();
  arrow();
  drawTip(ctx, g, tip, grad, ring.to, opts.shadow);
}

// rings: [{ color, from, to, track, arrow }], progress: [number]
function drawRings(canvas, rings, progress, opts = {}) {
  const css = canvas.clientWidth;
  if (!css || !rings.length) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.round(css * dpr);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, px, px);
  ctx.scale(dpr, dpr);

  const { stroke, gap } = ringGeometry(rings.length, opts.thin);
  const w = css * stroke;
  const pad = css * 0.012;
  rings.forEach((ring, i) => {
    const r = css / 2 - pad - w / 2 - i * (w + css * gap);
    drawRing(ctx, { cx: css / 2, cy: css / 2, r, w, dpr }, ring, progress[i] || 0, opts);
  });
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const STYLE = `
  :host { display: block; }
  ha-card {
    display: block;
    --ar-font: "SF Pro Rounded", ui-rounded, "SF Pro Display", -apple-system,
      BlinkMacSystemFont, "Helvetica Neue", var(--ha-font-family-body, Roboto), sans-serif;
    font-family: var(--ar-font);
    color: var(--ar-text);
    overflow: hidden;
    height: 100%;
    box-sizing: border-box;
  }
  ha-card.dark {
    --ar-bg: #000000;
    --ar-text: #ffffff;
    --ar-text2: rgba(235, 235, 245, 0.6);
    --ar-text3: rgba(235, 235, 245, 0.3);
    --ar-sep: rgba(84, 84, 88, 0.6);
    --ar-pill: rgba(118, 118, 128, 0.24);
  }
  ha-card.light {
    --ar-bg: #ffffff;
    --ar-text: #000000;
    --ar-text2: rgba(60, 60, 67, 0.6);
    --ar-text3: rgba(60, 60, 67, 0.3);
    --ar-sep: rgba(60, 60, 67, 0.18);
    --ar-pill: rgba(118, 118, 128, 0.12);
  }
  ha-card.dark, ha-card.light {
    background: var(--ar-bg);
    --ha-card-background: var(--ar-bg);
  }
  ha-card.transparent {
    --ar-text: var(--primary-text-color);
    --ar-text2: var(--secondary-text-color);
    --ar-text3: var(--disabled-text-color, rgba(127, 127, 127, 0.5));
    --ar-sep: var(--divider-color, rgba(127, 127, 127, 0.25));
    --ar-pill: rgba(127, 127, 127, 0.15);
    background: none;
    --ha-card-background: transparent;
    box-shadow: none;
    border: none;
    --ha-card-border-width: 0;
    backdrop-filter: none;
  }
  .wrap { container-type: inline-size; padding: 16px; }
  .tappable { cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .tappable:focus { outline: none; }
  .tappable:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; border-radius: 8px;
  }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; margin-bottom: 12px; min-height: 22px;
  }
  .title { font-size: 17px; font-weight: 600; letter-spacing: -0.2px; }
  .pill {
    font-size: 12px; font-weight: 600; color: var(--ar-text2);
    background: var(--ar-pill); border-radius: 999px; padding: 3px 9px;
    white-space: nowrap;
  }
  .pill.closed { color: var(--ar-text); }

  .rings { position: relative; aspect-ratio: 1; container-type: inline-size; }
  .rings canvas { display: block; width: 100%; height: 100%; }

  /* full layout */
  .main { display: flex; align-items: center; gap: 20px; }
  .layout-full .rings { flex: 0 0 auto; width: clamp(110px, 44%, 210px); }
  .details { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .row { min-width: 0; }
  .row-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .label { font-size: 15px; font-weight: 600; }
  .pct { font-size: 13px; font-weight: 600; color: var(--ar-text2); font-variant-numeric: tabular-nums; }
  .value {
    font-size: 26px; font-weight: 600; line-height: 1.1; letter-spacing: -0.3px;
    color: var(--ring-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .value .unit { font-size: 0.62em; font-weight: 700; margin-left: 1px; letter-spacing: 0; }
  .note { font-size: 12px; color: var(--ar-text2); margin-top: 1px; }
  .row.missing .value, .row.unavailable .value { color: var(--ar-text3); }
  @container (max-width: 330px) {
    .main { flex-direction: column; gap: 14px; }
    .layout-full .rings { width: min(220px, 72%); }
    .details { width: 100%; }
  }

  /* lone ring layouts */
  .layout-ring .rings, .layout-ring_values .rings {
    width: 100%; max-width: var(--ar-size, 100%); margin: 0 auto;
  }
  .center {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; pointer-events: none;
    font-variant-numeric: tabular-nums; line-height: 1.15;
  }
  .cv { color: var(--ring-text); font-weight: 600; white-space: nowrap; opacity: 0.92; }
  .cv .of { color: var(--ar-text2); font-weight: 500; }
  .cv.missing { color: var(--ar-text3); }
  .center.n3 { font-size: 6.6cqw; }
  .center.n2 { font-size: 8.5cqw; }
  .center.n1 { font-size: 15cqw; }
  .center.n1 .cv .of { display: block; font-size: 0.42em; text-align: center; letter-spacing: 0.5px; }

  /* week strip */
  .week {
    display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px;
    margin-top: 16px; padding-top: 12px; border-top: 0.5px solid var(--ar-sep);
  }
  .day { display: flex; flex-direction: column; align-items: center; gap: 5px; min-width: 0; }
  .day .dl { font-size: 11px; font-weight: 600; color: var(--ar-text2); line-height: 18px;
    width: 18px; text-align: center; border-radius: 50%; }
  .day.today .dl { color: var(--ar-bg, var(--card-background-color, #000)); background: var(--ar-text); }
  ha-card.transparent .day.today .dl { color: var(--primary-background-color, #fff); }
  .day canvas { width: min(100%, 34px); aspect-ratio: 1; display: block; }

  .footer { margin-top: 10px; font-size: 11px; color: var(--ar-text2); text-align: right; }
  .warn { font-size: 12px; color: var(--error-color, #db4437); margin-top: 8px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

class ActivityRingsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._shown = {};        // ring key -> progress currently drawn
    this._target = {};       // ring key -> progress to animate to
    this._week = null;       // { days: [{ date, values: {key: number} }], goals: {key: [[ts, goal]]} }
    this._weekKey = "";
    this._ents = {};         // resolved *_entity / *_goal_entity ids
    this._uids = null;       // {entity_id: unique_id} for config.device, once known
    this._uidDevice = null;  // device the lookup above was made for
    this._weekLoading = false;
    this._sig = "";
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TYPE);
  }

  static getStubConfig(hass) {
    const device = findDevice(hass);
    return device ? { device } : {};
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    const c = { ...DEFAULTS, ...config };
    for (const k of RETIRED) delete c[k];
    if (!LAYOUTS.includes(c.layout)) throw new Error(`layout must be one of: ${LAYOUTS.join(", ")}`);
    if (!THEMES.includes(c.theme)) throw new Error(`theme must be one of: ${THEMES.join(", ")}`);
    let rings = Array.isArray(c.rings) ? c.rings : String(c.rings).split(",");
    rings = RING_ORDER.filter((k) => rings.map((r) => String(r).trim()).includes(k));
    if (!rings.length) throw new Error("rings must include at least one of move, exercise, stand");
    c.rings = rings;
    if (!c.device && !rings.some((k) => c[`${k}_entity`])) {
      throw new Error("Pick a Companion App device (device:) or set move_entity / exercise_entity / stand_entity");
    }
    for (const k of RING_ORDER) c[`${k}_goal`] = num(c[`${k}_goal`], 0);
    c.size = num(c.size, 0);
    c.tap_action = tapAction(c.tap_action);
    this._config = c;
    this._colors = {};
    for (const k of RING_ORDER) this._colors[k] = ringColors(k, config.colors?.[k]);
    this._weekKey = "";
    this._week = null;
    this._weekRetryAt = 0;
    this._sig = "";
    this._built = false;
    if (this._uidDevice !== c.device) {
      this._uids = null;
      this._uidDevice = null;
    }
    if (this._hass) {
      this._lookupUniqueIds();
      this._sig = this._signature();
      this._update();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._lookupUniqueIds();
    this._refresh();
  }

  get hass() {
    return this._hass;
  }

  // Re-render only when something the card shows has changed.
  _refresh() {
    if (!this._hass || !this._config) return;
    const sig = this._signature();
    if (sig === this._sig) return;
    this._sig = sig;
    this._update();
  }

  connectedCallback() {
    // Midnight has to roll the card over even when no entity changes.
    clearInterval(this._timer);
    this._timer = setInterval(() => this._refresh(), 60 * 1000);
    // A cached view can be re-attached hours later.
    this._refresh();
    if (this._built) this._observe();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = null;
    if (this._raf) {
      // Finish the sweep now; otherwise the card comes back drawn mid-animation.
      cancelAnimationFrame(this._raf);
      this._raf = null;
      for (const k of Object.keys(this._target)) this._shown[k] = this._target[k];
    }
    this._ro?.disconnect();
    this._ro = null;
  }

  getCardSize() {
    if (this._config?.layout !== "full") return 4;
    return this._config.show_week ? 6 : 4;
  }

  getGridOptions() {
    return this._config?.layout === "full"
      ? { columns: "full", min_columns: 6 }
      : { columns: 6, min_columns: 3 };
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  _isDark() {
    const t = this._config.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return Boolean(this._hass?.themes?.darkMode);
  }

  // Unique ids make the device match survive renames. The entity_id match is
  // used meanwhile (and for good when the registry can't be read).
  _lookupUniqueIds() {
    const device = this._config.device;
    if (!device || this._uidDevice === device || !this._hass?.callWS) return;
    this._uidDevice = device;
    fetchUniqueIds(this._hass, device).then((uids) => {
      if (this._config?.device !== device || !uids) return;
      this._uids = uids;
      this._sig = "";
      this._weekKey = "";
      if (this._hass) this.hass = this._hass;
    });
  }

  _signature() {
    const c = this._config;
    this._ents = resolveEntities(this._hass, c, this._uids);
    const loc = this._hass.locale || {};
    const parts = [dayKey(new Date()), this._isDark(), loc.language, loc.time_format];
    for (const k of c.rings) {
      for (const id of [this._ents[`${k}_entity`], this._ents[`${k}_goal_entity`]]) {
        const s = id && this._hass.states[id];
        parts.push(s ? `${id}|${s.state}|${s.last_reported || s.last_updated}|${s.attributes.unit_of_measurement}` : `${id}|-`);
      }
    }
    return parts.join(";");
  }

  // Goal precedence: an explicit goal entity, then an explicit number, then
  // the device's own goal sensor (what's set on the watch), then Apple's default.
  _goal(key) {
    const c = this._config;
    const fromEntity = (id) => {
      const gs = id && this._hass.states[id];
      if (!gs || BAD_STATES.has(String(gs.state).toLowerCase())) return 0;
      const g = toRingUnits(key, num(gs.state, NaN), gs.attributes.unit_of_measurement);
      return g > 0 ? g : 0;
    };
    const ge = `${key}_goal_entity`;
    if (c[ge]) {
      const g = fromEntity(c[ge]);
      if (g) return { goal: g, from: c[ge] };
    }
    if (c[`${key}_goal`] > 0) return { goal: c[`${key}_goal`], from: "config" };
    if (!c[ge]) {
      const g = fromEntity(this._ents[ge]);
      if (g) return { goal: g, from: this._ents[ge] };
    }
    return { goal: APPLE_GOALS[key], from: "default" };
  }

  _read(key) {
    const c = this._config;
    const entity = this._ents[`${key}_entity`];
    const { goal } = this._goal(key);
    const out = { key, entity, goal, value: null, progress: 0, status: "ok", updated: null };
    const s = entity && this._hass.states[entity];
    if (!s) {
      out.status = "missing";
      return out;
    }
    const reported = s.last_reported || s.last_updated || s.last_changed;
    out.updated = reported ? new Date(reported) : null;
    if (BAD_STATES.has(String(s.state).toLowerCase()) || !Number.isFinite(parseFloat(s.state))) {
      out.status = "unavailable";
      return out;
    }
    let v = Math.max(0, toRingUnits(key, parseFloat(s.state), s.attributes.unit_of_measurement));
    if (c.reset_stale && out.updated && out.updated < startOfDay(new Date())) {
      v = 0;
      out.status = "stale";
    }
    out.value = v;
    out.progress = v / goal;
    return out;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  _themeClass() {
    const t = this._config.theme;
    if (t === "transparent") return "transparent";
    return this._isDark() ? "dark" : "light";
  }

  _ringStyle(key) {
    const col = this._colors[key];
    const dark = this._isDark();
    return { ...col, track: rgba(col.color, dark ? 0.22 : 0.17) };
  }

  _build() {
    const c = this._config;
    const layout = c.layout;
    const tap = c.tap_action !== "none" ? " tappable" : "";
    let body = "";

    const center = layout === "ring_values"
      ? `<div class="center n${c.rings.length}">${c.rings.map((k) =>
          `<div class="cv" data-cv="${k}"></div>`).join("")}</div>`
      : "";
    const focus = tap ? ` tabindex="0" role="button"` : "";
    const rings = `<div class="rings${tap}" data-tap="${c.rings[0]}"${tap ? focus : ` role="img"`}>
      <canvas class="big"></canvas>${center}</div>`;

    if (layout === "full") {
      const rows = c.rings.map((k) => `
        <div class="row${tap}" data-row="${k}" data-tap="${k}"${focus}>
          <div class="row-head"><span class="label">${escapeHtml(this._colors[k].label)}</span>
            <span class="pct"></span></div>
          <div class="value"></div>
          <div class="note" hidden></div>
        </div>`).join("");
      body = `<div class="main">${rings}<div class="details">${rows}</div></div>`;
      if (c.show_week) {
        body += `<div class="week">${Array.from({ length: 7 }, (_, i) =>
          `<div class="day" data-day="${i}"><span class="dl"></span><canvas></canvas></div>`).join("")}</div>`;
      }
      if (c.show_footer) body += `<div class="footer"></div>`;
    } else {
      body = rings;
    }

    const header = c.title || layout === "full"
      ? `<div class="header"><span class="title">${escapeHtml(c.title || "Activity")}</span>
          <span class="pill" hidden></span></div>`
      : "";

    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <ha-card><div class="wrap layout-${layout}">${header}${body}</div></ha-card>`;
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    this._els = {
      card: $("ha-card"),
      rings: $(".rings"),
      big: $("canvas.big"),
      pill: $(".pill"),
      footer: $(".footer"),
    };
    if (c.size > 0) this._els.rings.style.setProperty("--ar-size", `${c.size}px`);
    for (const k of RING_ORDER) {
      const color = this._colors[k];
      this.shadowRoot.querySelectorAll(`[data-row="${k}"], [data-cv="${k}"]`).forEach((el) => {
        el.style.setProperty("--ring-text", "var(--ring-text-" + k + ")");
      });
      this._els.card.style.setProperty(`--ring-dark-${k}`, color.color);
      this._els.card.style.setProperty(`--ring-light-${k}`, color.light || color.color);
    }
    if (c.tap_action !== "none") {
      this.shadowRoot.querySelectorAll("[data-tap]").forEach((el) => {
        el.addEventListener("click", () => this._moreInfo(el.dataset.tap));
        el.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          this._moreInfo(el.dataset.tap);
        });
      });
    }
    this._built = true;
    this._observe();
  }

  _observe() {
    this._ro?.disconnect();
    if (!this._els?.card || typeof ResizeObserver === "undefined") return;
    this._ro = new ResizeObserver(() => this._draw());
    this._ro.observe(this._els.card);
  }

  _moreInfo(key) {
    const id = this._ents[`${key}_entity`];
    if (!id || !this._hass.states[id]) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: id }, bubbles: true, composed: true,
    }));
  }

  _fmt(n) {
    const lang = this._hass?.locale?.language || undefined;
    return Math.round(n).toLocaleString(lang);
  }

  // Honours the user's HA time format (12 h / 24 h / language / system).
  _time(d) {
    const loc = this._hass?.locale || {};
    const lang = loc.language || undefined;
    const opts = { hour: "numeric", minute: "2-digit" };
    if (loc.time_format === "12") opts.hour12 = true;
    if (loc.time_format === "24") opts.hour12 = false;
    const t = d.toLocaleTimeString(loc.time_format === "system" ? undefined : lang, opts);
    const today = startOfDay(new Date());
    if (d >= today) return t;
    if (d >= addDays(today, -1)) return `yesterday ${t}`;
    return `${d.toLocaleDateString(lang, { month: "short", day: "numeric" })} ${t}`;
  }

  _update() {
    if (!this._hass || !this._config) return;
    if (!this._built) this._build();
    const c = this._config;
    this._ents = resolveEntities(this._hass, c, this._uids);
    const dark = this._isDark();
    const card = this._els.card;
    card.className = this._themeClass();
    for (const k of RING_ORDER) {
      card.style.setProperty(`--ring-text-${k}`, `var(--ring-${dark ? "dark" : "light"}-${k})`);
    }

    const data = c.rings.map((k) => this._read(k));
    this._data = data;

    // details rows
    for (const d of data) {
      const row = this.shadowRoot.querySelector(`[data-row="${d.key}"]`);
      if (row) {
        row.className = `row ${d.status}${c.tap_action !== "none" ? " tappable" : ""}`;
        const valueEl = row.querySelector(".value");
        const pctEl = row.querySelector(".pct");
        const noteEl = row.querySelector(".note");
        const goal = this._fmt(d.goal);
        const cur = d.value == null ? "--" : this._fmt(d.value);
        valueEl.innerHTML = `${cur}/${goal}<span class="unit">${UNIT_LABEL[d.key]}</span>`;
        pctEl.textContent = d.value == null ? "" : `${Math.round(d.progress * 100)}%`;
        let note = "";
        if (d.status === "missing") {
          note = d.entity ? `Not found: ${d.entity}`
            : c.device ? `No ${this._colors[d.key].label} sensor on this device` : "No sensor set";
        } else if (d.status === "unavailable") {
          note = "Unavailable";
        } else if (d.status === "stale") {
          note = "Waiting for today's first sync";
        }
        noteEl.textContent = note;
        noteEl.hidden = !note;
      }
      const cv = this.shadowRoot.querySelector(`[data-cv="${d.key}"]`);
      if (cv) {
        cv.classList.toggle("missing", d.value == null);
        cv.innerHTML = d.value == null
          ? `--<span class="of">/${this._fmt(d.goal)}</span>`
          : `${this._fmt(d.value)}<span class="of">/${this._fmt(d.goal)}${
            c.rings.length === 1 ? ` ${UNIT_LABEL[d.key]}` : ""}</span>`;
      }
    }

    // header pill
    if (this._els.pill) {
      const live = data.filter((d) => d.value != null);
      const closed = live.filter((d) => d.progress >= 1).length;
      const pill = this._els.pill;
      if (live.length && closed === live.length) {
        pill.textContent = live.length === c.rings.length ? "✓ Rings closed" : `✓ ${closed} closed`;
        pill.className = "pill closed";
        pill.hidden = false;
      } else if (live.length) {
        pill.textContent = `${closed} of ${c.rings.length} closed`;
        pill.className = "pill";
        pill.hidden = false;
      } else {
        pill.hidden = true;
      }
    }

    // footer
    if (this._els.footer) {
      const times = data.map((d) => d.updated).filter(Boolean);
      const latest = times.length ? new Date(Math.max(...times)) : null;
      this._els.footer.textContent = latest ? `Synced ${this._time(latest)}` : "";
    }

    // a11y
    this._els.rings.setAttribute("aria-label", data.map((d) => {
      const name = this._colors[d.key].label;
      return d.value == null
        ? `${name} not available`
        : `${name} ${Math.round(d.value)} of ${Math.round(d.goal)} ${UNIT_WORD[d.key]}`;
    }).join(", "));

    // animate rings toward their new targets
    for (const d of data) this._target[d.key] = d.value == null ? 0 : d.progress;
    this._animate();

    if (c.layout === "full" && c.show_week) this._maybeLoadWeek();
    this._drawWeek();
  }

  _animate() {
    const c = this._config;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = {};
    for (const k of c.rings) from[k] = this._shown[k] ?? 0;
    const same = c.rings.every((k) => Math.abs(from[k] - this._target[k]) < 0.0005);
    if (!c.animate || reduce || same) {
      for (const k of c.rings) this._shown[k] = this._target[k];
      this._draw();
      return;
    }
    cancelAnimationFrame(this._raf);
    const t0 = performance.now();
    const span = Math.max(...c.rings.map((k) => Math.abs(this._target[k] - from[k])));
    const dur = Math.min(1600, 700 + span * 500);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = easeOutCubic(t);
      for (const k of c.rings) this._shown[k] = from[k] + (this._target[k] - from[k]) * e;
      this._draw();
      this._raf = t < 1 ? requestAnimationFrame(step) : null;
    };
    this._raf = requestAnimationFrame(step);
  }

  _draw() {
    if (!this._els?.big || !this._config) return;
    const c = this._config;
    drawRings(this._els.big, c.rings.map((k) => this._ringStyle(k)),
      c.rings.map((k) => this._shown[k] || 0),
      { arrows: c.show_arrows, shadow: true, thin: c.layout === "ring_values" });
    this._drawWeek();
  }

  // -------------------------------------------------------------------------
  // The week strip: the six days before today come from the recorder (the
  // day's highest reading, which for a daily total is its final value); today
  // is the live value. Each past day is measured against the goal that was in
  // force that day when the goal comes from a sensor, as Fitness does.
  // -------------------------------------------------------------------------

  // One load at a time. If the config or the resolved sensors change while a
  // load is in flight, its result is dropped (or kept, if the sensors still
  // match) and the strip reloads for what the card shows now. A failed load
  // is retried after a pause rather than leaving the strip empty all day.
  async _maybeLoadWeek() {
    const c = this._config;
    const hass = this._hass;
    if (!c || !hass?.callWS || c.layout !== "full" || !c.show_week) return;
    const live = (id) => id && hass.states[id];
    const valueIds = Object.fromEntries(c.rings.map((k) => [k, this._ents[`${k}_entity`]]));
    const goalFrom = Object.fromEntries(c.rings.map((k) => [k, this._goal(k).from]));
    const ids = c.rings.map((k) => valueIds[k]).filter(live);
    const goalIds = c.rings.map((k) => goalFrom[k]).filter((id) => live(id));
    const key = `${dayKey(new Date())}|${ids.join(",")}|${goalIds.join(",")}`;
    if (key === this._weekKey || this._weekLoading) return;
    if (key === this._weekFailKey && Date.now() < this._weekRetryAt) return;
    this._weekLoading = true;
    const today = startOfDay(new Date());
    const days = Array.from({ length: 6 }, (_, i) => ({ date: addDays(today, i - 6), values: {} }));
    const goals = {};
    const query = (entityIds, withStart) => (entityIds.length ? hass.callWS({
      type: "history/history_during_period",
      start_time: days[0].date.toISOString(),
      end_time: today.toISOString(),
      entity_ids: entityIds,
      minimal_response: true,
      no_attributes: true,
      // Goals rarely change, so ask for the value in force at the start too.
      include_start_time_state: withStart,
      significant_changes_only: false,
    }) : Promise.resolve({}));
    let ok = false;
    try {
      const [res, goalRes] = await Promise.all([query(ids, false), query(goalIds, true)]);
      for (const k of c.rings) {
        const id = valueIds[k];
        const unit = hass.states[id]?.attributes.unit_of_measurement;
        for (const p of res?.[id] || []) {
          const v = parseFloat(p.s);
          const ts = (p.lu ?? p.lc ?? 0) * 1000;
          if (!Number.isFinite(v)) continue;
          // real day bounds rather than 24h steps: DST days are 23 or 25 hours
          const day = days.find((d) => ts >= d.date.getTime() && ts < addDays(d.date, 1).getTime());
          if (!day) continue;
          const cv = toRingUnits(k, v, unit);
          day.values[k] = Math.max(day.values[k] ?? 0, cv);
        }
        const gid = goalFrom[k];
        const gunit = hass.states[gid]?.attributes.unit_of_measurement;
        goals[k] = (goalRes?.[gid] || [])
          .map((p) => [(p.lu ?? p.lc ?? 0) * 1000, toRingUnits(k, parseFloat(p.s), gunit)])
          .filter(([, g]) => g > 0)
          .sort((a, b) => a[0] - b[0]);
      }
      ok = true;
    } catch (err) {
      // Recorder off or connection lost: keep empty tracks rather than break the card.
      console.warn(`${CARD_TYPE}: week history unavailable`, err);
    }
    this._weekLoading = false;
    if (this._config !== c) {
      // Reconfigured while loading: this result belongs to the old config.
      this._maybeLoadWeek();
      return;
    }
    this._week = { days, goals };
    if (ok) {
      this._weekKey = key;
    } else {
      this._weekKey = "";
      this._weekFailKey = key;
      this._weekRetryAt = Date.now() + 5 * 60 * 1000;
    }
    this._drawWeek();
    // The sensors may have been re-resolved meanwhile (unique IDs arriving).
    this._maybeLoadWeek();
  }

  // The goal at the end of day i (0..5), falling back to today's goal.
  _dayGoal(key, i) {
    const goal = this._goal(key);
    const hist = this._week?.goals?.[key];
    const day = this._week?.days?.[i];
    if (!hist?.length || !day || !this._hass.states[goal.from]) return goal.goal;
    const end = addDays(day.date, 1).getTime();
    let g = null;
    for (const [ts, v] of hist) if (ts < end) g = v;
    return g ?? goal.goal;
  }

  _drawWeek() {
    const c = this._config;
    if (c.layout !== "full" || !c.show_week || !this._data) return;
    const lang = this._hass?.locale?.language || undefined;
    const today = startOfDay(new Date());
    const styles = c.rings.map((k) => this._ringStyle(k));
    const cells = this.shadowRoot.querySelectorAll(".day");
    cells.forEach((cell, i) => {
      const date = addDays(today, i - 6);
      const isToday = i === 6;
      cell.classList.toggle("today", isToday);
      cell.querySelector(".dl").textContent = date.toLocaleDateString(lang, { weekday: "narrow" });
      const vals = isToday ? null : this._week?.days?.[i]?.values || {};
      const goals = c.rings.map((k) => (isToday ? this._goal(k).goal : this._dayGoal(k, i)));
      const progress = isToday
        ? c.rings.map((k) => this._shown[k] || 0)
        : c.rings.map((k, j) => (vals[k] != null ? vals[k] / goals[j] : 0));
      const tip = c.rings.map((k, j) => {
        const v = isToday ? this._data.find((x) => x.key === k)?.value : vals[k];
        return `${this._colors[k].label} ${v == null ? "--" : this._fmt(v)}/${this._fmt(goals[j])}`;
      });
      cell.title = `${date.toLocaleDateString(lang, { weekday: "long", month: "short", day: "numeric" })}\n${tip.join("\n")}`;
      drawRings(cell.querySelector("canvas"), styles, progress, { arrows: false, shadow: true });
    });
  }
}

// ---------------------------------------------------------------------------
// Visual editor
// ---------------------------------------------------------------------------

const RING_OPTIONS = RING_ORDER.map((k) => ({ value: k, label: RINGS[k].label }));

const ringSection = (k, unit, max) => ({
  type: "expandable",
  flatten: true,
  title: `${RINGS[k].label} ring`,
  schema: [
    { name: `${k}_entity`, selector: { entity: { domain: "sensor" } } },
    {
      type: "grid",
      schema: [
        { name: `${k}_goal`, selector: { number: { min: 0, max, step: 1, mode: "box", unit_of_measurement: unit } } },
        { name: `${k}_goal_entity`, selector: { entity: { domain: ["sensor", "input_number", "number"] } } },
      ],
    },
  ],
});

const SCHEMA = [
  { name: "device", selector: { device: { filter: { integration: "mobile_app" } } } },
  {
    name: "layout",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "full", label: "Rings with details" },
          { value: "ring", label: "Ring only" },
          { value: "ring_values", label: "Ring with values inside" },
        ],
      },
    },
  },
  {
    type: "grid",
    schema: [
      {
        name: "theme",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "auto", label: "Auto (follow HA)" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "transparent", label: "Transparent" },
            ],
          },
        },
      },
      { name: "title", selector: { text: {} } },
    ],
  },
  { name: "rings", selector: { select: { multiple: true, mode: "list", options: RING_OPTIONS } } },
  ringSection("move", "kcal", 5000),
  ringSection("exercise", "min", 600),
  ringSection("stand", "hr", 24),
  {
    type: "expandable",
    flatten: true,
    title: "Display",
    schema: [
      {
        type: "grid",
        schema: [
          { name: "show_week", selector: { boolean: {} } },
          { name: "show_footer", selector: { boolean: {} } },
          { name: "show_arrows", selector: { boolean: {} } },
          { name: "animate", selector: { boolean: {} } },
          { name: "reset_stale", selector: { boolean: {} } },
          {
            name: "tap_action",
            selector: { select: { mode: "dropdown", options: [
              { value: "more-info", label: "More info" }, { value: "none", label: "Nothing" }] } },
          },
        ],
      },
      { name: "size", selector: { number: { min: 0, max: 600, step: 10, mode: "box", unit_of_measurement: "px" } } },
    ],
  },
];

const LABELS = {
  device: "Device",
  layout: "Layout",
  theme: "Theme",
  title: "Title",
  rings: "Rings",
  move_entity: "Active energy sensor",
  exercise_entity: "Exercise time sensor",
  stand_entity: "Stand hours sensor",
  move_goal: "Move goal",
  exercise_goal: "Exercise goal",
  stand_goal: "Stand goal",
  move_goal_entity: "Move goal sensor",
  exercise_goal_entity: "Exercise goal sensor",
  stand_goal_entity: "Stand goal sensor",
  show_week: "7-day strip",
  show_footer: "Last synced",
  show_arrows: "Ring arrows",
  animate: "Animate",
  reset_stale: "Zero yesterday's values",
  tap_action: "Tap",
  size: "Max ring size (0 = fill)",
};

const goalHelper = (k, unit) =>
  `Empty: the goal sensor, else Apple's default (${APPLE_GOALS[k]} ${unit})`;
const HELPERS = {
  device: "The iPhone in the Companion App. Fills in all six sensors below",
  move_goal: goalHelper("move", "kcal"),
  exercise_goal: goalHelper("exercise", "min"),
  stand_goal: goalHelper("stand", "h"),
  reset_stale: "Show 0 until the phone's first sync after midnight",
};

// What the editor stores: only what differs from the defaults, and a sensor
// only when it differs from what the device provides, so picking a device
// keeps the YAML to one line and later sensor renames still follow the device.
// `prev` is the stored config, `value` the form's data, `autoPrev`/`autoNext`
// the device's sensors before and after the change.
function editorConfig(prev, value, autoPrev, autoNext, deviceOf) {
  const out = { type: prev.type };
  const deviceChanged = (value.device || "") !== (prev.device || "");
  for (const [k, v] of Object.entries(value)) {
    if (k === "type" || RETIRED.includes(k) || v === undefined || v === "" || v === null) continue;
    if (SENSORS[k]) {
      const shown = prev[k] || autoPrev[k] || "";
      if (v === shown) {
        // Untouched. Keep an explicit choice unless it belonged to the old device.
        if (prev[k] && !(deviceChanged && deviceOf(prev[k]) === prev.device)) out[k] = prev[k];
        continue;
      }
      if (v !== autoNext[k]) out[k] = v;
      continue;
    }
    if (/_goal$/.test(k) && !(num(v, 0) > 0)) continue;
    if (JSON.stringify(v) === JSON.stringify(DEFAULTS[k])) continue;
    out[k] = v;
  }
  return out;
}

class ActivityRingsCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // hass updates constantly; re-setting the form's data each time would
    // fight with typing, so only re-render when the device's sensors moved.
    const sig = JSON.stringify(this._auto(this._config?.device));
    if (this._form && sig === this._autoSig) {
      this._form.hass = hass;
      return;
    }
    this._render();
  }

  _auto(device) {
    if (!device || !this._hass) return {};
    const uids = this._uids?.[device];
    if (uids === undefined && this._hass.callWS) {
      this._uids = { ...this._uids, [device]: null };
      fetchUniqueIds(this._hass, device).then((u) => {
        this._uids = { ...this._uids, [device]: u };
        if (u) this._render();
      });
    }
    return resolveDevice(this._hass, device, uids || null);
  }

  _render() {
    if (!this._config || !this._hass) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => LABELS[s.name] ?? s.name;
      this._form.computeHelper = (s) => HELPERS[s.name];
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const value = ev.detail.value;
        const deviceOf = (id) => this._hass.entities?.[id]?.device_id;
        const out = editorConfig(this._config, value,
          this._auto(this._config.device), this._auto(value.device), deviceOf);
        this._config = out;
        this._render();
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: out }, bubbles: true, composed: true,
        }));
      });
      this.appendChild(this._form);
    }
    const auto = this._auto(this._config.device);
    this._autoSig = JSON.stringify(auto);
    const data = { ...DEFAULTS, ...this._config };
    data.tap_action = tapAction(data.tap_action);
    for (const k of SENSOR_KEYS) data[k] = this._config[k] || auto[k] || undefined;
    this._form.hass = this._hass;
    this._form.schema = SCHEMA;
    this._form.data = data;
  }
}

if (!customElements.get(CARD_TYPE)) customElements.define(CARD_TYPE, ActivityRingsCard);
if (!customElements.get(EDITOR_TYPE)) customElements.define(EDITOR_TYPE, ActivityRingsCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: "Activity Rings",
    description: "Move, Exercise and Stand rings from the Companion App's Apple Health sensors.",
    preview: true,
  });
}

console.info(`%c ACTIVITY-RINGS-CARD %c ${CARD_VERSION} `,
  "color:#000;background:#FA114F;font-weight:700", "color:#000;background:#92E82A");

export { ActivityRingsCard, ActivityRingsCardEditor, APPLE_GOALS, SENSORS, editorConfig,
  fetchUniqueIds, findDevice, hexColor, resolveDevice, resolveEntities, ringColors, tapAction, toRingUnits };
