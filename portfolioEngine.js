// KUZGUN PRO — PORTFOLIO & TIMEFRAME ENGINE
const PortfolioEngine = {
    // 1. ZAMAN TÜNELİ & SLOT ÇAKIŞMA KALKANI (Swift ile Birebir)
    filterTradesBySlotCapacity(rawTrades, maxSlots, activePositions = []) {
        if (!maxSlots || maxSlots <= 0 || !rawTrades || rawTrades.length === 0) return rawTrades;

        // İşlemleri giriş zamanına göre kronolojik sırala (Eskiden yeniye)
        const sortedCandidates = [...rawTrades].sort((a, b) => a.entryTime - b.entryTime);
        const acceptedTrades = [];

        for (const candidate of sortedCandidates) {
            const candidateStart = candidate.entryTime;
            const candidateEnd = Math.max(candidate.exitTime, candidate.entryTime + 1);

            // Mevcut kabul edilmiş işlemlerin ve aktif pozisyonların zaman aralıkları
            const occupiedIntervals = acceptedTrades.map(t => ({
                start: t.entryTime,
                end: Math.max(t.exitTime, t.entryTime + 1)
            }));

            // Şu an canlıda devam eden pozisyonlar
            activePositions.forEach(p => {
                occupiedIntervals.push({
                    start: p.entryTime,
                    end: Infinity
                });
            });

            // Kritik kontrol noktaları: Giriş anı ve o aralıktaki diğer işlemlerin başlangıçları
            const checkPoints = [candidateStart];
            for (const interval of occupiedIntervals) {
                if (interval.start > candidateStart && interval.start < candidateEnd) {
                    checkPoints.push(interval.start);
                }
            }

            // Kapasite aşımı kontrolü
            let wouldExceed = false;
            for (const point of checkPoints) {
                const occupiedCount = occupiedIntervals.reduce((count, interval) => {
                    return (interval.start <= point && interval.end > point) ? count + 1 : count;
                }, 0);

                if (occupiedCount + 1 > maxSlots) {
                    wouldExceed = true;
                    break;
                }
            }

            // Slot boşsa işleme giriş yapılır ve portföye kaydedilir
            if (!wouldExceed) {
                acceptedTrades.push(candidate);
            }
        }

        // Çıkış zamanına göre yeniden sırala (en güncel en üstte)
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
        startDateTimestamp = 0
    }) {
        // A) Slot kapasitesi kalkanını uygula
        const processedTrades = isSlotConstraintEnabled 
            ? this.filterTradesBySlotCapacity(trades, maxSlots, activePositions)
            : [...trades].sort((a, b) => a.exitTime - b.exitTime);

        // B) Sermaye başlangıç tarihinden sonrasını filtrele
        const validTrades = processedTrades
            .filter(t => (t.exitTime / 1000) >= startDateTimestamp)
            .sort((a, b) => a.exitTime - b.exitTime);

        let runningBalance = baseBalance;
        const slotsCount = Math.max(1, maxSlots);
        let totalFeesAccumulated = 0;
        const executedTrades = [];

        // C) İşlemleri bileşik olarak cüzdana işlet
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
        }

        // D) Açık (gerçekleşmemiş) pozisyonların kâr/zararı
        let unrealizedPnlUSD = 0;
        const currentSlotBudget = runningBalance / slotsCount;

        activePositions.forEach(pos => {
            const coin = coins.find(c => c.id === pos.coinId);
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
            executedTrades: executedTrades.sort((a, b) => b.exitTime - a.exitTime)
        };
    },

    // 3. DİNAMİK ZAMAN DİLİMİ İSTATİSTİKLERİ (Bugün, Hafta, Ay, Seçilen Ay, Özel Aralık)
    calculateTimeframeStats({
        executedTrades = [],
        timeframe = 'today', // 'today', 'week', 'month', 'selectMonth', 'custom'
        selectedMonthIndex = new Date().getMonth() + 1, // 1..12
        selectedYear = '2026',
        customStartDate = null,
        customEndDate = null,
        initialBalance = 1000.0,
        isFeeDeductionEnabled = true
    }) {
        if (!initialBalance || initialBalance <= 0) {
            return { usdtGain: 0, directTradePnlSum: 0, initialPnlPercentage: 0, totalFeesUSD: 0, tradesCount: 0 };
        }

        const now = new Date();
        let startMs = 0;
        let endMs = now.getTime();

        const getStartOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).getTime();

        switch (timeframe) {
            case 'today':
                startMs = getStartOfDay(now);
                break;
            case 'week': {
                // Pazartesi'yi haftanın başı al (Türkiye/ISO)
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
                const mIdx = parseInt(selectedMonthIndex, 10) - 1; // 0..11
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
                startMs = getStartOfDay(now);
        }

        const filtered = executedTrades.filter(t => t.exitTime >= startMs && t.exitTime <= endMs);

        let usdtGain = 0;
        let directTradePnlSum = 0;
        let totalFeesUSD = 0;

        for (const t of filtered) {
            usdtGain += (t.netGainUSD !== undefined) ? t.netGainUSD : (t.positionSizeUSD * (t.pnlPercent / 100));
            directTradePnlSum += t.pnlPercent;
            totalFeesUSD += (t.feeUSD || 0);
        }

        const initialPnlPercentage = (usdtGain / initialBalance) * 100.0;

        return {
            usdtGain,
            directTradePnlSum,
            initialPnlPercentage,
            totalFeesUSD,
            tradesCount: filtered.length
        };
    }
};
