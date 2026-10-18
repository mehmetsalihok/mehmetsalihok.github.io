"use strict";
importScripts("combination-worker.js?v=24-shared-strategy");
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
    const training={schema:'kuzgun-combination-v2',trainingStart:start,asOf:cutoff,year:source.year,coins,closedTrades:[],pendingClosedTrades:[],
        referenceArgs:{baseBalance:source.referenceArgs.baseBalance,maxSlots:source.referenceArgs.maxSlots,trades:[],activePositions:[],
            coins:coins.filter(coin=>coin.isActive!==false).map(coin=>({id:coin.id,symbol:coin.symbol,price:coin.price})),
            isSlotConstraintEnabled:true,isFeeDeductionEnabled:source.referenceArgs.isFeeDeductionEnabled,
            startDateTimestamp:start/1000,selectedYear:source.year}};
    const groups=referenceGroups(training),trades=assembleTrades(groups,groups.map(()=>0));
    training.referenceArgs.trades=trades;
    const engine=PortfolioEngine.calculateCompoundedBalance(training.referenceArgs);
    training.expected={realizedBalance:engine.realizedBalance,compoundedBalance:engine.compoundedBalance,unrealizedPnlUSD:0};
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
function wfAccount(base){return {base,cash:base,realized:base,fees:0,positions:new Map(),marks:{},monthlyPnl:{},closed:[],wins:0,losses:0,skipped:0,missingFills:0,peak:base,maxDrawdown:0}}
function wfEquity(account){let total=account.cash;for(const position of account.positions.values())total+=position.units*(account.marks[position.coinId]||position.entryPrice);return total}
function wfLowerBound(candles,ms,time){let low=0,high=candles.length;while(low<high){const middle=(low+high)>>1;if(candles[middle].time+ms<time)low=middle+1;else high=middle}return low}
function wfHeapPush(heap,event){heap.push(event);let index=heap.length-1;while(index>0){const parent=(index-1)>>1;if(heap[parent].time<=event.time)break;heap[index]=heap[parent];index=parent}heap[index]=event}
function wfHeapPop(heap){const first=heap[0],last=heap.pop();if(heap.length){let index=0;while(index*2+1<heap.length){let child=index*2+1;if(child+1<heap.length&&heap[child+1].time<heap[child].time)child++;if(heap[child].time>=last.time)break;heap[index]=heap[child];index=child}heap[index]=last}return first}
function wfMonthRow(account,key){return {monthKey:key,openingEquity:wfEquity(account),carriedIn:account.positions.size,entries:0,trades:0,wins:0,losses:0,fees:0,realizedNet:0,skipped:0,lockedSignals:0,missingFills:0,peak:wfEquity(account),maxDrawdown:0}}
function wfRisk(account,row){const equity=wfEquity(account);account.peak=Math.max(account.peak,equity);row.peak=Math.max(row.peak,equity);if(account.peak>0)account.maxDrawdown=Math.max(account.maxDrawdown,(account.peak-equity)/account.peak*100);if(row.peak>0)row.maxDrawdown=Math.max(row.maxDrawdown,(row.peak-equity)/row.peak*100)}
function wfExit(account,row,position,price,time,reason,rate){
    const gross=position.units*price,fee=gross*rate,proceeds=gross-fee,net=proceeds-position.budget;
    const rawPnl=(price-position.entryPrice)/position.entryPrice*100;
    account.cash+=proceeds;account.realized+=net;account.fees+=fee;row.fees+=fee;row.realizedNet+=net;row.trades++;
    if(rawPnl>=0){account.wins++;row.wins++}else{account.losses++;row.losses++}
    const month=getTurkeyMonthKey(time),ledger=account.monthlyPnl[month]||(account.monthlyPnl[month]={});
    ledger[position.coinId]=(ledger[position.coinId]||0)+rawPnl;
    account.closed.push({coinId:position.coinId,symbol:position.symbol,entryTime:position.entryTime,exitTime:time,entryPrice:position.entryPrice,
        exitPrice:price,net,rawPnl,reason,settings:position.settings});
    account.positions.delete(position.coinId);
}
function wfReplayMonth(accounts,settingsByAccount,streams,coins,fold,slots,fees){
    const rows=accounts.map(account=>wfMonthRow(account,fold.monthKey));
    const heap=[];
    for(let stream=0;stream<streams.length;stream++){
        const series=streams[stream],index=wfLowerBound(series.candles,series.ms,fold.start);
        if(index<series.candles.length)wfHeapPush(heap,{stream,index,time:series.candles[index].time+series.ms});
    }
    const rate=fees ? 0.00075 : 0;
    while(heap.length&&heap[0].time<fold.end){
        const time=heap[0].time,bucket=[];
        while(heap.length&&heap[0].time===time){
            const event=wfHeapPop(heap),series=streams[event.stream],bar=series.candles[event.index];
            const next=series.candles[event.index+1],executionPrice=next&&next.time===time?next.open:null;
            bucket.push({...event,series,bar,executionPrice});
            if(event.index+1<series.candles.length)wfHeapPush(heap,{stream:event.stream,index:event.index+1,time:next.time+series.ms});
        }
        for(const account of accounts)for(const event of bucket)account.marks[event.series.coinId]=event.executionPrice||event.bar.close;
        // Old positions exit under their original timeframe and thresholds, including across month boundaries.
        for(let a=0;a<accounts.length;a++){
            const account=accounts[a],row=rows[a];
            for(const event of bucket){
                const position=account.positions.get(event.series.coinId);
                if(!position||position.settings.interval!==event.series.interval||event.bar.time<position.entryTime)continue;
                const rsi=event.series.features[position.settings.rsiLength][event.index];
                if(event.bar.high>=position.targetPrice)wfExit(account,row,position,position.targetPrice,time,'Kâr hedefi',rate);
                else if(rsi!==null&&rsi>=position.settings.sellRsi){
                    if(event.executionPrice)wfExit(account,row,position,event.executionPrice,time,'RSI satışı · sonraki açılış',rate);
                    else{account.missingFills++;row.missingFills++}
                }
            }
            // New entries use fixed terminal coin order for simultaneous signals.
            for(let i=0;i<coins.length;i++){
                const coin=coins[i],setting=settingsByAccount[a][i];
                if(setting.off||account.positions.has(coin.id))continue;
                const event=bucket.find(item=>item.series.coinId===coin.id&&item.series.interval===setting.interval);
                if(!event||event.index<1)continue;
                const values=event.series.features[setting.rsiLength],current=values[event.index],previous=values[event.index-1];
                if(current===null||previous===null||!(previous<=setting.buyRsi&&current>setting.buyRsi))continue;
                const total=account.monthlyPnl[fold.monthKey]?.[coin.id]||0;
                if(coin.monthlyCap>0&&total+.001>=coin.monthlyCap){row.lockedSignals++;continue}
                if(account.positions.size>=slots){account.skipped++;row.skipped++;continue}
                if(!event.executionPrice){account.missingFills++;row.missingFills++;continue}
                const budget=account.cash/(slots-account.positions.size);
                if(!(budget>0))continue;
                const fee=budget*rate;
                account.cash=Math.max(0,account.cash-budget);account.fees+=fee;row.fees+=fee;row.entries++;
                account.positions.set(coin.id,{coinId:coin.id,symbol:coin.symbol,entryTime:time,entryPrice:event.executionPrice,budget,
                    units:(budget-fee)/event.executionPrice,targetPrice:event.executionPrice*(1+coin.profitTarget/100),settings:{...setting}});
            }
            wfRisk(account,row);
        }
    }
    // Mark each coin with its newest available close, preferring finer bars on ties.
    const closingMarks={};
    for(const series of streams){
        const next=wfLowerBound(series.candles,series.ms,fold.end+1),bar=series.candles[next-1];
        if(!bar||bar.time+series.ms>fold.end)continue;
        const time=bar.time+series.ms,old=closingMarks[series.coinId];
        if(!old||time>old.time||(time===old.time&&series.ms<old.ms))closingMarks[series.coinId]={time,ms:series.ms,price:bar.close};
    }
    for(const account of accounts)for(const [id,mark] of Object.entries(closingMarks))account.marks[id]=mark.price;
    for(let a=0;a<accounts.length;a++){
        const account=accounts[a],row=rows[a];wfRisk(account,row);
        row.endEquity=wfEquity(account);row.net=row.endEquity-row.openingEquity;row.realizedBalance=account.realized;
        row.openPositions=account.positions.size;row.cash=account.cash;row.winRate=row.trades?row.wins/row.trades*100:0;
        delete row.peak;
    }
    return rows;
}
function wfSummary(account){const equity=wfEquity(account);return {base:account.base,equity,net:equity-account.base,realized:account.realized,
    unrealized:equity-account.realized,cash:account.cash,openPositions:account.positions.size,trades:account.wins+account.losses,
    wins:account.wins,losses:account.losses,winRate:account.wins+account.losses?account.wins/(account.wins+account.losses)*100:0,
    fees:account.fees,skipped:account.skipped,missingFills:account.missingFills,maxDrawdown:account.maxDrawdown}}
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
