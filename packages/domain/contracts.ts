export type Status =
  | "ready"
  | "assigned"
  | "running"
  | "review"
  | "done"
  | "failed";
export type User = { id: string; name: string; maxConcurrency: number };
export type Organization = { id: string; name: string };
export type OrganizationMembership = {
  organizationId: string;
  userId: string;
  status: 'active' | 'suspended';
};
export type Project = {
  organizationId: string;
  repository?: RepositorySnapshot;
  coordinatorAgentId?: string;
  coordinationEpoch?: number;
  coordinationPaused?: { reason: string; at: string; jobId: string };
  id: string;
  name: string;
  description: string;
  ownerId: string;
  memberIds: string[];
  boardIds: string[];
  createdAt: string;
};
export type Board = { id: string; projectId: string; name: string };
export type Story = {
  id: string;
  projectId: string;
  boardId: string;
  title: string;
  description: string;
  published: boolean;
  taskIds: string[];
  createdAt: string;
};
export type Artifact = { name: string; content: string };
export type RepositorySnapshot = {
  id: string;
  commit: string;
  fileCount: number;
  createdAt: string;
};
export type CodeChanges = {
  id: string;
  repositorySnapshotId: string;
  fileCount: number;
};
export type Attempt = {
  codeContext?: {
    repositorySnapshotId: string;
    inputSnapshotId: string;
    inputRevision: number;
    dependencyAttemptIds: string[];
  };
  codeChanges?: CodeChanges;
  id: string;
  agentId: string;
  ownerId: string;
  deviceId: string;
  fence: number;
  startedAt: string;
  finishedAt?: string;
  outcome?: string;
  summary?: string;
  artifacts?: Artifact[];
  nativeSession?: { threadId: string; turnId: string };
};
export type Task = {
  inputRevision?: number;
  inputHistory?: TaskInputHistoryEntry[];
  assessmentRequired?: boolean;
  assessment?: Assessment;
  assessmentApproved?: boolean;
  id: string;
  projectId: string;
  boardId: string;
  storyId: string;
  title: string;
  description: string;
  acceptance: string;
  capability: string;
  priority: number;
  dependsOn: string[];
  status: Status;
  responsibleUserId: string | null;
  agentId: string | null;
  attempts: Attempt[];
  result: { summary: string; artifacts: Artifact[] } | null;
  error: string | null;
  feedback: string[];
  maxAttempts: number;
  reviewPolicy: "human" | "automatic";
  createdAt: string;
  updatedAt: string;
  leaseUntil?: number;
  fence?: number;
  recoveryRequired?: boolean;
};
export type TaskInputHistoryEntry = {
  revision: number;
  input: Pick<Task, "title" | "description" | "acceptance" | "capability">;
  reason: string;
  actorId: string;
  failedAssessmentJobId: string;
  replacementAssessmentJobId: string;
  revisedAt: string;
};
export type Agent = {
  executionMode?: 'remote-demo' | 'remote-dsh-text';
  remoteReadyUntil?: number;
  difficultyRange?: { min: number; max: number };
  id: string;
  name: string;
  ownerId: string;
  deviceId: string;
  provider: "demo" | "codex" | "dsh" | "claude-code";
  capabilities: string[];
  projectIds: string[];
  maxConcurrency: number;
  enabled: boolean;
  online: boolean;
};
export type WorkflowEvent = {
  id: string;
  projectId: string;
  taskId?: string;
  type: string;
  message: string;
  at: string;
};
export type State = {
  organizations: Organization[];
  organizationMemberships: OrganizationMembership[];
  coordinationJobs: CoordinationJob[];
  revision: number;
  users: User[];
  projects: Project[];
  boards: Board[];
  stories: Story[];
  tasks: Task[];
  agents: Agent[];
  events: WorkflowEvent[];
  nextFence: number;
  commands: Record<string, { hash: string; result: unknown }>;
};
export type CoordinatorReadiness = {
  ready: boolean;
  blockers: {
    code: "unconfigured" | "invalid_owner" | "grant_revoked" | "disabled" | "offline" | "paused" | "not_accepting" | "recovery_required" | "agent_capacity" | "owner_capacity";
    message: string;
    action: "configure" | "agents" | "resume" | "recover" | "wait";
  }[];
};
export type TaskDispatch = {
  ready: boolean;
  code:
    | "eligible"
    | "assessment"
    | "assessment_approval"
    | "attempt_budget"
    | "dependencies"
    | "no_granted_agent"
    | "capability"
    | "difficulty"
    | "disabled"
    | "offline"
    | "not_accepting"
    | "capacity"
    | "recovery";
  message: string;
};
export type Workspace = Omit<State, "nextFence" | "commands" | "projects"> & {
  projects: (Project & { coordinationReadiness?: CoordinatorReadiness })[];
  taskDispatch?: Record<string, TaskDispatch>;
  mode: "local-preview";
  currentUser: User;
  runtime: {
    dshAvailable?: boolean;
    codexAvailable: boolean;
    codexVersion: string | null;
    claudeCodeAvailable?: boolean;
    running: number;
  };
};
export type DraftTask = {
  title: string;
  description: string;
  acceptance: string;
  capability: "coding" | "writing";
  priority: number;
  dependsOnIndexes: number[];
  reviewPolicy: "human" | "automatic";
};
export type ExecutionMessageOutcome = 'delivered'|'rejected'|'unknown';
export type ExecutionMessageHandler = (message:{id:string;text:string})=>Promise<ExecutionMessageOutcome>;
export type ExecutionInput = {
  /** Public events only. The collector redacts complete text before bounding it. */
  onProgress?: (event: Omit<import('./task-conversation.ts').ConversationEntry, 'at'>) => void;
  onMessageReady?: (handler:ExecutionMessageHandler|null)=>void;
  purpose?: 'assess'|'decompose';
  model?: string;
  credentialId?: string;
  code?: import('./code-transfer.ts').CodeInput;
  coordination?: { kind: CoordinationKind; context: CoordinationContext };
  taskId: string;
  attemptId: string;
  fence: number;
  title: string;
  description: string;
  acceptance: string;
  feedback: string[];
  cwd: string;
};
export type ExecutionResult = {
  assessmentEvaluation?: import('./typesafe-assessment.ts').TypeSafeEvaluation;
  code?: import('./code-transfer.ts').CodeBundle;
  codeArtifact?: import('./code-result-artifacts.ts').DetachedCodeResult;
  summary: string;
  artifacts: Artifact[];
  checksPassed: boolean;
  nativeSession?: { threadId: string; turnId: string };
};
export interface Executor {
  /** Settle after teardown; throw ExecutorStopUnconfirmed if stop evidence is unavailable. */
  run(input: ExecutionInput, signal: AbortSignal): Promise<ExecutionResult>;
}
export type Assessment = {
  difficulty: number;
  risk: "low" | "medium" | "high";
  confidence: number;
  rationale: string;
  requiredCapability: "coding" | "writing";
};
export type CoordinationKind = "decompose" | "assess" | "retrospect";
export type CoordinationContext = {
  project: { id: string; name: string; description: string };
  subject: {
    id: string;
    title: string;
    description: string;
    acceptance?: string;
    capability?: string;
  };
  history: {
    id: string;
    status: Status;
    title: string;
    feedback: string[];
    summary: string;
    error: string;
  }[];
  lessons: string[];
};
export type CoordinationResult =
  | { tasks: DraftTask[] }
  | Assessment
  | { summary: string; lessons: string[] };
export type CoordinationOutputCall = {
  id: string;
  correctionOf?: string;
  attemptId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "invalid" | "valid" | "failed";
  output?: string;
  truncated?: boolean;
  issues?: string[];
  nativeSession?: Attempt["nativeSession"];
};
export type CoordinationJob = {
  supersededBy?: string;
  supersedes?: string;
  inputRevision?: number;
  outputCalls?: CoordinationOutputCall[];
  inputHash: string;
  attemptHistory: (Attempt & { epoch: number })[];
  waitingReason?: string;
  id: string;
  projectId: string;
  kind: CoordinationKind;
  subjectId: string;
  status: "queued" | "running" | "completed" | "failed";
  requestedBy: string;
  input: CoordinationContext;
  agentId: string | null;
  epoch: number;
  attempts: number;
  fence?: number;
  leaseUntil?: number;
  error?: string;
  recoveryRequired?: boolean;
  result?: CoordinationResult;
  createdAt: string;
  updatedAt: string;
};
