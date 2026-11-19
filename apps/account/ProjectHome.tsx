import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowLeft, ArrowUpRight, Building2, FolderKanban, Search} from 'lucide-react';
import {z} from 'zod';
import {accountRequest, denied} from './account-api';
import {organizationSchema, projectSchema, roleLabel} from './hierarchy';
import {usePageRef, usePageState} from './page-state';
import RequiredMark from './RequiredMark';

export type Organization = z.infer<typeof organizationSchema>;
export type Project = z.infer<typeof projectSchema>;
type Group = {organization: Organization; projects: Project[] | null; error: string | null};
const listing = z.object({projects: z.array(projectSchema)}).strict();
const detail = z.object({project: projectSchema, boards: z.array(z.object({id: z.uuid(), name: z.string(), isDefault: z.boolean()}).strict())}).strict();

export function useProjectDirectory(organizations: Organization[] | null, identityId: string | null) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setGroups((organizations ?? []).map(organization => ({organization, projects: null, error: null})));
    if (!identityId || !organizations) return () => controller.abort();
    for (const organization of organizations) {
      void accountRequest('/organizations/' + organization.id + '/projects', listing, {signal: controller.signal, expectedIdentity: identityId})
        .then(result => {
          if (result.projects.some(project => project.organizationId !== organization.id)) throw Error('Project scope mismatch');
          if (!controller.signal.aborted) setGroups(current => current.map(group => group.organization.id === organization.id ? {...group, projects: result.projects} : group));
        })
        .catch(error => {
          if (!controller.signal.aborted) setGroups(current => current.map(group => group.organization.id === organization.id ? {...group, error: denied(error) ? '当前账号无法访问此组织的项目。' : '项目暂时无法加载。'} : group));
        });
    }
    return () => controller.abort();
  }, [organizations, identityId, revision]);
  return {groups, refresh};
}

export function ProjectSwitcher({groups, selectedId, onSelect, onHome}: {groups: Group[]; selectedId: string | null; onSelect: (project: Project) => void; onHome: () => void}) {
  return <div className="project-switcher">
    <button className="workspace-home-link" type="button" onClick={onHome}><FolderKanban size={15}/>所有项目</button>
    <label htmlFor="workspace-project">当前项目</label>
    <select id="workspace-project" aria-label="切换项目" value={selectedId ?? ''} onChange={event => {
      const project = groups.flatMap(group => group.projects ?? []).find(item => item.id === event.target.value);
      if (project) onSelect(project);
    }}>
      <option value="" disabled>选择项目</option>
      {selectedId && !groups.some(group => group.projects?.some(project => project.id === selectedId)) && <option value={selectedId}>当前项目</option>}
      {groups.map(group => <optgroup key={group.organization.id} label={group.organization.alias || group.organization.name}>
        {group.projects?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </optgroup>)}
    </select>
  </div>;
}

export default function ProjectHome({groups, loading, onOpen, onRetry, onOrganizations}: {groups: Group[]; loading: boolean; onOpen: (project: Project) => void; onRetry: () => void; onOrganizations: () => void}) {
  const [query, setQuery] = usePageState('home.project-query', z.string().max(200), '');
  const needle = query.trim().toLocaleLowerCase();
  const filtered = groups.map(group => ({...group, matches: group.projects?.filter(project => [project.name, project.key, project.description, group.organization.name, group.organization.alias].some(value => value?.toLocaleLowerCase().includes(needle)))}));
  const total = groups.reduce((count, group) => count + (group.projects?.length ?? 0), 0), matched = filtered.reduce((count, group) => count + (group.matches?.length ?? 0), 0);
  const reading = loading || groups.some(group => group.projects === null && !group.error), partial = groups.some(group => group.error);
  return <section className="project-home" aria-label="我的项目">
    <header className="workspace-page-heading"><div><h1>我的项目</h1><span>{reading ? '正在读取项目…' : <>{needle ? '匹配 ' + matched + ' / ' + total : total} 个项目{partial ? ' · 部分未载入' : ' · ' + groups.length + ' 个组织'}</>}</span></div>
      <label className="project-search"><Search size={16} aria-hidden="true"/><input type="search" aria-label="搜索项目" placeholder="搜索名称、KEY 或简介" maxLength={200} value={query} onChange={event => setQuery(event.target.value)}/></label>
    </header>
    {!reading && !partial && needle && matched === 0 && groups.length > 0 && <div className="workspace-empty project-search-empty" role="status"><p>没有匹配的项目</p><button className="text-button" type="button" onClick={() => setQuery('')}>清除搜索</button></div>}
    {loading ? <p role="status">正在读取组织…</p> : groups.length === 0 ? <div className="workspace-empty"><Building2 size={28}/><h2>尚未加入组织</h2><button className="secondary-button" onClick={onOrganizations}>组织管理</button></div> : filtered.map(group => {
      const projects = group.matches;
      if (needle && projects?.length === 0 && !group.error) return null;
      return <section key={group.organization.id} className="project-group" aria-label={'组织项目：' + group.organization.name}>
        <div className="project-group-heading"><Building2 size={17} aria-hidden="true"/><h2>{group.organization.alias || group.organization.name}</h2>{projects && <span>{projects.length}</span>}{group.organization.alias && <small>{group.organization.slug || group.organization.name}</small>}</div>
        {group.error ? <p role="alert">{group.error} <button className="text-button" onClick={onRetry}>重新加载</button></p> : !projects ? <p role="status">正在读取项目…</p> : projects.length === 0 ? <p className="compact-empty">暂无可访问的项目</p> :
          <div className="project-grid">{projects.map(project => <button type="button" className="project-tile" key={project.id} aria-label={'打开项目：' + project.name} onClick={() => onOpen(project)}>
            <div className="project-tile-heading"><h3>{project.name}</h3><ArrowUpRight size={16} aria-hidden="true"/></div>
            <div className="project-tile-meta"><code>{project.key || 'PROJECT'}</code><span className="role-label">{roleLabel[project.role]}</span></div>
            <p>{project.description || '暂无项目简介'}</p>
          </button>)}</div>}
      </section>;
    })}
  </section>;
}

export function CreateProject({organizations, identityId, onCreated, onBack, onOrganizations}: {organizations: Organization[]; identityId: string; onCreated: (project: Project) => void; onBack: () => void; onOrganizations: () => void}) {
  const [organizationId, setOrganizationId] = usePageState('project.create.organization', z.string(), organizations.length === 1 ? organizations[0].id : '');
  const selectedId = organizations.length === 1 ? organizations[0].id : organizations.some(item => item.id === organizationId) ? organizationId : '';
  const scope = 'projects.' + selectedId;
  const [name, setName] = usePageState(scope + '.create.name', z.string().max(120), '');
  const [key, setKey] = usePageState(scope + '.create.key', z.string().max(10), '');
  const [description, setDescription] = usePageState(scope + '.create.description', z.string().max(200), '');
  const pending = usePageRef(scope + '.create.pending', z.object({name: z.string().max(120), key: z.string(), description: z.string(), requestId: z.uuid()}).nullable(), null);
  const [saving, setSaving] = useState(false), [notice, setNotice] = useState('');
  const alive = useRef(false), working = useRef(false);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (working.current || !selectedId || !name.trim()) return;
    if (pending.current?.name !== name.trim() || pending.current?.key !== key || pending.current?.description !== description) pending.current = {name: name.trim(), key, description, requestId: crypto.randomUUID()};
    working.current = true; setSaving(true); setNotice('');
    try {
      const result = await accountRequest('/organizations/' + selectedId + '/projects', detail, {body: pending.current, expectedIdentity: identityId});
      if (!alive.current) return;
      if (result.project.organizationId !== selectedId) throw Error('Project scope mismatch');
      setName(''); setKey(''); setDescription(''); pending.current = null;
      onCreated(result.project);
    } catch (error) {
      if (alive.current) setNotice(denied(error) ? '当前账号无法在此组织创建项目，请重新选择组织或登录。' : '项目创建未能确认，请重试；相同请求不会重复创建。');
    } finally {working.current = false; if (alive.current) setSaving(false);}
  }
  return <section className="project-create-page" aria-label="新建项目">
    <header className="workspace-page-heading"><h1>新建项目</h1></header>
    {organizations.length === 0 ? <div className="workspace-empty"><p>尚未加入组织</p><button className="secondary-button" onClick={onOrganizations}>组织管理</button></div> :
      <form className="story-form" aria-label="创建项目" onSubmit={create} aria-busy={saving}>
        {notice && <p className="notice notice-error" role="alert">{notice}</p>}
        <label htmlFor="project-organization">所属组织<RequiredMark/></label>
        <select id="project-organization" required disabled={saving || organizations.length === 1} value={selectedId} onChange={event => {setOrganizationId(event.target.value); setNotice('');}}><option value="">请选择组织</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.alias ? item.alias + ' · ' : ''}{item.name}</option>)}</select>
        <label htmlFor="project-key">项目 KEY<RequiredMark/></label><input id="project-key" required pattern="[A-Z][A-Z0-9]{1,9}" maxLength={10} value={key} disabled={saving} onChange={event => setKey(event.target.value.toUpperCase())}/>
        <label htmlFor="project-name">项目名称<RequiredMark/></label><input id="project-name" required maxLength={120} value={name} disabled={saving} onChange={event => setName(event.target.value)}/>
        <label htmlFor="project-description">项目简介</label><textarea id="project-description" maxLength={200} value={description} disabled={saving} onChange={event => setDescription(event.target.value)}/>
        <div className="form-actions"><button className="primary-button" type="submit" disabled={saving || !selectedId}>{saving ? '创建中…' : '创建项目'}</button><button className="secondary-button" type="button" disabled={saving} onClick={onBack}>取消</button></div>
      </form>}
  </section>;
}
