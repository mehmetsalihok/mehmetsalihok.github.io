'use strict';
importScripts('combination-walkforward.js?v=4-research');
const researchDeliver=self.postMessage.bind(self);
function researchBounds(source,config){
    const n=Number(config.testMonths);
    if(!Number.isInteger(n)||n<1||n>6)throw new Error('Bağımsız test süresi 1–6 ay olmalı.');
    const first=config.rangeStart?wfParseMonth(config.rangeStart).time:wfMonthStart(Number(source.year),0);
    let end;
    if(config.rangeEnd){const last=wfParseMonth(config.rangeEnd);end=wfMonthStart(last.year,last.index+1)}
    else end=wfMonthStart(Number(source.year)+1,0);
    const now=new Date(source.asOf+10800000),completedEnd=wfMonthStart(now.getUTCFullYear(),now.getUTCMonth());
    end=Math.min(end,completedEnd);
    const date=new Date(end+10800000),cutoff=wfMonthStart(date.getUTCFullYear(),date.getUTCMonth()-n);
    if(cutoff<wfMonthStart(new Date(first+10800000).getUTCFullYear(),new Date(first+10800000).getUTCMonth()+3))
        throw new Error('En az 3 eğitim ayı ve seçtiğin sayıda tamamlanmış test ayı gerekli. Dönemi uzat veya test ayını azalt.');
    if((end-first)/86400000>1830)throw new Error('En fazla 5 yıllık araştırma dönemi seçebilirsin.');
    return {start:first,cutoff,end,startMonth:getTurkeyMonthKey(first),trainingEnd:getTurkeyMonthKey(cutoff-1),testStart:getTurkeyMonthKey(cutoff),endMonth:getTurkeyMonthKey(end-1)};
}
function researchConfig(config){
    if(!['standard','broad'].includes(config.searchScope))throw new Error('Arama kapsamı geçersiz.');
    for(const [key,min,max] of [['minTestTrades',1,1000],['maxDrawdown',1,80]]){
        if(!Number.isFinite(Number(config[key]))||Number(config[key])<min||Number(config[key])>max)throw new Error('Doğrulama sınırları geçersiz.');
    }
    if(!Number.isInteger(Number(config.minTestTrades)))throw new Error('Test işlem sayısı tam sayı olmalı.');
    return {...config,testMonths:Number(config.testMonths),minTestTrades:Number(config.minTestTrades),maxDrawdown:Number(config.maxDrawdown)};
}
function researchIntervals(coins,config){return [...new Set([...coins.map(c=>c.interval),...(!config.leagueOnly && config.searchScope==='broad'?['5m','15m','30m','1h','4h']:['15m','30m'])])];}
function researchCoverage(candles,interval,start,end){
    const ms=TF[interval],first=Math.ceil(start/ms)*ms,last=Math.floor((end-ms)/ms)*ms;
    const expected=Math.max(0,Math.floor((last-first)/ms)+1);
    const relevant=KuzgunStrategy.prepare(candles,interval,end).filter(bar=>bar.time>=start);
    const invalid=relevant.filter(c=>c.time%ms!==0 || !['open','high','low','close'].every(key=>Number.isFinite(c[key]) && c[key]>0) || c.high<Math.max(c.open,c.close) || c.low>Math.min(c.open,c.close) || c.high<c.low).length;
    let gaps=0;for(let i=1;i<relevant.length;i++)if(relevant[i].time-relevant[i-1].time!==ms)gaps++;
    return {candles:relevant.length,expected,missing:Math.max(0,expected-relevant.length),gaps,invalid,
        first:relevant[0]?.time,last:relevant.at(-1)?.time+ms,complete:relevant.length===expected && gaps===0 && invalid===0 && (!expected || relevant[0]?.time===first && relevant.at(-1)?.time===last)};
}
function researchStreams(source,history){
    const streams=[];
    for(const coin of source.coins)for(const [key,candles] of history){
        const [symbol,interval]=key.split('|');if(symbol!==coin.symbol)continue;
        const features={};for(const length of [...new Set([6,7,8,10,14,coin.rsiLength])])features[length]=KuzgunStrategy.rsiHistory(candles.map(c=>c.close),length);
        streams.push({coinId:coin.id,interval,ms:TF[interval],candles,features});
    }
    return streams;
}
function researchFolds(start,end){
    const local=new Date(start+10800000),folds=[];
    for(let i=local.getUTCMonth();wfMonthStart(local.getUTCFullYear(),i)<end;i++){
        const time=wfMonthStart(local.getUTCFullYear(),i);
        folds.push({monthKey:getTurkeyMonthKey(time),start:time,end:Math.min(end,wfMonthStart(local.getUTCFullYear(),i+1))});
    }
    return folds;
}
function researchReplay(source,plans,streams,start,end,execution={}){
    const active=new Set();plans.forEach(plan=>plan.forEach((setting,i)=>{if(!setting.off)active.add(source.coins[i].id+'|'+setting.interval)}));
    const used=streams.filter(s=>active.has(s.coinId+'|'+s.interval));
    const accounts=plans.map(()=>wfAccount(source.referenceArgs.baseBalance)),months=[];
    for(const fold of researchFolds(start,end)){
        const rows=wfReplayMonth(accounts,plans,used,source.coins,fold,source.referenceArgs.maxSlots,source.referenceArgs.isFeeDeductionEnabled,execution);
        months.push({monthKey:fold.monthKey,rows});
    }
    return {summaries:accounts.map(wfSummary),months};
}
function researchNeighborPlans(plan){
    const variants=[];
    plan.forEach((s,index)=>{if(s.off)return;for(const [db,ds] of [[-1,0],[1,0],[0,-1],[0,1]]){
        const next={...s,buyRsi:s.buyRsi+db,sellRsi:s.sellRsi+ds};
        if(next.buyRsi<8||next.buyRsi>50||next.sellRsi<55||next.sellRsi>98||next.buyRsi>=next.sellRsi)continue;
        variants.push({coinIndex:index,buyRsi:next.buyRsi,sellRsi:next.sellRsi,plan:plan.map((old,i)=>i===index?next:old)});
    }});
    // Cover the full coin list evenly if the portfolio has more than 40 neighbors.
    const selected=variants.length<=40?variants:Array.from({length:40},(_,i)=>variants[Math.floor(i*variants.length/40)]);
    return {available:variants.length,selected};
}
function researchGate(validation,hasCandidate,config){
    const issues=[],test=validation.forward.candidate,reference=validation.forward.baseline;
    const numeric=[validation.training.baseline.equity,validation.training.candidate.equity,reference.equity,test.equity,test.net,test.trades,test.maxDrawdown,...validation.stress.flatMap(s=>[s.candidate.net,s.candidate.maxDrawdown,s.candidate.trades])];
    if(numeric.some(value=>!Number.isFinite(value)) || validation.neighbors.tested && !Number.isFinite(validation.neighbors.passRate))issues.push('Hesaplamada geçersiz sayısal sonuç var.');
    if(!hasCandidate)issues.push('Eğitimde koşullara uygun daha iyi aday bulunamadı.');
    if(validation.training.candidate.equity<=validation.training.baseline.equity+.005)issues.push('Aday, eğitimde nakit ve slot hesabıyla yeniden oynatıldığında referansı geçmedi.');
    if(test.trades<config.minTestTrades)issues.push('Bağımsız testte yeterli kapanmış işlem yok.');
    if(test.net<=0)issues.push('Bağımsız testte net getiri pozitif değil.');
    if(test.equity+.005<reference.equity)issues.push('Bağımsız testte referans portföyün gerisinde kaldı.');
    if(test.maxDrawdown>config.maxDrawdown)issues.push('Bağımsız testte düşüş sınırı aşıldı.');
    const months=validation.forward.months||[],before=months.map(m=>m.rows[0].net),after=months.map(m=>m.rows[1].net);
    if(config.monthlyMode==='strict'){
        if(after.some((net,i)=>net+.005<before[i]))issues.push('Bağımsız testte en az bir ayın net kazancı geriledi.');
    }else if(months.length){
        if(after.filter(n=>n<-.005).length>before.filter(n=>n<-.005).length || Math.min(...after)<Math.min(...before)-.005
            || after.filter((n,i)=>n>before[i]+.005).length<after.filter((n,i)=>n<before[i]-.005).length)
            issues.push('Bağımsız testte aylık denge koşulları bozuldu.');
    }
    if(test.missingFills || validation.training.candidate.missingFills)issues.push('Eksik açılış verisi nedeniyle gerçekleştirilemeyen işlemler var.');
    for(const scenario of validation.stress){
        const r=scenario.candidate;
        if(r.net<=0||r.maxDrawdown>config.maxDrawdown||r.trades<config.minTestTrades||r.missingFills)issues.push(scenario.label+' kontrolü geçilemedi.');
    }
    if(validation.neighbors.tested && validation.neighbors.passRate<70)issues.push('Yakın AL/SAT eşiklerinde dayanıklılık %70 altında.');
    return {passed:issues.length===0,issues};
}
async function runResearch(source,input){
    const config=researchConfig(input),bounds=researchBounds(source,config);
    const verified=verifyReference(source);
    researchDeliver({type:'reference',baseline:verified.baseline,asOf:source.asOf});
    if(!source.referenceArgs.isSlotConstraintEnabled)throw new Error('Slot filtresini açıp terminalden yeni referans al.');
    const history=new Map(),coverage=[],intervals=researchIntervals(source.coins,config);
    SNAP={...source,historyStart:bounds.start,historyEnd:bounds.end};
    for(const coin of source.coins)for(const interval of intervals){
        researchDeliver({type:'progress',message:coin.symbol+' / '+interval+' · Araştırma verisi',detail:'Eğitim: '+bounds.startMonth+' — '+bounds.trainingEnd+' · Ayrı test: '+bounds.testStart+' — '+bounds.endMonth});
        const cached=interval===coin.interval?(coin.rawCandles||[]):[];
        const reuse=researchCoverage(cached,interval,bounds.start,bounds.end).complete;
        const data=reuse?cached:await fetchYear(coin.symbol,interval);
        const candles=KuzgunStrategy.prepare(data,interval,bounds.end).filter(c=>c.time>=bounds.start);
        const row={symbol:coin.symbol,interval,...researchCoverage(candles,interval,bounds.start,bounds.end)};
        if(!row.complete)throw new Error(coin.symbol+' / '+interval+': seçilen dönemde eksik veya kesintili mum verisi var. Dönemi daralt; eksik veriyle doğrulanmış öneri üretilmedi.');
        coverage.push(row);history.set(wfKey(coin.symbol,interval),candles);
    }
    const baselinePlan=source.coins.map(c=>c.isActive===false?{off:true}:{interval:c.interval,rsiLength:c.rsiLength,buyRsi:c.buyRsi,sellRsi:c.sellRsi});
    const training=wfMakeTraining(source,history,bounds.cutoff,baselinePlan,bounds.start);
    const searchConfig={...config};
    // Saved league results can contain test-period information: never reuse them here.
    if(config.leagueOnly)searchConfig.leagueRecords=wfLeagueRecords(training,history);
    const download=fetchYear,post=self.postMessage;let report;
    try{
        fetchYear=async(symbol,interval)=>wfCut(history.get(wfKey(symbol,interval))||[],interval,bounds.cutoff).filter(c=>c.time>=bounds.start);
        self.postMessage=message=>{if(message.type==='progress')researchDeliver({...message,message:'Eğitim · '+message.message})};
        report=await optimize(training,searchConfig);
    }finally{fetchYear=download;self.postMessage=post}
    const chosen=report.recommendation||report.baseline;
    const plan=report.groups.map((group,i)=>({...group.options[chosen.selection[i]].settings}));
    const streams=researchStreams(source,history);
    researchDeliver({type:'progress',message:'Ayarlar donduruldu · Bağımsız test',detail:'Test sonuçları aday seçimine veya eşik düzeltmesine geri verilmez.'});
    const trainingReplay=researchReplay(source,[baselinePlan,plan],streams,bounds.start,bounds.cutoff);
    const forward=researchReplay(source,[baselinePlan,plan],streams,bounds.cutoff,bounds.end);
    const stress=[];
    const fee=source.referenceArgs.isFeeDeductionEnabled ? .00075 : 0;
    for(const scenario of [{id:'costs',label:'Komisyon %0,15/yön + fiyat kayması %0,10/yön',execution:{feeRate:Math.max(.00075,fee)*2,slippageBps:10}},
        {id:'delay',label:'1 mum gecikme + normal komisyon',execution:{delayBars:1}}]){
        researchDeliver({type:'progress',message:'Dayanıklılık · '+scenario.label,detail:'Dondurulmuş ayarlar ve aynı bağımsız test dönemi kullanılıyor.'});
        const replay=researchReplay(source,[baselinePlan,plan],streams,bounds.cutoff,bounds.end,scenario.execution);
        stress.push({id:scenario.id,label:scenario.label,execution:scenario.execution,baseline:replay.summaries[0],candidate:replay.summaries[1]});
    }
    const neighbors=researchNeighborPlans(plan),neighborRows=[];
    for(let i=0;i<neighbors.selected.length;i++){
        const neighbor=neighbors.selected[i];
        if(i%4===0)researchDeliver({type:'progress',message:'Yakın eşik kontrolü · '+(i+1)+'/'+neighbors.selected.length,detail:'AL veya SAT bir RSI puanı değiştirilir; bu sonuçlara göre yeni aday seçilmez.'});
        const r=researchReplay(source,[neighbor.plan],streams,bounds.cutoff,bounds.end).summaries[0];
        neighborRows.push({coinId:source.coins[neighbor.coinIndex].id,buyRsi:neighbor.buyRsi,sellRsi:neighbor.sellRsi,...r,
            passed:r.net>0&&r.maxDrawdown<=config.maxDrawdown&&r.trades>=config.minTestTrades&&!r.missingFills});
    }
    const validation={schema:'kuzgun-validation-v1',selectionCutoff:bounds.cutoff,testStart:bounds.cutoff,testEnd:bounds.end,
        training:{baseline:trainingReplay.summaries[0],candidate:trainingReplay.summaries[1]},
        forward:{baseline:forward.summaries[0],candidate:forward.summaries[1],months:forward.months},stress,
        neighbors:{available:neighbors.available,tested:neighborRows.length,passRate:neighborRows.length?neighborRows.filter(r=>r.passed).length/neighborRows.length*100:null,rows:neighborRows},
        config:{minTestTrades:config.minTestTrades,maxDrawdown:config.maxDrawdown,neighborPassRate:70},
        note:'Bugünkü coin havuzunun tarihsel testi. Araştırma seçimi test dönemini kullanmaz. Referans ayarların daha önce nasıl seçildiği bilinmez. Daha sonraki tekrar analizler aynı test dönemini gerçek anlamda görülmemiş kılmaz.'};
    Object.assign(validation,researchGate(validation,!!report.recommendation,config));
    const result={...report,validation,coverage,analysisRange:{...bounds,end:bounds.cutoff,endMonth:bounds.trainingEnd},
        comparisonMode:'training-with-independent-validation',terminalAsOf:source.asOf,referenceVerified:true,
        research:{bounds,scope:config.searchScope,intervals,selectionPlan:plan,baselinePlan,candidateSelectedBefore:bounds.cutoff,
            tested:report.tested,budget:report.budget,frozen:true,excludedActualRecords:true}};
    researchDeliver(result);return result;
}
self.onmessage=async({data})=>{try{await runResearch(data.snapshot,data.config)}catch(error){researchDeliver({type:'error',message:error.message||'Araştırma tamamlanamadı.'})}};
