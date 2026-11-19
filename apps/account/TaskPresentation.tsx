import {Bot,ShieldCheck,UserRound,XCircle} from 'lucide-react';
import {z} from 'zod';

export const taskPresentation=z.object({priority:z.enum(['low','normal','high']),dependencyCount:z.number().int().min(0).max(20),
  responsibleName:z.string().nullable(),agentName:z.string().nullable(),profile:z.enum(['demo','dsh-text','codex-code']).nullable(),recoveryRequired:z.boolean(),
}).strict();
export type TaskPresentation=z.infer<typeof taskPresentation>;

export function TaskPeople({value}:{value?:TaskPresentation}){
  const person=value?value.responsibleName??'未分配':'待同步',agent=value?value.agentName??'未分配':'待同步';
  return <span className="task-people"><span className="card-person" title={'责任成员：'+person}><UserRound size={13}/><span className="person-name">{person}</span></span>
    <span className="agent-mark" title={'执行 Agent：'+agent}><Bot size={13}/><span className="agent-name">{agent}</span>{value?.profile==='demo'&&<span className="agent-provider">模拟</span>}</span></span>;
}
export function TaskAttention({status,recoveryRequired}:{status:string;recoveryRequired?:boolean}){
  if(recoveryRequired)return <span className="card-notice failed"><XCircle size={13}/>旧执行待核实 · 请执行成员核对</span>;
  if(status==='failed')return <span className="card-notice failed"><XCircle size={13}/>执行失败 · 查看原因</span>;
  if(status==='review')return <span className="card-notice review"><ShieldCheck size={13}/>待人工验收</span>;
  return null;
}
