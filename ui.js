const elCardsGrid = document.getElementById('cardsGrid');
const elLiveTry = document.getElementById('liveTryRate');
const elLiveBtc = document.getElementById('liveBtcPrice');
const elPortfolioUsd = document.getElementById('portfolioUsd');
const elPortfolioTry = document.getElementById('portfolioTry');
const elNetGainUsd = document.getElementById('netGainUsd');
const elNetGainPercent = document.getElementById('netGainPercent');
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
const addCoinModal = document.getElementById('addCoinModal');
const wizardResultCard = document.getElementById('wizardResultCard');
const wizardLoadingStatus = document.getElementById('wizardLoadingStatus');

const fmtUsd = (val) => '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtTry = (val) => '₺' + Number(val).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatCryptoPrice(price) {
    if (!price || price <= 0) return "--.--";
    if (price >= 1000) return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return '$' + price.toFixed(4);
    return '$' + price.toFixed(6);
}

function playChime(isSuccess = true) {
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

function loadStorage() {
    const savedCoins = localStorage.getItem('kuzgun_web_coins');
    if (savedCoins) {
        try { terminalState.coins = JSON.parse(savedCoins); } catch (e) { terminalState.coins = []; }
    }
    if (!terminalState.coins || terminalState.coins.length === 0) {
        terminalState.coins = [
            { id: 'c1', symbol: 'ASTERUSDT', displaySymbol: 'ASTER', interval: '30m', rsiLength: 7, buyRsi: 24, sellRsi: 92, profitTarget: 0.7, monthlyCap: 7.0, price: 0, prevPrice: 0, high24: 0, low24: 0, rsi: 50.0, prevRsi: 50.0, candles: [], isExpanded: false, activeSubTab: 'monthly', avgHoldDurationStr: '--' },
            { id: 'c2', symbol: 'BTCUSDT', displaySymbol: 'BTC', interval: '15m', rsiLength: 14, buyRsi: 25, sellRsi: 75, profitTarget: 3.5, monthlyCap: 10.5, price: 0, prevPrice: 0, high24: 0, low24: 0, rsi: 50.0, prevRsi: 50.0, candles: [], isExpanded: false, activeSubTab: 'monthly', avgHoldDurationStr: '--' }
        ];
        saveCoins();
    }

    const savedSlots = localStorage.getItem('kuzgun_max_slots');
    if (savedSlots) {
        terminalState.maxSlots = parseInt(savedSlots) || 2;
        elSlotSelector.value = terminalState.maxSlots;
    }

    const savedBase = localStorage.getItem('kuzgun_base_usd');
    if (savedBase) terminalState.portfolioBaseUsd = parseFloat(savedBase) || 1000.00;

    const savedPositions = localStorage.getItem('kuzgun_active_pos');
    if (savedPositions) {
        try { terminalState.activePositions = JSON.parse(savedPositions); } catch(e) {}
    }

    const savedPending = localStorage.getItem('kuzgun_pending_signals');
    if (savedPending) {
        try { terminalState.pendingSignals = JSON.parse(savedPending); } catch(e) {}
    }

    const savedClosedTrades = localStorage.getItem('kuzgun_closed_trades');
    if (savedClosedTrades) {
        try { terminalState.closedTrades = JSON.parse(savedClosedTrades); } catch(e) {}
    }
}

function saveCoins() { localStorage.setItem('kuzgun_web_coins', JSON.stringify(terminalState.coins)); }
function savePositions() { 
    localStorage.setItem('kuzgun_active_pos', JSON.stringify(terminalState.activePositions));
    localStorage.setItem('kuzgun_base_usd', terminalState.portfolioBaseUsd.toString());
}
function savePending() { localStorage.setItem('kuzgun_pending_signals', JSON.stringify(terminalState.pendingSignals)); }
function saveClosedTrades() { localStorage.setItem('kuzgun_closed_trades', JSON.stringify(terminalState.closedTrades)); }

function changeMaxSlots(newSlots) {
    terminalState.maxSlots = parseInt(newSlots) || 2;
    localStorage.setItem('kuzgun_max_slots', terminalState.maxSlots.toString());
    updatePortfolioCalculations();
}

function renderSingleCard(coin) {
    let cardEl = document.getElementById(`card-${coin.id}`);
    const isPos = terminalState.activePositions.some(p => p.coinId === coin.id);
    const isLocked = isCoinMonthlyLocked(coin);

    if (terminalState.activeFilter === 'position' && !isPos) {
        if (cardEl) cardEl.style.display = 'none';
        return;
    } else if (terminalState.activeFilter === 'locked' && !isLocked) {
        if (cardEl) cardEl.style.display = 'none';
        return;
    } else if (cardEl) {
        cardEl.style.display = 'flex';
    }

    let rsiColor = 'text-slate-600', rsiBg = 'bg-slate-50 border-slate-200', rsiLabel = 'NÖTR BÖLGE';
    if (coin.rsi <= coin.buyRsi) {
        rsiColor = 'text-emerald-700 font-bold';
        rsiBg = 'bg-emerald-50 border-emerald-200';
        rsiLabel = 'AŞIRI SATIM (AL)';
    } else if (coin.rsi >= coin.sellRsi) {
        rsiColor = 'text-rose-700 font-bold';
        rsiBg = 'bg-rose-50 border-rose-200';
        rsiLabel = 'AŞIRI ALIM (SAT)';
    }

    let statusBadge = `<span class="px-2 py-0.5 rounded-full bg-slate-100 text-[9px] font-semibold text-slate-500">BOŞTA</span>`;
    if (isPos) {
        statusBadge = `<span class="flex items-center space-x-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200 text-[9px] font-semibold">
            <span class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span><span>POZİSYONDA</span>
        </span>`;
    } else if (isLocked) {
        statusBadge = `<span class="px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-200 text-[9px] font-semibold">🔒 KİLİTLİ</span>`;
    }

    let priceColorClass = 'text-slate-900';
    if (coin.prevPrice > 0 && coin.price !== coin.prevPrice) {
        priceColorClass = coin.price > coin.prevPrice ? 'text-emerald-600' : 'text-rose-600';
    }

    const isExpanded = !!coin.isExpanded;
    const activeSubTab = coin.activeSubTab || 'monthly';
    const subTabIndex = activeSubTab === 'monthly' ? 0 : 1;

    const strategyFixedHtml = `
        <div class="bg-slate-50/80 p-3 rounded-xl border border-slate-200/80 space-y-2.5 text-xs">
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-slate-500 text-[10px] font-semibold mb-0.5">Zaman Dilimi</label>
                    <select id="select-interval-${coin.id}" onchange="handleLiveIntervalChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white border border-slate-200 rounded font-semibold text-slate-800 text-xs focus:outline-none focus:border-blue-500">
                        <option value="5m" ${coin.interval === '5m' ? 'selected' : ''}>5m</option>
                        <option value="15m" ${coin.interval === '15m' ? 'selected' : ''}>15m</option>
                        <option value="30m" ${coin.interval === '30m' ? 'selected' : ''}>30m</option>
                        <option value="1h" ${coin.interval === '1h' ? 'selected' : ''}>1h</option>
                        <option value="4h" ${coin.interval === '4h' ? 'selected' : ''}>4h</option>
                    </select>
                </div>
                <div>
                    <label class="block text-slate-500 text-[10px] font-semibold mb-0.5">RSI Boyu</label>
                    <input type="number" id="input-rsiLen-${coin.id}" value="${coin.rsiLength}" min="2" max="50" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white border border-slate-200 rounded font-semibold text-slate-800 text-xs focus:outline-none focus:border-blue-500">
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-slate-500 text-[10px] font-semibold mb-0.5">AL Sinyali (RSI ≤)</label>
                    <input type="number" id="input-buy-${coin.id}" value="${coin.buyRsi}" step="1" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white border border-slate-200 rounded font-bold text-emerald-600 text-xs focus:outline-none focus:border-blue-500 tabular-nums">
                </div>
                <div>
                    <label class="block text-slate-500 text-[10px] font-semibold mb-0.5">SAT Sinyali (RSI ≥)</label>
                    <input type="number" id="input-sell-${coin.id}" value="${coin.sellRsi}" step="1" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white border border-slate-200 rounded font-bold text-rose-600 text-xs focus:outline-none focus:border-blue-500 tabular-nums">
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-slate-500 text-[10px] font-semibold mb-0.5">Hedef Kâr (%)</label>
                    <input type="number" id="input-profit-${coin.id}" value="${coin.profitTarget}" step="0.1" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white border border-slate-200 rounded font-bold text-blue-600 text-xs focus:outline-none focus:border-blue-500 tabular-nums">
                </div>
                <div>
                    <label class="block text-slate-500 text-[10px] font-semibold mb-0.5">Aylık Kilit (%)</label>
                    <input type="number" id="input-cap-${coin.id}" value="${coin.monthlyCap}" step="0.1" oninput="handleLiveParamChange('${coin.id}')"
                        class="w-full px-2 py-1 bg-white border border-slate-200 rounded font-bold text-indigo-600 text-xs focus:outline-none focus:border-blue-500 tabular-nums">
                </div>
            </div>
        </div>
    `;

    const months = coin.simMonthlyStats || [];
    const totalPnl = months.reduce((acc, m) => acc + m.pnl, 0);
    const totalTrades = months.reduce((acc, m) => acc + m.trades, 0);

    const monthlyPanelHtml = `
        <div id="monthly-container-${coin.id}" class="space-y-1">
            <div class="space-y-0.5 max-h-48 overflow-y-auto pr-1 divide-y divide-slate-100">
                ${months.map(m => `
                    <div class="flex items-center justify-between py-1 px-2 rounded hover:bg-slate-50 text-xs transition">
                        <div class="flex items-center space-x-2">
                            <span class="font-semibold text-slate-800 w-16">${m.name}</span>
                            <span class="text-[10px] text-slate-400 tabular-nums">${m.trades} İşlem</span>
                            ${m.isLocked ? `<span class="text-[9px] px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-600 font-semibold border border-indigo-100">Kilitlendi</span>` : ''}
                        </div>
                        <span class="font-bold tabular-nums text-xs ${m.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}">
                            ${m.pnl > 0 ? '+' : ''}${m.pnl.toFixed(1)}%
                        </span>
                    </div>`).join('')}
            </div>
            <div class="pt-2 border-t border-slate-200 flex items-center justify-between px-2 text-xs font-bold">
                <span class="text-slate-700">Toplam (${totalTrades} İşlem):</span>
                <span class="tabular-nums ${totalPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%</span>
            </div>
        </div>
    `;

    const trades = coin.simLastTrades || [];
    const tradesPanelHtml = `
        <div id="trades-container-${coin.id}" class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            ${trades.map(t => `
                <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-100 text-xs">
                    <div class="space-y-0.5">
                        <div class="flex items-center space-x-1.5">
                            <span class="font-semibold text-slate-800 text-[11px]">${t.reason}</span>
                            <span class="text-[10px] text-blue-600 font-medium">• ${t.duration}</span>
                        </div>
                        <div class="text-[10px] text-slate-400 tabular-nums">${formatCryptoPrice(t.entryPrice)} → ${formatCryptoPrice(t.exitPrice)}</div>
                    </div>
                    <span class="font-bold tabular-nums text-xs px-2 py-0.5 rounded ${t.isWin ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}">
                        ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%
                    </span>
                </div>`).join('')}
        </div>
    `;

    const htmlContent = `
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div class="flex items-center space-x-2">
                <span class="font-bold text-base tracking-tight text-slate-900">${coin.displaySymbol}</span>
                <span class="text-[10px] text-slate-400 font-medium">/USDT</span>
                <span class="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200/60">${coin.interval} • RSI(${coin.rsiLength})</span>
            </div>
            <div class="flex items-center space-x-1.5">
                ${statusBadge}
                <button onclick="toggleCardExpand('${coin.id}')" class="px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition flex items-center space-x-1">
                    <span>${isExpanded ? 'Kapat' : 'Detay'}</span>
                    <svg class="w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                </button>
                <button onclick="openWizardForExistingCoin('${coin.id}')" class="text-slate-400 hover:text-blue-600 p-1 rounded-lg transition" title="Strateji Ayarları">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                    </svg>
                </button>
                <button onclick="deleteCoinCard('${coin.id}')" class="text-slate-400 hover:text-rose-600 p-1 rounded-lg transition" title="Kartı Sil">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </div>
        </div>

        <div class="flex items-baseline justify-between pt-1">
            <div>
                <div class="text-2xl font-bold tabular-nums tracking-tight price-transition ${priceColorClass}" id="price-${coin.id}">
                    ${formatCryptoPrice(coin.price)}
                </div>
                <div class="flex items-center space-x-2 text-[10px] text-slate-400 mt-0.5 font-medium">
                    <span>24s En Düşük:</span><span class="text-rose-500 tabular-nums font-semibold">${formatCryptoPrice(coin.low24)}</span>
                    <span>•</span>
                    <span>En Yüksek:</span><span class="text-emerald-600 tabular-nums font-semibold">${formatCryptoPrice(coin.high24)}</span>
                </div>
            </div>
            <div class="flex flex-col items-end space-y-1">
                <div class="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg border ${rsiBg} text-xs shadow-sm">
                    <span class="text-[9px] text-slate-500 font-bold tracking-wider">RSI</span>
                    <span class="font-extrabold tabular-nums ${rsiColor}">${coin.rsi.toFixed(1)}</span>
                </div>
                <span class="text-[9px] font-bold tracking-tight ${rsiColor}">${rsiLabel}</span>
            </div>
        </div>

        <!-- PROFESYONEL RSI BANDI -->
        <div class="space-y-1.5 pt-1.5">
            <div class="flex items-center justify-between text-[9px] font-bold text-slate-500">
                <span class="flex items-center space-x-1 text-emerald-600"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span><span>AL KORİDORU</span></span>
                <span class="text-slate-400 font-medium">NÖTR ALAN</span>
                <span class="flex items-center space-x-1 text-rose-600"><span>SAT KORİDORU</span><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span></span>
            </div>
            <div class="w-full bg-slate-200/90 rounded-md h-3 relative overflow-hidden flex border border-slate-300/60 shadow-inner">
                <div style="width: ${coin.buyRsi}%" class="bg-emerald-500/25 border-r border-emerald-500/60 h-full"></div>
                <div style="width: ${Math.max(0, coin.sellRsi - coin.buyRsi)}%" class="bg-slate-100/40 h-full"></div>
                <div style="width: ${Math.max(0, 100 - coin.sellRsi)}%" class="bg-rose-500/25 border-l border-rose-500/60 h-full"></div>
                <div class="absolute top-0 bottom-0 w-1 bg-slate-900 shadow-md transition-all duration-300 z-10 -ml-0.5" style="left: ${Math.min(100, Math.max(0, coin.rsi))}%">
                    <div class="w-2.5 h-1.5 bg-slate-900 rounded-sm -mt-0.5 -ml-[3px]"></div>
                </div>
            </div>
            <div class="flex justify-between text-[8px] font-bold tabular-nums text-slate-400 px-0.5">
                <span>0</span>
                <span class="text-emerald-700 bg-emerald-50 px-1 py-0.2 rounded border border-emerald-200">AL: ≤ ${coin.buyRsi}</span>
                <span class="text-rose-700 bg-rose-50 px-1 py-0.2 rounded border border-rose-200">SAT: ≥ ${coin.sellRsi}</span>
                <span>100</span>
            </div>
        </div>

        ${isExpanded ? `
            <div class="pt-3 border-t border-slate-100 space-y-3">
                ${strategyFixedHtml}
                <div class="space-y-2 pt-1">
                    <div class="flex items-center space-x-1 bg-slate-100 p-0.5 rounded-lg text-xs font-semibold text-slate-600">
                        <button id="subtab-btn-${coin.id}-monthly" onclick="setCardSubTab('${coin.id}', 'monthly')" class="flex-1 py-1 rounded-md transition ${activeSubTab === 'monthly' ? 'bg-white text-slate-900 shadow-sm font-semibold' : 'text-slate-500 hover:text-slate-800 font-medium'}">Aylık Tablo (2026)</button>
                        <button id="subtab-btn-${coin.id}-trades" onclick="setCardSubTab('${coin.id}', 'trades')" class="flex-1 py-1 rounded-md transition ${activeSubTab === 'trades' ? 'bg-white text-slate-900 shadow-sm font-semibold' : 'text-slate-500 hover:text-slate-800 font-medium'}">Son 10 İşlem</button>
                    </div>
                    <div class="overflow-hidden w-full relative pt-1">
                        <div id="subslider-${coin.id}" class="flex w-full transition-transform duration-300 ease-in-out" style="transform: translateX(-${subTabIndex * 100}%);">
                            <div class="w-full shrink-0 px-0.5">${monthlyPanelHtml}</div>
                            <div class="w-full shrink-0 px-0.5">${tradesPanelHtml}</div>
                        </div>
                    </div>
                </div>
            </div>` : `
            <div class="pt-2.5 border-t border-slate-100 grid grid-cols-5 gap-1.5 text-center text-xs">
                <div class="bg-slate-50 p-1.5 rounded-lg border border-slate-200/70 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 font-bold uppercase tracking-wider">AL SİNYALİ</span>
                    <strong class="text-emerald-600 font-extrabold tabular-nums text-xs">≤ ${coin.buyRsi}</strong>
                </div>
                <div class="bg-slate-50 p-1.5 rounded-lg border border-slate-200/70 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 font-bold uppercase tracking-wider">SAT SİNYALİ</span>
                    <strong class="text-rose-600 font-extrabold tabular-nums text-xs">≥ ${coin.sellRsi}</strong>
                </div>
                <div class="bg-slate-50 p-1.5 rounded-lg border border-slate-200/70 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 font-bold uppercase tracking-wider">HEDEF KÂR</span>
                    <strong class="text-blue-600 font-extrabold tabular-nums text-xs">%${coin.profitTarget.toFixed(1)}</strong>
                </div>
                <div class="bg-slate-50 p-1.5 rounded-lg border border-slate-200/70 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 font-bold uppercase tracking-wider">AY KİLİT</span>
                    <strong class="text-indigo-600 font-extrabold tabular-nums text-xs">%${coin.monthlyCap.toFixed(1)}</strong>
                </div>
                <div class="bg-slate-50 p-1.5 rounded-lg border border-slate-200/70 flex flex-col justify-center">
                    <span class="text-[8px] text-slate-400 font-bold uppercase tracking-wider">ORT. SÜRE</span>
                    <strong class="text-amber-600 font-extrabold tabular-nums text-[10px]">${coin.avgHoldDurationStr || '--'}</strong>
                </div>
            </div>`}
    `;

    if (!cardEl) {
        cardEl = document.createElement('div');
        cardEl.id = `card-${coin.id}`;
        cardEl.className = 'bg-white border border-slate-200/80 rounded-xl p-4 space-y-3 shadow-sm hover:border-slate-300 transition flex flex-col justify-between';
        elCardsGrid.appendChild(cardEl);
    }
    cardEl.innerHTML = htmlContent;

    setTimeout(() => {
        const pEl = document.getElementById(`price-${coin.id}`);
        if (pEl) {
            pEl.classList.remove('text-emerald-600', 'text-rose-600');
            pEl.classList.add('text-slate-900');
        }
    }, 350);
}

function updateCardTablesOnly(coin) {
    const mContainer = document.getElementById(`monthly-container-${coin.id}`);
    const tContainer = document.getElementById(`trades-container-${coin.id}`);

    if (mContainer) {
        const months = coin.simMonthlyStats || [];
        const totalPnl = months.reduce((acc, m) => acc + m.pnl, 0);
        const totalTrades = months.reduce((acc, m) => acc + m.trades, 0);

        mContainer.innerHTML = `
            <div class="space-y-1">
                <div class="space-y-0.5 max-h-48 overflow-y-auto pr-1 divide-y divide-slate-100">
                    ${months.map(m => `
                        <div class="flex items-center justify-between py-1 px-2 rounded hover:bg-slate-50 text-xs transition">
                            <div class="flex items-center space-x-2">
                                <span class="font-semibold text-slate-800 w-16">${m.name}</span>
                                <span class="text-[10px] text-slate-400 tabular-nums">${m.trades} İşlem</span>
                                ${m.isLocked ? `<span class="text-[9px] px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-600 font-semibold border border-indigo-100">Kilitlendi</span>` : ''}
                            </div>
                            <span class="font-bold tabular-nums text-xs ${m.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}">
                                ${m.pnl > 0 ? '+' : ''}${m.pnl.toFixed(1)}%
                            </span>
                        </div>`).join('')}
                </div>
                <div class="pt-2 border-t border-slate-200 flex items-center justify-between px-2 text-xs font-bold">
                    <span class="text-slate-700">Toplam (${totalTrades} İşlem):</span>
                    <span class="tabular-nums ${totalPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%</span>
                </div>
            </div>`;
    }

    if (tContainer) {
        const trades = coin.simLastTrades || [];
        tContainer.innerHTML = trades.length === 0 ? `<p class="py-6 text-center text-xs text-slate-400 font-medium">İşlem yok.</p>` : `
            <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                ${trades.map(t => `
                    <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-100 text-xs">
                        <div class="space-y-0.5">
                            <div class="flex items-center space-x-1.5">
                                <span class="font-semibold text-slate-800 text-[11px]">${t.reason}</span>
                                <span class="text-[10px] text-blue-600 font-medium">• ${t.duration}</span>
                            </div>
                            <div class="text-[10px] text-slate-400 tabular-nums">${formatCryptoPrice(t.entryPrice)} → ${formatCryptoPrice(t.exitPrice)}</div>
                        </div>
                        <span class="font-bold tabular-nums text-xs px-2 py-0.5 rounded ${t.isWin ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}">
                            ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%
                        </span>
                    </div>`).join('')}
            </div>`;
    }
}

function renderActivePositionsList() {
    elActivePositionsCountBadge.textContent = `${terminalState.activePositions.length} / ${terminalState.maxSlots} Slot`;
    if (terminalState.activePositions.length === 0) {
        elActivePositionsList.innerHTML = `<div class="py-5 px-3 text-center bg-slate-50/70 border border-dashed border-slate-200/80 rounded-lg"><p class="font-semibold text-slate-700 text-xs">Açık pozisyon yok</p></div>`;
        return;
    }

    elActivePositionsList.innerHTML = terminalState.activePositions.map(pos => {
        const coin = terminalState.coins.find(c => c.id === pos.coinId);
        const currentPrice = coin ? coin.price : pos.entryPrice;
        const pnl = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const isWin = pnl >= 0;

        return `
            <div class="bg-slate-50/80 border border-slate-200/80 rounded-lg p-2.5 space-y-2">
                <div class="flex items-center justify-between">
                    <span class="font-bold text-xs text-slate-900">${pos.displaySymbol} <span class="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-semibold border border-blue-200">%${pos.profitTarget.toFixed(1)} TP</span></span>
                    <span class="font-semibold text-xs tabular-nums ${isWin ? 'text-emerald-600' : 'text-rose-600'}">${isWin ? '+' : ''}${pnl.toFixed(2)}%</span>
                </div>
                <div class="grid grid-cols-2 gap-1.5 text-[10px] text-slate-500 bg-white p-2 rounded border border-slate-100">
                    <div>Giriş: <span class="text-slate-800 font-medium">${formatCryptoPrice(pos.entryPrice)}</span></div>
                    <div>Hedef: <span class="text-emerald-600 font-medium">${formatCryptoPrice(pos.targetPrice)}</span></div>
                    <div>Anlık: <span class="text-slate-900 font-medium">${formatCryptoPrice(currentPrice)}</span></div>
                    <div>Bütçe: <span class="text-slate-800 font-medium">${fmtUsd(pos.allocatedUsd)}</span></div>
                </div>
                <button onclick="closePosition('${pos.id}')" class="w-full py-1 rounded-lg bg-white hover:bg-rose-50 text-slate-700 hover:text-rose-600 text-xs font-medium border border-slate-200 transition">Pozisyonu Kapat</button>
            </div>`;
    }).join('');
}

function renderPendingSignalsList() {
    elPendingSignalsCountBadge.textContent = `${terminalState.pendingSignals.length} Bekleyen`;
    if (terminalState.pendingSignals.length === 0) {
        elPendingSignalsList.innerHTML = `<div class="py-5 px-3 text-center bg-slate-50/70 border border-dashed border-slate-200/80 rounded-lg"><p class="font-semibold text-slate-700 text-xs">Radar sırası boş</p></div>`;
        return;
    }

    elPendingSignalsList.innerHTML = terminalState.pendingSignals.map(item => `
        <div class="bg-amber-50/50 border border-amber-200/80 rounded-lg p-2.5 space-y-2">
            <div class="flex items-center justify-between">
                <span class="font-bold text-xs text-slate-900">${item.displaySymbol} <span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold tabular-nums">RSI: ${item.triggerRsi.toFixed(1)}</span></span>
                <button onclick="dismissPending('${item.id}')" class="text-slate-400 hover:text-rose-600 text-xs font-semibold">✕</button>
            </div>
            <div class="text-[10px] text-slate-600">Tetiklenme: <strong class="text-slate-900 tabular-nums">${formatCryptoPrice(item.triggerPrice)}</strong></div>
            <button onclick="forceEnterFromPending('${item.id}')" class="w-full py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold transition shadow-sm">Slot Aç & Dahil Et</button>
        </div>`).join('');
}

function renderHistoryTrades() {
    elHistoryTotal.textContent = `${terminalState.closedTrades.length} İşlem`;
    if (terminalState.closedTrades.length === 0) {
        elHistoryContainer.innerHTML = `<div class="py-6 text-center text-xs text-slate-400 bg-slate-50/70 border border-dashed border-slate-200/80 rounded-lg"><p class="font-medium text-slate-600">Henüz kapalı işlem kaydı yok.</p></div>`;
        return;
    }

    elHistoryContainer.innerHTML = terminalState.closedTrades.map(t => {
        const isWin = t.pnlPercent >= 0;
        return `
            <div class="bg-slate-50 border border-slate-200 rounded-lg p-2.5 space-y-1 text-xs">
                <div class="flex items-center justify-between">
                    <span class="font-bold text-slate-900 text-xs">${t.displaySymbol} <span class="text-[9px] px-1.5 py-0.2 rounded ${isWin ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'} font-semibold">${t.reason}</span></span>
                    <span class="font-bold tabular-nums text-xs ${isWin ? 'text-emerald-600' : 'text-rose-600'}">${isWin ? '+' : ''}${t.pnlPercent.toFixed(2)}%</span>
                </div>
                <div class="flex items-center justify-between text-[10px] text-slate-400 font-medium">
                    <span class="tabular-nums">${formatCryptoPrice(t.entryPrice)} → ${formatCryptoPrice(t.exitPrice)}</span>
                    <span class="text-slate-600 tabular-nums font-semibold">${t.pnlUsd >= 0 ? '+' : ''}${fmtUsd(t.pnlUsd)}</span>
                </div>
            </div>`;
    }).join('');
}

function updatePortfolioCalculations() {
    let unrealizedPnlUsd = 0;
    terminalState.activePositions.forEach(p => {
        const coin = terminalState.coins.find(c => c.id === p.coinId);
        if (coin && coin.price > 0) {
            unrealizedPnlUsd += p.allocatedUsd * (((coin.price - p.entryPrice) / p.entryPrice));
        }
    });

    const currentTotalUsd = terminalState.portfolioBaseUsd + unrealizedPnlUsd;
    const netGainUsd = currentTotalUsd - 1000.00;
    const netGainPct = (netGainUsd / 1000.00) * 100;

    elPortfolioUsd.textContent = fmtUsd(currentTotalUsd);
    elNetGainUsd.textContent = `${netGainUsd >= 0 ? '+' : ''}${fmtUsd(netGainUsd)}`;
    elNetGainUsd.className = `font-bold tabular-nums tracking-tight text-xs ${netGainUsd >= 0 ? 'text-emerald-600' : 'text-rose-600'}`;
    elNetGainPercent.textContent = `%${netGainPct >= 0 ? '+' : ''}${netGainPct.toFixed(2)}`;
    elNetGainPercent.className = `text-[10px] font-semibold tabular-nums ${netGainPct >= 0 ? 'text-emerald-600' : 'text-rose-600'}`;

    if (terminalState.usdtTryRate > 0) {
        elPortfolioTry.textContent = `≈ ${fmtTry(currentTotalUsd * terminalState.usdtTryRate)}`;
    }
    elSlotCountDisplay.textContent = `${terminalState.activePositions.length}/${terminalState.maxSlots}`;
    renderActivePositionsList();
}

function toggleCardExpand(coinId) {
    const coin = terminalState.coins.find(c => c.id === coinId);
    if (!coin) return;
    coin.isExpanded = !coin.isExpanded;
    if (coin.isExpanded && !coin.simMonthlyStats) runCardBacktest(coin);
    saveCoins();
    renderSingleCard(coin);
}

function setCardSubTab(coinId, subTab) {
    const coin = terminalState.coins.find(c => c.id === coinId);
    if (!coin) return;
    coin.activeSubTab = subTab;
    saveCoins();

    const sliderEl = document.getElementById(`subslider-${coin.id}`);
    if (sliderEl) {
        sliderEl.style.transform = `translateX(-${subTab === 'monthly' ? 0 : 100}%)`;
        document.getElementById(`subtab-btn-${coin.id}-monthly`).className = subTab === 'monthly' ? "flex-1 py-1 rounded-md bg-white text-slate-900 shadow-sm font-semibold" : "flex-1 py-1 rounded-md text-slate-500 hover:text-slate-800 font-medium";
        document.getElementById(`subtab-btn-${coin.id}-trades`).className = subTab === 'trades' ? "flex-1 py-1 rounded-md bg-white text-slate-900 shadow-sm font-semibold" : "flex-1 py-1 rounded-md text-slate-500 hover:text-slate-800 font-medium";
    }
}

function handleLiveParamChange(coinId) {
    const coin = terminalState.coins.find(c => c.id === coinId);
    if (!coin) return;

    coin.buyRsi = parseFloat(document.getElementById(`input-buy-${coin.id}`).value);
    coin.sellRsi = parseFloat(document.getElementById(`input-sell-${coin.id}`).value);
    coin.profitTarget = parseFloat(document.getElementById(`input-profit-${coin.id}`).value);
    coin.monthlyCap = parseFloat(document.getElementById(`input-cap-${coin.id}`).value);
    coin.rsiLength = parseInt(document.getElementById(`input-rsiLen-${coin.id}`).value);

    runCardBacktest(coin);
    saveCoins();
    updateCardTablesOnly(coin);
}

async function handleLiveIntervalChange(coinId) {
    const coin = terminalState.coins.find(c => c.id === coinId);
    if (!coin) return;
    coin.interval = document.getElementById(`select-interval-${coin.id}`).value;
    saveCoins();
    await fetchInitialCandles(coin);
    initBinanceWebSocket();
}

function filterCards(type) {
    terminalState.activeFilter = type;
    document.getElementById('btnFilterAll').className = type === 'all' ? 'px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white shadow-sm' : 'px-2.5 py-1 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition';
    document.getElementById('btnFilterPos').className = type === 'position' ? 'px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white shadow-sm' : 'px-2.5 py-1 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition';
    document.getElementById('btnFilterLocked').className = type === 'locked' ? 'px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-600 text-white shadow-sm' : 'px-2.5 py-1 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition';
    terminalState.coins.forEach(c => renderSingleCard(c));
}

function openAddCoinModal() {
    wizardResultCard.classList.add('hidden');
    wizardLoadingStatus.classList.add('hidden');
    terminalState.pendingWizardCandidate = null;
    addCoinModal.classList.remove('hidden');
    addCoinModal.classList.add('flex');
}

function closeAddCoinModal() {
    addCoinModal.classList.add('hidden');
    addCoinModal.classList.remove('flex');
}

function openWizardForExistingCoin(coinId) {
    const coin = terminalState.coins.find(c => c.id === coinId);
    if (!coin) return;
    openAddCoinModal();
    document.getElementById('wizardSymbolInput').value = coin.displaySymbol;
    document.getElementById('wizardIntervalInput').value = coin.interval;
    document.getElementById('wizardRsiLengthInput').value = coin.rsiLength;
    document.getElementById('wizardProfitInput').value = coin.profitTarget;
    document.getElementById('wizardCapInput').value = coin.monthlyCap;
}

async function confirmAndAddCoinFromWizard() {
    if (!terminalState.pendingWizardCandidate) return;
    const cand = terminalState.pendingWizardCandidate;
    const existingIdx = terminalState.coins.findIndex(c => c.symbol === cand.symbol);

    if (existingIdx !== -1) {
        Object.assign(terminalState.coins[existingIdx], cand, { isExpanded: false, activeSubTab: 'monthly' });
        saveCoins();
        await fetchInitialCandles(terminalState.coins[existingIdx]);
    } else {
        const newCoin = Object.assign({
            id: 'c_' + Date.now(),
            price: 0, prevPrice: 0, high24: 0, low24: 0, rsi: 50.0, prevRsi: 50.0,
            candles: [], isExpanded: false, activeSubTab: 'monthly', avgHoldDurationStr: '--'
        }, cand);
        terminalState.coins.push(newCoin);
        saveCoins();
        await fetchInitialCandles(newCoin);
    }

    closeAddCoinModal();
    initBinanceWebSocket();
    updatePortfolioCalculations();
    playChime(true);
}

function deleteCoinCard(id) {
    terminalState.coins = terminalState.coins.filter(c => c.id !== id);
    terminalState.activePositions = terminalState.activePositions.filter(p => p.coinId !== id);
    terminalState.pendingSignals = terminalState.pendingSignals.filter(p => p.coinId !== id);
    saveCoins();
    savePositions();
    savePending();
    const el = document.getElementById(`card-${id}`);
    if (el) el.remove();
    initBinanceWebSocket();
    updatePortfolioCalculations();
}

function clearHistory() {
    if (confirm("İşlem geçmişi sıfırlansın mı?")) {
        terminalState.closedTrades = [];
        saveClosedTrades();
        renderHistoryTrades();
        updatePortfolioCalculations();
    }
}

function forceEnterFromPending(pendingId) {
    const idx = terminalState.pendingSignals.findIndex(p => p.id === pendingId);
    if (idx === -1) return;
    const pending = terminalState.pendingSignals[idx];
    const coin = terminalState.coins.find(c => c.id === pending.coinId);
    if (coin && !isCoinMonthlyLocked(coin)) {
        terminalState.pendingSignals.splice(idx, 1);
        savePending();
        openPosition(coin);
    }
}

function dismissPending(pendingId) {
    terminalState.pendingSignals = terminalState.pendingSignals.filter(p => p.id !== pendingId);
    savePending();
    renderPendingSignalsList();
}
