const $ = id => document.getElementById(id);
const state = {
  profile: null,
  sim: null,
  metrics: null,
  user: null,
  workspace: { profile: null, degradation: null, weibull: null, validation: null, simulationComplete: false, randomSeed: 42 }
};
const labels = [["temperature", "Temperature", "°C"], ["cycles", "Cycle count", "cycles"], ["fastCharge", "Fast charge", "%"], ["cRate", "Average C-rate", "C"], ["velocity", "Average velocity", "km/h"], ["gradient", "Road gradient", "%"]];
const num = id => $(id).value.trim() === "" ? NaN : Number($(id).value);
const fmt = (v, d = 2) => Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
const pct = v => Number.isFinite(v) ? (v * 100).toFixed(2) + "%" : "—";
let saveQueue = Promise.resolve();
let saveTimer;
let authMode = "login";

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers
  });
  if (response.status === 204) return null;
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an invalid response. Start the EVLife server and reload.");
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showAppError(message) {
  $("appMessage").textContent = message;
  $("appMessage").classList.add("visible");
}

function setSaveStatus(message, status = "saved") {
  const element = $("saveStatus");
  element.textContent = message;
  element.classList.toggle("saving", status === "saving");
  element.classList.toggle("error", status === "error");
}

function clearAppError() {
  $("appMessage").textContent = "";
  $("appMessage").classList.remove("visible");
}

function showProfile() {
  if (!state.profile) {
    $("profileGrid").innerHTML = '<div class="empty-state">No battery profile saved yet.</div>';
    $("overviewProfile").textContent = "No battery profile saved yet. Enter your measurements to get started.";
    $("profileStatus").textContent = "NOT SET";
    return;
  }
  const content = labels.map(([key, label, unit]) => `<div class="profile-item"><small>${label}</small><b>${fmt(state.profile[key])} ${unit}</b></div>`).join("");
  $("profileGrid").innerHTML = content;
  $("overviewProfile").innerHTML = content;
  $("profileStatus").textContent = "SAVED";
}

function captureWorkspace() {
  const readComplete = (ids, previous) => {
    const values = ids.map(num);
    return values.every(Number.isFinite) ? values : previous;
  };
  const degradation = readComplete(["initialSoh", "fadeRate", "cyclesYear", "cycleHorizon"], [
    state.workspace.degradation?.initialSoh,
    state.workspace.degradation?.fadeRate,
    state.workspace.degradation?.cyclesYear,
    state.workspace.degradation?.cycleHorizon
  ]);
  const weibull = readComplete(["beta", "eta", "mission"], [
    state.workspace.weibull?.b,
    state.workspace.weibull?.e,
    state.workspace.weibull?.t
  ]);
  const seed = num("randomSeed");
  return {
    profile: state.profile,
    degradation: degradation.every(Number.isFinite) ? {
      initialSoh: degradation[0], fadeRate: degradation[1], cyclesYear: degradation[2], cycleHorizon: degradation[3]
    } : null,
    weibull: weibull.every(Number.isFinite) ? {
      b: weibull[0], e: weibull[1], t: weibull[2], unit: $("distanceUnit").value.trim()
    } : null,
    validation: $("observedData").value || $("predictedData").value ? {
      observed: $("observedData").value, predicted: $("predictedData").value
    } : null,
    simulationComplete: isSimulationCurrent(),
    randomSeed: Number.isInteger(seed) && seed >= -2147483648 && seed <= 2147483647 ? seed : state.workspace.randomSeed
  };
}

function isSimulationCurrent() {
  if (!state.sim) return false;
  const { b, e, unit } = getW();
  return state.sim.b === b && state.sim.e === e && state.sim.unit === unit && state.sim.seed === num("randomSeed");
}

function updateOverviewResults() {
  const simulationIsCurrent = isSimulationCurrent();
  $("ovMcMean").textContent = simulationIsCurrent ? fmt(state.sim.mean, 0) : "—";
  $("ovMcUnit").textContent = simulationIsCurrent ? `${state.sim.unit} · 10,000 samples` : "Run a simulation to calculate";
  $("ovMcRange").textContent = simulationIsCurrent ? `${fmt(state.sim.p5, 0)}–${fmt(state.sim.p95, 0)}` : "—";
  $("ovMcRangeNote").textContent = simulationIsCurrent ? `${state.sim.unit} · 5th to 95th percentile` : "Life distribution range";
  $("ovRmse").textContent = state.metrics ? fmt(state.metrics.rmse, 4) : "—";
  $("ovR2").textContent = state.metrics ? `R² ${fmt(state.metrics.r2, 4)} · ${state.metrics.count} observations` : "Calculate validation metrics";
}

function persistWorkspace() {
  const snapshot = captureWorkspace();
  const save = async () => {
    setSaveStatus("Saving to database…", "saving");
    try {
      const result = await request("/api/workspace", { method: "PUT", body: JSON.stringify(snapshot) });
      state.workspace = result.workspace;
      setSaveStatus("Saved to your account");
      clearAppError();
    } catch (error) {
      setSaveStatus("Save failed", "error");
      showAppError(`Could not save your workspace to the database: ${error.message}`);
      throw error;
    }
  };
  saveQueue = saveQueue.then(save, save);
  return saveQueue;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistWorkspace().catch(() => {}), 400);
}

function restoreWorkspace(workspace) {
  state.workspace = workspace;
  state.profile = workspace.profile;
  state.sim = null;
  state.metrics = null;
  for (const [key] of labels) $(key).value = "";
  ["initialSoh", "fadeRate", "cyclesYear", "cycleHorizon", "beta", "eta", "mission"].forEach(id => $(id).value = "");
  $("distanceUnit").value = "km";
  $("observedData").value = "";
  $("predictedData").value = "";
  $("currentSoh").textContent = "—";
  $("capacityFade").textContent = "—";
  $("cycles80").textContent = "—";
  $("years80").textContent = "—";
  $("ovSoh").textContent = "—";
  $("ovMcMean").textContent = "—";
  $("ovMcUnit").textContent = "Run a simulation to calculate";
  $("ovMcRange").textContent = "—";
  $("ovMcRangeNote").textContent = "Life distribution range";
  $("ovRmse").textContent = "—";
  $("ovR2").textContent = "Calculate validation metrics";
  $("reliabilityValue").textContent = "—";
  $("hazardValue").textContent = "—";
  $("b10Value").textContent = "—";
  $("b50Value").textContent = "—";
  $("ovRel").textContent = "—";
  $("ovB10").textContent = "—";
  $("scenarioRows").innerHTML = "";
  $("r2Value").textContent = "—";
  $("rmseValue").textContent = "—";
  $("maeValue").textContent = "—";
  $("ksValue").textContent = "—";
  $("sampleCount").textContent = "—";
  $("mcMean").textContent = "—";
  $("mcStd").textContent = "—";
  $("mcP5").textContent = "—";
  $("mcP95").textContent = "—";
  $("mcSummary").textContent = "Run the simulation to generate the distribution and summary statistics.";
  $("validationMessage").textContent = "";
  $("inputMessage").textContent = "";
  ["degradationChart", "reliabilityChart", "hazardChart", "overviewScenarioChart", "histogramChart", "validationChart", "residualChart"].forEach(id => {
    const canvas = $(id);
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  });
  clearAppError();
  if (state.profile) {
    for (const [key] of labels) $(key).value = state.profile[key];
  }
  if (workspace.degradation) {
    $("initialSoh").value = workspace.degradation.initialSoh;
    $("fadeRate").value = workspace.degradation.fadeRate;
    $("cyclesYear").value = workspace.degradation.cyclesYear;
    $("cycleHorizon").value = workspace.degradation.cycleHorizon;
  }
  if (workspace.weibull) {
    $("beta").value = workspace.weibull.b;
    $("eta").value = workspace.weibull.e;
    $("mission").value = workspace.weibull.t;
    $("distanceUnit").value = workspace.weibull.unit;
  }
  if (workspace.validation) {
    $("observedData").value = workspace.validation.observed;
    $("predictedData").value = workspace.validation.predicted;
  }
  $("randomSeed").value = workspace.randomSeed;
  showProfile();
  updateDegradation();
  updateWeibull();
  $("authGate").hidden = true;
  $("appShell").hidden = false;
  $("userEmail").textContent = state.user.email;
  setSaveStatus("Connected · saved to your account");
  if (workspace.validation) calcValidation();
  if (workspace.simulationComplete) runMC();
  updateOverviewResults();
}

function setAuthMode(mode) {
  authMode = mode;
  const creating = mode === "register";
  $("authTitle").textContent = creating ? "Create your account" : "Sign in to EVLife";
  $("authDescription").textContent = creating
    ? "Create a private workspace for your battery profiles and analysis settings."
    : "Sign in to access your saved battery profiles and analysis settings.";
  $("authPassword").autocomplete = creating ? "new-password" : "current-password";
  $("authSubmit").textContent = creating ? "Create account" : "Sign in";
  $("authSwitchText").textContent = creating ? "Already have an account?" : "New to EVLife?";
  $("authToggle").textContent = creating ? "Sign in" : "Create an account";
  $("authMessage").textContent = creating ? "Use a password with at least 12 characters." : "";
}

function sohAt(cycles) {
  return Math.max(0, num("initialSoh") - num("fadeRate") * cycles / 1000);
}

function updateDegradation() {
  const settings = ["initialSoh", "fadeRate", "cyclesYear", "cycleHorizon"].map(num);
  if (!state.profile || !settings.every(Number.isFinite) || settings[0] <= 0 || settings[0] > 100 ||
      settings[1] <= 0 || settings[2] <= 0 || settings[3] < 100) {
    $("currentSoh").textContent = "—";
    $("capacityFade").textContent = "—";
    $("cycles80").textContent = "—";
    $("years80").textContent = "—";
    $("ovSoh").textContent = "—";
    updateOverviewResults();
    const canvas = $("degradationChart");
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    $("degradationText").textContent = state.profile
      ? "Enter your calibrated degradation settings to calculate battery health."
      : "Save a battery profile and enter calibrated degradation settings to calculate battery health.";
    return;
  }
  const [initial, rate, perYear, horizon] = settings;
  const cycles = state.profile.cycles;
  const soh = sohAt(cycles);
  const cycles80 = initial > 80 ? (initial - 80) * 1000 / rate : 0;
  $("currentSoh").textContent = fmt(soh) + "%";
  $("capacityFade").textContent = fmt(initial - soh) + "%";
  $("cycles80").textContent = Number.isFinite(cycles80) ? fmt(cycles80, 0) : "Not reached";
  $("years80").textContent = Number.isFinite(cycles80) ? fmt(Math.max(0, cycles80 - cycles) / perYear) + " years" : "Not reached";
  $("degradationText").textContent = `At ${fmt(cycles, 0)} cycles, the configured model estimates SoH at ${fmt(soh)}%. The 80% threshold is reached at approximately ${fmt(cycles80, 0)} total cycles.`;
  $("ovSoh").textContent = fmt(soh) + "%";
  updateOverviewResults();
  const xs = Array.from({ length: 21 }, (_, i) => i * horizon / 20);
  drawLine("degradationChart", xs, xs.map(sohAt), "Cycles", "SoH (%)", 80, 100, 0);
}

function weibull(t, b, e) {
  return Math.exp(-Math.pow(Math.max(0, t) / e, b));
}

function hazard(t, b, e) {
  if (t === 0 && b < 1) return Infinity;
  if (t === 0 && b === 1) return 1 / e;
  return (b / e) * Math.pow(t / e, b - 1);
}

function bLife(q, b, e) {
  return e * Math.pow(-Math.log(1 - q), 1 / b);
}

function getW() {
  return { b: num("beta"), e: num("eta"), t: num("mission"), unit: $("distanceUnit").value.trim() || "units" };
}

function updateWeibull() {
  const { b, e, t, unit } = getW();
  if (!(b > 0 && e > 0 && t >= 0 && [b, e, t].every(Number.isFinite))) {
    $("reliabilityValue").textContent = "—";
    $("hazardValue").textContent = "—";
    $("b10Value").textContent = "—";
    $("b50Value").textContent = "—";
    $("ovRel").textContent = "—";
    $("ovB10").textContent = "—";
    $("scenarioRows").innerHTML = "";
    updateOverviewResults();
    return;
  }
  const reliability = weibull(t, b, e);
  const rate = hazard(t, b, e);
  $("reliabilityValue").textContent = pct(reliability);
  $("hazardValue").textContent = (!Number.isFinite(rate) && rate > 0 ? "∞" : fmt(rate, 7)) + " / " + unit;
  $("b10Value").textContent = fmt(bLife(.1, b, e), 1) + " " + unit;
  $("b50Value").textContent = fmt(bLife(.5, b, e), 1) + " " + unit;
  $("ovRel").textContent = pct(reliability);
  $("ovB10").textContent = fmt(bLife(.1, b, e), 0) + " " + unit;
  updateOverviewResults();
  const xmax = Math.max(e * 1.5, t * 1.15, 1);
  const xs = Array.from({ length: 41 }, (_, i) => xmax * i / 40);
  drawLine("reliabilityChart", xs, xs.map(x => weibull(x, b, e) * 100), `Distance (${unit})`, "Reliability (%)", null, 100, 0);
  const rates = xs.map(x => Math.min(hazard(Math.max(x, .000001), b, e), 10 / e));
  drawLine("hazardChart", xs, rates, `Distance (${unit})`, "Hazard rate", null, Math.max(...rates) * 1.1, 0);
  const scenarios = [["Configured", b, e], ["Scale −10%", b, e * .9], ["Scale +10%", b, e * 1.1]];
  $("scenarioRows").innerHTML = scenarios.map(([name, shape, scale]) =>
    `<tr><td>${name}</td><td>${fmt(shape)}</td><td>${fmt(scale, 0)}</td><td><b>${pct(weibull(t, shape, scale))}</b></td></tr>`
  ).join("");
  drawBars("overviewScenarioChart", scenarios.map(item => item[0]), scenarios.map(item => weibull(t, item[1], item[2]) * 100), 100, "%");
}

function drawLine(id, xs, ys, xLabel, yLabel, threshold, yMaxOverride, yMin = 0) {
  const canvas = $(id);
  if (!canvas || !ys.length) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth || 600;
  const height = canvas.height;
  canvas.width = Math.max(300, width * devicePixelRatio);
  canvas.height = height * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.width / devicePixelRatio;
  const h = height;
  const left = 48, right = 12, top = 15, bottom = 34, plotW = w - left - right, plotH = h - top - bottom;
  ctx.clearRect(0, 0, w, h);
  let ymin = yMin, ymax = yMaxOverride || Math.max(...ys) * 1.12;
  if (ymax <= ymin) ymax = ymin + 1;
  ctx.font = "10px Arial";
  ctx.fillStyle = "#7b8a81";
  ctx.strokeStyle = "#e7eee9";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = top + plotH * i / 4;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
    ctx.fillText(fmt(ymax - (ymax - ymin) * i / 4, 1), 4, y + 3);
  }
  ctx.strokeStyle = "#168357";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ys.forEach((value, i) => {
    const x = left + plotW * i / (ys.length - 1);
    const y = top + plotH - (value - ymin) / (ymax - ymin) * plotH;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  if (threshold !== null) {
    const y = top + plotH - (threshold - ymin) / (ymax - ymin) * plotH;
    ctx.strokeStyle = "#d99a36";
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(w - right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#a77522";
    ctx.fillText("80% threshold", w - 90, y - 5);
  }
  ctx.fillStyle = "#7b8a81";
  ctx.fillText(xLabel, left + plotW / 2 - 35, h - 7);
  ctx.save();
  ctx.translate(11, top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

function drawBars(id, names, values, max, suffix = "") {
  const canvas = $(id);
  if (!canvas || !values.length) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth || 600, height = canvas.height;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, width, height);
  const left = 45, right = 10, top = 15, bottom = 34, plotW = width - left - right, plotH = height - top - bottom;
  ctx.font = "10px Arial";
  ctx.fillStyle = "#7b8a81";
  ctx.strokeStyle = "#e7eee9";
  for (let i = 0; i <= 4; i++) {
    const y = top + plotH * i / 4;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
    ctx.fillText(fmt(max * (1 - i / 4), 0), 8, y + 3);
  }
  const slot = plotW / names.length, barW = Math.min(65, slot * .48);
  values.forEach((value, i) => {
    const barH = Math.max(0, value / max * plotH);
    const x = left + slot * i + (slot - barW) / 2;
    const y = top + plotH - barH;
    ctx.fillStyle = "#168357";
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = "#607168";
    ctx.textAlign = "center";
    ctx.fillText(names[i], x + barW / 2, height - 12);
    ctx.fillStyle = "#234b39";
    ctx.fillText(fmt(value, 1) + suffix, x + barW / 2, y - 5);
  });
  ctx.textAlign = "left";
}

function mulberry32(seed) {
  return function () {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function runMC() {
  const { b, e, unit } = getW();
  const seed = num("randomSeed");
  if (!(b > 0 && e > 0 && Number.isInteger(seed))) {
    state.sim = null;
    $("mcMean").textContent = "—";
    $("mcStd").textContent = "—";
    $("mcP5").textContent = "—";
    $("mcP95").textContent = "—";
    $("mcSummary").textContent = "Enter valid Weibull parameters and a random seed to run a simulation.";
    const canvas = $("histogramChart");
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    updateOverviewResults();
    showAppError("Enter valid Weibull shape and scale parameters and a whole-number random seed first.");
    return;
  }
  const random = mulberry32(seed);
  const samples = Array.from({ length: 10000 }, () => e * Math.pow(-Math.log(1 - random()), 1 / b)).sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const standardDeviation = Math.sqrt(samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1));
  const percentile = q => samples[Math.floor(q * (samples.length - 1))];
  state.sim = { samples, mean, standardDeviation, p5: percentile(.05), p95: percentile(.95), unit, b, e, seed };
  $("mcMean").textContent = fmt(mean, 0);
  $("mcStd").textContent = fmt(standardDeviation, 0);
  $("mcP5").textContent = fmt(percentile(.05), 0);
  $("mcP95").textContent = fmt(percentile(.95), 0);
  $("mcUnit").textContent = unit;
  const low = samples[0], high = samples[samples.length - 1], bins = 25, counts = Array(bins).fill(0);
  samples.forEach(value => counts[Math.min(bins - 1, Math.floor((value - low) / (high - low || 1) * bins))]++);
  drawBars("histogramChart", counts.map((_, i) => fmt(low + (i + .5) * (high - low) / bins, 0)), counts, Math.max(...counts));
  $("mcSummary").textContent = `10,000 lifetimes sampled with β = ${b}, η = ${fmt(e, 0)} ${unit}, seed ${seed}. Mean: ${fmt(mean, 1)} ${unit}; standard deviation: ${fmt(standardDeviation, 1)} ${unit}; P5: ${fmt(percentile(.05), 1)} ${unit}; P95: ${fmt(percentile(.95), 1)} ${unit}.`;
  updateOverviewResults();
}

function parseList(id) {
  return $(id).value.split(/[,\s;]+/).filter(Boolean).map(Number);
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + .3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function normCdf(x, mean, standardDeviation) {
  return .5 * (1 + erf((x - mean) / (standardDeviation * Math.sqrt(2))));
}

function calcValidation() {
  state.metrics = null;
  const observed = parseList("observedData"), predicted = parseList("predictedData");
  $("r2Value").textContent = "—";
  $("rmseValue").textContent = "—";
  $("maeValue").textContent = "—";
  $("ksValue").textContent = "—";
  $("sampleCount").textContent = "—";
  if (observed.length < 2 || observed.length !== predicted.length || [...observed, ...predicted].some(value => !Number.isFinite(value))) {
    $("validationMessage").textContent = "Enter at least two valid values in matching-length lists.";
    ["validationChart", "residualChart"].forEach(id => {
      const canvas = $(id);
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    });
    updateOverviewResults();
    return;
  }
  const count = observed.length, mean = observed.reduce((sum, value) => sum + value, 0) / count;
  const squaredError = observed.reduce((sum, value, i) => sum + (value - predicted[i]) ** 2, 0);
  const totalSquared = observed.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const rmse = Math.sqrt(squaredError / count);
  const mae = observed.reduce((sum, value, i) => sum + Math.abs(value - predicted[i]), 0) / count;
  const r2 = totalSquared === 0 ? NaN : 1 - squaredError / totalSquared;
  const sorted = [...observed].sort((a, b) => a - b);
  const standardDeviation = Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count) || 1;
  let statistic = 0;
  sorted.forEach((value, i) => {
    const cdf = normCdf(value, mean, standardDeviation);
    statistic = Math.max(statistic, Math.abs((i + 1) / count - cdf), Math.abs(i / count - cdf));
  });
  $("r2Value").textContent = fmt(r2, 4);
  $("rmseValue").textContent = fmt(rmse, 4);
  $("maeValue").textContent = fmt(mae, 4);
  $("ksValue").textContent = fmt(statistic, 4);
  $("sampleCount").textContent = count;
  $("aicValue").textContent = "Not applicable";
  $("validationMessage").textContent = "Metrics calculated for entered data.";
  drawScatter("validationChart", observed, predicted);
  const residuals = observed.map((value, i) => value - predicted[i]);
  drawBars("residualChart", observed.map((_, i) => String(i + 1)), residuals, Math.max(...residuals.map(Math.abs)) * 1.2 || 1);
  state.metrics = { r2, rmse, mae, ks: statistic, count };
  updateOverviewResults();
}

function drawScatter(id, xValues, yValues) {
  const canvas = $(id), ctx = canvas.getContext("2d"), width = canvas.clientWidth || 500, height = canvas.height;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, width, height);
  const left = 42, right = 15, top = 12, bottom = 30, all = [...xValues, ...yValues];
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1, plotW = width - left - right, plotH = height - top - bottom;
  ctx.strokeStyle = "#e7eee9";
  for (let i = 0; i <= 4; i++) {
    const y = top + plotH * i / 4;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
  }
  const px = value => left + (value - min) / span * plotW;
  const py = value => top + plotH - (value - min) / span * plotH;
  ctx.strokeStyle = "#c18b39";
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(px(min), py(min));
  ctx.lineTo(px(max), py(max));
  ctx.stroke();
  ctx.setLineDash([]);
  xValues.forEach((value, i) => {
    ctx.fillStyle = "#168357";
    ctx.beginPath();
    ctx.arc(px(value), py(yValues[i]), 4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#718078";
  ctx.font = "10px Arial";
  ctx.fillText("Observed", width / 2 - 20, height - 6);
  ctx.save();
  ctx.translate(11, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Predicted", 0, 0);
  ctx.restore();
}

function nav(view) {
  document.querySelectorAll(".view").forEach(element => element.classList.toggle("active", element.id === "view-" + view));
  document.querySelectorAll(".nav-link").forEach(element => element.classList.toggle("active", element.dataset.view === view));
  const names = { overview: "Overview", input: "Battery information", degradation: "Degradation prediction", weibull: "Weibull reliability", montecarlo: "Monte Carlo simulation", validation: "Model validation" };
  $("pageTitle").textContent = names[view];
  if (view === "overview" || view === "degradation") updateDegradation();
  if (view === "overview" || view === "weibull") updateWeibull();
  if (view === "montecarlo" && state.sim) runMC();
  setTimeout(() => window.dispatchEvent(new Event("resize")), 20);
}

document.querySelectorAll(".nav-link").forEach(button => button.addEventListener("click", () => nav(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => nav(button.dataset.go)));

$("authToggle").addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
$("authForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("authMessage").textContent = "Connecting…";
  $("authSubmit").disabled = true;
  try {
    const result = await request(`/api/auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({ email: $("authEmail").value, password: $("authPassword").value })
    });
    state.user = result.user;
    $("authForm").reset();
    $("authMessage").textContent = "";
    restoreWorkspace(result.workspace);
  } catch (error) {
    $("authMessage").textContent = error.message;
  } finally {
    $("authSubmit").disabled = false;
  }
});

$("signOut").addEventListener("click", async () => {
  clearTimeout(saveTimer);
  let saveWarning = "";
  try {
    await persistWorkspace();
  } catch (error) {
    saveWarning = `Signed out, but the latest changes were not saved: ${error.message}`;
  }
  try {
    await request("/api/auth/logout", { method: "POST" });
    state.user = null;
    state.profile = null;
    state.workspace = { profile: null, degradation: null, weibull: null, validation: null, simulationComplete: false, randomSeed: 42 };
    $("appShell").hidden = true;
    $("authGate").hidden = false;
    $("authForm").reset();
    setAuthMode("login");
    if (saveWarning) $("authMessage").textContent = saveWarning;
  } catch (error) {
    showAppError(`Could not sign out: ${error.message}`);
  }
});

$("batteryForm").addEventListener("submit", async event => {
  event.preventDefault();
  const profile = {};
  for (const [key] of labels) profile[key] = Number($(key).value);
  if (Object.values(profile).some(value => !Number.isFinite(value)) || profile.cycles < 0 || !Number.isInteger(profile.cycles) ||
      profile.fastCharge < 0 || profile.fastCharge > 100 || profile.cRate < 0 || profile.velocity < 0 ||
      Math.abs(profile.temperature) > 200 || Math.abs(profile.gradient) > 100) {
    $("inputMessage").textContent = "Check your values. Cycles must be a non-negative integer, fast charge 0–100%, temperature ±200°C, and gradient ±100%.";
    return;
  }
  state.profile = profile;
  try {
    await persistWorkspace();
    showProfile();
    $("inputMessage").textContent = "Battery profile saved to your account.";
    updateDegradation();
  } catch {
    $("inputMessage").textContent = "The profile could not be saved. Check the message above and try again.";
  }
});

$("clearProfile").addEventListener("click", async () => {
  state.profile = null;
  try {
    await persistWorkspace();
    $("batteryForm").reset();
    showProfile();
    updateDegradation();
    $("inputMessage").textContent = "Saved battery profile removed.";
  } catch {
    $("inputMessage").textContent = "The profile could not be removed. Check the message above and try again.";
  }
});

$("runDegradation").addEventListener("click", async () => {
  const values = ["initialSoh", "fadeRate", "cyclesYear", "cycleHorizon"].map(num);
  if (!state.profile || !values.every(Number.isFinite) || values[0] <= 0 || values[0] > 100 || values[1] <= 0 || values[2] <= 0 || values[3] < 100) {
    showAppError("Save a battery profile and enter valid degradation settings before calculating.");
    return;
  }
  try {
    await persistWorkspace();
    updateDegradation();
  } catch {}
});

$("runWeibull").addEventListener("click", async () => {
  const { b, e, t } = getW();
  if (!(b > 0 && e > 0 && t >= 0 && [b, e, t].every(Number.isFinite)) || !$("distanceUnit").value.trim()) {
    showAppError("Enter a positive Weibull shape and scale, a non-negative mission distance, and a distance unit.");
    return;
  }
  try {
    await persistWorkspace();
    updateWeibull();
  } catch {}
});

$("runSimulation").addEventListener("click", async () => {
  clearAppError();
  runMC();
  if (!state.sim) return;
  try {
    await persistWorkspace();
  } catch {}
});

$("calculateMetrics").addEventListener("click", async () => {
  calcValidation();
  if (!state.metrics) return;
  try {
    await persistWorkspace();
  } catch {}
});

$("randomSeed").addEventListener("change", scheduleSave);
$("initialSoh").addEventListener("change", scheduleSave);
$("fadeRate").addEventListener("change", scheduleSave);
$("cyclesYear").addEventListener("change", scheduleSave);
$("cycleHorizon").addEventListener("change", scheduleSave);
$("beta").addEventListener("change", scheduleSave);
$("eta").addEventListener("change", scheduleSave);
$("mission").addEventListener("change", scheduleSave);
$("distanceUnit").addEventListener("change", scheduleSave);
$("observedData").addEventListener("input", scheduleSave);
$("predictedData").addEventListener("input", scheduleSave);

window.addEventListener("resize", () => {
  if ($("appShell").hidden) return;
  if ($("view-overview").classList.contains("active")) {
    updateDegradation();
    updateWeibull();
  }
  if ($("view-degradation").classList.contains("active")) updateDegradation();
  if ($("view-weibull").classList.contains("active")) updateWeibull();
  if ($("view-montecarlo").classList.contains("active") && state.sim) runMC();
  if ($("view-validation").classList.contains("active") && state.metrics) calcValidation();
});

async function start() {
  setAuthMode("login");
  try {
    const result = await request("/api/me");
    state.user = result.user;
    restoreWorkspace(result.workspace);
  } catch (error) {
    $("authGate").hidden = false;
    $("appShell").hidden = true;
    if (!error.message.includes("Please sign in") && !error.message.includes("session expired")) {
      $("authMessage").textContent = `Cannot connect to EVLife. Start the server and reload this page. (${error.message})`;
    }
  }
}

start();
