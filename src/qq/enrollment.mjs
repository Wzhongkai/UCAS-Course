import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dataDirectory } from "../automation/store.mjs";
import { withFileLock } from "../automation/file-lock.mjs";
import { writeJsonAtomically } from "../automation/atomic-json.mjs";

const WINDOW_MS = 15 * 60_000;
const MAX_USER_FAILURES = 3;
const MAX_GLOBAL_FAILURES = 50;

function emptyState() {
  return { version: 1, failuresByUser: {}, globalFailures: [], reservations: {} };
}

function normalizeState(value) {
  if (!value || value.version !== 1 || typeof value !== "object") return emptyState();
  return {
    version: 1,
    failuresByUser: value.failuresByUser && typeof value.failuresByUser === "object" ? value.failuresByUser : {},
    globalFailures: Array.isArray(value.globalFailures) ? value.globalFailures : [],
    reservations: value.reservations && typeof value.reservations === "object" ? value.reservations : {}
  };
}

async function readState(stateFile) {
  try {
    return normalizeState(JSON.parse(await readFile(stateFile, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

function prune(state, now) {
  const cutoff = now - WINDOW_MS;
  state.globalFailures = state.globalFailures.filter((at) => Number.isFinite(at) && at > cutoff);
  for (const [userKey, failures] of Object.entries(state.failuresByUser)) {
    const fresh = Array.isArray(failures) ? failures.filter((at) => Number.isFinite(at) && at > cutoff) : [];
    if (fresh.length) state.failuresByUser[userKey] = fresh;
    else delete state.failuresByUser[userKey];
  }
  for (const [id, reservation] of Object.entries(state.reservations)) {
    if (!Number.isFinite(reservation?.at) || reservation.at <= cutoff || typeof reservation.userKey !== "string") {
      delete state.reservations[id];
    }
  }
}

export function createEnrollmentCoordinator({ directory = dataDirectory, clock = Date.now } = {}) {
  const stateFile = resolve(directory, "qq-enrollment.json");
  const lockFile = resolve(directory, "qq-enrollment");

  async function transact(callback) {
    return withFileLock(lockFile, async () => {
      const state = await readState(stateFile);
      const now = clock();
      prune(state, now);
      const result = await callback(state, now);
      await writeJsonAtomically(stateFile, state, { space: 0 });
      return result;
    });
  }

  function reserve(userId) {
    const userKey = userKeyOf(userId);
    return transact((state, now) => {
      const active = Object.values(state.reservations);
      const userPending = active.filter((entry) => entry.userKey === userKey).length;
      if ((state.failuresByUser[userKey]?.length ?? 0) + userPending >= MAX_USER_FAILURES) return null;
      if (state.globalFailures.length + active.length >= MAX_GLOBAL_FAILURES) return null;
      const id = randomUUID();
      state.reservations[id] = { userKey, at: now };
      return id;
    });
  }

  function finish(reservationId, failed) {
    return transact((state, now) => {
      const reservation = state.reservations[reservationId];
      if (!reservation) return false;
      delete state.reservations[reservationId];
      if (failed) {
        (state.failuresByUser[reservation.userKey] ??= []).push(now);
        state.globalFailures.push(now);
      }
      return true;
    });
  }

  function withLock(callback) {
    if (typeof callback !== "function") throw new TypeError("callback 必须是函数");
    return withFileLock(lockFile, callback);
  }

  return { reserve, finish, withLock };
}

const defaultCoordinator = createEnrollmentCoordinator();

export function reserveEnrollmentAttempt(userId) {
  return defaultCoordinator.reserve(userId);
}

export function finishEnrollmentAttempt(reservationId, failed) {
  return defaultCoordinator.finish(reservationId, failed);
}

export function withEnrollmentLock(callback) {
  return defaultCoordinator.withLock(callback);
}

function userKeyOf(userId) {
  return createHash("sha256").update(userId, "utf8").digest("hex");
}
