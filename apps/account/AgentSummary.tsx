import {Bot,Monitor} from 'lucide-react';
import {z} from 'zod';

export const agentReadinessSchema=z.enum(['ready','runner_revoked','runner_offline','executor_unavailable','model_unavailable']);
type Summary={name:string;profile:string;model:string|null;effectiveModel?:string|null;enabled:boolean;revoked:boolean;available:boolean;readiness:z.infer<typeof agentReadinessSchema>;deviceName:string;runnerConnected:boolean;executorReady:boolean;modelReady:boolean};
export function AgentReadinessChecks({agent}:{agent:Pick<Summary,'name'|'profile'|'enabled'|'runnerConnected'|'executorReady'|'modelReady'>}){
  const executor=agent.profile==='codex-code'?'Codex':agent.profile==='dsh-text'?'DSH':'执行器';
  return <div className="agent-readiness-tabs" role="group" aria-label={agent.name+'就绪检查'}>{[
    ['Agent',agent.enabled],['Runner',agent.runnerConnected],[executor,agent.executorReady],['模型',agent.modelReady],
  ].map(([label,ready])=><span key={String(label)} className="agent-readiness-tab" data-ready={ready?'true':'false'}><b aria-hidden="true">{ready?'✓':'×'}</b>{label}<span className="sr-only">{ready?'已就绪':'未就绪'}</span></span>)}</div>;
}
export function AgentStatus({agent}:{agent:Pick<Summary,'enabled'|'revoked'|'available'|'readiness'|'deviceName'|'profile'>}){
  const normal=agent.enabled&&!agent.revoked&&agent.available;
  const label=!agent.enabled?'未启用':normal?'正常':'未就绪';
  return <span className="agent-status" data-state={normal?'positive':!agent.enabled?'neutral':'warning'}>{label}</span>;
}
export function AgentMetadata({agent}:{agent:Summary}){
  return <div className="agent-card-meta"><span><Bot size={15}/>{agent.profile==='codex-code'?'Codex':agent.profile==='dsh-text'?'DSH':'模拟执行器'}</span><span className="agent-card-model" title={agent.model??agent.effectiveModel??'Runner 默认模型尚未确认'}>{agent.model??agent.effectiveModel??'默认模型待确认'}</span><span className="agent-card-runner"><Monitor size={14}/>{agent.deviceName}</span></div>;
}
