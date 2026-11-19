import { setTimeout } from "node:timers/promises";
import type {
  Executor,
  ExecutionInput,
  ExecutionResult,
} from "../domain/contracts.ts";

/** Deterministic workflow simulator, not AI and never evidence of actual implementation. */
export class DemoExecutor implements Executor {
  constructor(private delayMs = 2200) {}
  async run(
    input: ExecutionInput,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    await setTimeout(this.delayMs, undefined, { signal });
    if (input.coordination) {
      const { kind, context } = input.coordination;
      const simulated =
        kind === "decompose"
          ? {
              tasks: [
                {
                  title: `模拟拆解：${context.subject.title}`.slice(0, 200),
                  description: context.subject.description,
                  acceptance: "人工核对模拟成果，不代表真实需求已实现",
                  capability: "writing",
                  priority: 2,
                  dependsOnIndexes: [],
                  reviewPolicy: "human",
                },
              ],
            }
          : kind === "assess"
            ? {
                difficulty: 2,
                risk: "low",
                confidence: 0.9,
                rationale: "模拟评估，仅验证流程，未调用真实模型",
                requiredCapability:
                  context.subject.capability === "coding"
                    ? "coding"
                    : "writing",
              }
            : {
                summary: "模拟复盘：依据项目内已有记录验证流程，未调用模型",
                lessons: ["模拟建议：保留明确验收标准，人工核对实际成果"],
              };
      return {
        summary: JSON.stringify(simulated),
        artifacts: [],
        checksPassed: false,
      };
    }
    return {
      summary: `演示执行完成：${input.title}。已生成流程验证报告，未实际编写代码或调用模型。`,
      checksPassed: false,
      artifacts: [
        {
          name: "demo-report.md",
          content: [
            `# 演示执行报告：${input.title}`,
            "",
            "> 这是模拟执行器的输出，不代表真实需求已实现，也不能作为产品验收证据。",
            "",
            `任务：${input.taskId}`,
            `执行尝试：${input.attemptId}`,
            "",
            "## 原始目标",
            input.description || "（未填写）",
            "",
            "## 待人工核对的验收标准",
            input.acceptance,
            "",
            "## 历次返工意见",
            ...input.feedback.map((f) => `- ${f}`),
            "",
            "## 本轮验证",
            "任务由服务端自动分配；执行结果已持久化；成果可由项目成员读取。",
            "尚未调用真实模型，尚未修改业务代码。",
          ].join("\n"),
        },
      ],
    };
  }
}
