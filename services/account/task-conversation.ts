import type {Pool} from 'pg';
import type {IdentityPrincipal} from '../identity/service.ts';
import {projectTransaction,authorizeProjectContent} from './project-scope.ts';
import {conversationSnapshotSchema,taskConversationResponseSchema,taskInteractiveConversationResponseSchema,CONVERSATION_MAX_BYTES,type ConversationSnapshot} from '../../packages/domain/task-conversation.ts';
import {redactText} from '../runner/results.ts';
import {readTaskMessaging} from './task-messages.ts';

export async function readTaskConversation(pool:Pool,principal:IdentityPrincipal,projectId:string,taskId:string,messages=false){
  return projectTransaction(pool,async client=>{
    const actor=await authorizeProjectContent(client,principal.id,projectId);
    const row=(await client.query<{status:string;id:string|null;state:string;agent_name:string;live:boolean;updated_at:Date|null;snapshot:unknown;summary:string|null;finished_at:Date|null}>(`SELECT t.status,a.id,a.state,g.name AS agent_name,
      (a.state='running' AND a.lease_until>clock_timestamp() AND d.revoked_at IS NULL AND d.session_until>clock_timestamp()) IS TRUE AS live,
      a.conversation_snapshot AS snapshot,a.conversation_updated_at AS updated_at,a.report->>'summary' AS summary,a.finished_at
      FROM mas_business_task t JOIN mas_business_board b ON b.id=t.board_id AND b.project_id=t.project_id AND b.archived_at IS NULL
      LEFT JOIN mas_business_work w ON w.task_id=t.id AND w.kind='execute'
      LEFT JOIN mas_business_work_attempt a ON a.work_id=w.id AND a.fence=w.calls
      LEFT JOIN mas_business_agent g ON g.id=a.agent_id
      LEFT JOIN mas_business_runner_device d ON d.id=a.runner_id
      WHERE t.id=$1 AND t.project_id=$2`,[taskId,projectId])).rows[0];
    if(!row)throw 404;
    let snapshot:ConversationSnapshot|null=row.snapshot?conversationSnapshotSchema.parse(row.snapshot):null;
    // A final progress upload can be lost independently of the durable result.
    // Include that result even when only an empty or partial snapshot arrived.
    if(row.state==='finished'&&row.summary){
      const text=redactText(row.summary);
      if(!snapshot?.entries.some(entry=>entry.kind==='message'&&entry.text===text.slice(0,4000))){
        snapshot={revision:Math.min(Number.MAX_SAFE_INTEGER,(snapshot?.revision??0)+1),entries:[...(snapshot?.entries??[]).filter(entry=>entry.id!=='final-report'),
          {id:'final-report',kind:'message',text:text.slice(0,4000),state:'completed',at:row.finished_at?.getTime()??0}],truncated:(snapshot?.truncated??false)||text.length>4000};
        while(snapshot.entries.length>80||Buffer.byteLength(JSON.stringify(snapshot))>CONVERSATION_MAX_BYTES){snapshot.entries.shift();snapshot.truncated=true;}
      }
    }
    const result=taskConversationResponseSchema.parse({identityId:principal.id,projectId,taskId,taskStatus:row.status,
      attempt:row.id?{id:row.id,state:row.state,agentName:row.agent_name,live:row.live,
        updatedAt:(row.finished_at??row.updated_at)?.toISOString()??null,snapshot}:null});
    return messages?taskInteractiveConversationResponseSchema.parse({...result,messaging:await readTaskMessaging(client,row.id,actor.projectRole)}):result;
  });
}
