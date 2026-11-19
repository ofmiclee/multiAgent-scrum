import {z} from 'zod';

export const projectFileLimit=96*1024;
export const publicProjectConfigSchema=z.object({
  repositoryUrl:z.string().max(2048),branch:z.string().max(160),
  deployEnvironment:z.string().max(80),serverHost:z.string().max(253),
}).strict();
export const projectContextSchema=z.object({
  projectId:z.uuid(),version:z.number().int().positive(),agentsMd:z.string().max(8000),
  config:publicProjectConfigSchema,
}).strict();
export type ProjectContext=z.infer<typeof projectContextSchema>;
export const projectFilesWriteSchema=z.object({
  expectedVersion:z.number().int().nonnegative(),agentsMd:z.string().max(8000),env:z.string().max(24000),
}).strict();
export const personalProjectWriteSchema=z.object({
  runnerId:z.uuid(),directory:z.string().trim().min(2).max(1024).refine(v=>!/[\x00-\x1f]/.test(v)),
  gitUsername:z.string().trim().min(1).max(128).regex(/^[^\s:]+$/),
  gitToken:z.string().max(4096).regex(/^[^\r\n\x00]*$/).optional(),
  deploymentAccess:z.boolean().default(false),expectedVersion:z.number().int().nonnegative(),
}).strict();
export const setupStateSchema=z.enum(['queued','running','ready','failed']);
export const setupResultSchema=z.enum(['ok','local_changes','directory_exists','unsafe_path','git_failed','binding_failed','cancelled','unavailable']);
export const setupJobSchema=z.object({
  id:z.uuid(),projectId:z.uuid(),runnerId:z.uuid(),version:z.number().int().positive(),
  mode:z.enum(['initialize','sync']),agentsMd:z.string().max(8000),env:z.string().max(24000),
  config:publicProjectConfigSchema,directory:z.string().max(1024),
  gitUsername:z.string().max(128),gitToken:z.string().max(4096),
}).strict();
export type SetupJob=z.infer<typeof setupJobSchema>;
export const projectFilesViewSchema=z.object({
  version:z.number().int().nonnegative(),config:publicProjectConfigSchema.nullable(),canEdit:z.boolean(),
  personal:z.array(z.object({runnerId:z.uuid(),directory:z.string(),gitUsername:z.string(),hasGitToken:z.boolean(),deploymentAccess:z.boolean(),version:z.number().int().positive()}).strict()),
  jobs:z.array(z.object({id:z.uuid(),runnerId:z.uuid(),version:z.number().int(),state:setupStateSchema,result:setupResultSchema.nullable(),updatedAt:z.string()}).strict()),
}).strict();

/** Parse a deliberately small dotenv format as data, never source or interpolate it. */
export function parseProjectEnv(text:string):Record<string,string>{
  const values:Record<string,string>=Object.create(null);
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const match=/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if(!match||Object.hasOwn(values,match[1]))throw Error('Invalid or duplicate environment entry');
    let value=match[2];
    if(value.startsWith('"')){try{value=JSON.parse(value);}catch{throw Error('Invalid quoted value');}}
    else if(value.startsWith("'")){if(!value.endsWith("'"))throw Error('Invalid quoted value');value=value.slice(1,-1);}
    else value=value.replace(/\s+#.*$/,'').trim();
    if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid environment value');
    values[match[1]]=value;
  }
  return values;
}
// Only these public configuration keys are imported. Database/relay hosts and regions
// are deliberately not candidates for the project's deployment destination.
const configKeys={repositoryUrl:['REPO_URL','CNB_MAS_PROJECT_URL'],branch:['DEFAULT_BRANCH'],
  deployEnvironment:['DEPLOY_ENV'],serverHost:['SERVER_HOST'],deploymentTarget:['DEPLOY_TARGET'],
  cloudbaseEnvId:['CLOUDBASE_ENV_ID','TCB_ENV_ID','MAS_CLOUDBASE_ENV_ID'],cloudbaseRegion:['CLOUDBASE_REGION','TCB_REGION','MAS_CLOUDBASE_REGION']} as const;
export type ProjectConfigFields=Record<keyof typeof configKeys,string>;
export class ProjectConfigError extends Error {}
export function projectConfigFields(env:string):ProjectConfigFields{
  let values:Record<string,string>;
  try{values=parseProjectEnv(env);}catch{throw new ProjectConfigError('.deploy-access.env 格式有误，请检查引号、重复变量和每行 KEY=VALUE。');}
  const read=(field:keyof ProjectConfigFields)=>configKeys[field].map(key=>values[key]).find(value=>value!==undefined)??'';
  const cloudbaseEnvId=read('cloudbaseEnvId'),cloudbaseRegion=read('cloudbaseRegion'),serverHost=read('serverHost');
  return {repositoryUrl:read('repositoryUrl'),branch:read('branch')||'main',deployEnvironment:read('deployEnvironment'),serverHost,
    deploymentTarget:read('deploymentTarget')||(cloudbaseEnvId||cloudbaseRegion?'tcb':serverHost?'server':'none'),cloudbaseEnvId,cloudbaseRegion};
}
function validateProjectConfig(fields:ProjectConfigFields){
  const {repositoryUrl,branch,serverHost,deployEnvironment,deploymentTarget,cloudbaseEnvId,cloudbaseRegion}=fields;
  if(repositoryUrl){
    let url:URL;try{url=new URL(repositoryUrl);}catch{throw new ProjectConfigError('代码仓库地址无效，请填写不含凭据的 HTTPS 仓库地址。');}
    if(repositoryUrl.length>2048||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.hostname||url.pathname==='/'||/\s/.test(repositoryUrl))throw new ProjectConfigError('代码仓库地址无效，请填写不含凭据的 HTTPS 仓库地址。');
  }
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,159}$/.test(branch)||branch.includes('..')||branch.includes('//')||branch.endsWith('/')||branch.endsWith('.lock'))throw new ProjectConfigError('分支名称无效，请填写有效的 Git 分支名。');
  if(serverHost&&(serverHost.length>253||!/^[a-zA-Z0-9.:[\]-]+$/.test(serverHost)))throw new ProjectConfigError('服务器地址无效，请填写主机名或 IP，不包含协议和路径。');
  if(deployEnvironment.length>80||/[\x00-\x1f\x7f]/.test(deployEnvironment))throw new ProjectConfigError('部署环境无效，请使用 80 字以内的单行名称。');
  if(!['none','tcb','server'].includes(deploymentTarget))throw new ProjectConfigError('部署方式无效，请选择 TCB、服务器或暂不配置。');
  if(cloudbaseEnvId&&!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(cloudbaseEnvId))throw new ProjectConfigError('TCB 环境 ID 无效，请从云开发控制台复制环境 ID。');
  if(cloudbaseRegion&&!/^[a-z][a-z0-9-]{0,79}$/.test(cloudbaseRegion))throw new ProjectConfigError('TCB 地域无效，请填写地域标识，例如 ap-shanghai。');
}
/** Preserve unrelated values and comments; explicit form edits replace canonical keys. */
export function mergeProjectConfigEnv(env:string,fields:ProjectConfigFields){
  projectConfigFields(env);validateProjectConfig(fields);
  const entries=new Map(Object.entries(configKeys).map(([field,keys])=>[keys[0] as string,JSON.stringify(fields[field as keyof ProjectConfigFields])]));
  const aliases=new Map(Object.entries(configKeys).flatMap(([field,keys])=>keys.slice(1).map(key=>[key as string,JSON.stringify(fields[field as keyof ProjectConfigFields])] as const)));
  const lines=env.split(/\r?\n/).map(line=>{
    const key=/^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if(key&&aliases.has(key))return `${key}=${aliases.get(key)}`;
    if(!key||!entries.has(key))return line;
    const value=entries.get(key)!;entries.delete(key);return `${key}=${value}`;
  });
  if(lines.at(-1)==='')lines.pop();
  for(const [key,value] of entries)lines.push(`${key}=${value}`);
  const merged=lines.join('\n')+'\n';
  if(merged.length>24000)throw new ProjectConfigError('.deploy-access.env 超过 24000 字，请精简后保存。');
  return merged;
}
export function publicProjectConfig(env:string){
  const fields=projectConfigFields(env);validateProjectConfig(fields);
  const {repositoryUrl,branch,deployEnvironment,serverHost}=fields;
  // Keep the existing Runner/task protocol unchanged. TCB details remain in the
  // encrypted deployment file, delivered only to the explicitly authorized Runner.
  return publicProjectConfigSchema.parse({repositoryUrl,branch,deployEnvironment,serverHost});
}
export function publicProjectEnv(config:z.infer<typeof publicProjectConfigSchema>){
  return Object.entries({REPO_URL:config.repositoryUrl,DEFAULT_BRANCH:config.branch,DEPLOY_ENV:config.deployEnvironment,SERVER_HOST:config.serverHost}).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n';
}
export const defaultAgentsMd='# Project instructions\n\nRead .deploy-access.env for project context. Never commit or print credentials.\nFollow the project test and review requirements before reporting completion.\n';
export const defaultProjectEnv='DEFAULT_BRANCH=main\n';
