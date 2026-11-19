import type { Agent, State } from "./contracts.ts";

/** All execution kinds share the same member and Agent reservation budget. */
export function capacityBlocker(
  s: State,
  a: Agent,
  stoppingOwners = new Set<string>(),
): "recovery_required" | "agent_capacity" | "owner_capacity" | undefined {
  const tasks = s.tasks.filter(
    (t) => t.status === "assigned" || t.status === "running",
  );
  const jobs = (s.coordinationJobs ?? []).filter((j) => j.status === "running");
  const ownerOf = (agentId: string | null) =>
    s.agents.find((x) => x.id === agentId)?.ownerId;
  if (
    stoppingOwners.has(a.ownerId) ||
    s.tasks.some(
      (t) => t.recoveryRequired && t.responsibleUserId === a.ownerId,
    ) ||
    (s.coordinationJobs ?? []).some(
      (j) => j.recoveryRequired && ownerOf(j.agentId) === a.ownerId,
    )
  )
    return "recovery_required";
  if (
    !(tasks.filter((t) => t.agentId === a.id).length +
      jobs.filter((j) => j.agentId === a.id).length < a.maxConcurrency)
  ) return "agent_capacity";
  if (
    !(tasks.filter((t) => t.responsibleUserId === a.ownerId).length +
      jobs.filter((j) => ownerOf(j.agentId) === a.ownerId).length <
      (s.users.find((u) => u.id === a.ownerId)?.maxConcurrency ?? 0))
  ) return "owner_capacity";
  return undefined;
}

export function hasCapacity(s: State, a: Agent, stoppingOwners = new Set<string>()) {
  return capacityBlocker(s, a, stoppingOwners) === undefined;
}
