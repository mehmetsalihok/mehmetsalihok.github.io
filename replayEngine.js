/* KUZGUN replay v3. Closed-bar decisions; OHLC target fills at bar end are estimates.
 * Cash is reserved at entry, open positions occupy slots, FIFO pending signals carry
 * across months. A resumed run and a single run consume the same ordered events.
 * This is a model, never a record of an exchange order or a Telegram delivery.
 */
(function(root) {
'use strict';
const version = 'replay-v3';
const key = t => new Date(Number(t)+10800000).toISOString().slice(0,7);
const msOf = tf => KuzgunStrategy.intervalMs(tf);
function account(base) {
    return {version,base,cash:base,positions:new Map(),pending:new Map(),marks:{},markTimes:{},
        monthlyPnl:{},months:{},closed:[],pendingClosed:[],entries:[],fees:0,closedNet:0,
        skipped:0,lockedSignals:0,lastTime:-Infinity,peak:base,maxDrawdown:0,curve:[]};
}
function equity(s) {let value=s.cash; for(const p of s.positions.values())value+=p.units*(s.marks[p.coinId]??p.entryPrice);return value;}
function row(s,k) {
    return s.months[k]||(s.months[k]={openingEquity:equity(s),closingEquity:equity(s),net:0,realizedNet:0,
        fees:0,gross:0,netPercent:0,trades:0,wins:0,entries:0,skipped:0});
}
function risk(s) {const value=equity(s);s.peak=Math.max(s.peak,value);if(s.peak>0)s.maxDrawdown=Math.max(s.maxDrawdown,(s.peak-value)/s.peak*100);}
function locked(s,c,t) {return Number(c.monthlyCap)>0&&(s.monthlyPnl[key(t)]?.[c.id]||0)+.001>=Number(c.monthlyCap);}
function signal(previous,current,settings) {return KuzgunStrategy.entrySignal(previous,current,settings);}
function exit(position,bar,rsi) {
    const fill=KuzgunStrategy.exitSignal(position,bar,rsi,{...position.settings,profitTarget:position.profitTarget});
    return fill?{...fill,reason:fill.target?'Kâr hedefi · mum içi tahmin':'RSI satışı · mum kapanışı'}:null;
}
function enter(s,c,price,time,origin,slots,rate) {
    const free=slots-s.positions.size,budget=s.cash/Math.max(1,free);
    if(!(price>0)||!(budget>0)||free<=0)return;
    const buyFee=budget*rate,units=(budget-buyFee)/price;
    const p={id:`replay_open_${c.id}_${time}`,coinId:c.id,symbol:c.symbol,displaySymbol:c.displaySymbol,
        entryTime:time,entryPrice:price,allocatedUsd:budget,budget,units,buyFee,
        profitTarget:Number(c.profitTarget),targetPrice:price*(1+Number(c.profitTarget)/100),
        originSignalTime:origin,originSignalId:`${c.id}_${origin}`,settings:{...c,rawCandles:undefined,features:undefined},estimated:true};
    s.cash-=budget;s.fees+=buyFee;s.positions.set(c.id,p);s.pending.delete(c.id);
    const m=row(s,key(time));m.entries++;m.fees+=buyFee;s.entries.push({...p});
}
function close(s,p,price,time,reason,rate) {
    const gross=p.units*price,sellFee=gross*rate,net=gross-sellFee-p.budget,pnl=(price/p.entryPrice-1)*100;
    s.cash+=gross-sellFee;s.closedNet+=net;s.fees+=sellFee;s.positions.delete(p.coinId);
    const k=key(time),ledger=s.monthlyPnl[k]||(s.monthlyPnl[k]={});ledger[p.coinId]=(ledger[p.coinId]||0)+pnl;
    const m=row(s,k);m.trades++;m.wins+=Number(pnl>=0);m.realizedNet+=net;m.fees+=sellFee;m.gross+=pnl;m.netPercent+=net/p.budget*100;
    s.closed.push({...p,id:`replay_${p.coinId}_${p.entryTime}_${time}`,exitTime:time,exitPrice:price,
        pnl,pnlPercent:pnl,effectivePnl:net/p.budget*100,positionSizeUSD:p.budget,netGainUSD:net,
        feeUSD:p.buyFee+sellFee,monthKey:k,reason,isReal:false,isWin:pnl>=0,
        duration:Math.floor((time-p.entryTime)/60000)+'dk'});
}
function push(heap,event) {let i=heap.length;heap.push(event);while(i>0){const p=(i-1)>>1;if(heap[p].time<=event.time)break;heap[i]=heap[p];i=p;}heap[i]=event;}
function pop(heap) {const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].time<heap[c].time)c++;if(heap[c].time>=last.time)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;}
function lower(bars,ms,t) {let lo=0,hi=bars.length;while(lo<hi){const m=(lo+hi)>>>1;if(bars[m].time+ms<t)lo=m+1;else hi=m;}return lo;}
function stream(c,candles,features) {
    const ms=msOf(c.interval),bars=candles||c.rawCandles||[];
    return {coinId:c.id,interval:c.interval,ms,candles:bars,
        features:features||{[c.rsiLength]:KuzgunStrategy.rsiHistory(bars.map(b=>b.close),Number(c.rsiLength))}};
}
function run(options) {
    const coins=options.coins||[],base=Number(options.baseBalance??1000);
    if(!(base>0))throw new Error('Başlangıç bütçesi pozitif olmalı.');
    const s=options.state||account(base);
    if(s.version!==version)throw new Error('Eski hesaplama durumu; yeni referans oluştur.');
    const start=Number(options.startTime??-Infinity),end=Number(options.endTime??((options.asOf??Date.now())+1));
    const slots=options.isSlotConstraintEnabled===false?Math.max(1,coins.length):Math.max(1,Number(options.maxSlots)||1);
    const rate=Number(options.feeRate??(options.isFeeDeductionEnabled===false?0:.00075));
    const slip=Math.max(0,Number(options.slippageBps)||0)/10000,delay=Math.max(0,Number(options.delayBars)||0);
    const streams=options.streams||coins.filter(c=>c.isActive!==false&&!c.off).map(c=>stream(c,KuzgunStrategy.prepare(c.rawCandles||[],c.interval,end-1)));
    if(options.keepCurve&&!s.curve.length)s.curve.push({time:Number.isFinite(start)?start-1:0,equity:s.base,fees:0});
    const heap=[],order=new Map(coins.map((c,i)=>[c.id,i]));
    for(let i=0;i<streams.length;i++){
        const series=streams[i],index=lower(series.candles,series.ms,Math.max(start,s.lastTime+1));
        if(index<series.candles.length)push(heap,{stream:i,index,time:series.candles[index].time+series.ms});
    }
    while(heap.length&&heap[0].time<end){
        const time=heap[0].time,bucket=[];
        while(heap.length&&heap[0].time===time){
            const e=pop(heap),series=streams[e.stream],bar=series.candles[e.index];
            bucket.push({...e,series,bar});
            if(e.index+1<series.candles.length)push(heap,{stream:e.stream,index:e.index+1,time:series.candles[e.index+1].time+series.ms});
        }
        const k=key(time);row(s,k);
        bucket.sort((a,b)=>(order.get(a.series.coinId)??0)-(order.get(b.series.coinId)??0)||b.series.ms-a.series.ms);
        for(const e of bucket){
            if(!Number.isFinite(e.bar.close)||!(e.bar.close>0))throw new Error('Geçersiz mum fiyatı.');
            s.marks[e.series.coinId]=e.bar.close;s.markTimes[e.series.coinId]=time;
        }
        const closedNow=new Set();
        for(const e of bucket){
            const p=s.positions.get(e.series.coinId);
            if(p&&p.settings.interval===e.series.interval){
                const rsi=e.series.features[p.settings.rsiLength]?.[e.index];
                let fill=exit(p,e.bar,rsi);
                if(p.exitDue&&time>=p.exitDue)fill={price:e.bar.close,reason:'RSI satışı · gecikmeli',target:false};
                else if(fill&&!fill.target&&delay){p.exitDue=p.exitDue||time+delay*e.series.ms;fill=null;}
                if(fill){close(s,p,fill.price*(1-slip),time,fill.reason,rate);closedNow.add(p.coinId);}
            }
            const pending=s.pending.get(e.series.coinId);
            if(pending&&pending.coin.interval===e.series.interval&&e.bar.time>=pending.time&&e.bar.high>=pending.target){
                s.pendingClosed.push({id:`replay_pending_${pending.coin.id}_${pending.time}_${time}`,
                    coinId:pending.coin.id,symbol:pending.coin.symbol,entryTime:pending.time,exitTime:time,
                    entryPrice:pending.price,exitPrice:pending.target,pnlPercent:pending.coin.profitTarget,
                    reason:'Geçmiş bekleme · Kâr hedefi',source:'pending-simulation',estimated:true});
                s.pending.delete(pending.coin.id);
            }
        }
        // Signals are collected before promotions; FIFO then fixed coin order resolve ties.
        for(const c of coins){
            if(c.isActive===false||c.off||s.positions.has(c.id)||s.pending.has(c.id)||closedNow.has(c.id))continue;
            const e=bucket.find(b=>b.series.coinId===c.id&&b.series.interval===c.interval);
            if(!e||e.index<Number(c.rsiLength)+1)continue;
            const values=e.series.features[c.rsiLength];
            if(!values||!signal(values[e.index-1],values[e.index],c))continue;
            if(locked(s,c,time)){s.lockedSignals++;continue;}
            s.pending.set(c.id,{coin:{...c,rawCandles:undefined},time,notBefore:time+delay*e.series.ms,price:e.bar.close,target:e.bar.close*(1+c.profitTarget/100)});
            if(s.positions.size>=slots){s.skipped++;row(s,k).skipped++;}
        }
        const queue=[...s.pending.values()].sort((a,b)=>a.time-b.time||(order.get(a.coin.id)??0)-(order.get(b.coin.id)??0));
        for(const pending of queue){
            const c=coins.find(c=>c.id===pending.coin.id);
            if(!c||c.isActive===false||c.off||locked(s,c,time)){s.pending.delete(pending.coin.id);continue;}
            if(s.positions.size>=slots)break;
            // A missing/stale close never supplies a synthetic fill.
            if(s.markTimes[c.id]!==time||time<(pending.notBefore||pending.time))continue;
            enter(s,c,s.marks[c.id]*(1+slip),time,pending.time,slots,rate);
        }
        s.lastTime=time;risk(s);
        const m=row(s,k);m.closingEquity=equity(s);m.net=m.closingEquity-m.openingEquity;
        if(options.keepCurve)s.curve.push({time,equity:equity(s),fees:s.fees});
    }
    return summarize(s,options.markPrices);
}
function summarize(s,markPrices) {
    const positions=[...s.positions.values()].map(p=>{
        const mark=Number(markPrices?.[p.coinId])>0?Number(markPrices[p.coinId]):(s.marks[p.coinId]??p.entryPrice);
        return {...p,currentPrice:mark,livePnlPercent:(mark/p.entryPrice-1)*100,livePnlUsd:p.units*mark-p.budget};
    });
    const unrealized=positions.reduce((v,p)=>v+p.livePnlUsd,0),realized=s.base+s.closedNet;
    const stats={};for(const t of s.closed){const v=stats[t.coinId]||(stats[t.coinId]={totalTrades:0,totalPnl:0,monthly:{}});v.totalTrades++;v.totalPnl+=t.pnlPercent;const m=v.monthly[t.monthKey]||(v.monthly[t.monthKey]={trades:0,pnl:0});m.trades++;m.pnl+=t.pnlPercent;}
    const wins=s.closed.filter(t=>t.pnlPercent>=0).length;
    return {engineVersion:version,state:s,base:s.base,compoundedBalance:realized+unrealized,realizedBalance:realized,
        unrealizedPnlUSD:unrealized,totalFeesUSD:s.fees,cash:s.cash,executedTrades:[...s.closed].reverse(),
        acceptedTradeIds:new Set(s.closed.map(t=>t.id)),coinRealStats:stats,openPositions:positions,
        pendingSignals:[...s.pending.values()],pendingClosedTrades:[...s.pendingClosed].reverse(),
        entries:s.entries,months:s.months,equityCurve:s.curve,skipped:s.skipped,lockedSignals:s.lockedSignals,
        maxDrawdown:s.maxDrawdown,trades:s.closed.length,wins,losses:s.closed.length-wins,
        winRate:s.closed.length?wins/s.closed.length*100:0};
}
root.KuzgunReplay={version,account,equity,signal,exit,stream,run,summarize};
})(globalThis);
