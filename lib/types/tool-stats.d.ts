export interface ToolStatsFile {
    startedAt: number;
    days: Record<string, Record<string, number>>;
}
/** 计一次调用。fire-and-forget：不给回合加延迟，写竞态容忍度与
 * recordInteraction 同级（调用频率低，丢失一两次写入可接受）。 */
export declare function bumpToolStat(home: string, petId: string, tool: string): Promise<void>;
export interface ToolStatsSummary {
    startedAt: number | null;
    perTool: Record<string, number>;
    total: number;
}
/** 读两种口径：all = 全体求和；30d = 近 30 个本地日（含今天）。 */
export declare function readToolStats(home: string, petId: string, range: 'all' | '30d'): Promise<ToolStatsSummary>;
