import {lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {deviceLockActive,inspectDeviceIdentity} from './device-identity.ts';
import {readDeviceConfig,resolveDeviceLaunch,type DeviceConfig} from './device-config.ts';
import {TaskJournal} from './task-journal.ts';

type Check={code:string;level:'info'|'attention';message:string};
/** A local, possibly concurrent snapshot. Never an execution/admission decision.
 * Output is allowlisted prose: no raw errors, paths, task bodies or credentials. */
export async function diagnoseDevice(root:string,env:NodeJS.ProcessEnv={}){
  const checks:Check[]=[];
  const add=(code:string,level:Check['level'],message:string)=>checks.push({code,level,message});
  const finish=()=>{
    add('REMOTE_STATE_UNCHECKED','info','未联网：服务端在线状态、设备绑定和项目授权请在 Web 核对。本报告不授予执行权限。');
    return {version:1,scope:'local-read-only',status:checks.some(c=>c.level==='attention')?'attention':'local-checks-passed',checks};
  };
  if(!isAbsolute(root)||process.platform==='win32'){
    add('ROOT_UNSUPPORTED','attention','需要绝对身份目录路径；当前尚未验证 Windows 权限。');return finish();
  }
  try{
    const dir=await lstat(root);
    if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)||dir.uid!==process.getuid?.())throw Error('Unsafe root');
  }catch(e){
    if((e as NodeJS.ErrnoException).code==='ENOENT')add('SETUP_REQUIRED','attention','尚无本机身份目录。请运行 npm run runner:setup；诊断不会创建身份。');
    else add('ROOT_UNSAFE','attention','无法安全读取身份目录。请核对所有者、权限与链接；不要删除身份或凭据。');
    return finish();
  }
  try{
    const identity=await inspectDeviceIdentity(root);
    add(identity?'IDENTITY_PRESENT':'IDENTITY_MISSING',identity?'info':'attention',identity?'已存在结构有效的本机身份；不代表服务端绑定有效。':'缺少本机身份。若这是旧设备，请先核对原身份目录，不要自动重建绑定。');
  }catch{add('IDENTITY_UNSAFE','attention','身份记录损坏或权限不安全；保留原文件，进行本机恢复核对。');}
  let launch:DeviceConfig|undefined;
  try{
    const saved=await readDeviceConfig(root);launch=await resolveDeviceLaunch(root,env);
    add(saved?'CONFIG_PRESENT':'CONFIG_UNSAVED',saved?'info':'attention',saved?'已有本机配置，显式环境变量仍可覆盖本次启动。':'未保存本机配置；当前只检查环境变量或默认值。可运行 npm run runner:setup。');
  }catch{add('CONFIG_INVALID','attention','配置或环境覆盖值无效。请核对模式、服务地址及路径；不会回退或覆盖损坏配置。');}
  let locked=true;
  try{
    locked=await deviceLockActive(root);
    if(locked)add('DEVICE_LOCK_PRESENT','attention','本机独占锁正在使用；诊断不会把它当成服务端在线证明。');
  }catch{add('DEVICE_LOCK_UNREADABLE','attention','设备锁无法检查，请保留现场进行本机核对。');}
  if(locked)add('JOURNAL_NOT_INSPECTED','attention','为避免把运行中的日志快照误判为故障，本次不检查任务记录；安全停止 Runner 后重试。');
  else try{
    const journal=await new TaskJournal(root).inspect();
    if(!journal.exists)add('JOURNAL_ABSENT','info','尚无任务日志；诊断不会初始化日志或绑定地址。');
    else{
      if(!journal.server)add('SERVER_PIN_MISSING','attention','现有日志尚未固定服务地址，请核对历史环境；不要通过清空日志迁移。');
      else if(launch&&journal.server!==launch.server)add('SERVER_PIN_MISMATCH','attention','启动地址与历史服务地址不一致；请恢复原启动地址，不要删除身份或日志。');
      const unfinished=journal.pending.filter(p=>!p.terminal).length,receipts=journal.pending.length-unfinished;
      if(unfinished)add('UNFINISHED_WORK','attention',`有 ${unfinished} 个尝试尚无确认停止或结果记录。先核对旧执行，不能直接重跑。`);
      if(receipts)add('RECEIPTS_PENDING','attention',`有 ${receipts} 个持久结果或停止回执等待确认；不要清除，可在原绑定下恢复连接补传。`);
      if(!journal.pending.length)add('JOURNAL_SETTLED','info','本次日志快照没有待核对尝试或待确认回执；不证明其他进程已停止。');
    }
  }catch{add('JOURNAL_UNSAFE','attention','日志不完整、损坏或权限不安全；保留历史记录并核对，不自动修复。');}
  if(launch?.profile==='dsh-text'){
    if(process.platform!=='darwin')add('DSH_PLATFORM_UNSUPPORTED','attention','当前原生 DSH 文本执行只验证了 macOS 隔离机制。');
    try{
      const runtime=await lstat(launch.dsh!.runtime);if(!runtime.isDirectory()||runtime.isSymbolicLink())throw Error('Invalid directory');
      add('DSH_RUNTIME_PRESENT','info','DSH 目录存在；未执行 Runtime，未验证版本、兼容性或可信来源。');
    }catch{add('DSH_RUNTIME_UNAVAILABLE','attention','DSH 目录不存在、是链接或无法读取。核对已安装 Runtime 的绝对路径。');}
    try{
      const credential=await lstat(launch.dsh!.credentials);
      if(!credential.isFile()||credential.isSymbolicLink()||credential.nlink!==1||(credential.mode&0o077)||credential.uid!==process.getuid?.())throw Error('Unsafe credentials');
      add('DSH_CREDENTIAL_FILE_PRESENT','info','原生凭据文件的类型和权限符合本机检查；未读取其内容，不代表已登录或有额度。');
    }catch{add('DSH_CREDENTIAL_FILE_UNSAFE','attention','原生凭据文件缺失、权限不安全或是链接；请在本机核对，诊断不会修改它。');}
    add('DSH_AUTH_UNCHECKED','info','未检测账号同意、登录或额度。安全停止 Runner 后可运行 npm run runner:dsh -- status；授权需明确操作。');
  }
  return finish();
}
