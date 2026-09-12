// Exercise the shipped page helpers/actions and watch UI without a browser or network.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('web/index.html','utf8');
const inline=html.slice(html.indexOf("'use strict';"),html.indexOf("document.addEventListener('click'"));
const script=fs.readFileSync('web/watch.js','utf8');
function harness(){
 const nodes=new Map(),requests=[],responses=[];
 const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',scrollIntoView(){this.scrolled=true}});return nodes.get(selector)};
 const context=vm.createContext({document:{querySelector:node,addEventListener(){}},window:{scrollTo(){}},location:{hash:''},
  setTimeout(){return 1},clearTimeout(){},requestAnimationFrame(){},
  keywordWorkspace(){return ''},insightWorkspace(){return ''},reportWorkspace(){return ''},guide(){return ''},research(){return ''},jobView(){return ''},
  async fetch(path,options){requests.push({path,options});assert.ok(responses.length,'Only an explicit refresh may request history');return responses.shift()(path,options)}});
 vm.runInContext(script,context);vm.runInContext(inline,context);
 return {context,nodes,requests,responses,run:code=>vm.runInContext(code,context),
  set(p){context.inputProject=p;vm.runInContext("state.project=inputProject;state.page='products';state.query='';state.filter='all';state.sort='default'",context)}};
}
function product(id='B000000001',title='宠物饮水机'){
 return {id,title,asin:id,platform:'amazon',source_url:'https://www.amazon.com/dp/'+id,
  features:['可拆卸'],candidate:false,price:null,currency:'USD',rating:null,review_count:null,
  sales_raw:'',provenance:'live',collected_at:'2026-09-12T00:00:00Z'};
}
function project(id='project-a',items=[product()]){return {id,name:'调研',keyword:'宠物饮水机',revision:7,
 updated_at:'2026-09-12T00:00:00Z',data_version:1,products:items,watch_history:[],demo:false}}
function history(status='success'){
 return {product_id:'B000000001',status,created_at:'2026-09-12T00:00:00Z',finished_at:'2026-09-12T00:01:00Z',
  requests:2,request_limit:2,source:'卖家精灵 MCP',results:[
   {tool:'keepa_info',status:'success',data:{requested_asin:'B000000001',returned_asin:'B000000001',data_asin:'B000000001',skipped_points:3,series:{
    price:[{at:'2026-09-01T00:00:00Z',value:19.99},{at:'2026-09-10T00:00:00Z',value:24.99}],
    bsr:[{at:'2026-09-10T00:00:00Z',value:null}],ratings_count:[],rating:[]}}},
   {tool:'asin_sales_trend',status:'success',data:{requested_asin:'B000000001',returned_asin:'B000000001',skipped_points:2,
    months:[{month:'2026-08',parent_units:3200,child_units:140,average_price:null}]}}]};
}
function renderHistory(h,record){h.context.inputHistory=record;return h.run('historyBody(inputHistory)')}
async function main(){
 const h=harness();h.set(project());
 assert.match(html,/<script src="\/watch.js"><\/script>/);
 assert.equal(h.run("NAV.some(x=>x[0]==='products'&&x[2]==='电商盯盘')"),true);
 let view=h.run('marketWatch()');
 assert.match(view,/查看竞品变化/);assert.match(view,/未开启定时监控/);assert.equal(h.requests.length,0);
 await h.run("runAction('product-history',{dataset:{id:'B000000001'}})");
 assert.equal(h.run('watch.productId'),'B000000001');assert.match(h.nodes.get('#content').innerHTML,/读取历史 · 2次查询/);
 assert.match(h.nodes.get('#content').innerHTML,/近 90 天的价格、BSR 与评分记录，以及供应商全部可用月份的销量估算/);
 assert.equal(h.requests.length,0,'Viewing saved/empty history does not consume MCP calls');

 h.context.missingDaily=[{at:'2026-09-01T00:00:00Z',value:null}];
 h.context.monthly=[{month:'2026-07',average_price:25},{month:'2026-08',average_price:29}];
 const fallback=h.run('historyPriceChart(missingDaily,monthly)');
 assert.match(fallback,/月均价格 · USD/);assert.match(fallback,/统计口径不同/);assert.match(fallback,/<svg/);
 assert.equal(h.requests.length,0,'Monthly fallback uses saved values without another request');
 let resolve;h.responses.push(()=>new Promise(r=>{resolve=r}));
 const pending=h.run("watchAction('refresh-product-history',{dataset:{id:'B000000001'}})");
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].path,'/api/projects/project-a/product-history');
 assert.equal(h.requests[0].options.method,'POST');
 assert.deepEqual(JSON.parse(h.requests[0].options.body),{revision:7,product_id:'B000000001'});
 await h.run("watchAction('refresh-product-history',{dataset:{id:'B000000001'}})");
 assert.equal(h.requests.length,1,'A double click does not duplicate queries');
 const saved=project();saved.revision=8;saved.watch_history=[history()];resolve({ok:true,json:async()=>saved});await pending;
 assert.equal(h.run('state.project.revision'),8);assert.equal(h.run('watch.busy'),false);
 assert.match(h.nodes.get('#content').innerHTML,/更新趋势 · 2次查询/);

 h.responses.push(()=>new Promise(r=>{resolve=r}));
 const old=h.run("watchAction('refresh-product-history',{dataset:{id:'B000000001'}})");
 const other=project('project-b',[product('B000000002','另一个项目的商品')]);h.set(other);
 await h.run("runAction('product-history',{dataset:{id:'B000000002'}})");
 assert.match(h.nodes.get('#content').innerHTML,/正在查询/);
 resolve({ok:true,json:async()=>saved});await old;
 assert.equal(h.run('state.project.id'),'project-b');assert.equal(h.run('state.project.revision'),7);
 assert.match(h.nodes.get('#content').innerHTML,/另一个项目的商品/);
 assert.doesNotMatch(h.nodes.get('#content').innerHTML,/正在查询…/,'The new project is re-rendered when the old request unlocks');

 const partial=history('partial');partial.results[1]={tool:'asin_sales_trend',status:'failed',error:'供应商限流，请稍后再试',http:429};
 view=renderHistory(h,partial);assert.match(view,/部分结果已保存/);assert.match(view,/供应商限流/);assert.match(view,/HTTP 429/);assert.match(view,/24\.99/);
 assert.match(view,/跳过异常、重复或超出范围时间点 3 个/);assert.match(view,/保留缺失值时间点 1 个/);
 const missing=history();missing.results[0].data.series.price=[{at:'2026-09-10',value:null}];
 view=renderHistory(h,missing);assert.match(view,/<strong>未提供<\/strong><span>最新记录价格/);
 assert.match(view,/<strong>未提供<\/strong><span>BSR 排名/);assert.doesNotMatch(view,/<strong>0<\/strong>/);
 assert.match(view,/<th>父体月销量<\/th><th>子体月销量<\/th>/);
 assert.match(view,/<td>3,200<\/td><td>140<\/td><td>未提供<\/td>/);
 assert.match(view,/供应商全部可用月份，不限于近 90 天/);
 assert.match(view,/跳过异常或重复月份 2 个/);assert.match(view,/当前表格缺失值 4 项/);
 assert.equal(h.run('watchValue(0)'), '0');assert.equal(h.run('watchValue(null)'),'未提供');assert.equal(h.run('watchValue(NaN)'),'未提供');

 for(const field of ['data_asin','returned_asin']){
  const mismatch=history();mismatch.results[0].data[field]='B000000099';
  view=renderHistory(h,mismatch);assert.match(view,/供应商返回关联商品 B000000099/);assert.match(view,/不能直接作为所选商品的走势/);
 }
 const mismatch=history();mismatch.results[1].data.returned_asin='B000000088';
 assert.match(renderHistory(h,mismatch),/销量返回商品 B000000088 与查询商品不同/);
 const onlyMonthly=history('partial');onlyMonthly.results[0]={tool:'keepa_info',status:'failed',error:'价格记录查询失败',http:503};
 onlyMonthly.results[1].data.months=[{month:'2026-07',average_price:25,price:1234.56,parent_revenue:920001,child_revenue:830001},{month:'2026-08',average_price:29}];
 view=renderHistory(h,onlyMonthly);assert.match(view,/月均价格 · USD/);assert.match(view,/统计口径不同/);assert.match(view,/HTTP 503/);
 for(const value of ['1,234.56','920,001','830,001'])assert.ok(view.includes(value),'Saved supplier fields remain in folded raw details');
 h.context.onlyMonthly=onlyMonthly;const monthlyExport=h.run('historyBody(onlyMonthly,{exported:true})');
 for(const value of ['1,234.56','920,001','830,001'])assert.ok(monthlyExport.includes(value),'HTML export preserves each saved monthly field');
 onlyMonthly.results[1].data.returned_asin='B000000099';view=renderHistory(h,onlyMonthly);assert.doesNotMatch(view,/<figcaption>月均价格 · USD/,'Wrong-ASIN monthly data cannot replace selected product prices');

 const attack='<img src=x onerror="alert(1)">';
 const injected=history('partial');injected.source=attack;injected.requests=attack;
 injected.results[0].data.data_asin=attack;injected.results[1]={tool:'asin_sales_trend',status:'failed',error:attack,http:500};
 view=renderHistory(h,injected);assert.doesNotMatch(view,/<img/);assert.match(view,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
 const escaped=project('project-c',[product('B000000001',attack)]);escaped.watch_history=[injected];h.set(escaped);h.run("watch.productId='B000000001'");
 escaped.products[0].features=[attack];escaped.products[0].sales_raw=attack;escaped.products[0].source_url='https://example.test/"<img src=x>';
 assert.doesNotMatch(h.run('marketWatch()'),/<img/);assert.doesNotMatch(h.run('watchReportHtml()'),/<img/);
 assert.equal(h.requests.length,2,'Rendering/report export never makes extra requests');
 h.responses.push(async()=>({ok:false,json:async()=>({error:'供应商暂不可用'})}));
 await assert.rejects(h.run("watchAction('refresh-product-history',{dataset:{id:'B000000001'}})"),/供应商暂不可用/);
 assert.equal(h.run('watch.busy'),false);assert.doesNotMatch(h.nodes.get('#content').innerHTML,/正在查询…/);

 // Charts use actual dates, preserve zero, split known gaps, and label BSR direction.
 h.context.irregular=[{at:'2026-01-11T00:00:00Z',value:30},{at:'2026-01-01T00:00:00Z',value:10},{at:'2026-01-02T00:00:00Z',value:20},{at:'invalid',value:999}];
 let chart=h.run("watchLineChart(irregular,'日期测试')");
 assert.match(chart,/d="M68\.0,178\.0 L134\.7,100\.0 L735\.0,22\.0"/,'Jan 2 is one tenth of the ten-day interval, not the midpoint');
 assert.doesNotMatch(chart,/999|NaN|invalid/);
 h.context.gap=[{at:'2026-01-01T00:00:00Z',value:0},{at:'2026-01-02T00:00:00Z',value:null},{at:'2026-01-11T00:00:00Z',value:10}];
 chart=h.run("watchLineChart(gap,'缺失测试')");
 assert.match(chart,/data-series="line" d="M68\.0,178\.0  M735\.0,22\.0"/);
 assert.match(chart,/<title>2026-01-01：0<\/title>/);assert.match(chart,/缺失值处断开/);
 chart=h.run("watchLineChart(irregular,'BSR 排名',0,{rank:true})");
 assert.match(chart,/d="M68\.0,22\.0 L134\.7,100\.0 L735\.0,178\.0"/);
 assert.match(chart,/BSR 数字越小，名次越前/);

 h.context.units=[{month:'2026-03',parent_units:3000,child_units:30},{month:'2026-01',parent_units:1000,child_units:0},{month:'2025-01',parent_units:9999,child_units:999}];
 chart=h.run("watchSalesChart(units,'child_units','12')");
 assert.match(chart,/data-month="2026-01" data-value="0"/);assert.match(chart,/data-month="2026-03" data-value="30"/);
 assert.doesNotMatch(chart,/data-month="2025-01"|data-value="(?:3000|1000|9999)"/);
 assert.match(chart,/<title>2026-01：0 件（估算）<\/title>/);
 assert.match(chart,/父子体不相加/);assert.match(chart,/最新月份可能尚未结束/);
 chart=h.run("watchSalesChart(units,'parent_units','all')");
 assert.match(chart,/data-month="2025-01" data-value="9999"/);assert.doesNotMatch(chart,/data-value="30"/);
 h.context.missingMonth=[{month:'2026-01',child_units:0},{month:'2026-02',child_units:null},{month:'2026-03',child_units:10}];
 chart=h.run("watchSalesChart(missingMonth,'child_units','all')");
 assert.match(chart,/class="watch-missing"/);assert.match(chart,/<title>2026-02：未提供<\/title>/);
 assert.doesNotMatch(chart,/data-month="2026-02" data-value="0"/);

 // Use the real action dispatcher: list filtering, tabs and saved snapshots must stay offline.
 const selectedProduct=product();selectedProduct.candidate=true;selectedProduct.price=19;
 const secondProduct=product('B000000002','第二件商品');secondProduct.price=9;
 const listProject=project('watch-layout',[selectedProduct,secondProduct]);
 const older=history();older.id='history-old';older.created_at='2026-09-10T09:00:00Z';older.finished_at='2026-09-10T09:01:00Z';older.results[0].data.series.price[1].value=22;
 const newer=history();newer.id='history-new';
 newer.results[0].data.series.bsr=[{at:'2026-09-01T00:00:00Z',value:900},{at:'2026-09-10T00:00:00Z',value:800}];
 newer.results[0].data.series.rating=[{at:'2026-09-01T00:00:00Z',value:4},{at:'2026-09-10T00:00:00Z',value:4.5}];
 newer.results[0].data.series.ratings_count=[{at:'2026-09-01T00:00:00Z',value:30},{at:'2026-09-10T00:00:00Z',value:50}];
 newer.results[1].data.months=Array.from({length:27},(_,i)=>({month:Math.floor((2024*12+5+i)/12)+'-'+String((5+i)%12+1).padStart(2,'0'),parent_units:1000+i,child_units:100+i,average_price:20+i}));
 listProject.watch_history=[older,newer];h.set(listProject);const unchanged=JSON.stringify(listProject),requestCount=h.requests.length;
 view=h.run('marketWatch()');
 assert.equal(h.run('watch.filter'),'candidate');assert.match(view,/data-product="B000000001"/);assert.doesNotMatch(view,/data-product="B000000002"/);
 assert.ok(view.indexOf('id="watch-history"')<view.indexOf('class="watch-list"'),'Focused details precede the product list');
 assert.match(view,/class="watch-spark"><figure/);
 assert.match(view,/<details class="watch-details"><summary>查看全部 27 个月/);assert.doesNotMatch(view,/<details[^>]*\bopen\b/);
 assert.match(view,/2026-09-12<\/h4>/);assert.match(view,/2026-09-10<\/h4>/);
 await h.run("runAction('watch-filter',{dataset:{value:'all'}})");
 assert.match(h.nodes.get('#content').innerHTML,/data-product="B000000002"/);
 h.run("state.sort='price';render()");view=h.nodes.get('#content').innerHTML;
 assert.ok(view.indexOf('data-product="B000000002"')<view.indexOf('data-product="B000000001"'));
 await h.run("runAction('watch-metric',{dataset:{value:'bsr'}})");
 view=h.nodes.get('#content').innerHTML;assert.match(view,/aria-pressed="true" data-action="watch-metric" data-value="bsr"/);assert.match(view,/<figcaption>BSR 排名<\/figcaption>/);
 await h.run("runAction('watch-metric',{dataset:{value:'parent_units'}})");
 assert.match(h.nodes.get('#content').innerHTML,/父体月销量 · 第三方估算/);
 await h.run("runAction('watch-months',{dataset:{value:'all'}})");
 assert.equal(h.run('watch.months'),'all');
 await h.run("runAction('watch-snapshot',{dataset:{index:'0'}})");
 assert.equal(h.run('watchSelectedHistory("B000000001").id'),'history-old');
 await h.run("runAction('watch-metric',{dataset:{value:'price'}})");
 assert.match(h.nodes.get('#content').innerHTML,/<strong>22<\/strong>/);
 await h.run("runAction('watch-metric',{dataset:{value:'__proto__'}})");assert.equal(h.run('watch.metric'),'price');
 await h.run("runAction('watch-snapshot',{dataset:{index:'999'}})");assert.equal(h.run('watch.historyIndex'),0);
 assert.equal(h.requests.length,requestCount,'All list/tab/history interactions reuse saved data');
 assert.equal(JSON.stringify(listProject),unchanged,'Viewing and exporting do not mutate stored product/history data');

 // Export includes every metric and every saved month, regardless of the current tab/range/snapshot.
 const report=h.run('watchReportHtml()');
 assert.match(report,/<style>[\s\S]*\.watch-visual svg\{display:block!important/);
 for(const title of ['历史价格 · USD','BSR 排名','评分 · 5 分制','评分数量','子体月销量 · 第三方估算','父体月销量 · 第三方估算'])assert.ok(report.includes('<figcaption>'+title+'</figcaption>'),title+' must be visible in standalone exports');
 assert.match(report,/2024-06/);assert.match(report,/2026-08/);assert.match(report,/<strong>24\.99<\/strong>/);
 assert.doesNotMatch(report,/data-action="watch-metric"/);
 assert.equal(h.requests.length,requestCount);

 const wrongAsin=history();wrongAsin.results[0].data.data_asin='B000000099';wrongAsin.results[1].data.returned_asin='B000000099';
 h.context.wrongAsin=wrongAsin;h.run('state.project.watch_history=[wrongAsin]');
 assert.equal(h.run('watchSpark(state.project.products[0])'),'<span class="caption">尚无价格曲线</span>','Related-ASIN charts must not appear as the selected product mini trend');
 h.context.sameIdNewProject=project('watch-other',[product()]);h.run('state.project=sameIdNewProject;marketWatch()');
 assert.equal(h.run('watch.historyIndex'),-1);assert.equal(h.run('watch.productId'),'');assert.equal(h.run('watch.metric'),'price');

 // Product-direction actions open the real collection dialog with Amazon only; start remains explicit.
 const researchScript=fs.readFileSync('web/research.js','utf8');
 vm.runInContext(researchScript.split('\n').filter(line=>line.startsWith('const PLATFORM_NAMES=')||line.startsWith('function platformPicker(')).join('\n'),h.context);
 vm.runInContext(fs.readFileSync('web/collection.js','utf8'),h.context);
 h.context.document.querySelectorAll=selector=>selector==='input[name="collect-platform"]:checked'?[{value:'amazon'}]:[];
 h.context.document.querySelector('#collect-queries').value='quiet pet water fountain';h.context.document.querySelector('#collect-pages').value='1';
 h.run("state.page='report';watch.filter='candidate'");
 await h.run("runAction('watch-product-direction',{dataset:{query:'quiet pet water fountain'}})");
 assert.equal(h.run('state.page'),'products');assert.equal(h.run('watch.filter'),'all');assert.equal(h.run('state.modal'),true);
 const dialog=h.nodes.get('#modal-root').innerHTML;
 assert.match(dialog,/<textarea[^>]*>quiet pet water fountain<\/textarea>/);
 assert.match(dialog,/name="collect-platform" value="amazon" checked/);
 for(const platform of ['xhs','tiktok','reddit'])assert.doesNotMatch(dialog,new RegExp('name="collect-platform" value="'+platform+'" checked'));
 assert.match(dialog,/开始采集并保存/);assert.match(h.nodes.get('#collect-budget').textContent,/卖家精灵 1 次查询/);
 assert.equal(h.requests.length,requestCount,'Opening a prefilled product direction never issues a request');
 const completedProject=project('watch-other',[product(),product('B000000003','本次方向新发现的商品')]);
 const completedJob={id:'fake-job',project_id:'watch-other',run:{kind:'posts',status:'success',platforms:['amazon'],requests:1,request_limit:1,pages:1,imported:1,duplicates:0,errors:[]}};
 h.responses.push(async()=>({ok:true,json:async()=>completedJob}),async()=>({ok:true,json:async()=>completedJob}),async()=>({ok:true,json:async()=>completedProject}));
 await h.run("collectAction('start-collection',{disabled:false})");
 assert.equal(h.run('state.page'),'products');assert.equal(h.run('state.modal'),null);
 assert.match(h.nodes.get('#content').innerHTML,/本次方向新发现的商品/);
 assert.deepEqual(JSON.parse(h.requests[requestCount].options.body),{revision:7,kind:'posts',platforms:['amazon'],pages:1,queries:['quiet pet water fountain'],post_ids:[]});
 assert.equal(h.requests.length,requestCount+3,'Only explicit start sends the fake collect request and reads its saved results');
 console.log('Watch UI: compact lists, offline tabs/history, date-proportional/gapped charts, BSR direction, separate monthly estimates, full exports, query guards and escaping verified.');
}
main().catch(error=>{console.error(error);process.exitCode=1});
