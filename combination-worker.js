"use strict";
let SNAP=null;
let KZ_STATE={coins:[],closedTrades:[],activePositions:[],pendingClosedTrades:[],selectedYear:'2026'};
function getTurkeyMonthKey(timestamp=SNAP?.asOf||Date.now()) {return new Date(Number(timestamp)+10800000).toISOString().slice(0,7)}
function formatTradeDuration(entryTime,exitTime) {const minutes=Math.max(0,Math.floor((exitTime-entryTime)/60000));return Math.floor(minutes/60)+'sa '+minutes%60+'dk'}
const TF={'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000};
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
function isSameTradeSignal(first, second) {
    const symbolOf = trade => {
        const coin = (KZ_STATE.coins || []).find(c => c.id === trade.coinId);
        return String(trade.symbol || coin?.symbol || trade.displaySymbol || '')
            .toUpperCase().replace(/[^A-Z0-9]/g, '');
    };
    const firstSymbol = symbolOf(first), secondSymbol = symbolOf(second);
    const sameCoin = (first.coinId && second.coinId && first.coinId === second.coinId)
        || (firstSymbol && secondSymbol && firstSymbol === secondSymbol);
    if (!sameCoin) return false;
    if (first.originSignalId && second.originSignalId && first.originSignalId === second.originSignalId) return true;
    if (first.id && second.id && first.id === second.id) return true;
    if (Number(first.originSignalTime) > 0 && Number(second.originSignalTime) > 0) {
        return Math.floor(Number(first.originSignalTime) / 60000) === Math.floor(Number(second.originSignalTime) / 60000);
    }
    const firstEntry = Number(first.originSignalTime || first.entryTime), secondEntry = Number(second.originSignalTime || second.entryTime);
    if (!(firstEntry > 0) || !(secondEntry > 0)) return false;
    if (firstEntry === secondEntry) return true;
    // Eski canlı kayıtlar Date.now() ile saniye/milisaniye taşır;
    // simülasyon ise mum sınırını kullanır. Aynı giriş dakikasını eşleştir.
    // Manuel girişler için bu yaklaşık eşleştirmeyi kullanma.
    if (first.isManual || second.isManual || first.source === 'manual' || second.source === 'manual') return false;
    return Math.floor(firstEntry / 60000) === Math.floor(secondEntry / 60000);
}
function coinMatchesTrade(coin, trade) {
    return trade.coinId === coin.id || (trade.symbol && trade.symbol === coin.symbol);
}
function rebuildCoinMonthlyLedger(coin) {
    const year = String(KZ_STATE.selectedYear);
    const recorded = (KZ_STATE.closedTrades || []).filter(t => coinMatchesTrade(coin, t))
        .map(t => ({...t, isReal: true, isRealTrade: true,
            source: t.source || (t.isManual ? 'manual' : 'automatic'),
            pnl: Number(t.pnlPercent || 0), pnlPercent: Number(t.pnlPercent || 0),
            duration: formatTradeDuration(t.entryTime, t.exitTime),
            monthKey: getTurkeyMonthKey(t.exitTime)}));
    const open = (KZ_STATE.activePositions || []).filter(t => coinMatchesTrade(coin, t));
    const waiting = (KZ_STATE.pendingClosedTrades || []).filter(t => coinMatchesTrade(coin, t));
    const occupied = [...recorded, ...open.map(t => ({...t, exitTime: Infinity}))];
    const raw = coin.strategyTrades || (coin.simMonthlyStats || []).flatMap(m => m.tradesList || []).filter(t => !t.isReal);
    const simulated = raw.filter(t => !t.source && Number(t.exitTime) > 0)
        .filter(t => ![...recorded, ...open, ...waiting].some(r => isSameTradeSignal(t, r)))
        .filter(t => !occupied.some(r => Number(t.entryTime) < Number(r.exitTime)
            && Number(t.exitTime) > Number(r.entryTime)))
        .map(t => ({...t, symbol: coin.symbol, isReal: false,
            pnl: Number(t.pnl ?? t.pnlPercent ?? 0),
            pnlPercent: Number(t.pnl ?? t.pnlPercent ?? 0),
            monthKey: getTurkeyMonthKey(t.exitTime)}));
    const months = new Map();
    const names = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    const month = key => {
        if (!months.has(key)) months.set(key, {monthKey:key,name:names[Number(key.slice(5))-1],
            trades:0,pnl:0,isLocked:false,tradesList:[],afterLimitCount:0});
        return months.get(key);
    };
    // Aylar boş olsa bile karttaki mevcut yıl tablosunda yerini korur.
    const currentKey = getTurkeyMonthKey();
    const maxMonth = currentKey.startsWith(year + '-') ? Number(currentKey.slice(5)) : 12;
    for (let i=1; i<=maxMonth; i++) month(`${year}-${String(i).padStart(2,'0')}`);
    const events=[];
    const seen = new Set();
    for (const trade of [...recorded, ...simulated]) {
        if (Number.isFinite(SNAP.trainingStart)?(trade.entryTime<SNAP.trainingStart||trade.exitTime>SNAP.asOf):!trade.monthKey.startsWith(year + '-')) continue;
        const key = trade.id || `${trade.coinId}_${trade.entryTime}_${trade.exitTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!(Number(trade.entryTime)>0) || !(Number(trade.exitTime)>=Number(trade.entryTime))) continue;
        // entry=exit olan eski kayıtlar da kaybolmaz.
        events.push({time:Number(trade.entryTime),type:1,trade});
        events.push({time:Number(trade.exitTime),type:0,trade});
    }
    events.sort((a,b) => a.time-b.time ||
        (a.trade===b.trade ? b.type-a.type : a.type-b.type) || Number(b.trade.isReal)-Number(a.trade.isReal));
    const admitted=new Set();
    const cap=Number(coin.monthlyCap || 0);
    for (const event of events) {
        const trade=event.trade;
        if (event.type===1) {
            const entryMonth=month(getTurkeyMonthKey(trade.entryTime));
            const locked=cap>0 && entryMonth.pnl+0.001>=cap;
            if (locked && !trade.isReal) continue;
            trade.afterMonthlyLimit=Boolean(locked && trade.isReal);
            admitted.add(trade);
        } else if (admitted.has(trade)) {
            const result=month(trade.monthKey);
            result.tradesList.push(trade);
            result.trades++;
            result.pnl+=trade.pnl;
            if (trade.afterMonthlyLimit) result.afterLimitCount++;
        }
    }
    const summaries=[...months.values()].filter(m=>Number.isFinite(SNAP.trainingStart)?monthKeys().includes(m.monthKey):m.monthKey.startsWith(year+'-'));
    for (const summary of summaries) {
        summary.tradesList.sort((a,b)=>b.exitTime-a.exitTime);
        summary.isLocked=cap>0 && summary.pnl+0.001>=cap;
    }
    coin.monthlyLedger=summaries.sort((a,b)=>b.monthKey.localeCompare(a.monthKey));
    // Eski ekranların kullandığı alan da aynı kaynağı gösterir.
    coin.simMonthlyStats=coin.monthlyLedger;
    coin.simLastTrades=coin.monthlyLedger.flatMap(m=>m.tradesList)
        .sort((a,b)=>b.exitTime-a.exitTime).slice(0,10);
    return coin.monthlyLedger;
}
function progress(message,detail=''){self.postMessage({type:'progress',message,detail})}
function simulateTerminalTrades(coin,candles,settings,rsiValues=null) {
    const ms=TF[settings.interval];
    const closed=candles.filter(c=>c.time+ms<=SNAP.asOf);
    const rsi=rsiValues||calculateRSIHistory(closed.map(c=>c.close),settings.rsiLength);
    let inPos=false,entryP=0,entryT=0;const trades=[];
    for(let i=settings.rsiLength+1;i<closed.length;i++){
        const candle=closed[i],current=rsi[i],previous=rsi[i-1];
        if(current===null||previous===null)continue;
        if(!inPos){if(previous<=settings.buyRsi&&current>settings.buyRsi){inPos=true;entryP=candle.close;entryT=candle.time+ms}}
        else {
            const target=entryP*(1+coin.profitTarget/100);
            let exited=false,pnl=0,reason='';
            if(candle.high>=target){exited=true;pnl=coin.profitTarget;reason=`Kâr (%${coin.profitTarget.toFixed(1)})`}
            else if(current>=settings.sellRsi){exited=true;pnl=(candle.close-entryP)/entryP*100;reason=`RSI Sat (${current.toFixed(0)})`}
            if(exited){
                inPos=false;const exitTime=candle.time+ms;
                trades.push({id:`sim_${coin.id}_${entryT}_${exitTime}`,coinId:coin.id,symbol:coin.symbol,
                    originSignalId:`${coin.id||coin.symbol}_${entryT}`,originSignalTime:entryT,
                    entryTime:entryT,exitTime,entryPrice:entryP,exitPrice:reason.startsWith('Kâr (')?target:candle.close,
                    pnl,pnlPercent:pnl,monthKey:candle.monthKey,reason,isWin:pnl>=0});
            }
        }
    }
    return trades;
}
function ledgerCandidate(coin,candles,settings,rsiValues=null) {
    if(settings.off)return {settings:{off:true},trades:[],count:0,winRate:0,standalone:0,signature:''};
    const virtual={...coin,...settings,rawCandles:undefined,strategyTrades:simulateTerminalTrades(coin,candles,settings,rsiValues)};
    const ledger=rebuildCoinMonthlyLedger(virtual);
    // Real records are immutable and enter the portfolio once, outside the candidate pool.
    const trades=ledger.flatMap(month=>month.tradesList).filter(trade=>!trade.isReal);
    const start=SNAP.referenceArgs.startDateTimestamp>0?SNAP.referenceArgs.startDateTimestamp*1000:Date.UTC(Number(SNAP.year)||2026,0,1);
    const measured=trades.filter(trade=>trade.exitTime>=start);
    const wins=measured.filter(trade=>trade.pnlPercent>=0).length;
    return {settings:{interval:settings.interval,rsiLength:settings.rsiLength,buyRsi:settings.buyRsi,sellRsi:settings.sellRsi},trades,
        count:measured.length,winRate:measured.length?wins/measured.length*100:0,
        standalone:measured.reduce((sum,trade)=>sum+trade.pnlPercent,0),
        averageHold:measured.length?measured.reduce((sum,trade)=>sum+trade.exitTime-trade.entryTime,0)/measured.length:Infinity,
        signature:measured.slice(0,16).map(trade=>trade.entryTime+'_'+trade.exitTime).join(',')};
}
function assembleTrades(groups,selection) {
    const list=[],seen=new Set();
    const add=trade=>{if(!seen.has(trade.id)){seen.add(trade.id);list.push({...trade,pnlPercent:Number(trade.pnlPercent??trade.pnl??0)})}};
    for(let i=0;i<groups.length;i++) {
        const candidate=groups[i].options[selection[i]];
        // Match recalculateFullPortfolio(): months and trades are newest first.
        const recorded=SNAP.closedTrades.filter(trade=>coinMatchesTrade(groups[i].coin,trade)).map(trade=>({...trade,isReal:true,isRealTrade:true,
            source:trade.source||(trade.isManual?'manual':'automatic'),pnl:Number(trade.pnlPercent||0),pnlPercent:Number(trade.pnlPercent||0),monthKey:getTurkeyMonthKey(trade.exitTime)}));
        const merged=[...recorded,...candidate.trades].filter(trade=>Number.isFinite(SNAP.trainingStart)?trade.entryTime>=SNAP.trainingStart&&trade.exitTime<=SNAP.asOf:trade.monthKey.startsWith(SNAP.year+'-')).sort((a,b)=>b.exitTime-a.exitTime);
        merged.forEach(add);
    }
    for(const trade of SNAP.closedTrades) {
        if(seen.has(trade.id)||(Number.isFinite(SNAP.trainingStart)?trade.entryTime<SNAP.trainingStart||trade.exitTime>SNAP.asOf:!getTurkeyMonthKey(trade.exitTime).startsWith(SNAP.year+'-')))continue;
        add({...trade,source:trade.source||(trade.isManual?'manual':'automatic'),monthKey:trade.exitMonth||getTurkeyMonthKey(trade.exitTime)});
    }
    return list;
}
function evaluate(groups,selection,detailed=false) {
    const raw=assembleTrades(groups,selection);
    const args=SNAP.referenceArgs;
    const accepted=args.isSlotConstraintEnabled?PortfolioEngine.filterTradesBySlotCapacity(raw,args.maxSlots,args.activePositions):raw;
    const effectiveStart=args.startDateTimestamp>0?args.startDateTimestamp:Date.UTC(Number(args.selectedYear)||2026,0,1)/1000;
    const valid=accepted.filter(trade=>trade.exitTime/1000>=effectiveStart).sort((a,b)=>a.exitTime-b.exitTime);
    const monthStats={};
    const coins={};for(const group of groups)coins[group.coin.id]={trades:0,wins:0,net:0};
    let balance=args.baseBalance,fees=0,wins=0;
    for(const trade of valid) {
        const budget=balance/Math.max(1,args.maxSlots),pct=trade.pnlPercent;
        const buyFee=args.isFeeDeductionEnabled?budget*.00075:0;
        const value=budget*(1+pct/100),sellFee=args.isFeeDeductionEnabled?value*.00075:0;
        const fee=buyFee+sellFee,net=budget*(pct/100)-fee;
        balance+=net;fees+=fee;if(pct>=0)wins++;
        const key=getTurkeyMonthKey(trade.exitTime);
        const row=monthStats[key]||(monthStats[key]={net:0,fees:0,gross:0,netPercent:0,trades:0,wins:0});
        row.net+=net;row.fees+=fee;row.gross+=pct;row.netPercent+=budget>0?net/budget*100:pct;row.trades++;if(pct>=0)row.wins++;
        if(coins[trade.coinId]){coins[trade.coinId].trades++;coins[trade.coinId].net+=net;if(pct>=0)coins[trade.coinId].wins++}
    }
    const admitted=new Set(accepted.map(trade=>trade.id));
    let skipped=0,skippedPnl=0;
    for(const trade of raw)if(!admitted.has(trade.id)&&trade.exitTime/1000>=effectiveStart){skipped++;skippedPnl+=trade.pnlPercent}
    for(const row of Object.values(coins))row.winRate=row.trades?row.wins/row.trades*100:0;
    // Existing open positions and their marks are fixed in both historical alternatives.
    let unrealized=0;
    for(const position of args.activePositions){
        const coin=args.coins.find(c=>c.id===position.coinId||c.symbol===position.symbol);
        const price=coin&&coin.price>0?coin.price:position.entryPrice;
        const amount=Number(position.allocatedUsd)>0?Number(position.allocatedUsd):balance/Math.max(1,args.maxSlots);
        unrealized+=amount*(price-position.entryPrice)/position.entryPrice;
    }
    const summary={selection:[...selection],realized:balance,balance:balance+unrealized,unrealized,fees,trades:valid.length,wins,losses:valid.length-wins,
        winRate:valid.length?wins/valid.length*100:0,months:monthStats,coins,skipped,skippedPnl};
    if(detailed)summary.acceptedIds=accepted.map(trade=>trade.id).sort();
    return summary;
}
function referenceGroups(snapshot) {
    SNAP=snapshot;
    KZ_STATE={coins:snapshot.coins,closedTrades:snapshot.closedTrades,activePositions:snapshot.referenceArgs.activePositions,pendingClosedTrades:snapshot.pendingClosedTrades,selectedYear:snapshot.year};
    return snapshot.coins.map(coin=>{
        if(!TF[coin.interval])throw new Error(coin.symbol+': zaman dilimi desteklenmiyor');
        const settings={interval:coin.interval,rsiLength:coin.rsiLength,buyRsi:coin.buyRsi,sellRsi:coin.sellRsi};
        const candidate=coin.isActive===false?ledgerCandidate(coin,[],{off:true}):ledgerCandidate(coin,coin.rawCandles||[],settings);
        return {coin,original:settings,options:[candidate],currentIndex:0};
    });
}
function verifyReference(snapshot) {
    const groups=referenceGroups(snapshot);
    const baseline=evaluate(groups,groups.map(()=>0),true);
    const reference=PortfolioEngine.calculateCompoundedBalance(snapshot.referenceArgs);
    const expected=snapshot.expected;
    const expectedIds=[...reference.acceptedTradeIds].sort();
    const sourceMatches=Math.abs(reference.realizedBalance-expected.realizedBalance)<.005&&Math.abs(reference.compoundedBalance-expected.compoundedBalance)<.005;
    const generatedMatches=Math.abs(baseline.realized-reference.realizedBalance)<.005&&Math.abs(baseline.balance-reference.compoundedBalance)<.005&&JSON.stringify(baseline.acceptedIds)===JSON.stringify(expectedIds);
    if(!sourceMatches||!generatedMatches)throw new Error(`Terminal referansı eşleşmedi. Terminal: ${expected.compoundedBalance.toFixed(2)} USDT / yeniden hesap: ${baseline.balance.toFixed(2)} USDT. Terminali yenileyip Kombinasyon bağlantısından tekrar aç. Eşleşmeden öneri üretilmedi.`);
    return {groups,baseline};
}
function monthKeys() {
    if(Number.isFinite(SNAP.trainingStart)){
        const keys=[],first=getTurkeyMonthKey(SNAP.trainingStart),last=getTurkeyMonthKey(SNAP.asOf-1);
        let [year,month]=first.split('-').map(Number);
        while(`${year}-${String(month).padStart(2,'0')}`<=last){keys.push(`${year}-${String(month).padStart(2,'0')}`);if(++month>12){month=1;year++}}
        return keys;
    }
    const year=Number(SNAP.year),asOfKey=getTurkeyMonthKey(SNAP.asOf);
    const max=asOfKey.startsWith(SNAP.year+'-')?Number(asOfKey.slice(5)):12;
    return Array.from({length:max},(_,i)=>SNAP.year+'-'+String(i+1).padStart(2,'0'));
}
function guard(summary,baseline,groups,config) {
    const issues=[];
    if(!Number.isFinite(summary.balance)||summary.realized<=baseline.realized+.005||summary.balance<=baseline.balance+.005)issues.push('Toplam net kazanç artmadı');
    if(summary.winRate+1e-9<baseline.winRate)issues.push('Portföy kazanma oranı azaldı');
    for(let i=0;i<groups.length;i++) {
        const candidate=groups[i].options[summary.selection[i]],before=baseline.coins[groups[i].coin.id],after=summary.coins[groups[i].coin.id];
        if(candidate.settings.off)continue;
        if(summary.selection[i]!==0&&(candidate.count<config.minTrades||after.trades<config.minTrades))issues.push('Alternatif işlem örneği yetersiz');
        if(after.trades&&after.winRate+1e-9<before.winRate)issues.push('Coin başarı oranı azaldı');
    }
    const months=monthKeys();
    const previous=months.map(key=>baseline.months[key]?.net||0),next=months.map(key=>summary.months[key]?.net||0);
    if(config.monthlyMode==='strict') {
        if(next.some((value,i)=>value+.005<previous[i]))issues.push('En az bir ayın net kazancı geriledi');
    } else {
        if(next.filter(value=>value<-.005).length>previous.filter(value=>value<-.005).length)issues.push('Zararlı ay sayısı arttı');
        if(Math.min(...next)<Math.min(...previous)-.005)issues.push('En kötü ay geriledi');
        if(next.filter((value,i)=>value>previous[i]+.005).length<next.filter((value,i)=>value<previous[i]-.005).length)issues.push('Gerileyen ay sayısı iyileşen ay sayısından fazla');
    }
    return [...new Set(issues)];
}
async function fetchYear(symbol,interval) {
    const start=SNAP.historyStart??Date.UTC(Number(SNAP.year),0,1),end=SNAP.historyEnd??Math.min(SNAP.asOf,Date.UTC(Number(SNAP.year)+1,0,1));
    const endpoints=['https://data-api.binance.vision/api/v3/klines','https://api.binance.com/api/v3/klines'];
    let cursor=start;const candles=[];
    while(cursor<end){
        let batch=null;
        for(const endpoint of endpoints){
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
            try {
                const params=new URLSearchParams({symbol,interval,startTime:String(cursor),endTime:String(end-1),limit:'1000'});
                const response=await fetch(endpoint+'?'+params,{signal:controller.signal});
                if(!response.ok)throw new Error('HTTP '+response.status);
                const value=await response.json();if(!Array.isArray(value))throw new Error('Geçersiz veri');batch=value;break;
            }catch(error){}finally{clearTimeout(timer)}
        }
        if(!batch)throw new Error(symbol+' / '+interval+': veri indirilemedi');
        if(!batch.length)break;
        const next=Number(batch.at(-1)[0])+1;if(next<=cursor)throw new Error('Veri ilerlemiyor');
        for(const row of batch){const time=Number(row[0]);if(time+TF[interval]>end)continue;
            const candle={time,open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),monthKey:getTurkeyMonthKey(time)};
            if(![candle.open,candle.high,candle.low,candle.close].every(value=>Number.isFinite(value)&&value>0))throw new Error('Geçersiz mum fiyatı');candles.push(candle);
        }
        cursor=next;progress(symbol+' / '+interval,`${candles.length.toLocaleString('tr-TR')} mum alındı`);
        if(batch.length<1000)break;
    }
    return candles;
}
function candidateKey(candidate){const s=candidate.settings;return s.off?'off':[s.interval,s.rsiLength,s.buyRsi,s.sellRsi].join('_')}
function addOption(group,candidate){const key=candidateKey(candidate);const found=group.options.findIndex(option=>candidateKey(option)===key);if(found!==-1)return found;group.options.push(candidate);return group.options.length-1}
function overlap(a,b){const values=new Set(a.trades.map(trade=>trade.entryTime));const hits=b.trades.filter(trade=>values.has(trade.entryTime)).length;return hits/Math.max(1,Math.min(a.trades.length,b.trades.length))}
function qualifying(candidate,group,config){return candidate.count>=config.minTrades&&candidate.winRate+1e-9>=group.referenceWin}
function rawRate(candidate){return candidate.winRate}
function matchingLeagueRecords(snapshot,coin,records) {
    return records.filter(row=>row&&row.symbol===coin.symbol&&String(row.year)===snapshot.year&&
        Number(row.startTime)===(snapshot.trainingStart??Date.UTC(Number(snapshot.year),0,1))&&Number.isFinite(row.endTime)&&row.endTime<=snapshot.asOf&&row.endTime>row.startTime&&
        Math.abs(Number(row.profitTarget)-Number(coin.profitTarget))<1e-8&&Math.abs(Number(row.monthlyCap)-Number(coin.monthlyCap))<1e-8&&
        ['15m','30m'].includes(row.interval)&&[6,7].includes(row.rsiLength)&&Number.isFinite(row.buyRsi)&&row.buyRsi>=8&&row.buyRsi<=50&&
        Number.isFinite(row.sellRsi)&&row.sellRsi>=55&&row.sellRsi<=98&&row.buyRsi<row.sellRsi);
}
let SESSION=null;
async function optimize(snapshot,config) {
    SESSION=null;
    const {groups,baseline}=verifyReference(snapshot);
    const records=Array.isArray(config.leagueRecords)?config.leagueRecords:[];
    if(config.leagueOnly) {
        const missing=groups.filter(group=>!matchingLeagueRecords(snapshot,group.coin,records).length).map(group=>group.coin.displaySymbol||group.coin.symbol);
        if(missing.length)throw new Error('Uygun lig kaydı bulunamadı: '+missing.join(', ')+'. Aynı yıl ve hedef/aylık kilit değerleriyle 15m veya 30m lig taraması yap, sonra terminalden yeni kombinasyon referansı al.');
    }
    self.postMessage({type:'reference',baseline,asOf:snapshot.asOf});
    if(!snapshot.referenceArgs.isSlotConstraintEnabled)throw new Error('Terminalde slot çakışma filtresi kapalı. Slot uyumunu analiz etmek için bu filtreyi açıp referansı yeniden al.');
    const budget=Math.max(200,Math.min(2500,Number(config.budget)||1000));
    let tested=0;const cache=new Map();let best=baseline;
    function evaluateTrial(selection){
        const key=selection.join(',');if(cache.has(key))return cache.get(key);
        if(tested>=budget)return null;
        const value=evaluate(groups,selection);tested++;
        value.issues=guard(value,baseline,groups,config);
        const improvement=value.realized-baseline.realized;
        const monthDeficit=monthKeys().reduce((sum,key)=>sum+Math.max(0,(baseline.months[key]?.net||0)-(value.months[key]?.net||0)),0);
        value.searchScore=improvement-monthDeficit*(config.monthlyMode==='strict'?3:1.5)-Math.max(0,baseline.winRate-value.winRate)*snapshot.referenceArgs.baseBalance*.02;
        const compact={selection:value.selection,balance:value.balance,realized:value.realized,searchScore:value.searchScore,issues:value.issues};
        cache.set(key,compact);
        if(!value.issues.length&&value.realized>best.realized+.005)best=value;
        if(tested%20===0)progress('Ortak slotlar karşılaştırılıyor',`${tested}/${budget} portföy denemesi · bulunan net artış ${(best.realized-baseline.realized).toFixed(2)} USDT`);
        return compact;
    }
    // Baseline is always retained, even if no alternative passes all guardrails.
    const zero=groups.map(()=>0);
    evaluateTrial(zero);
    const baselineTrades=groups.map(group=>group.options[0]);
    for(let i=0;i<groups.length;i++) {
        const group=groups[i],coin=group.coin;
        group.referenceWin=rawRate(baselineTrades[i]);
        if(config.allowDisable)addOption(group,ledgerCandidate(coin,[],{off:true}));
        group.histories={};
        const lockedRecords=config.leagueOnly?matchingLeagueRecords(snapshot,coin,records):[];
        const intervals=config.leagueOnly?[...new Set([coin.interval,...lockedRecords.map(row=>row.interval)])]:[...new Set([coin.interval,'15m','30m'])];
        for(const interval of intervals){
            if(interval===coin.interval && (coin.rawCandles||[]).length)group.histories[interval]=coin.rawCandles;
            else {
                try{group.histories[interval]=await fetchYear(coin.symbol,interval)}catch(error){
                    throw new Error(error.message+' Eksik alternatifle öneri üretilmedi.');
                }
            }
        }
        if(config.leagueOnly) {
            for(const row of lockedRecords) {
                const candidate=ledgerCandidate(coin,group.histories[row.interval],{interval:row.interval,rsiLength:row.rsiLength,buyRsi:row.buyRsi,sellRsi:row.sellRsi});
                if(qualifying(candidate,group,config))addOption(group,candidate);
            }
            progress(`${i+1}/${groups.length} coin hazır`,`${group.options.length-1} lig adayı · AL/SAT eşikleri sabit`);
            continue;
        }
        for(const interval of ['15m','30m'])for(const rsiLength of [6,7]) {
            progress(`${coin.displaySymbol||coin.symbol} / ${interval} / RSI ${rsiLength}`,'AL/SAT eşikleri ve farklı sinyal zamanları hazırlanıyor');
            const candles=group.histories[interval].filter(c=>c.time+TF[interval]<=SNAP.asOf);
            const rsiValues=calculateRSIHistory(candles.map(c=>c.close),rsiLength);
            const buys=[...new Set([10,15,18,20,24,25,30,35,coin.buyRsi])].filter(value=>value>=8&&value<=50);
            const sells=[...new Set([65,75,80,85,90,95,coin.sellRsi])].filter(value=>value>=55&&value<=98);
            // Bound retained candidates: high return, fast release and distinct entry timing.
            const profitPool=[],fastPool=[],timingPool=[];
            const retain=(pool,candidate,sort)=>{pool.push(candidate);pool.sort(sort);if(pool.length>5)pool.length=5};
            for(const buyRsi of buys)for(const sellRsi of sells){
                const candidate=ledgerCandidate(coin,candles,{interval,rsiLength,buyRsi,sellRsi},rsiValues);
                if(!qualifying(candidate,group,config))continue;
                candidate.overlapWithCurrent=overlap(group.options[0],candidate);
                retain(profitPool,candidate,(a,b)=>b.standalone-a.standalone);
                if(candidate.standalone>0)retain(fastPool,candidate,(a,b)=>a.averageHold-b.averageHold||b.standalone-a.standalone);
                retain(timingPool,candidate,(a,b)=>a.overlapWithCurrent-b.overlapWithCurrent||b.standalone-a.standalone);
            }
            const preferred=[...profitPool.slice(0,2),...fastPool.slice(0,2),...timingPool.slice(0,2)];
            const seen=new Set();
            for(const candidate of preferred){const key=candidateKey(candidate);if(!seen.has(key)){seen.add(key);addOption(group,candidate)}}
        }
        // The next stage tests retained alternatives against all other coins, not in isolation.
        progress(`${i+1}/${groups.length} coin hazır`,`${group.options.length-1} farklı ayar adayı korundu`);
    }
    // Every coin receives single-change probes before the deeper joint search.
    const singles=[];
    const maxOptions=Math.max(...groups.map(group=>group.options.length));
    for(let option=1;option<maxOptions&&tested<budget*.45;option++)for(let i=0;i<groups.length&&tested<budget*.45;i++){
        if(!groups[i].options[option])continue;
        const selection=[...zero];selection[i]=option;const trial=evaluateTrial(selection);if(trial)singles.push(trial);
    }
    singles.sort((a,b)=>b.searchScore-a.searchScore);
    // Beam search keeps several timing combinations; pair changes can escape one-coin local optima.
    let beam=[{selection:zero,searchScore:0},...singles.slice(0,3)];
    const local=groups.map(group=>group.options.map((option,index)=>({option,index})).sort((a,b)=>b.option.standalone-a.option.standalone)[0].index);
    const localScore=evaluateTrial(local);if(localScore)beam.push(localScore);
    for(let pass=0;pass<3&&tested<budget*.75;pass++) {
        let changed=false;
        for(let i=0;i<groups.length&&tested<budget*.75;i++) {
            const proposals=[...beam];
            for(const parent of beam)for(let option=0;option<groups[i].options.length;option++){
                const selection=[...parent.selection];selection[i]=option;const trial=evaluateTrial(selection);if(trial)proposals.push(trial);
            }
            proposals.sort((a,b)=>b.searchScore-a.searchScore);
            const unique=new Map();for(const proposal of proposals){const key=proposal.selection.join(',');if(!unique.has(key))unique.set(key,proposal)}
            const next=[...unique.values()].slice(0,4);
            if(next[0]?.selection.join(',')!==beam[0]?.selection.join(','))changed=true;
            beam=next;
        }
        if(!changed)break;
    }
    const anchor=[...best.selection];
    const changes=[];
    for(let i=0;i<groups.length&&tested<budget*.9;i++)for(let option=0;option<groups[i].options.length;option++){
        if(option===anchor[i])continue;const selection=[...anchor];selection[i]=option;
        const trial=evaluateTrial(selection);if(trial)changes.push({i,option,score:trial.searchScore});
    }
    changes.sort((a,b)=>b.score-a.score);
    for(let a=0;a<Math.min(14,changes.length)&&tested<budget*.9;a++)for(let b=a+1;b<Math.min(14,changes.length)&&tested<budget*.9;b++){
        if(changes[a].i===changes[b].i)continue;const selection=[...anchor];selection[changes[a].i]=changes[a].option;selection[changes[b].i]=changes[b].option;evaluateTrial(selection);
    }
    // Refine AL/SAT levels around the jointly chosen portfolio, with real slot feedback.
    for(let i=0;!config.leagueOnly&&i<groups.length&&tested<budget;i++) {
        const group=groups[i],selected=group.options[best.selection[i]],setting=selected.settings;
        if(setting.off)continue;
        const candles=group.histories[setting.interval].filter(c=>c.time+TF[setting.interval]<=SNAP.asOf);
        const rsi=calculateRSIHistory(candles.map(c=>c.close),setting.rsiLength);
        for(const [db,ds] of [[-2,0],[-1,0],[1,0],[2,0],[0,-2],[0,-1],[0,1],[0,2],[-1,1],[1,-1]]){
            const buyRsi=setting.buyRsi+db,sellRsi=setting.sellRsi+ds;
            if(buyRsi<8||buyRsi>50||sellRsi<55||sellRsi>98)continue;
            const candidate=ledgerCandidate(group.coin,candles,{...setting,buyRsi,sellRsi},rsi);
            if(!qualifying(candidate,group,config))continue;
            const index=addOption(group,candidate),selection=[...best.selection];selection[i]=index;evaluateTrial(selection);
        }
    }
    cache.clear();
    const improved=best.realized>baseline.realized+.005&&guard(best,baseline,groups,config).length===0;
    const recommendation=improved?evaluate(groups,best.selection,true):null;
    for(const group of groups)delete group.histories;
    // Session is released after reporting; only compact review data goes to the main page.
    const summary=groups.map(group=>({coin:{...group.coin,rawCandles:undefined},options:group.options.map(candidate=>({settings:candidate.settings,count:candidate.count,winRate:candidate.winRate}))}));
    const report={type:'result',baseline,recommendation,groups:summary,tested,budget,config:{...config,leagueRecords:undefined},year:SNAP.year,asOf:SNAP.asOf,
        base:SNAP.referenceArgs.baseBalance,slots:SNAP.referenceArgs.maxSlots,months:monthKeys(),referenceVerified:true};
    self.postMessage(report);
    return report;
}
self.onmessage=async({data})=>{try{await optimize(data.snapshot,data.config)}catch(error){self.postMessage({type:'error',message:error.message||'Analiz tamamlanamadı'})}};
