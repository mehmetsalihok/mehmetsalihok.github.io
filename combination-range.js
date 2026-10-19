'use strict';
importScripts('combination-worker.js?v=27-budget');
const rangeDeliver=self.postMessage.bind(self);
function analysisMonth(value){
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(value||''))throw new Error('Geçerli bir başlangıç ve bitiş ayı seç.');
    const [year,month]=value.split('-').map(Number);
    if(year<2017||year>2100)throw new Error('Tarih 2017–2100 arasında olmalı.');
    return {year,month,start:Date.UTC(year,month-1,1,-3),end:Date.UTC(year,month,1,-3)};
}
function analysisBounds(source,config){
    const first=analysisMonth(config.rangeStart),last=analysisMonth(config.rangeEnd);
    if(first.start>last.start)throw new Error('Başlangıç ayı bitiş ayından sonra olamaz.');
    if(last.start>=source.asOf)throw new Error('Bitiş ayı referans tarihinden sonra olamaz.');
    if((last.year-first.year)*12+last.month-first.month>=60)throw new Error('Tek aramada en fazla 60 ay seçebilirsin.');
    return {start:first.start,end:Math.min(last.end,source.asOf),startMonth:config.rangeStart,endMonth:config.rangeEnd};
}
function rangeLeagueRecords(source,coin,records,bounds){
    const candidates=[];
    for(const row of records||[]){
        if(!row||!Number.isFinite(Number(row.year))||Number(row.endTime)<=bounds.start||Number(row.startTime)>=bounds.end)continue;
        if(!matchingLeagueRecords({...source,year:String(row.year),asOf:bounds.end},coin,[row]).length)continue;
        candidates.push({...row,sourceYear:row.year,sourceStartTime:row.startTime,sourceEndTime:row.endTime,
            year:source.year,startTime:bounds.start,endTime:bounds.end});
    }
    return candidates;
}
async function prepareRangeSnapshot(source,config){
    const bounds=analysisBounds(source,config),history=new Map(),coverage=[];
    SNAP={...source,historyStart:bounds.start,historyEnd:bounds.end};
    for(const coin of source.coins)for(const interval of [...new Set([coin.interval,'15m','30m'])]){
        progress(coin.symbol+' / '+interval,'Seçilen dönemin mumları hazırlanıyor.');
        const cached=coin.rawCandles||[],ms=TF[interval];
        const reusable=interval===coin.interval&&cached.length&&cached[0].time<=bounds.start&&cached.at(-1).time+ms>=bounds.end-ms;
        const data=reusable?cached:await fetchYear(coin.symbol,interval);
        const candles=data.filter(bar=>bar.time>=bounds.start&&bar.time+ms<=bounds.end).sort((a,b)=>a.time-b.time);
        if(candles.length<Math.max(9,coin.rsiLength+2))throw new Error(coin.symbol+' / '+interval+': seçilen dönemde yeterli mum yok.');
        const expected=Math.floor((bounds.end-bounds.start)/ms);
        coverage.push({symbol:coin.symbol,interval,first:candles[0].time,last:candles.at(-1).time+ms,missing:Math.max(0,expected-candles.length),candles:candles.length});
        history.set(coin.symbol+'|'+interval,candles);
    }
    const coins=source.coins.map(coin=>({...coin,rawCandles:history.get(coin.symbol+'|'+coin.interval),price:history.get(coin.symbol+'|'+coin.interval).at(-1).close}));
    const snapshot={schema:source.schema,year:source.year,asOf:bounds.end,trainingStart:bounds.start,coins,
        closedTrades:[],pendingClosedTrades:[],referenceArgs:{baseBalance:source.referenceArgs.baseBalance,maxSlots:source.referenceArgs.maxSlots,
            trades:[],activePositions:[],coins:coins.filter(coin=>coin.isActive!==false).map(coin=>({id:coin.id,symbol:coin.symbol,price:coin.price})),
            isSlotConstraintEnabled:source.referenceArgs.isSlotConstraintEnabled,isFeeDeductionEnabled:source.referenceArgs.isFeeDeductionEnabled,
            startDateTimestamp:bounds.start/1000,selectedYear:source.year}};
    const groups=referenceGroups(snapshot);
    snapshot.referenceArgs.trades=assembleTrades(groups,groups.map(()=>0));
    const baseline=PortfolioEngine.calculateCompoundedBalance(snapshot.referenceArgs);
    snapshot.expected={realizedBalance:baseline.realizedBalance,compoundedBalance:baseline.compoundedBalance,unrealizedPnlUSD:0};
    return {snapshot,history,coverage,bounds};
}
async function runRangeAnalysis(source,config){
    verifyReference(source);
    if(!Number.isInteger(config.minTrades)||config.minTrades<1||config.minTrades>1000||!['strict','balanced'].includes(config.monthlyMode))throw new Error('Arama koşulları geçersiz.');
    const prepared=await prepareRangeSnapshot(source,config),{snapshot,history,coverage,bounds}=prepared;
    const searchConfig={...config};
    if(config.leagueOnly){
        searchConfig.leagueRecords=source.coins.flatMap(coin=>rangeLeagueRecords(source,coin,config.leagueRecords,bounds));
        const missing=source.coins.filter(coin=>!matchingLeagueRecords(snapshot,coin,searchConfig.leagueRecords).length);
        if(missing.length)throw new Error('Seçilen dönem ve bitiş tarihiyle uyumlu lig kaydı yok: '+missing.map(coin=>coin.symbol).join(', ')+'. Döneme ait lig taramasını kaydet veya lig modunu kapat.');
    }
    fetchYear=async(symbol,interval)=>history.get(symbol+'|'+interval)||[];
    const originalPost=self.postMessage;
    try{
        self.postMessage=message=>{
            if(message.type==='reference')rangeDeliver({...message,type:'range-reference',bounds,coverage});
            else if(message.type==='result')rangeDeliver({...message,analysisRange:bounds,coverage,terminalAsOf:source.asOf,comparisonMode:'range-simulation'});
            else rangeDeliver(message);
        };
        return await optimize(snapshot,searchConfig);
    }finally{self.postMessage=originalPost}
}
self.onmessage=async({data})=>{try{await runRangeAnalysis(data.snapshot,data.config)}catch(error){rangeDeliver({type:'error',message:error.message||'Dönem analizi tamamlanamadı.'})}};
