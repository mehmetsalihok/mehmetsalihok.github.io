// KUZGUN Portföy Sihirbazı: terminal depolamasını yalnızca okur.
'use strict';
const OPT_INTERVALS = {'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000};
const optMoney = n => '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const optPct = n => `${n>=0?'+':''}${Number(n).toFixed(2)}%`;
const optSafe = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const optMonth = t => { const d=new Date(t+10800000); return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0'); };

function optRsi(closes,period) {
  const r=new Array(closes.length).fill(null);if(closes.length<=period)return r;
  let up=0,down=0;for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];up+=Math.max(0,d);down+=Math.max(0,-d)}
  up/=period;down/=period;r[period]=down===0?100:100-100/(1+up/down);
  for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];up=(up*(period-1)+Math.max(0,d))/period;down=(down*(period-1)+Math.max(0,-d))/period;r[i]=down===0?100:100-100/(1+up/down)}
  return r;
}

function optRows(candles,period) {
  const rs=optRsi(candles.map(c=>c.close),period),rows=[];
  for(let i=period+1;i<candles.length;i++)if(rs[i]!=null&&rs[i-1]!=null)rows.push({t:candles[i].t,close:candles[i].close,high:candles[i].high,rsi:rs[i],prev:rs[i-1]});
  return rows;
}

function optSolo(rows,c,start,end,fee) {
  let pos=null,gain=0,trades=0,hold=0;const month=new Map();
  for(const row of rows){if(row.t<start||row.t>end)continue;
    if(pos&&row.t>pos.t){const target=pos.price*(1+c.profitTarget/100);
      if(row.high>=target||row.rsi>=c.sellRsi){const exit=row.high>=target?target:row.close,pnl=(exit/pos.price-1)*100;
        gain+=pnl-(fee?.075*(1+exit/pos.price):0);trades++;hold+=(row.t-pos.t)/3600000;
        const key=optMonth(row.t);month.set(key,(month.get(key)||0)+pnl);pos=null;
      }
    }
    if(!pos && (month.get(optMonth(row.t))||0)+.001<c.monthlyCap && row.prev<=c.buyRsi&&row.rsi>c.buyRsi)pos={t:row.t,price:row.close};
  }
  return {gain,trades,avgHours:trades?hold/trades:0};
}

function optReplay(configs,rowsByVariant,start,end,balance,slots,fee) {
  const selected=new Map(configs.filter(Boolean).map(c=>[c.symbol,c])),events=[];
  for(const c of selected.values())for(const r of rowsByVariant[c.key])if(r.t>=start&&r.t<=end)events.push({symbol:c.symbol,...r});
  events.sort((a,b)=>a.t-b.t||a.symbol.localeCompare(b.symbol));
  const open=new Map(),month=new Map(),lastPrices=new Map();let equity=balance,completed=0,blocked=0,holdHours=0,slotMs=0,last=start;
  for(let i=0;i<events.length;){const t=events[i].t;slotMs+=open.size*Math.max(0,t-last);last=t;
    let j=i+1;while(j<events.length&&events[j].t===t)j++;
    const group=events.slice(i,j);
    for(const e of group){lastPrices.set(e.symbol,e.close);const pos=open.get(e.symbol);if(!pos||pos.t>=t)continue;
      const c=selected.get(e.symbol),target=pos.entry*(1+c.profitTarget/100);
      if(e.high<target&&e.rsi<c.sellRsi)continue;
      const price=e.high>=target?target:e.close,gross=(price/pos.entry-1)*100;
      const fees=fee?pos.budget*.00075+pos.budget*(price/pos.entry)*.00075:0;
      equity+=pos.budget*gross/100-fees;holdHours+=(t-pos.t)/3600000;completed++;
      const key=e.symbol+'|'+optMonth(t);month.set(key,(month.get(key)||0)+gross);open.delete(e.symbol);
    }
    const buys=group.filter(e=>e.prev<=selected.get(e.symbol).buyRsi&&e.rsi>selected.get(e.symbol).buyRsi&&!open.has(e.symbol))
      .sort((a,b)=>(a.rsi-selected.get(a.symbol).buyRsi)-(b.rsi-selected.get(b.symbol).buyRsi)||a.symbol.localeCompare(b.symbol));
    for(const e of buys){const c=selected.get(e.symbol);if((month.get(e.symbol+'|'+optMonth(t))||0)+.001>=c.monthlyCap)continue;
      if(open.size>=slots){blocked++;continue}
      open.set(e.symbol,{entry:e.close,t,budget:Math.max(0,equity)/slots});
    }
    i=j;
  }
  slotMs+=open.size*Math.max(0,end-last);
  for(const [symbol,pos] of open){const price=lastPrices.get(symbol)||pos.entry,ratio=price/pos.entry;
    equity+=pos.budget*(ratio-1)-(fee?pos.budget*.00075+pos.budget*ratio*.00075:0);
  }
  return {balance:equity,returnPct:(equity/balance-1)*100,trades:completed,blocked,avgHours:completed?holdHours/completed:0,occupancy:slotMs/((end-start)*slots)*100,open:open.size};
}

function optBuildCandidates(coins,candlesByCoin,start,trainEnd,fee,progress) {
  const rows={},variants={};
  for(let index=0;index<coins.length;index++){
    const coin=coins[index],candles=candlesByCoin[coin.symbol],list=[];
    for(const interval of Object.keys(candles)){
      for(const length of new Set([6,7,coin.rsiLength])){
        if(length===coin.rsiLength&&interval!==coin.interval&&length!==6&&length!==7)continue;
        const key=`${coin.symbol}|${interval}|${length}`,data=optRows(candles[interval],length);rows[key]=data;
        if(interval==='15m'||interval==='30m'){
          let best=null,bestScore=-Infinity;
          for(let buy=10;buy<=35;buy+=2)for(let sell=65;sell<=92;sell+=3){
            const c={...coin,interval,rsiLength:length,buyRsi:buy,sellRsi:sell,key};
            const solo=optSolo(data,c,start,trainEnd,fee),score=solo.trades>=3?solo.gain:-1000+solo.gain;
            if(score>bestScore){bestScore=score;best=c}
          }
          if(best)list.push(best);
        }
      }
    }
    const original={...coin,key:`${coin.symbol}|${coin.interval}|${coin.rsiLength}`};
    variants[coin.symbol]=[original,...list.filter(c=>c.key!==original.key||c.buyRsi!==original.buyRsi||c.sellRsi!==original.sellRsi)];
    progress(`Aday ayarlar ${index+1}/${coins.length} · ${coin.name}`,12+Math.round((index+1)/coins.length*35));
  }
  return {variants,rows};
}

function optOptimize(data,notify) {
  const {coins,candles,start,end,balance,slots,fees}=data,split=start+Math.floor((end-start)*.7);
  const {variants,rows}=optBuildCandidates(coins,candles,start,split,fees,notify);
  const current=coins.map(c=>c.active?variants[c.symbol][0]:null);
  const initial=coins.map(c=>variants[c.symbol][1]||variants[c.symbol][0]);
  const cache=new Map(),keyOf=items=>items.map(x=>x?`${x.key}:${x.buyRsi}:${x.sellRsi}`:'off').join('/');
  function train(items){const key=keyOf(items);if(!cache.has(key))cache.set(key,optReplay(items,rows,start,split,balance,slots,fees));return cache.get(key)}
  const baselineTrain=train(current);
  const targets=[{kind:'profit',title:'En yüksek net getiri'},{kind:'fast',title:'Daha hızlı getiri'}],found=[];
  for(let mode=0;mode<targets.length;mode++){
    const goal=targets[mode];let champion=null,championScore=-Infinity;
    for(const seed of [current,initial]){
      let chosen=seed.slice();
      function score(items){const r=train(items);if(goal.kind==='profit')return r.returnPct;
        return r.returnPct<=0?-1000+r.returnPct:r.returnPct/(1+r.avgHours/6)-(r.trades<3?100:0);
      }
      for(let pass=0;pass<2;pass++){
        for(let i=0;i<coins.length;i++){
          let best=chosen[i],bestScore=score(chosen);
          for(const candidate of [null,...variants[coins[i].symbol]]){
            if(candidate===chosen[i])continue;const proposal=chosen.slice();proposal[i]=candidate;
            const value=score(proposal);if(value>bestScore+1e-9){bestScore=value;best=candidate}
          }
          chosen[i]=best;
        }
        notify(`${goal.title}: kombinasyonlar karşılaştırılıyor`,52+mode*20+pass*9);
      }
      const value=score(chosen);if(value>championScore){championScore=value;champion=chosen}
    }
    found.push({kind:goal.kind,title:goal.title,configs:champion,train:train(champion)});
  }
  const baselineTest=optReplay(current,rows,split,end,balance,slots,fees);
  const recommendations=found.map(f=>({...f,test:optReplay(f.configs,rows,split,end,balance,slots,fees)}));
  notify('Son dönem kontrolü tamamlandı',100);
  return {current,baselineTrain,baselineTest,recommendations,split,start,end,coins,slots,balance,fees,candidateCount:Object.values(variants).reduce((n,v)=>n+v.length+1,0),evaluated:cache.size};
}

if(typeof document==='undefined'){
  self.onmessage=e=>{
    try {const result=optOptimize(e.data,(label,percent)=>self.postMessage({type:'progress',label,percent}));self.postMessage({type:'done',result})}
    catch(error){self.postMessage({type:'error',message:error?.message||String(error)})}
  };
} else {
  const $=id=>document.getElementById(id);
  const candleCache=new Map();let running=false,worker=null;
  function configFromTerminal(){
    let raw=[];try{raw=JSON.parse(localStorage.getItem('kuzgun_web_coins')||'[]')}catch{}
    if(!Array.isArray(raw))raw=[];
    const coins=raw.filter(c=>c&&/^[A-Z0-9]{2,20}USDT$/.test(c.symbol||'')&&OPT_INTERVALS[c.interval]&&Number(c.rsiLength)>=2&&Number(c.rsiLength)<=50&&Number(c.buyRsi)>0&&Number(c.sellRsi)>Number(c.buyRsi)&&Number(c.sellRsi)<=100&&Number(c.profitTarget)>0&&Number(c.monthlyCap)>0)
      .map(c=>({symbol:c.symbol,name:c.displaySymbol||c.symbol.replace(/USDT$/,''),active:c.isActive!==false,interval:c.interval,rsiLength:Number(c.rsiLength),buyRsi:Number(c.buyRsi),sellRsi:Number(c.sellRsi),profitTarget:Number(c.profitTarget),monthlyCap:Number(c.monthlyCap)}));
    const rawBalance=Number(localStorage.getItem('kuzgun_base_usd')||localStorage.getItem('kuzgun_user_balance')||1000),rawSlots=Number(localStorage.getItem('kuzgun_max_slots'))||2;
    return {coins,balance:rawBalance>0?rawBalance:1000,slots:Math.min(12,Math.max(1,Math.floor(rawSlots))),fees:localStorage.getItem('kuzgun_fee_deduction_enabled')!=='false'};
  }
  function renderInput(){const c=configFromTerminal();$('coinCount').textContent=c.coins.length;$('activeCount').textContent=c.coins.filter(x=>x.active).length;
    $('balance').textContent=optMoney(c.balance);$('fee').textContent=c.fees?'Açık (%0,075 + %0,075)':'Kapalı';
    $('slots').innerHTML=Array.from({length:Math.max(4,c.slots)},(_,i)=>`<option value="${i+1}">${i+1} slot</option>`).join('');$('slots').value=String(c.slots);
    $('coinList').innerHTML=c.coins.length?c.coins.map(x=>`<span class="coin ${x.active?'':'off'}">${optSafe(x.name)} <small>${x.active?'aktif':'pasif'} · ${optSafe(x.interval)} RSI ${x.rsiLength}</small></span>`).join(''):'<span class="muted">Kayıtlı uygun coin yok.</span>';
    $('start').disabled=!c.coins.length;$('status').textContent=c.coins.length?`${c.coins.length} coin hazır. Analiz terminal ayarlarını değiştirmez.`:'Terminale önce coin ekle.';
  }
  async function loadCandles(coin,interval,start,end){const size=OPT_INTERVALS[interval],warm=start-120*size,cacheKey=`${coin.symbol}|${interval}|${start}`;
    const stored=candleCache.get(cacheKey);if(stored&&stored.end>=end-60000)return stored.rows;
    let cursor=Math.max(0,Math.floor(warm/size)*size),out=[];
    while(cursor<end){let batch=null,last=null;
      for(const endpoint of ['https://api.binance.com/api/v3/klines','https://data-api.binance.vision/api/v3/klines']){
        const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
        try{const url=`${endpoint}?symbol=${coin.symbol}&interval=${interval}&startTime=${cursor}&endTime=${end-1}&limit=1000`,res=await fetch(url,{signal:ctrl.signal});
          if(!res.ok)throw Error(`HTTP ${res.status}`);batch=await res.json();if(!Array.isArray(batch))throw Error('Geçersiz veri');break}
        catch(e){last=e}finally{clearTimeout(timer)}
      }
      if(!batch)throw Error(`${coin.name} ${interval}: mum verisi alınamadı (${last?.message||'bağlantı'}).`);
      if(!batch.length)break;
      for(const row of batch){const t=Number(row[0])+size,close=Number(row[4]),high=Number(row[2]);if(t<=end&&close>0&&high>0)out.push({t,close,high})}
      const next=Number(batch.at(-1)[0])+size;if(next<=cursor)throw Error(`${coin.name} ${interval}: veri ilerlemiyor.`);cursor=next;
      if(batch.length<1000)break;
    }
    out=[...new Map(out.map(x=>[x.t,x])).values()].sort((a,b)=>a.t-b.t);
    if(out.length<140||!out.some(x=>x.t>=start))throw Error(`${coin.name} ${interval}: seçilen dönem için yeterli veri yok.`);
    candleCache.set(cacheKey,{rows:out,end});return out;
  }
  function progress(label,percent){$('status').textContent=label;$('bar').style.width=`${percent}%`;$('progress').hidden=false}
  function renderResult(res){const baseline=res.baselineTest,rec=res.recommendations;
    $('report').hidden=false;$('error').hidden=true;
    $('summary').innerHTML=`<div class="metric"><small>Mevcut · son dönem</small><strong>${optPct(baseline.returnPct)}</strong><span>${baseline.trades} işlem · ${baseline.avgHours.toFixed(1)} saat ort.</span></div><div class="metric"><small>Öneri · son dönem</small><strong>${optPct(rec[0].test.returnPct)}</strong><span>${rec[0].test.trades} işlem · ${rec[0].test.avgHours.toFixed(1)} saat ort.</span></div><div class="metric"><small>Denenen kombinasyon</small><strong>${res.evaluated}</strong><span>${res.candidateCount} coin ayarı · ${res.slots} slot</span></div>`;
    $('period').textContent=`Ayarlama: ${new Date(res.start).toLocaleDateString('tr-TR')} – ${new Date(res.split).toLocaleDateString('tr-TR')} · Ayrı kontrol: ${new Date(res.split).toLocaleDateString('tr-TR')} – ${new Date(res.end).toLocaleDateString('tr-TR')}`;
    $('cards').innerHTML=rec.map((r,i)=>{const enabled=r.configs.filter(Boolean),difference=r.test.returnPct-baseline.returnPct;
      return `<article class="panel recommendation"><div class="row"><div><div class="eyebrow">ÖNERİ ${i+1}</div><h3>${optSafe(r.title)}</h3></div><span class="pill">${enabled.length} aktif coin</span></div>
        <div class="numbers"><div><small>Ayarlama dönemi</small><b>${optPct(r.train.returnPct)}</b></div><div><small>Son dönem kontrolü</small><b class="${difference>=0?'positive':'negative'}">${optPct(r.test.returnPct)}</b></div><div><small>Mevcut düzene fark</small><b class="${difference>=0?'positive':'negative'}">${difference>=0?'+':''}${difference.toFixed(2)} puan</b></div><div><small>Ort. işlem süresi</small><b>${r.test.avgHours.toFixed(1)} saat</b></div></div>
        <div class="table-scroll"><table><thead><tr><th>Coin</th><th>Durum</th><th>Zaman</th><th>RSI</th><th>Al / Sat</th><th>Değişiklik</th></tr></thead><tbody>${res.coins.map((c,idx)=>{const v=r.configs[idx],change=!v?(c.active?'Kapat':'—'):(c.active&&v.interval===c.interval&&v.rsiLength===c.rsiLength&&v.buyRsi===c.buyRsi&&v.sellRsi===c.sellRsi?'Aynı':c.active?'Ayar değiştir':'Aktif et');return `<tr><td><b>${optSafe(c.name)}</b></td><td>${v?'Aktif':'Pasif'}</td><td>${v?optSafe(v.interval):'—'}</td><td>${v?v.rsiLength:'—'}</td><td>${v?`${v.buyRsi} / ${v.sellRsi}`:'—'}</td><td>${change}</td></tr>`}).join('')}</tbody></table></div>
        <p class="micro">Son dönem: ${r.test.trades} tamamlanan işlem · ${r.test.occupancy.toFixed(1)}% slot doluluğu · ${r.test.blocked} çakışma nedeniyle kaçan sinyal · ${r.test.open} açık pozisyon.</p>
        ${difference<0?'<p class="caution">Bu kombinasyon ayrı kontrol döneminde mevcut düzenden düşük getiri sağladı; uygulanacak öneri olarak değerlendirme.</p>':''}
        ${r.test.trades<3?'<p class="caution">Son dönem işlem sayısı az; sonuç güvenilir bir karşılaştırma için yetersiz olabilir.</p>':''}</article>`;
    }).join('');
  }
  async function start(){if(running)return;const snapshot=configFromTerminal();if(!snapshot.coins.length)return;
    const days=Number($('days').value),slots=Number($('slots').value),end=Math.floor(Date.now()/60000)*60000,start=end-days*86400000;
    running=true;$('start').disabled=true;$('report').hidden=true;$('error').hidden=true;progress('Mum verileri yükleniyor…',1);
    try{const history={},tasks=snapshot.coins.flatMap(c=>[...new Set(['15m','30m',c.interval])].map(interval=>({coin:c,interval})));
      let nextTask=0,completedTasks=0;
      await Promise.all(Array.from({length:Math.min(3,tasks.length)},async()=>{
        while(nextTask<tasks.length){const {coin,interval}=tasks[nextTask++];
          const rows=await loadCandles(coin,interval,start,end);
          history[coin.symbol]??={};history[coin.symbol][interval]=rows;
          completedTasks++;progress(`${completedTasks}/${tasks.length} · ${coin.name} ${interval} mum verileri`,Math.round(completedTasks/tasks.length*10));
        }
      }));
      const commonEnd=Math.min(...tasks.map(({coin,interval})=>history[coin.symbol][interval].at(-1).t));
      if(commonEnd<=start)throw Error('Tüm coinlerin ortak analiz dönemi bulunamadı.');
      progress('RSI adayları hesaplanıyor…',11);
      worker=new Worker('portfolio-optimizer.js?worker=1');
      const result=await new Promise((resolve,reject)=>{worker.onmessage=e=>{const m=e.data;if(m.type==='progress')progress(m.label,m.percent);else if(m.type==='done')resolve(m.result);else if(m.type==='error')reject(Error(m.message))};worker.onerror=e=>reject(Error(e.message||'Hesaplama hatası'));worker.postMessage({...snapshot,slots,start,end:commonEnd,candles:history})});
      renderResult(result);progress(`${snapshot.coins.length} coin için öneriler hazır.`,100);setTimeout(()=>$('progress').hidden=true,1500);
    }catch(error){$('error').hidden=false;$('error').textContent=error?.message||'Analiz tamamlanamadı.';progress('Analiz tamamlanamadı.',0);$('progress').hidden=true}
    finally{if(worker){worker.terminate();worker=null}running=false;$('start').disabled=false}
  }
  $('start').addEventListener('click',start);renderInput();
}
