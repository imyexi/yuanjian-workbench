/* Saved product recommendations. Navigation starts work; renderers and exports are read-only. */
const recommendationsUI={entries:new Map(),startingAI:false};
const RECOMMENDATION_DONE=new Set(['success','no_match','failed','interrupted']);
function recommendationReport(){return state.project&&['insights','report'].includes(state.page)?selectedInsightReport():null}
function recommendationStamp(report){return JSON.stringify([report?.id,report?.data_version,report?.status,report?.finished_at,report?.report])}
function recommendationRecord(report,project=state.project){return report?[...(project?.product_recommendations||[])].reverse().find(x=>x.report_id===report.id):null}
function recommendationEntry(report){const key=state.project?.id+'/'+report?.id,previous=recommendationsUI.entries.get(key),stamp=recommendationStamp(report);if(!previous||previous.stamp!==stamp){clearTimeout(previous?.timer);recommendationsUI.entries.set(key,{stamp,sequence:(previous?.sequence||0)+1,pending:false,attempted:false,deferred:false,blocked:false,error:'',timer:null,polls:0});if(previous)previous.sequence++}return recommendationsUI.entries.get(key)}
function recommendationContext(report=recommendationReport()){return report?{projectId:state.project.id,reportId:report.id,stamp:recommendationStamp(report)}:null}
function recommendationCurrent(context){const r=recommendationReport();return r&&state.project.id===context.projectId&&r.id===context.reportId&&recommendationStamp(r)===context.stamp}
function recommendationRender(){if(!state.modal&&!state.composing&&!['quick-query','search-input'].includes(document.activeElement?.id)){if(typeof renderPreservingReport==='function')renderPreservingReport();else render()}}
function recommendationSaveView(context,record){
 if(!recommendationCurrent(context)||!record||record.report_id!==context.reportId)return false;
 const existing=state.project.product_recommendations||[],index=existing.findIndex(x=>x.id===record.id);
 state.project={...state.project,product_recommendations:index<0?[...existing,record]:existing.map((x,i)=>i===index?record:x)};return true;
}
async function recommendationReloadProject(context,record,entry,sequence){
 const project=await api('/api/projects/'+context.projectId);
 if(!recommendationCurrent(context)||entry.sequence!==sequence||project.id!==context.projectId||project.revision<state.project.revision)return;
 const report=(project.ai_reports||[]).find(x=>x.id===context.reportId);
 if(recommendationStamp(report)!==context.stamp)return;
 state.project=project;
 // A delayed project response must not erase the terminal record just returned by the task endpoint.
 const stored=recommendationRecord(report);if(!stored||stored.id===record.id&&stored.status==='running'){
  const records=state.project.product_recommendations||[];state.project={...state.project,product_recommendations:[...records.filter(x=>x.id!==record.id),record]};
 }
 recommendationRender();
}
function recommendationSchedule(context,entry,sequence){
 clearTimeout(entry.timer);
 if(!recommendationCurrent(context)||entry.sequence!==sequence)return;
 if(entry.polls>=200){entry.error='查询仍在后台进行，可稍后重新打开报告查看已保存结果。';recommendationRender();return}
 entry.timer=setTimeout(()=>recommendationPoll(context,entry,sequence),1800);
}
async function recommendationAccept(context,entry,sequence,record){
 if(entry.sequence!==sequence||!recommendationSaveView(context,record))return;
 entry.error='';recommendationRender();
 if(record.status==='running'){recommendationSchedule(context,entry,sequence);return}
 if(RECOMMENDATION_DONE.has(record.status))await recommendationReloadProject(context,record,entry,sequence);
}
async function recommendationPoll(context,entry,sequence){
 if(!recommendationCurrent(context)||entry.sequence!==sequence)return;
 entry.polls++;
 try{const record=await api('/api/projects/'+context.projectId+'/recommendations?report='+encodeURIComponent(context.reportId));if(!record)throw Error('暂未读到已保存的商品建议。');await recommendationAccept(context,entry,sequence,record)}
 catch(error){if(entry.sequence===sequence&&recommendationCurrent(context)){entry.blocked=true;entry.error=error.message;recommendationRender()}}
}
function recommendationWaitIdle(context,entry,sequence){
 clearTimeout(entry.timer);if(!recommendationCurrent(context)||entry.sequence!==sequence)return;
 if(entry.polls>=200){entry.blocked=true;entry.error='等待时间较长，可稍后原地重试。';entry.deferred=false;recommendationRender();return}
 entry.timer=setTimeout(async()=>{
  if(!recommendationCurrent(context)||entry.sequence!==sequence)return;entry.polls++;
  try{const status=await api('/api/recommendations/status');if(!recommendationCurrent(context)||entry.sequence!==sequence)return;
   if(status.running||status.ai_running){recommendationWaitIdle(context,entry,sequence);return}
   const project=await api('/api/projects/'+context.projectId);if(!recommendationCurrent(context)||entry.sequence!==sequence)return;
   if(project.id===context.projectId&&project.revision>=state.project.revision){state.project=project;recommendationRender()}
   entry.deferred=false;await recommendationsOnNavigation({afterAI:true,serverIdle:true});
  }catch(error){if(recommendationCurrent(context)&&entry.sequence===sequence){entry.blocked=true;entry.deferred=false;entry.error=error.message;recommendationRender()}}
 },2500);
}
async function recommendationsOnNavigation({retry=false,afterAI=false,serverIdle=false}={}){
 const report=recommendationReport();if(!report||state.project.demo)return;
 const context=recommendationContext(report),entry=recommendationEntry(report),saved=recommendationRecord(report);
 if(saved&&RECOMMENDATION_DONE.has(saved.status)&&!retry)return;
 if(entry.blocked&&!retry)return;
 if(!['success','partial','running'].includes(report.status))return;
 if(serverIdle&&report.status==='running'){entry.error='分析报告尚未保存完成，请稍后重新打开报告。';recommendationRender();return}
 if(saved?.status!=='running'&&(report.status==='running'||recommendationsUI.startingAI||!serverIdle&&activeAI())){if(!entry.deferred)entry.polls=0;entry.deferred=true;recommendationWaitIdle(context,entry,++entry.sequence);return}
 if(entry.pending)return;
 if(entry.deferred&&!afterAI&&!retry){recommendationWaitIdle(context,entry,++entry.sequence);return}
 entry.deferred=false;entry.blocked=false;entry.pending=true;entry.error='';entry.polls=0;clearTimeout(entry.timer);const sequence=++entry.sequence;
 try{
  let record=saved;
  if(!record||retry)record=await api('/api/projects/'+context.projectId+'/recommendations?report='+encodeURIComponent(context.reportId));
  if(!recommendationCurrent(context)||entry.sequence!==sequence)return;
  if(record&&record.report_id!==context.reportId)throw Error('商品建议与当前报告不匹配。');
  if(record?.status==='running'||record&&RECOMMENDATION_DONE.has(record.status)&&!retry){await recommendationAccept(context,entry,sequence,record);return}
  if(entry.attempted&&!retry){entry.error='本次请求结果尚未确认，请稍后重新打开报告，或手动重试。';recommendationRender();return}
  entry.attempted=true;
  record=await api('/api/projects/'+context.projectId+'/recommendations',{report_id:context.reportId,retry});
  await recommendationAccept(context,entry,sequence,record);
 }catch(error){if(entry.sequence===sequence&&recommendationCurrent(context)){if(error.status===409){entry.deferred=true;entry.attempted=false;entry.error='已有分析任务正在处理，完成后会继续推荐商品。';recommendationWaitIdle(context,entry,sequence)}else{entry.blocked=true;entry.error=error.message}recommendationRender()}}
 finally{if(entry.sequence===sequence)entry.pending=false}
}
function recommendationStyles(){return `
.recommendation-sheet{--rec-blue:#1765d1;border-top:1px solid #e5e9ee;border-bottom:1px solid #e5e9ee;padding:26px 0;margin:20px 0 28px}.recommendation-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:16px}.recommendation-heading h2{font-size:22px;line-height:1.5;margin:0}.recommendation-heading p,.recommendation-sheet .caption{font-size:12px;color:#78818a;line-height:1.8}.recommendation-hero{display:grid;grid-template-columns:100px minmax(0,1fr);gap:24px;margin:24px 0}.recommendation-image{width:100px;height:110px;object-fit:contain;background:#f6f7f9;border-radius:8px}.recommendation-placeholder{display:grid;place-items:center;color:#87919d;font-size:12px}.recommendation-hero h3{font-size:20px;line-height:1.6;margin:4px 0 12px;overflow-wrap:anywhere}.recommendation-kicker{font-size:11px;letter-spacing:1px;color:var(--rec-blue)}.recommendation-summary{font-size:15px;line-height:1.9;margin:12px 0;white-space:pre-wrap;overflow-wrap:anywhere}.recommendation-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 22px;margin:16px 0}.recommendation-facts dt{font-size:11px;color:#78818a;margin-bottom:5px}.recommendation-facts dd{margin:0;font-size:14px;font-weight:500;overflow-wrap:anywhere}.recommendation-facts small{display:block;font-size:11px;font-weight:400;color:#78818a;margin-top:4px}.recommendation-reasons{margin:24px 0}.recommendation-reasons>h3,.recommendation-alternatives>h3{font-size:16px;margin-bottom:12px}.recommendation-reason{padding:12px 0;border-bottom:1px solid #edf0f3}.recommendation-reason p{font-size:14px;line-height:1.9;margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}.recommendation-links{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.recommendation-links .btn{font-size:12px}.recommendation-alternative{display:grid;grid-template-columns:minmax(160px,1fr) minmax(250px,1fr);gap:20px;padding:18px 0;border-top:1px solid #e5e9ee}.recommendation-alternative h4{font-size:14px;line-height:1.7;margin:0 0 8px;overflow-wrap:anywhere}.recommendation-alternative p{font-size:13px;line-height:1.8;margin:0 0 10px}.recommendation-alternative .recommendation-facts{margin:0}.recommendation-checks{margin:24px 0;padding-left:20px;font-size:14px;line-height:1.9}.recommendation-checks li{margin-bottom:7px;overflow-wrap:anywhere}.recommendation-sheet details{border-top:1px solid #e5e9ee;padding-top:14px;margin-top:20px}.recommendation-sheet summary{font-size:13px;cursor:pointer;color:#687480}.recommendation-sheet blockquote{border-left:2px solid #ced9e8;margin:12px 0;padding:4px 16px;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.recommendation-sheet .error-inline{font-size:13px}.recommendation-source-row{margin:16px 0;padding-bottom:12px;border-bottom:1px solid #edf0f3}.recommendation-source-row h4{font-size:13px;margin:0 0 5px}.recommendation-source-row p{font-size:12px;line-height:1.9;overflow-wrap:anywhere}.report-reading-section{border-top:1px solid #e5e9ee;margin-top:26px;padding-top:18px}.report-reading-section>summary{cursor:pointer;font-size:16px;font-weight:550;padding:4px 0 16px}.report-reading-section>.report-reading-content{margin-top:14px}.recommendation-empty{padding:18px 0;line-height:1.9;color:#687480}.recommendation-query-table{overflow:auto}.recommendation-query-table table{font-size:12px;width:100%}.recommendation-sheet td,.recommendation-sheet th{padding:9px 12px;text-align:left;border-bottom:1px solid #e5e9ee}
@media(max-width:650px){.recommendation-hero{grid-template-columns:64px minmax(0,1fr);gap:14px}.recommendation-image{width:64px;height:76px}.recommendation-hero h3{font-size:17px}.recommendation-heading{flex-direction:column}.recommendation-facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.recommendation-alternative{grid-template-columns:1fr;gap:10px}.recommendation-sheet{padding:20px 0}.recommendation-summary{font-size:14px}.recommendation-heading h2{font-size:20px}}
@media print{.recommendation-hero,.recommendation-alternative{break-inside:avoid}}
`;}
function recommendationNumber(value,precision=0){return typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:precision}):'未提供'}
function recommendationUrl(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:''}catch{return ''}}
function recommendationLink(value,label='来源'){const url=recommendationUrl(value);return url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:'来源链接未提供'}
function recommendationPrice(product){return typeof product.price==='number'&&Number.isFinite(product.price)?esc(product.currency||'币种未注明')+' '+recommendationNumber(product.price,2):'未提供'}
function recommendationFacts(product){return `<dl class="recommendation-facts"><div><dt>采样价格</dt><dd>${recommendationPrice(product)}</dd></div><div><dt>评分 / 数量</dt><dd>${recommendationNumber(product.rating,1)} / ${recommendationNumber(product.review_count)}</dd></div><div><dt>销售表现</dt><dd>${esc(product.sales_raw||'未提供')}<small>${esc(product.sales_period||'周期未注明')}</small></dd></div></dl><p class="caption">${esc(product.source||'来源未注明')} · ${esc(product.collected_at?date(product.collected_at):'采集时间未注明')} · ${recommendationLink(product.source_url,'商品来源')}</p>`}
function recommendationProduct(record,id){return (record.products||[]).find(x=>x.id===id)}
function recommendationProductActions(record,product){const attrs=`data-record="${esc(record.id)}" data-product="${esc(product.id)}"`;return `<div class="recommendation-links">${button('商品资料','recommendation-product','','small',attrs)}${button('查看趋势','recommendation-trend','','small',attrs)}</div>`}
function recommendationAnchor(record,kind,id){return 'recommendation-'+[record.id,kind,id].map(value=>Array.from(String(value)).map(char=>char.codePointAt(0).toString(16)).join('-')).join('--')}
function recommendationEvidenceHtml(record,refs,{anchors=false}={}){const rows=refs?(record.evidence_snapshot||[]).filter(x=>refs.includes(x.id)):record.evidence_snapshot||[];return rows.map(x=>`<article class="recommendation-source-row">${anchors?'<div id="'+esc(recommendationAnchor(record,'evidence',x.id))+'">':'<div>'}<h4>${esc(x.id)}</h4><blockquote>${esc(x.text||'未保存原文')}</blockquote>${x.translation?`<p>中文译文：${x.translation&&esc(x.translation)}</p>`:''}<p>${esc(x.platform||x.source||'来源未注明')} · ${esc(x.market_scope||'')}${x.source_url?' · '+recommendationLink(x.source_url,'原始来源'):''}</p>${x.text_truncated?'<p class="caption">本项原文为分析时保存的截断摘录。</p>':''}</div></article>`).join('')||'<p class="caption">没有保存对应原文，暂不能提供依据。</p>'}
function recommendationSnapshotsHtml(record){return `<details data-reading-key="recommendation-${esc(record.id)}-sources"><summary>推荐时的商品与需求依据 · ${record.products?.length||0} 件商品</summary>${(record.products||[]).map(x=>`<article class="recommendation-source-row"><div id="${esc(recommendationAnchor(record,'product',x.id))}"><h4>${esc(x.id)} · ${esc(x.title)}</h4>${recommendationFacts(x)}<p>${(x.features||[]).map(esc).join('；')}</p><p>查询词：${esc(x.query||x.original_query||'未注明')} · ${esc(x.market_scope||'市场未注明')}</p></div></article>`).join('')}${recommendationEvidenceHtml(record,undefined,{anchors:true})}</details>`}
function recommendationReasonSources(record,reason,exported){const products=[...new Set(reason.product_ids||[])].filter(id=>recommendationProduct(record,id)),evidence=[...new Set(reason.evidence_ids||[])].filter(id=>(record.evidence_snapshot||[]).some(x=>x.id===id));if(exported)return `<p class="caption">${products.map((id,i)=>`<a href="#${esc(recommendationAnchor(record,'product',id))}">商品资料 ${i+1}</a>`).join(' · ')}${products.length&&evidence.length?' · ':''}${evidence.map((id,i)=>`<a href="#${esc(recommendationAnchor(record,'evidence',id))}">需求原文 ${i+1}</a>`).join(' · ')}</p>`;return `<div class="recommendation-links"><span class="caption">参考 ${products.length} 件商品</span>${evidence.length?button('查看需求依据 '+evidence.length+' 条','recommendation-evidence','','small',`data-record="${esc(record.id)}" data-refs="${esc(JSON.stringify(evidence))}"`):'<span class="caption">尚无可核对的需求原文</span>'}</div>`}
function recommendationQueriesHtml(record){return (record.queries||[]).length?`<details data-reading-key="recommendation-${esc(record.id)}-queries"><summary>查看本次商品查询 · ${record.queries.length} 项</summary><div class="recommendation-query-table"><table><tr><th>查询词 / 方向</th><th>状态</th><th>返回商品</th></tr>${record.queries.map(x=>`<tr><td>${esc(x.query)}<p class="caption">${esc(x.direction)}</p></td><td>${esc(x.status)}${x.http?' · HTTP '+Number(x.http):''}${x.error?'<p>'+esc(x.error)+'</p>':''}</td><td>${recommendationNumber(x.returned)}</td></tr>`).join('')}</table></div></details>`:''}
function recommendationHtml(report,{exported=false}={}){
 if(!report)return '';
 const record=recommendationRecord(report),entry=exported?null:recommendationsUI.entries.get(state.project.id+'/'+report.id),result=record?.result||{},product=record&&recommendationProduct(record,result.recommended_product_id),statuses={running:'正在形成商品建议',success:'已保存商品建议',no_match:'暂未找到合适商品',failed:'商品建议未完成',interrupted:'商品建议已中断'},phases={planning:'正在根据需求规划查询',querying:'正在查询商品与竞品',ranking:'正在比较商品并形成建议'};
 const header=`<div class="recommendation-heading"><div><h2>${record?esc(result.title||statuses[record.status]||'商品建议'):'优先推荐商品'}</h2><p>${record?`${esc(date(record.finished_at||record.created_at))} · 卖家精灵查询 ${recommendationNumber(record.requests)} / ${recommendationNumber(record.request_limit)} 次`:'需求报告完成后，自动查询商品并保存推荐。'}</p></div>${!exported&&(record&&['failed','interrupted','no_match'].includes(record.status)||entry?.error&&!entry.deferred)?button('原地重试','recommendation-retry','refresh','small',`data-report="${esc(report.id)}" ${entry?.pending?'disabled':''}`):''}</div>`;
 let body='';
 if(record?.status==='success'&&product){
  const image=exported?'':recommendationUrl(product.image),alternatives=(result.alternatives||[]).filter((x,i,rows)=>x.product_id!==product.id&&rows.findIndex(y=>y.product_id===x.product_id)===i&&recommendationProduct(record,x.product_id)).slice(0,2);
  body=`<div class="recommendation-hero">${image?`<img class="recommendation-image" src="${esc(image)}" alt="${esc(product.title)}" loading="lazy" referrerpolicy="no-referrer">`:'<div class="recommendation-image recommendation-placeholder">商品</div>'}<div><span class="recommendation-kicker">优先推荐 · 待验证</span><h3>${esc(result.direction||product.title)}</h3><p class="caption">${esc(product.title)}</p><p class="caption">面向：${esc(result.target)}</p>${recommendationFacts(product)}${exported?'':recommendationProductActions(record,product)}</div></div><details data-reading-key="recommendation-${esc(record.id)}-summary"><summary>推荐结论与适用范围</summary><p class="recommendation-summary">${esc(result.summary)}</p></details><section class="recommendation-reasons"><h3>为什么先看这一件</h3>${(result.reasons||[]).map((reason,i)=>`<article class="recommendation-reason"><p>${i+1}. ${esc(reason.text)}</p>${recommendationReasonSources(record,reason,exported)}</article>`).join('')}</section>${alternatives.length?`<section class="recommendation-alternatives"><h3>一起比较的备选 · ${alternatives.length} 件</h3>${alternatives.map(x=>{const alt=recommendationProduct(record,x.product_id);return `<article class="recommendation-alternative"><div><h4>${esc(alt.title)}</h4><p>${esc(x.reason)}</p>${exported?'':recommendationProductActions(record,alt)}</div><div>${recommendationFacts(alt)}</div></article>`}).join('')}</section>`:''}`;
 }else body=`<p class="recommendation-empty" role="status">${esc(record?.status==='running'?phases[record.phase]||record.message:record?.status==='no_match'?result.no_match_reason||record.message:record?.message||entry?.error||'正在准备商品推荐；已有任务完成后会自动继续。')}</p>${record?.status==='success'&&!product?'<p class="error-inline">推荐商品快照缺失，暂不显示商品结论。</p>':''}`;
 if(result.checks?.length)body+='<details data-reading-key="recommendation-'+esc(record.id)+'-checks"><summary>下单或投入前，还要验证 · '+result.checks.length+' 项</summary><ul class="recommendation-checks">'+result.checks.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></details>';
 return `<style>${recommendationStyles()}</style><section class="recommendation-sheet" data-recommendation-report="${esc(report.id)}">${header}${body}${entry?.error&&record?'<p class="error-inline">'+esc(entry.error)+'</p>':''}${record?recommendationQueriesHtml(record)+recommendationSnapshotsHtml(record):''}<p class="caption">推荐依据为本次保存的商品与需求样本；销量口径随来源保留，成本、物流、退货与利润仍需核算。</p></section>`;
}
function recommendationMarkdown(report){
 const record=recommendationRecord(report);if(!record)return '';
 const result=record.result||{},product=recommendationProduct(record,result.recommended_product_id),lines=['## 商品推荐',result.title||'',`状态：${record.status} · 保存：${record.finished_at||record.created_at}`,`卖家精灵查询：${record.requests} / ${record.request_limit}`,'',result.summary||result.no_match_reason||record.message||''];
 if(product)lines.push('### 优先推荐',product.title,'产品方向：'+(result.direction||''),'面向：'+(result.target||''));
 lines.push('### 推荐理由',...(result.reasons||[]).flatMap(x=>[x.text,'商品依据：'+(x.product_ids||[]).join('、'),'需求依据：'+(x.evidence_ids||[]).join('、')]),'### 备选',...(result.alternatives||[]).slice(0,2).map(x=>(recommendationProduct(record,x.product_id)?.title||x.product_id)+'：'+x.reason),'### 待验证',...(result.checks||[]).map(x=>'- '+x),'### 推荐时的全部商品快照');
 for(const x of record.products||[])lines.push('#### '+x.id+' · '+x.title,'价格：'+(typeof x.price==='number'?recommendationNumber(x.price,2)+' '+(x.currency||'币种未注明'):'未提供'),'评分：'+recommendationNumber(x.rating,1)+' / 数量：'+recommendationNumber(x.review_count),'销售表现：'+(x.sales_raw||'未提供')+' · '+(x.sales_period||'周期未注明'),'特点：'+(x.features||[]).join('；'),'查询词：'+(x.query||x.original_query||'未注明'),'来源：'+(x.source||'未注明')+' · '+(recommendationUrl(x.source_url)||'未提供'),'采集时间：'+(x.collected_at||'未提供'),'');
 lines.push('### 推荐时的需求依据');for(const x of record.evidence_snapshot||[])lines.push('#### '+x.id,...String(x.text||'未保存原文').split('\n').map(line=>'> '+line),'来源：'+(x.platform||x.source||'未注明')+' · '+(recommendationUrl(x.source_url)||'未提供'),...(x.translation?['中文译文：'+x.translation]:[]),...(x.text_truncated?['本项为保存的截断摘录。']:[]),'');
 lines.push('### 本次商品查询');for(const q of record.queries||[])lines.push('#### '+q.query,'方向：'+(q.direction||'未注明'),'状态：'+q.status+' · HTTP：'+(q.http??'未提供')+' · 返回商品：'+recommendationNumber(q.returned),...(q.error?['失败原因：'+q.error]:[]),'');
 return lines.join('\n');
}
async function recommendationAction(action,el){
 if(action==='recommendation-retry'){const report=recommendationReport();if(!report||report.id!==el.dataset.report)return true;await recommendationsOnNavigation({retry:true});return true}
 if(!['recommendation-product','recommendation-evidence','recommendation-trend'].includes(action))return false;
 const record=(state.project?.product_recommendations||[]).find(x=>x.id===el.dataset.record);if(!record)throw Error('这份商品建议已不在当前项目中。');
 if(action==='recommendation-evidence'){let refs;try{refs=JSON.parse(el.dataset.refs)}catch{throw Error('依据编号无效')}if(!Array.isArray(refs))throw Error('依据编号无效');modal('推荐依据 · 保存时的原文',`<style>${recommendationStyles()}</style><div class="recommendation-sheet">${recommendationEvidenceHtml(record,refs)}</div>`,button('关闭','close'),true);return true}
 const product=recommendationProduct(record,el.dataset.product);if(!product)throw Error('没有保存这件商品的快照。');
 if(action==='recommendation-trend'){openWatchModal(product);return true}
 modal('推荐商品 · 查询时的资料',`<style>${recommendationStyles()}</style><div class="recommendation-sheet"><h2>${esc(product.title)}</h2>${recommendationFacts(product)}<p>${(product.features||[]).map(esc).join('；')}</p><p class="caption">商品编号：${esc(product.id)} · ${esc(product.market_scope||'市场未注明')}</p></div>`,button('查看趋势','recommendation-trend','','',`data-record="${esc(record.id)}" data-product="${esc(product.id)}"`)+button('关闭','close','','primary'),true);return true;
}
