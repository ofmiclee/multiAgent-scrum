import {z} from 'zod';

export const executionFailureReasonSchema=z.enum(['timeout','execution_failed']);
export type ExecutionFailureReason=z.infer<typeof executionFailureReasonSchema>;

/** Fixed diagnostic only: native error text and credentials never enter receipts. */
export class ExecutorTimeout extends Error {
  constructor(){super('Native execution timed out');this.name='ExecutorTimeout';}
}

/** Rejection is NOT stop evidence in this case. Retain durable Owner quarantine. */
export class ExecutorStopUnconfirmed extends Error {
  constructor() {super('执行器停止尚未确认，请核实旧进程后恢复');}
}
