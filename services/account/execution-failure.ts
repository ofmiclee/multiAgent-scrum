import type {ExecutionFailureReason} from '../../packages/domain/execution-errors.ts';

// Only fixed public diagnostics; native exception text stays on the device.
export const executionFailureIssues:Record<ExecutionFailureReason,string>={
  timeout:'执行超过时限并已停止，请检查任务范围与执行环境后人工重试。',
  execution_failed:'执行异常并已停止，请检查执行环境后人工重试。',
};
