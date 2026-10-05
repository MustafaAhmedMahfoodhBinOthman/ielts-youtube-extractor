"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.limit = exports.MAX_CONCURRENT = void 0;
exports.activeCount = activeCount;
exports.pendingCount = pendingCount;
exports.isBusy = isBusy;
exports.tryRun = tryRun;
const p_limit_1 = __importDefault(require("p-limit"));
/**
 * Max 2 concurrent extractions. Extra requests are rejected immediately
 * with 429 busy_retry (we do NOT queue them).
 *
 * p-limit tracks activeCount/pendingCount for us. Admission MUST go through
 * `tryRun()` below: the busy-check + `limit()` dispatch happen in one
 * synchronous block (no await between), so concurrent requests cannot both
 * slip past the gate. Never call `isBusy()` and `limit()` as two separate
 * steps across an await (e.g. mkdir) — that reopens the race.
 */
exports.MAX_CONCURRENT = 2;
exports.limit = (0, p_limit_1.default)(exports.MAX_CONCURRENT);
function activeCount() {
    return exports.limit.activeCount;
}
function pendingCount() {
    return exports.limit.pendingCount;
}
function isBusy() {
    return exports.limit.activeCount + exports.limit.pendingCount >= exports.MAX_CONCURRENT;
}
/**
 * Atomic admission: returns null when 2 jobs are already admitted
 * (caller maps to 429 busy_retry), otherwise the promise of `fn`
 * dispatched through the limiter.
 */
function tryRun(fn) {
    if (exports.limit.activeCount + exports.limit.pendingCount >= exports.MAX_CONCURRENT)
        return null;
    return (0, exports.limit)(fn);
}
