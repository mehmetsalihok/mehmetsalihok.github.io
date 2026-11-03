"use strict";
importScripts("combination-worker.js?v=3-replay");
const wfDeliver=self.postMessage.bind(self);
const monthNames=["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
function getTurkeyDateComponents(timestamp){const iso=new Date(timestamp+10800000).toISOString();return {monthKey:iso.slice(0,7),day:Number(iso.slice(8,10))}}

function wfLeagueOptimize(candles,rsiLength,profitTarget,monthlyCap,interval,asOf) {
    return KuzgunStrategy.optimize(candles,{interval,rsiLength,profitTarget,monthlyCap},{asOf});
}

function wfMonthStart(year,index){return Date.UTC(year,index,1,-3)}
function wfParseMonth(value){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value||''))throw new Error('Geçerli bir ay seç.');
    const [year,month]=value.split('-').map(Number);
    if(year<2017||year>2100)throw new Error('Tarih 2017–2100 arasında olmalı.');
    return {year,index:month-1,time:wfMonthStart(year,month-1)};
}
function wfBounds(source,config){
    if(config.trainingStart){
        const first=wfParseMonth(config.trainingStart),test=wfParseMonth(config.testStart),last=wfParseMonth(config.testEnd);
        if(first.time>=test.time)throw new Error('Eğitim başlangıcı ilk test ayından önce olmalı.');
        if(test.time>last.time)throw new Error('Son test ayı ilk test ayından önce olamaz.');
        if(wfMonthStart(last.year,last.index+1)>source.asOf)throw new Error('Yalnızca referans tarihinde tamamlanmış test aylarını seçebilirsin.');
        if(!['expanding','rolling'].includes(config.trainingMode))throw new Error('Eğitim yöntemi geçersiz.');
        const window=Number(config.windowMonths);
        if(config.trainingMode==='rolling'&&(!Number.isInteger(window)||window<1||window>60))throw new Error('Geçmiş pencere 1–60 ay olmalı.');
        if(config.trainingMode==='rolling'&&wfMonthStart(test.year,test.index-window)<first.time)throw new Error('İlk test için pencereyi dolduracak kadar erken bir eğitim başlangıcı seç.');
        const folds=[];
        for(let month=test.index;wfMonthStart(test.year,month)<=last.time;month++){
            const start=wfMonthStart(test.year,month),end=wfMonthStart(test.year,month+1);
            if(folds.length>=36)throw new Error('Tek testte en fazla 36 test ayı seçebilirsin.');
            folds.push({monthKey:getTurkeyMonthKey(start),start,end,trainingStart:config.trainingMode==='rolling'?wfMonthStart(test.year,month-window):first.time,trainingEnd:start});
        }
        return folds;
    }
    const initial=Number(config.initialMonths),limit=Number(config.maxTests);
    if(!Number.isInteger(initial)||initial<1||initial>10||!Number.isInteger(limit)||limit<1||limit>12)throw new Error('Eğitim veya test ayı sayısı geçersiz');
    const year=Number(source.year),folds=[];
    for(let month=initial;month<12&&folds.length<limit;month++){
        const start=wfMonthStart(year,month),end=wfMonthStart(year,month+1);
        if(end>source.asOf)break;
        folds.push({monthKey:year+'-'+String(month+1).padStart(2,'0'),start,end,trainingStart:wfMonthStart(year,0),trainingEnd:start});
    }
    if(!folds.length)throw new Error('Bu başlangıç eğitiminin ardından tamamlanmış bir test ayı yok. Daha kısa başlangıç eğitimi seç.');
    return folds;
}
function wfCut(candles,interval,end){return candles.filter(candle=>candle.time+TF[interval]<=end)}
function wfKey(symbol,interval){return symbol+'|'+interval}
function wfMakeTraining(source,history,cutoff,seedSettings,start=wfMonthStart(Number(source.year),0)){
    const coins=source.coins.map((coin,index)=>{
        const seed=seedSettings[index],interval=seed.off?'15m':seed.interval;
        const rawCandles=wfCut(history.get(wfKey(coin.symbol,interval))||[],interval,cutoff).filter(bar=>bar.time>=start);
        const price=rawCandles.at(-1)?.close||1;
        return {id:coin.id,symbol:coin.symbol,displaySymbol:coin.displaySymbol,profitTarget:coin.profitTarget,monthlyCap:coin.monthlyCap,
            interval,rsiLength:seed.off?6:seed.rsiLength,buyRsi:seed.off?25:seed.buyRsi,sellRsi:seed.off?75:seed.sellRsi,
            isActive:!seed.off,rawCandles,price};
    });
    const training={schema:'kuzgun-combination-v2',engineVersion:KuzgunReplay.version,trainingStart:start,asOf:cutoff,year:source.year,coins,closedTrades:[],pendingClosedTrades:[],
        referenceArgs:{baseBalance:source.referenceArgs.baseBalance,maxSlots:source.referenceArgs.maxSlots,trades:[],activePositions:[],
            coins:coins.filter(coin=>coin.isActive!==false).map(coin=>({id:coin.id,symbol:coin.symbol,price:coin.price})),
            isSlotConstraintEnabled:true,isFeeDeductionEnabled:source.referenceArgs.isFeeDeductionEnabled,
            startDateTimestamp:start/1000,selectedYear:source.year}};
    const groups=referenceGroups(training),trades=assembleTrades(groups,groups.map(()=>0));
    training.referenceArgs.trades=trades;
    const engine=PortfolioEngine.calculateCompoundedBalance({...training.referenceArgs,coins:training.coins,asOf:training.asOf,keepCurve:false});
    training.expected={realizedBalance:engine.realizedBalance,compoundedBalance:engine.compoundedBalance,unrealizedPnlUSD:engine.unrealizedPnlUSD};
    return training;
}
function wfLeagueRecords(training,history){
    const records=[];
    for(const coin of training.coins)for(const interval of ['15m','30m'])for(const rsiLength of [6,7]){
        const candles=wfCut(history.get(wfKey(coin.symbol,interval))||[],interval,training.asOf).filter(bar=>bar.time>=training.trainingStart);
        const strategy=wfLeagueOptimize(candles,rsiLength,coin.profitTarget,coin.monthlyCap,interval,training.asOf);
        records.push({symbol:coin.symbol,year:training.year,startTime:training.trainingStart,endTime:training.asOf,
            profitTarget:coin.profitTarget,monthlyCap:coin.monthlyCap,interval,rsiLength,buyRsi:strategy.buyRsi,sellRsi:strategy.sellRsi});
    }
    return records;
}
function wfAccount(base){return KuzgunReplay.account(base)}
function wfEquity(account){return KuzgunReplay.equity(account)}
function wfReplayMonth(accounts,settingsByAccount,streams,coins,fold,slots,fees,execution={}) {
    return accounts.map((state,index)=>{
        const selected=coins.map((c,i)=>({...c,...settingsByAccount[index][i],isActive:!settingsByAccount[index][i].off}));
        const before=KuzgunReplay.summarize(state),opening=before.compoundedBalance,carriedIn=before.openPositions.length;
        const active=new Set(selected.filter(c=>c.isActive).map(c=>c.id+'|'+c.interval));
        for(const p of state.positions.values())active.add(p.coinId+'|'+p.settings.interval);
        const result=KuzgunReplay.run({state,coins:selected,streams:streams.filter(s=>active.has(s.coinId+'|'+s.interval)),
            baseBalance:state.base,startTime:fold.start,endTime:fold.end,maxSlots:slots,isFeeDeductionEnabled:fees,...execution});
        const m=result.months[fold.monthKey]||{};
        return {...m,carriedIn,openingEquity:opening,endEquity:result.compoundedBalance,net:result.compoundedBalance-opening,
            realizedBalance:result.realizedBalance,openPositions:result.openPositions.length,cash:result.cash,
            trades:result.trades-before.trades,wins:result.wins-before.wins,losses:result.losses-before.losses,
            fees:result.totalFeesUSD-before.totalFeesUSD,skipped:result.skipped-before.skipped,missingFills:0,
            maxDrawdown:result.maxDrawdown,winRate:result.trades>before.trades?100*(result.wins-before.wins)/(result.trades-before.trades):0};
    });
}
function wfSummary(account){const r=KuzgunReplay.summarize(account);return {base:r.base,equity:r.compoundedBalance,
    net:r.compoundedBalance-r.base,realized:r.realizedBalance,unrealized:r.unrealizedPnlUSD,cash:r.cash,
    openPositions:r.openPositions.length,trades:r.trades,wins:r.wins,losses:r.losses,winRate:r.winRate,
    fees:r.totalFeesUSD,skipped:r.skipped,missingFills:0,maxDrawdown:r.maxDrawdown};}
async function runWalkForward(source,config){
    if(!source?.coins?.length)throw new Error('Terminal referansı gerekli');
    if(!Number.isInteger(config.minTrades)||config.minTrades<1||config.minTrades>1000||!['strict','balanced'].includes(config.monthlyMode))throw new Error('Test arama koşulları geçersiz');
    verifyReference(source);
    const folds=wfBounds(source,config),history=new Map();
    const historyStart=Math.min(...folds.map(fold=>fold.trainingStart)),historyEnd=folds.at(-1).end;
    SNAP={...source,historyStart,historyEnd};
    wfDeliver({type:'wf-progress',message:'Seçilen tarihlerin verileri hazırlanıyor',detail:'Önceki yıllar dahil indirilir; her eğitimde yalnızca kendi geçmiş penceresi kullanılır.'});
    const realFetch=fetchYear,coverage=[];
    for(const coin of source.coins)for(const interval of [...new Set([coin.interval,'15m','30m'])]){
        const cached=coin.rawCandles||[],reuse=interval===coin.interval&&cached.length&&cached[0].time<=historyStart&&cached.at(-1).time+TF[interval]>=historyEnd;
        const data=reuse?cached:await realFetch(coin.symbol,interval);
        const candles=data.filter(bar=>bar.time>=historyStart&&bar.time+TF[interval]<=historyEnd).sort((a,b)=>a.time-b.time);
        if(!candles.length)throw new Error(coin.symbol+' / '+interval+': seçilen tarihlerde veri bulunamadı.');
        for(const fold of folds){
            const count=candles.filter(bar=>bar.time>=fold.trainingStart&&bar.time+TF[interval]<=fold.trainingEnd).length;
            if(count<Math.max(9,coin.rsiLength+2))throw new Error(coin.symbol+' / '+interval+' / '+fold.monthKey+': eğitim verisi yetersiz. Daha geç bir ilk test ayı seç.');
            if(!candles.some(bar=>bar.time>=fold.start&&bar.time+TF[interval]<=fold.end))throw new Error(coin.symbol+' / '+interval+' / '+fold.monthKey+': test ayı verisi yok.');
        }
        const expected=Math.round((historyEnd-historyStart)/TF[interval]);
        coverage.push({symbol:coin.symbol,interval,first:candles[0].time,last:candles.at(-1).time+TF[interval],candles:candles.length,missing:Math.max(0,expected-candles.length)});
        history.set(wfKey(coin.symbol,interval),candles);
    }
    const streams=[];
    for(const coin of source.coins)for(const interval of [...new Set([coin.interval,'15m','30m'])]){
        const candles=history.get(wfKey(coin.symbol,interval)),features={};
        for(const length of [...new Set([6,7,coin.rsiLength])])features[length]=calculateRSIHistory(candles.map(bar=>bar.close),length);
        streams.push({coinId:coin.id,interval,ms:TF[interval],candles,features});
    }
    fetchYear=async(symbol,interval)=>wfCut(history.get(wfKey(symbol,interval))||[],interval,SNAP.asOf).filter(bar=>bar.time>=SNAP.trainingStart);
    const base=source.referenceArgs.baseBalance,slots=source.referenceArgs.maxSlots;
    if(!Number.isInteger(slots)||slots<1)throw new Error('Slot sayısı geçersiz');
    const adaptive=wfAccount(base),fixed=wfAccount(base);
    const benchmark=source.coins.map(coin=>coin.isActive===false?{off:true}:{interval:coin.interval,rsiLength:coin.rsiLength,buyRsi:coin.buyRsi,sellRsi:coin.sellRsi});
    let seeds=source.coins.map(()=>({interval:'15m',rsiLength:6,buyRsi:25,sellRsi:75}));
    const output=[];
    for(let index=0;index<folds.length;index++){
        const fold=folds[index],training=wfMakeTraining(source,history,fold.trainingEnd,seeds,fold.trainingStart);
        wfDeliver({type:'wf-progress',message:`${index+1}/${folds.length} · ${fold.monthKey} için eğitim`,detail:'Veri kesimi: '+new Date(fold.trainingEnd).toISOString()+' · Sonraki ay seçime katılmaz.'});
        const trainingConfig={minTrades:config.minTrades,monthlyMode:config.monthlyMode,budget:config.budget,allowDisable:!!config.allowDisable,leagueOnly:!!config.leagueOnly};
        if(config.leagueOnly){
            wfDeliver({type:'wf-progress',message:fold.monthKey+' · Lig adayları geçmiş verilerle yeniden üretiliyor',detail:'Kaydedilmiş tüm yıl lig sonuçları kullanılmaz.'});
            trainingConfig.leagueRecords=wfLeagueRecords(training,history);
        }
        const originalPost=self.postMessage;
        let trainingResult;
        try{
            self.postMessage=message=>{if(message.type==='progress')wfDeliver({type:'wf-progress',message:fold.monthKey+' · '+message.message,detail:message.detail})};
            trainingResult=await optimize(training,trainingConfig);
        }finally{self.postMessage=originalPost}
        const selected=trainingResult.recommendation||trainingResult.baseline;
        seeds=trainingResult.groups.map((group,i)=>({...group.options[selected.selection[i]].settings}));
        const plan=seeds.map((setting,i)=>({coinId:source.coins[i].id,symbol:source.coins[i].symbol,...setting}));
        wfDeliver({type:'wf-progress',message:fold.monthKey+' · Ayarlar sabitlendi, test ayı yürütülüyor',detail:'Test sonucu kötü olsa da bu ayın ayarları yeniden seçilmez.'});
        const rows=wfReplayMonth([fixed,adaptive],[benchmark,seeds],streams,source.coins,fold,slots,source.referenceArgs.isFeeDeductionEnabled);
        const row={...fold,settingsSelectedAt:fold.trainingEnd,trainingTrials:trainingResult.tested,trainingImproved:!!trainingResult.recommendation,plan,fixed:rows[0],adaptive:rows[1]};
        output.push(row);
        wfDeliver({type:'wf-fold',row,completed:index+1,total:folds.length});
    }
    const result={type:'wf-result',schema:'kuzgun-walkforward-v1',asOf:source.asOf,year:source.year,config,coverage,base,slots,fees:source.referenceArgs.isFeeDeductionEnabled,
        pool:source.coins.map(coin=>({id:coin.id,symbol:coin.symbol,profitTarget:coin.profitTarget,monthlyCap:coin.monthlyCap})),
        folds:output,benchmark:benchmark,fixed:wfSummary(fixed),adaptive:wfSummary(adaptive),
        closed:{fixed:fixed.closed,adaptive:adaptive.closed},label:'Bugünkü coin havuzunun tarihsel ileri dönem testi'};
    wfDeliver(result);return result;
}
self.onmessage=async({data})=>{try{await runWalkForward(data.snapshot,data.config)}catch(error){wfDeliver({type:'wf-error',message:error.message||'İleri dönem testi tamamlanamadı'})}};
