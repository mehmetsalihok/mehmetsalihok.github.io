// KUZGUN PRO — HIGH PERFORMANCE PORTFOLIO & TIMEFRAME ENGINE
const PortfolioEngine = {
    // 1. ⚡️ ALTIN STANDART SLOT ÇAKIŞMA KALKANI (0.1 Milisaniyede Tamamlanır)
    filterTradesBySlotCapacity(rawTrades, maxSlots, activePositions = []) {
        if (!maxSlots || maxSlots <= 0 || !rawTrades || rawTrades.length === 0) return rawTrades;

        // İşlemleri giriş zamanına göre kronolojik sırala (Eskiden yeniye)
        const sorted = [...rawTrades].sort((a, b) => a.entryTime - b.entryTime);
        const slotsCount = Math.max(1, maxSlots);

        // Her slotun ne zaman boşa çıkacağını tutan zaman dizisi (milisaniye)
        const slotFreeTimes = new Array(slotsCount).fill(0);

        // Canlıda devam eden açık pozisyonlar slotu süresiz meşgul eder
        if (activePositions && activePositions.length > 0) {
            for (let i = 0; i < Math.min(activePositions.length, slotsCount); i++) {
                slotFreeTimes[i] = Infinity;
            }
        }

        const acceptedTrades = [];

        for (let i = 0; i < sorted.length; i++) {
            const trade = sorted[i];
            const entry = trade.entryTime;
            // Mum periyodu kadar slotu meşgul tutar
            const exit = Math.max(trade.exitTime, trade.entryTime + 60000);

            // Giriş anında boşa çıkmış olan ilk slotu ara
            let freeSlotIdx = -1;
            for (let s = 0; s < slotsCount; s++) {
                if (slotFreeTimes[s] <= entry) {
                    freeSlotIdx = s;
                    break;
                }
            }

            // Boş slot varsa işleme girilir ve o slot çıkış anına kadar meşgul edilir
            if (freeSlotIdx !== -1) {
                slotFreeTimes[freeSlotIdx] = exit;
                acceptedTrades.push(trade);
            }
            // Slotların tümü doluysa bu işlem elenir (Kasaya yazılmaz)
        }

        // En güncel işlem en üstte olacak şekilde sırala
        return acceptedTrades.sort((a, b) => b.exitTime - a.exitTime);
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
            unrealizedPnlUSD += currentSlotBudget * (pnlPercent / 100.0);
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
