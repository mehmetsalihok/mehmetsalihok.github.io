'use strict';
const $=id=>document.getElementById(id);
let coinSnapshot=[],loadedAt=null,worker=null,lastResult=null,runSnapshot=null;
const supportedIntervals=['5m','15m','30m','1h','4h'];
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
const dateKey=timestamp=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp));
function showError(message){$('analysisError').textContent=message}
function readTerminal() {
    if(worker)return;
    try {
        const source=JSON.parse(localStorage.getItem('kuzgun_web_coins')||'[]');
        if(!Array.isArray(source))throw new Error('Terminal coin kaydı geçersiz');
        const symbols=new Set();
        coinSnapshot=source.map((coin,index)=>{
            const symbol=String(coin.symbol||'').toUpperCase();
            if(!/^[A-Z0-9]{2,25}USDT$/.test(symbol)||symbols.has(symbol))throw new Error('Geçersiz veya tekrarlı coin kaydı: '+symbol);
            symbols.add(symbol);
            const result={id:String(coin.id||'combination_'+index),symbol,displaySymbol:symbol.replace(/USDT$/,''),interval:coin.interval,
                rsiLength:Number(coin.rsiLength),buyRsi:Number(coin.buyRsi),sellRsi:Number(coin.sellRsi),
                profitTarget:Number(coin.profitTarget),monthlyCap:Number(coin.monthlyCap),isActive:coin.isActive!==false};
            if(!supportedIntervals.includes(result.interval)||!Number.isInteger(result.rsiLength)||result.rsiLength<2||result.rsiLength>50||
                ![result.buyRsi,result.sellRsi,result.profitTarget,result.monthlyCap].every(Number.isFinite)||
                result.buyRsi<0||result.sellRsi>100||result.buyRsi>=result.sellRsi||result.profitTarget<=0||result.monthlyCap<=0)
                throw new Error(symbol+': strateji ayarları geçersiz veya bu sürümde desteklenmiyor');
            return result;
        });
        if(new Set(coinSnapshot.map(coin=>coin.id)).size!==coinSnapshot.length)throw new Error('Tekrarlı coin kimliği bulundu');
        loadedAt=new Date();
        $('sourceCoins').innerHTML=coinSnapshot.map(coin=>`<tr><td class="coin-name">${esc(coin.displaySymbol)}</td><td><span class="status ${coin.isActive?'active':''}">${coin.isActive?'Aktif':'Pasif'}</span></td><td>${esc(coin.interval)} / RSI ${coin.rsiLength}</td><td>${coin.buyRsi} / ${coin.sellRsi}</td><td>%${coin.profitTarget.toFixed(2)} / %${coin.monthlyCap.toFixed(2)}</td></tr>`).join('')||'<tr><td colspan="5">Terminalde kayıtlı coin yok. Önce terminale coin ekle.</td></tr>';
        $('coinCount').textContent=`${coinSnapshot.length} coin · ${coinSnapshot.filter(coin=>coin.isActive).length} aktif`;
        $('sourceDate').textContent='Son okuma: '+loadedAt.toLocaleString('tr-TR');
        $('runCombination').disabled=!coinSnapshot.length;
        const year=Number(localStorage.getItem('kuzgun_selected_year'))||new Date().getFullYear();
        $('analysisStart').value=year+'-01-01';
        $('analysisEnd').value=Math.min(Date.UTC(year,11,31),Date.now())===Date.UTC(year,11,31)?year+'-12-31':dateKey(Date.now());
        const base=Number(localStorage.getItem('kuzgun_base_usd'));
        $('analysisBase').value=Number.isFinite(base)&&base>0?base:1000;
        $('analysisSlots').value=Number(localStorage.getItem('kuzgun_max_slots'))||2;
        $('analysisFees').value=localStorage.getItem('kuzgun_fee_deduction_enabled')==='false'?'false':'true';
        $('combinationResults').hidden=true;lastResult=null;showError('');
    }catch(error){coinSnapshot=[];$('runCombination').disabled=true;$('sourceCoins').innerHTML='<tr><td colspan="5">Coinler okunamadı.</td></tr>';showError(error.message)}
}
function getConfig() {
    for(const element of document.querySelectorAll('#configFields input'))if(!element.reportValidity())throw new Error('Analiz alanlarını kontrol et');
    const start=Date.parse($('analysisStart').value+'T00:00:00+03:00');
    const end=Math.min(Date.parse($('analysisEnd').value+'T00:00:00+03:00')+86400000,Date.now());
    const base=Number($('analysisBase').value),slots=Number($('analysisSlots').value),minWin=Number($('analysisWin').value),minTrades=Number($('analysisMinTrades').value);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end||start<Date.UTC(2017,0,1))throw new Error('Geçerli bir tarih aralığı seç');
    if(!Number.isFinite(base)||base<=0||!Number.isInteger(slots)||slots<1||slots>20||!Number.isFinite(minWin)||minWin<0||minWin>100||!Number.isInteger(minTrades)||minTrades<1)throw new Error('Analiz koşulları geçersiz');
    if(!coinSnapshot.length)throw new Error('Önce terminale coin ekle');
    return {start,end,base,slots,minWin,minTrades,fees:$('analysisFees').value==='true',preserve:$('preserveSuccess').checked,coins:JSON.parse(JSON.stringify(coinSnapshot))};
}
function setRunning(running) {
    $('runCombination').disabled=running||!coinSnapshot.length;$('reloadCoins').disabled=running;$('cancelCombination').hidden=!running;
    document.querySelectorAll('#configFields input,#configFields select,#preserveSuccess').forEach(element=>element.disabled=running);
}
function stopWorker(){if(worker)worker.terminate();worker=null;setRunning(false)}
function runAnalysis() {
    if(worker)return;
    showError('');let config;
    try{config=getConfig();worker=new Worker('combination-worker.js?v=2')}catch(error){showError(error.message);return}
    runSnapshot=JSON.parse(JSON.stringify(config));lastResult=null;$('combinationResults').hidden=true;
    setRunning(true);$('analysisProgress').hidden=false;$('progressTitle').textContent='Analiz hazırlanıyor';$('progressDetail').textContent='Veriler indirilirken ve RSI alternatifleri hesaplanırken bu sayfayı açık tut.';
    worker.onmessage=({data})=>{
        if(data.type==='progress'){$('progressTitle').textContent=data.message;$('progressDetail').textContent=data.detail}
        if(data.type==='error'){stopWorker();$('progressTitle').textContent='Analiz tamamlanamadı';showError(data.message)}
        if(data.type==='result'){stopWorker();lastResult=data;renderResult(data);$('progressTitle').textContent='Analiz tamamlandı';$('progressDetail').textContent=`${data.tested.toLocaleString('tr-TR')} farklı kombinasyon değerlendirildi.`}
    };
    worker.onerror=event=>{stopWorker();$('progressTitle').textContent='Analiz durdu';showError(event.message||'Analiz işçisi başlatılamadı')};
    worker.postMessage(config);
}
function metricMarkup(result,base) {
    return `<div class="metric"><span>Hesaplanan bakiye</span><strong>${money(result.balance)}</strong><small class="${result.gain>=0?'positive':'negative'}">${result.gain>=0?'+':''}${money(result.gain)} · %${(result.gain/base*100).toFixed(2)}</small><small>Brüt getiri %${result.grossPnl.toFixed(2)} · Net işlem %${result.netTradePnl.toFixed(2)}</small></div><div class="metric"><span>Slota alınan kazanma oranı</span><strong>%${result.winRate.toFixed(2)}</strong><small>${result.wins} win / ${result.losses} lose</small></div><div class="metric"><span>İşlem / kaçan sinyal</span><strong>${result.trades} / ${result.skipped}</strong><small>${result.signals} kapanmış aday sinyal</small></div><div class="metric"><span>Toplam komisyon</span><strong>${money(result.fees)}</strong><small>${result.valid?'Başarı ve işlem koşulları sağlandı':'Başarı veya işlem koşulları sağlanmadı'}</small></div>`;
}
function optionLabel(option){return option.off?'Pasif':`${option.interval} / RSI ${option.rsiLength}`}
function renderMonthlyComparison(data) {
    const months=[];
    const first=dateKey(data.config.start).slice(0,7),last=dateKey(data.config.end-1).slice(0,7);
    let [year,month]=first.split('-').map(Number);
    for(let count=0;count<1200;count++) {
        const key=year+'-'+String(month).padStart(2,'0');
        if(key>last)break;
        months.push(key);month++;if(month===13){month=1;year++}
    }
    const choices=[['Mevcut düzen',data.baseline]];
    if(data.best)choices.push(['Önerilen',data.best]);
    const balances=choices.map(()=>data.config.base);
    const percentage=value=>`${value>=0?'+':''}${value.toFixed(2)}%`;
    $('monthlyComparisonRows').innerHTML=months.map(key=>choices.map(([label,result],index)=>{
        const row=result.monthly.find(month=>month.monthKey===key)||{trades:0,grossPnl:0,netTradePnl:0,netGain:0,fees:0,capitalPnl:0};
        balances[index]+=row.netGain;
        const title=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',year:'numeric',month:'long'}).format(new Date(key+'-15T12:00:00Z'));
        const style=row.netGain<0?'negative':'positive';
        return `<tr><td class="coin-name">${title}</td><td>${label}</td><td>${row.trades}</td><td class="${row.grossPnl<0?'negative':'positive'}">${percentage(row.grossPnl)}</td><td class="${row.netTradePnl<0?'negative':'positive'}">${percentage(row.netTradePnl)}</td><td>${money(row.fees)}</td><td class="${style}">${row.netGain>=0?'+':''}${money(row.netGain)}</td><td class="${style}">${percentage(row.capitalPnl)}</td><td>${money(balances[index])}</td></tr>`;
    }).join('')).join('');
}
function renderResult(data) {
    $('combinationResults').hidden=false;
    $('searchDescription').textContent=data.exhaustive?`${data.combinations.toLocaleString('tr-TR')} uygun seçenek kombinasyonunun tamamı tarandı. Mevcut düzen ayrıca karşılaştırıldı.`:`Sınırlı arama: ${data.tested.toLocaleString('tr-TR')} kombinasyon denendi; tüm olasılıkların tarandığı iddia edilmez.`;
    $('baselineMetrics').innerHTML=metricMarkup(data.baseline,data.config.base);
    renderMonthlyComparison(data);
    $('analysisWarnings').hidden=!data.warnings.length;$('analysisWarnings').textContent=data.warnings.length?'Bazı alternatifler veri alınamadığı için denenemedi:\n'+data.warnings.join('\n'):'';
    $('bestResult').hidden=!data.best;$('noFeasibleResult').hidden=!!data.best;$('downloadRecommendation').hidden=!data.best;
    if(!data.best){$('noFeasibleResult').textContent='Bu koşulları sağlayan bir kombinasyon bulunamadı. Başarı eşiğini, asgari işlem sayısını veya tarih aralığını inceleyebilirsin. Mevcut terminal ayarların değişmedi.';return}
    $('bestMetrics').innerHTML=metricMarkup(data.best,data.config.base);
    const gainDifference=data.best.balance-data.baseline.balance;
    const different=data.best.selection.some((value,index)=>value!==data.baseline.selection[index]);
    $('improvementText').textContent=(different?`Mevcut düzene göre bakiye farkı: ${gainDifference>=0?'+':''}${money(gainDifference)}.`:'Taranan uygun seçenekler içinde mevcut düzen korundu.')+' Analiz önerisidir; terminale hiçbir ayar uygulanmadı.';
    $('recommendationRows').innerHTML=data.groups.map((group,index)=>{
        const before=group.options[data.baseline.selection[index]],after=group.options[data.best.selection[index]],stats=data.best.byCoin[group.coin.id];
        const same=data.baseline.selection[index]===data.best.selection[index];
        const action=after.off?(before.off?'Pasif kalsın':'Pasife al'):(before.off?'Aktifleştir':same?'Koru':'Ayarı değiştir');
        return `<tr><td class="coin-name">${esc(group.coin.displaySymbol)}<small>Gerekli başarı ≥ %${group.requiredWin.toFixed(2)}</small></td><td><strong>${action}</strong></td><td>${optionLabel(before)}</td><td>${optionLabel(after)}${after.off?'':`<small>AL ${after.buyRsi} / SAT ${after.sellRsi}<br>Hedef %${after.profitTarget.toFixed(2)} / Kilit %${after.monthlyCap.toFixed(2)}</small>`}</td><td>${after.off?'—':`%${stats.winRate.toFixed(2)}<small>${stats.wins} win / ${stats.losses} lose · ${stats.trades} işlem<br>Adayın tüm işlemlerinde %${after.winRate.toFixed(2)}</small>`}</td><td class="${stats.gain>=0?'positive':'negative'}">${money(stats.gain)}</td></tr>`;
    }).join('');
}
$('runCombination').addEventListener('click',runAnalysis);
$('reloadCoins').addEventListener('click',readTerminal);
$('cancelCombination').addEventListener('click',()=>{stopWorker();$('progressTitle').textContent='Analiz durduruldu';$('progressDetail').textContent='Terminal ayarlarında değişiklik yapılmadı.'});
$('downloadRecommendation').addEventListener('click',()=>{
    if(!lastResult?.best)return;
    const payload={type:'kuzgun-combination-review',createdAt:new Date().toISOString(),appliedToTerminal:false,sourceSnapshot:runSnapshot,result:lastResult};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download='kuzgun-kombinasyon-onerisi.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
window.addEventListener('beforeunload',()=>worker?.terminate());
readTerminal();
