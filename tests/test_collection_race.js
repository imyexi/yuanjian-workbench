// Exercise the real collection poller with controlled asynchronous responses; no network or data writes.
const assert=require('node:assert/strict');
const {harness,fixture}=require('./test_workflow.js');

const copy=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function setup(){
 const h=harness(),notifications=[],scheduled=[];let renders=0;
 h.context.toast=text=>notifications.push(text);h.context.render=()=>{renders++};
 h.context.setTimeout=(callback,delay)=>{scheduled.push({callback,delay});return scheduled.length};
 h.run("collectionJob={id:'collection-a',project_id:'project-a'};quick.message='original message'");
 return {h,notifications,scheduled,renders:()=>renders};
}
function result(status='success'){return {id:'collection-a',project_id:'project-a',run:{status,kind:'posts',imported:2,errors:[]}}}
function otherProject(){return {...fixture(),id:'project-b',name:'B 项目',keyword:'blender'}}

async function projectSwitchDuringProjectRead(){
 const view=setup(),{h}=view,status=result(),response=deferred(),started=deferred(),calls=[];
 h.context.api=async url=>{
  calls.push(url);
  if(url==='/api/jobs/collection-a')return status;
  if(url==='/api/projects/project-a'){started.resolve();return response.promise}
  throw Error('Unexpected mock request: '+url);
 };
 const poll=h.run('pollCollection()');await started.promise;
 const next=otherProject();h.state.project=next;response.resolve({...fixture(),name:'A 的旧响应'});await poll;
 assert.equal(h.state.project,next,'An A project response must not replace the newly selected B project');
 assert.equal(h.run('quick.message'),'original message');assert.equal(view.renders(),0);
 assert.equal(view.notifications.length,0,'A completion must not announce itself in B');
 assert.deepEqual(calls,['/api/jobs/collection-a','/api/projects/project-a']);
}

async function projectOrJobSwitchDuringStatusRead(){
 for(const replaceJob of [false,true]){
  const view=setup(),{h}=view,response=deferred(),calls=[];
  h.context.api=url=>{calls.push(url);return response.promise};
  const poll=h.run('pollCollection()');h.state.project=otherProject();
  if(replaceJob)h.run("collectionJob={id:'collection-b',project_id:'project-b',run:{status:'running'}}");
  response.resolve(result());await poll;
  assert.equal(h.state.project.id,'project-b');
  assert.equal(h.run('collectionJob.id'),replaceJob?'collection-b':'collection-a');
  assert.deepEqual(calls,['/api/jobs/collection-a'],'An old status response must not fetch project A while B is selected');
  assert.equal(view.notifications.length,0);assert.equal(view.renders(),0);assert.equal(view.scheduled.length,0);
 }
}

async function newJobDuringProjectRead(){
 const view=setup(),{h}=view,response=deferred(),started=deferred();
 h.context.api=async url=>{if(url==='/api/jobs/collection-a')return result('running');started.resolve();return response.promise};
 const poll=h.run('pollCollection()');await started.promise;
 h.run("collectionJob={id:'collection-b',project_id:'project-a',run:{status:'running'}}");
 const original=h.state.project;response.resolve({...fixture(),revision:99});await poll;
 assert.equal(h.state.project,original,'An obsolete task must not replace a newer task result even within the same project');
 assert.equal(h.run('collectionJob.id'),'collection-b');assert.equal(view.scheduled.length,0);
}

async function completedResultsPreserveInputGuards(){
 for(const protection of ['none','modal','composing','quick-query','search-input']){
  const view=setup(),{h}=view,fresh={...fixture(),revision:9,products:[{id:'new-product',title:'新商品'}]};
  h.state.modal=protection==='modal';h.state.composing=protection==='composing';
  h.context.document.activeElement=protection.endsWith('query')||protection==='search-input'?{id:protection}:null;
  h.context.api=async url=>url==='/api/jobs/collection-a'?result():copy(fresh);
  await h.run('pollCollection()');
  assert.equal(h.state.project.revision,9);assert.equal(h.state.project.products[0].id,'new-product');
  assert.equal(h.run('collectionJob.run.status'),'success');assert.match(h.run('quick.message'),/新增 2 条/);
  assert.equal(view.notifications.length,1);assert.equal(view.scheduled.length,0);
  assert.equal(view.renders()>0,protection==='none','Modal and active text input must suppress DOM replacement: '+protection);
 }
 const view=setup(),{h}=view;
 h.context.api=async url=>url==='/api/jobs/collection-a'?result('running'):fixture();
 await h.run('pollCollection()');
 assert.equal(view.scheduled.length,1);assert.equal(view.scheduled[0].delay,1600);
 assert.equal(view.notifications.length,0);assert.equal(h.run('quick.message'),'original message');
}

async function main(){
 await projectSwitchDuringProjectRead();await projectOrJobSwitchDuringStatusRead();
 await newJobDuringProjectRead();await completedResultsPreserveInputGuards();
 console.log('Collection races: project/task ownership checked after both awaits; normal refresh, polling and input guards preserved.');
}
main().catch(error=>{console.error(error);process.exitCode=1});
