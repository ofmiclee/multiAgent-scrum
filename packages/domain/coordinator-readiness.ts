import type { State, Project, CoordinatorReadiness } from './contracts.ts';
import { capacityBlocker } from './capacity.ts';
import { isProjectMember } from './access.ts';

/** Read-only snapshot, never an execution grant. Aggregate capacity before visibility filtering. */
export function coordinatorReadiness(
  s: State, p: Project, blockedAgents = new Set<string>(),
): CoordinatorReadiness {
  const blockers: CoordinatorReadiness['blockers'] = [];
  if (p.coordinationPaused) blockers.push({code:'paused',message:`项目协调已暂停：${p.coordinationPaused.reason}`,action:'resume'});
  if (!p.coordinatorAgentId) {
    blockers.push({code:'unconfigured',message:'等待 Owner 配置项目协调 Agent',action:'configure'});
  } else {
    const a=s.agents.find(a=>a.id===p.coordinatorAgentId);
    if (!a || a.ownerId!==p.ownerId || !isProjectMember(s,a.ownerId,p)) {
      blockers.push({code:'invalid_owner',message:'协调 Agent 必须属于当前项目 Owner',action:'configure'});
    } else {
      if (a.executionMode) blockers.push({code:'not_accepting',message:'独立文本执行器暂不支持项目协调',action:'configure'});
      if (!a.projectIds.includes(p.id)) blockers.push({code:'grant_revoked',message:'协调 Agent 尚未授权本项目',action:'agents'});
      if (!a.enabled) blockers.push({code:'disabled',message:'协调 Agent 未启用自动接收任务',action:'agents'});
      if (!a.online) blockers.push({code:'offline',message:'协调 Agent 不可用，请 Owner 检查运行设备与账号连接',action:'agents'});
      if (blockedAgents.has(a.id)) blockers.push({code:'not_accepting',message:'本机执行器暂不接收新工作，请 Owner 检查账号连接或停止状态',action:'agents'});
      const capacity=capacityBlocker(s,a);
      if (capacity) blockers.push({code:capacity,message:{
        recovery_required:'Owner 有旧进程尚未确认停止，协调工作等待解除隔离',
        agent_capacity:'协调 Agent 并发已满，等待当前工作结束',
        owner_capacity:'Owner 的共享并发已满，等待当前工作结束',
      }[capacity],action:capacity==='recovery_required'?'recover':'wait'});
    }
  }
  return {ready:blockers.length===0,blockers};
}
