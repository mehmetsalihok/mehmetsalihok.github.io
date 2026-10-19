'use strict';
const $=id=>document.getElementById(id);
const escapeText=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
const pct=value=>(value>=0?'+':'')+Number(value).toFixed(2)+'%';
let snapshot=null,worker=null,result=null,selectedMonth='all';
const appliedSettings=new Map();
function error(message){$('errorMessage').textContent=message||''}
function settingsKey(coins){return JSON.stringify(coins.map(coin=>[coin.id,coin.symbol,coin.interval,Number(coin.rsiLength),Number(coin.buyRsi),Number(coin.sellRsi),Number(coin.profitTarget),Number(coin.monthlyCap),coin.isActive!==false]))}
function recordKey(records){return JSON.stringify(records.map(record=>[record.id,record.coinId,record.symbol,Number(record.entryTime),Number(record.exitTime||0),Number(record.pnlPercent||0),Number(record.entryPrice||0),Number(record.allocatedUsd||0)]))}
function assertCurrentReference(forApply=false) {
    if(!forApply&&appliedSettings.size)throw new Error('Ayar uygulandı. Yeni analiz için terminalden yeni kombinasyon referansı al.');
    if(!snapshot||snapshot.schema!=='kuzgun-combination-v2')throw new Error('Bu sürümün terminal referansı yok. Terminali yenile ve üst menüdeki Kombinasyon bağlantısından aç.');
    const stored=JSON.parse(localStorage.getItem('kuzgun_web_coins')||'[]');
    const args=snapshot.referenceArgs;
    if(settingsKey(stored)!==settingsKey(snapshot.coins.map(coin=>appliedSettings.has(coin.id)?{...coin,...appliedSettings.get(coin.id)}:coin))||
       (Number(localStorage.getItem('kuzgun_base_usd'))||1000)!==Number(args.baseBalance)||
       (Number(localStorage.getItem('kuzgun_max_slots'))||2)!==Number(args.maxSlots)||
       (localStorage.getItem('kuzgun_fee_deduction_enabled')!=='false')!==args.isFeeDeductionEnabled||
       (localStorage.getItem('kuzgun_slot_constraint_enabled')!=='false')!==args.isSlotConstraintEnabled||
       String(localStorage.getItem('kuzgun_selected_year')||'2026')!==snapshot.year||
       (Number(localStorage.getItem('kuzgun_portfolio_start_date'))||0)!==Number(args.startDateTimestamp))
       throw new Error('Terminal ayarları referans alındıktan sonra değişmiş. Terminaldeki Kombinasyon bağlantısından yeni referans al.');
    if(recordKey(JSON.parse(localStorage.getItem('kuzgun_closed_trades')||'[]'))!==recordKey(snapshot.closedTrades)||
       recordKey(JSON.parse(localStorage.getItem('kuzgun_active_pos')||'[]'))!==recordKey(args.activePositions)||
       recordKey(JSON.parse(localStorage.getItem('kuzgun_pending_closed_trades')||'[]'))!==recordKey(snapshot.pendingClosedTrades))
       throw new Error('Terminal işlem kayıtları değişmiş. Karşılaştırmadan önce terminalden yeni referans al.');
    if(!snapshot.coins.length)throw new Error('Terminalde karşılaştırılacak coin yok.');
}
function matchingLeagueRecords(snapshot,coin,records) {
    return records.filter(row=>row&&row.symbol===coin.symbol&&String(row.year)===snapshot.year&&
        Number(row.startTime)===Date.UTC(Number(snapshot.year),0,1)&&Number.isFinite(row.endTime)&&row.endTime<=snapshot.asOf&&row.endTime>row.startTime&&
        Math.abs(Number(row.profitTarget)-Number(coin.profitTarget))<1e-8&&Math.abs(Number(row.monthlyCap)-Number(coin.monthlyCap))<1e-8&&
        ['15m','30m'].includes(row.interval)&&[6,7].includes(row.rsiLength)&&Number.isFinite(row.buyRsi)&&row.buyRsi>=8&&row.buyRsi<=50&&
        Number.isFinite(row.sellRsi)&&row.sellRsi>=55&&row.sellRsi<=98&&row.buyRsi<row.sellRsi);
}function eligibleLeagueRecords(allYears=false) {
    let saved;try{saved=JSON.parse(localStorage.getItem('kuzgun_league_candidates_v1')||'null')}catch(_){saved=null}
    if(saved?.schema!=='kuzgun-league-candidates-v2'||!Array.isArray(saved.records))return [];
    return allYears?saved.records:snapshot.coins.flatMap(coin=>matchingLeagueRecords(snapshot,coin,saved.records));
}
function analysisRangeConfig(){
    if($('analysisPeriod').value!=='range')return null;
    if(![$('analysisStart'),$('analysisEnd')].every(input=>input.reportValidity()))throw new Error('Başlangıç ve bitiş aylarını seç.');
    const first=$('analysisStart').value,last=$('analysisEnd').value;
    if(!first||!last||first>last)throw new Error('Geçerli bir tarih aralığı seç.');
    if(last>new Date(snapshot.asOf+10800000).toISOString().slice(0,7))throw new Error('Bitiş ayı referans tarihinden sonra olamaz.');
    return {rangeStart:first,rangeEnd:last};
}
function updateAnalysisPeriod(){
    const custom=$('analysisPeriod').value==='range';
    $('analysisStartField').hidden=!custom;$('analysisEndField').hidden=!custom;
    $('analysisStart').required=custom;$('analysisEnd').required=custom;
    if(snapshot){
        const last=new Date(snapshot.asOf+10800000).toISOString().slice(0,7);
        $('analysisStart').max=last;$('analysisEnd').max=last;
        if(!$('analysisStart').value)$('analysisStart').value=(Number(snapshot.year)-1)+'-01';
        if(!$('analysisEnd').value)$('analysisEnd').value=last;
    }
    $('analysisPeriodHint').textContent=custom?'Mevcut ayarlar ve tek bir öneri seçilen dönemde simüle edilir. Başlangıç sermayesi terminalden alınır; gerçek işlemler ve bugünkü açık pozisyonlar içeri aktarılmaz. Sonuç kapanmış işlemlere dayanır; her ay ayrı ayar seçilmez.':'Terminalde seçili yılın mevcut hesap ve gerçek işlem kayıtlarıyla karşılaştırma yapılır.';
    updateLeagueStatus();
}
function updateLeagueStatus() {
    if(!snapshot)return;
    if($('analysisPeriod').value==='range'){
        $('leagueRecordStatus').textContent=$('leagueOnly').checked?'Lig modu: seçili döneme ait, bitiş tarihinden sonra üretilmemiş kayıtlı AL/SAT çiftleri denenir. Eşikler değiştirilmez; eksik kayıt varsa arama durur.':'Serbest arama: seçili dönem için RSI, zaman dilimi ve AL/SAT eşikleri birlikte denenir.';return;
    }
    try {
        const records=eligibleLeagueRecords(),missing=snapshot.coins.filter(coin=>!matchingLeagueRecords(snapshot,coin,records).length);
        $('leagueRecordStatus').textContent=$('leagueOnly').checked?
            (missing.length?'Lig modu için kayıt eksik/uyumsuz: '+missing.map(coin=>coin.displaySymbol||coin.symbol).join(', '):'Lig modu hazır: '+records.length+' kayıtlı aday. AL/SAT eşikleri sabit kalacak.'):
            'Serbest arama: RSI, zaman dilimi ve AL/SAT eşikleri birlikte denenir. Lig modunu açarsan yalnızca kaydedilmiş lig adayları kullanılır.';
    }catch(reason){$('leagueRecordStatus').textContent=reason.message}
}
function applyCoinRecommendation(index) {
    try {
        if(window.kuzgunWalkForwardRunning)throw new Error('İleri dönem testi sürerken ayar uygulanmaz; testin tamamlanmasını bekle.');
        if(!result?.recommendation)throw new Error('Uygulanacak öneri yok');
        if(!Number.isInteger(index)||!result.groups[index])throw new Error('Coin seçimi geçersiz');
        const group=result.groups[index],candidate=group.options[result.recommendation.selection[index]].settings;
        if(result.recommendation.selection[index]===0)return;
        if(appliedSettings.has(group.coin.id))return;
        assertCurrentReference(true);
        const beforeRaw=localStorage.getItem('kuzgun_web_coins');
        const coins=JSON.parse(beforeRaw||'[]');
        const current=coins.find(coin=>coin.id===group.coin.id&&coin.symbol===group.coin.symbol);
        if(!current)throw new Error('Coin terminalde bulunamadı');
        const patch=candidate.off?{isActive:false}:{interval:candidate.interval,rsiLength:candidate.rsiLength,buyRsi:candidate.buyRsi,sellRsi:candidate.sellRsi,isActive:true};
        if(!candidate.off&&(!['5m','15m','30m','1h','4h'].includes(patch.interval)||![6,7,group.coin.rsiLength].includes(patch.rsiLength)||
            !Number.isFinite(patch.buyRsi)||!Number.isFinite(patch.sellRsi)||patch.buyRsi>=patch.sellRsi))throw new Error('Öneri ayarları geçersiz');
        const replacement=coins.map(coin=>coin.id===current.id?{...coin,...patch}:coin);
        if(localStorage.getItem('kuzgun_web_coins')!==beforeRaw)throw new Error('Terminal ayarları değişti; yeniden referans al');
        localStorage.setItem('kuzgun_web_coins',JSON.stringify(replacement));
        appliedSettings.set(group.coin.id,patch);
        const previousMonth=selectedMonth;renderResult();showMonth(previousMonth);
        $('applyStatus').textContent=(group.coin.displaySymbol||group.coin.symbol)+' için önerilen ayarlar terminale kaydedildi. Diğer coinler ayrı uygulanır. Yeni analiz için terminalden yeni referans al.';
        $('startSearch').disabled=true;
    }catch(reason){$('applyStatus').textContent='Ayar uygulanmadı: '+reason.message}
}

function readSnapshot() {
    return new Promise((resolve,reject)=>{
        const request=indexedDB.open('KuzgunCandlesDB',1);
        request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('candles'))db.createObjectStore('candles',{keyPath:'key'})};
        request.onerror=()=>reject(new Error('Terminal referansına erişilemedi'));
        request.onsuccess=()=>{
            const db=request.result,tx=db.transaction('candles','readonly');
            const read=tx.objectStore('candles').get('kuzgun_combination_terminal_v2');
            read.onsuccess=()=>resolve(read.result?.data||null);
            read.onerror=()=>reject(new Error('Referans okunamadı'));
            tx.oncomplete=()=>db.close();tx.onabort=()=>{db.close();reject(new Error('Referans okuma iptal edildi'))};
        };
    });
}
function setRunning(active){
    $('startSearch').disabled=active||!snapshot;$('stopSearch').hidden=!active;
    document.querySelectorAll('#searchControls input,#searchControls select,#allowDisable,#leagueOnly').forEach(element=>element.disabled=active);
}
function stop(){if(worker)worker.terminate();worker=null;setRunning(false)}
async function initialize(){
    try{
        snapshot=await readSnapshot();assertCurrentReference();
        $('referenceBalance').textContent=money(snapshot.expected.compoundedBalance);
        $('referenceMeta').textContent='Referans anı: '+new Date(snapshot.asOf).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'})+' · '+snapshot.referenceArgs.maxSlots+' slot';
        $('referencePeriod').textContent=snapshot.year+' yılının mumları · Sermaye '+money(snapshot.referenceArgs.baseBalance)+' · Komisyon '+(snapshot.referenceArgs.isFeeDeductionEnabled?'açık':'kapalı');
        $('coinCount').textContent=snapshot.coins.length+' coin';
        $('referenceStatus').textContent='Analiz başlarken terminal hesabıyla eşleşme kontrol edilecek.';
        $('startSearch').disabled=false;
        updateAnalysisPeriod();
    }catch(reason){snapshot=null;$('startSearch').disabled=true;error(reason.message)}
}
function start(){
    if(window.kuzgunWalkForwardRunning){error('Önce ileri dönem testini durdur veya tamamlanmasını bekle.');return}
    if(worker)return;error('');
    const min=$('minTrades');if(!min.reportValidity())return;
    let leagueRecords=[],range=null;
    try{
        assertCurrentReference();
        range=analysisRangeConfig();
        if($('leagueOnly').checked){
            leagueRecords=eligibleLeagueRecords(!!range);
            const missing=range?[]:snapshot.coins.filter(coin=>!matchingLeagueRecords(snapshot,coin,leagueRecords).length);
            if(missing.length)throw new Error('Lig kaydı eksik veya uyumsuz: '+missing.map(coin=>coin.displaySymbol||coin.symbol).join(', ')+'. Aynı yıl, hedef kâr ve aylık kilitle 15m/30m lig taraması yap; ardından terminalden yeni referans al.');
        }
        worker=new Worker(range?'combination-range.js?v=3-classic':'combination-worker.js?v=26-classic');
    }catch(reason){error(reason.message);return}
    const config={...range,minTrades:Number(min.value),monthlyMode:$('monthlyMode').value,budget:Number($('searchBudget').value),allowDisable:$('allowDisable').checked,leagueOnly:$('leagueOnly').checked,leagueRecords};
    result=null;$('applyStatus').textContent='';$('resultSection').hidden=true;$('progressBox').hidden=false;$('progressTitle').textContent='Terminal referansı doğrulanıyor';$('progressDetail').textContent='Aynı bakiye ve aynı slota kabul edilen işlem listesi bekleniyor.';setRunning(true);
    worker.onmessage=({data})=>{
        if(data.type==='progress'){$('progressTitle').textContent=data.message;$('progressDetail').textContent=data.detail}
        if(data.type==='reference'){
            $('referenceStatus').textContent='Terminal referansı doğrulandı: bakiye ve kabul edilen işlemler eşleşiyor.';
            $('referenceBalance').textContent=money(data.baseline.balance);
        }
        if(data.type==='range-reference'){
            $('referenceStatus').textContent='Terminal referansı doğrulandı. Sonuçlar seçili tarih aralığının ayrı simülasyonudur.';
        }
        if(data.type==='error'){stop();$('progressTitle').textContent='Analiz tamamlanamadı';error(data.message)}
        if(data.type==='result'){stop();result=data;renderResult();$('progressTitle').textContent='Karşılaştırma tamamlandı';$('progressDetail').textContent=data.tested+' portföy denemesi yapıldı.'}
    };
    worker.onerror=event=>{stop();$('progressTitle').textContent='Analiz durdu';error(event.message||'Analiz işçisi çalıştırılamadı')};
    worker.onmessageerror=()=>{stop();error('Analiz sonucu aktarılamadı. Hafif bütçeyle yeniden deneyebilirsin.')};
    worker.postMessage({snapshot,config});
}
function settingsLabel(settings){return settings.off?'Pasif':`${escapeText(settings.interval)} / RSI ${settings.rsiLength}<small>AL ${settings.buyRsi} / SAT ${settings.sellRsi}</small>`}
function period(summary){
    if(selectedMonth==='all')return {...summary,net:summary.realized-result.base,gross:Object.values(summary.months).reduce((sum,row)=>sum+row.gross,0),netPercent:Object.values(summary.months).reduce((sum,row)=>sum+row.netPercent,0)};
    const row=summary.months[selectedMonth]||{net:0,fees:0,gross:0,netPercent:0,trades:0,wins:0};
    const balance=result.base+Object.entries(summary.months).filter(([key])=>key<=selectedMonth).reduce((sum,[,month])=>sum+month.net,0);
    return {...row,balance,realized:balance,unrealized:0,winRate:row.trades?row.wins/row.trades*100:0,losses:row.trades-row.wins};
}
function metrics(summary){
    const view=period(summary),capital=100*view.net/result.base;
    return `<div class="metric"><span>${selectedMonth==='all'?(result.analysisRange?'Dönem sonu gerçekleşmiş bakiye':'Toplam portföy bakiyesi'):'Ay sonu gerçekleşmiş bakiye'}</span><strong>${money(view.balance)}</strong><small>Net kazanç: <b class="${view.net<0?'negative':'positive'}">${view.net>=0?'+':''}${money(view.net)}</b> · Sermayeye ${pct(capital)}</small>${selectedMonth==='all'?`<small>${result.analysisRange?'Kapanmış işlemler; dönem sonu açık pozisyon değeri dahil değil.':`Gerçekleşmiş bakiye ${money(view.realized)} · Sabit açık pozisyon getirisi ${money(view.unrealized)}`}</small>`:''}</div><div class="metric"><span>Kazanma oranı</span><strong>%${view.winRate.toFixed(2)}</strong><small>${view.wins} win / ${view.losses} lose · ${view.trades} işlem</small></div><div class="metric"><span>Brüt / net işlem getirisi</span><strong>${pct(view.gross)}</strong><small>Net ${pct(view.netPercent)}</small></div><div class="metric"><span>Komisyon</span><strong>${money(view.fees)}</strong><small>Analizdeki tercih uygulandı</small></div>`;
}
function monthTitle(key){return new Intl.DateTimeFormat('tr-TR',{year:'numeric',month:'long',timeZone:'Europe/Istanbul'}).format(new Date(key+'-15T12:00:00Z'))}
function showMonth(key){
    selectedMonth=key;
    document.querySelectorAll('[data-month]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.month===key)));
    const next=result.recommendation||result.baseline;
    $('currentMetrics').innerHTML=metrics(result.baseline);$('suggestedMetrics').innerHTML=metrics(next);
    $('viewLabel').textContent=key==='all'?(result.analysisRange?result.analysisRange.startMonth+' — '+result.analysisRange.endMonth+' · Seçilen dönemin kapanmış işlem simülasyonu':result.year+' · Yılbaşından terminal referans anına kadar'):monthTitle(key)+' · Kapanmış işlemler';
    const delta=period(next).net-period(result.baseline).net;
    $('deltaLabel').textContent=key==='all'?'Toplam gerçekleşmiş net kazanç farkı':'Bu ayın net kazanç farkı';
    $('gainDelta').textContent=(delta>=0?'+':'')+money(delta);$('gainDelta').className=delta<0?'negative':'positive';
    $('slotDifference').textContent=`Tüm dönemde kaçan sinyal: ${result.baseline.skipped} → ${next.skipped}`;
}
function renderResult(){
    $('resultSection').hidden=false;
    $('analysisCoverage').hidden=!result.analysisRange;
    if(result.analysisRange){const gaps=(result.coverage||[]).filter(row=>row.missing>0);$('analysisCoverage').textContent='Dönem simülasyonu: terminaldeki gerçek bakiye değildir. '+(gaps.length?gaps.map(row=>row.symbol+' / '+row.interval+': veri başlangıcı '+new Date(row.first).toLocaleDateString('tr-TR',{timeZone:'Europe/Istanbul'})+', '+row.missing+' eksik mum.').join(' '):'Seçilen aralıkta tüm coin ve zaman dilimlerinin mumları mevcut.')}
    const recommended=result.recommendation,comparison=recommended||result.baseline;
    $('suggestionLabel').textContent=recommended?'BULUNAN DAHA İYİ KOMBİNASYON':'MEVCUT DÜZEN KORUNDU';
    $('resultStatus').textContent=recommended?'Toplam kazanç ve seçilen aylık denge koşulları sağlandı.':'Taranan adaylar içinde daha iyi ve koşullara uygun bir kombinasyon bulunamadı.';
    $('keepMessage').hidden=!!recommended;
    $('keepMessage').textContent='Mevcut düzeni koru. Daha düşük kazançlı veya başarı/aylık denge koşullarını bozan bir ayar önerilmedi.';
    $('monthSelector').innerHTML='<button data-month="all" aria-pressed="true">Başlangıçtan beri</button>'+result.months.map(key=>`<button data-month="${key}" aria-pressed="false">${escapeText(monthTitle(key))}</button>`).join('');
    $('monthlyRows').innerHTML=result.months.map(key=>{
        const a=result.baseline.months[key]||{net:0,gross:0,netPercent:0,fees:0},b=comparison.months[key]||{net:0,gross:0,netPercent:0,fees:0},delta=b.net-a.net;
        return `<tr><td><button data-month="${key}">${escapeText(monthTitle(key))}</button></td><td>${money(a.net)}</td><td>${money(b.net)}</td><td class="${delta<-.005?'negative':'positive'}">${delta>=0?'+':''}${money(delta)}</td><td>${pct(a.gross)} / ${pct(b.gross)}</td><td>${pct(a.netPercent)} / ${pct(b.netPercent)}</td><td>${money(a.fees)} / ${money(b.fees)}</td></tr>`;
    }).join('');
    $('settingsRows').innerHTML=result.groups.map((group,index)=>{
        const old=group.options[0].settings,option=group.options[comparison.selection[index]].settings;
        const before=result.baseline.coins[group.coin.id],after=comparison.coins[group.coin.id];
        const action=old.off?(option.off?'Pasif kalsın':'Aktifleştir'):option.off?'Pasife al':comparison.selection[index]===0?'Koru':'Ayarı değiştir';
        return `<tr><td class="coin-name">${escapeText(group.coin.displaySymbol||group.coin.symbol)}</td><td>${settingsLabel(old)}</td><td>${settingsLabel(option)}</td><td>${recommended&&comparison.selection[index]!==0?`<button type="button" data-apply-index="${index}" ${appliedSettings.has(group.coin.id)?'disabled':''}>${appliedSettings.has(group.coin.id)?'Uygulandı':action}</button>`:action}</td><td>%${before.winRate.toFixed(2)} → %${after.winRate.toFixed(2)}<small>${after.wins} win / ${after.trades-after.wins} lose · ${after.trades} işlem</small></td><td>${money(before.net)} / ${money(after.net)}</td></tr>`;
    }).join('');
    $('searchCoverage').textContent=`${result.tested}/${result.budget} portföy denemesi. ${result.config.leagueOnly?'Lig modu: kayıtlı AL/SAT eşikleri değiştirilmedi.':'Serbest mod: AL/SAT eşikleri dahil arama yapıldı.'} Sınırlı ve kademeli arama yapıldı; tüm olası kombinasyonların tarandığı iddia edilmez. Referans anı: ${new Date(result.asOf).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'})}.`;
    showMonth('all');
}
$('startSearch').addEventListener('click',start);
$('stopSearch').addEventListener('click',()=>{stop();$('progressTitle').textContent='Analiz durduruldu';$('progressDetail').textContent='Terminal ayarları değiştirilmedi.'});
$('resultSection').addEventListener('click',event=>{const apply=event.target.closest('[data-apply-index]');if(apply){applyCoinRecommendation(Number(apply.dataset.applyIndex));return}const button=event.target.closest('[data-month]');if(button&&result)showMonth(button.dataset.month)});
$('leagueOnly').addEventListener('change',updateLeagueStatus);
for(const id of ['analysisPeriod','analysisStart','analysisEnd'])$(id).addEventListener('change',updateAnalysisPeriod);
$('downloadResult').addEventListener('click',()=>{
    if(!result)return;
    const payload={type:'kuzgun-combination-v2-review',applied:false,createdAt:new Date().toISOString(),result};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='kuzgun-kombinasyon-v2-rapor.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
window.addEventListener('beforeunload',()=>worker?.terminate());
initialize();
