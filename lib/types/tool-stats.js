import { readPetStateJson, writePetStateJson } from "./petdata.js";
/** 审计看板（2026-11-15）：按宠 × 按天 × 按工具的调用计数。
 * 每次工具调用 bump 一次（含失败——审计视角「调用过」就是行为信号）；
 * 「全部 / 最近30天」两种口径读时求和。无回填：文件从空开始，首次调用创建。 */
const DAY_MS = 86_400_000;
const localDay = (at = Date.now()) => {
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const PET_ID_RE = /^[A-Za-z0-9_-]+$/;
/** 计一次调用。fire-and-forget：不给回合加延迟，写竞态容忍度与
 * recordInteraction 同级（调用频率低，丢失一两次写入可接受）。 */
export async function bumpToolStat(home, petId, tool) {
    if (!PET_ID_RE.test(petId))
        return;
    try {
        const state = await readPetStateJson(home, petId, 'pet-tool-stats.json');
        const days = (typeof state.days === 'object' && state.days !== null ? state.days : {});
        const day = localDay();
        const bucket = { ...(days[day] ?? {}) };
        bucket[tool] = (bucket[tool] ?? 0) + 1;
        days[day] = bucket;
        await writePetStateJson(home, petId, 'pet-tool-stats.json', {
            startedAt: typeof state.startedAt === 'number' ? state.startedAt : Date.now(),
            days,
        });
    }
    catch {
        // 统计失败不影响工具调用本身
    }
}
/** 读两种口径：all = 全体求和；30d = 近 30 个本地日（含今天）。 */
export async function readToolStats(home, petId, range) {
    const empty = { startedAt: null, perTool: {}, total: 0 };
    if (!PET_ID_RE.test(petId))
        return empty;
    let startedAt = null;
    let days = {};
    try {
        const raw = await readPetStateJson(home, petId, 'pet-tool-stats.json');
        if (typeof raw.startedAt === 'number')
            startedAt = raw.startedAt;
        if (typeof raw.days === 'object' && raw.days !== null)
            days = raw.days;
    }
    catch {
        return empty;
    }
    const cutoff = range === '30d' ? Date.now() - 30 * DAY_MS : 0;
    const perTool = {};
    let total = 0;
    for (const [day, tools] of Object.entries(days)) {
        const t = Date.parse(`${day}T00:00:00`);
        if (!Number.isFinite(t) || t < cutoff)
            continue;
        for (const [tool, n] of Object.entries(tools)) {
            if (typeof n !== 'number' || !Number.isFinite(n))
                continue;
            perTool[tool] = (perTool[tool] ?? 0) + n;
            total += n;
        }
    }
    return { startedAt, perTool, total };
}
//# sourceMappingURL=tool-stats.js.map