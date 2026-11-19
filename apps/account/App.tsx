import RequiredMark from './RequiredMark';
import './members.css';
import HelpTip from './HelpTip';
import {lazy, Suspense, useEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowLeft, ArrowRight, BookOpen, Check, Layers3, LoaderCircle, Mail, Plus, UserRound} from './Icons';
import {takeLifecycleLink, type LifecycleLink} from './lifecycle-link';
import {organizationSchema} from './hierarchy';
import OrganizationInfo,{JoinOrganization} from './OrganizationInfo';
import OrganizationAvatar from './OrganizationAvatar';
import ProjectHome, {CreateProject, ProjectSwitcher, useProjectDirectory, type Project} from './ProjectHome';
import ProfileMenu from './ProfileMenu';
import PersonalProfileDialog from './PersonalProfile';
import Devices from './Devices';
import Agents from './Agents';
import {InvitationInbox} from './Members';
import Members from './OrganizationMembers';
import {JoinInvitation,invitationToken,rememberInvitationReturn,restoreInvitationReturn,clearInvitationReturn} from './InvitationLink';
import {accountRequest,AccountRequestError} from './account-api';
import {z} from 'zod';
import GitHubMark from './GitHubMark';
import {Bot,FolderKanban,Monitor} from 'lucide-react';
import {runnerReturnId as readRunnerReturnId} from './runner-return';
import {readAgentReturn,clearAgentReturns,agentDraftId} from './agent-return';
import {PageIdentity,readPageState,writePageState,clearPageState,usePageState,usePageRef,DraftStorageNotice} from './page-state';
import {readHierarchyRoute,writeHierarchyRoute} from './hierarchy-route';

type View = 'login' | 'signup' | 'resend' | 'recover';
const Projects=lazy(()=>import('./Projects'));
type User = {id: string; name: string; image?:string|null};
type Organization = z.infer<typeof organizationSchema>;
type Options = {registration: boolean; passwordReset: boolean; delivery: 'disabled' | 'local' | 'email';githubLogin?:boolean};
type Notice = {kind: 'error' | 'success'; text: string} | null;
type OrganizationSection='boards'|'projects'|'members'|'info';
class ApiError extends Error {constructor(public status: number) {super('Account request failed');}}
const accountSchema=z.object({user:z.object({id:z.uuid(),name:z.string()}).strict().nullable(),organizations:z.array(organizationSchema)}).strict();

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) throw new ApiError(response.status);
  return await response.json() as T;
}

export default function App({initialLink = null,githubFailed=false}: {initialLink?: LifecycleLink;githubFailed?:boolean}) {
  const [view, setView] = useState<View>('login');
  const [link, setLink] = useState(initialLink);
  const [joinToken,setJoinToken]=useState(restoreInvitationReturn);
  const [options, setOptions] = useState<Options | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profileIdentity,setProfileIdentity]=useState<string|null>(null);
  useEffect(()=>setProfileIdentity(null),[user?.id]);
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [selectedOrganization,setSelectedOrganization]=useState<Organization|null>(null);
  const [organizationSection,setOrganizationSection]=useState<OrganizationSection>('boards');
  const [workspaceView,setWorkspaceView]=useState<'home'|'create-project'|'organizations'>('home');
  const [activeProjectId,setActiveProjectId]=useState<string|null>(null);
  const [organizationTab,setOrganizationTab]=useState<'joined'|'join'|'invitations'>('joined');
  const directory=useProjectDirectory(organizations,user?.id??null);
  const [projectNavigation,setProjectNavigation]=useState<HTMLDivElement|null>(null);
  const [boardEntry,setBoardEntry]=useState(0);
  const [runnerReturnId,setRunnerReturnId]=useState(()=>readRunnerReturnId(window.location.hash));
  const [showDevices,setShowDevices]=useState(()=>window.location.hash==='#devices'||!!readRunnerReturnId(window.location.hash));
  const [showAgents,setShowAgents]=useState(false);
  const [loading, setLoading] = useState(true);
  const [formBusy, setBusy] = useState(false);
  const [githubPending, setGithubPending] = useState(false);
  const busy = formBusy || githubPending;
  const [notice, setNotice] = useState<Notice>(githubFailed?{kind:'error',text:'GitHub 登录未完成。请重新点击下方 GitHub 按钮；若仍失败，请联系管理员检查授权配置与服务端网络。'}:null);
  const [optionsUnavailable, setOptionsUnavailable] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [organizationName, setOrganizationName] = usePageState('organization.create.name',z.string().max(120),'',user?.id??null);
  const [organizationAlias,setOrganizationAlias]=usePageState('organization.create.alias',z.string().max(50),'',user?.id??null);
  const [organizationDescription,setOrganizationDescription]=usePageState('organization.create.description',z.string().max(200),'',user?.id??null);
  const [showOrganizationForm, setShowOrganizationForm] = useState(false);
  const organizationCreateButton = useRef<HTMLButtonElement>(null);
  const organizationRequest = usePageRef('organization.create.pending',z.object({name:z.string().max(50),alias:z.string().max(50),description:z.string().max(200),requestId:z.uuid()}).nullable(),null,user?.id??null);
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLElement>(null);
  const identityGeneration=useRef(0),identityId=useRef<string|null>(null),organizationReadGeneration=useRef(0);
  const restoredIdentity=useRef<string|null>(null);
  const [projectReturnEntry,setProjectReturnEntry]=useState(0);

  function routeRunnerReturn(owner:string|null){
    if(!readRunnerReturnId(window.location.hash)&&!agentDraftId(window.location.hash)&&!['#agents','#devices'].includes(window.location.hash))return;
    const returned=readRunnerReturnId(window.location.hash)??agentDraftId(window.location.hash);
    setSelectedOrganization(null);setActiveProjectId(null);
    const inline=!!agentDraftId(window.location.hash)||!!(owner&&returned&&readAgentReturn(owner,returned));
    const agents=inline||window.location.hash==='#agents';
    setRunnerReturnId(inline?returned:readRunnerReturnId(window.location.hash));setShowDevices(!inline&&(!!readRunnerReturnId(window.location.hash)||window.location.hash==='#devices'));setShowAgents(agents);
  }

  async function loadOrganizations(restoreRoute=false) {
    const expectedIdentity=identityId.current,expectedIdentityGeneration=identityGeneration.current;
    if(!expectedIdentity)return;
    const generation=++organizationReadGeneration.current;
    const account=await accountRequest('/me',accountSchema,{expectedIdentity}).catch(error=>{
      if(error instanceof AccountRequestError&&error.status===401&&identityGeneration.current===expectedIdentityGeneration&&identityId.current===expectedIdentity&&organizationReadGeneration.current===generation){
        ++identityGeneration.current;identityId.current=null;restoredIdentity.current=null;
        setUser(null);setOrganizations(null);setSelectedOrganization(null);setShowAgents(false);setShowDevices(false);
      }
      throw error;
    });
    if(identityGeneration.current!==expectedIdentityGeneration||identityId.current!==expectedIdentity||organizationReadGeneration.current!==generation)return;
    setOrganizations(account.organizations);
    const route=restoreRoute?readHierarchyRoute(window.location.hash):null;
    if(route){
      restoredIdentity.current=expectedIdentity;setShowAgents(false);setShowDevices(false);setShowOrganizationForm(false);setNotice(null);
      const organization=route!=='invalid'&&route.organizationId?account.organizations.find(item=>item.id===route.organizationId):null;
      setSelectedOrganization(organization??null);
      setActiveProjectId(route!=='invalid'&&route.organizationId?route.project?.id??null:null);
      setWorkspaceView(route!=='invalid'&&route.organizationId===null?route.page??'organizations':'home');
      if(route==='invalid'||route.organizationId&&!organization){setNotice({kind:'error',text:'组织或项目路径不可用，或当前账号无权访问。草稿仍保留在本机。'});return;}
      if(route.organizationId){
        setOrganizationSection(route.project?.page==='execution'&&!route.project.taskId?'projects':route.section);
        const scope='projects.'+route.organizationId;
        if(route.project){
          const p=route.project;
          writePageState(expectedIdentity,scope+'.selected',p.id);writePageState(expectedIdentity,scope+'.board',p.boardId);
          const coordination=p.page==='automatic'||p.page==='execution'&&!p.taskId;
          writePageState(expectedIdentity,scope+'.subview',p.page==='grants'||coordination?'agents':['agents','members','settings'].includes(p.page)?p.page:'board');
          writePageState(expectedIdentity,'project.'+p.id+'.coordinator-tab',coordination?'records':'agents');
          writePageState(expectedIdentity,scope+'.agents',null);
          writePageState(expectedIdentity,'project.'+p.id+'.page',p.page==='automatic'?'execution':['stories','create-story','execution'].includes(p.page)?p.page:'board');
          if(p.page==='execution'||p.page==='automatic'){
            const saved=readPageState(expectedIdentity,'project.'+p.id+'.task',z.object({taskId:z.uuid(),pages:z.array(z.string()).max(100)}).nullable(),null);
            writePageState(expectedIdentity,'project.'+p.id+'.task',p.taskId?{taskId:p.taskId,pages:saved?.taskId===p.taskId?saved.pages:[]}:null);
          }
        }else if(route.section==='boards'||route.section==='projects'){
          writePageState(expectedIdentity,scope+'.selected',null);setSelectedOrganization(null);setWorkspaceView('home');
          writeHierarchyRoute({organizationId:null,page:'home'},true);
        }
      }
      setProjectReturnEntry(value=>value+1);return;
    }
    if(restoredIdentity.current!==expectedIdentity){
      restoredIdentity.current=expectedIdentity;
      if(!window.location.hash){setSelectedOrganization(null);setActiveProjectId(null);setWorkspaceView('home');setShowAgents(false);setShowDevices(false);}
    }
  }

  useEffect(()=>{
    if(!user||loading||organizations===null||restoredIdentity.current!==user.id)return;
    writePageState(user.id,'workspace',{organizationId:selectedOrganization?.id??null,section:organizationSection,
      page:showDevices?'devices':showAgents?'agents':'workspace',creatingOrganization:showOrganizationForm});
  },[user,loading,organizations,selectedOrganization,organizationSection,showDevices,showAgents,showOrganizationForm]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const results = await Promise.allSettled([
        request<Options>('/api/identity/options'), request<{user: User}>('/api/identity/session'),
      ]);
      if (!active) return;
      if (results[0].status === 'fulfilled') setOptions(results[0].value);
      else setOptionsUnavailable(true);
      const session = results[1];
      if (session.status === 'fulfilled') {
        ++identityGeneration.current;identityId.current=session.value.user.id;setUser(session.value.user);
        routeRunnerReturn(session.value.user.id);
        try {
          await loadOrganizations(true);
        } catch {if (active) setNotice({kind: 'error', text: '组织信息暂时无法加载，请重试。'});}
      } else if (!(session.reason instanceof ApiError && session.reason.status === 401)) {
        setNotice({kind: 'error', text: '暂时无法恢复登录状态，请检查连接后重试登录。'});
      }
      if (active) setLoading(false);
    })();
    return () => {active = false;};
  }, []);

  useEffect(() => {
    const consume = (event:Event) => {
      const invited=invitationToken();setJoinToken(invited);if(invited)return;
      // Email links scrub their hash in the first event. Do not reinterpret the
      // following hashchange as Back to the original bare workspace entry.
      if(!window.location.hash&&event.type!=='popstate')return;
      if(!window.location.hash||readHierarchyRoute(window.location.hash)){
        if(!window.location.hash)writeHierarchyRoute({organizationId:null,page:'home'},true);
        setSelectedOrganization(null);setNotice(null);
        void loadOrganizations(true).catch(()=>setNotice({kind:'error',text:'组织信息暂时无法加载，请重试。'}));return;
      }
      const returned=readRunnerReturnId(window.location.hash);
      if(returned||agentDraftId(window.location.hash)||window.location.hash==='#devices'||window.location.hash==='#agents'){
        routeRunnerReturn(identityId.current);
        return;
      }
      const next = takeLifecycleLink(window.location, window.history);
      if (next) {setLink(next); setPassword(''); setConfirmation(''); setNotice(null);}
    };
    window.addEventListener('hashchange', consume);
    window.addEventListener('popstate', consume);
    return () => {window.removeEventListener('hashchange', consume);window.removeEventListener('popstate', consume);};
  }, []);

  function navigate(next: View) {
    setView(next); setLink(null); setNotice(null); setPassword(''); setConfirmation('');
    requestAnimationFrame(() => heading.current?.focus());
  }

  async function githubLogin(){
    if(busy)return;
    setGithubPending(true);setNotice(null);
    try{
      const response=await request<{url:string}>('/api/identity/github/start',{}),url=new URL(response.url);
      if(url.origin!=='https://github.com'||url.pathname!=='/login/oauth/authorize'||url.username||url.password)throw Error();
      rememberInvitationReturn();
      window.location.assign(url.href);
    }catch{setGithubPending(false);setNotice({kind:'error',text:'暂时无法开始 GitHub 登录，请稍后重试。'});}
  }

  const isReset = link?.kind === 'reset-password';
  const isVerify = link?.kind === 'verify-email';
  const lifecycleAvailable = options !== null && options.delivery !== 'disabled';
  const unavailable = isReset || view === 'recover' ? !options?.passwordReset
    : isVerify || view === 'resend' ? !lifecycleAvailable
    : view === 'signup' ? !options?.registration : false;
  const passwordMismatch = confirmation !== '' && password !== confirmation;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || unavailable) return;
    if ((view === 'signup' || isReset) && password !== confirmation) {
      setNotice({kind: 'error', text: '两次输入的密码不一致。'}); return;
    }
    setBusy(true); setNotice(null);
    try {
      if (link?.kind === 'verify-email') {
        await request('/api/identity/verify-email', {token: link.token});
        setLink(null); setView('login');
        setNotice({kind: 'success', text: '邮箱验证成功。请使用邮箱和密码登录。'});
      } else if (link?.kind === 'reset-password') {
        await request('/api/identity/reset-password', {token: link.token, newPassword: password});
        setLink(null);++identityGeneration.current;identityId.current=null;setUser(null); setOrganizations(null); setSelectedOrganization(null); setView('login');
        setNotice({kind: 'success', text: '密码已更新，原有登录已失效。请使用新密码登录。'});
      } else if (view === 'login') {
        await request('/api/identity/sign-in/email', {email: email.trim(), password, rememberMe});
        const session = await request<{user: User}>('/api/identity/session');
        ++identityGeneration.current;identityId.current=session.user.id;setUser(session.user); setOrganizations(null); setSelectedOrganization(null);setOrganizationSection('boards');
        if(!readRunnerReturnId(window.location.hash)&&!agentDraftId(window.location.hash)&&!invitationToken())writeHierarchyRoute({organizationId:null,page:'home'},true);
        routeRunnerReturn(session.user.id);
        try {await loadOrganizations(true);}
        catch {setNotice({kind: 'error', text: '登录成功，组织信息暂时无法加载，请重试。'});}
      } else if (view === 'signup') {
        await request('/api/identity/sign-up/email', {name: name.trim(), email: email.trim(), password});
        setView('resend');
        setNotice({kind: 'success', text: '注册请求已受理。若账号符合条件且邮件服务可用，将收到验证说明；如未收到，请稍后重试或联系管理员。完成验证后才能登录。'});
      } else if (view === 'resend') {
        await request('/api/identity/send-verification-email', {email: email.trim()});
        setNotice({kind: 'success', text: '验证请求已受理。若账号符合条件且邮件服务可用，将收到验证说明；如未收到，请稍后重试或联系管理员。'});
      } else {
        await request('/api/identity/request-password-reset', {email: email.trim()});
        setNotice({kind: 'success', text: '密码重置请求已受理。若账号符合条件且邮件服务可用，将收到重置说明；如未收到，请稍后重试或联系管理员。'});
      }
      setPassword(''); setConfirmation('');
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const text = status === 429 ? '操作过于频繁，请稍后再试。'
        : status === 0 || status >= 500 ? '服务暂时不可用，请稍后重试。'
        : link ? '链接无效、已使用或已过期。请重新申请邮件。'
        : view === 'login' ? '登录失败，请检查邮箱和密码，并确认已完成邮箱验证。'
        : '请求未能完成，请检查填写内容后重试。';
      setNotice({kind: 'error', text});
    } finally {setBusy(false);}
  }

  async function signOut() {
    const previousIdentity=identityId.current;++identityGeneration.current;identityId.current=null;
    setBusy(true); setNotice(null);
    try {
      await request('/api/identity/sign-out', {});
      setJoinToken(null);clearInvitationReturn();
      if(previousIdentity){clearAgentReturns(previousIdentity);clearPageState(previousIdentity);}restoredIdentity.current=null;
      setShowAgents(false);setShowDevices(false);setRunnerReturnId(null);
      setActiveProjectId(null);setWorkspaceView('home');setLink(null);
      window.history.replaceState(null,'',window.location.pathname+window.location.search);
      setUser(null); setOrganizations(null); setSelectedOrganization(null); setPassword(''); setConfirmation('');
      organizationRequest.current = null; setOrganizationName(''); setShowOrganizationForm(false); setView('login');
      setNotice({kind: 'success', text: '已退出登录。'});
    } catch {++identityGeneration.current;identityId.current=previousIdentity;setNotice({kind: 'error', text: '退出登录未完成，请检查连接后重试。'});}
    finally {setBusy(false);}
  }

  function closeOrganizationForm() {
    setShowOrganizationForm(false);
    requestAnimationFrame(() => organizationCreateButton.current?.focus());
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || organizations === null) return;
    const trimmedName = organizationName.trim(),trimmedAlias=organizationAlias.trim();
    if (!trimmedName) {setNotice({kind: 'error', text: '请输入组织标识。'}); return;}
    if (!trimmedAlias) {setNotice({kind: 'error', text: '请输入组织名称。'}); return;}
    if (organizationRequest.current?.name !== trimmedName || organizationRequest.current?.alias!==trimmedAlias || organizationRequest.current?.description!==organizationDescription) organizationRequest.current = {name: trimmedName, alias:trimmedAlias,description:organizationDescription,requestId: crypto.randomUUID()};
    setBusy(true); setNotice(null);
    try {
      const result = await request<{organization: Organization}>('/api/account/organizations', organizationRequest.current);
      setOrganizations(current => [...(current ?? []).filter(item => item.id !== result.organization.id), result.organization]);
      organizationRequest.current = null; setOrganizationName('');setOrganizationAlias('');setOrganizationDescription('');
      try {
        await loadOrganizations();
        setNotice({kind: 'success', text: '组织已创建，你是该组织的所有者。'});
      } catch {
        setNotice({kind: 'error', text: '组织已创建，但完整组织列表暂时无法刷新。请刷新页面查看，不要重复创建。'});
      }
      closeOrganizationForm();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        ++identityGeneration.current;identityId.current=null;setUser(null); setOrganizations(null); setShowOrganizationForm(false); setView('login');
        setNotice({kind: 'error', text: '登录已过期，请重新登录。'});
      } else setNotice({kind: 'error', text: error instanceof ApiError && error.status === 403
        ? '当前账号没有创建组织的权限。' : '组织创建未能确认，请重试。同名重试不会重复创建。'});
    } finally {setBusy(false);}
  }

  // An existing session must not swallow recovery/resend navigation from a
  // lifecycle link. These forms remain usable without signing out another tab.
  const dashboard = user !== null && !loading && !link && view === 'login';
  const title = dashboard ? '你的协作空间' : isVerify ? '验证你的邮箱' : isReset ? '设置新密码'
    : link?.kind === 'invalid' ? '邮件链接不可用' : view === 'signup' ? '创建独立账号'
    : view === 'resend' ? '验证邮箱' : view === 'recover' ? '找回密码' : '登录工作空间';
  const subtitle = dashboard ? '管理你的组织，确认每一次协作的归属。'
    : isVerify ? '仅当你本人申请注册时，才点击下方按钮确认邮箱归属。若非本人操作，请不要确认。验证完成后，请重新登录。'
    : isReset ? '设置 12–128 位的新密码。重置后，需要在所有设备上重新登录。'
    : link?.kind === 'invalid' ? '链接不完整或格式错误，请重新申请验证或密码重置邮件。'
    : view === 'signup' ? '一个 MAS 账号，用于你自己的个人与团队协作。'
    : view === 'resend' ? '输入注册邮箱，重新获取验证说明。'
    : view === 'recover' ? '输入注册邮箱，获取密码重置说明。'
    : options?.githubLogin?'使用 GitHub 登录；首次授权将创建独立的 MAS 账号。':'用邮箱和密码，回到你的 MultiAgent Scrum 账号。';

  function workspacePage(page:'boards'|'projects'|'agents'|'devices'|'members'|'info'|'organizations'|'home'|'create-project',publish=true) {
    setJoinToken(null);
    setShowDevices(page==='devices');setRunnerReturnId(null);setNotice(null);
    setShowAgents(page==='agents');
    if(page==='boards'||page==='projects'||page==='members'||page==='info')setOrganizationSection(page);
    if(page==='boards')setBoardEntry(value=>value+1);
    if(['organizations','home','create-project','agents','devices'].includes(page)){setSelectedOrganization(null);setActiveProjectId(null);setShowOrganizationForm(false);}
    if(page==='organizations'||page==='home'||page==='create-project')setWorkspaceView(page);
    if(!publish)return;
    if(page==='agents'||page==='devices'){window.history.pushState(null,'',window.location.pathname+window.location.search+'#'+page);return;}
    if(page==='home'||page==='create-project'){writeHierarchyRoute({organizationId:null,page});return;}
    if(page==='organizations'||!selectedOrganization){writeHierarchyRoute({organizationId:null});return;}
    const scope='projects.'+selectedOrganization.id;
    const projectId=user&&readPageState(user.id,scope+'.selected',z.uuid().nullable(),null),boardId=user&&readPageState(user.id,scope+'.board',z.uuid().nullable(),null);
    writeHierarchyRoute({organizationId:selectedOrganization.id,section:page,...((page==='boards'||page==='projects')&&projectId&&boardId?{project:{id:projectId,boardId,page:page==='boards'?'board':'settings'}}:{})});
  }

  function selectOrganization(organization:Organization,section:OrganizationSection='boards'){
    workspacePage(section,false);setSelectedOrganization(organization);
    writeHierarchyRoute({organizationId:organization.id,section});
  }

  function openProject(project:Project){
    const organization=organizations?.find(item=>item.id===project.organizationId);
    if(!organization||!user)return;
    const scope='projects.'+organization.id;
    writePageState(user.id,scope+'.selected',project.id);writePageState(user.id,scope+'.board',project.defaultBoardId);
    writePageState(user.id,scope+'.subview','board');writePageState(user.id,scope+'.agents',null);
    writePageState(user.id,'project.'+project.id+'.page','board');
    workspacePage('boards',false);setSelectedOrganization(organization);setActiveProjectId(project.id);setProjectReturnEntry(value=>value+1);
    writeHierarchyRoute({organizationId:organization.id,section:'boards',project:{id:project.id,boardId:project.defaultBoardId,page:'board'}});
  }
  const inProject=!!selectedOrganization&&!showAgents&&!showDevices&&(organizationSection==='boards'||organizationSection==='projects')&&!!activeProjectId;

  return <PageIdentity.Provider value={user?.id??null}>{dashboard&&<button type="button" className="skip-navigation" onClick={()=>content.current?.focus()}>跳至主要内容</button>}<main className={dashboard?'workspace-layout':'account-layout'}>
    {dashboard?<aside className="workspace-sidebar" data-project={inProject}>
      <div className="brand"><span className="brand-mark"><Layers3 size={22} aria-hidden="true" /></span><span>MultiAgent<span className="workspace-brand-sub">SCRUM WORKSPACE</span></span></div>
      {inProject?<ProjectSwitcher groups={directory.groups} selectedId={activeProjectId} onSelect={openProject} onHome={()=>workspacePage('home')}/>:<>
      <nav aria-label="工作台导航">
        <button type="button" className="workspace-create-project" disabled={busy||organizations===null} onClick={()=>workspacePage('create-project')}><Plus size={17}/>新建项目</button>
        <button type="button" disabled={busy} aria-current={!selectedOrganization&&!showAgents&&!showDevices&&workspaceView==='home'?'page':undefined} onClick={()=>workspacePage('home')}><FolderKanban size={17}/>我的项目</button>
        <button type="button" disabled={busy} aria-current={showAgents&&!showDevices?'page':undefined} onClick={()=>workspacePage('agents')}><Bot size={17}/>我的 Agent</button>
        <button type="button" disabled={busy} aria-current={showDevices?'page':undefined} onClick={()=>workspacePage('devices')}><Monitor size={17}/>管理 Runner</button>
      </nav>
      </>}
      <div ref={setProjectNavigation} className="project-navigation-slot" hidden={!inProject}/>
      <div className="workspace-profile"><ProfileMenu name={user.name} image={user.image} disabled={busy} onProfile={()=>setProfileIdentity(user.id)} onOrganizations={()=>workspacePage('organizations')} onSignOut={()=>void signOut()}/></div>
    </aside>:<aside className="account-intro" aria-label="关于 MultiAgent Scrum">
      <div className="brand"><span className="brand-mark"><Layers3 size={22} aria-hidden="true" /></span><span>MultiAgent<span className="brand-secondary">Scrum</span></span></div>
      <div className="intro-content">
        <h1>想法成为成果</h1>
        <ol className="identity-layers" aria-label="协作流程">
          <li><BookOpen aria-hidden="true"/><div><strong>故事</strong><span>写下目标</span></div><span>01</span></li>
          <li><Layers3 aria-hidden="true"/><div><strong>任务</strong><span>确认后执行</span></div><span>02</span></li>
          <li><Check aria-hidden="true"/><div><strong>成果</strong><span>查看与验收</span></div><span>03</span></li>
        </ol>
      </div>
    </aside>}
    <section ref={content} tabIndex={-1} className={`account-panel${dashboard ? ' account-panel-wide' : ''}`} aria-label={dashboard?'工作台':undefined} aria-labelledby={dashboard?undefined:'account-title'}>
      <div className="account-content">
        {dashboard&&<DraftStorageNotice/>}
        {!dashboard && !loading && (view !== 'login' || link) && <button className="back-link" type="button" onClick={() => navigate('login')} disabled={busy}><ArrowLeft size={15} aria-hidden="true" />返回登录</button>}
        {!dashboard&&<header className="form-header"><div className="heading-with-tip"><h2 id="account-title" ref={heading} tabIndex={-1}>{title}</h2></div>{(isVerify||isReset||link?.kind==='invalid')&&<p>{subtitle}</p>}</header>}
        {!dashboard && options?.delivery === 'local' && <div className="delivery-label"><Mail size={17} aria-hidden="true"/><span>本地邮件模式</span><HelpTip label="邮件模式说明">邮件仅保存在本机，不会发送到邮箱。请由本机服务操作者查看邮件记录。</HelpTip></div>}
        {optionsUnavailable && <p className="inline-notice" role="status">暂时无法读取注册与邮件服务状态。你仍可尝试登录，或刷新页面重试。</p>}
        {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' && <Check size={17} aria-hidden="true" />}<span>{notice.text}</span></div>}
        {loading ? <p className="loading-message" role="status"><LoaderCircle className="spinner" size={18} aria-hidden="true" />正在检查登录状态…</p>
          : dashboard&&joinToken?<JoinInvitation key={user.id+joinToken} token={joinToken} onJoined={loadOrganizations} onBack={()=>{setJoinToken(null);workspacePage('home');}}/>: dashboard ? <>
            {selectedOrganization&&(organizationSection==='boards'||organizationSection==='projects')&&<Suspense fallback={<p role="status">正在打开项目…</p>}><Projects key={user.id+':projects:'+selectedOrganization.id+':'+projectReturnEntry} identityId={user.id} organization={selectedOrganization} view={organizationSection==='projects'?'settings':'board'} boardVisible={inProject} navigationTarget={inProject?projectNavigation:null} boardEntry={boardEntry} onOpenBoard={()=>workspacePage('boards',false)} onSettings={()=>workspacePage('projects',false)} onBack={()=>workspacePage('home')}/></Suspense>}
            {showAgents&&!showDevices&&<Agents key={'agents:'+user.id} identityId={user.id} resumeId={runnerReturnId} onReturnHandled={()=>setRunnerReturnId(null)} onManageDevices={()=>workspacePage('devices')} onBack={()=>workspacePage('home')}/>}
            {showDevices?<Devices key={'devices:'+user.id+':'+(runnerReturnId??'')} resumeId={runnerReturnId} identityId={user.id} name={user.name} onBack={()=>workspacePage('home')}/>:showAgents?null:selectedOrganization?(organizationSection==='members'
              ?<Members key={user.id+':members:'+selectedOrganization.id} organization={selectedOrganization} name={user.name} onBack={()=>workspacePage('organizations')}/>:organizationSection==='info'?<><OrganizationInfo key={selectedOrganization.id} organization={selectedOrganization} onChanged={organization=>{setSelectedOrganization(organization);void loadOrganizations().catch(()=>setNotice({kind:'error',text:'组织列表暂时无法刷新。'}));}}/></>:null):workspaceView==='home'?<ProjectHome groups={directory.groups} loading={organizations===null} onOpen={openProject} onRetry={directory.refresh} onOrganizations={()=>workspacePage('organizations')}/>:workspaceView==='create-project'?<CreateProject key={user.id} identityId={user.id} organizations={organizations??[]} onCreated={project=>{directory.refresh();openProject(project);}} onBack={()=>workspacePage('home')} onOrganizations={()=>workspacePage('organizations')}/>:<section className="organization-management" aria-label="组织管理">
            <header className="workspace-page-heading"><div><h1>组织管理</h1>{organizations !== null && <span>{organizations.length} 个已加入的组织</span>}</div><button ref={organizationCreateButton} type="button" className="primary-button" disabled={busy||organizations===null} onClick={()=>{setNotice(null);setOrganizationTab('joined');setShowOrganizationForm(true);}}><Plus size={16}/>新建组织</button></header>
            <nav className="organization-tabs" aria-label="组织管理视图">{(['joined','join','invitations'] as const).map(tab=><button key={tab} type="button" aria-current={organizationTab===tab?'page':undefined} onClick={()=>{setOrganizationTab(tab);setShowOrganizationForm(false);}}>{tab==='joined'?'已加入的组织':tab==='join'?'申请加入组织':'待处理的邀请'}</button>)}</nav>
            <div hidden={organizationTab!=='joined'}>
            {organizations === null ? <div className="organization-empty"><p>组织信息未加载。</p><button className="text-button" type="button" disabled={busy} onClick={async () => {setBusy(true); setNotice(null); try {await loadOrganizations();} catch {setNotice({kind: 'error', text: '组织信息仍无法加载，请稍后重试。'});} finally {setBusy(false);}}}>重新加载</button></div>
              : <ul className="organization-list" aria-label="我的组织">
                {organizations.map(organization => <li key={organization.id}>
                  <button type="button" className="organization-entry" aria-label={'组织信息：'+organization.name} disabled={busy} onClick={()=>selectOrganization(organization,'info')}>
                    <OrganizationAvatar name={organization.alias||organization.name} image={organization.image}/>
                    <div><strong>{organization.alias||organization.name}</strong><small>{organization.slug||organization.name}</small><p>{organization.description||'暂无组织简介'}</p></div><ArrowRight size={16} aria-hidden="true" />
                  </button>
                  <span className="role-label">{organization.role === 'owner' ? '所有者' : organization.role === 'admin' ? '管理员' : '成员'}</span>
                  <button type="button" className="text-button" disabled={busy} onClick={()=>selectOrganization(organization,'members')}>{organization.role==='owner'?'管理成员':'查看成员'}</button>
                </li>)}
                {organizations.length===0&&<li className="compact-empty">尚未加入组织</li>}
              </ul>}
            {showOrganizationForm && <form id="organization-create-form" onSubmit={createOrganization} className="organization-form" aria-label="创建组织" aria-busy={busy}>
              <div className="section-heading"><h3>创建组织</h3><button type="button" className="text-button" disabled={busy} onClick={closeOrganizationForm}>取消</button></div>
              <div className="field-label"><label htmlFor="organization-name">组织标识<RequiredMark/></label></div><div className="organization-create"><input autoFocus id="organization-name" name="organizationName" autoComplete="off" maxLength={50} pattern="[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?" required value={organizationName} onChange={event => setOrganizationName(event.target.value)} placeholder="例如：product-team" disabled={busy || organizations === null} /></div>
              <label htmlFor="organization-alias">组织名称<RequiredMark/></label><input id="organization-alias" autoComplete="organization" required maxLength={50} value={organizationAlias} disabled={busy} onChange={e=>setOrganizationAlias(e.target.value)}/>
              <label htmlFor="organization-description">组织简介</label><textarea id="organization-description" maxLength={200} value={organizationDescription} disabled={busy} onChange={e=>setOrganizationDescription(e.target.value)}/><button className="primary-button" disabled={busy || organizations === null} type="submit">{busy ? '处理中…' : '创建组织'}</button>
            </form>}
            </div>
            <div hidden={organizationTab!=='join'}><JoinOrganization/></div><div hidden={organizationTab!=='invitations'}><InvitationInbox key={'inbox:'+user.id} identityId={user.id} onAccepted={loadOrganizations}/></div>
            </section>}
          </> : link?.kind === 'invalid' ? <div className="recovery-actions"><button className="secondary-button" onClick={() => navigate('resend')}>重新验证邮箱</button><button className="secondary-button" onClick={() => navigate('recover')}>重新申请密码重置</button></div> : <>
            {!link && (view === 'login' || view === 'signup') && <nav className="auth-tabs" aria-label="账号操作"><button type="button" aria-current={view === 'login' ? 'page' : undefined} onClick={() => navigate('login')} disabled={busy}>登录</button><button type="button" aria-current={view === 'signup' ? 'page' : undefined} onClick={() => navigate('signup')} disabled={busy}>注册账号</button></nav>}
            {unavailable && <p className="inline-notice" role="status">{options === null ? '正在等待邮件服务配置，当前操作暂不可用。' : '当前服务尚未开放此操作。请联系服务管理员配置邮件投递；已有账号仍可登录。'}</p>}
            <form onSubmit={submit} className="auth-form" aria-label={title} aria-busy={formBusy}>
              <fieldset disabled={busy || unavailable}>
                {!link && view === 'signup' && <div className="form-field"><label htmlFor="account-name">姓名<RequiredMark/></label><input id="account-name" name="name" autoComplete="name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="你的姓名" /></div>}
                {!link && <div className="form-field"><label htmlFor="account-email">邮箱<RequiredMark/></label><input id="account-email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></div>}
                {(isReset || (!link && (view === 'login' || view === 'signup'))) && <div className="form-field"><div className="field-label"><label htmlFor="account-password">{isReset ? '新密码' : '密码'}<RequiredMark/></label>{(view==='signup'||isReset)&&<HelpTip label="密码说明">使用 12–128 位密码，建议混合字母、数字和符号。</HelpTip>}</div><input id="account-password" name="password" type="password" autoComplete={view === 'signup' || isReset ? 'new-password' : 'current-password'} minLength={view === 'signup' || isReset ? 12 : 1} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} /></div>}
                {(isReset || (!link && view === 'signup')) && <div className="form-field"><label htmlFor="password-confirmation">确认{isReset ? '新' : ''}密码<RequiredMark/></label><input id="password-confirmation" name="passwordConfirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={event => setConfirmation(event.target.value)} aria-invalid={passwordMismatch} aria-describedby={passwordMismatch ? 'confirmation-error' : undefined} />{passwordMismatch && <p className="field-error" id="confirmation-error">两次输入的密码不一致。</p>}</div>}
                {!link && view === 'login' && <div className="login-options"><label className="checkbox-label"><input type="checkbox" name="rememberMe" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} />保持登录</label><HelpTip label="保持登录说明">最长保持 24 小时；共享电脑上请不要勾选。</HelpTip><button className="text-button" type="button" onClick={() => navigate('recover')}>忘记密码？</button></div>}
                <button type="submit" className="primary-button form-submit" disabled={passwordMismatch && (isReset || view === 'signup')}>{formBusy ? <><LoaderCircle className="spinner" size={18} aria-hidden="true" />处理中…</> : <>{isVerify ? '确认验证邮箱' : isReset ? '更新密码' : view === 'signup' ? '创建账号并验证邮箱' : view === 'resend' ? '重新发送验证说明' : view === 'recover' ? '发送重置说明' : '登录'}<ArrowRight size={17} aria-hidden="true" /></>}</button>
              </fieldset>
            </form>
            {!link && view === 'login' && <p className="auth-footer">尚未验证邮箱？<button className="text-button" type="button" disabled={busy} onClick={() => navigate('resend')}>重新发送验证说明</button></p>}
            {(isVerify || isReset) && <p className="auth-footer">链接失效？<button className="text-button" type="button" disabled={busy} onClick={() => navigate(isVerify ? 'resend' : 'recover')}>重新申请邮件</button></p>}

            {!link && (view==='login'||view==='signup') && options?.githubLogin && <div className="github-login"><div className="auth-divider"><span>其他登录方式</span></div><button type="button" className="primary-button form-submit github-button" disabled={busy} aria-busy={githubPending} onClick={()=>void githubLogin()}><GitHubMark/><span>{githubPending?'正在连接…':'使用 GitHub 登录'}</span></button></div>}
          </>}
      </div>
      <footer className="panel-footer"><span>MultiAgent Scrum</span></footer>
    </section>
    {user&&profileIdentity===user.id&&<PersonalProfileDialog key={user.id} identityId={user.id} onClose={()=>setProfileIdentity(null)} onSaved={updated=>{if(identityId.current===updated.id)setUser(updated);}}/>}
  </main></PageIdentity.Provider>;
}
