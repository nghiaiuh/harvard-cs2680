export type ModelPricing = {
  name: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

export const PRICING_TABLE: Record<string, ModelPricing> = {
  // Default Codex model from config
  "gpt-5.6-luna": {
    name: "gpt-5.6-luna",
    inputPerMillion: 2.5,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 10.0,
  },
  "gpt-4o": {
    name: "gpt-4o",
    inputPerMillion: 2.5,
    cachedInputPerMillion: 1.25,
    outputPerMillion: 10.0,
  },
  "gpt-4o-mini": {
    name: "gpt-4o-mini",
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.6,
  },
  "o3-mini": {
    name: "o3-mini",
    inputPerMillion: 1.1,
    cachedInputPerMillion: 0.55,
    outputPerMillion: 4.4,
  },
  "o1": {
    name: "o1",
    inputPerMillion: 15.0,
    cachedInputPerMillion: 7.5,
    outputPerMillion: 60.0,
  },
};

export const DEFAULT_MODEL = "gpt-5.6-luna";

export type CostCalculationResult = {
  costUSD: number;
  formattedCost: string;
  model: string;
  isEstimated: boolean;
  breakdown: {
    inputCost: number;
    cachedCost: number;
    outputCost: number;
  };
};

/**
 * Calculates USD cost from token usage based on model pricing matrix.
 * Note: Non-cached input and cached input are charged at separate tier rates.
 */
export function calculateRunCost(
  usage: {
    input?: number;
    cached?: number;
    nonCached?: number;
    output?: number;
  },
  modelName: string = DEFAULT_MODEL
): CostCalculationResult {
  const modelKey = Object.keys(PRICING_TABLE).find(
    (k) => k.toLowerCase() === modelName.toLowerCase()
  ) ?? DEFAULT_MODEL;

  const pricing = PRICING_TABLE[modelKey];
  const input = usage.input ?? 0;
  const cached = usage.cached ?? 0;
  const nonCached = usage.nonCached ?? Math.max(0, input - cached);
  const output = usage.output ?? 0;

  const inputCost = (nonCached * pricing.inputPerMillion) / 1_000_000;
  const cachedCost = (cached * pricing.cachedInputPerMillion) / 1_000_000;
  const outputCost = (output * pricing.outputPerMillion) / 1_000_000;

  const totalCost = inputCost + cachedCost + outputCost;

  let formattedCost = "$0.00";
  if (totalCost >= 0.01) {
    formattedCost = `$${totalCost.toFixed(2)}`;
  } else if (totalCost > 0) {
    formattedCost = `$${totalCost.toFixed(4)}`;
  }

  return {
    costUSD: Number(totalCost.toFixed(6)),
    formattedCost,
    model: pricing.name,
    isEstimated: true, // Marked as estimated since pricing is based on public list rates
    breakdown: {
      inputCost: Number(inputCost.toFixed(6)),
      cachedCost: Number(cachedCost.toFixed(6)),
      outputCost: Number(outputCost.toFixed(6)),
    },
  };
}

