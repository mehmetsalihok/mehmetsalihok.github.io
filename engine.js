window.terminalState = window.terminalState || {
    portfolioBaseUsd: 1000.00,
    usdtTryRate: 36.50,
    btcPrice: 0.00,
    maxSlots: 2,
    coins: [],
    validSymbols: new Set(),
    activePositions: [],
    pendingSignals: [],
    closedTrades: [],
    activeFilter: 'all',
    pendingWizardCandidate: null
};
const terminalState = window.terminalState;

let binanceWs = null;
let wsEndpointIndex = 0;
// Port 9443 engeline takılmayan standart 443 portlu WebSocket uçları
const WS_ENDPOINTS = [
    'wss://stream.binance.com/stream?streams=',
    'wss://data-stream.binance.vision/stream?streams='
];

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
    const currentMonthStr = new Date().toISOString().slice(0, 7);
    const currentMonthTrades = (terminalState.closedTrades || []).filter(t => t.coinId === coin.id && t.exitMonth === currentMonthStr);
    const totalMonthPnl = currentMonthTrades.reduce((sum, t) => sum + t.pnlPercent, 0);
    return (totalMonthPnl + 0.001) >= coin.monthlyCap;
}

function runCardBacktest(coin) {
    const monthNames = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    const currentYear = 2026;
    const currentMonthIdx = 8;

    const monthlyMap = {};
    for (let m = 0; m <= currentMonthIdx; m++) {
        const mKey = `${currentYear}-${String(m + 1).padStart(2, '0')}`;
        monthlyMap[mKey] = { monthKey: mKey, name: monthNames[m], trades: 0, pnl: 0, isLocked: false };
    }

    if (!coin.rawCandles || coin.rawCandles.length < (coin.rsiLength + 10)) {
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
            const mIdx = parseInt(mKey.split('-')[1]) - 1;
            monthlyMap[mKey] = { monthKey: mKey, name: monthNames[mIdx] || mKey, trades: 0, pnl: 0, isLocked: false };
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
                monthlyMap[mKey].trades++;
                monthlyMap[mKey].pnl += pnl;
                if ((monthlyMap[mKey].pnl + 0.001) >= coin.monthlyCap) {
                    monthlyMap[mKey].isLocked = true;
                }

                const diffSec = Math.max(0, Math.floor((c.time - entryT) / 1000));
                totalHoldSeconds += diffSec;

                const hours = Math.floor(diffSec / 3600);
                const mins = Math.floor((diffSec % 3600) / 60);
                const exitD = new Date(c.time);

                trades.push({
                    entryPrice: entryP,
                    exitPrice: c.close,
                    pnl: pnl,
                    reason: reason,
                    duration: hours > 0 ? `${hours}sa ${mins}dk` : `${mins}dk`,
                    dateStr: `${exitD.getDate()} ${monthNames[exitD.getMonth()].slice(0, 3)} ${exitD.getHours().toString().padStart(2, '0')}:${exitD.getMinutes().toString().padStart(2, '0')}`,
                    isWin: pnl >= 0
                });
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

function evaluateTradingRules(coin) {
    const activePos = (terminalState.activePositions || []).find(p => p.coinId === coin.id);

    if (activePos) {
        const pnl = ((coin.price - activePos.entryPrice) / activePos.entryPrice) * 100;
        activePos.livePnlPercent = pnl;
        activePos.livePnlUsd = activePos.allocatedUsd * (pnl / 100);

        if (coin.price >= activePos.targetPrice) {
            closePosition(activePos.id, `Kâr Hedefi (%${activePos.profitTarget.toFixed(1)})`);
            playChime(true);
            return;
        }

        if (coin.rsi >= coin.sellRsi) {
            closePosition(activePos.id, `RSI Sat (${coin.rsi.toFixed(1)})`);
            playChime(pnl >= 0);
            return;
        }
    } else {
        if (isCoinMonthlyLocked(coin)) return;

        const isRsiBuyTriggered = (coin.prevRsi <= coin.buyRsi && coin.rsi > coin.buyRsi) || (coin.rsi <= coin.buyRsi);
        
        if (isRsiBuyTriggered) {
            const alreadyPending = (terminalState.pendingSignals || []).some(s => s.coinId === coin.id);
            if (terminalState.activePositions.length < terminalState.maxSlots) {
                openPosition(coin);
                playChime(true);
            } else if (!alreadyPending) {
                terminalState.pendingSignals.push({
                    id: 'pend_' + Date.now(),
                    coinId: coin.id,
                    symbol: coin.symbol,
                    displaySymbol: coin.displaySymbol,
                    triggerPrice: coin.price,
                    triggerRsi: coin.rsi,
                    time: Date.now()
                });
                savePending();
                renderPendingSignalsList();
            }
        }
    }
}

function openPosition(coin, customPrice = null) {
    const entryP = customPrice || coin.price;
    const slotBudget = terminalState.portfolioBaseUsd / terminalState.maxSlots;

    terminalState.activePositions.push({
        id: 'pos_' + Date.now(),
        coinId: coin.id,
        symbol: coin.symbol,
        displaySymbol: coin.displaySymbol,
        entryPrice: entryP,
        targetPrice: entryP * (1.0 + (coin.profitTarget / 100.0)),
        profitTarget: coin.profitTarget,
        allocatedUsd: slotBudget,
        entryTime: Date.now(),
        livePnlPercent: 0,
        livePnlUsd: 0
    });

    terminalState.pendingSignals = terminalState.pendingSignals.filter(p => p.coinId !== coin.id);
    savePending();
    savePositions();
    renderActivePositionsList();
    renderPendingSignalsList();
}

function closePosition(positionId, reason = 'Manuel Kapatıldı') {
    const idx = terminalState.activePositions.findIndex(p => p.id === positionId);
    if (idx === -1) return;

    const pos = terminalState.activePositions[idx];
    const exitPnlUsd = pos.livePnlUsd;
    terminalState.portfolioBaseUsd += exitPnlUsd;

    const now = new Date();
    terminalState.closedTrades.unshift({
        id: 'trade_' + Date.now(),
        coinId: pos.coinId,
        symbol: pos.symbol,
        displaySymbol: pos.displaySymbol,
        entryPrice: pos.entryPrice,
        exitPrice: (pos.coinId && terminalState.coins.find(c => c.id === pos.coinId)?.price) || pos.targetPrice,
        pnlPercent: pos.livePnlPercent,
        pnlUsd: exitPnlUsd,
        reason: reason,
        entryTimeStr: new Date(pos.entryTime).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        exitTimeStr: now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        exitMonth: now.toISOString().slice(0, 7)
    });

    terminalState.activePositions.splice(idx, 1);
    savePositions();
    saveClosedTrades();

    if (terminalState.pendingSignals.length > 0 && terminalState.activePositions.length < terminalState.maxSlots) {
        const next = terminalState.pendingSignals.shift();
        savePending();
        const coin = terminalState.coins.find(c => c.id === next.coinId);
        if (coin && !isCoinMonthlyLocked(coin)) {
            openPosition(coin, coin.price || next.triggerPrice);
        }
    }

    renderActivePositionsList();
    renderPendingSignalsList();
    renderHistoryTrades();
    updatePortfolioCalculations();
}

async function fetchInitialCandles(coin) {
    try {
        const endpoints = [
            `https://api.binance.com/api/v3/klines?symbol=${coin.symbol}&interval=${coin.interval}&limit=1000`,
            `https://data-api.binance.vision/api/v3/klines?symbol=${coin.symbol}&interval=${coin.interval}&limit=1000`
        ];

        let batch = null;
        for (const ep of endpoints) {
            try {
                const res = await fetch(ep);
                if (res.ok) {
                    batch = await res.json();
                    if (batch && batch.length > 0) break;
                }
            } catch (e) {}
        }

        if (batch && batch.length > 0) {
            const all = batch.map(item => ({
                time: item[0],
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                monthKey: new Date(item[0]).toISOString().slice(0, 7)
            }));

            coin.rawCandles = all;
            coin.candles = all.map(c => c.close);
            coin.rsi = calculateRSI(coin.candles, coin.rsiLength);
            coin.prevRsi = coin.rsi;

            const latest = coin.candles[coin.candles.length - 1];
            if (latest > 0 && (!coin.price || coin.price === 0)) {
                coin.prevPrice = latest;
                coin.price = latest;
            }

            runCardBacktest(coin);
        }
    } catch (err) {
        console.warn(`Mum çekilemedi [${coin.symbol}]:`, err.message);
    }
    renderSingleCard(coin);
}

// REST Fiyat Yedekleme (WS bağlantısı gecikse bile kartları hemen canlandırır)
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
            terminalState.btcPrice = priceMap['BTCUSDT'].price;
            if (elLiveBtc) elLiveBtc.textContent = fmtUsd(terminalState.btcPrice);
        }

        terminalState.coins.forEach(coin => {
            const info = priceMap[coin.symbol];
            if (info && info.price > 0) {
                coin.prevPrice = coin.price > 0 ? coin.price : info.price;
                coin.price = info.price;
                coin.high24 = info.high;
                coin.low24 = info.low;

                if (coin.candles && coin.candles.length > 0) {
                    coin.candles[coin.candles.length - 1] = info.price;
                    coin.rsi = calculateRSI(coin.candles, coin.rsiLength);
                }

                evaluateTradingRules(coin);
                renderSingleCard(coin);
            }
        });

        updatePortfolioCalculations();
    } catch (err) {
        console.warn("REST ticker yedekleme hatası:", err.message);
    }
}

function initBinanceWebSocket() {
    if (binanceWs) {
        try { 
            binanceWs.onclose = null;
            binanceWs.close(); 
        } catch(e) {}
    }

    if (!terminalState.coins || terminalState.coins.length === 0) return;

    const streamSet = new Set();
    streamSet.add('btcusdt@miniTicker');
    terminalState.coins.forEach(c => {
        if (c.symbol) streamSet.add(`${c.symbol.toLowerCase()}@miniTicker`);
    });

    const streamPath = Array.from(streamSet).join('/');
    const currentEndpoint = WS_ENDPOINTS[wsEndpointIndex % WS_ENDPOINTS.length];
    const streamUrl = `${currentEndpoint}${streamPath}`;

    try {
        binanceWs = new WebSocket(streamUrl);

        binanceWs.onopen = () => {
            if (elWsStatusDot) elWsStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
            if (elWsStatusText) {
                elWsStatusText.className = 'text-emerald-600 font-semibold text-[9px]';
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
                    terminalState.btcPrice = liveClose;
                    if (elLiveBtc) elLiveBtc.textContent = fmtUsd(liveClose);
                }

                const coin = terminalState.coins.find(c => c.symbol === sym);
                if (coin && liveClose > 0) {
                    coin.prevPrice = coin.price > 0 ? coin.price : liveClose;
                    coin.price = liveClose;
                    coin.high24 = parseFloat(d.h);
                    coin.low24 = parseFloat(d.l);

                    if (coin.candles && coin.candles.length > 0) {
                        coin.candles[coin.candles.length - 1] = liveClose;
                        coin.prevRsi = coin.rsi;
                        coin.rsi = calculateRSI(coin.candles, coin.rsiLength);
                    }

                    evaluateTradingRules(coin);
                    renderSingleCard(coin);
                    updatePortfolioCalculations();
                }
            } catch (e) {}
        };

        binanceWs.onerror = () => {
            wsEndpointIndex++;
        };

        binanceWs.onclose = () => {
            if (elWsStatusDot) elWsStatusDot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping';
            if (elWsStatusText) {
                elWsStatusText.className = 'text-amber-600 font-semibold text-[9px]';
                elWsStatusText.textContent = 'WS..';
            }
            setTimeout(initBinanceWebSocket, 3000);
        };
    } catch (e) {
        wsEndpointIndex++;
        setTimeout(initBinanceWebSocket, 3000);
    }
}

async function fetchBinanceSpotSymbols() {
    try {
        const endpoints = [
            'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT',
            'https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT'
        ];

        let data = null;
        for (const ep of endpoints) {
            try {
                const res = await fetch(ep);
                if (res.ok) {
                    data = await res.json();
                    if (data && data.symbols) break;
                }
            } catch (e) {}
        }

        if (data && data.symbols) {
            const symbols = data.symbols
                .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
                .map(s => s.baseAsset);
                
            terminalState.validSymbols = new Set(symbols);
            if (typeof populateDatalist === 'function') populateDatalist(symbols);
        }
    } catch (err) {
        console.warn("Sembol listesi alınamadı:", err.message);
    }
}

async function runWizardForNewCoin() {
    let rawSym = document.getElementById('wizardSymbolInput').value.trim().toUpperCase();
    if (!rawSym) {
        alert("Lütfen bir coin sembolü girin");
        return;
    }
    if (!rawSym.endsWith('USDT')) rawSym += 'USDT';

    const interval = document.getElementById('wizardIntervalInput').value;
    const rsiLength = parseInt(document.getElementById('wizardRsiLengthInput').value) || 7;
    const profitTarget = parseFloat(document.getElementById('wizardProfitInput').value) || 0.7;
    const monthlyCap = parseFloat(document.getElementById('wizardCapInput').value) || 7.0;

    const btn = document.getElementById('btnWizardRun');
    wizardLoadingStatus.classList.remove('hidden');
    wizardLoadingStatus.textContent = "Binance verisi taranıyor...";
    btn.disabled = true;

    try {
        const endpoints = [
            `https://api.binance.com/api/v3/klines?symbol=${rawSym}&interval=${interval}&limit=1000`,
            `https://data-api.binance.vision/api/v3/klines?symbol=${rawSym}&interval=${interval}&limit=1000`
        ];

        let batch = null;
        for (const ep of endpoints) {
            try {
                const res = await fetch(ep);
                if (res.ok) {
                    batch = await res.json();
                    if (batch && batch.length > 0) break;
                }
            } catch (e) {}
        }

        if (!batch || batch.length === 0) throw new Error("Parite verisi alınamadı.");

        let allCandles = batch.map(item => ({
            time: item[0],
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            monthKey: new Date(item[0]).toISOString().slice(0, 7)
        }));

        const closePrices = allCandles.map(c => c.close);
        const rsiValues = calculateRSIHistory(closePrices, rsiLength);
        let bestCandidate = null;

        for (let buy = 15; buy <= 38; buy += 1) {
            for (let sell = 65; sell <= 90; sell += 1) {
                let inPos = false, entryPrice = 0, totPnl = 0, winCount = 0, lossCount = 0, totalTrades = 0;

                for (let i = rsiLength + 1; i < allCandles.length; i++) {
                    const c = allCandles[i];
                    const rsi = rsiValues[i];
                    const prevRsi = rsiValues[i - 1];
                    if (rsi === null || prevRsi === null) continue;

                    if (!inPos) {
                        if (prevRsi <= buy && rsi > buy) {
                            inPos = true;
                            entryPrice = c.close;
                        }
                    } else {
                        const targetPrice = entryPrice * (1.0 + profitTarget / 100.0);
                        let exited = false, pnl = 0;

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
        }

        if (bestCandidate) {
            terminalState.pendingWizardCandidate = {
                symbol: rawSym,
                displaySymbol: rawSym.replace('USDT', ''),
                interval, rsiLength,
                buyRsi: bestCandidate.buyRsi,
                sellRsi: bestCandidate.sellRsi,
                profitTarget, monthlyCap
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
            alert("Uygun strateji kombinasyonu bulunamadı.");
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
        const endpoints = [
            'https://api.binance.com/api/v3/ticker/price?symbol=USDTTRY',
            'https://data-api.binance.vision/api/v3/ticker/price?symbol=USDTTRY'
        ];

        let data = null;
        for (const ep of endpoints) {
            try {
                const res = await fetch(ep);
                if (res.ok) {
                    data = await res.json();
                    if (data && data.price) break;
                }
            } catch (e) {}
        }

        if (data && data.price) {
            terminalState.usdtTryRate = parseFloat(data.price) || 36.50;
            if (elLiveTry) elLiveTry.textContent = fmtTry(terminalState.usdtTryRate);
            updatePortfolioCalculations();
        }
    } catch (e) {}
}

async function startEngine() {
    loadStorage();

    // 1. Kartları hemen DOM'a bas
    terminalState.coins.forEach(c => renderSingleCard(c));
    renderActivePositionsList();
    renderPendingSignalsList();
    renderHistoryTrades();
    updatePortfolioCalculations();

    // 2. Canlı fiyatları REST ile HEMEN çek (WebSocket açılana kadar ekran boş kalmaz)
    await fetchLiveTickerFallback();
    fetchMarketRate();

    // 3. WebSocket ve dinamik doğrulayıcıyı başlat
    initBinanceWebSocket();
    fetchBinanceSpotSymbols();
    if (typeof setupSymbolLiveValidation === 'function') setupSymbolLiveValidation();

    // Düzenli fiyat kontrolleri
    setInterval(fetchMarketRate, 10000);
    setInterval(fetchLiveTickerFallback, 5000);

    // 4. Arka planda geçmiş mumları tamamla
    for (const coin of terminalState.coins) {
        await fetchInitialCandles(coin);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startEngine);
} else {
    startEngine();
}
