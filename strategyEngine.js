/* KUZGUN — shared closed-candle strategy simulation, v1.
 * Entry: RSI upward crossing at close. Exit: target touched on a later bar,
 * otherwise RSI at close. Target fills are idealized; fees are not included.
 * Target exit timestamps use the bar close: OHLC cannot reveal the touch time.
 */
function createKuzgunStrategy() {
    'use strict';
    const names = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    const monthKey = time => new Date(Number(time) + 10800000).toISOString().slice(0, 7);
    const day = time => new Date(Number(time) + 10800000).getUTCDate();
    function intervalMs(interval) {
        const match = /^(\d+)([mhdw])$/.exec(interval);
        if (!match) throw new Error('Desteklenmeyen zaman dilimi: ' + interval);
        return Number(match[1]) * {m:60000,h:3600000,d:86400000,w:604800000}[match[2]];
    }
    function rsiHistory(prices, period) {
        const values = new Array(prices.length).fill(null);
        if (prices.length <= period) return values;
        let gain=0, loss=0;
        for (let i=1;i<=period;i++) {const d=prices[i]-prices[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);}
        gain/=period;loss/=period;
        values[period]=loss===0?100:100-100/(1+gain/loss);
        for (let i=period+1;i<prices.length;i++) {
            const d=prices[i]-prices[i-1];
            gain=(gain*(period-1)+Math.max(0,d))/period;
            loss=(loss*(period-1)+Math.max(0,-d))/period;
            values[i]=loss===0?100:100-100/(1+gain/loss);
        }
        return values;
    }
    function prepare(candles, interval, asOf=Date.now()) {
        const ms=intervalMs(interval), unique=new Map();
        for (const c of candles || []) {
            if (Number.isFinite(c.time) && c.time+ms<=asOf && Number(c.close)>0 && Number(c.high)>0) unique.set(c.time,c);
        }
        return [...unique.values()].sort((a,b)=>a.time-b.time);
    }
    function simulate(candles, settings, options={}) {
        const ms=intervalMs(settings.interval);
        const bars=options.prepared?candles:prepare(candles,settings.interval,options.asOf ?? Date.now());
        const period=Number(settings.rsiLength), buy=Number(settings.buyRsi), sell=Number(settings.sellRsi);
        const targetPct=Number(settings.profitTarget), cap=Number(settings.monthlyCap);
        const rsi=options.rsiValues || rsiHistory(bars.map(c=>c.close),period);
        const months=new Map(), trades=[];
        const month=key=>{if(!months.has(key))months.set(key,{monthKey:key,name:names[Number(key.slice(5))-1],trades:0,pnl:0,isLocked:false,tradesList:[]});return months.get(key);};
        let position=null,totalTrades=0,winCount=0,netPnl=0,totalHoldMs=0;
        for (let i=period+1;i<bars.length;i++) {
            const c=bars[i],time=c.time+ms,key=monthKey(time),current=rsi[i],previous=rsi[i-1];
            if (current==null || previous==null) continue;
            if (!position) {
                const result=month(key);
                if (cap>0 && result.pnl+0.001>=cap) continue;
                if (previous<=buy && current>buy) position={entryPrice:Number(c.close),entryTime:time};
            } else {
                const target=position.entryPrice*(1+targetPct/100);
                const hit=targetPct>0 && c.high>=target;
                if (!hit && current<sell) continue;
                const exitPrice=hit?target:Number(c.close);
                const pnl=hit?targetPct:(exitPrice-position.entryPrice)/position.entryPrice*100;
                const result=month(key);
                result.trades++;result.pnl+=pnl;result.isLocked=cap>0 && result.pnl+0.001>=cap;
                totalTrades++;if(pnl>=0)winCount++;netPnl+=pnl;totalHoldMs+=time-position.entryTime;
                if (options.includeTrades!==false) {
                    const entryTime=position.entryTime, identity=settings.id || settings.symbol || 'strategy';
                    const minutes=Math.max(0,Math.floor((time-entryTime)/60000));
                    const trade={id:`sim_${identity}_${entryTime}_${time}`,coinId:settings.id,symbol:settings.symbol,
                        originSignalId:`${identity}_${entryTime}`,originSignalTime:entryTime,
                        ...position,exitTime:time,exitPrice,pnl,pnlPercent:pnl,monthKey:key,
                        reason:hit?`Kâr (%${targetPct.toFixed(1)})`:`RSI Sat (${current.toFixed(0)})`,
                        isWin:pnl>=0,isReal:false,duration:minutes>=60?`${Math.floor(minutes/60)}sa ${minutes%60}dk`:`${minutes}dk`};
                    trades.push(trade);result.tradesList.push(trade);
                }
                position=null;
            }
        }
        if (options.year) {
            const year=String(options.year),nowKey=monthKey(options.asOf ?? Date.now());
            const count=nowKey.startsWith(year+'-')?Number(nowKey.slice(5)):12;
            for(let m=1;m<=count;m++)month(`${year}-${String(m).padStart(2,'0')}`);
        }
        const monthly=[...months.values()].filter(m=>!options.year || m.monthKey.startsWith(String(options.year)+'-')).sort((a,b)=>b.monthKey.localeCompare(a.monthKey));
        monthly.forEach(m=>m.tradesList.sort((a,b)=>b.exitTime-a.exitTime));
        return {trades,months:monthly,totalTrades,winCount,lossCount:totalTrades-winCount,netPnl,
            winRateDouble:totalTrades?winCount/totalTrades*100:0,averageHoldMs:totalTrades?totalHoldMs/totalTrades:0,openPosition:position};
    }
    function leagueResult(result,settings) {
        const monthlyBreakdowns=result.months.filter(m=>m.trades>0).map(m=>{
            const entries=m.tradesList.map(t=>t.entryTime),ordered=[...m.tradesList].sort((a,b)=>a.exitTime-b.exitTime);
            let pnl=0,locked=null;
            for(const t of ordered){pnl+=t.pnl;if(locked===null && Number(settings.monthlyCap)>0 && pnl+0.001>=Number(settings.monthlyCap))locked=t;}
            const firstTradeDay=day(Math.min(...entries)),lockDay=locked?day(locked.exitTime):null;
            return {monthKey:m.monthKey,monthName:m.name,firstTradeDay,lockDay,
                daysToLock:locked?Math.max(1,lockDay-firstTradeDay+1):null,totalMonthPnl:m.pnl,isLocked:m.isLocked};
        });
        const locked=monthlyBreakdowns.filter(m=>m.isLocked),hours=result.averageHoldMs/3600000;
        return {...result,rsiLength:Number(settings.rsiLength),buyRsi:Number(settings.buyRsi),sellRsi:Number(settings.sellRsi),
            winRate:result.winRateDouble.toFixed(0)+'%',tradeLogs:result.trades,
            avgDurationFormatted:hours<1?`${Math.floor(hours*60)}dk`:`${hours.toFixed(1)}sa`,monthlyBreakdowns,
            avgDaysToLock:locked.length?(locked.reduce((s,m)=>s+m.daysToLock,0)/locked.length).toFixed(1):null,
            lockedMonthsRatio:`${locked.length}/${Math.max(1,monthlyBreakdowns.length)} Ay`};
    }
    function optimize(candles,settings,options={}) {
        const bars=prepare(candles,settings.interval,options.asOf ?? Date.now());
        const values=rsiHistory(bars.map(c=>c.close),Number(settings.rsiLength));
        const opts={...options,prepared:true,rsiValues:values};
        let best=null;
        for(let buy=10;buy<=35;buy++)for(let sell=65;sell<=92;sell++) {
            const result=simulate(bars,{...settings,buyRsi:buy,sellRsi:sell},{...opts,includeTrades:false});
            const score=result.netPnl*Math.pow(result.winRateDouble/100,1.5);
            if(result.totalTrades && (!best || score>best.score))best={buyRsi:buy,sellRsi:sell,score};
        }
        const chosen={...settings,buyRsi:best?best.buyRsi:25,sellRsi:best?best.sellRsi:75};
        return leagueResult(simulate(bars,chosen,opts),chosen);
    }
    return {version:1,monthKey,intervalMs,rsiHistory,prepare,simulate,leagueResult,optimize};
}
globalThis.KuzgunStrategy = createKuzgunStrategy();
