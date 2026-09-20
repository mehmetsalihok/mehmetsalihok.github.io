// KUZGUN PRO — INDEXEDDB CANDLE CACHE (Swift Disk Cache Eşdeğeri)
const CandleCache = {
    db: null,
    async init() {
        if (this.db) return this.db;
        return new Promise((resolve) => {
            const req = indexedDB.open('KuzgunCandlesDB', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('candles')) {
                    db.createObjectStore('candles', { keyPath: 'key' });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            req.onerror = () => resolve(null);
        });
    },
    async get(key) {
        const db = await this.init();
        if (!db) return null;
        return new Promise((resolve) => {
            const tx = db.transaction('candles', 'readonly');
            const req = tx.objectStore('candles').get(key);
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
            req.onerror = () => resolve(null);
        });
    },
    async set(key, data) {
        const db = await this.init();
        if (!db) return;
        return new Promise((resolve) => {
            const tx = db.transaction('candles', 'readwrite');
            tx.objectStore('candles').put({ key, data });
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }
};

const KZ_STATE = {
    portfolioBaseUsd: 1000.00,
    selectedYear: localStorage.getItem('kuzgun_selected_year') || '2026',
    usdtTryRate: 36.50,
    btcPrice: 0.00,
    maxSlots: 2,
    coins: [],
    validSymbols: new Set(),
    activePositions: [],
    pendingSignals: [],
    closedTrades: [],
    activeFilter: 'all',
    pendingWizardCandidate: null,
    
    selectedTimeframe: 'sinceStart',
    selectedTimeframeMonth: new Date().getMonth() + 1,
    customStartDate: null,
    customEndDate: null,

    activeMonthModal: {
        coinId: null,
        monthKey: null
    },

    acceptedTradeIds: new Set(),
    coinRealStats: {},
    cachedRealizedBalance: 1000.00,
    executedGlobalTrades: [],
    lastTimeframeStats: null,
    historyPage: 0
};

let binanceWs = null;
let activeBuySignalAlert = null;
let buySignalAlertQueue = [];
let buySignalCountdownTimer = null;
let buySignalAlarmAudio = null;
const kuzgunSyncChannel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('kuzgun_terminal_sync')
    : null;

function notifyKuzgunTabs(type, payload = {}) {
    if (kuzgunSyncChannel) kuzgunSyncChannel.postMessage({ type, payload });
}

function getTurkeyMonthKey(timestamp = Date.now()) {
    const d = new Date(Number(timestamp) + (3 * 3600 * 1000));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

function getIntervalMilliseconds(interval) {
    switch (interval) {
        case '5m': return 5 * 60 * 1000;
        case '15m': return 15 * 60 * 1000;
        case '30m': return 30 * 60 * 1000;
        case '1h': return 60 * 60 * 1000;
        case '4h': return 4 * 60 * 60 * 1000;
        default: return 15 * 60 * 1000;
    }
}

function colorForTradeTime(timestamp) {
    const diffHours = (Date.now() - timestamp) / 3600000;
    if (diffHours <= 24) {
        return { dotClass: 'bg-blue-500', textClass: 'text-blue-500 dark:text-blue-400' };
    } else if (diffHours <= 48) {
        return { dotClass: 'bg-amber-500', textClass: 'text-amber-500 dark:text-amber-400' };
    } else {
        return { dotClass: 'bg-slate-400', textClass: 'text-slate-400 dark:text-slate-500' };
    }
}

function formatTimeAgo(exitMs) {
    const diffSec = Math.max(0, Math.floor((Date.now() - exitMs) / 1000));
    const mins = Math.floor(diffSec / 60);
    const hours = Math.floor(diffSec / 3600);
    const days = Math.floor(diffSec / 86400);

    if (days > 0) return `${days}gün önce`;
    if (hours > 0) return `${hours}sa önce`;
    if (mins > 0) return `${mins}dk önce`;
    return 'Az önce';
}

function formatShortDate(timestampMs) {
    const d = new Date(timestampMs);
    return `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatTradeDuration(entryTime, exitTime) {
    const diffSec = Math.max(0, Math.floor((Number(exitTime) - Number(entryTime)) / 1000));
    const hours = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    return hours > 0 ? `${hours}sa ${mins}dk` : `${mins}dk`;
}

function getCoinDisplayTrades(coin) {
    const realTrades = (KZ_STATE.closedTrades || [])
        .filter(t => t.coinId === coin.id || t.symbol === coin.symbol)
        .map(t => ({
            ...t,
            pnl: Number(t.pnlPercent || 0),
            isWin: Number(t.pnlPercent || 0) >= 0,
            duration: formatTradeDuration(t.entryTime, t.exitTime),
            isRealTrade: true
        }));

    const combined = [...realTrades, ...(coin.simLastTrades || [])]
        .sort((a, b) => Number(b.exitTime || 0) - Number(a.exitTime || 0));
    const seen = new Set();
    return combined.filter(t => {
        const key = t.id || `${t.entryTime}_${t.exitTime}_${t.entryPrice}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 10);
}

// 📲 TELEGRAM BİLDİRİMİ GÖNDERİCİ
function sendTelegramAlert(text) {
    const chatId = localStorage.getItem('kuzgun_telegram_chat_id') || '1059064615';
    const botToken = "8868427780:AAG0tAJFxew404d5MdpjVsf1UVMftBFieh0";
    if (!chatId || !botToken) return;

    try {
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML'
            })
        }).catch(() => {});
    } catch (e) {}
}

async function changeYearFromHeader(year) {
    KZ_STATE.selectedYear = year;
    localStorage.setItem('kuzgun_selected_year', year);
    await Promise.all(KZ_STATE.coins.filter(c => c.isActive !== false).map(c => fetchInitialCandles(c)));
    recalculateFullPortfolio();
}

function toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('kuzgun_theme', isDark ? 'dark' : 'light');
}

// DOM Elemanları
const elCardsGrid = document.getElementById('cardsGrid');
const elLiveTry = document.getElementById('liveTryRate');
const elLiveBtc = document.getElementById('liveBtcPrice');
const elPortfolioUsd = document.getElementById('portfolioUsd');
const elPortfolioTry = document.getElementById('portfolioTry');
const elSlotCountDisplay = document.getElementById('slotCountDisplay');
const elActivePositionsList = document.getElementById('activePositionsList');
const elActivePositionsCountBadge = document.getElementById('activePositionsCountBadge');
const elPendingSignalsList = document.getElementById('pendingSignalsList');
const elPendingSignalsCountBadge = document.getElementById('pendingSignalsCountBadge');
const elWsStatusDot = document.getElementById('wsStatusDot');
const elWsStatusText = document.getElementById('wsStatusText');
const elSlotSelector = document.getElementById('slotSelector');
const elHistoryContainer = document.getElementById('historyTradesContainer');
const elHistoryTotal = document.getElementById('historyStatsTotal');
const elHistoryPaginationDots = document.getElementById('historyPaginationDots');
const elBtnPrevHistory = document.getElementById('btnPrevHistory');
const elBtnNextHistory = document.getElementById('btnNextHistory');
const addCoinModal = document.getElementById('addCoinModal');
const wizardResultCard = document.getElementById('wizardResultCard');
const wizardLoadingStatus = document.getElementById('wizardLoadingStatus');
const manualPositionModal = document.getElementById('manualPositionModal');

// Aylık Detay Modalı Elemanları
const monthTradesModal = document.getElementById('monthTradesModal');
const modalCoinTitle = document.getElementById('modalCoinTitle');
const modalCoinBadge = document.getElementById('modalCoinBadge');
const modalMonthTabsContainer = document.getElementById('modalMonthTabsContainer');
const modalActiveMonthName = document.getElementById('modalActiveMonthName');
const modalActiveMonthTradesCount = document.getElementById('modalActiveMonthTradesCount');
const modalActiveMonthPnl = document.getElementById('modalActiveMonthPnl');
const modalActiveMonthLockBadge = document.getElementById('modalActiveMonthLockBadge');
const modalTradesListContainer = document.getElementById('modalTradesListContainer');

const fmtUsd = (val) => '$' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTry = (val) => '₺' + Number(val || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatCryptoPrice(price) {
    if (!price || price <= 0) return "--.--";
    if (price >= 1000) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return '$' + price.toFixed(4);
    return '$' + price.toFixed(6);
}

function playChime(isSuccess = true) {
    const isSound = localStorage.getItem('kuzgun_sound_enabled') !== 'false';
    if (!isSound) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        const now = ctx.currentTime;
        osc.frequency.setValueAtTime(isSuccess ? 587.33 : 440, now);
        osc.frequency.exponentialRampToValueAtTime(isSuccess ? 880 : 330, now + 0.15);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
    } catch (e) {}
}

function stopBuySignalAlarm() {
    if (!buySignalAlarmAudio) return;
    try {
        buySignalAlarmAudio.pause();
        buySignalAlarmAudio.currentTime = 0;
    } catch (e) {}
    buySignalAlarmAudio = null;
}

function playBuySignalAlarm() {
    stopBuySignalAlarm();
    if (localStorage.getItem('kuzgun_sound_enabled') === 'false') return;
    try {
        buySignalAlarmAudio = new Audio('alarm.mp3');
        buySignalAlarmAudio.loop = true;
        buySignalAlarmAudio.volume = 1;
        buySignalAlarmAudio.play().catch(() => playChime(true));
    } catch (e) {
        playChime(true);
    }
}

function addBuySignalToPending(signal) {
    const alreadyPending = (KZ_STATE.pendingSignals || []).some(s => s.coinId === signal.coinId || s.symbol === signal.symbol);
    if (alreadyPending) return;
    KZ_STATE.pendingSignals.push({
        id: 'pend_' + Date.now(),
        coinId: signal.coinId,
        symbol: signal.symbol,
        displaySymbol: signal.displaySymbol,
        triggerPrice: signal.triggerPrice,
        triggerRsi: signal.triggerRsi,
        time: signal.time,
        source: 'buy-alert'
    });
    savePending();
    renderPendingSignalsList();
}

function requestBuySignalDecision(coin, triggerPrice, triggerRsi, signalTime = Date.now(), signalMode = 'Mum Teyitli') {
    if (!coin) return;
    const signalId = `${coin.id || coin.symbol}_${signalTime}`;
    if (activeBuySignalAlert?.id === signalId || buySignalAlertQueue.some(item => item.id === signalId)) return;

    buySignalAlertQueue.push({
        id: signalId,
        coinId: coin.id,
        symbol: coin.symbol,
        displaySymbol: coin.displaySymbol,
        triggerPrice: Number(triggerPrice || coin.price),
        triggerRsi: Number(triggerRsi || coin.rsi),
        profitTarget: Number(coin.profitTarget || 0),
        interval: coin.interval,
        time: Number(signalTime || Date.now()),
        mode: signalMode
    });

    sendTelegramAlert(`🟢 <b>ALIM SİNYALİ (${signalMode})</b>\n\n<b>Coin:</b> #${coin.displaySymbol}\n<b>Sinyal Fiyatı:</b> ${formatCryptoPrice(triggerPrice || coin.price)}\n<b>RSI:</b> ${Number(triggerRsi || coin.rsi).toFixed(1)}\n<b>Zaman Dilimi:</b> ${coin.interval}\n<b>Karar Süresi:</b> 30 saniye`);
    showNextBuySignalAlert();
}

function showNextBuySignalAlert() {
    if (activeBuySignalAlert || buySignalAlertQueue.length === 0) return;
    const modal = document.getElementById('buySignalDecisionModal');
    if (!modal) return;

    activeBuySignalAlert = buySignalAlertQueue.shift();
    const alert = activeBuySignalAlert;
    document.getElementById('buySignalCoin').textContent = alert.displaySymbol;
    document.getElementById('buySignalMode').textContent = `${alert.interval} • ${alert.mode}`;
    document.getElementById('buySignalPrice').textContent = formatCryptoPrice(alert.triggerPrice);
    document.getElementById('buySignalRsi').textContent = alert.triggerRsi.toFixed(1);
    document.getElementById('buySignalTarget').textContent = `%${alert.profitTarget.toFixed(2)}`;
    document.getElementById('buySignalTime').textContent = formatShortDate(alert.time);
    const message = document.getElementById('buySignalDecisionMessage');
    message.classList.add('hidden');
    message.textContent = '';
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    playBuySignalAlarm();

    let remaining = 30;
    const countdown = document.getElementById('buySignalCountdown');
    countdown.textContent = `${remaining} sn`;
    clearInterval(buySignalCountdownTimer);
    buySignalCountdownTimer = setInterval(() => {
        remaining -= 1;
        countdown.textContent = `${Math.max(0, remaining)} sn`;
        if (remaining <= 0) resolveBuySignalDecision('pending', true);
    }, 1000);
}

function resolveBuySignalDecision(action, isTimeout = false) {
    const signal = activeBuySignalAlert;
    if (!signal) return;
    const coin = KZ_STATE.coins.find(c => c.id === signal.coinId || c.symbol === signal.symbol);
    const message = document.getElementById('buySignalDecisionMessage');

    if (action === 'accept') {
        if (!coin || coin.isActive === false) {
            message.textContent = 'Coin aktif olmadığı için pozisyon açılamadı.';
            message.className = 'text-[11px] font-medium rounded-lg px-3 py-2 bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900';
            return;
        }
        if (KZ_STATE.activePositions.length >= KZ_STATE.maxSlots) {
            message.textContent = 'Boş slot yok. Sinyali beklemeye alabilir veya reddedebilirsin.';
            message.className = 'text-[11px] font-medium rounded-lg px-3 py-2 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-900';
            return;
        }
        if (!openPosition(coin, signal.triggerPrice, signal.time)) {
            message.textContent = 'Pozisyon açılamadı; coin kilitli veya zaten açık pozisyonda olabilir.';
            message.className = 'text-[11px] font-medium rounded-lg px-3 py-2 bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900';
            return;
        }
    } else if (action === 'pending') {
        addBuySignalToPending(signal);
    }

    clearInterval(buySignalCountdownTimer);
    buySignalCountdownTimer = null;
    stopBuySignalAlarm();
    const modal = document.getElementById('buySignalDecisionModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    activeBuySignalAlert = null;
    if (isTimeout) showToast('Sinyal süresi doldu; beklemeye alındı');
    setTimeout(showNextBuySignalAlert, 200);
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

function calculateRSI(closes, period = 14) {
    const history = calculateRSIHistory(closes, period);
    return history[history.length - 1] || 50.0;
}

function isCoinMonthlyLocked(coin) {
    const currentMonthStr = getTurkeyMonthKey();
    const simulatedMonth = (coin.simMonthlyStats || []).find(m => m.monthKey === currentMonthStr);
    if (simulatedMonth && (simulatedMonth.isLocked || (simulatedMonth.pnl + 0.001) >= coin.monthlyCap)) {
        return true;
    }

    const realMonth = KZ_STATE.coinRealStats?.[coin.id]?.monthly?.[currentMonthStr];
    if (realMonth && (realMonth.pnl + 0.001) >= coin.monthlyCap) {
        return true;
    }

    const currentMonthTrades = (KZ_STATE.closedTrades || []).filter(t => (t.coinId === coin.id || t.symbol === coin.symbol) && t.exitMonth === currentMonthStr);
    const totalMonthPnl = currentMonthTrades.reduce((sum, t) => sum + t.pnlPercent, 0);
    return (totalMonthPnl + 0.001) >= coin.monthlyCap;
}

// 🎯 CANLI FİYAT, MUM DEVRİ (ROLLOVER) VE MUM KAPANIŞ TEYİDİ MOTORU
function processLivePriceUpdate(coin, livePrice, liveHigh, liveLow) {
    if (coin.isActive === false) return;
    if (!coin.rawCandles || coin.rawCandles.length === 0) return;

    const intervalMs = getIntervalMilliseconds(coin.interval);
    const nowMs = Date.now();
    let lastCandle = coin.rawCandles[coin.rawCandles.length - 1];
    let isRolloverOccurred = false;

    // 1️⃣ MUM DEVİR DÖNGÜSÜ (CANDLE ROLLOVER)
    while (nowMs >= (lastCandle.time + intervalMs)) {
        isRolloverOccurred = true;
        const nextStartTime = lastCandle.time + intervalMs;

        // Kapanan mumu son fiyatla mühürle
        lastCandle.close = livePrice;
        if (livePrice > lastCandle.high) lastCandle.high = livePrice;
        if (livePrice < lastCandle.low) lastCandle.low = livePrice;
        coin.rawCandles[coin.rawCandles.length - 1] = lastCandle;
        coin.candles[coin.candles.length - 1] = lastCandle.close;

        // 🎯 MUM KAPANIŞINDA KESİNLEŞMİŞ CROSSOVER TEYİDİ (TradingView Uyumu)
        const isCandleCloseEnabled = localStorage.getItem('kuzgun_candle_close_confirmation_enabled') !== 'false';
        if (isCandleCloseEnabled) {
            const recentCandles = coin.rawCandles.slice(-150);
            const rsiHistory = calculateRSIHistory(recentCandles.map(c => c.close), coin.rsiLength);
            const validRsis = rsiHistory.filter(r => r !== null);

            if (validRsis.length >= 2) {
                const closedRsi = validRsis[validRsis.length - 1];
                const prevClosedRsi = validRsis[validRsis.length - 2];

                // Kesinleşmiş kapanış crossover kuralı
                const isConfirmedCrossover = prevClosedRsi <= coin.buyRsi && closedRsi > coin.buyRsi;
                const isAlreadyInPos = (KZ_STATE.activePositions || []).some(p => p.coinId === coin.id || p.symbol === coin.symbol);
                const isCapReached = isCoinMonthlyLocked(coin);

                if (isConfirmedCrossover && !isAlreadyInPos && !isCapReached) {
                    requestBuySignalDecision(coin, livePrice, closedRsi, nextStartTime, 'Mum Teyitli');
                }
            }
        }

        // Sıradaki yeni açık mumu başlat
        const newCandle = {
            time: nextStartTime,
            open: livePrice,
            high: livePrice,
            low: livePrice,
            close: livePrice,
            monthKey: getTurkeyMonthKey(nextStartTime)
        };
        coin.rawCandles.push(newCandle);
        coin.candles.push(livePrice);
        lastCandle = newCandle;
    }

    // 2️⃣ ŞU ANKİ AKTİF MUMUN DEĞERLERİNİ CANLI GÜNCELLE
    lastCandle.close = livePrice;
    if (livePrice > lastCandle.high) lastCandle.high = livePrice;
    if (livePrice < lastCandle.low) lastCandle.low = livePrice;
    coin.rawCandles[coin.rawCandles.length - 1] = lastCandle;
    coin.candles[coin.candles.length - 1] = livePrice;

    coin.prevPrice = coin.price > 0 ? coin.price : livePrice;
    coin.price = livePrice;
    if (liveHigh !== undefined) coin.high24 = liveHigh;
    if (liveLow !== undefined) coin.low24 = liveLow;

    coin.prevRsi = coin.rsi;
    coin.rsi = calculateRSI(coin.candles, coin.rsiLength);

    // 3️⃣ CANLI POZİSYON ÇIKIŞ KONTROLÜ (Kâr Hedefi ve RSI Sat Anlık Çalışır)
    const activePos = (KZ_STATE.activePositions || []).find(p => p.coinId === coin.id || p.symbol === coin.symbol);
    if (activePos) {
        const pnl = ((coin.price - activePos.entryPrice) / activePos.entryPrice) * 100;
        activePos.livePnlPercent = pnl;
        activePos.livePnlUsd = activePos.allocatedUsd * (pnl / 100);

        if (coin.price >= activePos.targetPrice) {
            closePosition(activePos.id, `Kâr Hedefi (%${activePos.profitTarget.toFixed(1)})`);
            playChime(true);
            sendTelegramAlert(`🔴 <b>HEDEF KÂR ALINDI</b>\n\n<b>Coin:</b> #${coin.displaySymbol}\n<b>Çıkış Fiyatı:</b> ${formatCryptoPrice(coin.price)}\n<b>Kâr:</b> +%${pnl.toFixed(2)}`);
            return;
        }

        if (coin.rsi >= coin.sellRsi) {
            closePosition(activePos.id, `RSI Sat (${coin.rsi.toFixed(1)})`);
            playChime(pnl >= 0);
            sendTelegramAlert(`🔴 <b>RSI SAT SİNYALİ</b>\n\n<b>Coin:</b> #${coin.displaySymbol}\n<b>Çıkış Fiyatı:</b> ${formatCryptoPrice(coin.price)}\n<b>Net PnL:</b> ${pnl >= 0 ? '+' : ''}%${pnl.toFixed(2)}`);
            return;
        }
    } else {
        // 4️⃣ MUM KAPANIŞI TEYİDİ KAPALIYSA: ANLIK İĞNE KIRILIMINDA GİRİŞ
        const isCandleCloseEnabled = localStorage.getItem('kuzgun_candle_close_confirmation_enabled') !== 'false';
        if (!isCandleCloseEnabled && !isCoinMonthlyLocked(coin)) {
            const isCrossedUp = coin.prevRsi <= coin.buyRsi && coin.rsi > coin.buyRsi;
            if (isCrossedUp) {
                requestBuySignalDecision(coin, coin.price, coin.rsi, Date.now(), 'Anlık RSI');
            }
        }
    }

    // Arayüzü hafifçe güncelle
    updateCardPriceOnly(coin);
    updateActivePositionsLive();
    updateLivePortfolioQuick();

    // Mum devri gerçekleştiyse önbelleği ve tabloları arka planda mühürle
    if (isRolloverOccurred) {
        const cacheKey = `kuzgun_candles_${coin.symbol}_${coin.interval}_${KZ_STATE.selectedYear}`;
        CandleCache.set(cacheKey, coin.rawCandles);
        runCardBacktest(coin);
        updateCardTablesOnly(coin);
    }
}

function runCardBacktest(coin) {
    const monthNames = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    const targetYear = parseInt(KZ_STATE.selectedYear, 10) || 2026;
    const now = new Date();
    const intervalMs = getIntervalMilliseconds(coin.interval);
    
    const maxMonthIdx = (targetYear === now.getFullYear()) ? now.getMonth() : 11;

    const monthlyMap = {};
    for (let m = 0; m <= maxMonthIdx; m++) {
        const mKey = `${targetYear}-${String(m + 1).padStart(2, '0')}`;
        monthlyMap[mKey] = { 
            monthKey: mKey, 
            name: monthNames[m], 
            trades: 0, 
            pnl: 0, 
            isLocked: false,
            tradesList: [] 
        };
    }

    if (!coin.rawCandles || coin.rawCandles.length < (coin.rsiLength + 5)) {
        coin.simMonthlyStats = Object.values(monthlyMap).reverse();
        coin.simLastTrades = [];
        coin.avgHoldDurationStr = '--';
        return;
    }

    const closes = coin.rawCandles.map(c => c.close);
    const rsiVals = calculateRSIHistory(closes, coin.rsiLength);
    let inPos = false, entryP = 0, entryT = 0;
    const trades = [];
    let totalHoldSeconds = 0;

    for (let i = coin.rsiLength + 1; i < coin.rawCandles.length; i++) {
        const c = coin.rawCandles[i];
        const rsi = rsiVals[i];
        const prevRsi = rsiVals[i - 1];
        if (rsi === null || prevRsi === null) continue;

        const mKey = c.monthKey;
        if (!monthlyMap[mKey]) {
            const mParts = mKey.split('-');
            const mIdx = parseInt(mParts[1], 10) - 1;
            monthlyMap[mKey] = { 
                monthKey: mKey, 
                name: monthNames[mIdx] || mKey, 
                trades: 0, 
                pnl: 0, 
                isLocked: false,
                tradesList: [] 
            };
        }

        const isCapReached = (monthlyMap[mKey].pnl + 0.001) >= coin.monthlyCap;

        if (!inPos && !isCapReached) {
            if (prevRsi <= coin.buyRsi && rsi > coin.buyRsi) {
                inPos = true;
                entryP = c.close;
                entryT = c.time;
            }
        } else if (inPos) {
            const targetP = entryP * (1.0 + coin.profitTarget / 100.0);
            let exited = false, pnl = 0, reason = '';

            if (c.high >= targetP) {
                exited = true;
                pnl = coin.profitTarget;
                reason = `Kâr (%${coin.profitTarget.toFixed(1)})`;
            } else if (rsi >= coin.sellRsi) {
                exited = true;
                pnl = ((c.close - entryP) / entryP) * 100.0;
                reason = `RSI Sat (${rsi.toFixed(0)})`;
            }

            if (exited) {
                inPos = false;
                const exitTime = c.time + intervalMs;
                monthlyMap[mKey].trades++;
                monthlyMap[mKey].pnl += pnl;
                if ((monthlyMap[mKey].pnl + 0.001) >= coin.monthlyCap) {
                    monthlyMap[mKey].isLocked = true;
                }

                const diffSec = Math.max(0, Math.floor((exitTime - entryT) / 1000));
                totalHoldSeconds += diffSec;

                const hours = Math.floor(diffSec / 3600);
                const mins = Math.floor((diffSec % 3600) / 60);
                
                const entryD = new Date(entryT);
                const exitD = new Date(exitTime);
                
                const entryDateFormatted = `${entryD.getDate()} ${monthNames[entryD.getMonth()]} ${entryD.getHours().toString().padStart(2, '0')}:${entryD.getMinutes().toString().padStart(2, '0')}`;
                const exitDateFormatted = `${exitD.getDate()} ${monthNames[exitD.getMonth()]} ${exitD.getHours().toString().padStart(2, '0')}:${exitD.getMinutes().toString().padStart(2, '0')}`;

                const tradeItem = {
                    id: `sim_${coin.id}_${entryT}_${exitTime}`,
                    coinId: coin.id,
                    entryTime: entryT,
                    exitTime: exitTime,
                    entryPrice: entryP,
                    exitPrice: c.close,
                    pnl: pnl,
                    pnlPercent: pnl,
                    monthKey: mKey,
                    reason: reason,
                    duration: hours > 0 ? `${hours}sa ${mins}dk` : `${mins}dk`,
                    entryDateStr: entryDateFormatted,
                    exitDateStr: exitDateFormatted,
                    isWin: pnl >= 0
                };

                trades.push(tradeItem);
                monthlyMap[mKey].tradesList.unshift(tradeItem);
            }
        }
    }

    if (trades.length > 0) {
        const avgSec = Math.floor(totalHoldSeconds / trades.length);
        const avgH = Math.floor(avgSec / 3600);
        const avgM = Math.floor((avgSec % 3600) / 60);
        coin.avgHoldDurationStr = avgH > 0 ? `${avgH}sa ${avgM}dk` : `${avgM}dk`;
    } else {
        coin.avgHoldDurationStr = '--';
    }

    coin.simMonthlyStats = Object.values(monthlyMap).sort((a, b) => b.monthKey.localeCompare(a.monthKey));
    coin.simLastTrades = trades.slice(-10).reverse();
}

function openMonthTradesModal(coinId, monthKey) {
    const coin = KZ_STATE.coins.find(c => c.id === coinId || c.symbol === coinId || c.displaySymbol === coinId);
    if (!coin || !coin.simMonthlyStats || coin.simMonthlyStats.length === 0) return;

    KZ_STATE.activeMonthModal = { coinId: coin.id, monthKey };

    if (modalCoinTitle) modalCoinTitle.textContent = `${coin.displaySymbol}/USDT`;
    if (modalCoinBadge) modalCoinBadge.textContent = `${coin.interval} • RSI(${coin.rsiLength})`;

    renderModalTabsAndContent(coin, monthKey);

    if (monthTradesModal) {
        monthTradesModal.classList.remove('hidden');
        monthTradesModal.classList.add('flex');
    }
}

function renderModalTabsAndContent(coin, selectedMonthKey) {
    const months = coin.simMonthlyStats || [];
    if (months.length === 0) return;

    if (modalMonthTabsContainer) {
        modalMonthTabsContainer.innerHTML = months.map(m => {
            const isSelected = m.monthKey === selectedMonthKey;
            return `
                <button onclick="selectModalMonth('${m.monthKey}')" 
                    class="px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 transition flex items-center space-x-1.5 cursor-pointer ${isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}">
                    <span>${m.name}</span>
                    <span class="text-[10px] px-1.5 py-0.2 rounded-full ${isSelected ? 'bg-blue-700 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-500'} font-semibold">${m.trades}</span>
                </button>
            `;
        }).join('');
    }

    const currentMonthData = months.find(m => m.monthKey === selectedMonthKey) || months[0];

    if (modalActiveMonthName) modalActiveMonthName.textContent = `${currentMonthData.name} ${KZ_STATE.selectedYear}`;
    if (modalActiveMonthTradesCount) modalActiveMonthTradesCount.textContent = `${currentMonthData.trades} Adet İşlem Gerçekleşti`;
    if (modalActiveMonthPnl) {
        modalActiveMonthPnl.textContent = `${currentMonthData.pnl >= 0 ? '+' : ''}${currentMonthData.pnl.toFixed(2)}%`;
        modalActiveMonthPnl.className = `font-black text-base tabular-nums ${currentMonthData.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
    }
    if (modalActiveMonthLockBadge) {
        if (currentMonthData.isLocked) {
            modalActiveMonthLockBadge.textContent = "🔒 Aylık Kâr Kilidine Ulaşıldı";
            modalActiveMonthLockBadge.className = "text-[10px] font-bold text-indigo-600 dark:text-indigo-400";
        } else {
            modalActiveMonthLockBadge.textContent = `Aylık Kilit Limiti: %${coin.monthlyCap.toFixed(1)}`;
            modalActiveMonthLockBadge.className = "text-[10px] font-medium text-slate-400";
        }
    }

    const trades = currentMonthData.tradesList || [];
    if (modalTradesListContainer) {
        if (trades.length === 0) {
            modalTradesListContainer.innerHTML = `
                <div class="py-12 text-center text-slate-400 text-xs">
                    <p class="font-semibold text-slate-600 dark:text-slate-300">Bu ayda yapılmış işlem kaydı bulunmuyor.</p>
                </div>
            `;
        } else {
            modalTradesListContainer.innerHTML = trades.map(t => {
                const isWin = t.pnl >= 0;
                const isAccepted = KZ_STATE.acceptedTradeIds.has(t.id);

                return `
                    <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border ${isAccepted ? 'border-slate-200/70 dark:border-slate-800' : 'border-dashed border-slate-300 dark:border-slate-700 opacity-70'} space-y-2 text-xs transition">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center space-x-2">
                                <span class="w-2 h-2 rounded-full ${isWin ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
                                <span class="font-bold text-slate-900 dark:text-white">${t.reason}</span>
                                <span class="text-[10px] text-blue-600 dark:text-blue-400 font-semibold">• Süre: ${t.duration}</span>
                            </div>
                            
                            <div class="flex items-center space-x-2">
                                ${isAccepted ? `
                                    <span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800">✓ Slota Girdi</span>
                                ` : `
                                    <span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800">✕ Slot Doluydu (Pas)</span>
                                `}
                                <span class="font-black tabular-nums text-xs px-2 py-0.5 rounded ${isWin ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400'}">
                                    ${isWin ? '+' : ''}${t.pnl.toFixed(2)}%
                                </span>
                            </div>
                        </div>

                        <div class="grid grid-cols-2 gap-2 text-[11px] bg-white dark:bg-slate-900 p-2.5 rounded-lg border border-slate-100 dark:border-slate-800">
                            <div>
                                <span class="block text-[9px] font-bold text-slate-400 uppercase tracking-wider">GİRİŞ ZAMANI & FİYATI</span>
                                <span class="font-bold text-slate-800 dark:text-slate-200">${t.entryDateStr}</span>
                                <span class="block text-slate-500 font-mono text-[10px]">${formatCryptoPrice(t.entryPrice)}</span>
                            </div>
                            <div>
                                <span class="block text-[9px] font-bold text-slate-400 uppercase tracking-wider">ÇIKIŞ ZAMANI & FİYATI</span>
                                <span class="font-bold text-slate-800 dark:text-slate-200">${t.exitDateStr}</span>
                                <span class="block text-slate-500 font-mono text-[10px]">${formatCryptoPrice(t.exitPrice)}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }
}

function selectModalMonth(monthKey) {
    const coin = KZ_STATE.coins.find(c => c.id === KZ_STATE.activeMonthModal.coinId);
    if (!coin) return;
    KZ_STATE.activeMonthModal.monthKey = monthKey;
    renderModalTabsAndContent(coin, monthKey);
}

function closeMonthTradesModal() {
    if (monthTradesModal) {
        monthTradesModal.classList.add('hidden');
        monthTradesModal.classList.remove('flex');
    }
    KZ_STATE.activeMonthModal = { coinId: null, monthKey: null };
}

function generateMonthlyTableHtml(coin) {
    const months = coin.simMonthlyStats || [];
    const totalPnl = months.reduce((acc, m) => acc + m.pnl, 0);
    const totalTrades = months.reduce((acc, m) => acc + m.trades, 0);

    const realStats = KZ_STATE.coinRealStats[coin.id] || { totalTrades: 0, totalPnl: 0, monthly: {} };

    return `
        <div class="space-y-1">
            <div class="space-y-0.5 max-h-56 overflow-y-auto pr-1 divide-y divide-slate-100 dark:divide-slate-800">
                ${months.map(m => {
                    const rMonth = realStats.monthly[m.monthKey] || { trades: 0, pnl: 0 };
                    return `
                        <div onclick="openMonthTradesModal('${coin.id}', '${m.monthKey}')" 
                            class="flex items-center justify-between py-1.5 px-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800/80 text-xs transition cursor-pointer group select-none" title="${m.name} ayı işlemlerini aç">
                            <div class="flex items-center space-x-2">
                                <span class="font-bold text-slate-800 dark:text-slate-200 w-16 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition">${m.name}</span>
                                <span class="text-[10px] tabular-nums text-slate-500">
                                    ${m.trades} <strong class="text-blue-600 font-bold">(${rMonth.trades})</strong> İşlem
                                </span>
                                ${m.isLocked ? `<span class="text-[9px] px-1.5 py-0.2 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-semibold border border-indigo-100 dark:border-indigo-900">Kilitlendi</span>` : ''}
                            </div>
                            
                            <div class="flex items-center space-x-2">
                                <span class="font-bold tabular-nums text-xs ${m.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">
                                    ${m.pnl > 0 ? '+' : ''}${m.pnl.toFixed(1)}%
                                </span>
                                <span class="font-bold tabular-nums text-[11px] text-blue-600 dark:text-blue-400">
                                    (${rMonth.pnl >= 0 ? '+' : ''}${rMonth.pnl.toFixed(1)}%)
                                </span>
                                <span class="text-[10px] text-slate-400 group-hover:text-blue-600 transition">→</span>
                            </div>
                        </div>`;
                }).join('')}
            </div>
            <div class="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between px-2 text-xs font-bold">
                <div class="flex items-center space-x-1">
                    <span class="text-slate-700 dark:text-slate-300">Toplam:</span>
                    <span class="tabular-nums text-slate-900 dark:text-white">${totalTrades} <strong class="text-blue-600">(${realStats.totalTrades})</strong> İşlem</span>
                </div>
                <div class="flex items-center space-x-1.5">
                    <span class="tabular-nums ${totalPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%</span>
                    <span class="tabular-nums text-blue-600 dark:text-blue-400">(${realStats.totalPnl >= 0 ? '+' : ''}${realStats.totalPnl.toFixed(2)}%)</span>
                </div>
            </div>
        </div>
    `;
}

function renderHistoryTrades() {
    if (!elHistoryContainer) return;
    
    const allTrades = (KZ_STATE.executedGlobalTrades || []).slice(0, 50);
    const totalTradesCount = allTrades.length;
    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(totalTradesCount / pageSize));

    if (elHistoryTotal) {
        elHistoryTotal.textContent = `${totalTradesCount} İşlem`;
    }

    KZ_STATE.historyPage = Math.min(KZ_STATE.historyPage, totalPages - 1);
    const currentPage = KZ_STATE.historyPage;

    if (elHistoryPaginationDots) {
        if (totalPages > 1) {
            elHistoryPaginationDots.innerHTML = Array.from({ length: totalPages }).map((_, idx) => `
                <button onclick="setHistoryPage(${idx})" class="w-2 h-2 rounded-full transition-all duration-200 cursor-pointer ${idx === currentPage ? 'bg-blue-600 w-3' : 'bg-slate-300 dark:bg-slate-700 hover:bg-slate-400'}" title="Sayfa ${idx + 1}"></button>
            `).join('');
        } else {
            elHistoryPaginationDots.innerHTML = '';
        }
    }

    if (elBtnPrevHistory) elBtnPrevHistory.disabled = (currentPage <= 0);
    if (elBtnNextHistory) elBtnNextHistory.disabled = (currentPage >= totalPages - 1);

    if (totalTradesCount === 0) {
        elHistoryContainer.innerHTML = `
            <div class="py-16 text-center text-xs text-slate-400 dark:text-slate-500 bg-slate-50/70 dark:bg-slate-800/40 border border-dashed border-slate-200/80 dark:border-slate-800 rounded-xl">
                <p class="font-medium text-slate-600 dark:text-slate-300">Henüz tamamlanan işlem kaydı yok.</p>
            </div>
        `;
        return;
    }

    const startIdx = currentPage * pageSize;
    const pageTrades = allTrades.slice(startIdx, startIdx + pageSize);

    elHistoryContainer.innerHTML = pageTrades.map(t => {
        const isWin = (t.effectivePnl !== undefined ? t.effectivePnl : t.pnlPercent) >= 0;
        const timeColor = colorForTradeTime(t.exitTime);
        const pnlValue = t.effectivePnl !== undefined ? t.effectivePnl : t.pnlPercent;

        return `
            <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-xs transition hover:border-slate-200 dark:hover:border-slate-700">
                <div class="flex items-start space-x-2.5">
                    <span class="w-2 h-2 rounded-full ${timeColor.dotClass} mt-1.5 shrink-0 shadow-sm"></span>
                    
                    <div class="space-y-0.5">
                        <div class="flex items-center space-x-1.5">
                            <span class="font-black text-[11px] px-1.5 py-0.5 rounded bg-white dark:bg-slate-700 border border-slate-200/80 dark:border-slate-600 text-slate-800 dark:text-slate-100">${t.symbol.replace('USDT', '')}</span>
                            ${t.isManual ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-950/50 text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-800" title="Manuel oluşturulan işlem">✍ MANUEL</span>' : ''}
                            <span class="font-bold text-[11px] text-slate-700 dark:text-slate-200 truncate max-w-[130px]">${t.reason}</span>
                        </div>
                        
                        <div class="flex items-center space-x-1.5 text-[10px] font-mono text-slate-400">
                            <span>${formatCryptoPrice(t.entryPrice)} → ${formatCryptoPrice(t.exitPrice)}</span>
                            <span class="font-bold ${timeColor.textClass}">• ${formatTimeAgo(t.exitTime)}</span>
                        </div>
                        
                        <div class="text-[9px] font-mono text-slate-400/80">
                            Giriş: ${formatShortDate(t.entryTime)} • Çıkış: ${formatShortDate(t.exitTime)}
                        </div>
                    </div>
                </div>

                <span class="font-black tabular-nums text-xs px-2.5 py-1 rounded-lg shrink-0 ${isWin ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400'}">
                    ${isWin ? '+' : ''}${pnlValue.toFixed(2)}%
                </span>
            </div>
        `;
    }).join('');
}

function setHistoryPage(pageIdx) {
    KZ_STATE.historyPage = pageIdx;
    renderHistoryTrades();
}

function prevHistoryPage() {
    if (KZ_STATE.historyPage > 0) {
        KZ_STATE.historyPage--;
        renderHistoryTrades();
    }
}

function nextHistoryPage() {
    const totalTrades = (KZ_STATE.executedGlobalTrades || []).slice(0, 50).length;
    const totalPages = Math.max(1, Math.ceil(totalTrades / 5));
    if (KZ_STATE.historyPage < totalPages - 1) {
        KZ_STATE.historyPage++;
        renderHistoryTrades();
    }
}

function renderSingleCard(coin) {
    if (!elCardsGrid) return;
    let cardEl = document.getElementById(`card-${coin.id}`);
    const isActive = coin.isActive !== false;
    const isPos = (KZ_STATE.activePositions || []).some(p => p.coinId === coin.id || p.symbol === coin.symbol);
    const isLocked = isCoinMonthlyLocked(coin);

    if (KZ_STATE.activeFilter === 'position' && !isPos) {
        if (cardEl) cardEl.style.display = 'none';
        return;
    } else if (KZ_STATE.activeFilter === 'locked' && !isLocked) {
        if (cardEl) cardEl.style.display = 'none';
        return;
    } else if (cardEl) {
        cardEl.style.display = 'flex';
    }

    let rsiColor = 'text-slate-600 dark:text-slate-300', rsiBg = 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700', rsiLabel = 'NÖTR BÖLGE';
    if (coin.rsi <= coin.buyRsi) {
        rsiColor = 'text-emerald-700 dark:text-emerald-400 font-bold';
        rsiBg = 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800';
        rsiLabel = 'AŞIRI SATIM (AL)';
    } else if (coin.rsi >= coin.sellRsi) {
        rsiColor = 'text-rose-700 dark:text-rose-400 font-bold';
        rsiBg = 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800';
        rsiLabel = 'AŞIRI ALIM (SAT)';
    }

    let statusBadge = `<span id="status-badge-${coin.id}" class="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-[9px] font-semibold text-slate-500 dark:text-slate-400">BOŞTA</span>`;
    if (!isActive) {
        statusBadge = `<span id="status-badge-${coin.id}" class="px-2.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-700 text-[9px] font-semibold">PASİF</span>`;
    } else if (isPos) {
        statusBadge = `<span id="status-badge-${coin.id}" class="flex items-center space-x-1 px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 text-[9px] font-semibold">
            <span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span><span>POZİSYONDA</span>
        </span>`;
    } else if (isLocked) {
        statusBadge = `<span id="status-badge-${coin.id}" class="px-2.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 text-[9px] font-semibold">🔒 KİLİTLİ</span>`;
    }

    let priceColorClass = 'text-slate-900 dark:text-white';
    const isExpanded = !!coin.isExpanded;
    const activeSubTab = coin.activeSubTab || 'monthly';
    const subTabIndex = activeSubTab === 'monthly' ? 0 : 1;

    const strategyFixedHtml = `
        <div class="bg-slate-50/80 dark:bg-slate-800/50 p-3 rounded-xl border border-slate-200/80 dark:border-slate-700/80 space-y-2.5 text-xs">
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-slate-500 dark:text-slate-400 text-[10px] font-semibold mb-0.5">Zaman Dilimi</label>
                    <select id="select-interval-${coin.id}" onchange="handleLiveIntervalChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded font-semibold text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:border-blue-500">
                        <option value="5m" ${coin.interval === '5m' ? 'selected' : ''}>5m</option>
                        <option value="15m" ${coin.interval === '15m' ? 'selected' : ''}>15m</option>
                        <option value="30m" ${coin.interval === '30m' ? 'selected' : ''}>30m</option>
                        <option value="1h" ${coin.interval === '1h' ? 'selected' : ''}>1h</option>
                        <option value="4h" ${coin.interval === '4h' ? 'selected' : ''}>4h</option>
                    </select>
                </div>
                <div>
                    <label class="block text-slate-500 dark:text-slate-400 text-[10px] font-semibold mb-0.5">RSI Boyu</label>
                    <input type="number" id="input-rsiLen-${coin.id}" value="${coin.rsiLength}" min="2" max="50" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded font-semibold text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:border-blue-500">
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-slate-500 dark:text-slate-400 text-[10px] font-semibold mb-0.5">AL Sinyali (RSI ≤)</label>
                    <input type="number" id="input-buy-${coin.id}" value="${coin.buyRsi}" step="1" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded font-bold text-emerald-600 dark:text-emerald-400 text-xs focus:outline-none focus:border-blue-500 tabular-nums">
                </div>
                <div>
                    <label class="block text-slate-500 dark:text-slate-400 text-[10px] font-semibold mb-0.5">SAT Sinyali (RSI ≥)</label>
                    <input type="number" id="input-sell-${coin.id}" value="${coin.sellRsi}" step="1" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded font-bold text-rose-600 dark:text-rose-400 text-xs focus:outline-none focus:border-blue-500 tabular-nums">
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-slate-500 dark:text-slate-400 text-[10px] font-semibold mb-0.5">Hedef Kâr (%)</label>
                    <input type="number" id="input-profit-${coin.id}" value="${coin.profitTarget}" step="0.1" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded font-bold text-blue-600 dark:text-blue-400 text-xs focus:outline-none focus:border-blue-500 tabular-nums">
                </div>
                <div>
                    <label class="block text-slate-500 dark:text-slate-400 text-[10px] font-semibold mb-0.5">Aylık Kilit (%)</label>
                    <input type="number" id="input-cap-${coin.id}" value="${coin.monthlyCap}" step="0.1" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded font-bold text-indigo-600 dark:text-indigo-400 text-xs focus:outline-none focus:border-blue-500 tabular-nums">
                </div>
            </div>
        </div>
    `;

    const monthlyPanelHtml = `
        <div id="monthly-container-${coin.id}">
            ${generateMonthlyTableHtml(coin)}
        </div>
    `;

    const trades = getCoinDisplayTrades(coin);
    const tradesPanelHtml = `
        <div id="trades-container-${coin.id}" class="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            ${trades.map(t => `
                <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 text-xs">
                    <div class="space-y-0.5">
                        <div class="flex items-center space-x-1.5">
                            <span class="font-semibold text-slate-800 dark:text-slate-200 text-[11px]">${t.reason}</span>
                            <span class="text-[10px] text-blue-600 dark:text-blue-400 font-medium">• ${t.duration}</span>
                        </div>
                        <div class="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">${formatCryptoPrice(t.entryPrice)} → ${formatCryptoPrice(t.exitPrice)}</div>
                        <div class="text-[9px] text-slate-400/80 dark:text-slate-500 tabular-nums">Giriş: ${formatShortDate(t.entryTime)} • Çıkış: ${formatShortDate(t.exitTime)}</div>
                    </div>
                    <span class="font-bold tabular-nums text-xs px-2 py-0.5 rounded ${t.isWin ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400'}">
                        ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%
                    </span>
                </div>`).join('')}
        </div>
    `;

    const htmlContent = `
        <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <div class="flex items-center space-x-2 min-w-0 flex-1">
                <span class="font-bold text-base tracking-tight text-slate-900 dark:text-white">${coin.displaySymbol}</span>
                <span class="text-[10px] text-slate-400 dark:text-slate-500 font-medium">/USDT</span>
                <span class="whitespace-nowrap text-[9px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 border border-blue-200/60 dark:border-blue-800/60">${coin.interval} • RSI(${coin.rsiLength})</span>
            </div>
            <div class="flex items-center space-x-1 shrink-0">
                <span id="badge-wrapper-${coin.id}">${statusBadge}</span>

                <button type="button" onclick="openCoinFocus('${coin.id}')" class="text-slate-400 hover:text-emerald-600 dark:text-slate-500 dark:hover:text-emerald-400 p-1 rounded-lg transition cursor-pointer" title="Ayrı sekmede canlı takip et">
                    <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 3h7m0 0v7m0-7L10 14M5 7v12h12v-5"></path>
                    </svg>
                </button>
                
                <button type="button" onclick="openWizardForExistingCoin('${coin.id}')" class="text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 p-1 rounded-lg transition cursor-pointer" title="Strateji Ayarları">
                    <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                    </svg>
                </button>
                
                <button type="button" onclick="deleteCoinCard('${coin.id}')" class="text-slate-400 hover:text-rose-600 dark:text-slate-500 dark:hover:text-rose-400 p-1 rounded-lg transition cursor-pointer" title="Kartı Sil">
                    <svg class="w-3.5 h-3.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>

                <button type="button" onclick="toggleCoinActive('${coin.id}')" aria-pressed="${isActive}" aria-label="${isActive ? 'Coini pasife al' : 'Coini aktifleştir'}" class="shrink-0 p-0.5 rounded-full focus:outline-none focus:ring-2 focus:ring-emerald-400/50" title="${isActive ? 'Aktif — pasife almak için tıkla' : 'Pasif — aktifleştirmek için tıkla'}">
                    <span class="relative block w-8 h-[18px] rounded-full transition-colors ${isActive ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}">
                        <span class="absolute top-[3px] w-3 h-3 rounded-full bg-white shadow transition-all ${isActive ? 'left-[17px]' : 'left-[3px]'}"></span>
                    </span>
                </button>
            </div>
        </div>

        <div class="flex items-baseline justify-between pt-1">
            <div>
                <div class="text-2xl font-bold tabular-nums tracking-tight price-transition ${priceColorClass}" id="price-${coin.id}">
                    ${formatCryptoPrice(coin.price)}
                </div>
                <div class="flex items-center space-x-2 text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 font-medium">
                    <span>24s En Düşük:</span><span id="low24-${coin.id}" class="text-rose-500 tabular-nums font-semibold">${formatCryptoPrice(coin.low24)}</span>
                    <span>•</span>
                    <span>En Yüksek:</span><span id="high24-${coin.id}" class="text-emerald-600 dark:text-emerald-400 tabular-nums font-semibold">${formatCryptoPrice(coin.high24)}</span>
                </div>
            </div>
            <div class="flex flex-col items-end space-y-1">
                <div id="rsi-badge-${coin.id}" class="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border ${rsiBg} text-xs shadow-sm">
                    <span class="text-[9px] text-slate-500 dark:text-slate-400 font-bold tracking-wider">RSI</span>
                    <span id="rsi-val-${coin.id}" class="font-extrabold tabular-nums ${rsiColor}">${(coin.rsi || 50).toFixed(1)}</span>
                </div>
                <span id="rsi-label-${coin.id}" class="text-[9px] font-bold tracking-tight ${rsiColor}">${rsiLabel}</span>
            </div>
        </div>

        <div class="space-y-1.5 pt-1.5">
            <div class="flex items-center justify-between text-[9px] font-bold text-slate-500 dark:text-slate-400">
                <span class="flex items-center space-x-1 text-emerald-600 dark:text-emerald-400"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span><span>AL KORİDORU</span></span>
                <span class="text-slate-400 dark:text-slate-500 font-medium">NÖTR ALAN</span>
                <span class="flex items-center space-x-1 text-rose-600 dark:text-rose-400"><span>SAT KORİDORU</span><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span></span>
            </div>
            <div class="w-full bg-slate-200/90 dark:bg-slate-800 rounded-md h-3 relative overflow-hidden flex border border-slate-300/60 dark:border-slate-700 shadow-inner">
                <div style="width: ${coin.buyRsi}%" class="bg-emerald-500/25 border-r border-emerald-500/60 h-full"></div>
                <div style="width: ${Math.max(0, coin.sellRsi - coin.buyRsi)}%" class="bg-slate-100/40 dark:bg-slate-700/40 h-full"></div>
                <div style="width: ${Math.max(0, 100 - coin.sellRsi)}%" class="bg-rose-500/25 border-l border-rose-500/60 h-full"></div>
                <div id="rsi-needle-${coin.id}" class="absolute top-0 bottom-0 w-1 bg-slate-900 dark:bg-white shadow-md transition-all duration-300 z-10 -ml-0.5" style="left: ${Math.min(100, Math.max(0, coin.rsi || 50))}%">
                    <div class="w-2.5 h-1.5 bg-slate-900 dark:bg-white rounded-sm -mt-0.5 -ml-[3px]"></div>
                </div>
            </div>
            <div class="flex justify-between text-[8px] font-bold tabular-nums text-slate-400 dark:text-slate-500 px-0.5">
                <span>0</span>
                <span class="text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-1 py-0.2 rounded border border-emerald-200 dark:border-emerald-800">AL: ≤ ${coin.buyRsi}</span>
                <span class="text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/50 px-1 py-0.2 rounded border border-rose-200 dark:border-rose-800">SAT: ≥ ${coin.sellRsi}</span>
                <span>100</span>
            </div>
        </div>

        ${isExpanded ? `
            <div class="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
                ${strategyFixedHtml}
                <div class="space-y-2 pt-1">
                    <div class="flex items-center space-x-1 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300">
                        <button id="subtab-btn-${coin.id}-monthly" onclick="setCardSubTab('${coin.id}', 'monthly')" class="flex-1 py-1 rounded-md transition cursor-pointer ${activeSubTab === 'monthly' ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm font-semibold' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 font-medium'}">Aylık Tablo (${KZ_STATE.selectedYear})</button>
                        <button id="subtab-btn-${coin.id}-trades" onclick="setCardSubTab('${coin.id}', 'trades')" class="flex-1 py-1 rounded-md transition cursor-pointer ${activeSubTab === 'trades' ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm font-semibold' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 font-medium'}">Son 10 İşlem</button>
                    </div>
                    <div class="overflow-hidden w-full relative pt-1">
                        <div id="subslider-${coin.id}" class="flex w-full transition-transform duration-300 ease-in-out" style="transform: translateX(-${subTabIndex * 100}%);">
                            <div class="w-full shrink-0 px-0.5">${monthlyPanelHtml}</div>
                            <div class="w-full shrink-0 px-0.5">${tradesPanelHtml}</div>
                        </div>
                    </div>
                </div>
            </div>` : `
            <div class="pt-2.5 border-t border-slate-100 dark:border-slate-800 grid grid-cols-5 gap-1.5 text-center text-xs">
                <div class="bg-slate-50 dark:bg-slate-800/60 p-1.5 rounded-lg border border-slate-200/70 dark:border-slate-800 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">AL SİNYALİ</span>
                    <strong class="text-emerald-600 dark:text-emerald-400 font-extrabold tabular-nums text-xs">≤ ${coin.buyRsi}</strong>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800/60 p-1.5 rounded-lg border border-slate-200/70 dark:border-slate-800 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">SAT SİNYALİ</span>
                    <strong class="text-rose-600 dark:text-rose-400 font-extrabold tabular-nums text-xs">≥ ${coin.sellRsi}</strong>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800/60 p-1.5 rounded-lg border border-slate-200/70 dark:border-slate-800 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">HEDEF KÂR</span>
                    <strong class="text-blue-600 dark:text-blue-400 font-extrabold tabular-nums text-xs">%${coin.profitTarget.toFixed(1)}</strong>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800/60 p-1.5 rounded-lg border border-slate-200/70 dark:border-slate-800 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">AY KİLİT</span>
                    <strong class="text-indigo-600 dark:text-indigo-400 font-extrabold tabular-nums text-xs">%${coin.monthlyCap.toFixed(1)}</strong>
                </div>
                <div class="bg-slate-50 dark:bg-slate-800/60 p-1.5 rounded-lg border border-slate-200/70 dark:border-slate-800 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">ORT. SÜRE</span>
                    <strong class="text-amber-600 dark:text-amber-400 font-extrabold tabular-nums text-[10px]">${coin.avgHoldDurationStr || '--'}</strong>
                </div>
            </div>`}

        <button type="button" onclick="toggleCardExpand('${coin.id}')" aria-expanded="${isExpanded}" class="group w-full flex items-center justify-center gap-1 pt-2 border-t border-slate-100 dark:border-slate-800 text-[9px] font-bold tracking-wider text-slate-400 hover:text-blue-600 dark:text-slate-500 dark:hover:text-blue-400 transition-colors cursor-pointer select-none" title="${isExpanded ? 'Detayları kapat' : 'Detayları aç'}">
            <span class="pointer-events-none">${isExpanded ? 'DETAYLARI KAPAT' : 'DETAYLARI AÇ'}</span>
            <svg class="w-3.5 h-3.5 pointer-events-none transition-transform duration-300 ease-in-out group-hover:translate-y-0.5 ${isExpanded ? 'rotate-180' : 'animate-bounce'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"></path>
            </svg>
        </button>
    `;

    if (!cardEl) {
        cardEl = document.createElement('div');
        cardEl.id = `card-${coin.id}`;
        cardEl.className = 'bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-xl p-4 space-y-3 shadow-sm hover:border-slate-300 dark:hover:border-slate-700 transition flex flex-col justify-between';
        elCardsGrid.appendChild(cardEl);
    }
    cardEl.className = `bg-white dark:bg-slate-900 border rounded-xl p-4 space-y-3 shadow-sm transition flex flex-col justify-between ${isActive ? 'border-slate-200/80 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700' : 'border-dashed border-slate-300 dark:border-slate-700 opacity-60'}`;
    cardEl.innerHTML = htmlContent;
}

function updateCardPriceOnly(coin) {
    const elPrice = document.getElementById(`price-${coin.id}`);
    if (elPrice) {
        elPrice.textContent = formatCryptoPrice(coin.price);
        if (coin.prevPrice > 0 && coin.price !== coin.prevPrice) {
            elPrice.classList.remove('text-slate-900', 'dark:text-white', 'text-emerald-600', 'dark:text-emerald-400', 'text-rose-600', 'dark:text-rose-400');
            if (coin.price > coin.prevPrice) {
                elPrice.classList.add('text-emerald-600', 'dark:text-emerald-400');
            } else {
                elPrice.classList.add('text-rose-600', 'dark:text-rose-400');
            }
            setTimeout(() => {
                elPrice.classList.remove('text-emerald-600', 'dark:text-emerald-400', 'text-rose-600', 'dark:text-rose-400');
                elPrice.classList.add('text-slate-900', 'dark:text-white');
            }, 350);
        }
    }

    const elHigh = document.getElementById(`high24-${coin.id}`);
    const elLow = document.getElementById(`low24-${coin.id}`);
    if (elHigh) elHigh.textContent = formatCryptoPrice(coin.high24);
    if (elLow) elLow.textContent = formatCryptoPrice(coin.low24);

    const elRsiVal = document.getElementById(`rsi-val-${coin.id}`);
    const elRsiLabel = document.getElementById(`rsi-label-${coin.id}`);
    const elRsiBadge = document.getElementById(`rsi-badge-${coin.id}`);
    const elRsiNeedle = document.getElementById(`rsi-needle-${coin.id}`);

    let rsiColor = 'text-slate-600 dark:text-slate-300';
    let rsiBg = 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700';
    let rsiLabel = 'NÖTR BÖLGE';

    if (coin.rsi <= coin.buyRsi) {
        rsiColor = 'text-emerald-700 dark:text-emerald-400 font-bold';
        rsiBg = 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800';
        rsiLabel = 'AŞIRI SATIM (AL)';
    } else if (coin.rsi >= coin.sellRsi) {
        rsiColor = 'text-rose-700 dark:text-rose-400 font-bold';
        rsiBg = 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800';
        rsiLabel = 'AŞIRI ALIM (SAT)';
    }

    if (elRsiVal) {
        elRsiVal.textContent = (coin.rsi || 50).toFixed(1);
        elRsiVal.className = `font-extrabold tabular-nums ${rsiColor}`;
    }
    if (elRsiLabel) {
        elRsiLabel.textContent = rsiLabel;
        elRsiLabel.className = `text-[9px] font-bold tracking-tight ${rsiColor}`;
    }
    if (elRsiBadge) {
        elRsiBadge.className = `flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border ${rsiBg} text-xs shadow-sm`;
    }
    if (elRsiNeedle) {
        elRsiNeedle.style.left = `${Math.min(100, Math.max(0, coin.rsi || 50))}%`;
    }
}

function updateCardTablesOnly(coin) {
    const mContainer = document.getElementById(`monthly-container-${coin.id}`);
    const tContainer = document.getElementById(`trades-container-${coin.id}`);

    if (mContainer) {
        mContainer.innerHTML = generateMonthlyTableHtml(coin);
    }

    if (tContainer) {
        const trades = getCoinDisplayTrades(coin);
        tContainer.innerHTML = trades.length === 0 ? `<p class="py-6 text-center text-xs text-slate-400 dark:text-slate-500 font-medium">İşlem yok.</p>` : `
            <div class="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                ${trades.map(t => `
                    <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 text-xs">
                        <div class="space-y-0.5">
                            <div class="flex items-center space-x-1.5">
                                <span class="font-semibold text-slate-800 dark:text-slate-200 text-[11px]">${t.reason}</span>
                                ${t.isManual ? '<span class="text-[9px] px-1 py-0.5 rounded bg-violet-50 dark:bg-violet-950/50 text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-800" title="Manuel oluşturulan işlem">✍ MANUEL</span>' : ''}
                                <span class="text-[10px] text-blue-600 dark:text-blue-400 font-medium">• ${t.duration}</span>
                            </div>
                            <div class="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">${formatCryptoPrice(t.entryPrice)} → ${formatCryptoPrice(t.exitPrice)}</div>
                            <div class="text-[9px] text-slate-400/80 dark:text-slate-500 tabular-nums">Giriş: ${formatShortDate(t.entryTime)} • Çıkış: ${formatShortDate(t.exitTime)}</div>
                        </div>
                        <span class="font-bold tabular-nums text-xs px-2 py-0.5 rounded ${t.isWin ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400'}">
                            ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%
                        </span>
                    </div>`).join('')}
            </div>`;
    }
}

function renderActivePositionsList() {
    if (!elActivePositionsCountBadge || !elActivePositionsList) return;
    elActivePositionsCountBadge.textContent = `${KZ_STATE.activePositions.length} / ${KZ_STATE.maxSlots} Slot`;
    if (KZ_STATE.activePositions.length === 0) {
        elActivePositionsList.innerHTML = `<div class="py-5 px-3 text-center bg-slate-50/70 dark:bg-slate-800/40 border border-dashed border-slate-200/80 dark:border-slate-800 rounded-lg"><p class="font-semibold text-slate-700 dark:text-slate-300 text-xs">Açık pozisyon yok</p></div>`;
        return;
    }

    elActivePositionsList.innerHTML = KZ_STATE.activePositions.map(pos => {
        const coin = KZ_STATE.coins.find(c => c.id === pos.coinId || c.symbol === pos.symbol);
        const currentPrice = coin && coin.price > 0 ? coin.price : pos.entryPrice;
        const pnl = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const pnlUsd = pos.allocatedUsd * (pnl / 100);
        const isWin = pnl >= 0;
        const entryDate = formatShortDate(pos.entryTime || Date.now());

        return `
            <div class="bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 rounded-lg p-2.5 space-y-2">
                <div class="flex items-center justify-between">
                    <span class="font-bold text-xs text-slate-900 dark:text-white">${pos.displaySymbol} <span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold border border-blue-200 dark:border-blue-800">%${pos.profitTarget.toFixed(1)} TP</span>${pos.isManual ? ' <span class="text-[9px] px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-950/50 text-violet-600 dark:text-violet-400 border border-violet-200 dark:border-violet-800" title="Manuel oluşturulan pozisyon">✍ MANUEL</span>' : ''}</span>
                    <span id="active-pos-pnl-${pos.id}" class="font-semibold text-xs tabular-nums ${isWin ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">${isWin ? '+' : ''}${fmtUsd(pnlUsd)} (${isWin ? '+' : ''}${pnl.toFixed(2)}%)</span>
                </div>
                <div class="grid grid-cols-2 gap-1.5 text-[10px] text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-800/90 p-2 rounded border border-slate-100 dark:border-slate-700/60">
                    <div class="flex items-center gap-1">Giriş: <span class="text-slate-800 dark:text-slate-200 font-medium">${formatCryptoPrice(pos.entryPrice)}</span>
                        <button type="button" onclick="editPositionEntryPrice('${pos.id}')" class="p-0.5 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition" title="Giriş fiyatını düzenle" aria-label="Giriş fiyatını düzenle">
                            <svg class="w-3 h-3 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536M9 15l-1 4 4-1 8.5-8.5a2.5 2.5 0 10-3.536-3.536L8.5 14.464 9 15z"></path></svg>
                        </button>
                    </div>
                    <div>Hedef: <span class="text-emerald-600 dark:text-emerald-400 font-medium">${formatCryptoPrice(pos.targetPrice)}</span></div>
                    <div>Anlık: <span id="active-pos-price-${pos.id}" class="text-slate-900 dark:text-white font-medium">${formatCryptoPrice(currentPrice)}</span></div>
                    <div>Bütçe: <span class="text-slate-800 dark:text-slate-200 font-medium">${fmtUsd(pos.allocatedUsd)}</span></div>
                    <div class="col-span-2 pt-1 border-t border-slate-100 dark:border-slate-700/60">Giriş zamanı: <span class="text-slate-800 dark:text-slate-200 font-semibold tabular-nums">${entryDate}</span></div>
                </div>
                <button onclick="closePosition('${pos.id}')" class="w-full py-1 rounded-lg bg-white dark:bg-slate-800 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-700 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 text-xs font-medium border border-slate-200 dark:border-slate-700 transition cursor-pointer">Pozisyonu Kapat</button>
            </div>`;
    }).join('');
}

function updateActivePositionsLive() {
    (KZ_STATE.activePositions || []).forEach(pos => {
        const coin = KZ_STATE.coins.find(c => c.id === pos.coinId || c.symbol === pos.symbol);
        const currentPrice = coin && coin.price > 0 ? coin.price : pos.entryPrice;
        const pnl = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const pnlUsd = pos.allocatedUsd * (pnl / 100);
        const isWin = pnl >= 0;

        pos.livePnlPercent = pnl;
        pos.livePnlUsd = pnlUsd;

        const pnlEl = document.getElementById(`active-pos-pnl-${pos.id}`);
        const priceEl = document.getElementById(`active-pos-price-${pos.id}`);
        if (pnlEl) {
            pnlEl.textContent = `${isWin ? '+' : ''}${fmtUsd(pnlUsd)} (${isWin ? '+' : ''}${pnl.toFixed(2)}%)`;
            pnlEl.className = `font-semibold text-xs tabular-nums ${isWin ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
        }
        if (priceEl) priceEl.textContent = formatCryptoPrice(currentPrice);
    });
}

function editPositionEntryPrice(positionId) {
    const pos = KZ_STATE.activePositions.find(p => p.id === positionId);
    if (!pos) return;

    const enteredValue = prompt(`${pos.displaySymbol} için gerçek giriş fiyatını yaz:`, String(pos.entryPrice));
    if (enteredValue === null) return;

    const newEntryPrice = Number(String(enteredValue).trim().replace(',', '.'));
    if (!Number.isFinite(newEntryPrice) || newEntryPrice <= 0) {
        alert('Geçerli ve sıfırdan büyük bir giriş fiyatı yazmalısın.');
        return;
    }

    pos.entryPrice = newEntryPrice;
    pos.targetPrice = newEntryPrice * (1 + (Number(pos.profitTarget || 0) / 100));

    const coin = KZ_STATE.coins.find(c => c.id === pos.coinId || c.symbol === pos.symbol);
    const currentPrice = coin && coin.price > 0 ? coin.price : newEntryPrice;
    pos.livePnlPercent = ((currentPrice - newEntryPrice) / newEntryPrice) * 100;
    pos.livePnlUsd = Number(pos.allocatedUsd || 0) * (pos.livePnlPercent / 100);

    savePositions();
    renderActivePositionsList();
    recalculateFullPortfolio();
}

function toLocalDateTimeInputValue(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function openManualPositionModal() {
    if (!manualPositionModal) return;
    const select = document.getElementById('manualPositionCoin');
    const entryInput = document.getElementById('manualPositionEntryPrice');
    const targetInput = document.getElementById('manualPositionProfitTarget');
    const timeInput = document.getElementById('manualPositionEntryTime');
    const errorEl = document.getElementById('manualPositionError');
    const openKeys = new Set(KZ_STATE.activePositions.map(p => p.coinId || p.symbol));
    const availableCoins = KZ_STATE.coins.filter(c => c.isActive !== false && !openKeys.has(c.id) && !openKeys.has(c.symbol));

    select.innerHTML = availableCoins.length
        ? availableCoins.map(c => `<option value="${c.id}">${c.displaySymbol || c.symbol.replace('USDT', '')}</option>`).join('')
        : '<option value="">Eklenebilecek coin yok</option>';
    select.disabled = availableCoins.length === 0;

    const selectedCoin = availableCoins[0];
    entryInput.value = selectedCoin && selectedCoin.price > 0 ? selectedCoin.price : '';
    targetInput.value = selectedCoin ? Number(selectedCoin.profitTarget || 1).toFixed(2) : '';
    timeInput.value = toLocalDateTimeInputValue();
    timeInput.max = toLocalDateTimeInputValue();
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    select.onchange = () => {
        const coin = KZ_STATE.coins.find(c => c.id === select.value);
        if (!coin) return;
        if (coin.price > 0) entryInput.value = coin.price;
        targetInput.value = Number(coin.profitTarget || 1).toFixed(2);
    };

    manualPositionModal.classList.remove('hidden');
    manualPositionModal.classList.add('flex');
}

function closeManualPositionModal() {
    if (!manualPositionModal) return;
    manualPositionModal.classList.add('hidden');
    manualPositionModal.classList.remove('flex');
}

function submitManualPosition(event) {
    event.preventDefault();
    const errorEl = document.getElementById('manualPositionError');
    const coinId = document.getElementById('manualPositionCoin').value;
    const entryPrice = Number(document.getElementById('manualPositionEntryPrice').value);
    const profitTarget = Number(document.getElementById('manualPositionProfitTarget').value);
    const entryTime = new Date(document.getElementById('manualPositionEntryTime').value).getTime();
    const coin = KZ_STATE.coins.find(c => c.id === coinId);
    const fail = (message) => {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    };

    if (!coin) return fail('Lütfen geçerli bir coin seç.');
    if (coin.isActive === false) return fail('Pasif bir coin için canlı pozisyon açılamaz. Önce coin kartını aktifleştir.');
    if (KZ_STATE.activePositions.length >= KZ_STATE.maxSlots) return fail('Boş slot yok. Önce bir pozisyonu kapatmalı veya slot sayısını artırmalısın.');
    if (KZ_STATE.activePositions.some(p => p.coinId === coin.id || p.symbol === coin.symbol)) return fail('Bu coin için zaten açık bir pozisyon var.');
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return fail('Giriş fiyatı sıfırdan büyük olmalı.');
    if (!Number.isFinite(profitTarget) || profitTarget <= 0) return fail('Hedef kâr yüzdesi sıfırdan büyük olmalı.');
    if (!Number.isFinite(entryTime) || entryTime > Date.now()) return fail('Geçerli ve gelecekte olmayan bir giriş zamanı seçmelisin.');

    const availableBalance = Number(KZ_STATE.cachedRealizedBalance) > 0 ? Number(KZ_STATE.cachedRealizedBalance) : KZ_STATE.portfolioBaseUsd;
    const slotBudget = availableBalance / Math.max(1, KZ_STATE.maxSlots);
    const currentPrice = coin.price > 0 ? coin.price : entryPrice;
    const livePnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    KZ_STATE.activePositions.push({
        id: `pos_manual_${Date.now()}`,
        coinId: coin.id,
        symbol: coin.symbol,
        displaySymbol: coin.displaySymbol,
        entryPrice,
        targetPrice: entryPrice * (1 + profitTarget / 100),
        profitTarget,
        allocatedUsd: slotBudget,
        allocationVersion: 2,
        entryTime,
        livePnlPercent,
        livePnlUsd: slotBudget * (livePnlPercent / 100),
        isManual: true,
        source: 'manual'
    });

    KZ_STATE.pendingSignals = KZ_STATE.pendingSignals.filter(p => p.coinId !== coin.id && p.symbol !== coin.symbol);
    savePending();
    savePositions();
    closeManualPositionModal();
    renderActivePositionsList();
    renderPendingSignalsList();
    recalculateFullPortfolio();
}

function renderPendingSignalsList() {
    if (!elPendingSignalsCountBadge || !elPendingSignalsList) return;
    elPendingSignalsCountBadge.textContent = `${KZ_STATE.pendingSignals.length} Bekleyen`;
    if (KZ_STATE.pendingSignals.length === 0) {
        elPendingSignalsList.innerHTML = `<div class="py-5 px-3 text-center bg-slate-50/70 dark:bg-slate-800/40 border border-dashed border-slate-200/80 dark:border-slate-800 rounded-lg"><p class="font-semibold text-slate-700 dark:text-slate-300 text-xs">Radar sırası boş</p></div>`;
        return;
    }

    elPendingSignalsList.innerHTML = KZ_STATE.pendingSignals.map(item => `
        <div class="bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-900/40 rounded-lg p-2.5 space-y-2">
            <div class="flex items-center justify-between">
                <span class="font-bold text-xs text-slate-900 dark:text-white">${item.displaySymbol} <span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 font-semibold tabular-nums">RSI: ${(item.triggerRsi || 0).toFixed(1)}</span></span>
                <button onclick="dismissPending('${item.id}')" class="text-slate-400 hover:text-rose-600 text-xs font-semibold cursor-pointer">✕</button>
            </div>
            <div class="text-[10px] text-slate-600 dark:text-slate-300">Tetiklenme: <strong class="text-slate-900 dark:text-white tabular-nums">${formatCryptoPrice(item.triggerPrice)}</strong></div>
            <button onclick="forceEnterFromPending('${item.id}')" class="w-full py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold transition shadow-sm cursor-pointer">Slot Aç & Dahil Et</button>
        </div>`).join('');
}

function clearHistory() {
    if (confirm("İşlem geçmişi sıfırlansın mı?")) {
        KZ_STATE.closedTrades = [];
        KZ_STATE.executedGlobalTrades = [];
        saveClosedTrades();
        renderHistoryTrades();
        recalculateFullPortfolio();
    }
}

function forceEnterFromPending(pendingId) {
    const idx = KZ_STATE.pendingSignals.findIndex(p => p.id === pendingId);
    if (idx === -1) return;
    const pending = KZ_STATE.pendingSignals[idx];
    const coin = KZ_STATE.coins.find(c => c.id === pending.coinId || c.symbol === pending.symbol);
    if (coin && !isCoinMonthlyLocked(coin)) {
        if (openPosition(coin)) {
            renderPendingSignalsList();
        }
    }
}

function dismissPending(pendingId) {
    KZ_STATE.pendingSignals = KZ_STATE.pendingSignals.filter(p => p.id !== pendingId);
    savePending();
    renderPendingSignalsList();
}

function populateDatalist(symbols) {
    const datalist = document.getElementById('coinSuggestions');
    if (!datalist) return;
    datalist.innerHTML = symbols.map(sym => `<option value="${sym}">`).join('');
}

function setupSymbolLiveValidation() {
    const input = document.getElementById('wizardSymbolInput');
    const status = document.getElementById('wizardSymbolStatus');
    const btn = document.getElementById('btnWizardRun');
    if (!input || !status) return;

    input.addEventListener('input', () => {
        let val = input.value.trim().toUpperCase().replace('USDT', '');
        
        if (!val) {
            status.className = "mt-1 text-[11px] text-slate-400 dark:text-slate-500 font-medium";
            status.textContent = "Bir sembol giriniz...";
            if (btn) btn.disabled = true;
            return;
        }

        if (KZ_STATE.validSymbols && KZ_STATE.validSymbols.size > 0) {
            if (KZ_STATE.validSymbols.has(val)) {
                status.className = "mt-1 flex items-center space-x-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400";
                status.innerHTML = `<span>✓ ${val}USDT geçerli (Binance Spot)</span>`;
                if (btn) {
                    btn.disabled = false;
                    btn.classList.remove('opacity-50', 'cursor-not-allowed');
                }
            } else {
                status.className = "mt-1 flex items-center space-x-1 text-[11px] font-semibold text-rose-500";
                status.innerHTML = `<span>✕ "${val}USDT" paritesi Binance'te bulunamadı</span>`;
                if (btn) {
                    btn.disabled = true;
                    btn.classList.add('opacity-50', 'cursor-not-allowed');
                }
            }
        }
    });
}

function toggleCardExpand(coinId) {
    const coin = KZ_STATE.coins.find(c => c.id === coinId || c.symbol === coinId || c.displaySymbol === coinId);
    if (!coin) return;
    coin.isExpanded = !coin.isExpanded;
    if (coin.isExpanded && !coin.simMonthlyStats) runCardBacktest(coin);
    saveCoins();
    renderSingleCard(coin);
}

async function toggleCoinActive(coinId) {
    const coin = KZ_STATE.coins.find(c => c.id === coinId || c.symbol === coinId || c.displaySymbol === coinId);
    if (!coin) return;

    const isCurrentlyActive = coin.isActive !== false;
    if (isCurrentlyActive) {
        const hasOpenPosition = (KZ_STATE.activePositions || []).some(p => p.coinId === coin.id || p.symbol === coin.symbol);
        if (hasOpenPosition) {
            alert(`${coin.displaySymbol} açık pozisyonda. Pasife almadan önce pozisyonu kapatmalısın.`);
            return;
        }

        coin.isActive = false;
        KZ_STATE.pendingSignals = (KZ_STATE.pendingSignals || []).filter(p => p.coinId !== coin.id && p.symbol !== coin.symbol);
        savePending();
    } else {
        coin.isActive = true;
        if (!coin.rawCandles || coin.rawCandles.length === 0) {
            await fetchInitialCandles(coin);
        }
    }

    saveCoins();
    renderSingleCard(coin);
    renderPendingSignalsList();
    initBinanceWebSocket();
    recalculateFullPortfolio();
}

function openWizardForExistingCoin(coinId) {
    const coin = KZ_STATE.coins.find(c => c.id === coinId || c.symbol === coinId || c.displaySymbol === coinId);
    if (!coin) return;
    openAddCoinModal();
    const elSym = document.getElementById('wizardSymbolInput');
    const elInt = document.getElementById('wizardIntervalInput');
    const elRsi = document.getElementById('wizardRsiLengthInput');
    const elPrf = document.getElementById('wizardProfitInput');
    const elCap = document.getElementById('wizardCapInput');

    if (elSym) elSym.value = coin.displaySymbol;
    if (elInt) elInt.value = coin.interval;
    if (elRsi) elRsi.value = coin.rsiLength;
    if (elPrf) elPrf.value = coin.profitTarget;
    if (elCap) elCap.value = coin.monthlyCap;
}

function openCoinFocus(coinId) {
    const coin = KZ_STATE.coins.find(c => c.id === coinId || c.symbol === coinId || c.displaySymbol === coinId);
    if (!coin) return;

    // URL'yi mevcut sayfaya göre kurmak GitHub Pages alt klasörlerinde de çalışır.
    const focusUrl = new URL('coin.html', window.location.href);
    focusUrl.searchParams.set('symbol', coin.symbol);
    window.open(focusUrl.href, `kuzgun_${coin.symbol}`, 'noopener');
}

function deleteCoinCard(id) {
    const coin = KZ_STATE.coins.find(c => c.id === id || c.symbol === id || c.displaySymbol === id);
    const targetId = coin ? coin.id : id;
    
    KZ_STATE.coins = KZ_STATE.coins.filter(c => c.id !== targetId && c.symbol !== targetId);
    KZ_STATE.activePositions = KZ_STATE.activePositions.filter(p => p.coinId !== targetId);
    KZ_STATE.pendingSignals = KZ_STATE.pendingSignals.filter(p => p.coinId !== targetId);
    saveCoins();
    savePositions();
    savePending();
    const el = document.getElementById(`card-${targetId}`);
    if (el) el.remove();
    initBinanceWebSocket();
    recalculateFullPortfolio();
}

function setCardSubTab(coinId, subTab) {
    const coin = KZ_STATE.coins.find(c => c.id === coinId || c.symbol === coinId || c.displaySymbol === coinId);
    if (!coin) return;
    coin.activeSubTab = subTab;
    saveCoins();

    const sliderEl = document.getElementById(`subslider-${coin.id}`);
    if (sliderEl) {
        sliderEl.style.transform = `translateX(-${subTab === 'monthly' ? 0 : 100}%)`;
        const activeSubBtn = "flex-1 py-1 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm font-semibold";
        const inactiveSubBtn = "flex-1 py-1 rounded-md text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 font-medium";

        const btnM = document.getElementById(`subtab-btn-${coin.id}-monthly`);
        const btnT = document.getElementById(`subtab-btn-${coin.id}-trades`);
        if (btnM) btnM.className = subTab === 'monthly' ? activeSubBtn : inactiveSubBtn;
        if (btnT) btnT.className = subTab === 'trades' ? activeSubBtn : inactiveSubBtn;
    }
}

function handleLiveParamChange(coinId) {
    const coin = KZ_STATE.coins.find(c => c.id === coinId || c.symbol === coinId || c.displaySymbol === coinId);
    if (!coin) return;

    coin.buyRsi = parseFloat(document.getElementById(`input-buy-${coin.id}`).value);
    coin.sellRsi = parseFloat(document.getElementById(`input-sell-${coin.id}`).value);
    coin.profitTarget = parseFloat(document.getElementById(`input-profit-${coin.id}`).value);
    coin.monthlyCap = parseFloat(document.getElementById(`input-cap-${coin.id}`).value);
    coin.rsiLength = parseInt(document.getElementById(`input-rsiLen-${coin.id}`).value, 10);

    runCardBacktest(coin);
    saveCoins();
    updateCardTablesOnly(coin);
    recalculateFullPortfolio();
}

async function handleLiveIntervalChange(coinId) {
    const coin = KZ_STATE.coins.find(c => c.id === coinId || c.symbol === coinId || c.displaySymbol === coinId);
    if (!coin) return;
    coin.interval = document.getElementById(`select-interval-${coin.id}`).value;
    saveCoins();
    await fetchInitialCandles(coin);
    initBinanceWebSocket();
    recalculateFullPortfolio();
}

function filterCards(type) {
    KZ_STATE.activeFilter = type;
    const activeClass = 'px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white shadow-sm';
    const inactiveClass = 'px-2.5 py-1 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition';

    document.getElementById('btnFilterAll').className = type === 'all' ? activeClass : inactiveClass;
    document.getElementById('btnFilterPos').className = type === 'position' ? activeClass : inactiveClass;
    document.getElementById('btnFilterLocked').className = type === 'locked' ? activeClass : inactiveClass;
    KZ_STATE.coins.forEach(c => renderSingleCard(c));
}

function openAddCoinModal() {
    wizardResultCard.classList.add('hidden');
    wizardLoadingStatus.classList.add('hidden');
    KZ_STATE.pendingWizardCandidate = null;
    addCoinModal.classList.remove('hidden');
    addCoinModal.classList.add('flex');
}

function closeAddCoinModal() {
    addCoinModal.classList.add('hidden');
    addCoinModal.classList.remove('flex');
}

async function confirmAndAddCoinFromWizard() {
    if (!KZ_STATE.pendingWizardCandidate) return;
    const cand = KZ_STATE.pendingWizardCandidate;
    const existingIdx = KZ_STATE.coins.findIndex(c => c.symbol === cand.symbol);

    if (existingIdx !== -1) {
        Object.assign(KZ_STATE.coins[existingIdx], cand, { isExpanded: false, activeSubTab: 'monthly' });
        saveCoins();
        await fetchInitialCandles(KZ_STATE.coins[existingIdx]);
    } else {
        const newCoin = Object.assign({
            id: 'c_' + Date.now(),
            isActive: true,
            price: 0, prevPrice: 0, high24: 0, low24: 0, rsi: 50.0, prevRsi: 50.0,
            candles: [], isExpanded: false, activeSubTab: 'monthly', avgHoldDurationStr: '--'
        }, cand);
        KZ_STATE.coins.push(newCoin);
        saveCoins();
        renderSingleCard(newCoin);
        await fetchInitialCandles(newCoin);
    }

    closeAddCoinModal();
    initBinanceWebSocket();
    recalculateFullPortfolio();
    playChime(true);
}

// ⚡️ ANLIK CANLI BAKİYE GÜNCELLEYİCİ
function updateLivePortfolioQuick() {
    let unrealizedPnlUsd = 0;
    const currentSlotBudget = (KZ_STATE.cachedRealizedBalance || KZ_STATE.portfolioBaseUsd) / Math.max(1, KZ_STATE.maxSlots);

    (KZ_STATE.activePositions || []).forEach(pos => {
        const coin = KZ_STATE.coins.find(c => c.id === pos.coinId || c.symbol === pos.symbol);
        if (coin && coin.isActive === false) return;
        const currentPrice = coin && coin.price > 0 ? coin.price : pos.entryPrice;
        const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100.0;
        unrealizedPnlUsd += currentSlotBudget * (pnlPercent / 100.0);
    });

    const totalUsd = (KZ_STATE.cachedRealizedBalance || KZ_STATE.portfolioBaseUsd) + unrealizedPnlUsd;
    const totalTry = totalUsd * KZ_STATE.usdtTryRate;

    if (elPortfolioUsd) elPortfolioUsd.textContent = fmtUsd(totalUsd);
    if (elPortfolioTry) elPortfolioTry.textContent = `≈ ${fmtTry(totalTry)}`;
    
    const elDashUsd = document.getElementById('dashCompoundedUsd');
    const elDashTry = document.getElementById('dashCompoundedTry');
    if (elDashUsd) elDashUsd.textContent = fmtUsd(totalUsd);
    if (elDashTry) elDashTry.textContent = `≈ ${fmtTry(totalTry)} TRY`;

    const lastStats = KZ_STATE.lastTimeframeStats;
    if (lastStats) {
        const liveGainUsd = Number(lastStats.realizedUsdtGain || 0) + (lastStats.includeUnrealized ? unrealizedPnlUsd : 0);
        const liveGainTry = liveGainUsd * KZ_STATE.usdtTryRate;
        const liveCapitalPnl = KZ_STATE.portfolioBaseUsd > 0 ? (liveGainUsd / KZ_STATE.portfolioBaseUsd) * 100 : 0;
        const elTfUsd = document.getElementById('dashTfUsdGain');
        const elTfTry = document.getElementById('dashTfTryGain');
        const elTfCapital = document.getElementById('dashTfCapitalPnl');

        if (elTfUsd) {
            elTfUsd.textContent = `${liveGainUsd >= 0 ? '+' : ''}${fmtUsd(liveGainUsd)}`;
            elTfUsd.className = `text-xl font-black tabular-nums ${liveGainUsd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
        }
        if (elTfTry) {
            elTfTry.textContent = `(${liveGainUsd >= 0 ? '+' : ''}${fmtTry(liveGainTry)})`;
            elTfTry.className = `text-xs font-bold tabular-nums ${liveGainUsd >= 0 ? 'text-emerald-600/80 dark:text-emerald-400/80' : 'text-rose-600/80 dark:text-rose-400/80'}`;
        }
        if (elTfCapital) elTfCapital.textContent = `Ana Paraya: ${liveCapitalPnl >= 0 ? '+' : ''}${liveCapitalPnl.toFixed(2)}%`;
    }
}

// REST Fiyat Yedekleme
async function fetchLiveTickerFallback() {
    try {
        const endpoints = [
            'https://api.binance.com/api/v3/ticker/24hr',
            'https://data-api.binance.vision/api/v3/ticker/24hr'
        ];

        let data = null;
        for (const ep of endpoints) {
            try {
                const res = await fetch(ep);
                if (res.ok) {
                    data = await res.json();
                    if (data && data.length > 0) break;
                }
            } catch (e) {}
        }

        if (!data) return;

        const priceMap = {};
        data.forEach(item => {
            priceMap[item.symbol] = {
                price: parseFloat(item.lastPrice),
                high: parseFloat(item.highPrice),
                low: parseFloat(item.lowPrice)
            };
        });

        if (priceMap['BTCUSDT']) {
            KZ_STATE.btcPrice = priceMap['BTCUSDT'].price;
            if (elLiveBtc) elLiveBtc.textContent = fmtUsd(KZ_STATE.btcPrice);
        }

        KZ_STATE.coins.forEach(coin => {
            if (coin.isActive === false) return;
            const info = priceMap[coin.symbol];
            if (info && info.price > 0) {
                // 🎯 REST fiyatı da mum devri ve teyit motoruna iletilir
                processLivePriceUpdate(coin, info.price, info.high, info.low);
            }
        });
    } catch (err) {
        console.warn("REST ticker hatası:", err.message);
    }
}

// Önbellek Destekli Mum Çekici
async function fetchInitialCandles(coin) {
    const year = parseInt(KZ_STATE.selectedYear, 10) || 2026;
    const cacheKey = `kuzgun_candles_${coin.symbol}_${coin.interval}_${year}`;
    const startTime = new Date(Date.UTC(year, 0, 1, 0, 0, 0)).getTime();
    const endTime = year === new Date().getFullYear() 
        ? Date.now() 
        : new Date(Date.UTC(year, 11, 31, 23, 59, 59)).getTime();

    let cached = await CandleCache.get(cacheKey) || [];

    if (cached.length > 0) {
        coin.rawCandles = cached;
        coin.candles = cached.map(c => c.close);
        coin.rsi = calculateRSI(coin.candles, coin.rsiLength);
        coin.prevRsi = coin.rsi;
        const lastCachedPrice = cached[cached.length - 1].close;
        if (lastCachedPrice > 0 && (!coin.price || coin.price === 0)) {
            coin.prevPrice = lastCachedPrice;
            coin.price = lastCachedPrice;
        }
        runCardBacktest(coin);
        renderSingleCard(coin);
    }

    let currentStart = startTime;
    if (cached.length > 0) {
        const lastCachedTime = cached[cached.length - 1].time;
        if (lastCachedTime >= (endTime - 60000)) {
            return;
        }
        currentStart = lastCachedTime + 1;
    }

    const endpoints = [
        'https://data-api.binance.vision/api/v3/klines',
        'https://api.binance.com/api/v3/klines'
    ];

    let newCandles = [];

    try {
        while (currentStart < endTime) {
            let batch = null;
            for (const ep of endpoints) {
                try {
                    const url = `${ep}?symbol=${coin.symbol}&interval=${coin.interval}&startTime=${currentStart}&endTime=${endTime}&limit=1000`;
                    const res = await fetch(url);
                    if (res.ok) {
                        batch = await res.json();
                        if (batch && batch.length > 0) break;
                    }
                } catch (e) {}
            }

            if (!batch || batch.length === 0) break;

            const mapped = batch.map(item => ({
                time: item[0],
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                monthKey: getTurkeyMonthKey(item[0])
            }));

            newCandles.push(...mapped);

            if (batch.length < 1000) break;
            currentStart = batch[batch.length - 1][0] + 1;
        }

        if (newCandles.length > 0) {
            const merged = cached.concat(newCandles);
            const seen = new Set();
            const uniqueCandles = merged.filter(c => {
                if (seen.has(c.time)) return false;
                seen.add(c.time);
                return true;
            });

            coin.rawCandles = uniqueCandles;
            coin.candles = uniqueCandles.map(c => c.close);
            coin.rsi = calculateRSI(coin.candles, coin.rsiLength);
            coin.prevRsi = coin.rsi;

            const latest = coin.candles[coin.candles.length - 1];
            if (latest > 0) {
                coin.prevPrice = latest;
                coin.price = latest;
            }

            await CandleCache.set(cacheKey, uniqueCandles);
            runCardBacktest(coin);
            renderSingleCard(coin);
        }
    } catch (err) {
        console.warn(`Delta mum çekilemedi [${coin.symbol}]:`, err.message);
    }
}

// 🎯 WEBSOCKET: CANLI FİYATI DOĞRUDAN MUM DEVRİ & TEYİT MOTORUNA AKTARIR
function initBinanceWebSocket() {
    if (binanceWs) {
        try { 
            binanceWs.onclose = null;
            binanceWs.close(); 
        } catch(e) {}
    }

    if (!KZ_STATE.coins || KZ_STATE.coins.length === 0) return;

    const streamSet = new Set();
    streamSet.add('btcusdt@miniTicker');
    KZ_STATE.coins.forEach(c => {
        if (c.symbol && c.isActive !== false) streamSet.add(`${c.symbol.toLowerCase()}@miniTicker`);
    });

    const streamPath = Array.from(streamSet).join('/');
    const streamUrl = `wss://stream.binance.com/stream?streams=${streamPath}`;

    try {
        binanceWs = new WebSocket(streamUrl);

        binanceWs.onopen = () => {
            if (elWsStatusDot) elWsStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
            if (elWsStatusText) {
                elWsStatusText.className = 'text-emerald-600 dark:text-emerald-400 font-semibold text-[9px]';
                elWsStatusText.textContent = 'WS';
            }
        };

        binanceWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (!msg || !msg.data) return;
                const d = msg.data;
                const sym = d.s;
                const liveClose = parseFloat(d.c);

                if (sym === 'BTCUSDT') {
                    KZ_STATE.btcPrice = liveClose;
                    if (elLiveBtc) elLiveBtc.textContent = fmtUsd(liveClose);
                }

                const coin = KZ_STATE.coins.find(c => c.symbol === sym);
                if (coin && coin.isActive !== false && liveClose > 0) {
                    // 🎯 Mum devri, kesinleşmiş teyit ve fiyat akışı tek merkezden yönetilir
                    processLivePriceUpdate(coin, liveClose, parseFloat(d.h), parseFloat(d.l));
                }
            } catch (e) {}
        };

        binanceWs.onclose = () => {
            if (elWsStatusDot) elWsStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping';
            if (elWsStatusText) {
                elWsStatusText.className = 'text-amber-600 dark:text-amber-400 font-semibold text-[9px]';
                elWsStatusText.textContent = 'WS..';
            }
            setTimeout(initBinanceWebSocket, 3500);
        };
    } catch (e) {
        setTimeout(initBinanceWebSocket, 3500);
    }
}

async function fetchBinanceSpotSymbols() {
    try {
        const res = await fetch('https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT');
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.symbols) {
            const symbols = data.symbols
                .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
                .map(s => s.baseAsset);
                
            KZ_STATE.validSymbols = new Set(symbols);
            populateDatalist(symbols);
        }
    } catch (err) {}
}

async function fetchJsonWithTimeout(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchKlinePage(symbol, interval, startTime, endTime) {
    // Ana Binance uç noktası genellikle GitHub Pages üzerinde daha hızlıdır.
    // Arşiv uç noktası yalnızca yedek olarak denenir.
    const endpoints = [
        'https://api.binance.com/api/v3/klines',
        'https://data-api.binance.vision/api/v3/klines'
    ];

    let lastError = null;
    for (const endpoint of endpoints) {
        try {
            const url = `${endpoint}?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
            const batch = await fetchJsonWithTimeout(url);
            return Array.isArray(batch) ? batch : [];
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('Binance mum verisi alınamadı.');
}

async function fetchAllCandlesForYear(symbol, interval, year, onProgress = null) {
    const startTime = new Date(Date.UTC(year, 0, 1, 0, 0, 0)).getTime();
    const endTime = year === new Date().getFullYear() 
        ? Date.now() 
        : new Date(Date.UTC(year, 11, 31, 23, 59, 59)).getTime();

    const cacheKey = `kuzgun_candles_${symbol}_${interval}_${year}`;
    const cached = (await CandleCache.get(cacheKey) || [])
        .filter(c => c.time >= startTime && c.time <= endTime)
        .sort((a, b) => a.time - b.time);

    // Son önbellek mumunu tekrar çekerek açık mumun OHLC değerlerini de tazeleriz.
    const missingStart = cached.length > 0
        ? Math.max(startTime, cached[cached.length - 1].time)
        : startTime;
    const intervalMs = getIntervalMilliseconds(interval);
    const pageSpanMs = intervalMs * 1000;
    const pages = [];

    for (let pageStart = missingStart; pageStart <= endTime; pageStart += pageSpanMs) {
        pages.push({
            start: pageStart,
            end: Math.min(endTime, pageStart + pageSpanMs - 1)
        });
    }

    if (pages.length === 0) return cached;

    const downloaded = [];
    let nextPageIndex = 0;
    let completedPages = 0;
    const workerCount = Math.min(6, pages.length);

    async function downloadWorker() {
        while (nextPageIndex < pages.length) {
            const page = pages[nextPageIndex++];
            const batch = await fetchKlinePage(symbol, interval, page.start, page.end);
            downloaded.push(...batch.map(item => ({
                time: item[0],
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                monthKey: getTurkeyMonthKey(item[0])
            })));
            completedPages++;
            if (onProgress) onProgress(completedPages, pages.length, cached.length > 0);
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => downloadWorker()));

    const candleMap = new Map();
    cached.forEach(candle => candleMap.set(candle.time, candle));
    downloaded.forEach(candle => candleMap.set(candle.time, candle));
    const allCandles = Array.from(candleMap.values())
        .filter(c => c.time >= startTime && c.time <= endTime)
        .sort((a, b) => a.time - b.time);

    await CandleCache.set(cacheKey, allCandles);
    return allCandles;
}

async function runWizardForNewCoin() {
    let rawSym = document.getElementById('wizardSymbolInput').value.trim().toUpperCase();
    if (!rawSym) {
        alert("Lütfen bir coin sembolü girin");
        return;
    }
    if (!rawSym.endsWith('USDT')) rawSym += 'USDT';

    const interval = document.getElementById('wizardIntervalInput').value;
    const rsiLength = parseInt(document.getElementById('wizardRsiLengthInput').value, 10) || 6;
    const profitTarget = parseFloat(document.getElementById('wizardProfitInput').value) || 0.6;
    const monthlyCap = parseFloat(document.getElementById('wizardCapInput').value) || 3.6;

    const btn = document.getElementById('btnWizardRun');
    wizardLoadingStatus.classList.remove('hidden');
    wizardLoadingStatus.textContent = `${KZ_STATE.selectedYear} yılı tüm mum verisi taranıyor (Binance)...`;
    btn.disabled = true;

    try {
        const targetYear = parseInt(KZ_STATE.selectedYear, 10) || 2026;
        const allCandles = await fetchAllCandlesForYear(rawSym, interval, targetYear, (done, total, fromCache) => {
            const percent = Math.round((done / total) * 100);
            wizardLoadingStatus.textContent = fromCache
                ? `Önbellek güncelleniyor... %${percent}`
                : `Mum verileri indiriliyor... %${percent}`;
        });
        if (!allCandles || allCandles.length < (rsiLength + 10)) {
            throw new Error("Yeterli mum verisi alınamadı.");
        }

        wizardLoadingStatus.textContent = `${allCandles.length.toLocaleString('tr-TR')} mum üzerinde AL/SAT değerleri hesaplanıyor...`;
        const closePrices = allCandles.map(c => c.close);
        const rsiValues = calculateRSIHistory(closePrices, rsiLength);
        let bestCandidate = null;

        for (let buy = 10; buy <= 35; buy += 1) {
            for (let sell = 65; sell <= 92; sell += 1) {
                let inPos = false;
                let entryPrice = 0.0;
                let totPnl = 0.0;
                let winCount = 0;
                let lossCount = 0;
                let totalTrades = 0;
                let monthlyStats = {};

                for (let i = rsiLength + 1; i < allCandles.length; i++) {
                    const c = allCandles[i];
                    const rsi = rsiValues[i];
                    const prevRsi = rsiValues[i - 1];
                    if (rsi === null || prevRsi === null) continue;

                    const mKey = c.monthKey;
                    if (!monthlyStats[mKey]) monthlyStats[mKey] = { pnl: 0.0, isLocked: false };
                    const isCapReached = (monthlyStats[mKey].pnl + 0.001) >= monthlyCap;

                    if (!inPos && !isCapReached) {
                        if (prevRsi <= buy && rsi > buy) {
                            inPos = true;
                            entryPrice = c.close;
                        }
                    } else if (inPos) {
                        const targetPrice = entryPrice * (1.0 + profitTarget / 100.0);
                        let exited = false;
                        let pnl = 0.0;

                        if (c.high >= targetPrice) {
                            exited = true;
                            pnl = profitTarget;
                        } else if (rsi >= sell) {
                            exited = true;
                            pnl = ((c.close - entryPrice) / entryPrice) * 100.0;
                        }

                        if (exited) {
                            inPos = false;
                            totalTrades++;
                            if (pnl >= 0) winCount++; else lossCount++;
                            totPnl += pnl;

                            monthlyStats[mKey].pnl += pnl;
                            if ((monthlyStats[mKey].pnl + 0.001) >= monthlyCap) {
                                monthlyStats[mKey].isLocked = true;
                            }
                        }
                    }
                }

                if (totalTrades >= 1) {
                    const winRate = (winCount / totalTrades) * 100.0;
                    const score = totPnl * Math.pow(winRate / 100.0, 1.5);
                    if (!bestCandidate || score > bestCandidate.score) {
                        bestCandidate = { buyRsi: buy, sellRsi: sell, winRate, lossCount, totalTrades, netPnl: totPnl, score };
                    }
                }
            }

            // Uzun 5m taramalarında arayüzün donmasını engeller ve ilerlemeyi gösterir.
            const scanPercent = Math.round(((buy - 9) / 26) * 100);
            wizardLoadingStatus.textContent = `Stratejiler karşılaştırılıyor... %${scanPercent}`;
            if ((buy - 10) % 2 === 1) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }

        if (bestCandidate) {
            KZ_STATE.pendingWizardCandidate = {
                symbol: rawSym,
                displaySymbol: rawSym.replace('USDT', ''),
                interval,
                rsiLength,
                buyRsi: bestCandidate.buyRsi,
                sellRsi: bestCandidate.sellRsi,
                profitTarget,
                monthlyCap
            };

            document.getElementById('wizardResultSymbol').textContent = `${rawSym} (${interval} | RSI ${rsiLength})`;
            document.getElementById('wizardResultTargetDisplay').textContent = `%${profitTarget.toFixed(1)} (Kilit: %${monthlyCap.toFixed(1)})`;
            document.getElementById('wizardResultWinRate').textContent = `%${bestCandidate.winRate.toFixed(0)}`;
            document.getElementById('wizardResultBuyRsi').textContent = `${bestCandidate.buyRsi}`;
            document.getElementById('wizardResultSellRsi').textContent = `${bestCandidate.sellRsi}`;
            document.getElementById('wizardResultLosses').textContent = `${bestCandidate.lossCount} Kayıp`;
            document.getElementById('wizardResultTrades').textContent = `${bestCandidate.totalTrades} İşlem`;
            document.getElementById('wizardResultPnl').textContent = `${bestCandidate.netPnl >= 0 ? '+' : ''}${bestCandidate.netPnl.toFixed(2)}%`;

            wizardLoadingStatus.classList.add('hidden');
            wizardResultCard.classList.remove('hidden');
            playChime(true);
        } else {
            alert("Kriterlere uygun işlem bulunamadı.");
        }
    } catch (err) {
        alert("Hata: " + err.message);
        wizardLoadingStatus.classList.add('hidden');
    } finally {
        btn.disabled = false;
    }
}

async function fetchMarketRate() {
    try {
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTTRY');
        if (res.ok) {
            const data = await res.json();
            if (data && data.price) {
                KZ_STATE.usdtTryRate = parseFloat(data.price) || 36.50;
                if (elLiveTry) elLiveTry.textContent = fmtTry(KZ_STATE.usdtTryRate);
                updateLivePortfolioQuick();
            }
        }
    } catch (e) {}
}

function openPosition(coin, customPrice = null, customTime = null) {
    if (!coin || coin.isActive === false || isCoinMonthlyLocked(coin)) return false;
    const alreadyOpen = KZ_STATE.activePositions.some(p => p.coinId === coin.id || p.symbol === coin.symbol);
    if (alreadyOpen) return false;
    const entryP = customPrice || coin.price;
    const posTime = customTime || Date.now();
    const availableBalance = Number(KZ_STATE.cachedRealizedBalance) > 0
        ? Number(KZ_STATE.cachedRealizedBalance)
        : KZ_STATE.portfolioBaseUsd;
    const slotBudget = availableBalance / Math.max(1, KZ_STATE.maxSlots);

    KZ_STATE.activePositions.push({
        id: 'pos_' + Date.now(),
        coinId: coin.id,
        symbol: coin.symbol,
        displaySymbol: coin.displaySymbol,
        entryPrice: entryP,
        targetPrice: entryP * (1.0 + (coin.profitTarget / 100.0)),
        profitTarget: coin.profitTarget,
        allocatedUsd: slotBudget,
        allocationVersion: 2,
        entryTime: posTime,
        livePnlPercent: 0,
        livePnlUsd: 0
    });

    KZ_STATE.pendingSignals = KZ_STATE.pendingSignals.filter(p => p.coinId !== coin.id && p.symbol !== coin.symbol);
    savePending();
    savePositions();
    renderActivePositionsList();
    renderPendingSignalsList();
    recalculateFullPortfolio();
    return true;
}

function closePosition(positionId, reason = 'Manuel Kapatıldı') {
    const idx = KZ_STATE.activePositions.findIndex(p => p.id === positionId);
    if (idx === -1) return;

    const pos = KZ_STATE.activePositions[idx];
    const exitPnlUsd = pos.livePnlUsd;
    KZ_STATE.portfolioBaseUsd += exitPnlUsd;

    const now = new Date();
    KZ_STATE.closedTrades.unshift({
        id: 'trade_' + Date.now(),
        coinId: pos.coinId,
        symbol: pos.symbol,
        displaySymbol: pos.displaySymbol,
        entryPrice: pos.entryPrice,
        exitPrice: (pos.coinId && KZ_STATE.coins.find(c => c.id === pos.coinId)?.price) || pos.targetPrice,
        pnlPercent: pos.livePnlPercent,
        pnlUsd: exitPnlUsd,
        reason: reason,
        entryTime: pos.entryTime,
        exitTime: now.getTime(),
        entryTimeStr: new Date(pos.entryTime).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        exitTimeStr: now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        exitMonth: getTurkeyMonthKey(now),
        isManual: pos.isManual === true,
        source: pos.isManual === true ? 'manual' : (pos.source || 'automatic')
    });

    KZ_STATE.activePositions.splice(idx, 1);
    savePositions();
    saveClosedTrades();

    if (KZ_STATE.pendingSignals.length > 0 && KZ_STATE.activePositions.length < KZ_STATE.maxSlots) {
        const next = KZ_STATE.pendingSignals.shift();
        savePending();
        const coin = KZ_STATE.coins.find(c => c.id === next.coinId || c.symbol === next.symbol);
        if (coin && !isCoinMonthlyLocked(coin)) {
            openPosition(coin, coin.price || next.triggerPrice);
        }
    }

    renderActivePositionsList();
    renderPendingSignalsList();
    recalculateFullPortfolio();
}

function loadStorage() {
    const savedCoins = localStorage.getItem('kuzgun_web_coins');
    if (savedCoins) {
        try { KZ_STATE.coins = JSON.parse(savedCoins); } catch (e) { KZ_STATE.coins = []; }
    }
    if (!KZ_STATE.coins || KZ_STATE.coins.length === 0) {
        KZ_STATE.coins = [
            { id: 'c_sol', symbol: 'SOLUSDT', displaySymbol: 'SOL', isActive: true, interval: '30m', rsiLength: 14, buyRsi: 30, sellRsi: 70, profitTarget: 1.5, monthlyCap: 10.0, price: 0, prevPrice: 0, high24: 0, low24: 0, rsi: 50.0, prevRsi: 50.0, candles: [], isExpanded: false, activeSubTab: 'monthly', avgHoldDurationStr: '--' },
            { id: 'c_btc', symbol: 'BTCUSDT', displaySymbol: 'BTC', isActive: true, interval: '15m', rsiLength: 14, buyRsi: 28, sellRsi: 72, profitTarget: 2.0, monthlyCap: 8.0, price: 0, prevPrice: 0, high24: 0, low24: 0, rsi: 50.0, prevRsi: 50.0, candles: [], isExpanded: false, activeSubTab: 'monthly', avgHoldDurationStr: '--' }
        ];
        saveCoins();
    } else {
        let needsSave = false;
        KZ_STATE.coins.forEach((c, idx) => {
            if (c.isActive === undefined) {
                c.isActive = true;
                needsSave = true;
            }
            if (!c.id) {
                c.id = 'c_' + (c.displaySymbol || c.symbol || idx).toLowerCase() + '_' + idx;
                needsSave = true;
            }
        });
        if (needsSave) saveCoins();
    }

    const savedSlots = localStorage.getItem('kuzgun_max_slots');
    if (savedSlots) {
        KZ_STATE.maxSlots = parseInt(savedSlots, 10) || 2;
        if (elSlotSelector) elSlotSelector.value = KZ_STATE.maxSlots;
    }

    const savedYear = localStorage.getItem('kuzgun_selected_year');
    if (savedYear) {
        KZ_STATE.selectedYear = savedYear;
        const sel = document.getElementById('headerYearSelector');
        if (sel) sel.value = savedYear;
    }

    if (!localStorage.getItem('kuzgun_portfolio_start_date')) {
        const yearInt = parseInt(KZ_STATE.selectedYear, 10) || 2026;
        const defTs = new Date(yearInt, 0, 1, 0, 0, 0).getTime() / 1000;
        localStorage.setItem('kuzgun_portfolio_start_date', defTs.toString());
    }

    const savedBase = localStorage.getItem('kuzgun_base_usd');
    if (savedBase) KZ_STATE.portfolioBaseUsd = parseFloat(savedBase) || 1000.00;

    const savedPositions = localStorage.getItem('kuzgun_active_pos');
    if (savedPositions) {
        try { KZ_STATE.activePositions = JSON.parse(savedPositions); } catch(e) {}
    }

    const savedPending = localStorage.getItem('kuzgun_pending_signals');
    if (savedPending) {
        try { KZ_STATE.pendingSignals = JSON.parse(savedPending); } catch(e) {}
    }

    const savedClosedTrades = localStorage.getItem('kuzgun_closed_trades');
    if (savedClosedTrades) {
        try { KZ_STATE.closedTrades = JSON.parse(savedClosedTrades); } catch(e) {}
    }
}

function saveCoins() {
    try {
        const sanitized = KZ_STATE.coins.map(c => ({
            id: c.id,
            symbol: c.symbol,
            displaySymbol: c.displaySymbol,
            interval: c.interval,
            rsiLength: c.rsiLength,
            buyRsi: c.buyRsi,
            sellRsi: c.sellRsi,
            profitTarget: c.profitTarget,
            monthlyCap: c.monthlyCap,
            isActive: c.isActive !== false,
            isExpanded: !!c.isExpanded,
            activeSubTab: c.activeSubTab || 'monthly'
        }));
        localStorage.setItem('kuzgun_web_coins', JSON.stringify(sanitized));
        notifyKuzgunTabs('coins-updated');
    } catch (e) {
        console.warn("LocalStorage kotası korundu:", e);
    }
}

function savePositions() { 
    try {
        localStorage.setItem('kuzgun_active_pos', JSON.stringify(KZ_STATE.activePositions));
        localStorage.setItem('kuzgun_base_usd', KZ_STATE.portfolioBaseUsd.toString());
    } catch (e) {}
}

function savePending() { 
    try {
        localStorage.setItem('kuzgun_pending_signals', JSON.stringify(KZ_STATE.pendingSignals)); 
    } catch (e) {}
}

function saveClosedTrades() { 
    try {
        localStorage.setItem('kuzgun_closed_trades', JSON.stringify(KZ_STATE.closedTrades)); 
    } catch (e) {}
}

function changeMaxSlots(newSlots) {
    KZ_STATE.maxSlots = parseInt(newSlots, 10) || 2;
    localStorage.setItem('kuzgun_max_slots', KZ_STATE.maxSlots.toString());
    recalculateFullPortfolio();
}

function recalculateFullPortfolio() {
    const isSlotConstraint = localStorage.getItem('kuzgun_slot_constraint_enabled') !== 'false';
    const isFeeDeduction = localStorage.getItem('kuzgun_fee_deduction_enabled') !== 'false';
    const startTs = parseFloat(localStorage.getItem('kuzgun_portfolio_start_date')) || 0;

    const allRawTrades = [];
    const inactiveCoinIds = new Set(KZ_STATE.coins.filter(c => c.isActive === false).map(c => c.id));
    const inactiveSymbols = new Set(KZ_STATE.coins.filter(c => c.isActive === false).map(c => c.symbol));

    (KZ_STATE.closedTrades || []).forEach(t => {
        if (inactiveCoinIds.has(t.coinId) || inactiveSymbols.has(t.symbol)) return;
        allRawTrades.push({
            id: t.id,
            coinId: t.coinId,
            symbol: t.symbol,
            entryTime: t.entryTime || (t.exitTime - 3600000),
            exitTime: t.exitTime || Date.now(),
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            pnlPercent: t.pnlPercent,
            reason: t.reason,
            isManual: t.isManual === true,
            source: t.source || (t.isManual ? 'manual' : 'automatic')
        });
    });

    KZ_STATE.coins.forEach(coin => {
        if (coin.isActive === false) return;
        if (coin.simMonthlyStats) {
            coin.simMonthlyStats.forEach(m => {
                if (m.tradesList) {
                    m.tradesList.forEach(t => {
                        allRawTrades.push({
                            id: t.id,
                            coinId: coin.id,
                            symbol: coin.symbol,
                            entryTime: t.entryTime,
                            exitTime: t.exitTime,
                            entryPrice: t.entryPrice,
                            exitPrice: t.exitPrice,
                            pnlPercent: t.pnl,
                            monthKey: m.monthKey,
                            reason: t.reason
                        });
                    });
                }
            });
        }
    });

    if (typeof PortfolioEngine !== 'undefined') {
        const engineArgs = {
            baseBalance: KZ_STATE.portfolioBaseUsd,
            maxSlots: KZ_STATE.maxSlots,
            trades: allRawTrades,
            activePositions: KZ_STATE.activePositions.filter(pos => !inactiveCoinIds.has(pos.coinId) && !inactiveSymbols.has(pos.symbol)),
            coins: KZ_STATE.coins.filter(c => c.isActive !== false),
            isSlotConstraintEnabled: isSlotConstraint,
            isFeeDeductionEnabled: isFeeDeduction,
            startDateTimestamp: startTs,
            selectedYear: KZ_STATE.selectedYear
        };

        let engineResult = PortfolioEngine.calculateCompoundedBalance(engineArgs);

        // Eski sürümde açık pozisyon bütçesi başlangıç parasından ayrılıyordu.
        // Bir defalık geçişle tek/çoklu slot bütçesini güncel gerçekleşmiş
        // bileşik bakiyeye göre düzelt ve yeniden hesapla.
        const legacyPositions = engineArgs.activePositions.filter(pos => pos.allocationVersion !== 2);
        if (legacyPositions.length > 0) {
            const correctedSlotBudget = engineResult.realizedBalance / Math.max(1, KZ_STATE.maxSlots);
            legacyPositions.forEach(pos => {
                pos.allocatedUsd = correctedSlotBudget;
                pos.allocationVersion = 2;
                const coin = KZ_STATE.coins.find(c => c.id === pos.coinId || c.symbol === pos.symbol);
                const currentPrice = coin && coin.price > 0 ? coin.price : pos.entryPrice;
                pos.livePnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
                pos.livePnlUsd = correctedSlotBudget * (pos.livePnlPercent / 100);
            });
            savePositions();
            engineResult = PortfolioEngine.calculateCompoundedBalance(engineArgs);
            renderActivePositionsList();
        }

        KZ_STATE.acceptedTradeIds = engineResult.acceptedTradeIds;
        KZ_STATE.coinRealStats = engineResult.coinRealStats;
        KZ_STATE.cachedRealizedBalance = engineResult.realizedBalance;
        KZ_STATE.executedGlobalTrades = engineResult.executedTrades;

        const tfStats = PortfolioEngine.calculateTimeframeStats({
            executedTrades: engineResult.executedTrades,
            timeframe: KZ_STATE.selectedTimeframe,
            selectedMonthIndex: KZ_STATE.selectedTimeframeMonth,
            selectedYear: KZ_STATE.selectedYear,
            startDateTimestamp: startTs,
            customStartDate: KZ_STATE.customStartDate,
            customEndDate: KZ_STATE.customEndDate,
            initialBalance: KZ_STATE.portfolioBaseUsd,
            unrealizedPnlUSD: engineResult.unrealizedPnlUSD
        });

        KZ_STATE.lastTimeframeStats = tfStats;

        renderPortfolioShowcaseUI(engineResult, tfStats);
        renderHistoryTrades();

        KZ_STATE.coins.forEach(coin => updateCardTablesOnly(coin));
    }
}

function renderPortfolioShowcaseUI(engineResult, tfStats) {
    const totalUsd = engineResult.compoundedBalance;
    const totalTry = totalUsd * KZ_STATE.usdtTryRate;
    const gainTry = tfStats.usdtGain * KZ_STATE.usdtTryRate;

    if (elPortfolioUsd) elPortfolioUsd.textContent = fmtUsd(totalUsd);
    if (elPortfolioTry) elPortfolioTry.textContent = `≈ ${fmtTry(totalTry)}`;
    if (elSlotCountDisplay) elSlotCountDisplay.textContent = `${KZ_STATE.activePositions.length}/${KZ_STATE.maxSlots}`;

    const elDashUsd = document.getElementById('dashCompoundedUsd');
    const elDashTry = document.getElementById('dashCompoundedTry');
    const elDashSlotBadge = document.getElementById('dashboardSlotBadge');
    
    if (elDashUsd) elDashUsd.textContent = fmtUsd(totalUsd);
    if (elDashTry) elDashTry.textContent = `≈ ${fmtTry(totalTry)} TRY`;
    if (elDashSlotBadge) elDashSlotBadge.textContent = `${KZ_STATE.activePositions.length}/${KZ_STATE.maxSlots} SLOT`;

    const elTfUsd = document.getElementById('dashTfUsdGain');
    const elTfTry = document.getElementById('dashTfTryGain');
    const elTfDirect = document.getElementById('dashTfDirectPnl');
    const elTfNet = document.getElementById('dashTfNetPnl');
    const elTfCapital = document.getElementById('dashTfCapitalPnl');
    const elTfFees = document.getElementById('dashTfFeesBadge');

    if (elTfUsd) {
        elTfUsd.textContent = `${tfStats.usdtGain >= 0 ? '+' : ''}${fmtUsd(tfStats.usdtGain)}`;
        elTfUsd.className = `text-xl font-black tabular-nums ${tfStats.usdtGain >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`;
    }

    if (elTfTry) {
        elTfTry.textContent = `(${tfStats.usdtGain >= 0 ? '+' : ''}${fmtTry(gainTry)})`;
        elTfTry.className = `text-xs font-bold tabular-nums ${tfStats.usdtGain >= 0 ? 'text-emerald-600/80 dark:text-emerald-400/80' : 'text-rose-600/80 dark:text-rose-400/80'}`;
    }

    if (elTfDirect) {
        elTfDirect.textContent = `Brüt Getiri: ${tfStats.directTradePnlSum >= 0 ? '+' : ''}${tfStats.directTradePnlSum.toFixed(2)}%`;
        elTfDirect.className = `px-2 py-0.5 rounded border text-[10px] font-bold ${tfStats.directTradePnlSum >= 0 ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800' : 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800'}`;
    }

    if (elTfNet) {
        const netTradePnl = Number(tfStats.netTradePnlSum || 0);
        elTfNet.textContent = `Net Getiri: ${netTradePnl >= 0 ? '+' : ''}${netTradePnl.toFixed(2)}%`;
        elTfNet.className = `px-2 py-0.5 rounded border text-[10px] font-bold ${netTradePnl >= 0 ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-600 dark:text-teal-400 border-teal-200 dark:border-teal-800' : 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800'}`;
    }

    if (elTfCapital) {
        elTfCapital.textContent = `Ana Paraya: ${tfStats.initialPnlPercentage >= 0 ? '+' : ''}${tfStats.initialPnlPercentage.toFixed(2)}%`;
    }

    if (elTfFees) {
        if (tfStats.totalFeesUSD > 0) {
            elTfFees.classList.remove('hidden');
            elTfFees.textContent = `Komisyon: -${fmtUsd(tfStats.totalFeesUSD)}`;
        } else {
            elTfFees.classList.add('hidden');
        }
    }
}

function changePortfolioTimeframe(tf) {
    KZ_STATE.selectedTimeframe = tf;

    const startTs = parseFloat(localStorage.getItem('kuzgun_portfolio_start_date'));
    let startDateFormatted = '';
    if (startTs) {
        const d = new Date(startTs * 1000);
        startDateFormatted = ` (${d.getDate().toString().padStart(2, '0')}.${(d.getMonth()+1).toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')})`;
    }

    const labels = {
        sinceStart: `Sermaye Başlangıcından Beri${startDateFormatted}`,
        today: 'Bugün Net Kazanç',
        week: 'Bu Hafta Net Kazanç',
        month: 'Bu Ay Net Kazanç',
        selectMonth: 'Seçili Ay Net Kazanç',
        custom: 'Özel Aralık Net Kazanç'
    };

    const labelEl = document.getElementById('dashTimeframeLabel');
    if (labelEl) labelEl.textContent = labels[tf] || 'Net Kazanç';

    const activeClass = "px-3 py-1.5 rounded-xl text-xs font-bold bg-blue-600 text-white shadow-sm transition shrink-0 cursor-pointer";
    const inactiveClass = "px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition shrink-0 cursor-pointer";

    document.querySelectorAll('#timeframeButtonGroup button').forEach(btn => {
        btn.className = (btn.dataset.tf === tf) ? activeClass : inactiveClass;
    });

    const subMonthBox = document.getElementById('subMonthPills');
    if (tf === 'selectMonth') {
        renderSubMonthPills();
        if (subMonthBox) subMonthBox.classList.remove('hidden');
    } else {
        if (subMonthBox) subMonthBox.classList.add('hidden');
    }

    recalculateFullPortfolio();
}

function renderSubMonthPills() {
    const subMonthBox = document.getElementById('subMonthPills');
    if (!subMonthBox) return;

    const monthNames = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    
    subMonthBox.innerHTML = monthNames.map((name, idx) => {
        const mNum = idx + 1;
        const isSelected = KZ_STATE.selectedTimeframeMonth === mNum;
        return `
            <button onclick="selectTimeframeMonth(${mNum})" 
                class="px-2.5 py-1 rounded-lg text-xs font-bold shrink-0 transition cursor-pointer ${isSelected ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200'}">
                ${name}
            </button>
        `;
    }).join('');
}

function selectTimeframeMonth(mNum) {
    KZ_STATE.selectedTimeframeMonth = mNum;
    renderSubMonthPills();
    recalculateFullPortfolio();
}

function openCustomDateRangeModal() {
    const modal = document.getElementById('customRangeModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeCustomDateRangeModal() {
    const modal = document.getElementById('customRangeModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

function applyCustomDateRange() {
    const startVal = document.getElementById('inputCustomStart').value;
    const endVal = document.getElementById('inputCustomEnd').value;

    if (startVal && endVal) {
        KZ_STATE.customStartDate = startVal;
        KZ_STATE.customEndDate = endVal;
        closeCustomDateRangeModal();
        changePortfolioTimeframe('custom');
    }
}

// 🎯 GLOBAL WINDOW BAĞLANTILARI
window.toggleCardExpand = toggleCardExpand;
window.toggleCoinActive = toggleCoinActive;
window.editPositionEntryPrice = editPositionEntryPrice;
window.openCoinFocus = openCoinFocus;
window.openWizardForExistingCoin = openWizardForExistingCoin;
window.deleteCoinCard = deleteCoinCard;
window.setCardSubTab = setCardSubTab;
window.handleLiveParamChange = handleLiveParamChange;
window.handleLiveIntervalChange = handleLiveIntervalChange;
window.openMonthTradesModal = openMonthTradesModal;
window.selectModalMonth = selectModalMonth;
window.closeMonthTradesModal = closeMonthTradesModal;
window.openCustomDateRangeModal = openCustomDateRangeModal;
window.closeCustomDateRangeModal = closeCustomDateRangeModal;
window.applyCustomDateRange = applyCustomDateRange;
window.changePortfolioTimeframe = changePortfolioTimeframe;
window.selectTimeframeMonth = selectTimeframeMonth;
window.setHistoryPage = setHistoryPage;
window.prevHistoryPage = prevHistoryPage;
window.nextHistoryPage = nextHistoryPage;
window.clearHistory = clearHistory;
window.openAddCoinModal = openAddCoinModal;
window.closeAddCoinModal = closeAddCoinModal;
window.confirmAndAddCoinFromWizard = confirmAndAddCoinFromWizard;
window.runWizardForNewCoin = runWizardForNewCoin;
window.filterCards = filterCards;
window.changeMaxSlots = changeMaxSlots;
window.changeYearFromHeader = changeYearFromHeader;
window.closePosition = closePosition;
window.forceEnterFromPending = forceEnterFromPending;
window.dismissPending = dismissPending;
window.openManualPositionModal = openManualPositionModal;
window.closeManualPositionModal = closeManualPositionModal;
window.submitManualPosition = submitManualPosition;
window.resolveBuySignalDecision = resolveBuySignalDecision;

function syncMainAppFromStorage(event) {
    const key = event && event.key;
    if (key && !['kuzgun_web_coins', 'kuzgun_active_pos', 'kuzgun_closed_trades', 'kuzgun_theme'].includes(key)) return;

    if (!key || key === 'kuzgun_web_coins') {
        try {
            const saved = JSON.parse(localStorage.getItem('kuzgun_web_coins')) || [];
            saved.forEach(savedCoin => {
                const liveCoin = KZ_STATE.coins.find(c => c.id === savedCoin.id || c.symbol === savedCoin.symbol);
                if (liveCoin) Object.assign(liveCoin, savedCoin);
            });
            KZ_STATE.coins.forEach(c => renderSingleCard(c));
        } catch (e) {}
    }

    if (!key || key === 'kuzgun_active_pos') {
        try { KZ_STATE.activePositions = JSON.parse(localStorage.getItem('kuzgun_active_pos')) || []; } catch (e) {}
        renderActivePositionsList();
        KZ_STATE.coins.forEach(c => renderSingleCard(c));
    }

    if (!key || key === 'kuzgun_closed_trades') {
        try { KZ_STATE.closedTrades = JSON.parse(localStorage.getItem('kuzgun_closed_trades')) || []; } catch (e) {}
        renderHistoryTrades();
        recalculateFullPortfolio();
    }
}

window.addEventListener('storage', syncMainAppFromStorage);
if (kuzgunSyncChannel) kuzgunSyncChannel.addEventListener('message', () => syncMainAppFromStorage());

// Başlatıcı
async function startEngine() {
    loadStorage();

    KZ_STATE.coins.forEach(c => renderSingleCard(c));
    renderActivePositionsList();
    renderPendingSignalsList();
    renderHistoryTrades();

    await Promise.all(KZ_STATE.coins.filter(coin => coin.isActive !== false).map(coin => fetchInitialCandles(coin)));
    recalculateFullPortfolio();

    await fetchLiveTickerFallback();
    fetchMarketRate();

    initBinanceWebSocket();
    fetchBinanceSpotSymbols();
    setupSymbolLiveValidation();

    setInterval(fetchMarketRate, 10000);
    setInterval(fetchLiveTickerFallback, 5000);
    setInterval(renderHistoryTrades, 30000);

    if (window.location.search.includes('openWizard=true')) {
        setTimeout(() => {
            openAddCoinModal();
            window.history.replaceState({}, document.title, window.location.pathname);
        }, 250);
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeMonthTradesModal();
        closeCustomDateRangeModal();
        closeAddCoinModal();
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startEngine);
} else {
    startEngine();
}
