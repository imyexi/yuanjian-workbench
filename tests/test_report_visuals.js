// Exercise the real report renderers without HTTP, a model, or business data.
const assert = require('node:assert/strict');
const {harness, fixture} = require('./test_workflow');
const {reportFixture} = require('./test_insight_modules');
const clone = value => JSON.parse(JSON.stringify(value));
const KEYS = ['clean', 'audience', 'intent', 'comments', 'notes', 'topics', 'summary'];
const HIDDEN = ['ROW_ONLY_CLASSIFICATION_REASON', 'ROW_ONLY_CONTENT_SUGGESTION', 'ROW_ONLY_INTENT_EMOTION'];
const SOURCE = 'https://example.com/report-source';
const PRODUCT_TERMS = ['easy clean cat fountain', '饮水机 "可拆洗" & 配件'];
const decode = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
const text = html => String(html).replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const markers = value => typeof value === 'string' ? (value.startsWith('FIELD_') ? [value] : [])
  : Array.isArray(value) ? value.flatMap(markers)
  : value && typeof value === 'object' ? Object.values(value).flatMap(markers) : [];

function keywordFixture() {
  const items = Array.from({length:150}, (_, index) => ({id:'keywords:k'+(index+1), valid:true,
    theme:index < 100 ? '清洗方式' : '饮水体验', w5h1:index < 120 ? 'HOW' : 'WHAT',
    intent:'方法查找', stage:index < 90 ? 'A4' : 'A2', emotion:index < 148 ? '中性' : index === 148 ? '焦虑' : '期待',
    reason:HIDDEN[0], content_suggestion:HIDDEN[1]}));
  const snapshot = items.map((item, index) => ({id:item.id,kind:'keywords',row_id:'k'+(index+1),
    text:index === 0 ? 'SAVED_KEYWORD' : '保存时关键词 '+(index+1),platform:'xhs',text_truncated:false}));
  return {id:'visual-keyword-report',kind:'keywords',status:'success',data_version:2,
    scope:{processed:150,total:150,truncated:0,text_truncated:0,evidence_ids:snapshot.map(row=>row.id)},evidence_snapshot:snapshot,
    report:{title:'关键词概览',summary:'先检查清洗方式的需求，再研究饮水体验。',items,
      stats:{total:150,valid:150,invalid:0,topic_count:2,longtail_count:0,how_pct:80,
        w5h1:[{name:'HOW',count:120},{name:'WHAT',count:30}],
        journey:[{name:'A4',count:90},{name:'A2',count:60}],
        emotion:[{name:'中性',count:148},{name:'焦虑',count:1},{name:'期待',count:1}]},
      findings:[{text:'先验证清洗体验。',evidence_ids:['keywords:k1']}],
      next_steps:[{text:'采集清洗相关原话。',evidence_ids:['keywords:k1']}]}};
}

function projectFixture() {
  const project=fixture(), keyword=keywordFixture(), insights=reportFixture('visual-insight-report');
  const clean=insights.report.modules.clean;
  clean.report.items=clone(keyword.report.items);
  clean.report.stats=clone(keyword.report.stats);
  clean.scope=clone(keyword.scope);
  clean.evidence_snapshot=clone(keyword.evidence_snapshot);
  insights.report.modules.intent.report.items[0].emotion=HIDDEN[2];
  insights.report.modules.summary.report.product_directions=[{
    name:'FIELD_PRODUCT_DIRECTION',target:'FIELD_PRODUCT_TARGET',
    problem:{text:'FIELD_PRODUCT_PROBLEM',basis:'evidence',evidence_ids:['keywords:k1'],validation:'FIELD_PRODUCT_PROBLEM_CHECK'},
    differentiation:{text:'FIELD_PRODUCT_DIFFERENCE',basis:'inference',evidence_ids:['keywords:k1'],validation:'FIELD_PRODUCT_DIFFERENCE_CHECK'},
    search_terms:PRODUCT_TERMS,checks:['FIELD_CHECK_FILTER_PRICE','FIELD_CHECK_CLEANABILITY'],evidence_ids:['keywords:k1']
  }];
  // Only an unchanged source row may contribute a live URL to an older snapshot.
  project.keywords=keyword.evidence_snapshot.map((row,index)=>({id:row.row_id,
    text:index === 0 ? row.text : 'CURRENT_CHANGED_'+row.row_id,platform:'xhs',
    source_url:index === 0 ? SOURCE : 'https://example.com/changed-source'}));
  project.posts[0].body='CURRENT_CHANGED_POST';
  project.reviews=[];
  project.ai_reports=[keyword,insights];
  return project;
}

function assertNoIndividualClassifications(html, where) {
  assert.doesNotMatch(html,/逐词分类|逐词内容建议|逐词阶段与情绪|查看逐词分析/,where+' still exposes the removed per-keyword analysis');
  for(const marker of HIDDEN) assert.ok(!html.includes(marker),where+' leaked a backend-only item field: '+marker);
}

function assertStandalone(html) {
  assert.match(html,/^<!doctype html>/i);
  assert.match(html,/<style>[^]*<\/style>/,'standalone reports carry their own styles');
  assert.doesNotMatch(html,/<link\b[^>]*rel=["']?stylesheet|<script\b|@import\b/i,'opening an export does not depend on a remote CSS or JS resource');
  assert.doesNotMatch(html,/<button\b|data-action=/,'exported controls do not pretend to call the live workbench');
  assert.match(html,/<details\b/,'evidence remains collapsed and expandable in the standalone HTML');
  assert.match(html,/<summary\b/);
}

function assertChartsKeepTheirStyles(screen, exported) {
  // Assert only the public visual node classes, rather than a snapshot of all markup.
  const css=exported.match(/<style>([^]*)<\/style>/)?.[1] || '';
  const visualClasses=[...screen.matchAll(/class="([^"]+)"/g)].flatMap(match=>match[1].split(/\s+/))
    .filter(name=>/distribution|emotion|persona|report-metric/.test(name));
  assert.ok(visualClasses.length,'the report actually contains visual structures');
  for(const name of new Set(visualClasses)) {
    assert.ok(exported.includes(name),'standalone HTML lost visual structure '+name);
    assert.ok(css.includes('.'+name),'standalone HTML omitted styles for '+name);
  }
}

async function main() {
  const sample=projectFixture(),view=harness(sample);
  const keyword=view.run("keywordReportBody(latestAI('keywords'))");
  const insight=view.run("insightReportBody(latestAI('insights'))");
  assertNoIndividualClassifications(keyword,'keyword screen');
  assertNoIndividualClassifications(insight,'insight screen');
  assert.match(keyword,/先检查清洗方式/);
  assert.match(keyword,/150/);
  assert.match(insight,/模型推断/);
  assert.match(insight,/付费证据 · 待验证/,'unknown payment evidence is not converted to a zero score');
  assert.doesNotMatch(insight,/付费证据 · 0/);
  assert.doesNotMatch(insight,/CURRENT_CHANGED_/,'historical evidence must not switch to the edited project records');
  const cleanTree=view.run("JSON.stringify(insightModuleNodes('clean',latestAI('insights').report.modules.clean.report,insightModuleContext(latestAI('insights'),'clean')))");
  const personaTree=view.run("JSON.stringify(insightModuleNodes('audience',latestAI('insights').report.modules.audience.report,insightModuleContext(latestAI('insights'),'audience')))");
  assert.match(cleanTree,/"type":"distribution"/,'keyword classifications feed aggregate charts');
  assert.match(cleanTree,/"type":"metrics"/,'sample totals use the shared report metrics');
  assert.match(personaTree,/"type":"persona"/,'complete personas have a dedicated visual structure');
  const productTree=view.run("JSON.stringify(insightModuleNodes('summary',latestAI('insights').report.modules.summary.report,insightModuleContext(latestAI('insights'),'summary')))");
  assert.match(productTree,/"type":"products"/,'product directions use the shared report tree');
  const productButton=[...insight.matchAll(/<button\b[^>]*>/g)].find(match=>match[0].includes('data-action="watch-product-direction"'))?.[0];
  assert.ok(productButton,'a product hypothesis exposes the next product-research action');
  assert.equal(decode(productButton.match(/data-query="([^"]*)"/)?.[1]),PRODUCT_TERMS.join('\n'),'the action carries every suggested term, including Chinese and quoted text');
  assert.match(insight,/建议检索词（AI 构造）/,'suggested product queries are not presented as collected evidence');

  await view.run("workflowAction('export-ai-html',{dataset:{kind:'keywords',report:'visual-keyword-report'}})");
  const keywordExport=view.downloads.at(-1).body;
  await view.run("workflowAction('export-ai-html',{dataset:{kind:'insights',report:'visual-insight-report'}})");
  const insightExport=view.downloads.at(-1).body;
  for(const [name,html] of [['keyword HTML',keywordExport],['insight HTML',insightExport]]) {
    assertStandalone(html);
    assertNoIndividualClassifications(html,name);
    assert.match(html,/SAVED_KEYWORD/,'raw source words remain available after hiding per-word analysis');
    assert.ok(html.includes(SOURCE),'source links remain readable outside the workbench');
    assert.ok(!html.includes('https://example.com/changed-source'),'changed records cannot lend their URLs to unrelated historical evidence');
    assert.doesNotMatch(html,/CURRENT_CHANGED_/,'standalone evidence is read from its report snapshot');
  }
  assertChartsKeepTheirStyles(insight,insightExport);

  const markdown=view.run("reportMarkdown(latestAI('insights'))");
  assertNoIndividualClassifications(markdown,'insight Markdown');
  const saved=sample.ai_reports[1];
  for(const key of KEYS) {
    const anchor='id="insight-visual-insight-report-'+key+'"';
    assert.equal(insight.split(anchor).length-1,1,'screen keeps exactly one '+key+' chapter');
    assert.equal(insightExport.split(anchor).length-1,1,'export keeps exactly one '+key+' chapter');
    assert.ok(markdown.includes(saved.report.modules[key].report.title),'Markdown preserves '+key);
    for(const field of markers(saved.report.modules[key].report)) {
      assert.ok(insight.includes(field),'screen omitted '+key+' field: '+field);
      assert.ok(insightExport.includes(field),'HTML omitted '+key+' field: '+field);
      assert.ok(markdown.includes(field),'Markdown omitted '+key+' field: '+field);
    }
  }
  assert.match(insightExport,/SAVED_REVIEW/);
  assert.match(insightExport,/SAVED_POST_BODY/);
  for(const term of PRODUCT_TERMS) {
    assert.ok(decode(insightExport).includes(term),'HTML omitted product search term '+term);
    assert.ok(markdown.includes(term),'Markdown omitted product search term '+term);
  }

  const full=view.run('fullReportHtml()');
  assertStandalone(full);
  assertNoIndividualClassifications(full,'complete project report');
  assert.match(full,/SAVED_POST_BODY/);
  assert.match(full,/CURRENT_CHANGED_POST/,'complete export distinguishes the latest project material from its older report evidence');

  // Distribution percentages describe recorded samples, never people or market size.
  assert.equal(view.run('typeof reportDistribution'),'function');
  const emotion=view.run("reportDistribution([{name:'中性',count:148},{name:'焦虑',count:1},{name:'期待',count:1}],{style:'emotion',total:150,label:'样本情绪分布'})");
  assert.match(text(emotion),/中性/);
  assert.match(emotion,/data-total="150"/);
  assert.match(emotion,/<span data-count="148">[^]*?中性[^]*?98\.7%/,'148 of 150 neutral keywords are reported as 98.7% of this sample');
  const widths=[...emotion.matchAll(/<i style="width:([\d.]+)%/g)].map(match=>Number(match[1]));
  assert.equal(widths.length,3,'all three observed emotions have a segment');
  assert.ok(Math.abs(widths[0]-148/150*100)<0.01,'the large neutral segment uses its real sample fraction');
  assert.ok(widths[1]<1&&widths[2]<1,'rare emotions are not visually inflated into equal categories');
  for(const number of ['148','150']) assert.ok(text(emotion).includes(number),'emotion distribution omitted its real '+number+' sample count');
  assert.doesNotMatch(text(emotion),/33\.3\s*%|98\.?\d*\s*%\s*(用户|人群|消费者)/,'categories cannot be rendered as equal slices or inferred population shares');
  assert.doesNotMatch(emotion,/NaN|Infinity/);

  for(const style of ['bars','emotion']) {
    const zero=view.run(`reportDistribution([{name:'零样本',count:0}],{style:'${style}',total:0,label:'已确认零条'})`);
    const missing=view.run(`reportDistribution([{name:'未采样项',count:null}],{style:'${style}',label:'缺失样本'})`);
    const empty=view.run(`reportDistribution([],{style:'${style}',total:0,label:'空样本'})`);
    assert.match(text(zero),/0|零/,'a known zero count remains distinguishable');
    assert.match(text(missing),/未|暂无|缺|不足|待/,'unknown counts must be identified as unavailable');
    assert.doesNotMatch(text(missing),/未采样项\s*0(?:\s|条|个|$)/,'null must not become an invented zero');
    assert.match(text(empty),/未|暂无|缺|不足|0|零/);
    for(const html of [zero,missing,empty]) assert.doesNotMatch(html,/NaN|Infinity/);
  }
  view.context.emptyKeyword={id:'empty-keywords',kind:'keywords',status:'success',scope:{processed:0,total:0,evidence_ids:[]},report:{title:'尚无样本',summary:'等待采集',items:[],findings:[],next_steps:[]}};
  const emptyKeyword=view.run('keywordReportBody(emptyKeyword)');
  assert.match(emptyKeyword,/等待采集/);
  assert.doesNotMatch(emptyKeyword,/NaN|Infinity|ROW_ONLY_|CURRENT_CHANGED_/,'an empty report never borrows numbers or source rows from the displayed project');
  const unsafe=view.run(`reportDistribution([{name:'<img src=x onerror=alert(1)>',count:2},{name:'负值',count:-7},{name:'非数字',count:'"><svg onload=alert(1)>'}],{style:'bars',total:2,label:'<script>alert(1)</script>'})`);
  assert.doesNotMatch(unsafe,/<script\b|<img\b|<svg[^>]*onload|NaN|Infinity|width:\s*-/i,'untrusted report labels and counts cannot create markup or invalid geometry');
  assert.match(unsafe,/&lt;img/,'labels remain readable as escaped text');
  assert.equal(view.calls.length,0,'rendering and exporting existing reports do not collect data or call AI');
  console.log('Report visuals: hidden per-word analysis, accurate sample distributions, complete personas and seven chapters, self-contained HTML, collapsible source snapshots and no external calls passed.');
}

if(require.main===module) main().catch(error=>{console.error(error);process.exitCode=1});
module.exports={keywordFixture,projectFixture};
