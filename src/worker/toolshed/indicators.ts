// Indicator maths, in one place. Every caller that needs an average, a spread,
// a z-score or a band reads it here, so a strategy template, an uploaded rule
// and the agent shell can never disagree about what the same window is worth.

/** Mean of the last `n` values. 0 for an empty series. */
export function sma(values: number[], n: number): number {
  if (values.length === 0) return 0
  const slice = values.slice(-n)
  return slice.reduce((sum, value) => sum + value, 0) / slice.length
}

/** Sample standard deviation (n−1). 0 when there are fewer than two values. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/** Exponential moving average seeded on the first value, `n` = span. */
export function ema(values: number[], n: number): number {
  if (values.length === 0) return 0
  const k = 2 / (n + 1)
  let out = values[0]
  for (let i = 1; i < values.length; i++) out = values[i] * k + out * (1 - k)
  return out
}

/**
 * RSI over the last `period` changes, 0…100.
 *
 * Average gain and average loss give the same number as the textbook RS form
 * (`100 − 100/(1 + g/l)` is `100g/(g+l)`), so this is the one RSI the folder
 * needs. A completely flat window is neutral (50) rather than the divide-by-zero
 * 100 an all-losses-free window would otherwise report.
 */
export function rsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50
  const window = prices.slice(-period - 1)
  let gain = 0
  let loss = 0
  for (let i = 1; i < window.length; i++) {
    const change = window[i] - window[i - 1]
    if (change > 0) gain += change
    else loss += -change
  }
  if (gain === 0 && loss === 0) return 50
  const avgLoss = loss / period
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + gain / period / avgLoss)
}

/** How far the last value sits from the mean, in standard deviations. Null when
 * the series is too short or flat: a z-score against zero dispersion would be
 * infinite rather than informative. */
export function zscore(values: number[]): number | null {
  if (values.length < 2) return null
  const sd = stdev(values)
  if (!(sd > 0)) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return (values[values.length - 1] - mean) / sd
}

export interface BollingerBands {
  upper: number
  middle: number
  lower: number
  /** Distance of the last value from the middle band, in standard deviations. */
  z: number
}

/** Bollinger bands around the last `period` values. Null when there is not
 * enough history to place them. */
export function bollinger(values: number[], period = 20, numStd = 2): BollingerBands | null {
  if (values.length < period) return null
  const window = values.slice(-period)
  const middle = window.reduce((sum, value) => sum + value, 0) / window.length
  const sd = stdev(window)
  const z = zscore(window) ?? 0
  return { upper: middle + numStd * sd, middle, lower: middle - numStd * sd, z }
}

/** Highest high over the last `n` bars. */
export function highestHigh(bars: { h: number }[], n: number): number {
  return Math.max(...bars.slice(-n).map((bar) => bar.h))
}

/** Lowest low over the last `n` bars. */
export function lowestLow(bars: { l: number }[], n: number): number {
  return Math.min(...bars.slice(-n).map((bar) => bar.l))
}

/** Volume's distance from its own mean in standard deviations over `n` bars. */
export function volumeZ(volumes: number[], n: number): number {
  const window = volumes.slice(-n)
  if (window.length < 2) return 0
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length
  const sd = stdev(window)
  return sd > 0 ? (window[window.length - 1] - mean) / sd : 0
}

/** Return over the last `n` bars, in percent. Null when there is no prior bar. */
export function momentum(closes: number[], n: number): number | null {
  const last = closes[closes.length - 1]
  const prior = closes[closes.length - 1 - n]
  if (last === undefined || prior === undefined) return null
  return ((last - prior) / prior) * 100
}
