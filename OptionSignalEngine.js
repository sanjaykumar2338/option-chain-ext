(function exposeOptionSignalEngine(global) {
  "use strict";

  const TREND_LOOKBACK_MS = 5 * 60 * 1000;
  const MIN_TREND_AGE_MS = 60 * 1000;
  const FORECAST_LOOKBACKS_MS = [5, 10, 15].map((minutes) => minutes * 60 * 1000);

  class OptionSignalEngine {
    analyze(marketState, history = []) {
      const normalizedMarketState = this.normalizeMarketState(marketState);
      const normalizedHistory = this.normalizeHistory(history);
      const trend = this.calculateTrend(normalizedMarketState, normalizedHistory);
      const directionalBuildUp = this.scoreDirectionalBuildUp(normalizedMarketState);

      const factors = {
        directionalBuildUp,
        pcrContext: this.scorePcrContext(normalizedMarketState, trend),
        spotTrend: this.scoreSpotTrend(trend),
        spotConfirmation: this.scoreSpotConfirmation(directionalBuildUp, trend),
        maxPain: this.scoreMaxPain(normalizedMarketState),
        ivSkew: this.scoreIvSkew(normalizedMarketState),
        gammaWall: this.calculateGammaWallScore(
          normalizedMarketState.strikes,
          normalizedMarketState.spotPrice
        ),
        vegaSkew: this.calculateVegaSkewScore(normalizedMarketState.strikes)
      };

      const rawScore = Object.values(factors).reduce((sum, value) => sum + value, 0);
      const totalScore = this.clamp(Math.round(rawScore), -100, 100);
      const signal = this.getSignal(totalScore, trend);
      const forecast = this.calculateForecast(
        totalScore,
        directionalBuildUp,
        normalizedMarketState,
        normalizedHistory,
        trend
      );

      return {
        totalScore,
        strength: Math.abs(totalScore),
        signal,
        forecast,
        factors,
        trend,
        marketState: normalizedMarketState
      };
    }

    normalizeMarketState(marketState = {}) {
      return {
        ...marketState,
        spotPrice: this.toFiniteNumber(marketState.spotPrice, NaN),
        maxPain: this.toFiniteNumber(marketState.maxPain, NaN),
        indiaVix: this.toFiniteNumber(marketState.indiaVix, NaN),
        timestamp: this.toFiniteNumber(marketState.timestamp, Date.now()),
        strikes: (marketState.strikes || []).map((row) => ({
          strike: this.toFiniteNumber(row.strike, NaN),
          call: this.normalizeSide(row.call),
          put: this.normalizeSide(row.put)
        })).filter((row) => Number.isFinite(row.strike))
      };
    }

    normalizeHistory(history) {
      return (history || [])
        .map((state) => this.normalizeMarketState(state))
        .filter((state) => Number.isFinite(state.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp);
    }

    normalizeSide(side = {}) {
      return {
        ltp: this.toFiniteNumber(side.ltp),
        ltpChangePct: this.toFiniteNumber(side.ltpChangePct),
        oiChg: this.toFiniteNumber(side.oiChg),
        oiChgPct: this.toFiniteNumber(side.oiChgPct),
        volume: this.toFiniteNumber(side.volume),
        iv: this.toFiniteNumber(side.iv),
        delta: this.toFiniteNumber(side.delta),
        gamma: this.toFiniteNumber(side.gamma),
        vega: this.toFiniteNumber(side.vega)
      };
    }

    calculateTrend(currentState, history) {
      const previousState = this.getLookbackState(currentState, history, TREND_LOOKBACK_MS);
      const currentMetrics = this.calculateMarketMetrics(currentState);

      if (!previousState) {
        return {
          hasEnoughHistory: false,
          ageMs: 0,
          spotChange: 0,
          spotChangePct: 0,
          pcrOiChange: 0,
          pcrVolumeChange: 0,
          currentPcrOi: currentMetrics.pcrOi,
          currentPcrVolume: currentMetrics.pcrVolume
        };
      }

      const previousMetrics = this.calculateMarketMetrics(previousState);
      const spotChange = currentState.spotPrice - previousState.spotPrice;
      const spotChangePct = Number.isFinite(previousState.spotPrice) && previousState.spotPrice
        ? (spotChange / previousState.spotPrice) * 100
        : 0;

      return {
        hasEnoughHistory: true,
        ageMs: currentState.timestamp - previousState.timestamp,
        spotChange,
        spotChangePct,
        pcrOiChange: this.safeDifference(currentMetrics.pcrOi, previousMetrics.pcrOi),
        pcrVolumeChange: this.safeDifference(currentMetrics.pcrVolume, previousMetrics.pcrVolume),
        currentPcrOi: currentMetrics.pcrOi,
        previousPcrOi: previousMetrics.pcrOi,
        currentPcrVolume: currentMetrics.pcrVolume,
        previousPcrVolume: previousMetrics.pcrVolume
      };
    }

    getLookbackState(currentState, history, targetLookbackMs) {
      const eligible = history.filter((state) => {
        const ageMs = currentState.timestamp - state.timestamp;
        return ageMs >= MIN_TREND_AGE_MS && ageMs <= targetLookbackMs;
      });

      if (!eligible.length) return null;

      return eligible.reduce((best, state) => {
        const bestDistance = Math.abs(currentState.timestamp - best.timestamp - targetLookbackMs);
        const stateDistance = Math.abs(currentState.timestamp - state.timestamp - targetLookbackMs);
        return stateDistance < bestDistance ? state : best;
      });
    }

    calculateSpotTrendForLookback(currentState, history, lookbackMs) {
      const previousState = this.getLookbackState(currentState, history, lookbackMs);
      if (
        !previousState ||
        !Number.isFinite(currentState.spotPrice) ||
        !Number.isFinite(previousState.spotPrice) ||
        !previousState.spotPrice
      ) {
        return {
          lookbackMs,
          hasEnoughHistory: false,
          spotChange: 0,
          spotChangePct: 0
        };
      }

      const spotChange = currentState.spotPrice - previousState.spotPrice;
      return {
        lookbackMs,
        hasEnoughHistory: true,
        ageMs: currentState.timestamp - previousState.timestamp,
        spotChange,
        spotChangePct: (spotChange / previousState.spotPrice) * 100
      };
    }

    calculateMarketMetrics(marketState) {
      const totals = marketState.strikes.reduce((sum, row) => {
        return {
          putOiChg: sum.putOiChg + Math.max(row.put.oiChg, 0),
          callOiChg: sum.callOiChg + Math.max(row.call.oiChg, 0),
          putVolume: sum.putVolume + Math.max(row.put.volume, 0),
          callVolume: sum.callVolume + Math.max(row.call.volume, 0),
          avgPutLtpChange: sum.avgPutLtpChange + row.put.ltpChangePct,
          avgCallLtpChange: sum.avgCallLtpChange + row.call.ltpChangePct
        };
      }, {
        putOiChg: 0,
        callOiChg: 0,
        putVolume: 0,
        callVolume: 0,
        avgPutLtpChange: 0,
        avgCallLtpChange: 0
      });

      const rowCount = marketState.strikes.length || 1;

      return {
        ...totals,
        avgPutLtpChange: totals.avgPutLtpChange / rowCount,
        avgCallLtpChange: totals.avgCallLtpChange / rowCount,
        pcrOi: totals.callOiChg > 0 ? totals.putOiChg / totals.callOiChg : NaN,
        pcrVolume: totals.callVolume > 0 ? totals.putVolume / totals.callVolume : NaN
      };
    }

    scoreDirectionalBuildUp(marketState) {
      if (!marketState.strikes.length) return 0;

      const strikeStep = this.estimateStrikeStep(marketState.strikes);
      const scoredRows = marketState.strikes.map((row) => {
        const distance = Number.isFinite(marketState.spotPrice)
          ? Math.abs(row.strike - marketState.spotPrice)
          : 0;
        const distanceWeight = 1 / (1 + distance / Math.max(strikeStep, 1));
        const activityWeight = Math.log1p(
          Math.abs(row.call.oiChg) +
          Math.abs(row.put.oiChg) +
          row.call.volume +
          row.put.volume
        );

        return {
          score: this.scoreSideBuildUp("call", row.call) + this.scoreSideBuildUp("put", row.put),
          weight: Math.max(activityWeight, 1) * distanceWeight
        };
      });

      const totalWeight = scoredRows.reduce((sum, row) => sum + row.weight, 0);
      if (!totalWeight) return 0;

      const weightedScore = scoredRows.reduce((sum, row) => {
        return sum + row.score * row.weight;
      }, 0) / totalWeight;

      return this.clamp(weightedScore * 18, -36, 36);
    }

    scoreSideBuildUp(sideName, side) {
      const ltpDirection = Math.sign(side.ltpChangePct);
      const oiDirection = Math.sign(side.oiChg);

      if (!ltpDirection || !oiDirection) return 0;

      if (sideName === "call") {
        if (ltpDirection > 0 && oiDirection > 0) return 1;
        if (ltpDirection < 0 && oiDirection > 0) return -1;
        if (ltpDirection > 0 && oiDirection < 0) return 0.5;
        if (ltpDirection < 0 && oiDirection < 0) return -0.5;
      }

      if (ltpDirection > 0 && oiDirection > 0) return -1;
      if (ltpDirection < 0 && oiDirection > 0) return 1;
      if (ltpDirection > 0 && oiDirection < 0) return -0.5;
      if (ltpDirection < 0 && oiDirection < 0) return 0.5;

      return 0;
    }

    scorePcrContext(marketState, trend) {
      const metrics = this.calculateMarketMetrics(marketState);
      const pcr = Number.isFinite(metrics.pcrOi) ? metrics.pcrOi : metrics.pcrVolume;

      if (!Number.isFinite(pcr)) return 0;

      let score = 0;

      if (pcr >= 1.25) {
        score += metrics.avgPutLtpChange <= 0 ? 14 : -14;
      } else if (pcr <= 0.75) {
        score += metrics.avgCallLtpChange >= 0 ? 14 : -14;
      }

      if (trend.hasEnoughHistory) {
        const pcrRising = trend.pcrOiChange > 0.12 || trend.pcrVolumeChange > 0.12;
        const pcrFalling = trend.pcrOiChange < -0.12 || trend.pcrVolumeChange < -0.12;
        const spotRising = trend.spotChangePct > 0.03;
        const spotFalling = trend.spotChangePct < -0.03;

        if (pcrRising && spotRising) score += 8;
        if (pcrRising && spotFalling) score -= 8;
        if (pcrFalling && spotFalling) score -= 8;
        if (pcrFalling && spotRising) score += 8;
      }

      return this.clamp(score, -22, 22);
    }

    scoreSpotTrend(trend) {
      if (!trend.hasEnoughHistory) return 0;

      if (trend.spotChangePct >= 0.12) return 22;
      if (trend.spotChangePct <= -0.12) return -22;
      if (trend.spotChangePct >= 0.05) return 12;
      if (trend.spotChangePct <= -0.05) return -12;
      return 0;
    }

    scoreSpotConfirmation(directionalBuildUp, trend) {
      if (!trend.hasEnoughHistory || Math.abs(directionalBuildUp) < 12) return 0;

      const bullishBuildUp = directionalBuildUp > 0;
      const bearishBuildUp = directionalBuildUp < 0;
      const spotRising = trend.spotChangePct > 0.03;
      const spotFalling = trend.spotChangePct < -0.03;

      if (bullishBuildUp && spotRising) return 16;
      if (bearishBuildUp && spotFalling) return -16;
      if (bullishBuildUp && spotFalling) return -10;
      if (bearishBuildUp && spotRising) return 10;
      return 0;
    }

    calculateForecast(totalScore, directionalBuildUp, marketState, history, trend) {
      const horizonTrends = FORECAST_LOOKBACKS_MS.map((lookbackMs) => {
        return this.calculateSpotTrendForLookback(marketState, history, lookbackMs);
      });
      const readyTrends = horizonTrends.filter((row) => row.hasEnoughHistory);

      if (!readyTrends.length) {
        return {
          key: "warming",
          label: "10-20m Forecast Warming Up",
          detail: "Collecting price history",
          score: 0,
          confidence: 0,
          horizonTrends
        };
      }

      const spotTrendScore = readyTrends.reduce((sum, row) => {
        const expectedMovePct = row.lookbackMs >= 10 * 60 * 1000 ? 0.18 : 0.12;
        return sum + this.clamp(row.spotChangePct / expectedMovePct, -1, 1) * 18;
      }, 0) / readyTrends.length;
      const alignedTrendBonus = this.calculateAlignedTrendBonus(readyTrends);
      const buildUpScore = this.clamp(directionalBuildUp * 0.45, -16, 16);
      const scoreScore = this.clamp(totalScore * 0.45, -45, 45);
      const rawForecastScore = scoreScore + spotTrendScore + alignedTrendBonus + buildUpScore;
      const forecastScore = this.clamp(Math.round(rawForecastScore), -100, 100);
      const confidence = Math.abs(forecastScore);
      const hasLongerHistory = readyTrends.some((row) => row.lookbackMs >= 10 * 60 * 1000);

      if (!hasLongerHistory && confidence < 65) {
        return {
          key: "warming",
          label: "10-20m Forecast Warming Up",
          detail: "Need more 10m history",
          score: forecastScore,
          confidence,
          horizonTrends
        };
      }

      if (forecastScore >= 45) {
        return {
          key: "bullish",
          label: "10-20m Bullish Bias",
          detail: confidence >= 70 ? "Strong upside continuation setup" : "Moderate upside bias",
          score: forecastScore,
          confidence,
          horizonTrends
        };
      }

      if (forecastScore <= -45) {
        return {
          key: "bearish",
          label: "10-20m Bearish Bias",
          detail: confidence >= 70 ? "Strong downside continuation setup" : "Moderate downside bias",
          score: forecastScore,
          confidence,
          horizonTrends
        };
      }

      return {
        key: "sideways",
        label: "10-20m Sideways / Wait",
        detail: "No clean continuation edge",
        score: forecastScore,
        confidence,
        horizonTrends
      };
    }

    calculateAlignedTrendBonus(trends) {
      const meaningfulTrends = trends.filter((row) => Math.abs(row.spotChangePct) >= 0.04);
      if (meaningfulTrends.length < 2) return 0;

      const allBullish = meaningfulTrends.every((row) => row.spotChangePct > 0);
      const allBearish = meaningfulTrends.every((row) => row.spotChangePct < 0);

      if (allBullish) return 12;
      if (allBearish) return -12;
      return 0;
    }

    scoreMaxPain(marketState) {
      if (!Number.isFinite(marketState.spotPrice) || !Number.isFinite(marketState.maxPain)) {
        return 0;
      }

      const strikeStep = this.estimateStrikeStep(marketState.strikes);
      const threshold = Math.max(strikeStep * 2, marketState.spotPrice * 0.003);
      const painDelta = marketState.spotPrice - marketState.maxPain;

      if (painDelta < -threshold) return 10;
      if (painDelta > threshold) return -10;
      return 0;
    }

    scoreIvSkew(marketState) {
      const otmCalls = marketState.strikes.filter((row) => row.strike > marketState.spotPrice);
      const otmPuts = marketState.strikes.filter((row) => row.strike < marketState.spotPrice);
      const avgCallIv = this.average(otmCalls.map((row) => row.call.iv));
      const avgPutIv = this.average(otmPuts.map((row) => row.put.iv));

      if (!Number.isFinite(avgCallIv) || !Number.isFinite(avgPutIv)) return 0;

      const ivSkew = avgPutIv - avgCallIv;
      if (ivSkew > 2.5) return -12;
      if (ivSkew > 1.2) return -6;
      if (ivSkew < -2) return 12;
      if (ivSkew < -0.9) return 6;
      return 0;
    }

    calculateGammaWallScore(strikes, spotPrice) {
      if (!strikes.length || !Number.isFinite(spotPrice)) return 0;

      const strikeStep = this.estimateStrikeStep(strikes);
      const gammaWalls = strikes.flatMap((row) => [
        {
          side: "call",
          strike: row.strike,
          gamma: Math.abs(row.call.gamma)
        },
        {
          side: "put",
          strike: row.strike,
          gamma: Math.abs(row.put.gamma)
        }
      ]);

      const maxGammaWall = gammaWalls.reduce((max, row) => {
        return row.gamma > max.gamma ? row : max;
      }, { side: null, strike: 0, gamma: 0 });

      if (!maxGammaWall.gamma) return 0;

      const distanceFromSpot = maxGammaWall.strike - spotPrice;
      if (maxGammaWall.side === "put" && distanceFromSpot < 0 && distanceFromSpot >= -strikeStep * 2) {
        return 12;
      }

      if (maxGammaWall.side === "call" && distanceFromSpot > 0 && distanceFromSpot <= strikeStep * 2) {
        return -12;
      }

      return 0;
    }

    calculateVegaSkewScore(strikes) {
      const putVegaIv = strikes.reduce((sum, row) => {
        return sum + Math.max(row.put.vega, 0) * Math.max(row.put.iv, 0);
      }, 0);
      const callVegaIv = strikes.reduce((sum, row) => {
        return sum + Math.max(row.call.vega, 0) * Math.max(row.call.iv, 0);
      }, 0);

      if (!putVegaIv && !callVegaIv) return 0;
      if (!callVegaIv) return -10;

      const vegaSkewRatio = putVegaIv / callVegaIv;
      if (vegaSkewRatio > 1.35) return -10;
      if (vegaSkewRatio < 0.75) return 10;
      return 0;
    }

    getSignal(score, trend) {
      if (score >= 50) {
        return {
          key: "call",
          label: "BUY CALL",
          detail: trend.hasEnoughHistory ? "Confirmed Bullish Momentum" : "Early Bullish Momentum",
          color: "#0f9f6e"
        };
      }

      if (score <= -50) {
        return {
          key: "put",
          label: "BUY PUT",
          detail: trend.hasEnoughHistory ? "Confirmed Bearish Momentum" : "Early Bearish Momentum",
          color: "#dc2626"
        };
      }

      return {
        key: "neutral",
        label: "NEUTRAL / WAIT",
        detail: trend.hasEnoughHistory ? "Choppy / Conflicting Data" : "Collecting Trend History",
        color: "#d97706"
      };
    }

    estimateStrikeStep(strikes) {
      const sortedStrikes = [...new Set(strikes.map((row) => row.strike))]
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

      const gaps = sortedStrikes
        .slice(1)
        .map((strike, index) => strike - sortedStrikes[index])
        .filter((gap) => gap > 0);

      return this.median(gaps) || 50;
    }

    median(values) {
      const sortedValues = values.filter(Number.isFinite).sort((a, b) => a - b);
      if (!sortedValues.length) return NaN;

      const middle = Math.floor(sortedValues.length / 2);
      if (sortedValues.length % 2) return sortedValues[middle];
      return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
    }

    average(values) {
      const finiteValues = values.filter(Number.isFinite);
      if (!finiteValues.length) return NaN;
      return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
    }

    safeDifference(currentValue, previousValue) {
      if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) return 0;
      return currentValue - previousValue;
    }

    toFiniteNumber(value, fallback = 0) {
      return Number.isFinite(value) ? value : fallback;
    }

    clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }
  }

  global.OptionSignalEngine = OptionSignalEngine;
})(globalThis);
