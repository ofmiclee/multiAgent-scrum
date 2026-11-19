// Isolated browser-test backend. Never imported by the application or release.
import {createServer} from 'vite';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';

if (process.env.MAS_NAVIGATION_FIXTURE !== '1') throw Error('Set MAS_NAVIGATION_FIXTURE=1 to start the isolated UI fixture.');
const identityId = '11111111-1111-4111-8111-111111111111';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = {id: identityId, name: '测试成员'};
let personalProfile,profileAvatar,agentRoutes;
let organizations, projects, agents, invitations, signedIn, requests, failCreate, failGroup, coordinators, devices, orgMembers, projectMembers, inviteLinks, stories, tasks, bodyImages, creationReceipts, projectFiles, directoryPicks;
function reset(mode = 'multiple') {
  user.name='测试成员';personalProfile={...user,image:mode==='github-profile'?'https://avatars.githubusercontent.com/u/123?v=4':null,signature:'',version:0};profileAvatar=null;
  signedIn = mode !== 'signed-out'; requests = []; failCreate = false; failGroup = mode === 'partial-error';
  organizations = [
    {id: id(1), name: 'product-team', alias: '产品研发', description: '产品需求与研发协作', role: 'owner', slug: 'product-team', version: 1, image:null},
    {id: id(2), name: 'design-team', alias: '设计团队', description: '跨项目设计与交付', role: 'member', slug: 'design-team', version: 1, image:null},
  ].slice(0, mode === 'empty' ? 0 : mode === 'single' ? 1 : 2);
  projects = organizations.flatMap((org, index) => [{id: id(11 + index), organizationId: org.id, name: index ? '设计系统' : '协作工作台', key: index ? 'DESIGN' : 'SCRUM', description: index ? '共享组件与交互规范' : '需求、任务与执行验收', version: 1, role: index ? 'member' : 'owner', defaultBoardId: id(21 + index)}]);
  agents = [{id: id(31), name: '我的文档助手', instructions: '整理项目文档', model: null, effectiveModel:'deepseek-v4-flash', runnerId: id(41), deviceName: '测试电脑', profile: 'dsh-text', credentialId:'legacy',credentialLabel:'本机 DSH API Key',credentialKind:'api-key', enabled: true, version: 1, maxConcurrency: 1, revoked: false, runnerConnected:true,executorReady:true,modelReady:true,available: true, readiness:'ready', projectGrants: []}];
  agents.push({...agents[0],id:id(32),name:'我的代码助手',profile:'codex-code',credentialLabel:'本机 Codex 账号',credentialKind:'subscription',model:'gpt-5.6-terra',effectiveModel:'gpt-5.6-terra'}, {...agents[0],id:id(33),name:'未启用助手',enabled:false});
  agentRoutes=Object.fromEntries(agents.map(a=>[a.id,{id:a.id,difficultyMin:1,difficultyMax:5,preference:'balanced',relativeCost:2,version:1,history:{accepted:0,rejected:0},lastDecision:null}]));
  devices=mode==='no-runner'?[]:[{runnerId:id(41),name:'测试电脑',online:mode!=='offline-runner',lastSeen:Date.now(),revoked:false,executionReady:false}];
  projectFiles={version:1,agentsMd:'# 项目规范\n',env:'REPO_URL=https://cnb.cool/pomona/demo\nDEFAULT_BRANCH=main\nDEPLOY_ENV=production\nSERVER_HOST=10.0.0.8\n',personal:{}};
  if(mode==='unconfigured-project')Object.assign(projectFiles,{version:0,agentsMd:'',env:''});
  directoryPicks={};
  coordinators = {};
  const joinedAt='2026-09-20T00:00:00.000Z';
  orgMembers=[{...user,role:'owner',status:'active',version:1,joinedAt,invitedBy:null},{id:id(61),name:'设计同事',role:'member',status:'active',version:1,joinedAt,invitedBy:'测试成员'},{id:id(62),name:'研发同事',role:'member',status:'active',version:1,joinedAt,invitedBy:null}];
  projectMembers=[{...user,role:'owner',status:'active',version:1,joinedAt}];
  if(mode==='viewer'){projects[0].role='viewer';projectMembers[0].role='viewer';}
  inviteLinks={};
  stories=[];tasks=[];bodyImages={};creationReceipts={};
  invitations = [{id: id(51), organizationId: id(3), organizationName: 'research-team', expiresAt: '2027-01-01T00:00:00.000Z'}];
}
reset();
const server = await createServer({configFile: 'vite.account.config.ts', server: {host: '127.0.0.1', port: Number(process.env.MAS_NAVIGATION_PORT || 5197), strictPort: true}, plugins: [{name: 'isolated-navigation-fixture', configureServer(vite) {
  vite.middlewares.use(async (req, res, next) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (!path.startsWith('/api/') && !path.startsWith('/__fixture/')) return next();
    const send = (value, status = 200) => {res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('X-MAS-Identity', identityId); res.end(JSON.stringify(value));};
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (path === '/__fixture/reset') {reset(body.mode); return send({ok: true});}
      if (path === '/__fixture/state') return send({organizations, projects, agents, requests, coordinators});
      if (path === '/__fixture/coordinator-conflict') {coordinators[id(11)] = {agentId:id(32),version:2,available:true,paused:false,pauseReason:null};return send({ok:true});}
      if (path === '/__fixture/runner-ready') {devices=[{runnerId:id(41),name:'测试电脑',online:true,lastSeen:Date.now(),revoked:false,executionReady:false}];return send({ok:true});}
      if (path === '/__fixture/agent-offline') {agents[0].available=false;agents[0].runnerConnected=false;agents[0].executorReady=false;agents[0].readiness='runner_offline';return send({ok:true});}
      if (path === '/__fixture/agent-executor-unavailable') {agents[1].available=false;agents[1].executorReady=false;agents[1].readiness='executor_unavailable';return send({ok:true});}
      if (path === '/__fixture/fail-create') {failCreate = true; return send({ok: true});}
      if (path === '/api/identity/options') return send({registration: false, passwordReset: false, delivery: 'disabled',githubLogin:true});
      if (path === '/api/identity/github/start') return send({url:'https://github.com/login/oauth/authorize?client_id=fixture'});
      if (path === '/api/identity/sign-in/email') {signedIn = true; return send({ok: true});}
      if (!signedIn) return send({error: 'Unauthorized'}, 401);
      if (path === '/api/identity/session') return send({user:personalProfile});
      if (path === '/api/identity/sign-out') {signedIn = false; return send({ok: true});}
      requests.push({path, method: req.method, body});
      if(path==='/api/account/profile'){
        if(req.method==='POST'){
          if(body.version!==personalProfile.version)return send({error:'Conflict'},409);
          personalProfile={...personalProfile,name:body.name.trim(),signature:body.signature.trim(),version:personalProfile.version+1};user.name=personalProfile.name;
          if(body.avatar)profileAvatar=Buffer.from(body.avatar,'base64');
          if(profileAvatar)personalProfile.image='/api/account/profile/avatar/'+personalProfile.version;
        }
        return send({user:personalProfile});
      }
      if(path===personalProfile.image&&profileAvatar){res.setHeader('Content-Type','image/png');res.end(profileAvatar);return;}
      if (path === '/api/account/me') return send({user, organizations});
      const linkCreate=path.match(/^\/api\/account\/organizations\/([^/]+)\/invite-links$/);
      if(linkCreate){const link={id:randomUUID(),expiresAt:new Date(Date.now()+body.hours*3600000).toISOString(),maxUses:body.maxUses,approvalRequired:linkCreate[1]===id(2)};inviteLinks[body.token]={...link,organizationName:linkCreate[1]===id(2)?'design-team':'product-team'};return send({link});}
      if(path==='/api/account/invitation-links/inspect'){const link=inviteLinks[body.token]??{organizationName:'邀请测试组织',approvalRequired:true,expiresAt:'2027-01-01T00:00:00.000Z'};return send({invitation:{organizationName:link.organizationName,inviterName:'邀请人',expiresAt:link.expiresAt,approvalRequired:link.approvalRequired,remaining:1,status:'available'}});}
      if(path==='/api/account/invitation-links/accept')return send({status:inviteLinks[body.token]?.approvalRequired===false?'joined':'pending'});
      if(/\/organizations\/[^/]+\/members\/add$/.test(path)){orgMembers.push({id:randomUUID(),name:body.email.split('@')[0],role:'member',status:'active',version:1,joinedAt:new Date().toISOString(),invitedBy:user.name});return send({ok:true});}
      if (path === '/api/account/organizations' && req.method === 'POST') {
        const organization = {id: randomUUID(), name: body.name, alias: body.alias, description: body.description, slug: body.name, role: 'owner', version: 1, image:null};
        organizations.push(organization); return send({organization});
      }
      const orgProjects = path.match(/^\/api\/account\/organizations\/([^/]+)\/projects$/);
      if (orgProjects) {
        if (failGroup && orgProjects[1] === id(2)) return send({error: 'Unavailable'}, 503);
        if (req.method === 'POST') {
          if (failCreate) {failCreate = false; return send({error: 'Unavailable'}, 503);}
          const project = {id: randomUUID(), organizationId: orgProjects[1], name: body.name, key: body.key, description: body.description, version: 1, role: 'owner', defaultBoardId: randomUUID()};
          projects.push(project); return send({project, boards: [{id: project.defaultBoardId, name: '默认看板', isDefault: true}]});
        }
        return send({projects: projects.filter(p => p.organizationId === orgProjects[1])});
      }
      const org = path.match(/^\/api\/account\/organizations\/([^/]+)(?:\/(members|invitations|join-requests))?$/);
      if (org) {
        if (org[2] === 'members') {
          if(req.method==='POST'){const member=orgMembers.find(m=>m.id===body.userId);member.status=body.status;member.version++;return send({member:{id:member.id,role:member.role,status:member.status,version:member.version}});}
          return send({members:orgMembers});
        }
        if (org[2] === 'invitations') return send({invitations: []});
        if (org[2] === 'join-requests') return send({requests: []});
        return send({organization: organizations.find(item => item.id === org[1])});
      }
      if (path === '/api/account/invitations') return send({invitations});
      if (/\/invitations\/[^/]+\/accept$/.test(path)) {
        const organization = {id: id(3), name: 'research-team', alias: '研究团队', description: '', slug: 'research-team', role: 'member', version: 1, image:null};
        organizations.push(organization); invitations = []; return send({organization});
      }
      if (path === '/api/account/organization-join-requests') return send({request: {id: randomUUID(), organizationId: id(3), userId: identityId, status: 'pending', createdAt: new Date().toISOString(), decidedAt: null}});
      if (path === '/api/account/execution-settings') return send({identityId, settings: {maxConcurrency: 1, version: 1}});
      if (path === '/api/account/agent-routing') return send({identityId, agents: Object.values(agentRoutes)});
      if (path === '/api/account/runner-credentials') return send({identityId,credentials:[{runnerId:id(41),id:'legacy',profile:'dsh-text',kind:'api-key',label:'本机 DSH API Key',ready:true},{runnerId:id(41),id:'legacy',profile:'codex-code',kind:'subscription',label:'本机 Codex 账号',ready:true},{runnerId:id(41),id:id(91),profile:'codex-code',kind:'api-key',label:'工作账号',ready:true}]});
      if (path === '/api/account/execution-recovery') return send({identityId, attempts: [], hasMore: false});
      if (path === '/api/account/agent-models') return send({identityId, models:[
        {vendor:'deepseek',profile:'dsh-text',model:'deepseek-v4-flash',displayName:'DeepSeek V4 Flash',difficultyMin:1,difficultyMax:3,relativeCost:1,isDefault:false},
        {vendor:'deepseek',profile:'dsh-text',model:'deepseek-v4-pro',displayName:'DeepSeek V4 Pro',difficultyMin:1,difficultyMax:5,relativeCost:2,isDefault:true},
        {vendor:'openai',profile:'codex-code',model:'gpt-6-astra',displayName:'6 Astra',difficultyMin:1,difficultyMax:5,relativeCost:3,isDefault:false},
        {vendor:'openai',profile:'codex-code',model:'gpt-6-sol',displayName:'6 Sol',difficultyMin:1,difficultyMax:5,relativeCost:2,isDefault:false},
        {vendor:'openai',profile:'codex-code',model:'gpt-5.6-sol',displayName:'5.6 Sol',difficultyMin:1,difficultyMax:5,relativeCost:2,isDefault:false},
        {vendor:'openai',profile:'codex-code',model:'gpt-5.6-terra',displayName:'5.6 Terra',difficultyMin:1,difficultyMax:4,relativeCost:2,isDefault:true},
        {vendor:'openai',profile:'codex-code',model:'gpt-6-luna',displayName:'6 Luna',difficultyMin:1,difficultyMax:3,relativeCost:1,isDefault:false},
        {vendor:'openai',profile:'codex-code',model:'gpt-5.6-luna',displayName:'5.6 Luna',difficultyMin:1,difficultyMax:3,relativeCost:1,isDefault:false},
        {vendor:'openai',profile:'codex-code',model:'gpt-5.5',displayName:'5.5',difficultyMin:1,difficultyMax:5,relativeCost:2,isDefault:false},
      ]});
      if (path === '/api/account/devices') return send({identityId, devices});
      if (path === '/api/account/device-launches' && req.method === 'GET') return send({error:'Not found'},404);
      if (path === '/api/account/agent-settings') {
        for(const change of body.agents??[]){const agent=agents.find(a=>a.id===change.id);if(!agent||agent.version!==change.expectedVersion||change.routing&&agentRoutes[agent.id].version!==change.routing.expectedVersion)return send({error:'Conflict'},409);if(change.routing){const {expectedVersion,...route}=change.routing;Object.assign(agentRoutes[agent.id],route,{version:expectedVersion+1});}if(change.credentialId)Object.assign(agent,{credentialId:change.credentialId,credentialLabel:'工作账号',credentialKind:'api-key'});Object.assign(agent,{enabled:change.enabled,...('model' in change?{model:change.model,effectiveModel:change.model??'deepseek-v4-flash'}:{}),version:agent.version+1});}
        return send({identityId,saved:true});
      }
      if (path === '/api/account/agents') {
        if (req.method === 'POST') {
          const agentId = randomUUID(); agents.push({...agents[0], id: agentId, name: body.name, instructions: body.instructions, projectGrants: []});
          agentRoutes[agentId]={...agentRoutes[id(31)],id:agentId,version:1};
          return send({identityId, agentId});
        }
        return send({identityId, agents});
      }
      const personalAgentDelete=path.match(/^\/api\/account\/agents\/([^/]+)$/);
      if(personalAgentDelete&&req.method==='DELETE'){
        const index=agents.findIndex(agent=>agent.id===personalAgentDelete[1]);
        if(index<0)return send({error:'Not found'},404);
        agents.splice(index,1);delete agentRoutes[personalAgentDelete[1]];return send({identityId,deleted:true});
      }
      const projectPath = path.match(/^\/api\/account\/projects\/([^/]+)(.*)$/);
      if (projectPath) {
        const project = projects.find(p => p.id === projectPath[1]);
        if (!project) return send({error: 'Forbidden'}, 403);
        const suffix = projectPath[2], board = {id: project.defaultBoardId, name: '默认看板', isDefault: true};
        if (!suffix) return send({project, boards: [board]});
        if(suffix==='/files/directory-pick'&&req.method==='POST'){
          const pickId=randomUUID();directoryPicks[pickId]={id:pickId,state:'selected',directory:'/Users/tester/work/chosen-folder'};return send({id:pickId});
        }
        if(suffix.startsWith('/files/directory-pick/'))return send(directoryPicks[suffix.split('/').at(-1)]??{error:'Not found'},directoryPicks[suffix.split('/').at(-1)]?200:404);
        if (suffix === '/files') {
          if(req.method==='POST'){if(project.role!=='owner'||body.expectedVersion!==projectFiles.version)return send({error:'Conflict'},409);Object.assign(projectFiles,{agentsMd:body.agentsMd,env:body.env,version:projectFiles.version+1});return send({ok:true,version:projectFiles.version});}
          const values=parseEnv(projectFiles.env);
          return send({version:projectFiles.version,config:projectFiles.version?{repositoryUrl:values.REPO_URL??'',branch:values.DEFAULT_BRANCH||'main',deployEnvironment:values.DEPLOY_ENV??'',serverHost:values.SERVER_HOST??''}:null,canEdit:project.role==='owner',personal:Object.values(projectFiles.personal),jobs:[]});
        }
        if (suffix === '/files/editor') return send({version:projectFiles.version,agentsMd:projectFiles.agentsMd,env:projectFiles.env});
        if (suffix === '/files/personal') {const previous=projectFiles.personal[body.runnerId];projectFiles.personal[body.runnerId]={runnerId:body.runnerId,directory:body.directory,gitUsername:body.gitUsername,hasGitToken:!!body.gitToken||!!previous?.hasGitToken,deploymentAccess:!!body.deploymentAccess,version:(previous?.version??0)+1};return send({ok:true});}
        if (suffix === '/files/initialize'||suffix === '/files/sync') return send({ok:true});
        if (suffix === '/boards') return send({projectId: project.id, defaultBoardId: board.id, boards: [{...board, archived: false}]});
        if(suffix==='/body-images'&&req.method==='POST'){bodyImages[body.id]=body.data;return send({url:'/api/account/projects/'+project.id+'/body-images/'+body.id});}
        if(suffix.startsWith('/body-images/')){const bytes=bodyImages[suffix.split('/').at(-1)];if(!bytes)return send({error:'Not found'},404);res.setHeader('Content-Type','image/png');return res.end(Buffer.from(bytes,'base64'));}
        if (suffix === '/tasks'||/^\/boards\/[^/]+\/tasks\/[^/]+$/.test(suffix)) return send({identityId, projectId: project.id, tasks: tasks.filter(t=>t.boardId===board.id&&(suffix==='/tasks'||suffix.endsWith(t.id))), hasMore: false, nextCursor: null});
        if(suffix===`/boards/${board.id}/tasks`&&req.method==='POST'){
          if(project.role==='viewer')return send({error:'Forbidden'},403);
          if(creationReceipts[body.requestId])return send(creationReceipts[body.requestId]);
          const task={id:randomUUID(),boardId:board.id,title:'',objective:body.body,acceptanceCriteria:'人工验收',requiredCapabilities:[],status:'pending',assessment:null,execution:null};tasks.push(task);
          return send(creationReceipts[body.requestId]={taskId:task.id});
        }
        if (suffix.endsWith('/stories')) {
          if(req.method==='POST'){
            if(project.role==='viewer')return send({error:'Forbidden'},403);
            if(creationReceipts[body.requestId])return send(creationReceipts[body.requestId]);
            const story={id:randomUUID(),projectId:project.id,boardId:board.id,title:body.title,body:body.body,version:1,authorId:identityId,number:stories.length+1,reference:project.key+'-'+(stories.length+1)};stories.push(story);
            return send(creationReceipts[body.requestId]={story});
          }
          return send({stories:stories.filter(s=>s.projectId===project.id)});
        }
        const storyDetail=suffix.match(/^\/stories\/([^/]+)(\/revisions)?$/);
        if(storyDetail){const story=stories.find(s=>s.id===storyDetail[1]);if(!story)return send({error:'Not found'},404);
          if(storyDetail[2])return send({revisions:[{title:story.title,body:story.body,version:story.version,authorId:identityId}]});
          if(req.method==='POST')Object.assign(story,{title:body.title,body:body.body,version:story.version+1});return send({story});
        }
        if (suffix === '/settings') {
          if(req.method==='POST'){if(body.expectedVersion!==project.version)return send({error:'Conflict'},409);Object.assign(project,{name:body.name,description:body.description,version:project.version+1});}
          return send({project: {id: project.id, name: project.name, key: project.key, description: project.description, version: project.version}});
        }
        if (suffix === '/members') {
          if(req.method==='POST'){let member=projectMembers.find(m=>m.id===body.userId);if(!member){const orgMember=orgMembers.find(m=>m.id===body.userId);member={id:orgMember.id,name:orgMember.name,role:body.role,status:'active',version:0,joinedAt:new Date().toISOString()};projectMembers.push(member);}Object.assign(member,{status:body.status,role:body.role??member.role,version:member.version+1});return send({member});}
          return send({members:projectMembers});
        }
        if (suffix === '/coordinator/agents') return send({identityId,projectId:project.id,ownerName:project.role==='owner'?user.name:'设计项目创建者',agents:agents.map(({id,name,profile,enabled,revoked,model,effectiveModel,deviceName,runnerConnected,executorReady,modelReady,available,readiness})=>({id,name:project.role==='owner'?name:'创建者的'+name,profile,enabled,revoked,model,effectiveModel,deviceName,runnerConnected,executorReady,modelReady,available,readiness}))});
        if (suffix === '/coordinator') {
          const current=coordinators[project.id]??{agentId:null,version:0,available:false,paused:false,pauseReason:null};
          if(req.method==='POST') {
            if(project.role!=='owner')return send({error:'Forbidden'},403);
            if(body.expectedVersion!==current.version)return send({error:'Conflict'},409);
            const agent=agents.find(a=>a.id===body.agentId);
            if(!agent?.enabled||agent.revoked)return send({error:'Forbidden'},403);
            agent.projectGrants=[{projectId:project.id,enabled:true,version:1}];
            coordinators[project.id]={...current,agentId:agent.id,version:current.version+1,available:true};
          }
          return send({identityId,coordinator:coordinators[project.id]??current});
        }
        if (suffix === '/agents') return send({identityId, projectId: project.id, agents: agents.map(a => ({id: a.id, name: a.name, profile: a.profile, model: a.model, enabled: a.enabled, ownerId: identityId, ownerName: user.name, granted: !!a.projectGrants.find(g => g.projectId === project.id)?.enabled, grantVersion: 1}))});
        if (suffix === '/agent-grants') {
          if (req.method === 'POST') {
            const agent = agents.find(a => a.id === body.agentId);
            if (!agent) return send({error: 'Forbidden'}, 403);
            agent.projectGrants = [{projectId: project.id, enabled: body.enabled, version: 1}];
            return send({identityId, version: 1});
          }
          return send({identityId, agents});
        }
      }
      return send({error: 'Unimplemented fixture: ' + path}, 404);
    } catch (error) {console.error(error); send({error: 'Fixture failure'}, 500);}
  });
}}]});
await server.listen();
server.printUrls();
