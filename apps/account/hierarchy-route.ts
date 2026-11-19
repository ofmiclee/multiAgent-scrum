import {z} from 'zod';

export type ProjectPage='board'|'stories'|'create-story'|'execution'|'automatic'|'grants'|'agents'|'members'|'settings';
export type HierarchyRoute={organizationId:string;section:'boards'|'projects'|'members'|'info';project?:{id:string;boardId:string;page:ProjectPage;taskId?:string}}|{organizationId:null;page?:'home'|'create-project'};
const uuid=z.uuid();
const pages=new Set<ProjectPage>(['board','stories','create-story','execution','automatic','grants','agents','members','settings']);
export const projectManagementPage=(page:ProjectPage)=>['agents','members','settings','automatic','grants'].includes(page);

// null means another existing account/Runner hash; invalid hierarchy is rejected.
export function readHierarchyRoute(hash:string):HierarchyRoute|'invalid'|null{
  if(!hash.startsWith('#/'))return null;
  const parts=hash.slice(2).split('/');
  if(parts.length===1&&parts[0]==='projects')return {organizationId:null,page:'home'};
  if(parts.length===2&&parts[0]==='projects'&&parts[1]==='new')return {organizationId:null,page:'create-project'};
  if(parts[0]!=='organizations')return 'invalid';
  if(parts.length===1)return {organizationId:null};
  if(!uuid.safeParse(parts[1]).success)return 'invalid';
  if(parts.length===3&&['boards','projects','members','info'].includes(parts[2]))return {organizationId:parts[1],section:parts[2] as 'boards'|'projects'|'members'|'info'};
  if((parts.length===7||parts.length===9)&&parts[2]==='projects'&&parts[4]==='boards'&&uuid.safeParse(parts[3]).success&&uuid.safeParse(parts[5]).success&&pages.has(parts[6] as ProjectPage)){
    if(parts.length===9&&(parts[6]!=='execution'||parts[7]!=='tasks'||!uuid.safeParse(parts[8]).success))return 'invalid';
    const page=parts[6] as ProjectPage;
    return {organizationId:parts[1],section:projectManagementPage(page)?'projects':'boards',project:{id:parts[3],boardId:parts[5],page,...(parts[8]?{taskId:parts[8]}:{})}};
  }
  return 'invalid';
}

export function hierarchyHash(route:HierarchyRoute){
  if(route.organizationId===null)return route.page==='home'?'#/projects':route.page==='create-project'?'#/projects/new':'#/organizations';
  const prefix='#/organizations/'+route.organizationId;
  if(!route.project)return prefix+'/'+route.section;
  const p=route.project;
  return prefix+'/projects/'+p.id+'/boards/'+p.boardId+'/'+p.page+(p.taskId?'/tasks/'+p.taskId:'');
}

export function writeHierarchyRoute(route:HierarchyRoute,replace=false){
  const hash=hierarchyHash(route);
  if(window.location.hash===hash)return;
  window.history[replace?'replaceState':'pushState'](null,'',window.location.pathname+window.location.search+hash);
}
