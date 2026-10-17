'use strict';
const $=id=>document.getElementById(id);
let coinSnapshot=[],loadedAt=null,worker=null,lastResult=null,runSnapshot=null;
let analysisRunning=false,scenarioResult=null,scenarioSelection=[],scenarioRequestId=0,scenarioTimer=null;
let viewMode='sinceStart';
const supportedIntervals=['5m','15m','30m','1h','4h'];
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
const dateKey=timestamp=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp));
function showError(message){$('analysisError').textContent=message}
function readTerminal() {
    if(analysisRunning)return;
    if(worker)stopWorker();
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
    return {start,end,base,slots,minWin,minTrades,searchBudget:Number($('analysisBudget').value),fees:$('analysisFees').value==='true',preserve:$('preserveSuccess').checked,coins:JSON.parse(JSON.stringify(coinSnapshot))};
}
function setRunning(running) {
    analysisRunning=running;
    $('runCombination').disabled=running||!coinSnapshot.length;$('reloadCoins').disabled=running;$('cancelCombination').hidden=!running;
    document.querySelectorAll('#configFields input,#configFields select,#preserveSuccess').forEach(element=>element.disabled=running);
}
function stopWorker(){clearTimeout(scenarioTimer);scenarioRequestId++;if(worker)worker.terminate();worker=null;setRunning(false)}
function runAnalysis() {
    if(analysisRunning)return;
    if(worker)stopWorker();
    showError('');let config;
    try{config=getConfig();worker=new Worker('combination-worker.js?v=4')}catch(error){showError(error.message);return}
    runSnapshot=JSON.parse(JSON.stringify(config));lastResult=null;$('combinationResults').hidden=true;
    setRunning(true);$('analysisProgress').hidden=false;$('progressTitle').textContent='Analiz hazırlanıyor';$('progressDetail').textContent='Veriler indirilirken ve RSI alternatifleri hesaplanırken bu sayfayı açık tut.';
    worker.onmessage=({data})=>{
        if(data.type==='progress'){$('progressTitle').textContent=data.message;$('progressDetail').textContent=data.detail}
        if(data.type==='error'){stopWorker();$('progressTitle').textContent='Analiz tamamlanamadı';showError(data.message)}
        if(data.type==='result'){setRunning(false);lastResult=data;renderResult(data);$('progressTitle').textContent='Analiz tamamlandı';$('progressDetail').textContent=`${data.tested.toLocaleString('tr-TR')} farklı kombinasyon değerlendirildi.`}
        if(data.type==='scenario' && data.requestId===scenarioRequestId) {
            scenarioResult=data.scenario;scenarioSelection=[...data.scenario.selection];
            renderScenario();$('scenarioStatus').textContent='Slot hesabı güncellendi. Terminal ayarları değişmedi.';
        }
        if(data.type==='scenarioError' && data.requestId===scenarioRequestId) {
            $('scenarioStatus').textContent=data.message;
            if(scenarioResult){scenarioSelection=[...scenarioResult.selection];renderRecommendation();}
        }
    };
    worker.onmessageerror=()=>{stopWorker();$('progressTitle').textContent='Analiz sonucu alınamadı';showError('Sonuç aktarımı tamamlanamadı. Hafif arama bütçesiyle yeniden deneyebilirsin.')};
    worker.onerror=event=>{stopWorker();$('progressTitle').textContent='Analiz durdu';showError(event.message||'Analiz işçisi başlatılamadı')};
    worker.postMessage(config);
}
function metricMarkup(result,base) {
    return `<div class="metric"><span>Dönem sonu portföyü</span><strong>${money(result.balance)}</strong><small class="${result.gain>=0?'positive':'negative'}">Dönem net kazancı: ${result.gain>=0?'+':''}${money(result.gain)} · Sermayeye %${(result.gain/base*100).toFixed(2)}</small><small>Brüt getiri %${result.grossPnl.toFixed(2)} · Net işlem %${result.netTradePnl.toFixed(2)}</small></div><div class="metric"><span>Slota alınan kazanma oranı</span><strong>%${result.winRate.toFixed(2)}</strong><small>${result.wins} win / ${result.losses} lose</small></div><div class="metric"><span>İşlem / kaçan sinyal</span><strong>${result.trades} / ${result.skipped}</strong><small>${result.signals} kapanmış aday sinyal</small></div><div class="metric"><span>Toplam komisyon</span><strong>${money(result.fees)}</strong><small>${result.valid?'Başarı ve işlem koşulları sağlandı':'Başarı veya işlem koşulları sağlanmadı'}</small></div>`;
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
    if(data.best)choices.push(['Seçili kombinasyon',data.best]);
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
function availableMonths(config) {
    const months=[];let [year,month]=dateKey(config.start).slice(0,7).split('-').map(Number);
    const last=dateKey(config.end-1).slice(0,7);
    for(let i=0;i<1200;i++){const key=year+'-'+String(month).padStart(2,'0');if(key>last)break;months.push(key);month++;if(month===13){year++;month=1}}
    return months;
}
function viewRange() {
    const config=lastResult.config;
    let start=dateKey(config.start),end=dateKey(config.end-1);
    const today=dateKey(Date.now());
    if(viewMode==='today'){start=today;end=today}
    if(viewMode==='week'){
        const day=new Date(today+'T12:00:00Z');const delta=(day.getUTCDay()+6)%7;
        start=new Date(day.getTime()-delta*86400000).toISOString().slice(0,10);end=today;
    }
    if(viewMode==='month'){start=today.slice(0,7)+'-01';end=today}
    if(viewMode==='selectMonth'){
        const key=$('viewMonth').value;if(!key)throw new Error('Bir ay seç');
        start=key+'-01';const [year,month]=key.split('-').map(Number);
        end=new Date(Date.UTC(year,month,0,12)).toISOString().slice(0,10);
    }
    if(viewMode==='custom'){start=$('viewStart').value;end=$('viewEnd').value;if(!start||!end||start>end)throw new Error('Geçerli bir tarih aralığı seç')}
    return {start,end};
}
function periodStats(result,config,range) {
    const daily=result.daily||[];
    let opening=config.base,balance=config.base,gain=0,fees=0,grossPnl=0,netTradePnl=0,trades=0,wins=0,losses=0,signals=0,skipped=0;
    for(const day of daily){
        if(day.day<range.start)opening+=day.netGain;
        if(day.day<=range.end)balance+=day.netGain;
        if(day.day<range.start||day.day>range.end)continue;
        gain+=day.netGain;fees+=day.fees;grossPnl+=day.grossPnl;netTradePnl+=day.netTradePnl;
        trades+=day.trades;wins+=day.wins;losses+=day.losses;signals+=day.signals;skipped+=day.skipped;
    }
    return {...result,balance,gain,fees,grossPnl,netTradePnl,trades,wins,losses,signals,skipped,opening,winRate:trades?wins/trades*100:0};
}
function renderPortfolioView() {
    if(!lastResult)return;
    try{
        const range=viewRange();$('viewError').textContent='';
        $('viewPeriodLabel').textContent=`Gösterilen dönem: ${range.start} — ${range.end} · Kârlar işlem kapanış gününe göre`;
        if(range.end<dateKey(lastResult.config.start)||range.start>dateKey(lastResult.config.end-1))$('viewPeriodLabel').textContent+=' · Bu aralıkta analiz verisi yok';
        const baseline=periodStats(lastResult.baseline,lastResult.config,range);
        $('baselineMetrics').innerHTML=metricMarkup(baseline,lastResult.config.base);
        if(scenarioResult){
            const scenario=periodStats(scenarioResult,lastResult.config,range);
            $('bestMetrics').innerHTML=metricMarkup(scenario,lastResult.config.base);
            const delta=scenario.gain-baseline.gain;
            $('comparisonDelta').textContent=(delta>=0?'+':'')+money(delta);
            $('comparisonDelta').className=delta>=0?'positive':'negative';
        }
        const isSuggested=lastResult.best && scenarioSelection.every((value,index)=>value===lastResult.best.selection[index]);
        $('scenarioTitle').textContent=isSuggested?'ÖNERİLEN AYARLAR':'SEÇTİĞİN SENARYO';
    }catch(error){$('viewError').textContent=error.message}
}
function selectView(mode) {
    viewMode=mode;
    document.querySelectorAll('[data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===mode)));
    $('viewMonthLabel').hidden=mode!=='selectMonth';$('viewCustomRange').hidden=mode!=='custom';
    renderPortfolioView();
}
function renderRecommendation() {
    if(!lastResult||!scenarioResult)return;
    $('recommendationRows').innerHTML=lastResult.groups.map((group,index)=>{
        const before=group.options[lastResult.baseline.selection[index]],after=group.options[scenarioSelection[index]],stats=scenarioResult.byCoin[group.coin.id];
        const same=lastResult.baseline.selection[index]===scenarioSelection[index];
        const action=after.off?(before.off?'Pasif kalsın':'Pasife al'):(before.off?'Aktifleştir':same?'Koru':'Ayarı değiştir');
        const options=group.options.map((option,optionIndex)=>`<option value="${optionIndex}" ${optionIndex===scenarioSelection[index]?'selected':''}>${option.current?'Mevcut · ':''}${optionLabel(option)}${option.off?'':` · AL ${option.buyRsi} / SAT ${option.sellRsi}`}</option>`).join('');
        return `<tr><td class="coin-name">${esc(group.coin.displaySymbol)}<small>Gerekli başarı ≥ %${group.requiredWin.toFixed(2)}</small></td><td><strong>${action}</strong></td><td>${optionLabel(before)}</td><td><select data-scenario-index="${index}" aria-label="${esc(group.coin.displaySymbol)} stratejisi">${options}</select>${after.off?'':`<small>Hedef %${after.profitTarget.toFixed(2)} / Kilit %${after.monthlyCap.toFixed(2)}</small>`}</td><td>${after.off?'—':`%${stats.winRate.toFixed(2)}<small>${stats.wins} win / ${stats.losses} lose · ${stats.trades} işlem</small>`}</td><td class="${stats.gain>=0?'positive':'negative'}">${money(stats.gain)}</td></tr>`;
    }).join('');
}
function renderScenario() {
    renderPortfolioView();renderRecommendation();
    renderMonthlyComparison({...lastResult,best:scenarioResult});
    const delta=scenarioResult.balance-lastResult.baseline.balance;
    $('improvementText').textContent=`Analizin tamamında bakiye farkı: ${delta>=0?'+':''}${money(delta)}. `+
        (scenarioResult.valid?'Seçim başarı ve işlem koşullarını sağlıyor.':'Bu manuel seçim başarı veya işlem koşullarını sağlamıyor.')+
        ' Terminale hiçbir ayar uygulanmadı.';
}
function requestScenario(selection) {
    if(!worker||analysisRunning||!lastResult){$('scenarioStatus').textContent='Senaryo hesabı için analizi yeniden çalıştır.';return}
    scenarioSelection=[...selection];
    const requestId=++scenarioRequestId;
    clearTimeout(scenarioTimer);$('scenarioStatus').textContent='Seçim için slotlar ve kazanç yeniden hesaplanıyor…';
    scenarioTimer=setTimeout(()=>worker?.postMessage({type:'scenario',selection:[...scenarioSelection],requestId}),150);
}
function renderResult(data) {
    lastResult=data;scenarioResult=data.best||data.baseline;scenarioSelection=[...scenarioResult.selection];
    $('combinationResults').hidden=false;
    $('searchDescription').textContent=data.exhaustive?`${data.combinations.toLocaleString('tr-TR')} uygun seçenek kombinasyonunun tamamı tarandı.`:`Sınırlı arama: ${data.tested.toLocaleString('tr-TR')} kombinasyon denendi; bütçe ${data.searchBudget}.`;
    $('snapshotLabel').textContent='Analiz verisi bitişi: '+new Date(data.config.end).toLocaleString('tr-TR')+' · Başlangıç sermayesi '+money(data.config.base)+' · '+data.config.slots+' slot';
    $('analysisWarnings').hidden=!data.warnings.length;$('analysisWarnings').textContent=data.warnings.length?'Veri alınamayan alternatifler:\n'+data.warnings.join('\n'):'';
    $('bestResult').hidden=false;$('noFeasibleResult').hidden=!!data.best;$('downloadRecommendation').hidden=!data.best;
    $('restoreSuggested').disabled=!data.best;
    $('noFeasibleResult').textContent=data.best?'':'Başarı koşullarını sağlayan öneri bulunamadı. Sağdaki panel başlangıçta mevcut düzeni gösterir; aşağıdan kendi senaryonu deneyebilirsin.';
    $('viewMonth').innerHTML=availableMonths(data.config).map(key=>`<option value="${key}">${key}</option>`).join('');
    $('viewMonth').value=dateKey(data.config.end-1).slice(0,7);
    $('viewStart').value=dateKey(data.config.start);$('viewEnd').value=dateKey(data.config.end-1);
    $('scenarioStatus').textContent='Ay seçebilir veya coin ayarlarını değiştirerek bir senaryo deneyebilirsin.';
    selectView('sinceStart');renderScenario();
}
$('runCombination').addEventListener('click',runAnalysis);
$('reloadCoins').addEventListener('click',readTerminal);
$('cancelCombination').addEventListener('click',()=>{stopWorker();$('progressTitle').textContent='Analiz durduruldu';$('progressDetail').textContent='Terminal ayarlarında değişiklik yapılmadı.'});
$('downloadRecommendation').addEventListener('click',()=>{
    if(!lastResult?.best)return;
    const payload={type:'kuzgun-combination-review',createdAt:new Date().toISOString(),appliedToTerminal:false,sourceSnapshot:runSnapshot,result:lastResult,selectedScenario:scenarioResult};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download='kuzgun-kombinasyon-onerisi.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>selectView(button.dataset.view)));
$('viewMonth').addEventListener('change',renderPortfolioView);
$('applyViewRange').addEventListener('click',renderPortfolioView);
$('recommendationRows').addEventListener('change',event=>{
    const index=event.target.dataset.scenarioIndex;
    if(index===undefined)return;
    const selection=[...scenarioSelection];selection[Number(index)]=Number(event.target.value);requestScenario(selection);
});
$('restoreSuggested').addEventListener('click',()=>{if(lastResult?.best)requestScenario(lastResult.best.selection)});
$('restoreBaseline').addEventListener('click',()=>{if(lastResult)requestScenario(lastResult.baseline.selection)});
window.addEventListener('beforeunload' ,()=>worker?.terminate());
readTerminal();
