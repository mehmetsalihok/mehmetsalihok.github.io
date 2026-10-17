"use strict";
// KUZGUN PRO — HIGH PERFORMANCE PORTFOLIO & TIMEFRAME ENGINE
const PortfolioEngine = {
    // 1. ⚡️ ALTIN STANDART SLOT ÇAKIŞMA KALKANI (0.1 Milisaniyede Tamamlanır)
    filterTradesBySlotCapacity(rawTrades, maxSlots, activePositions = []) {
        if (!maxSlots || maxSlots <= 0 || !rawTrades || rawTrades.length === 0) return rawTrades;

        // Aynı anda başlayan gerçek işlemler, simüle işlemlerden önce değerlendirilir.
        // Açık pozisyonları gerçek giriş anında başlayan slot olayları olarak ekle.
        // Böylece girişten önce kapanan geçmiş işlemler etkilenmez.
        const openEvents = activePositions.filter(pos => Number(pos.entryTime) > 0)
            .map(pos => ({entryTime: Number(pos.entryTime), exitTime: Infinity,
                source: 'automatic', isOpenSlotEvent: true}));
        const sorted = [...rawTrades, ...openEvents].sort((a, b) => a.entryTime - b.entryTime ||
            (b.source === 'manual' || b.source === 'automatic') - (a.source === 'manual' || a.source === 'automatic'));
        const slotsCount = Math.max(1, maxSlots);
        const occupied = [];

        const acceptedTrades = [];

        for (let i = 0; i < sorted.length; i++) {
            const trade = sorted[i];
            const entry = trade.entryTime;
            const exit = Math.max(trade.exitTime, trade.entryTime + 60000);
            const isReal = trade.source === 'manual' || trade.source === 'automatic';

            for (let s = occupied.length - 1; s >= 0; s--) {
                if (occupied[s].exit <= entry) occupied.splice(s, 1);
            }

            if (occupied.length >= slotsCount && isReal) {
                // Geçmişte gerçekten açılmış işlem, çakışan bir simülasyon
                // yüzünden kayıttan veya portföy hesabından silinemez.
                const simulatedIndex = occupied.findIndex(item => !item.isReal);
                if (simulatedIndex !== -1) {
                    occupied[simulatedIndex].accepted.active = false;
                    occupied.splice(simulatedIndex, 1);
                }
            }

            if (isReal || occupied.length < slotsCount) {
                const accepted = { trade, active: true };
                if (!trade.isOpenSlotEvent) acceptedTrades.push(accepted);
                occupied.push({ exit, isReal, accepted });
            }
        }

        // En güncel işlem en üstte olacak şekilde sırala
        return acceptedTrades.filter(item => item.active).map(item => item.trade)
            .sort((a, b) => b.exitTime - a.exitTime);
    },

    // 2. BİLEŞİK BAKİYE & KOMİSYON MOTORU
    calculateCompoundedBalance({
        baseBalance = 1000.0,
        maxSlots = 2,
        trades = [],
        activePositions = [],
        coins = [],
        isSlotConstraintEnabled = true,
        isFeeDeductionEnabled = true,
        startDateTimestamp = 0,
        selectedYear = '2026'
    }) {
        const processedTrades = isSlotConstraintEnabled 
            ? this.filterTradesBySlotCapacity(trades, maxSlots, activePositions)
            : [...trades].sort((a, b) => a.exitTime - b.exitTime);

        // Slota kabul edilen işlemlerin ID kümesi
        const acceptedTradeIds = new Set(processedTrades.map(t => t.id));

        const yearInt = parseInt(selectedYear, 10) || 2026;
        const defaultYearStartSec = new Date(Date.UTC(yearInt, 0, 1, 0, 0, 0)).getTime() / 1000;
        const effectiveStartSec = startDateTimestamp > 0 ? startDateTimestamp : defaultYearStartSec;

        const validTrades = processedTrades
            .filter(t => (t.exitTime / 1000) >= effectiveStartSec)
            .sort((a, b) => a.exitTime - b.exitTime);

        let runningBalance = baseBalance;
        const slotsCount = Math.max(1, maxSlots);
        let totalFeesAccumulated = 0;
        const executedTrades = [];

        // Coin bazlı slota giren reel istatistikler
        const coinRealStats = {};

        for (const trade of validTrades) {
            const slotBudget = runningBalance / slotsCount;

            const buyFee = isFeeDeductionEnabled ? (slotBudget * 0.00075) : 0.0;
            const exitValue = slotBudget * (1.0 + (trade.pnlPercent / 100.0));
            const sellFee = isFeeDeductionEnabled ? (exitValue * 0.00075) : 0.0;
            const totalFee = buyFee + sellFee;
            totalFeesAccumulated += totalFee;

            const rawGainUSD = slotBudget * (trade.pnlPercent / 100.0);
            const netGainUSD = rawGainUSD - totalFee;
            runningBalance += netGainUSD;

            const effectivePnl = slotBudget > 0 ? (netGainUSD / slotBudget) * 100.0 : trade.pnlPercent;

            executedTrades.push({
                ...trade,
                positionSizeUSD: slotBudget,
                netGainUSD: netGainUSD,
                effectivePnl: effectivePnl,
                feeUSD: totalFee
            });

            if (!coinRealStats[trade.coinId]) {
                coinRealStats[trade.coinId] = { totalTrades: 0, totalPnl: 0, monthly: {} };
            }
            coinRealStats[trade.coinId].totalTrades++;
            coinRealStats[trade.coinId].totalPnl += trade.pnlPercent;

            const mKey = trade.monthKey || new Date(trade.exitTime).toISOString().slice(0, 7);
            if (!coinRealStats[trade.coinId].monthly[mKey]) {
                coinRealStats[trade.coinId].monthly[mKey] = { trades: 0, pnl: 0 };
            }
            coinRealStats[trade.coinId].monthly[mKey].trades++;
            coinRealStats[trade.coinId].monthly[mKey].pnl += trade.pnlPercent;
        }

        let unrealizedPnlUSD = 0;
        const currentSlotBudget = runningBalance / slotsCount;

        activePositions.forEach(pos => {
            const coin = coins.find(c => c.id === pos.coinId || c.symbol === pos.symbol);
            const currentPrice = coin && coin.price > 0 ? coin.price : pos.entryPrice;
            const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100.0;
            const positionBudget = Number(pos.allocatedUsd) > 0 ? Number(pos.allocatedUsd) : currentSlotBudget;
            unrealizedPnlUSD += positionBudget * (pnlPercent / 100.0);
        });

        const totalCompoundedBalance = runningBalance + unrealizedPnlUSD;

        return {
            compoundedBalance: totalCompoundedBalance,
            realizedBalance: runningBalance,
            unrealizedPnlUSD: unrealizedPnlUSD,
            totalFeesUSD: totalFeesAccumulated,
            executedTrades: executedTrades.sort((a, b) => b.exitTime - a.exitTime),
            acceptedTradeIds: acceptedTradeIds,
            coinRealStats: coinRealStats
        };
    },

    // 3. DİNAMİK ZAMAN DİLİMİ İSTATİSTİKLERİ
    calculateTimeframeStats({
        executedTrades = [],
        timeframe = 'sinceStart',
        selectedMonthIndex = new Date().getMonth() + 1,
        selectedYear = '2026',
        startDateTimestamp = 0,
        customStartDate = null,
        customEndDate = null,
        initialBalance = 1000.0,
        unrealizedPnlUSD = 0
    }) {
        if (!initialBalance || initialBalance <= 0) {
            return { usdtGain: 0, realizedUsdtGain: 0, includeUnrealized: false, directTradePnlSum: 0, netTradePnlSum: 0, initialPnlPercentage: 0, totalFeesUSD: 0, tradesCount: 0 };
        }

        const now = new Date();
        let startMs = 0;
        let endMs = now.getTime();

        const getStartOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).getTime();

        switch (timeframe) {
            case 'sinceStart': {
                const yearInt = parseInt(selectedYear, 10) || 2026;
                const defaultYearStartMs = new Date(Date.UTC(yearInt, 0, 1, 0, 0, 0)).getTime();
                startMs = startDateTimestamp > 0 ? (startDateTimestamp * 1000) : defaultYearStartMs;
                break;
            }
            case 'today':
                startMs = getStartOfDay(now);
                break;
            case 'week': {
                const day = now.getDay();
                const diff = (day === 0 ? -6 : 1) - day;
                const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 0, 0, 0);
                startMs = startOfWeek.getTime();
                break;
            }
            case 'month':
                startMs = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0).getTime();
                break;
            case 'selectMonth': {
                const yearInt = parseInt(selectedYear, 10) || 2026;
                const mIdx = parseInt(selectedMonthIndex, 10) - 1;
                startMs = new Date(yearInt, mIdx, 1, 0, 0, 0).getTime();
                endMs = new Date(yearInt, mIdx + 1, 0, 23, 59, 59, 999).getTime();
                break;
            }
            case 'custom':
                if (customStartDate && customEndDate) {
                    startMs = new Date(customStartDate).setHours(0, 0, 0, 0);
                    endMs = new Date(customEndDate).setHours(23, 59, 59, 999);
                } else {
                    startMs = getStartOfDay(now);
                }
                break;
            default:
                startMs = startDateTimestamp > 0 ? (startDateTimestamp * 1000) : getStartOfDay(now);
        }

        const filtered = executedTrades.filter(t => t.exitTime >= startMs && t.exitTime <= endMs);

        let usdtGain = 0;
        let directTradePnlSum = 0;
        let netTradePnlSum = 0;
        let totalFeesUSD = 0;

        for (const t of filtered) {
            usdtGain += (t.netGainUSD !== undefined) ? t.netGainUSD : (t.positionSizeUSD * (t.pnlPercent / 100));
            directTradePnlSum += t.pnlPercent;
            netTradePnlSum += (t.effectivePnl !== undefined) ? t.effectivePnl : t.pnlPercent;
            totalFeesUSD += (t.feeUSD || 0);
        }

        const realizedUsdtGain = usdtGain;
        const includeUnrealized = now.getTime() >= startMs && now.getTime() <= endMs;
        if (includeUnrealized) usdtGain += Number(unrealizedPnlUSD || 0);

        const initialPnlPercentage = (usdtGain / initialBalance) * 100.0;

        return {
            usdtGain,
            realizedUsdtGain,
            includeUnrealized,
            directTradePnlSum,
            netTradePnlSum,
            initialPnlPercentage,
            totalFeesUSD,
            tradesCount: filtered.length
        };
    }
};

const monthNames = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
        function getTurkeyDateComponents(timestampMs) {
            const d = new Date(timestampMs);
            const str = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
            return {
                monthKey: str.slice(0, 7),
                day: parseInt(str.slice(8, 10), 10)
            };
        }
        function calculateRSIHistory(prices, period = 14) {
            const rsiValues = new Array(prices.length).fill(null);
            if (prices.length <= period) return rsiValues;

            let gains = 0, losses = 0;
            for (let i = 1; i <= period; i++) {
                const diff = prices[i] - prices[i - 1];
                if (diff >= 0) gains += diff; else losses += Math.abs(diff);
            }

            let avgGain = gains / period;
            let avgLoss = losses / period;
            rsiValues[period] = avgLoss === 0 ? 100.0 : 100.0 - (100.0 / (1.0 + avgGain / avgLoss));

            for (let i = period + 1; i < prices.length; i++) {
                const diff = prices[i] - prices[i - 1];
                const gain = diff >= 0 ? diff : 0;
                const loss = diff < 0 ? Math.abs(diff) : 0;

                avgGain = (avgGain * (period - 1) + gain) / period;
                avgLoss = (avgLoss * (period - 1) + loss) / period;

                if (avgLoss === 0) {
                    rsiValues[i] = 100.0;
                } else {
                    const rs = avgGain / avgLoss;
                    rsiValues[i] = 100.0 - (100.0 / (1.0 + rs));
                }
            }
            return rsiValues;
        }
        function simulateSingleConfig(candles, rsiLength, buyRsi, sellRsi, profitTarget, monthlyCap) {
            const closePrices = candles.map(c => c.close);
            const rsiVals = calculateRSIHistory(closePrices, rsiLength);
            
            let inPos = false, entryP = 0, entryT = 0;
            let totPnl = 0, winCount = 0, totalTrades = 0;
            let totalHoldSeconds = 0;
            let monthlyMap = {};
            const tradeLogs = [];

            for (let i = rsiLength + 1; i < candles.length; i++) {
                const c = candles[i];
                const rsi = rsiVals[i];
                const prevRsi = rsiVals[i - 1];
                if (rsi === null || prevRsi === null) continue;

                const mKey = c.monthKey;
                if (!monthlyMap[mKey]) monthlyMap[mKey] = { pnl: 0, isLocked: false };
                const isCapReached = (monthlyMap[mKey].pnl + 0.001) >= monthlyCap;

                if (!inPos && !isCapReached) {
                    if (prevRsi <= buyRsi && rsi > buyRsi) {
                        inPos = true;
                        entryP = c.close;
                        entryT = c.time;
                    }
                } else if (inPos) {
                    const targetP = entryP * (1.0 + profitTarget / 100.0);
                    let exited = false, pnl = 0;

                    if (c.high >= targetP) {
                        exited = true;
                        pnl = profitTarget;
                    } else if (rsi >= sellRsi) {
                        exited = true;
                        pnl = ((c.close - entryP) / entryP) * 100.0;
                    }

                    if (exited) {
                        inPos = false;
                        totalTrades++;
                        if (pnl >= 0) winCount++;
                        totPnl += pnl;

                        monthlyMap[mKey].pnl += pnl;
                        if ((monthlyMap[mKey].pnl + 0.001) >= monthlyCap) {
                            monthlyMap[mKey].isLocked = true;
                        }

                        const diffSec = Math.max(0, Math.floor((c.time - entryT) / 1000));
                        totalHoldSeconds += diffSec;

                        tradeLogs.push({
                            entryTime: entryT,
                            exitTime: c.time,
                            entryPrice: entryP,
                            exitPrice: c.high >= targetP ? targetP : c.close,
                            reason: c.high >= targetP ? 'Kâr hedefi' : 'RSI satışı',
                            pnl: pnl,
                            monthKey: mKey
                        });
                    }
                }
            }

            const winRateVal = totalTrades > 0 ? (winCount / totalTrades) * 100.0 : 0.0;
            const avgSec = totalTrades > 0 ? Math.floor(totalHoldSeconds / totalTrades) : 0;
            const avgHours = avgSec / 3600.0;
            const avgDurationStr = avgHours < 1.0 ? `${Math.max(15, Math.floor(avgHours * 60))}dk` : `${avgHours.toFixed(1)}sa`;

            const groupedByMonth = {};
            tradeLogs.forEach(t => {
                if (!groupedByMonth[t.monthKey]) groupedByMonth[t.monthKey] = [];
                groupedByMonth[t.monthKey].push(t);
            });

            const sortedMonthKeys = Object.keys(groupedByMonth).sort((a, b) => b.localeCompare(a));
            const monthlyRecords = [];
            let totalLockDaysSum = 0;
            let lockedMonthCount = 0;

            for (const mKey of sortedMonthKeys) {
                const monthTrades = groupedByMonth[mKey].sort((a, b) => a.entryTime - b.entryTime);
                if (monthTrades.length === 0) continue;

                const firstTrade = monthTrades[0];
                const firstDay = getTurkeyDateComponents(firstTrade.entryTime).day;

                let runningPnl = 0.0;
                let lockDay = null;
                let daysToLock = null;
                let isLocked = false;

                for (const t of monthTrades) {
                    runningPnl += t.pnl;
                    if ((runningPnl + 0.001) >= monthlyCap && !isLocked) {
                        isLocked = true;
                        const lDay = getTurkeyDateComponents(t.exitTime).day;
                        lockDay = lDay;
                        daysToLock = Math.max(1, lDay - firstDay + 1);
                        totalLockDaysSum += daysToLock;
                        lockedMonthCount++;
                    }
                }

                const mIdx = parseInt(mKey.split('-')[1], 10) - 1;
                const mTitle = monthNames[Math.max(0, Math.min(11, mIdx))];

                monthlyRecords.push({
                    monthKey: mKey,
                    monthName: mTitle,
                    firstTradeDay: firstDay,
                    lockDay: lockDay,
                    daysToLock: daysToLock,
                    totalMonthPnl: runningPnl,
                    isLocked: isLocked
                });
            }

            const avgDays = lockedMonthCount > 0 ? (totalLockDaysSum / lockedMonthCount).toFixed(1) : null;
            const ratioStr = `${lockedMonthCount}/${Math.max(1, monthlyRecords.length)} Ay`;

            return {
                rsiLength,
                buyRsi,
                sellRsi,
                winRate: `${winRateVal.toFixed(0)}%`,
                winRateDouble: winRateVal,
                avgDurationFormatted: avgDurationStr,
                totalTrades,
                winCount,
                lossCount: totalTrades - winCount,
                tradeLogs,
                openPosition: inPos ? {entryTime: entryT, entryPrice: entryP} : null,
                netPnl: totPnl,
                monthlyBreakdowns: monthlyRecords,
                avgDaysToLock: avgDays,
                lockedMonthsRatio: ratioStr
            };
        }
        function evaluateBestRsi(candles, rsiLength, profitTarget, monthlyCap) {
            const closePrices = candles.map(c => c.close);
            const rsiVals = calculateRSIHistory(closePrices, rsiLength);
            let bestCandidate = null;

            for (let buy = 10; buy <= 35; buy += 1) {
                for (let sell = 65; sell <= 92; sell += 1) {
                    let inPos = false, entryP = 0, totPnl = 0, winCount = 0, totalTrades = 0;
                    let monthlyStats = {};

                    for (let i = rsiLength + 1; i < candles.length; i++) {
                        const c = candles[i];
                        const rsi = rsiVals[i];
                        const prevRsi = rsiVals[i - 1];
                        if (rsi === null || prevRsi === null) continue;

                        const mKey = c.monthKey;
                        if (!monthlyStats[mKey]) monthlyStats[mKey] = { pnl: 0 };
                        const isCapReached = (monthlyStats[mKey].pnl + 0.001) >= monthlyCap;

                        if (!inPos && !isCapReached) {
                            if (prevRsi <= buy && rsi > buy) {
                                inPos = true;
                                entryP = c.close;
                            }
                        } else if (inPos) {
                            const targetP = entryP * (1.0 + profitTarget / 100.0);
                            let exited = false, pnl = 0;

                            if (c.high >= targetP) {
                                exited = true;
                                pnl = profitTarget;
                            } else if (rsi >= sell) {
                                exited = true;
                                pnl = ((c.close - entryP) / entryP) * 100.0;
                            }

                            if (exited) {
                                inPos = false;
                                totalTrades++;
                                if (pnl >= 0) winCount++;
                                totPnl += pnl;
                                monthlyStats[mKey].pnl += pnl;
                            }
                        }
                    }

                    if (totalTrades >= 1) {
                        const winRate = (winCount / totalTrades) * 100.0;
                        const score = totPnl * Math.pow(winRate / 100.0, 1.5);
                        if (!bestCandidate || score > bestCandidate.score) {
                            bestCandidate = { buyRsi: buy, sellRsi: sell, score };
                        }
                    }
                }
            }

            const chosenBuy = bestCandidate ? bestCandidate.buyRsi : 25;
            const chosenSell = bestCandidate ? bestCandidate.sellRsi : 75;
            return simulateSingleConfig(candles, rsiLength, chosenBuy, chosenSell, profitTarget, monthlyCap);
        }

const TF_MS = {'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000};
function report(message, detail='') { self.postMessage({type:'progress',message,detail}); }
async function fetchCandles(symbol, interval, start, end) {
    const endpoints=['https://data-api.binance.vision/api/v3/klines','https://api.binance.com/api/v3/klines'];
    let cursor=start, records=[];
    while(cursor<end) {
        let batch=null,lastError='Bağlantı kurulamadı';
        for(const endpoint of endpoints) {
            const controller=new AbortController();
            const timer=setTimeout(()=>controller.abort(),15000);
            try {
                const params=new URLSearchParams({symbol,interval,startTime:String(cursor),endTime:String(end-1),limit:'1000'});
                const response=await fetch(endpoint+'?'+params,{signal:controller.signal});
                if(!response.ok) throw new Error('HTTP '+response.status);
                const data=await response.json();
                if(!Array.isArray(data)) throw new Error('Geçersiz veri');
                batch=data;break;
            } catch(error) {lastError=error.message} finally {clearTimeout(timer)}
        }
        if(!batch) throw new Error(symbol+'/'+interval+': '+lastError);
        if(!batch.length) break;
        let next=Number(batch.at(-1)[0])+TF_MS[interval];
        if(next<=cursor) throw new Error('Mum verisi ilerlemiyor');
        for(const row of batch) {
            const time=Number(row[0]);
            if(time+TF_MS[interval]>end) continue;
            const open=Number(row[1]),high=Number(row[2]),low=Number(row[3]),close=Number(row[4]);
            if(![time,open,high,low,close].every(Number.isFinite)||close<=0) throw new Error('Geçersiz fiyat');
            records.push({time,open,high,low,close,monthKey:getTurkeyDateComponents(time).monthKey});
        }
        cursor=next;
        report('Mum verileri alınıyor',`${symbol} / ${interval} · ${records.length.toLocaleString('tr-TR')} mum`);
        if(batch.length<1000) break;
    }
    return [...new Map(records.map(c=>[c.time,c])).values()].sort((a,b)=>a.time-b.time);
}
function makeCandidate(coin, strategy, interval, config, key, current=false) {
    const ms=TF_MS[interval];
    const trades=strategy.tradeLogs.map((trade,index)=>({...trade,
        id:`${coin.symbol}_${key}_${index}`,coinId:coin.id,symbol:coin.symbol,
        entryTime:trade.entryTime+ms,exitTime:trade.exitTime+ms,pnlPercent:trade.pnl,
        monthKey:getTurkeyDateComponents(trade.exitTime+ms).monthKey
    })).filter(trade=>trade.entryTime>=config.start && trade.exitTime<=config.end);
    const wins=trades.filter(trade=>trade.pnlPercent>=0).length;
    const openTime=strategy.openPosition?strategy.openPosition.entryTime+ms:0;
    const openSlots=openTime>=config.start && openTime<config.end ? [{id:coin.symbol+'_'+key+'_open',coinId:coin.id,symbol:coin.symbol,entryTime:openTime,exitTime:Infinity,isOpenSimSlot:true}] : [];
    return {key,current,interval,rsiLength:strategy.rsiLength,buyRsi:strategy.buyRsi,sellRsi:strategy.sellRsi,
        profitTarget:coin.profitTarget,monthlyCap:coin.monthlyCap,
        totalTrades:trades.length,wins,losses:trades.length-wins,
        winRate:trades.length?wins/trades.length*100:0,trades,openSlots};
}
function evaluateCombination(groups, selection, config) {
    const raw=groups.flatMap((group,index)=>group.options[selection[index]].trades);
    const openSlots=groups.flatMap((group,index)=>group.options[selection[index]].openSlots||[]);
    const accepted=PortfolioEngine.filterTradesBySlotCapacity([...raw,...openSlots],config.slots,[]).filter(trade=>!trade.isOpenSimSlot);
    const outcome=PortfolioEngine.calculateCompoundedBalance({baseBalance:config.base,maxSlots:config.slots,
        trades:accepted,isSlotConstraintEnabled:false,isFeeDeductionEnabled:config.fees,startDateTimestamp:config.start/1000,activePositions:[],coins:[]});
    const wins=accepted.filter(trade=>trade.pnlPercent>=0).length;
    const winRate=accepted.length?wins/accepted.length*100:0;
    const byCoin={};
    for(const group of groups) {
        const trades=accepted.filter(trade=>trade.coinId===group.coin.id);
        const coinWins=trades.filter(trade=>trade.pnlPercent>=0).length;
        byCoin[group.coin.id]={trades:trades.length,wins:coinWins,losses:trades.length-coinWins,winRate:trades.length?coinWins/trades.length*100:0,
            gain:outcome.executedTrades.filter(trade=>trade.coinId===group.coin.id).reduce((sum,trade)=>sum+trade.netGainUSD,0)};
    }
    let valid=accepted.length>=config.minTrades && winRate+1e-9>=config.minWin;
    for(let i=0;i<groups.length;i++) {
        const candidate=groups[i].options[selection[i]];
        if(candidate.off) continue;
        const stats=byCoin[groups[i].coin.id];
        if(candidate.totalTrades<config.minTrades || candidate.winRate+1e-9<groups[i].requiredWin ||
            stats.trades<config.minTrades || stats.winRate+1e-9<groups[i].requiredWin) valid=false;
    }
    return {valid,balance:outcome.realizedBalance,gain:outcome.realizedBalance-config.base,fees:outcome.totalFeesUSD,
        trades:accepted.length,wins,losses:accepted.length-wins,winRate,skipped:raw.length-accepted.length,signals:raw.length,byCoin,
        selection:[...selection]};
}
function searchCombinations(groups, config, progress=()=>{}) {
    const baselineSelection=groups.map(group=>group.baselineIndex);
    const baseline=evaluateCombination(groups,baselineSelection,config);
    const eligible=groups.map(group=>group.options.map((option,index)=>({option,index})).filter(({option})=>option.off ||
        option.totalTrades>=config.minTrades && option.winRate+1e-9>=group.requiredWin).map(({index})=>index));
    let combinations=1;
    for(const options of eligible) combinations=Math.min(Number.MAX_SAFE_INTEGER,combinations*options.length);
    const exhaustive=combinations<=4096;
    const cache=new Map();let best=baseline.valid?baseline:null;
    let tested=0;
    function better(a,b) {return a && a.valid && (!b || !b.valid || a.balance>b.balance+1e-8 ||
        Math.abs(a.balance-b.balance)<1e-8 && a.selection.filter((v,i)=>v!==baselineSelection[i]).length<b.selection.filter((v,i)=>v!==baselineSelection[i]).length)}
    function score(selection) {
        const key=selection.join(',');if(cache.has(key))return cache.get(key);
        if(tested>=5000) return null;
        const value=evaluateCombination(groups,selection,config);cache.set(key,value);tested++;
        if(better(value,best)) best=value;
        if(tested%50===0)progress(tested,combinations,exhaustive);
        return value;
    }
    score(baselineSelection);
    if(exhaustive) {
        const selection=[];
        function walk(i){if(i===groups.length){score(selection);return}for(const option of eligible[i]){selection[i]=option;walk(i+1)}}
        walk(0);
    } else {
        // Deterministic multi-start coordinate search, followed by pair changes.
        const off=groups.map(group=>group.options.findIndex(option=>option.off));
        const localBest=eligible.map((indices,i)=>indices.filter(index=>!groups[i].options[index].off).sort((a,b)=>
            groups[i].options[b].trades.reduce((n,t)=>n+t.pnlPercent,0)-groups[i].options[a].trades.reduce((n,t)=>n+t.pnlPercent,0))[0]??off[i]);
        const starts=[baselineSelection,localBest,off,...eligible.map((_,i)=>off.map((v,j)=>i===j?localBest[j]:v))];
        for(const start of starts) {
            let selection=[...start], current=score(selection);
            for(let pass=0;pass<4 && tested<4500;pass++) {
                let changed=false;
                for(let i=0;i<groups.length;i++) {
                    let chosen=selection[i],winner=current;
                    for(const option of eligible[i]) {
                        const trial=[...selection];trial[i]=option;const candidate=score(trial);
                        if(better(candidate,winner)){winner=candidate;chosen=option}
                    }
                    if(chosen!==selection[i]){selection[i]=chosen;current=winner;changed=true}
                }
                if(!changed)break;
            }
        }
        const anchor=best?.selection||localBest;
        for(let i=0;i<groups.length && tested<5000;i++)for(let j=i+1;j<groups.length && tested<5000;j++)
            for(const a of eligible[i])for(const b of eligible[j]){const trial=[...anchor];trial[i]=a;trial[j]=b;score(trial)}
    }
    return {baseline,best,tested,combinations,exhaustive};
}
async function analyze(config) {
    const groups=[],warnings=[];
    for(let i=0;i<config.coins.length;i++) {
        const coin=config.coins[i];
        report(`Coin ${i+1}/${config.coins.length}: ${coin.symbol}`,'Mevcut ayar ve dört alternatif hazırlanıyor');
        const needed=[...new Set([coin.interval,'15m','30m'])];
        const data={};
        const warmStart=Math.max(Date.UTC(2017,0,1),config.start-Math.max(...needed.map(tf=>TF_MS[tf]))*250);
        for(const interval of needed) {
            try {data[interval]=await fetchCandles(coin.symbol,interval,warmStart,config.end)}
            catch(error) {
                if(coin.isActive!==false && interval===coin.interval) throw new Error('Mevcut düzen hesaplanamadı: '+error.message);
                warnings.push(error.message);
            }
        }
        if(coin.isActive!==false && (!data[coin.interval]||data[coin.interval].length<coin.rsiLength+5))throw new Error(coin.symbol+': mevcut strateji için yeterli veri yok');
        const options=[{key:'off',off:true,trades:[],totalTrades:0,winRate:0}];
        let current=null;
        if(data[coin.interval]?.length>coin.rsiLength+5) {
            current=makeCandidate(coin,simulateSingleConfig(data[coin.interval],coin.rsiLength,coin.buyRsi,coin.sellRsi,coin.profitTarget,coin.monthlyCap),coin.interval,config,'current',true);
            options.push(current);
        }
        const requiredWin=Math.max(config.minWin,config.preserve && current?current.winRate:0);
        for(const interval of ['15m','30m'])for(const rsi of [6,7]) {
            if(!data[interval] || data[interval].length<rsi+5)continue;
            report(`${coin.symbol} / ${interval} / RSI ${rsi}`,'Lig optimizasyonu çalışıyor');
            const strategy=evaluateBestRsi(data[interval],rsi,coin.profitTarget,coin.monthlyCap);
            options.push(makeCandidate(coin,strategy,interval,config,interval+'_'+rsi));
        }
        groups.push({coin,options,requiredWin,baselineIndex:coin.isActive===false?0:options.findIndex(option=>option.current)});
    }
    report('Kombinasyonlar karşılaştırılıyor','Slot kapasitesi, komisyon ve başarı koşulları uygulanıyor');
    const result=searchCombinations(groups,config,(tested,total,exact)=>report(`${tested} kombinasyon denendi`,exact?`Tam tarama: ${total} kombinasyon`:'Çok başlangıçlı sınırlı arama'));
    // Remove candle/trade arrays before sending the small review result to the UI.
    const summaries=groups.map(group=>({...group,options:group.options.map(({trades,openSlots,...option})=>option)}));
    self.postMessage({type:'result',...result,groups:summaries,warnings,config:{...config,coins:undefined}});
}
self.onmessage=async({data})=>{try{await analyze(data)}catch(error){self.postMessage({type:'error',message:error.message||'Analiz tamamlanamadı'})}};
