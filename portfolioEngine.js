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
    calculateCompoundedBalance(options = {}) {
        const year=Number(options.selectedYear)||new Date().getFullYear();
        const start=options.startTime ?? (Number(options.startDateTimestamp)>0?Number(options.startDateTimestamp)*1000:Date.UTC(year,0,1,-3));
        return KuzgunReplay.run({...options,startTime:start,keepCurve:options.keepCurve!==false});
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
        unrealizedPnlUSD = 0,
        equityCurve = null,
        currentEquity = null
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
        if(equityCurve?.length) {
            const valueAt=time=>{let lo=0,hi=equityCurve.length;while(lo<hi){const mid=(lo+hi)>>>1;if(equityCurve[mid].time<=time)lo=mid+1;else hi=mid;}return equityCurve[Math.max(0,lo-1)];};
            const opening=valueAt(startMs-1),ending=valueAt(endMs);
            const current=now.getTime()>=startMs&&now.getTime()<=endMs;
            const endValue=current&&Number.isFinite(currentEquity)?currentEquity:ending.equity;
            const net=endValue-opening.equity;
            return {usdtGain:net,realizedUsdtGain,includeUnrealized:current,directTradePnlSum,netTradePnlSum,
                initialPnlPercentage:net/initialBalance*100,totalFeesUSD:ending.fees-opening.fees,tradesCount:filtered.length};
        }
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
