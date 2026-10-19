(function(){
    'use strict';
    const get=id=>document.getElementById(id);
    const text=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const usd=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
    let activeWorker=null,report=null,partial=[],lockedButtons=[];
    const date=value=>new Date(value).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    function running(value){
        window.kuzgunWalkForwardRunning=value;
        get('wfStart').disabled=value;get('wfStop').hidden=!value;
        document.querySelectorAll('#wfControls input,#wfControls select,#wfLeague,#wfAllowDisable').forEach(element=>element.disabled=value);
        if(value){
            lockedButtons=[...document.querySelectorAll('#startSearch,#applyAllRecommendation,[data-apply-index]')].map(button=>({button,disabled:button.disabled}));
            lockedButtons.forEach(({button})=>button.disabled=true);
        }else{lockedButtons.forEach(({button,disabled})=>button.disabled=disabled);lockedButtons=[]}
    }
    function stop(){if(activeWorker)activeWorker.terminate();activeWorker=null;running(false)}
    function settingLabel(setting){return setting.off?'Pasif':`${text(setting.interval)} / RSI ${setting.rsiLength} · AL ${setting.buyRsi} / SAT ${setting.sellRsi}`}
    function monthRows(rows){
        return rows.map(row=>`<tr><td class="coin-name">${row.monthKey}</td><td>${date(row.trainingStart)}<small>→ ${date(row.trainingEnd)}</small></td><td class="${row.fixed.net<0?'negative':'positive'}">${usd(row.fixed.net)}</td><td class="${row.adaptive.net<0?'negative':'positive'}">${usd(row.adaptive.net)}</td><td>${usd(row.adaptive.endEquity)}</td><td>%${row.adaptive.winRate.toFixed(2)}<small>${row.adaptive.wins} win / ${row.adaptive.losses} lose</small></td><td>${row.fixed.skipped} / ${row.adaptive.skipped}</td><td>${row.adaptive.carriedIn} / ${row.adaptive.openPositions}</td><td><details><summary>Göster</summary><div class="small">${row.plan.map(setting=>`<p>${text(setting.symbol)}: ${settingLabel(setting)}</p>`).join('')}<p class="muted">${row.trainingTrials} eğitim denemesi · ${row.trainingImproved?'Yeni ayar seçildi':'Eğitimdeki başlangıç ayarı korundu'}</p></div></details></td></tr>`).join('');
    }
    function metrics(summary){
        return `<div class="metric"><span>Test sonu portföy değeri</span><strong>${usd(summary.equity)}</strong><small>Net değişim <b class="${summary.net<0?'negative':'positive'}">${usd(summary.net)}</b> · ${summary.base>0?(summary.net/summary.base*100).toFixed(2):'0.00'}%</small><small>Gerçekleşmiş ${usd(summary.realized)} · Açık getiri ${usd(summary.unrealized)}</small></div><div class="metric"><span>Kapanan işlemlerde başarı</span><strong>%${summary.winRate.toFixed(2)}</strong><small>${summary.wins} win / ${summary.losses} lose</small></div><div class="metric"><span>En büyük düşüş</span><strong>%${summary.maxDrawdown.toFixed(2)}</strong><small>Mum kapanışlarında ölçüldü</small></div><div class="metric"><span>Komisyon / açık pozisyon</span><strong>${usd(summary.fees)}</strong><small>${summary.openPositions} açık · ${summary.skipped} slot kaçışı · ${summary.missingFills} eksik açılış</small></div>`;
    }
    function render(value){
        get('wfResults').hidden=false;
        get('wfMonthRows').innerHTML=monthRows(value.folds);
        get('wfFixedMetrics').innerHTML=metrics(value.fixed);get('wfAdaptiveMetrics').innerHTML=metrics(value.adaptive);
        const delta=value.adaptive.equity-value.fixed.equity;
        get('wfDelta').textContent=(delta>=0?'+':'')+usd(delta);get('wfDelta').className=delta<0?'negative':'positive';
        get('wfMonthWins').textContent=value.folds.filter(row=>row.adaptive.net>row.fixed.net+.005).length+' / '+value.folds.length+' test ayında net değişim daha yüksek';
        get('wfCoverage').textContent=(value.coverage||[]).filter(row=>row.missing>0).map(row=>`${row.symbol} / ${row.interval}: ${date(row.first)} — ${date(row.last)}; seçilen aralıkta ${row.missing} eksik mum.`).join(' ')||'Seçilen aralıkta bütün coin ve zaman dilimlerinin mumları mevcut.';
        get('wfResultLabel').textContent=value.label+' · '+value.folds[0].monthKey+' — '+value.folds.at(-1).monthKey+' · İlk test sermayesi '+usd(value.base)+' · '+value.slots+' slot. İki hesap her ay sıfırlanmadan devam etti.';
    }
    function startTest(){
        if(activeWorker)return;
        get('wfError').textContent='';
        try{
            if(typeof worker!=='undefined'&&worker)throw new Error('Önce normal kombinasyon aramasını tamamla veya durdur.');
            assertCurrentReference();
            if(!['wfTrainingStart','wfTestStart','wfTestEnd','wfMinTrades',...(get('wfTrainingMode').value==='rolling'?['wfWindowMonths']:[])].every(id=>get(id).reportValidity()))return;
            const first=get('wfTrainingStart').value,test=get('wfTestStart').value,last=get('wfTestEnd').value;
            if(first>=test)throw new Error('Eğitim başlangıcı ilk test ayından önce olmalı.');
            if(test>last)throw new Error('Son test ayı ilk test ayından önce olamaz.');
            const [endYear,endMonth]=last.split('-').map(Number);
            if(Date.UTC(endYear,endMonth,1,-3)>snapshot.asOf)throw new Error('Yalnızca referans tarihinde tamamlanmış test aylarını seçebilirsin.');
            const config={trainingStart:first,testStart:test,testEnd:last,trainingMode:get('wfTrainingMode').value,windowMonths:Number(get('wfWindowMonths').value),budget:Number(get('wfBudget').value),
                searchScope:get('wfScope').value,minTrades:Number(get('wfMinTrades').value),monthlyMode:get('wfMonthly').value,leagueOnly:get('wfLeague').checked,allowDisable:get('wfAllowDisable').checked};
            activeWorker=new Worker('combination-walkforward.js?v=4-research');
            partial=[];report=null;get('wfDownload').hidden=true;get('wfResults').hidden=true;
            get('wfProgress').hidden=false;get('wfProgressTitle').textContent='İleri dönem testi hazırlanıyor';
            get('wfProgressDetail').textContent='Veri ve eğitim hesabı ayrı işçide yürütülür; sayfayı açık tutabilirsin.';running(true);
            activeWorker.onmessage=({data})=>{
                if(data.type==='progress'||data.type==='wf-progress'){get('wfProgressTitle').textContent=data.message;get('wfProgressDetail').textContent=data.detail||''}
                if(data.type==='wf-fold'){
                    partial.push(data.row);get('wfMonthRows').innerHTML=monthRows(partial);
                    get('wfProgressDetail').textContent=data.completed+' / '+data.total+' test ayı tamamlandı.';
                }
                if(data.type==='wf-error'){stop();get('wfError').textContent=data.message;get('wfProgressTitle').textContent='Test tamamlanamadı';get('wfDownload').hidden=true}
                if(data.type==='wf-result'){stop();report=data;render(data);get('wfDownload').hidden=false;get('wfProgressTitle').textContent='İleri dönem testi tamamlandı';get('wfProgressDetail').textContent='Sonuçlar görüldükten sonra test aylarının ayarları değiştirilmedi. Terminal kayıtlarına yazılmadı.'}
            };
            activeWorker.onerror=event=>{stop();get('wfError').textContent=event.message||'Test işçisi çalıştırılamadı';get('wfProgressTitle').textContent='Test durdu'};
            activeWorker.onmessageerror=()=>{stop();get('wfError').textContent='Test sonucu aktarılamadı. Daha az test ayıyla yeniden deneyebilirsin.'};
            activeWorker.postMessage({snapshot,config});
        }catch(reason){if(activeWorker)stop();get('wfError').textContent=reason.message}
    }
    function syncDates(){
        const reference=typeof snapshot!=='undefined'&&snapshot?snapshot:null;
        const asOf=reference?.asOf||Date.now(),local=new Date(asOf+10800000);
        const monthKey=(year,index)=>new Date(Date.UTC(year,index,1)).toISOString().slice(0,7);
        const last=monthKey(local.getUTCFullYear(),local.getUTCMonth()-1);
        const year=Number(reference?.year)||local.getUTCFullYear();
        for(const id of ['wfTrainingStart','wfTestStart','wfTestEnd'])get(id).max=last;
        if(!get('wfTrainingStart').value)get('wfTrainingStart').value=(year-1)+'-01';
        if(!get('wfTestStart').value)get('wfTestStart').value=year+'-01'<=last?year+'-01':last;
        if(!get('wfTestEnd').value)get('wfTestEnd').value=last;
        const rolling=get('wfTrainingMode').value==='rolling';
        get('wfWindowField').hidden=!rolling;get('wfWindowMonths').required=rolling;
        get('wfDateHint').textContent=rolling?'Her test ayından önceki son '+get('wfWindowMonths').value+' ay ile eğitim yapılır. Eğitim başlangıcı ilk pencereyi dolduracak kadar erken olmalı. Test ayı eğitime girmez.':'Eğitim '+get('wfTrainingStart').value+' ayından başlar ve her test ayından önce genişler. Önceki yıllar hesaba katılır; test ayı eğitime girmez.';
    }
    for(const id of ['wfTrainingStart','wfTestStart','wfTestEnd','wfTrainingMode','wfWindowMonths'])get(id).addEventListener('change',syncDates);
    get('wfPanel').addEventListener('toggle',syncDates);
    syncDates();
    get('wfStart').addEventListener('click',startTest);
    get('wfStop').addEventListener('click',()=>{stop();get('wfProgressTitle').textContent='Test durduruldu';get('wfProgressDetail').textContent='Kısmi sonuçlar tamamlanmış test olarak sunulmadı. Terminal ayarları değişmedi.'});
    get('wfDownload').addEventListener('click',()=>{
        if(!report)return;
        const url=URL.createObjectURL(new Blob([JSON.stringify({applied:false,...report},null,2)],{type:'application/json'}));
        const link=document.createElement('a');link.href=url;link.download='kuzgun-ileri-donem-testi.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    window.addEventListener('beforeunload',()=>activeWorker?.terminate());
})();
