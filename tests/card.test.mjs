// Unit tests for the parts of the card that don't need a browser: finding a
// device's sensors, goal precedence, units, stale values and the editor's
// config output. Run with `node --test` (Node 20+); no dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";

// Just enough of a browser for the module to load.
globalThis.window = globalThis;
globalThis.HTMLElement = class {
  attachShadow() { this.shadowRoot = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] }; }
  dispatchEvent() {}
};
const registry = new Map();
globalThis.customElements = { get: (n) => registry.get(n), define: (n, c) => registry.set(n, c) };
globalThis.document = { createElement: () => ({}) };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
console.info = () => {};

const {
  ActivityRingsCard, APPLE_GOALS, colorIsDark, editorConfig, fetchUniqueIds, findDevice, hexColor, resolveDevice,
  resolveEntities, ringColors, tapAction, themeIsDark, toRingUnits,
} = await import("../dist/activity-rings-card.js");

const tick = () => new Promise((r) => setTimeout(r, 0));
const quietly = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};

const PHONE = "phone1";
const today = () => new Date().toISOString();
const st = (state, unit, updated = today()) => ({
  state: String(state), attributes: { unit_of_measurement: unit }, last_updated: updated,
});

// A phone as the Companion App 2026.10.3 registers it.
function makeHass(overrides = {}) {
  const sensors = {
    "sensor.iphone_active_energy": ["health_active_energy_burned", st(320, "kcal")],
    "sensor.iphone_move_goal": ["health_active_energy_burned_goal", st(600, "kcal")],
    "sensor.iphone_exercise_time": ["health_apple_exercise_time", st(12, "min")],
    "sensor.iphone_exercise_goal": ["health_apple_exercise_time_goal", st(45, "min")],
    "sensor.iphone_stand_hours": ["health_apple_stand_hours", st(7, "hours")],
    "sensor.iphone_stand_goal": ["health_apple_stand_hours_goal", st(10, "hours")],
    "sensor.iphone_battery_level": ["battery_level", st(80, "%")],
    ...overrides,
  };
  const entities = {};
  const states = {};
  const uids = {};
  for (const [id, [uid, state]] of Object.entries(sensors)) {
    entities[id] = { entity_id: id, device_id: PHONE, platform: "mobile_app" };
    states[id] = state;
    uids[id] = `ABC123_${uid}`;
  }
  return { entities, states, uids, themes: { darkMode: true }, locale: { language: "en-US" } };
}

function card(config, hass) {
  const c = new ActivityRingsCard();
  c.setConfig({ type: "custom:activity-rings-card", ...config });
  c._hass = hass;
  c._uids = hass.uids;
  c._signature(); // resolves entities
  return c;
}

test("device resolves all six sensors by unique_id", () => {
  const hass = makeHass();
  assert.deepEqual(resolveDevice(hass, PHONE, hass.uids), {
    move_entity: "sensor.iphone_active_energy",
    move_goal_entity: "sensor.iphone_move_goal",
    exercise_entity: "sensor.iphone_exercise_time",
    exercise_goal_entity: "sensor.iphone_exercise_goal",
    stand_entity: "sensor.iphone_stand_hours",
    stand_goal_entity: "sensor.iphone_stand_goal",
  });
});

test("unique_id match survives renamed entities", () => {
  const hass = makeHass();
  hass.entities["sensor.kcal_today"] = { ...hass.entities["sensor.iphone_active_energy"], entity_id: "sensor.kcal_today" };
  hass.uids["sensor.kcal_today"] = hass.uids["sensor.iphone_active_energy"];
  delete hass.entities["sensor.iphone_active_energy"];
  assert.equal(resolveDevice(hass, PHONE, hass.uids).move_entity, "sensor.kcal_today");
});

test("without unique_ids (non-admin) entity_id suffixes are used", () => {
  const hass = makeHass();
  const r = resolveDevice(hass, PHONE, null);
  assert.equal(r.move_entity, "sensor.iphone_active_energy");
  assert.equal(r.stand_goal_entity, "sensor.iphone_stand_goal");
});

test("a value sensor is never mistaken for its goal sensor", () => {
  const hass = makeHass();
  for (const uids of [hass.uids, null]) {
    const r = resolveDevice(hass, PHONE, uids);
    assert.notEqual(r.move_entity, r.move_goal_entity);
    assert.notEqual(r.exercise_entity, r.exercise_goal_entity);
    assert.notEqual(r.stand_entity, r.stand_goal_entity);
  }
});

test("a phone without the 2026.10.3 sensors resolves what it has", () => {
  const hass = makeHass();
  for (const id of ["sensor.iphone_stand_hours", "sensor.iphone_stand_goal", "sensor.iphone_move_goal"]) delete hass.entities[id];
  const r = resolveDevice(hass, PHONE, hass.uids);
  assert.equal(r.stand_entity, "");
  assert.equal(r.move_goal_entity, "");
  assert.equal(r.move_entity, "sensor.iphone_active_energy");
});

test("explicit entities override the device", () => {
  const hass = makeHass();
  const r = resolveEntities(hass, { device: PHONE, stand_entity: "sensor.other" }, hass.uids);
  assert.equal(r.stand_entity, "sensor.other");
  assert.equal(r.move_entity, "sensor.iphone_active_energy");
});

test("goals follow the device's goal sensors by default", () => {
  const c = card({ device: PHONE }, makeHass());
  assert.deepEqual(["move", "exercise", "stand"].map((k) => c._goal(k).goal), [600, 45, 10]);
});

test("goal precedence: goal entity > number > device goal > Apple default", () => {
  const hass = makeHass({ "sensor.my_goal": ["x", st(900, "kcal")] });
  assert.equal(card({ device: PHONE, move_goal: 400, move_goal_entity: "sensor.my_goal" }, hass)._goal("move").goal, 900);
  assert.equal(card({ device: PHONE, move_goal: 400 }, hass)._goal("move").goal, 400);
  assert.equal(card({ device: PHONE }, hass)._goal("move").goal, 600);
  hass.states["sensor.iphone_move_goal"] = st("unavailable", "kcal");
  assert.equal(card({ device: PHONE }, hass)._goal("move").goal, APPLE_GOALS.move);
});

test("Apple defaults: Exercise 30 min, Stand 12 h", () => {
  assert.equal(APPLE_GOALS.exercise, 30);
  assert.equal(APPLE_GOALS.stand, 12);
  const c = card({ move_entity: "sensor.x", exercise_entity: "sensor.y", stand_entity: "sensor.z" }, makeHass());
  assert.equal(c._goal("exercise").goal, 30);
  assert.equal(c._goal("stand").goal, 12);
});

test("units are converted to kcal / min / h", () => {
  assert.ok(Math.abs(toRingUnits("move", 4184, "kJ") - 1000) < 1e-9);
  assert.equal(toRingUnits("exercise", 1.5, "h"), 90);
  assert.equal(toRingUnits("exercise", 120, "s"), 2);
  assert.equal(toRingUnits("stand", 7, "hours"), 7);
  assert.equal(toRingUnits("stand", 120, "min"), 2);
});

test("readings: progress, unavailable, missing", () => {
  const hass = makeHass();
  hass.states["sensor.iphone_stand_hours"] = st("unavailable", "hours");
  const c = card({ device: PHONE }, hass);
  const move = c._read("move");
  assert.equal(move.value, 320);
  assert.ok(Math.abs(move.progress - 320 / 600) < 1e-9);
  assert.equal(c._read("stand").status, "unavailable");
  delete hass.entities["sensor.iphone_stand_hours"];
  delete hass.states["sensor.iphone_stand_hours"];
  const c2 = card({ device: PHONE }, hass);
  assert.equal(c2._read("stand").status, "missing");
  assert.equal(c2._read("stand").entity, "");
});

test("a total last reported before midnight reads 0 until today's sync", () => {
  const yesterday = new Date(Date.now() - 86400e3).toISOString();
  const hass = makeHass({ "sensor.iphone_active_energy": ["health_active_energy_burned", st(900, "kcal", yesterday)] });
  const r = card({ device: PHONE }, hass)._read("move");
  assert.equal(r.status, "stale");
  assert.equal(r.value, 0);
  assert.equal(card({ device: PHONE, reset_stale: false }, hass)._read("move").value, 900);
});

test("setConfig needs a device or a sensor, and drops 1.x options", () => {
  const c = new ActivityRingsCard();
  assert.throws(() => c.setConfig({ type: "x" }), /device/);
  c.setConfig({ type: "x", device: PHONE, stand_placeholder: "old" });
  assert.equal(c._config.stand_placeholder, undefined);
  assert.throws(() => c.setConfig({ type: "x", device: PHONE, layout: "nope" }), /layout/);
  assert.throws(() => c.setConfig({ type: "x", device: PHONE, rings: [] }), /rings/);
});

test("stub config picks the Companion App phone", () => {
  assert.deepEqual(ActivityRingsCard.getStubConfig(makeHass()), { device: PHONE });
  assert.equal(findDevice({ entities: {} }), "");
  assert.deepEqual(ActivityRingsCard.getStubConfig({ entities: {} }), {});
});

test("editor: picking a device stores just the device", () => {
  const hass = makeHass();
  const auto = resolveDevice(hass, PHONE, hass.uids);
  const deviceOf = (id) => hass.entities[id]?.device_id;
  const prev = { type: "custom:activity-rings-card" };
  const out = editorConfig(prev, { ...prev, device: PHONE, layout: "full", theme: "auto" }, {}, auto, deviceOf);
  assert.deepEqual(out, { type: prev.type, device: PHONE });
  // the form echoes the auto-filled sensors back; they must not be stored
  const echoed = editorConfig(out, { ...out, ...auto, show_week: true }, auto, auto, deviceOf);
  assert.deepEqual(echoed, { type: prev.type, device: PHONE });
});

test("editor: overrides are kept, and dropped when set back to the device's", () => {
  const hass = makeHass();
  const auto = resolveDevice(hass, PHONE, hass.uids);
  const deviceOf = (id) => hass.entities[id]?.device_id;
  const base = { type: "t", device: PHONE };
  const over = editorConfig(base, { ...base, ...auto, stand_entity: "sensor.other" }, auto, auto, deviceOf);
  assert.equal(over.stand_entity, "sensor.other");
  const back = editorConfig(over, { ...over, ...auto }, auto, auto, deviceOf);
  assert.equal(back.stand_entity, undefined);
});

test("editor: switching device drops overrides from the old device", () => {
  const hass = makeHass();
  hass.entities["sensor.p2_active_energy"] = { entity_id: "sensor.p2_active_energy", device_id: "phone2", platform: "mobile_app" };
  const deviceOf = (id) => hass.entities[id]?.device_id;
  const auto1 = resolveDevice(hass, PHONE, null);
  const auto2 = resolveDevice(hass, "phone2", null);
  const prev = { type: "t", device: PHONE, move_goal_entity: "sensor.iphone_exercise_goal", stand_entity: "sensor.elsewhere" };
  const shown = { ...prev, ...auto1, move_goal_entity: prev.move_goal_entity, stand_entity: prev.stand_entity };
  const out = editorConfig(prev, { ...shown, device: "phone2" }, auto1, auto2, deviceOf);
  assert.equal(out.device, "phone2");
  assert.equal(out.move_goal_entity, undefined);     // belonged to phone1
  assert.equal(out.stand_entity, "sensor.elsewhere"); // not a phone1 sensor: user's choice
  assert.equal(out.move_entity, undefined);           // phone2's own, so not stored
});

test("editor: empty or zero goals are not stored", () => {
  const out = editorConfig({ type: "t", device: PHONE }, { device: PHONE, move_goal: 0, exercise_goal: "", stand_goal: 8 }, {}, {}, () => null);
  assert.deepEqual(out, { type: "t", device: PHONE, stand_goal: 8 });
});

test("units: food Calories, joules and watt-hours convert to kcal", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  close(toRingUnits("move", 320, "Cal"), 320);     // food Calorie = kcal
  close(toRingUnits("move", 320000, "cal"), 320);  // HA's small calorie
  close(toRingUnits("move", 320, "KCAL"), 320);
  close(toRingUnits("move", 4184000, "J"), 1000);
  close(toRingUnits("move", 4.184, "MJ"), 1000);
  close(toRingUnits("move", 1, "kWh"), 859.845);
  close(toRingUnits("move", 320, undefined), 320);
});

test("units: exercise and stand accept any time unit", () => {
  assert.equal(toRingUnits("exercise", 0.5, "hr"), 30);
  assert.equal(toRingUnits("exercise", 30, "min"), 30);
  assert.equal(toRingUnits("exercise", 1, "d"), 1440);
  assert.equal(toRingUnits("stand", 7200, "s"), 2);
  assert.equal(toRingUnits("stand", 2, "h"), 2);
  assert.equal(toRingUnits("stand", 9, "hr"), 9);
  assert.equal(toRingUnits("stand", 9, ""), 9);
});

test("colors: shorthand, short hex, a lone color paints the whole ring", () => {
  assert.equal(hexColor("#0f0"), "#00ff00");
  assert.equal(hexColor("#12AB34"), "#12AB34");
  assert.deepEqual(
    (({ color, from, to, light }) => ({ color, from, to, light }))(ringColors("stand", "#0f0")),
    { color: "#00ff00", from: "#00ff00", to: "#00ff00", light: "#00ff00" },
  );
  const mixed = ringColors("move", { color: "#123456", to: "#abcdef", label: "Burn" });
  assert.equal(mixed.from, "#123456");
  assert.equal(mixed.to, "#abcdef");
  assert.equal(mixed.label, "Burn");
  assert.equal(mixed.arrow, "single");
  const c = card({ device: PHONE, colors: { exercise: "#00f" } }, makeHass());
  assert.equal(c._colors.exercise.light, "#0000ff");
  assert.equal(c._colors.move.color, "#FA114F");
});

test("colors: an unusable value keeps Apple's colour", async () => {
  await quietly(() => {
    const r = ringColors("move", { color: "var(--accent)", from: "nope" });
    assert.equal(r.color, "#FA114F");
    assert.equal(r.from, "#E3053F");
  });
});

test("tap_action accepts HA's { action } object form", () => {
  assert.equal(tapAction({ action: "none" }), "none");
  assert.equal(tapAction({ action: "more-info" }), "more-info");
  assert.equal(tapAction(undefined), "more-info");
  assert.equal(card({ device: PHONE, tap_action: { action: "none" } }, makeHass())._config.tap_action, "none");
  assert.equal(card({ device: PHONE, tap_action: "none" }, makeHass())._config.tap_action, "none");
});

test("disconnecting mid-animation leaves the rings at their target", () => {
  const c = card({ device: PHONE }, makeHass());
  c._target = { move: 0.53, exercise: 0.27, stand: 0.7 };
  c._shown = { move: 0.1, exercise: 0.05, stand: 0.2 };
  c._raf = 7;
  c.disconnectedCallback();
  assert.deepEqual(c._shown, c._target);
  assert.equal(c._raf, null);
});

test("the sync time follows HA's 12/24-hour setting", () => {
  const hass = makeHass();
  const c = card({ device: PHONE }, hass);
  const t = new Date(2020, 0, 2, 15, 5);
  hass.locale = { language: "en-US", time_format: "24" };
  assert.match(c._time(t), /15:05/);
  hass.locale = { language: "en-GB", time_format: "12" };
  assert.match(c._time(t), /3:05/);
});

test("a failed unique_id lookup is not cached", async () => {
  const hass = makeHass();
  for (const e of Object.values(hass.entities)) e.device_id = "uid-retry";
  let fail = true;
  hass.callWS = async (msg) => {
    if (fail) throw new Error("connection lost");
    return Object.fromEntries(msg.entity_ids.map((id) => [id, { unique_id: hass.uids[id] }]));
  };
  assert.equal(await fetchUniqueIds(hass, "uid-retry"), null);
  fail = false;
  const uids = await fetchUniqueIds(hass, "uid-retry");
  assert.equal(uids["sensor.iphone_stand_hours"], hass.uids["sensor.iphone_stand_hours"]);
});

test("setConfig after hass looks up unique_ids", async () => {
  const hass = makeHass();
  for (const e of Object.values(hass.entities)) e.device_id = "late-config";
  const calls = [];
  hass.callWS = async (msg) => {
    calls.push(msg.type);
    return {};
  };
  const c = new ActivityRingsCard();
  c._update = () => {};
  c.hass = hass;
  c.setConfig({ type: "t", device: "late-config" });
  assert.deepEqual(calls, ["config/entity_registry/get_entries"]);
});

test("week: a load that outlives its config is dropped and reloaded", async () => {
  const hass = makeHass();
  const c = card({ device: PHONE }, hass);
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  hass.callWS = (msg) => {
    calls.push(msg.entity_ids);
    return calls.length <= 2 ? gate.then(() => ({})) : Promise.resolve({});
  };
  const first = c._maybeLoadWeek();
  // Reconfigure to Move only while the first load is in flight.
  c._hass = null;
  c.setConfig({ type: "t", device: PHONE, rings: ["move"] });
  c._hass = hass;
  c._uids = hass.uids;
  c._signature();
  release();
  await first;
  await tick();
  assert.deepEqual(calls.at(-2), ["sensor.iphone_active_energy"]);
  assert.match(c._weekKey, /sensor\.iphone_active_energy\|sensor\.iphone_move_goal$/);
  assert.doesNotMatch(c._weekKey, /exercise/);
});

test("week: a failed load is retried later, not cached for the day", async () => {
  const hass = makeHass();
  const c = card({ device: PHONE }, hass);
  let calls = 0;
  hass.callWS = async () => {
    calls += 1;
    throw new Error("recorder busy");
  };
  await quietly(() => c._maybeLoadWeek());
  assert.equal(c._weekKey, "");
  const n = calls;
  await quietly(() => c._maybeLoadWeek());
  assert.equal(calls, n, "no retry before the back-off");
  c._weekRetryAt = 0;
  hass.callWS = async () => { calls += 1; return {}; };
  await c._maybeLoadWeek();
  assert.ok(calls > n);
  assert.notEqual(c._weekKey, "");
});

test("colorIsDark reads hex and rgb()/rgba() theme colours", () => {
  assert.equal(colorIsDark("#18181b"), true);
  assert.equal(colorIsDark("#FFFFFF"), false);
  assert.equal(colorIsDark("#000"), true);
  assert.equal(colorIsDark(" #f7f9fc "), false);
  assert.equal(colorIsDark("rgb(50, 51, 53)"), true);
  assert.equal(colorIsDark("rgb(243 243 244)"), false);
  assert.equal(colorIsDark("rgba(255, 255, 255, 0.74)"), false);
  assert.equal(colorIsDark("#10203080"), true);
  // See-through or unreadable: no answer, so the next variable / darkMode decides.
  assert.equal(colorIsDark("rgba(0, 0, 0, 0.1)"), null);
  assert.equal(colorIsDark("#00000000"), null);
  assert.equal(colorIsDark("transparent"), null);
  assert.equal(colorIsDark(""), null);
  assert.equal(colorIsDark(undefined), null);
  assert.equal(colorIsDark("#12"), null);
});

test("themeIsDark: card background first, see-through falls through", () => {
  const vars = (v) => (name) => v[name] ?? "";
  assert.equal(themeIsDark({}, vars({ "--card-background-color": "#18181b" })), true);
  assert.equal(themeIsDark({}, vars({ "--card-background-color": "#ffffff" })), false);
  assert.equal(themeIsDark({}, vars({
    "--ha-card-background": "rgba(255, 255, 255, 0.05)", "--primary-background-color": "#111419",
  })), true);
  assert.equal(themeIsDark({}, vars({})), null);
  assert.equal(themeIsDark({}, () => { throw new Error("detached"); }), null);
});

test("auto follows a dark-only theme even when darkMode is false", () => {
  const hass = makeHass();
  hass.themes = { darkMode: false };
  const c = card({ device: PHONE }, hass);
  const gcs = globalThis.getComputedStyle;
  try {
    // A dark theme without light/dark modes (darkMode stays false).
    globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === "--card-background-color" ? "#18181b" : "") });
    assert.equal(c._isDark(), true);
    // A light theme while darkMode is (wrongly) on: the background wins.
    hass.themes = { darkMode: true };
    globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === "--card-background-color" ? "#ffffff" : "") });
    assert.equal(c._isDark(), false);
    // Nothing readable: darkMode decides, as in 2.0.0.
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
    assert.equal(c._isDark(), true);
    hass.themes = { darkMode: false };
    assert.equal(c._isDark(), false);
    // Explicit themes ignore the background.
    c._config = { ...c._config, theme: "light" };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => "#000000" });
    assert.equal(c._isDark(), false);
  } finally {
    globalThis.getComputedStyle = gcs;
  }
});
