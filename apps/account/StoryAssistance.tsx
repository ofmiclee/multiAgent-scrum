import HelpTip from './HelpTip';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError} from './account-api';
import {storyAssistanceListSchema,storyProposalSchema,type StoryProposal} from '../../services/account/story-assistance-input';

type Job=z.infer<typeof storyAssistanceListSchema>['jobs'][number];
function failureMessage(job:Job){
  if(job.issues.includes('Coordinator stopped; inspect the account and runtime before retrying'))return '协调执行已中断。请在“项目协调Agent”检查账号与 Runner；若已暂停，恢复项目协调后重新拆分。';
  if(job.issues.includes('Return only valid task proposal JSON with unique keys and acyclic dependencies'))return '返回的任务格式未通过校验，自动修正后仍未成功。请重新拆分。';
  if(job.issues.includes('Story changed or correction deadline exhausted'))return '故事已变化或拆分已超时。请核对当前故事后重新拆分。';
  return '拆分未完成。请检查项目协调 Agent 与 Runner 后重试。';
}
export default function StoryAssistance({projectId,storyId,storyVersion,disabled,canAutoApply,currentProposal,onApply}:{projectId:string;storyId:string;storyVersion:number;disabled:boolean;canAutoApply:boolean;currentProposal:unknown;onApply:(proposal:StoryProposal)=>void}){
  const path='/projects/'+projectId+'/stories/'+storyId+'/assistance';
  const [jobs,setJobs]=useState<Job[]>([]),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<Job|null>(null);
  const alive=useRef(true),request=useRef<{requestId:string;expectedVersion:number}|null>(null),readSequence=useRef(0);
  async function load(){
    const sequence=++readSequence.current;
    try{const result=await accountRequest(path,storyAssistanceListSchema);if(alive.current&&sequence===readSequence.current)setJobs(result.jobs);}
    catch{/* Manual editing remains available when AI assistance is offline. */}
  }
  useEffect(()=>{alive.current=true;void load();const timer=setInterval(()=>void load(),3000);return()=>{alive.current=false;++readSequence.current;clearInterval(timer);};},[path]);
  const active=jobs.some(job=>['queued','running'].includes(job.state));
  const latest=jobs.find(job=>!job.stale&&job.storyVersion===storyVersion);
  function apply(job:Job){
    if(!job.proposal)return;
    setSelected(job);onApply(job.proposal);setNotice('');
  }
  useEffect(()=>{
    if(!disabled&&canAutoApply&&latest?.state==='draft'&&latest.proposal&&selected?.id!==latest.id)apply(latest);
  },[disabled,canAutoApply,latest,selected?.id,onApply]);
  async function generate(){
    if(busy||disabled||active)return;request.current??={requestId:crypto.randomUUID(),expectedVersion:storyVersion};
    setBusy(true);setNotice('');
    try{await accountRequest(path,z.object({jobId:z.uuid()}).strict(),{body:request.current});request.current=null;if(alive.current){setNotice('');await load();}}
    catch(error){if(alive.current){
      if(error instanceof AccountRequestError&&error.status===409){request.current=null;setNotice('未能开始拆分。请确认故事版本未变化、没有正在进行的拆分，并在“项目协调Agent”确认已授权且未暂停。');await load();}
      else setNotice('AI 拆分暂不可用。可以稍后重试，也可以继续手工拆分。');
    }}finally{if(alive.current)setBusy(false);}
  }
  async function save(){
    if(!selected||busy||disabled)return;
    const proposal=storyProposalSchema.safeParse(currentProposal);
    if(!proposal.success){setNotice('请补齐任务信息并检查依赖后再保存草稿。');return;}
    setBusy(true);setNotice('');
    try{
      const result=await accountRequest(path+'/'+selected.id,z.object({version:z.number().int().positive()}).strict(),{body:{expectedVersion:selected.version,proposal:proposal.data}});
      if(alive.current){setSelected({...selected,version:result.version,proposal:proposal.data});setNotice('拆分草稿已保存。');await load();}
    }catch(error){if(alive.current)setNotice(error instanceof AccountRequestError&&error.status===409?'故事或草稿已变化，当前编辑已保留，请核对最新版本。':'保存结果未能确认，请重试保存相同草稿。');}
    finally{if(alive.current)setBusy(false);}
  }
  const visibleJob=latest??jobs[0];
  const status=notice||(visibleJob?.stale?'故事已更新，请重新拆分':visibleJob?.state==='queued'?'等待协调 Agent…':visibleJob?.state==='running'?'正在拆分，完成后将显示任务。':visibleJob?.state==='failed'?failureMessage(visibleJob):'');
  return <section aria-label="AI 故事拆分" className="publication-assistance">
    <div className="publication-assistance-actions">
      <button className="secondary-button" type="button" disabled={disabled||busy||active} onClick={()=>void generate()}>{active?'拆分中…':busy?'处理中…':jobs.length?'重新拆分':'开始拆分'}</button>
      {visibleJob?.proposal&&visibleJob.state==='draft'&&!visibleJob.stale&&visibleJob.storyVersion===storyVersion&&selected?.id!==visibleJob.id&&!canAutoApply&&<button className="text-button" type="button" disabled={disabled||busy} onClick={()=>{if(window.confirm('采用此草稿将替换下方正在编辑的任务，是否继续？'))apply(visibleJob);}}>采用 AI 草稿</button>}
      {selected&&<button className="text-button" type="button" disabled={disabled||busy} onClick={()=>void save()}>保存草稿</button>}
      <HelpTip label="拆分说明">使用项目 Owner 的协调 Agent，可能消耗该账号额度。生成结果由你编辑并确认发布。</HelpTip>
    </div>
    {status&&<p role="status" className="field-hint">{status}</p>}
  </section>;
}
