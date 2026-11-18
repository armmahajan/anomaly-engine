/**
 * API-price cost of vision calls logged by claudeCodeVision.ts (ANOMALY_USAGE_LOG), for round 5.
 * `apiCostUsd` is Claude Code's own estimate (it prices its cache writes as 1-hour writes, 2x input);
 * `computedUsd` prices the same tokens at list rates with 5-minute cache writes (1.25x input), what a
 * direct API caller caching the same way would pay. A line without an estimate counts at computedUsd.
 */

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 * 1.25 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1 * 1.25 },
};

export interface UsageLine {
  at: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  apiCostUsd: number | null;
}

export interface UsageSummary {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Claude Code's estimate, summed (lines without one at computedUsd). */
  apiCostUsd: number;
  /** List rates, 5-minute cache writes. */
  computedUsd: number;
  /** Lines that had no Claude Code estimate. */
  missingEstimates: number;
}

export function lineCost(line: Pick<UsageLine, "input" | "cacheRead" | "cacheWrite" | "output">, price: Price): number {
  return (line.input * price.input + line.cacheRead * price.cacheRead + line.cacheWrite * price.cacheWrite + line.output * price.output) / 1e6;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function summarize(lines: UsageLine[], model: string): UsageSummary {
  const price = PRICES[model];
  if (!price) throw new Error(`no price for ${model}`);
  let [input, cacheRead, cacheWrite, output, api, computed, missing] = [0, 0, 0, 0, 0, 0, 0];
  for (const l of lines) {
    input += l.input;
    cacheRead += l.cacheRead;
    cacheWrite += l.cacheWrite;
    output += l.output;
    const c = lineCost(l, PRICES[l.model] ?? price);
    computed += c;
    if (typeof l.apiCostUsd === "number") api += l.apiCostUsd;
    else (api += c), missing++;
  }
  return { calls: lines.length, input, cacheRead, cacheWrite, output, apiCostUsd: r6(api), computedUsd: r6(computed), missingEstimates: missing };
}
