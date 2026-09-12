// Real navigation/render/action functions with fake HTTP and timers; never calls a provider.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {harness,fixture}=require('./test_workflow.js');
const {reportFixture}=require('./test_insight_modules.js');
const clone=x=>JSON.parse(JSON.stringify(x));
function product(id='B000000001',price=24.99){return {id,title:'Saved product '+id,asin:id,platform:'amazon',price,currency:'USD',rating:4.4,review_count:120,sales_raw:'父体月销量估算 300',sales_period:'2026-08',features:['可拆洗泵体'],source:'卖家精灵 MCP',source_url:'https://www.amazon.com/dp/'+id,image:'https://images.example.com/product.jpg',collected_at:'2026-09-12T10:00:00Z',query:'easy clean fountain',market_scope:'US'}}
function record(status='success',reportId='report-a',id='rec-a'){
 const evidence=[{id:'reviews:r1',kind:'reviews',row_id:'r1',text:'SAVED raw: hard to clean <script>bad()</script>',translation:'保存时译文',source_url:'https://example.com/original-review',platform:'reddit',text_truncated:true}];
 const summary=reportFixture(reportId).report.modules.summary.report;
 return {id,report_id:reportId,source_fingerprint:'frozen-abc',report_snapshot:{schema_version:2,report:clone(summary)},status,phase:'ranking',message:'已完成',requests:2,request_limit:2,created_at:'2026-09-12T10:00:00Z',finished_at:status==='running'?null:'2026-09-12T10:01:00Z',
 queries:[{query:'replacement pump cleaning',direction:'易清洗饮水机',status:'failed',http:429,returned:0,error:'模拟服务额度限制'}],
 products:[product(),product('B000000002',31.5),product('B000000003',null)],
 result:{title:'先验证可拆洗款',direction:'可拆洗泵体的宠物饮水机',target:'多猫家庭',summary:'优先核验清洗体验和配件成本。',recommended_product_id:status==='no_match'?'':'B000000001',
 reasons:[{text:'便于清洗，但仍需试用验证。',product_ids:['B000000001'],evidence_ids:['reviews:r1']}],alternatives:[{product_id:'B000000002',reason:'配件另售'},{product_id:'B000000003',reason:'价格尚缺'}],checks:['核算清洗和换件成本'],no_match_reason:'暂无匹配商品'},
 evidence_snapshot:evidence};
}
function project(records=[]){const p=fixture();const r=reportFixture('report-a'),source=records[0]||record();r.status='success';r.finished_at='2026-09-12T09:59:00Z';r.data_version=p.data_version;r.report.modules.summary.evidence_snapshot=clone(source.evidence_snapshot);p.ai_reports=[r];p.product_recommendations=records;p.products=[{...product(),price:9999,title:'CURRENT MUTATED PRODUCT',rating:1}];return p}
function setup(p=project()){
 const h=harness(p),timers=new Map(),calls=[];let timerId=0,responder=async()=>{throw Error('Unexpected HTTP')};
 h.context.URL=URL;
 h.context.setTimeout=fn=>{timers.set(++timerId,fn);return timerId};
 h.context.clearTimeout=id=>timers.delete(id);
 h.context.api=async(url,body)=>{calls.push({url,body:body&&clone(body)});return responder(url,body)};
 vm.runInContext(fs.readFileSync('web/recommendations.js','utf8'),h.context,{filename:'web/recommendations.js'});
 h.state.page='report';
 return {...h,calls,timers,respond(fn){responder=fn},posts(){return calls.filter(c=>c.body)},async tick(){const next=timers.entries().next().value;assert.ok(next,'expected a scheduled read');timers.delete(next[0]);await next[1]()},evalValue(name,value){h.context[name]=value}};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const busy=()=>Object.assign(Error('AI busy'),{status:409});
async function main(){
 const pure=setup(project([record()]));
 for(let i=0;i<3;i++){pure.run('recommendationHtml(selectedInsightReport())');pure.run('recommendationHtml(selectedInsightReport(),{exported:true})');pure.run('recommendationMarkdown(selectedInsightReport())');pure.run('reportWorkspace()');pure.run('fullReportHtml()')}
 assert.equal(pure.calls.length,0,'rendering and exporting never call HTTP');
 const view=pure.run('recommendationHtml(selectedInsightReport())'),exported=pure.run('recommendationHtml(selectedInsightReport(),{exported:true})'),md=pure.run('recommendationMarkdown(selectedInsightReport())');
 assert.match(view,/<h3>可拆洗泵体的宠物饮水机<\/h3>/,'Chinese direction is the primary conclusion');
 assert.match(view,/查看需求依据 1 条/);assert.match(view,/参考 1 件商品/);
 assert.doesNotMatch(view,/商品依据：B000000001/);
 assert.match(view,/USD 24.99/);assert.doesNotMatch(view,/9,999|CURRENT MUTATED PRODUCT/);
 assert.match(view,/一起比较的备选 · 2 件/);assert.match(view,/未提供/);assert.match(view,/父体月销量估算 300/);
 const anchor=pure.run("recommendationAnchor(recommendationRecord(selectedInsightReport()),'evidence','reviews:r1')");
 assert.ok(exported.includes('href="#'+anchor+'"'));
 assert.ok(exported.indexOf('<div id="'+anchor+'">')>exported.indexOf('<details'));
 assert.equal(decodeURIComponent(anchor),anchor,'fragment decoding must preserve the exact target ID');
 assert.match(exported,/https:\/\/example.com\/original-review/);assert.match(exported,/&lt;script&gt;bad/);
 assert.doesNotMatch(exported,/<button\b|data-action=|<script\b|<img\b|images.example.com/);
 assert.match(md,/SAVED raw/);assert.match(md,/保存时译文/);assert.match(md,/replacement pump cleaning/);assert.match(md,/模拟服务额度限制/);assert.match(md,/HTTP：429/);
 assert.equal(pure.run('recommendationsUI.entries.size'),0,'pure renderers do not create task state');
 await pure.run('recommendationsOnNavigation()');assert.equal(pure.calls.length,0,'saved terminal result reopens without even a POST');
 const staleCache=setup(project([record()]));staleCache.state.project.ai_reports[0].report.modules.summary.report.title='UPDATED SUMMARY';
 assert.equal(staleCache.run('recommendationRecord(selectedInsightReport())')==null,true,'same-ID report changes invalidate the saved recommendation snapshot');
 assert.match(staleCache.run('recommendationHtml(selectedInsightReport())'),/生成商品推荐/);
 assert.doesNotMatch(staleCache.run('recommendationHtml(selectedInsightReport())'),/可拆洗泵体的宠物饮水机/);
 const incomplete=setup();incomplete.state.project.ai_reports[0].report.modules.summary.status='failed';
 const incompleteHtml=incomplete.run('recommendationHtml(selectedInsightReport())');
 assert.doesNotMatch(incompleteHtml,/data-action="recommendation-start"/);assert.match(incompleteHtml,/请先完成选品建议模块/);
 const complete=pure.run('fullReportHtml()');assert.doesNotMatch(complete,/<button\b|data-action=|<script\b|<img\b/);
 assert.ok(complete.indexOf('data-recommendation-report=')<complete.indexOf('需求与选品建议</h2>'),'recommendation leads the complete report');
 assert.doesNotMatch(pure.run('reportWorkspace()'),/watch-product-direction|watch-query-products|data-page="products"/);
 const history=reportFixture('report-old'),historyRecord={...record('success','report-old','rec-old'),result:{...record().result,title:'OLD SELECTED RECOMMENDATION'}};history.status='success';history.report.title='OLD SELECTED DEMAND';history.report.modules.summary.evidence_snapshot=clone(historyRecord.evidence_snapshot);pure.state.project.ai_reports.unshift(history);pure.state.project.product_recommendations.unshift(historyRecord);
 pure.run("workflow.reportChoices[state.project.id]='report-old'");
 assert.match(pure.run('reportWorkspace()'),/OLD SELECTED RECOMMENDATION/);
 assert.match(pure.run('fullReportHtml()'),/OLD SELECTED RECOMMENDATION/);
 assert.equal(pure.run('recommendationReport().id'),'report-old');

 const first=setup(),get=deferred();first.respond(async(url,body)=>body?record('running'):get.promise);
 assert.match(first.run('recommendationHtml(selectedInsightReport())'),/data-action="recommendation-start"/);
 const opening=first.run("recommendationAction('recommendation-start',{dataset:{report:'report-a'}})");await first.run('recommendationsOnNavigation()');assert.equal(first.calls.length,1);
 get.resolve(null);await opening;assert.equal(first.posts().length,1);assert.deepEqual(first.posts()[0].body,{report_id:'report-a',retry:false});
 first.state.project.data_version=100;const doneProject=clone(first.state.project);doneProject.revision++;doneProject.product_recommendations=[record()];
 first.respond(async url=>url.includes('/recommendations?')?record():clone(doneProject));
 await first.tick();assert.equal(first.run("recommendationRecord(selectedInsightReport()).status"),'success','supplier import data_version increments do not stop the frozen-report poll');
 assert.equal(first.state.project.revision,5);
 await first.run('recommendationsOnNavigation()');assert.equal(first.posts().length,1);

 const wait=setup();let occupied=true;
 wait.respond(async(url,body)=>{if(body)throw busy();if(url==='/api/recommendations/status')return {running:occupied,ai_running:false};if(url.includes('/recommendations?'))return null;return clone(wait.state.project)});
 await wait.run('recommendationsOnNavigation()');assert.equal(wait.posts().length,1);
 await wait.tick();await wait.tick();assert.equal(wait.posts().length,1,'busy work is polled through GET, never repeated POST');
 const a=clone(wait.state.project);wait.state.project={...project(),id:'project-b'};await wait.tick();assert.equal(wait.timers.size,0);
 wait.state.project=a;await wait.run('recommendationsOnNavigation()');assert.equal(wait.timers.size,1,'returning to deferred A reconnects its read-only wait');
 occupied=false;wait.respond(async(url,body)=>body?record('running'):url==='/api/recommendations/status'?{running:false,ai_running:false}:url.includes('/recommendations?')?null:clone(wait.state.project));
 await wait.tick();assert.equal(wait.posts().length,2);assert.equal(wait.run("recommendationRecord(selectedInsightReport()).status"),'running');

 const failed=setup();failed.respond(async(url,body)=>{if(body)throw Object.assign(Error('offline'),{status:503});return null});
 await failed.run('recommendationsOnNavigation()');await failed.run('recommendationsOnNavigation()');assert.equal(failed.posts().length,1,'uncertain/failed POST is never automatically retried');
 assert.match(failed.run('recommendationHtml(selectedInsightReport())'),/原地重试/);
 for(const status of ['failed','interrupted','no_match']){
  const h=setup(project([record(status)]));h.respond(async(url,body)=>body?record('running'):record(status));
  await h.run('recommendationsOnNavigation()');assert.equal(h.posts().length,0);
  await h.run("recommendationAction('recommendation-retry',{dataset:{report:'report-a'}})");assert.equal(h.posts().length,1);assert.equal(h.posts()[0].body.retry,true);
 }
 const noMatch=setup(project([record('no_match')]));assert.match(noMatch.run('recommendationHtml(selectedInsightReport())'),/暂无匹配商品/);assert.doesNotMatch(noMatch.run('recommendationHtml(selectedInsightReport())'),/class="recommendation-hero"/);

 const switched=setup(),late=deferred();switched.respond(()=>late.promise);const pending=switched.run('recommendationsOnNavigation()');
 switched.state.project={...project(),id:'project-b'};late.resolve(null);await pending;assert.equal(switched.posts().length,0,'project switch prevents a late GET from initiating a paid request');
 const changed=setup(),oldget=deferred();changed.respond(()=>oldget.promise);const previous=changed.run('recommendationsOnNavigation()');changed.state.project.ai_reports[0].report.title='CHANGED REPORT';oldget.resolve(null);await previous;assert.equal(changed.posts().length,0);
 changed.respond(async(url,body)=>body?record('running'):null);await changed.run('recommendationsOnNavigation()');assert.equal(changed.posts().length,1,'changed same-ID report gets a fresh guarded navigation context');

 const stale=setup(project([record('running')])),reload=deferred();stale.respond(async url=>url.includes('/recommendations?')?record():reload.promise);const refreshing=stale.run('recommendationsOnNavigation()');
 await Promise.resolve();await Promise.resolve();stale.run('recommendationEntry(selectedInsightReport()).sequence++');const staleProject=project([record()]);staleProject.revision=99;staleProject.name='LATE OLD RESPONSE';reload.resolve(staleProject);await refreshing;assert.notEqual(stale.state.project.name,'LATE OLD RESPONSE','an older poll sequence cannot overwrite a retry');
 const revision=setup(project([record('running')]));revision.state.project.revision=20;revision.respond(async url=>url.includes('/recommendations?')?record():project([record()]));await revision.run('recommendationsOnNavigation()');assert.equal(revision.state.project.revision,20,'full project responses never roll revision backward');

 const modal=setup(project([record()]));let navigations=0;modal.context.goto=()=>{navigations++};
 await modal.run("recommendationAction('recommendation-product',{dataset:{record:'rec-a',product:'B000000001'}})");
 assert.match(modal.modal().html,/USD 24.99/);assert.doesNotMatch(modal.modal().html,/CURRENT MUTATED PRODUCT/);
 await modal.run("recommendationAction('recommendation-evidence',{dataset:{record:'rec-a',refs:'[\"reviews:r1\"]'}})");
 assert.match(modal.modal().html,/SAVED raw/);
 await modal.run("recommendationAction('recommendation-trend',{dataset:{record:'rec-a',product:'B000000001'}})");
 assert.match(modal.modal().html,/data-watch-modal=/);assert.equal(modal.calls.length,0);assert.equal(navigations,0);
 const token=modal.run('watch.modalView.token');modal.fields['[data-watch-modal="'+token+'"]']={};
 const historyUpdate=deferred();modal.respond(()=>historyUpdate.promise);
 const refreshingTrend=modal.run("watchAction('watch-modal-refresh',{})");assert.equal(modal.posts().length,1);assert.equal(modal.posts()[0].url,'/api/projects/project-a/product-history');
 modal.state.modal=false;const modalBefore=modal.modal();historyUpdate.resolve({...modal.state.project,revision:10});await refreshingTrend;
 assert.equal(modal.modal(),modalBefore,'finishing an explicit trend update never reopens a closed modal');

 const index=fs.readFileSync('web/index.html','utf8');
 assert.match(index,/<script src="\/recommendations.js"><\/script>/);
 const nav=setup();nav.context.ROUTE_LABELS={report:'报告与选品',research:'关键词洞察'};let count=0;nav.context.recommendationsOnNavigation=()=>{count++};nav.context.window={scrollTo(){}};
 for(const prefix of ['function routePage(', 'function goto(']){const line=index.split('\n').find(x=>x.startsWith(prefix));if(line)vm.runInContext(line,nav.context)}
 nav.run("goto('report')");nav.run('reportWorkspace()');assert.equal(count,0,'navigation and rendering do not start a recommendation');
 const ai=setup();let attemptedDuringAI=0;ai.context.goto=page=>{ai.state.page=page;ai.run('recommendationsOnNavigation()')};
 ai.respond(async(url,body)=>{if(url.endsWith('/ai'))return {id:'ai-job',project_id:ai.state.project.id,status:'running'};if(url.startsWith('/api/ai/jobs/'))return {id:'ai-job',project_id:ai.state.project.id,status:'running'};if(body&&url.endsWith('/recommendations'))attemptedDuringAI++;if(url==='/api/projects/project-a')return clone(ai.state.project);throw Error('Unexpected '+url)});
 await ai.run("startAI('insights')");assert.equal(attemptedDuringAI,0,'starting a new analysis does not auto-recommend the previous report during goto');

 // Project loading itself is guarded before navigation can auto-start a recommendation.
 const loads=setup(),aLoad=deferred(),bLoad=deferred(),started=[];
 loads.context.projectLoadSequence=0;loads.context.resumeCollection=async()=>{};loads.context.resumeAI=async()=>{};loads.context.syncQuickProject=()=>{};loads.context.checkDeviceSetup=()=>{};
 loads.context.recommendationsOnNavigation=()=>started.push(loads.state.project.id);
 vm.runInContext(index.split('\n').find(x=>x.startsWith('async function openProject(')),loads.context);
 loads.respond(url=>url.endsWith('project-a')?aLoad.promise:bLoad.promise);
 const loadA=loads.run("openProject('project-a')"),loadB=loads.run("openProject('project-b')");
 bLoad.resolve({...project(),id:'project-b'});await loadB;aLoad.resolve(project());await loadA;
 assert.equal(loads.state.project.id,'project-b');assert.deepEqual(started,[],'opening a project never starts a recommendation');
 const initList=deferred();loads.respond(url=>url==='/api/projects'?initList.promise:Promise.resolve({...project(),id:'project-c'}));
 vm.runInContext(index.split('\n').find(x=>x.startsWith('async function init(')),loads.context);
 const initializing=loads.run('init()');await loads.run("openProject('project-c')");initList.resolve([]);await initializing;
 assert.equal(loads.state.project.id,'project-c');assert.deepEqual(started,[]);
 const waitingAI=setup();waitingAI.run("workflow.aiJob={id:'busy-ai',project_id:'project-a',status:'running'}");waitingAI.respond(async()=>({running:false,ai_running:true}));
 await waitingAI.run('recommendationsOnNavigation()');const waitingProject=clone(waitingAI.state.project);waitingAI.state.project={...project(),id:'project-b'};await waitingAI.tick();
 waitingAI.state.project=waitingProject;await waitingAI.run('recommendationsOnNavigation()');assert.equal(waitingAI.timers.size,1,'returning while own analysis is still running also reconnects waiting');
 assert.match(view,/<details[^>]*><summary>推荐结论与适用范围<\/summary>/);
 assert.match(view,/<details[^>]*><summary>下单或投入前，还要验证/);

 console.log('Recommendations: pure rendering/export, saved snapshot evidence, busy queue, explicit retry, history selection, race guards, navigation and in-place modals passed.');
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1});
module.exports={setup,project,record};
