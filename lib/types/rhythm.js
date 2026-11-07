/**
 * Quiet-hours parsing and evaluation. Scope is deliberately minimal: quiet
 * suppresses the WORLD clock only. Self-scheduled wakes still fire (with a
 * note in the prompt), touch replies follow `allowTouchReply`, chat is never
 * gated, and the boot greeting is unchanged.
 * @module dsh-agentic-pet/rhythm
 */
import { readGlobalJson } from "./petdata.js";
/** "HH:mm" (or "H:mm") → minutes since midnight. Undefined for invalid. */
export function parseClock(value) {
    if (typeof value !== 'string')
        return undefined;
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (match === null)
        return undefined;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute))
        return undefined;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
        return undefined;
    return hour * 60 + minute;
}
/** Half-open [from, to); cross-midnight is supported. */
export function isQuietAt(date, quiet) {
    if (quiet === undefined || quiet === null)
        return false;
    const from = parseClock(quiet.from);
    const to = parseClock(quiet.to);
    if (from === undefined || to === undefined || from === to)
        return false;
    const minutes = date.getHours() * 60 + date.getMinutes();
    return from < to
        ? minutes >= from && minutes < to
        : minutes >= from || minutes < to;
}
/** Read `rhythm.quiet` from pet-settings.json; absent/null/invalid = no quiet. */
export async function readRhythmConfig(home) {
    try {
        const raw = await readGlobalJson(home, 'pet-settings.json');
        const rhythm = raw.rhythm;
        if (typeof rhythm !== 'object' || rhythm === null)
            return {};
        const quiet = rhythm.quiet;
        if (typeof quiet !== 'object' || quiet === null)
            return { quiet: null };
        const record = quiet;
        const from = typeof record.from === 'string' ? record.from : undefined;
        const to = typeof record.to === 'string' ? record.to : undefined;
        if (from === undefined || to === undefined)
            return { quiet: null };
        if (parseClock(from) === undefined || parseClock(to) === undefined)
            return { quiet: null };
        return {
            quiet: {
                from,
                to,
                allowTouchReply: record.allowTouchReply !== false,
            },
        };
    }
    catch {
        return {};
    }
}
/** B06 默认表：凌晨安静系 ×1.5、活跃系 ×0.5。 */
export const DEFAULT_IDLE_BIAS = {
    hours: [1, 6],
    weights: { 疲惫: 1.5, 待机: 1.5, 放松: 1.5, 运动: 0.5, 娱乐: 0.5, 才艺: 0.5 },
};
const isWeightTable = (value) => typeof value === 'object' && value !== null
    && Object.entries(value).every(([key, w]) => key !== '' && typeof w === 'number' && Number.isFinite(w) && w >= 0);
/** Read `rhythm.idleBias` from pet-settings.json. Absent/invalid = 默认表；
 * 显式 `null` = 关闭（渲染层均匀随机）。 */
export async function readIdleBias(home) {
    try {
        const raw = await readGlobalJson(home, 'pet-settings.json');
        const configured = raw.rhythm?.idleBias;
        if (configured === null)
            return undefined;
        if (typeof configured !== 'object' || configured === null)
            return DEFAULT_IDLE_BIAS;
        const record = configured;
        const hours = Array.isArray(record.hours)
            && record.hours.length === 2
            && record.hours.every(h => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23)
            ? [record.hours[0], record.hours[1]]
            : undefined;
        if (hours === undefined || !isWeightTable(record.weights))
            return DEFAULT_IDLE_BIAS;
        return { hours, weights: record.weights };
    }
    catch {
        return DEFAULT_IDLE_BIAS;
    }
}
//# sourceMappingURL=rhythm.js.map