'use strict';
const $=id=>document.getElementById(id);
const escapeText=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
const pct=value=>(value>=0?'+':'')+Number(value).toFixed(2)+'%';
let snapshot=null,worker=null,result=null,selectedMonth='all';
function error(message){$('errorMessage').textContent=message||''}
function settingsKey(coins){return JSON.stringify(coins.map(coin=>[coin.id,coin.symbol,coin.interval,Number(coin.rsiLength),Number(coin.buyRsi),Number(coin.sellRsi),Number(coin.profitTarget),Number(coin.monthlyCap),coin.isActive!==false]))}
function recordKey(records){return JSON.stringify(records.map(record=>[record.id,record.coinId,record.symbol,Number(record.entryTime),Number(record.exitTime||0),Number(record.pnlPercent||0),Number(record.entryPrice||0),Number(record.allocatedUsd||0)]))}
function assertCurrentReference() {
    if(!snapshot||snapshot.schema!=='kuzgun-combination-v2')throw new Error('Bu sürümün terminal referansı yok. Terminali yenile ve üst menüdeki Kombinasyon bağlantısından aç.');
    const stored=JSON.parse(localStorage.getItem('kuzgun_web_coins')||'[]');
    const args=snapshot.referenceArgs;
    if(settingsKey(stored)!==settingsKey(snapshot.coins)||
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
    document.querySelectorAll('#searchControls input,#searchControls select,#allowDisable').forEach(element=>element.disabled=active);
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
    }catch(reason){snapshot=null;$('startSearch').disabled=true;error(reason.message)}
}
function start(){
    if(worker)return;error('');
    const min=$('minTrades');if(!min.reportValidity())return;
    try{assertCurrentReference();worker=new Worker('combination-worker.js?v=20-reference')}catch(reason){error(reason.message);return}
    const config={minTrades:Number(min.value),monthlyMode:$('monthlyMode').value,budget:Number($('searchBudget').value),allowDisable:$('allowDisable').checked};
    result=null;$('resultSection').hidden=true;$('progressBox').hidden=false;$('progressTitle').textContent='Terminal referansı doğrulanıyor';$('progressDetail').textContent='Aynı bakiye ve aynı slota kabul edilen işlem listesi bekleniyor.';setRunning(true);
    worker.onmessage=({data})=>{
        if(data.type==='progress'){$('progressTitle').textContent=data.message;$('progressDetail').textContent=data.detail}
        if(data.type==='reference'){
            $('referenceStatus').textContent='Terminal referansı doğrulandı: bakiye ve kabul edilen işlemler eşleşiyor.';
            $('referenceBalance').textContent=money(data.baseline.balance);
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
    return `<div class="metric"><span>${selectedMonth==='all'?'Toplam portföy bakiyesi':'Ay sonu gerçekleşmiş bakiye'}</span><strong>${money(view.balance)}</strong><small>Net kazanç: <b class="${view.net<0?'negative':'positive'}">${view.net>=0?'+':''}${money(view.net)}</b> · Sermayeye ${pct(capital)}</small>${selectedMonth==='all'?`<small>Gerçekleşmiş bakiye ${money(view.realized)} · Sabit açık pozisyon getirisi ${money(view.unrealized)}</small>`:''}</div><div class="metric"><span>Kazanma oranı</span><strong>%${view.winRate.toFixed(2)}</strong><small>${view.wins} win / ${view.losses} lose · ${view.trades} işlem</small></div><div class="metric"><span>Brüt / net işlem getirisi</span><strong>${pct(view.gross)}</strong><small>Net ${pct(view.netPercent)}</small></div><div class="metric"><span>Komisyon</span><strong>${money(view.fees)}</strong><small>Analizdeki tercih uygulandı</small></div>`;
}
function monthTitle(key){return new Intl.DateTimeFormat('tr-TR',{year:'numeric',month:'long',timeZone:'Europe/Istanbul'}).format(new Date(key+'-15T12:00:00Z'))}
function showMonth(key){
    selectedMonth=key;
    document.querySelectorAll('[data-month]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.month===key)));
    const next=result.recommendation||result.baseline;
    $('currentMetrics').innerHTML=metrics(result.baseline);$('suggestedMetrics').innerHTML=metrics(next);
    $('viewLabel').textContent=key==='all'?result.year+' · Yılbaşından terminal referans anına kadar':monthTitle(key)+' · Kapanmış işlemler';
    const delta=period(next).net-period(result.baseline).net;
    $('deltaLabel').textContent=key==='all'?'Toplam gerçekleşmiş net kazanç farkı':'Bu ayın net kazanç farkı';
    $('gainDelta').textContent=(delta>=0?'+':'')+money(delta);$('gainDelta').className=delta<0?'negative':'positive';
    $('slotDifference').textContent=`Tüm dönemde kaçan sinyal: ${result.baseline.skipped} → ${next.skipped}`;
}
function renderResult(){
    $('resultSection').hidden=false;
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
        return `<tr><td class="coin-name">${escapeText(group.coin.displaySymbol||group.coin.symbol)}</td><td>${settingsLabel(old)}</td><td>${settingsLabel(option)}</td><td>${action}</td><td>%${before.winRate.toFixed(2)} → %${after.winRate.toFixed(2)}<small>${after.wins} win / ${after.trades-after.wins} lose · ${after.trades} işlem</small></td><td>${money(before.net)} / ${money(after.net)}</td></tr>`;
    }).join('');
    $('searchCoverage').textContent=`${result.tested}/${result.budget} portföy denemesi. AL/SAT eşikleri dahil sınırlı ve kademeli arama yapıldı; tüm olası kombinasyonların tarandığı iddia edilmez. Referans anı: ${new Date(result.asOf).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'})}.`;
    showMonth('all');
}
$('startSearch').addEventListener('click',start);
$('stopSearch').addEventListener('click',()=>{stop();$('progressTitle').textContent='Analiz durduruldu';$('progressDetail').textContent='Terminal ayarları değiştirilmedi.'});
$('resultSection').addEventListener('click',event=>{const button=event.target.closest('[data-month]');if(button&&result)showMonth(button.dataset.month)});
$('downloadResult').addEventListener('click',()=>{
    if(!result)return;
    const payload={type:'kuzgun-combination-v2-review',applied:false,createdAt:new Date().toISOString(),result};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='kuzgun-kombinasyon-v2-rapor.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
window.addEventListener('beforeunload',()=>worker?.terminate());
initialize();
