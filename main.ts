// gta6-trophy-rarity-forecast-01 — count-space, refresh-aware trophy forecast.
// Forecasts each GTA VI trophy's Exophase earn rate (percent) at a case's target
// as five quantiles, from the house's reads before the case's checkpoint.
//
// Core idea: model EARNERS and PLAYERS separately, never fit raw rates.
//   rate = earners / players_tracked.
// On a refresh Exophase's players-tracked jumps (638 -> 3868 on launch night)
// while earners stay continuous, so raw rates collapse by dilution. Fitting
// earners E_i(t) and players N(t) separately in log-time keeps that structure
// instead of mistaking dilution drops for "rates declining".
//
// Two guards learned from synthetic final-like worlds (see the run record):
//   - Fits run on the DISTINCT refresh states only: the page is frozen
//     between refreshes, so repeated reads carry no information and distort
//     least squares (reads are dense exactly where the page is frozen).
//   - The forecast rate is capped at the last read's rate grown by at most
//     e^(0.2/day): log-linear fits over-extrapolate saturating processes,
//     and without the cap the model forecasts absurd 80-99% rates.
//
// Deterministic: no randomness, no clock, no network, no reads outside the
// input dir. Node 22 stdlib only.

import fs from "node:fs";
import path from "node:path";

const LAUNCH_MS = Date.parse("2026-11-19T00:00:00Z");
const FIRST_REFRESH_MS = Date.parse("2026-11-19T04:30:00Z");
const FIRST_REFRESH_N = 3868;
const Z: number[] = [-1.645, -0.674, 0, 0.674, 1.645];

type Trophy = {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
};

type Read = {
  atMs: number;
  n: number;
  rates: (number | null)[];
};

type CaseData = {
  id: string;
  at: string;
  target: string;
  horizonMinutes: number;
  trophies: Trophy[];
  history: Read[];
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function logit(x: number): number {
  const p = clamp(x, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function invLogit(l: number): number {
  return 100 / (1 + Math.exp(-l));
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// Ordinary least squares of y on x. Returns slope, intercept, residual
// variance (null when fewer than 2 points) and slope standard error.
function ols(
  xs: number[],
  ys: number[]
): { b: number; a: number; s2: number | null; seB: number | null; sxx: number } {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  if (n < 3 || sxx <= 0) {
    return { b, a, s2: null, seB: null, sxx };
  }
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    rss += r * r;
  }
  const s2 = rss / (n - 2);
  const seB = Math.sqrt(s2 / sxx);
  return { b, a, s2, seB, sxx };
}

function parseCase(raw: string): CaseData {
  const obj = JSON.parse(raw);
  const trophies: Trophy[] = obj.trophies.map((t: any) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    tier: t.tier,
    points: t.points,
    secret: t.secret,
  }));
  const history: Read[] = (obj.history || []).map((h: any) => ({
    atMs: Date.parse(h.at),
    n: h.players_tracked,
    rates: (h.rates || []).map((r: any) => (r === null || r === undefined ? null : Number(r))),
  }));
  return {
    id: String(obj.id),
    at: String(obj.at),
    target: String(obj.target),
    horizonMinutes: Number(obj.horizon_minutes),
    trophies,
    history,
  };
}

function forecastCase(c: CaseData): { id: number; q: number[] }[] {
  const targetMs = Date.parse(c.target);
  const checkpointMs = Date.parse(c.at);
  const horizonHours = Math.max(0, (targetMs - checkpointMs) / 3600000);
  const horizonDays = horizonHours / 24;
  const logT = Math.log(1 + Math.max(0, (targetMs - LAUNCH_MS) / 3600000));
  const nT = c.trophies.length;

  // No history at all: 1% median, wide fan.
  if (c.history.length === 0) {
    return c.trophies.map((t) => ({
      id: t.id,
      q: quantilesFromLogit(logit(1.0), 1.0),
    }));
  }

  const last = c.history[c.history.length - 1];
  const lastN = last.n;
  const lastRates: (number | null)[] = last.rates;

  // Collapse consecutive identical reads to the first read showing those
  // values. The page is frozen between Exophase refreshes, so the repeats
  // carry no information — and feeding them to a least-squares fit distorts
  // it, because reads are dense (every 10 min) exactly where the page is
  // frozen and sparse where it moves. The distinct states (one per refresh)
  // are the informative observations. A history is FLAT when it collapses
  // to a single state.
  const states: Read[] = [];
  for (const h of c.history) {
    const prev = states[states.length - 1];
    if (
      prev &&
      prev.n === h.n &&
      prev.rates.length === h.rates.length &&
      prev.rates.every((r, i) => r === h.rates[i])
    ) {
      continue;
    }
    states.push(h);
  }
  const flat = states.length === 1;

  const targetDate = c.target.slice(0, 10);
  const refreshPriorApplies =
    flat && targetDate === "2026-11-19" && targetMs >= FIRST_REFRESH_MS;

  // Flat history, long horizon, no refresh prior: no signal at all.
  // Fall back to the house baseline's persistence median + random-walk spread.
  if (flat && !refreshPriorApplies && horizonDays > 0.5) {
    return c.trophies.map((t, i) => {
      const r = lastRates[i] === null || lastRates[i] === undefined ? 1.0 : (lastRates[i] as number);
      const sigma = 0.5 * Math.sqrt(horizonDays);
      return { id: t.id, q: quantilesFromLogit(logit(r), sigma, sigma) };
    });
  }

  // ---- Fit players N(t): log N vs log(1 + t_hours), slope shrunk to 0.35 ----
  // Fitted on the distinct refresh states, not on the raw reads.
  const xsN: number[] = [];
  const ysN: number[] = [];
  for (const h of states) {
    if (h.n > 0) {
      xsN.push(Math.log(1 + Math.max(0, (h.atMs - LAUNCH_MS) / 3600000)));
      ysN.push(Math.log(h.n));
    }
  }
  let forecastN = lastN;
  if (xsN.length >= 2) {
    const fit = ols(xsN, ysN);
    const w = xsN.length / (xsN.length + 4);
    const bShrunk = w * fit.b + (1 - w) * 0.35;
    // Refit intercept at the shrunk slope so the line passes through the data mean.
    let mx = 0;
    let my = 0;
    for (let i = 0; i < xsN.length; i++) {
      mx += xsN[i];
      my += ysN[i];
    }
    mx /= xsN.length;
    my /= ysN.length;
    const a = my - bShrunk * mx;
    forecastN = Math.exp(a + bShrunk * logT);
  }
  // Sanity clamps on N(T).
  forecastN = clamp(forecastN, lastN, lastN * (1 + 2 * (horizonHours / 24)));
  if (refreshPriorApplies) {
    forecastN = FIRST_REFRESH_N;
  }

  // ---- Per-trophy earner fits: log(E + 0.5) vs log(1 + t_hours) ----
  // Fitted on the distinct refresh states, for the same reason as N(t):
  // frozen repeats would overweight the flat stretches.
  type TrophyFit = {
    b: number;
    a: number;
    sigmaFit: number;
    seB: number | null;
    nPts: number;
    lastE: number;
    always100: boolean;
    always0: boolean;
  };
  const fits: TrophyFit[] = [];
  const tierSlopes: Record<string, number[]> = {};
  const allSlopes: number[] = [];
  for (let i = 0; i < nT; i++) {
    const xs: number[] = [];
    const ys: number[] = [];
    let always100 = true;
    let always0 = true;
    let lastE = 0;
    for (const h of states) {
      const r = h.rates[i];
      if (r === null || r === undefined) continue;
      if (r < 100) always100 = false;
      if (r > 0) always0 = false;
      const e = Math.round((r * h.n) / 100);
      xs.push(Math.log(1 + Math.max(0, (h.atMs - LAUNCH_MS) / 3600000)));
      ys.push(Math.log(e + 0.5));
      lastE = e;
    }
    let f: TrophyFit;
    if (xs.length >= 2) {
      const fit = ols(xs, ys);
      let sigmaFit = 0.05;
      if (fit.s2 !== null) sigmaFit = Math.max(0.05, Math.sqrt(fit.s2));
      f = {
        b: fit.b,
        a: fit.a,
        sigmaFit,
        seB: fit.seB,
        nPts: xs.length,
        lastE,
        always100,
        always0,
      };
      if (!tierSlopes[c.trophies[i].tier]) tierSlopes[c.trophies[i].tier] = [];
      tierSlopes[c.trophies[i].tier].push(fit.b);
      allSlopes.push(fit.b);
    } else if (xs.length === 1) {
      f = {
        b: 0,
        a: ys[0],
        sigmaFit: 0.05,
        seB: null,
        nPts: 1,
        lastE,
        always100,
        always0,
      };
    } else {
      f = {
        b: 0,
        a: Math.log(0.5),
        sigmaFit: 0.05,
        seB: null,
        nPts: 0,
        lastE: 0,
        always100: false,
        always0: true,
      };
    }
    fits.push(f);
  }

  // Hierarchical shrinkage: tier means toward the global mean, then each
  // trophy's slope toward its tier mean (stronger with fewer reads).
  const globalMean =
    allSlopes.length > 0
      ? allSlopes.reduce((s, v) => s + v, 0) / allSlopes.length
      : 0;
  const tierMean: Record<string, number> = {};
  for (const tier of Object.keys(tierSlopes)) {
    const arr = tierSlopes[tier];
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    tierMean[tier] = (arr.length * m + 4 * globalMean) / (arr.length + 4);
  }

  const rows: { id: number; q: number[] }[] = [];
  for (let i = 0; i < nT; i++) {
    const t = c.trophies[i];
    const f = fits[i];
    let eForecast: number;
    let sigma: number;

    if (f.always100) {
      // Everyone tracked has it; it stays 100%.
      rows.push({ id: t.id, q: quantilesFromLogit(logit(99.99), 0.05, 0.05) });
      continue;
    }

    if (refreshPriorApplies) {
      // Practice regime: earners frozen at the last read, denominator jumps
      // to the first refresh count. Spread is the narrow random-walk fan.
      eForecast = f.lastE;
      const sigmaH = 0.5 * Math.sqrt(horizonDays);
      sigma = Math.sqrt(0.05 * 0.05 + sigmaH * sigmaH);
    } else {
      const tm = tierMean[t.tier] !== undefined ? tierMean[t.tier] : globalMean;
      const w = f.nPts / (f.nPts + 3);
      const bShrunk = w * f.b + (1 - w) * tm;
      eForecast = Math.exp(f.a + bShrunk * logT) - 0.5;
      if (f.always0) eForecast = Math.min(eForecast, 0.5);
      // Spread: the fit's residual scatter (capped — with deduped step
      // data the residuals mostly measure curvature, not noise, so an
      // uncapped scatter, and the slope standard error built from it, would
      // inflate the fan far past what the data warrants) plus the
      // random-walk horizon term. The slope SE is deliberately NOT added:
      // on step data it tracks curvature, and in simulation the fan with it
      // scores worse on every world family.
      const sigmaFit = Math.min(0.15, Math.max(0.05, f.sigmaFit));
      const sigmaH = 0.5 * Math.sqrt(horizonDays) * 0.7;
      sigma = Math.sqrt(sigmaFit * sigmaFit + sigmaH * sigmaH);
    }

    eForecast = clamp(eForecast, 0, forecastN);
    let rate = clamp((100 * eForecast) / forecastN, 0.01, 99.99);
    // Guardrail against log-linear over-extrapolation. The log-E and log-N
    // fits are straight lines in log-time, but both processes saturate, so
    // a long extrapolation can forecast absurd rates (80-99% for trophies
    // the data says are at 15%). Cap the forecast rate at the last read's
    // rate grown by at most e^(0.2/day) — 2.47x over the 4.52-day final
    // horizon. Validated on synthetic final-like worlds: without the cap
    // the model loses to the trend baseline everywhere; with it, it beats
    // the trend baseline on every simulated family (see the run record).
    // The cap never binds in the refresh-prior path (the diluted rate is
    // below the last rate) and is skipped for near-zero last rates, where
    // a trophy can legitimately appear from nothing.
    const rLast = lastRates[i];
    if (rLast !== null && rLast !== undefined && rLast > 0.1) {
      rate = Math.min(rate, rLast * Math.exp(0.2 * horizonDays));
    }
    const sigmaUp = sigma * 1.25;
    const sigmaDown = sigma * 0.9;
    rows.push({ id: t.id, q: quantilesFromLogit(logit(rate), sigmaUp, sigmaDown) });
  }
  return rows;
}

// Build the five quantiles from a logit median and asymmetric sigmas.
function quantilesFromLogit(
  l: number,
  sigmaUp: number,
  sigmaDown?: number
): number[] {
  const sd = sigmaDown === undefined ? sigmaUp : sigmaDown;
  const out: number[] = [];
  for (let k = 0; k < 5; k++) {
    const s = Z[k] < 0 ? sd : sigmaUp;
    const q = clamp(invLogit(l + Z[k] * s), 0, 100);
    out.push(round4(q));
  }
  // Enforce non-decreasing after rounding.
  for (let k = 1; k < 5; k++) {
    if (out[k] < out[k - 1]) out[k] = out[k - 1];
  }
  return out;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input/";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output/";
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(inputDir, file), "utf8");
    const c = parseCase(raw);
    const rows = forecastCase(c);
    const out = { trophies: rows };
    const id = file.slice(0, -3);
    fs.writeFileSync(
      path.join(outputDir, id + ".out"),
      JSON.stringify(out),
      "utf8"
    );
  }
}

main();
