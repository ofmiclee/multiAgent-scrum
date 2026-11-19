import {hostname} from 'node:os';
import {readDeviceConfig,saveDeviceConfig} from './device-config.ts';
import {manageDeviceDsh} from './device-dsh.ts';
import {manageDeviceCodex} from './device-codex.ts';

const terminalJson=(value:unknown)=>JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,c=>
  Array.from({length:c.length},(_,i)=>'\\u'+c.charCodeAt(i).toString(16).padStart(4,'0')).join(''));

/** Terminal interaction only; no credentials, shell interpolation, model prompts
 * or server-side account actions. Saving configuration does not grant consent. */
export async function setupDevice(io:{root:string;ask:(prompt:string)=>Promise<string>;tell:(message:string)=>void;signal?:AbortSignal},backend?:Parameters<typeof manageDeviceDsh>[1],codexBackend?:Parameters<typeof manageDeviceCodex>[1]){
  io.signal?.throwIfAborted();
  io.tell('MultiAgent-Scrum Runner 本机设置（本地预览）\n不会安装 Runtime、登录原生账号或调用模型。不要输入 API key；仅填写路径。');
  let config=await readDeviceConfig(io.root);
  if(!config){
    const server=(await io.ask('服务地址 [http://127.0.0.1:4317]：')).trim()||'http://127.0.0.1:4317';
    const name=(await io.ask(`设备名称 [${hostname()}]：`)).trim()||hostname();
    const profile=(await io.ask('模式 connection / demo / dsh-text / codex-code [connection]：')).trim()||'connection';
    const dsh=profile==='dsh-text'?{runtime:(await io.ask('已安装 DSH 目录（绝对路径）：')).trim(),credentials:(await io.ask('原生凭据文件（绝对路径，不是密钥内容）：')).trim()}:undefined;
    let codex:{command:string;codexHome?:string}|undefined;
    if(profile==='codex-code'){
      const command=(await io.ask('已安装 Codex 命令（绝对路径）：')).trim();
      const codexHome=(await io.ask('Codex HOME（绝对路径；留空沿用本机默认）：')).trim();
      codex={command,...(codexHome?{codexHome}:{})};
    }
    const value={version:1,server,name,profile,...(dsh?{dsh}:{}),...(codex?{codex}:{})};
    // Escape Unicode controls as well as JSON's ASCII controls while the
    // persisted schema still rejects it rather than silently normalizing it.
    io.tell('待保存的本机配置：'+terminalJson(value));
    if((await io.ask('配置随身份保留，普通卸载不清除；当前向导不覆盖已有配置。输入 yes 保存，其余取消：')).trim().toLowerCase()!=='yes'){io.tell('已取消；未保存配置或授权。');return;}
    io.signal?.throwIfAborted();await saveDeviceConfig(io.root,value);config=await readDeviceConfig(io.root);
  }
  if(!config)throw Error('Configuration was not persisted');
  io.tell('本机配置：'+JSON.stringify(config));
  if(config.profile==='dsh-text'){
    const options={root:io.root,server:config.server,config:config.dsh!,signal:io.signal};
    const status=await manageDeviceDsh({...options,action:'status'},backend);
    io.tell('DSH 本机授权状态：'+JSON.stringify(status.account));
    if(status.account.status==='disconnected'){
      if((await io.ask('是否允许本 Runner 使用这个本机 DSH 账号？授权握手不调用模型；以后获项目授权的任务可能消耗额度。输入 yes 授权，其余仅保存配置：')).trim().toLowerCase()!=='yes'){
        io.tell('配置已保存，账号未授权。再次运行 npm run runner:setup 可继续。');return;
      }
      await manageDeviceDsh({...options,action:'use-local'},backend);
      if(io.signal?.aborted){
        io.tell('授权已提交；取消发生在提交之后。没有启动任务。需要撤销时运行 npm run runner:dsh -- disconnect。');return;
      }
    }else if(status.account.status!=='connected'){
      io.tell('账号暂不接单。先核对停止状态与日志，再使用 npm run runner:dsh -- disconnect 处理；不会自动重新授权。');return;
    }
  }else if(config.profile==='codex-code'){
    const options={root:io.root,server:config.server,config:config.codex!,signal:io.signal};
    const status=await manageDeviceCodex({...options,action:'status'},codexBackend);
    io.tell('Codex 本机授权状态：'+JSON.stringify(status.account));
    if(status.account.status==='disconnected'){
      if((await io.ask('是否允许本 Runner 使用这个本机 Codex 账号？检测与授权不调用模型；以后获项目授权的任务可能消耗额度。输入 yes 授权，其余仅保存配置：')).trim().toLowerCase()!=='yes'){
        io.tell('配置已保存，账号未授权。可运行 npm run runner:codex -- detect 检测，或再次运行 npm run runner:setup 继续。');return;
      }
      await manageDeviceCodex({...options,action:'use-local'},codexBackend);
      if(io.signal?.aborted){
        io.tell('授权已提交；取消发生在提交之后。没有启动任务。需要撤销时运行 npm run runner:codex -- disconnect。');return;
      }
    }else if(status.account.status!=='connected'){
      io.tell('账号暂不接单。先核对停止状态与日志，再使用 npm run runner:codex -- disconnect 处理；不会自动重新授权。');return;
    }
  }
  io.tell('设置完成。运行 npm run runner:connect；首次将配对码输入 Web“我的执行设备”。账号同意不等于项目授权，仍需在“我的 Agent”启用并授权项目。');
}
