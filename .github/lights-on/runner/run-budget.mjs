import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadState, saveState, checkBudgetAndRateLimits, recordAttempt, recordUsage } from './state-store.mjs';

async function locked(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { fd = fs.openSync(lock, 'wx'); break; }
    catch (err) { if (err.code !== 'EEXIST') throw err; await delay(50); }
  }
  if (fd === undefined) throw new Error('Usage state is locked; refusing unreserved inference. Inspect any interrupted local run before clearing its lock.');
  try {
    // State corruption must not reset spending protection to zero.
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.usage_history)) throw new Error('Invalid usage state; refusing inference.');
    }
    const state = loadState({ stateFile: file });
    return action(state);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export async function reserveAgentRun({ stateFile, config, task, itemKey, now = Date.now() }) {
  return locked(stateFile, (state) => {
    const check = checkBudgetAndRateLimits(state, config, { task, itemKey, now });
    if (!check.allowed) return { allowed: false, ...check };
    const reserved = Math.max(0, Number(config.limits?.max_cost_per_run_usd) || 0);
    const daily = config.limits?.max_daily_budget_usd;
    if (typeof daily === 'number' && check.details.budgetAccountedUsd + reserved > daily) {
      return { allowed: false, reason: 'daily-budget-reservation-exceeded', details: check.details };
    }
    const id = crypto.randomUUID();
    const record = recordUsage(state, { task, outcome: 'reserved', now });
    record.reservation_id = id;
    record.reserved_cost_usd = reserved;
    if (itemKey) recordAttempt(state, itemKey, { task });
    saveState(state, { stateFile });
    return { allowed: true, id };
  });
}

export async function settleAgentRun({ stateFile, id, task, usage, outcome }) {
  return locked(stateFile, (state) => {
    const index = state.usage_history.findIndex((entry) => entry.reservation_id === id);
    if (index === -1) throw new Error('Missing usage reservation; refusing to discard accounting.');
    const reservation = state.usage_history[index];
    const holder = { usage_history: [] };
    const final = recordUsage(holder, { task, usage, outcome, now: Date.parse(reservation.at) });
    state.usage_history[index] = { ...final, reservation_id: id,
      // Unknown USD is not zero: keep the conservative allocation for 24h.
      reserved_cost_usd: final.cost_usd === null ? reservation.reserved_cost_usd : 0 };
    saveState(state, { stateFile });
  });
}
