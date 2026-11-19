import {createHash} from 'node:crypto';

type AssessmentInput={
  taskId:string;
  attemptId:string;
  fence:number;
  title:string;
  description:string;
  acceptance:string;
  feedback:string[];
};

export function typeSafeAssessmentEvidence(input:AssessmentInput){
  return {taskId:input.taskId,attemptId:input.attemptId,fence:input.fence,
    title:input.title,assessmentContext:input.description,acceptance:input.acceptance,feedback:input.feedback};
}

export function assessmentInputHash(input:AssessmentInput){
  return createHash('sha256').update(JSON.stringify(typeSafeAssessmentEvidence(input))).digest('hex');
}
