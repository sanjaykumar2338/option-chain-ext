(function exposeOptionSignalEngine(global) {
  "use strict";

  /**
   * @typedef {{ltp:number,ltpChangePct:number,oiChg:number,oiChgPct:number,volume:number,iv:number,delta:number,gamma:number,vega:number,oi?:number}} OptionSide
   * @typedef {{strike:number,call:OptionSide,put:OptionSide}} OptionStrike
   * @typedef {{stockName?:string,spotPrice:number,maxPain:number,indiaVix:number,timestamp:number,strikes:OptionStrike[]}} MarketState
   */

  const TREND_LOOKBACK_MS = 5 * 60 * 1000;
  const MIN_TREND_AGE_MS = 30 * 1000;
  const FORECAST_LOOKBACKS_MS = [5, 10, 15].map((minutes) => minutes * 60 * 1000);
  const OI_VELOCITY_WINDOW_MS = 3 * 60 * 1000;
  const OI_VELOCITY_LOOKBACKS_MS = [60 * 1000, 3 * 60 * 1000];

  class OptionSignalEngine {
    constructor() {
      this.oiHistoryByMarket = new Map();
    }

    /**
     * @param {MarketState} marketState
     * @param {MarketState[]} history
     */
    analyze(marketState, history = []) {
      const normalizedMarketState = this.normalizeMarketState(marketState);
      const normalizedHistory = this.normalizeHistory(history.filter((state) => this.marketKey(state) === this.marketKey(marketState)));
      const trend = this.calculateTrend(normalizedMarketState, normalizedHistory);
      const directionalBuildUp = this.scoreDirectionalBuildUp(normalizedMarketState);
      const oiVelocity = this.scoreOiVelocity(normalizedMarketState);

      const factors = {
        directionalBuildUp,
        oiVelocity,
        fastMomentum: this.scoreFastMomentum(normalizedMarketState, normalizedHistory),
        pcrContext: this.scorePcrContext(normalizedMarketState, trend),
        spotTrend: this.scoreSpotTrend(trend),
        spotConfirmation: this.scoreSpotConfirmation(directionalBuildUp, trend),
        maxPain: 0,
        ivSkew: 0,
        gammaWall: 0,
        vegaSkew: 0
      };

      const rawScore = Object.values(factors).reduce((sum, value) => sum + value, 0);
      const totalScore = this.clamp(Math.round(rawScore), -100, 100);
      let signal = this.getSignal(totalScore, trend);
      const dataQuality = this.assessData(marketState);
      const metrics = this.calculateMarketMetrics(normalizedMarketState);
      const candidate = signal.key === "neutral" ? null : this.selectCandidate(marketState, signal.key);
      const blockers = [...dataQuality.issues];
      if (signal.key !== "neutral" && !candidate) blockers.push("No liquid nearby contract with usable prices and Greeks");
      if (blockers.length) signal = { key: "neutral", label: "WAIT", detail: blockers[0], color: "#64748b" };
      const reasons = Object.entries(factors).filter(([, value]) => Math.abs(value) >= 3)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3)
        .map(([name, value]) => `${name.replace(/([A-Z])/g, " $1")}: ${value > 0 ? "+" : ""}${Math.round(value)}`);
      const forecast = this.calculateForecast(
        totalScore,
        directionalBuildUp,
        normalizedMarketState,
        normalizedHistory,
        trend
      );

      const result = {
        totalScore,
        strength: Math.abs(totalScore),
        signal,
        forecast,
        factors,
        dataQuality, metrics, candidate: blockers.length ? null : candidate, blockers, reasons,
        trend,
        marketState: normalizedMarketState
      };

      this.rememberOiSnapshot(normalizedMarketState);
      return result;
    }

    /**
     * @param {Partial<MarketState>} marketState
     * @returns {MarketState}
     */
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
        ...side,
        _hasCoreData: side._hasCoreData ?? ["ltp", "ltpChangePct", "oi", "oiChg", "volume"].every((key) => Number.isFinite(side[key])),
        ltp: this.toFiniteNumber(side.ltp),
        ltpChangePct: this.toFiniteNumber(side.ltpChangePct),
        oiChg: this.toFiniteNumber(side.oiChg),
        oiChgPct: this.toFiniteNumber(side.oiChgPct),
        volume: this.toFiniteNumber(side.volume),
        iv: this.toFiniteNumber(side.iv),
        delta: this.toFiniteNumber(side.delta),
        gamma: this.toFiniteNumber(side.gamma),
        vega: this.toFiniteNumber(side.vega),
        oi: this.toFiniteNumber(side.oi, NaN)
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
        return ageMs >= Math.max(MIN_TREND_AGE_MS, targetLookbackMs - 15000) && ageMs <= targetLookbackMs + 15000;
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
      const coveredRows = marketState.strikes.filter((row) => row.call._hasCoreData && row.put._hasCoreData);
      const totals = coveredRows.reduce((sum, row) => {
        return {
          callOi: sum.callOi + Math.max(this.toFiniteNumber(row.call.oi), 0),
          putOi: sum.putOi + Math.max(this.toFiniteNumber(row.put.oi), 0),
          putOiChg: sum.putOiChg + Math.max(row.put.oiChg, 0),
          callOiChg: sum.callOiChg + Math.max(row.call.oiChg, 0),
          putVolume: sum.putVolume + Math.max(row.put.volume, 0),
          callVolume: sum.callVolume + Math.max(row.call.volume, 0),
          avgPutLtpChange: sum.avgPutLtpChange + row.put.ltpChangePct,
          avgCallLtpChange: sum.avgCallLtpChange + row.call.ltpChangePct
        };
      }, {
        callOi: 0, putOi: 0,
        putOiChg: 0,
        callOiChg: 0,
        putVolume: 0,
        callVolume: 0,
        avgPutLtpChange: 0,
        avgCallLtpChange: 0
      });

      const rowCount = coveredRows.length || 1;

      return {
        ...totals,
        avgPutLtpChange: totals.avgPutLtpChange / rowCount,
        avgCallLtpChange: totals.avgCallLtpChange / rowCount,
        pcrOi: totals.callOi > 0 ? totals.putOi / totals.callOi : NaN,
        pcrOiChange: totals.callOiChg > 0 ? totals.putOiChg / totals.callOiChg : NaN,
        support: this.oiLevel(marketState, "put"),
        resistance: this.oiLevel(marketState, "call"),
        maxPain: marketState.maxPain,
        indiaVix: marketState.indiaVix,
        coveredRows: coveredRows.length,
        gammaOi: marketState.strikes.reduce((sum, row) => sum + [row.call, row.put].reduce((n, side) => n + Math.max(0, this.toFiniteNumber(side.gamma)) * Math.max(0, this.toFiniteNumber(side.oi)), 0), 0),
        pcrVolume: totals.callVolume > 0 ? totals.putVolume / totals.callVolume : NaN
      };
    }

    scoreDirectionalBuildUp(marketState) {
      if (!marketState.strikes.length) return 0;

      const strikeStep = this.estimateStrikeStep(marketState.strikes);
      const sigma = Math.max(strikeStep * 3, 1);
      const scoredRows = marketState.strikes.filter((row) => row.call._hasCoreData && row.put._hasCoreData).map((row) => {
        const atmWeight = this.calculateGaussianAtmWeight(row.strike, marketState.spotPrice, sigma);
        const activityWeight = Math.log1p(
          Math.abs(row.call.oiChg) +
          Math.abs(row.put.oiChg) +
          row.call.volume +
          row.put.volume
        );

        return {
          score: this.scoreSideBuildUp("call", row.call) + this.scoreSideBuildUp("put", row.put),
          weight: Math.max(activityWeight, 1) * atmWeight
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

    calculateGaussianAtmWeight(strike, spotPrice, sigma) {
      if (!Number.isFinite(strike) || !Number.isFinite(spotPrice) || !Number.isFinite(sigma) || sigma <= 0) {
        return 1;
      }

      const distance = strike - spotPrice;
      return Math.exp(-(distance * distance) / (2 * sigma * sigma));
    }

    rememberOiSnapshot(marketState) {
      const marketKey = this.marketKey(marketState);
      const cutoff = marketState.timestamp - OI_VELOCITY_WINDOW_MS;
      const snapshots = (this.oiHistoryByMarket.get(marketKey) || [])
        .filter((snapshot) => snapshot.timestamp >= cutoff);

      snapshots.push({
        timestamp: marketState.timestamp,
        strikes: new Map(marketState.strikes.map((row) => [
          row.strike,
          {
            callOi: Number.isFinite(row.call.oi) ? row.call.oi : NaN,
            putOi: Number.isFinite(row.put.oi) ? row.put.oi : NaN
          }
        ]))
      });

      this.oiHistoryByMarket.set(marketKey, snapshots);
    }

    getOiLookbackSnapshot(marketState, lookbackMs) {
      const marketKey = this.marketKey(marketState);
      const snapshots = this.oiHistoryByMarket.get(marketKey) || [];
      const eligible = snapshots.filter((snapshot) => {
        const ageMs = marketState.timestamp - snapshot.timestamp;
        return ageMs >= Math.max(30000, lookbackMs - 15000) && ageMs <= lookbackMs + 15000;
      });

      if (!eligible.length) return null;

      return eligible.reduce((best, snapshot) => {
        const bestDistance = Math.abs(marketState.timestamp - best.timestamp - lookbackMs);
        const snapshotDistance = Math.abs(marketState.timestamp - snapshot.timestamp - lookbackMs);
        return snapshotDistance < bestDistance ? snapshot : best;
      });
    }

    scoreOiVelocity(marketState) {
      if (!marketState.strikes.length) return 0;

      const lookbackSnapshots = OI_VELOCITY_LOOKBACKS_MS
        .map((lookbackMs) => ({
          lookbackMs,
          snapshot: this.getOiLookbackSnapshot(marketState, lookbackMs)
        }))
        .filter((entry) => entry.snapshot);

      if (!lookbackSnapshots.length) return 0;

      const strikeStep = this.estimateStrikeStep(marketState.strikes);
      const sigma = Math.max(strikeStep * 3, 1);
      const weightedScores = marketState.strikes.map((row) => {
        const atmWeight = this.calculateGaussianAtmWeight(row.strike, marketState.spotPrice, sigma);
        const rowScore = lookbackSnapshots.reduce((sum, entry) => {
          const previous = entry.snapshot.strikes.get(row.strike);
          if (!previous) return sum;

          const minutes = (marketState.timestamp - entry.snapshot.timestamp) / 60000;
          const callVelocity = this.calculateSideOiVelocity(row.call.oi, previous.callOi, minutes);
          const putVelocity = this.calculateSideOiVelocity(row.put.oi, previous.putOi, minutes);
          const callScore = this.scoreVelocitySide("call", row.call, callVelocity);
          const putScore = this.scoreVelocitySide("put", row.put, putVelocity);
          return sum + ((callScore + putScore) / lookbackSnapshots.length);
        }, 0);

        return {
          score: rowScore,
          weight: atmWeight
        };
      });

      const totalWeight = weightedScores.reduce((sum, row) => sum + row.weight, 0);
      if (!totalWeight) return 0;

      const weightedScore = weightedScores.reduce((sum, row) => {
        return sum + row.score * row.weight;
      }, 0) / totalWeight;

      return this.clamp(weightedScore, -18, 18);
    }

    calculateSideOiVelocity(currentOi, previousOi, minutes) {
      if (!Number.isFinite(currentOi) || !Number.isFinite(previousOi) || minutes <= 0) return 0;
      return (currentOi - previousOi) / minutes;
    }

    scoreVelocitySide(sideName, side, velocityPerMinute) {
      if (!Number.isFinite(velocityPerMinute) || velocityPerMinute <= 0) return 0;

      const baseOi = Number.isFinite(side.oi) && side.oi > 0 ? side.oi : Math.abs(side.oiChg);
      const relativeVelocity = baseOi > 0 ? (velocityPerMinute / baseOi) * 100 : 0;
      const intensity = this.clamp(Math.log1p(Math.max(relativeVelocity, 0)) * 4, 0, 9);
      const priceDirection = Math.sign(side.ltpChangePct);

      if (sideName === "call") {
        return priceDirection >= 0 ? intensity : -intensity * 0.75;
      }

      return priceDirection >= 0 ? -intensity : intensity * 0.75;
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
      const hasLongerHistory = readyTrends.some((row) => row.ageMs >= 8 * 60 * 1000);

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

    marketKey(state) {
      return state.marketKey || `${state.underlyingKey || state.stockName || "chain"}|${state.expiry || ""}`;
    }

    assessData(state) {
      const required = ["ltp", "ltpChangePct", "oi", "oiChg", "volume"];
      const validRows = (state.strikes || []).filter((row) => [row.call, row.put].every((side) =>
        side && required.every((key) => Number.isFinite(side[key])) && side.ltp > 0 && side.oi >= 0 && side.volume >= 0));
      const issues = [];
      if (!(state.spotPrice > 0)) issues.push("Waiting for the selected chain's spot price");
      if (validRows.length < 3) issues.push("Need at least 3 paired strikes with price, OI, changes and volume");
      if (Number.isFinite(state.dataUpdatedAt) && state.timestamp - state.dataUpdatedAt > 30000) issues.push("Data unchanged for over 30 seconds; waiting for a fresh quote");
      if (state.hasObservedChange === false) issues.push("Waiting for a live price/OI update");
      if (state.expiry && state.expiry < new Date(state.timestamp + 19800000).toISOString().slice(0, 10)) issues.push("Selected expiry has passed");
      if (state.sessionOpen === false) issues.unshift("Outside the regular trading session");
      if (state.sessionOpen !== undefined && !state.expiry) issues.unshift("Select an expiry before using trade signals");
      const warnings = [];
      if (!state.expiry) warnings.push("Expiry unavailable");
      if (!Number.isFinite(state.indiaVix)) warnings.push("India VIX unavailable");
      if (!Number.isFinite(state.maxPain)) warnings.push("Max pain unavailable");
      return { ready: !issues.length, issues, warnings, validRows: validRows.length,
        loadedRows: (state.strikes || []).length,
        score: Math.round(100 * validRows.length / Math.max(1, (state.strikes || []).length)) };
    }

    oiLevel(state, side) {
      const rows = state.strikes.filter((row) => Number.isFinite(row[side].oi)
        && (side === "put" ? row.strike <= state.spotPrice : row.strike >= state.spotPrice));
      const best = rows.reduce((best, row) => !best || row[side].oi > best[side].oi ? row : best, null);
      return best ? { strike: best.strike, oi: best[side].oi } : null;
    }

    scoreFastMomentum(state, history) {
      const prior = history.filter((row) => state.timestamp - row.timestamp >= 30000 && state.timestamp - row.timestamp <= 75000).at(-1);
      if (!prior || !(prior.spotPrice > 0)) return 0;
      const move = (state.spotPrice / prior.spotPrice - 1) * 100;
      const vix = state.indiaVix > 0 ? state.indiaVix : 15;
      const threshold = Math.max(0.02, vix / 500);
      let score = this.clamp(move / threshold, -1, 1) * 16;
      const oldRows = new Map(prior.strikes.map((row) => [row.strike, row]));
      let confirming = 0, comparable = 0;
      for (const row of state.strikes) {
        if (Math.abs(row.strike - state.spotPrice) > this.estimateStrikeStep(state.strikes) * 3) continue;
        const old = oldRows.get(row.strike);
        if (!old) continue;
        for (const side of ["call", "put"]) {
          const current = row[side], previous = old[side];
          if (!(previous.ltp > 0) || !Number.isFinite(previous.oi) || !Number.isFinite(current.oi)) continue;
          comparable++;
          const direction = side === "call" ? 1 : -1;
          if (current.ltp > previous.ltp && current.oi > previous.oi && current.volume > previous.volume) confirming += direction;
        }
      }
      if (comparable) score += this.clamp(confirming / comparable * 2, -1, 1) * 12;
      return Math.round(score);
    }

    selectCandidate(state, side) {
      const step = this.estimateStrikeStep(state.strikes);
      const candidates = [];
      for (const row of state.strikes) {
        const quote = row[side];
        if (!quote || !(quote.ltp > 0.05) || !(quote.oi > 0) || !(quote.volume > 0)
          || Math.abs(row.strike - state.spotPrice) > step * 3) continue;
        if (Number.isFinite(quote.delta) && (Math.abs(quote.delta) < 0.15 || Math.abs(quote.delta) > 0.9 || Math.sign(quote.delta) !== (side === "call" ? 1 : -1))) continue;
        if (Number.isFinite(quote.iv) && (quote.iv <= 0 || quote.iv >= 300)) continue;
        if (Number.isFinite(quote.theta) && Math.abs(quote.theta) > quote.ltp * 5) continue;
        if ((Number.isFinite(quote.gamma) && quote.gamma < 0) || (Number.isFinite(quote.vega) && quote.vega < 0)) continue;
        if ((Number.isFinite(quote.askQty) && quote.askQty <= 0) || (Number.isFinite(quote.bidQty) && quote.bidQty <= 0)) continue;
        if ((Number.isFinite(quote.bidPrice) && quote.bidPrice <= 0)
          || (Number.isFinite(quote.askPrice) && quote.askPrice <= 0)) continue;
        let spreadPct = NaN;
        if (Number.isFinite(quote.bidPrice) && Number.isFinite(quote.askPrice)) {
          if (!(quote.bidPrice > 0) || quote.askPrice < quote.bidPrice) continue;
          spreadPct = (quote.askPrice - quote.bidPrice) / ((quote.askPrice + quote.bidPrice) / 2) * 100;
          if (spreadPct > 10) continue;
        }
        const warnings = ["delta", "iv", "theta", "gamma", "vega"].filter((key) => !Number.isFinite(quote[key])).map((key) => `${key} unavailable`);
        if (!Number.isFinite(spreadPct)) warnings.push("Bid/ask spread unavailable");
        const thetaCostPct = Number.isFinite(quote.theta) ? Math.abs(quote.theta) / quote.ltp * 100 : NaN;
        const rank = Math.abs(row.strike - state.spotPrice) / step
          + (Number.isFinite(quote.delta) ? Math.abs(Math.abs(quote.delta) - 0.5) * 2 : 1)
          + (Number.isFinite(spreadPct) ? spreadPct / 10 : 0.5);
        const move = state.spotPrice * 0.01;
        const sensitivity = {
          deltaForOnePercent: Number.isFinite(quote.delta) ? quote.delta * move : NaN,
          gammaForOnePercent: Number.isFinite(quote.gamma) ? 0.5 * quote.gamma * move * move : NaN,
          vegaPerVolPoint: quote.vega,
          thetaPerDay: quote.theta
        };
        candidates.push({ ...quote, side, strike: row.strike, spreadPct, thetaCostPct, sensitivity, warnings, rank });
      }
      return candidates.sort((a, b) => a.rank - b.rank || b.volume - a.volume)[0] || null;
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
