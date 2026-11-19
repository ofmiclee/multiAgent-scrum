import {z} from 'zod';
import {publicationInput} from './task-publication-input.ts';

export const storyProposalSchema=z.object({tasks:publicationInput.shape.tasks}).strict().superRefine((proposal,ctx)=>{
  const parsed=publicationInput.safeParse({...proposal,expectedVersion:1,requestId:'00000000-0000-4000-8000-000000000000'});
  if(!parsed.success)ctx.addIssue({code:'custom',message:'Tasks must have unique keys and closed acyclic dependencies'});
});
export type StoryProposal=z.infer<typeof storyProposalSchema>;
export function parseStoryProposal(text:string):StoryProposal{
  if(new TextEncoder().encode(text).length>16000)throw Error('Proposal exceeds the text limit');
  return storyProposalSchema.parse(JSON.parse(text));
}
export const storyAssistanceViewSchema=z.object({id:z.uuid(),storyVersion:z.number().int().positive(),state:z.enum(['queued','running','draft','failed']),version:z.number().int().positive(),calls:z.number().int().min(0).max(4),stale:z.boolean(),proposal:storyProposalSchema.nullable(),issues:z.array(z.string()).max(10)}).strict();
export const storyAssistanceListSchema=z.object({jobs:z.array(storyAssistanceViewSchema).max(10)}).strict();
