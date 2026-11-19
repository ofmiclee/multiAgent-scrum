import {cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const exec=promisify(execFile);
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const base=resolve(process.env.MAS_RUNNER_BASE ?? join(root,'dist/runner/MultiAgent-Scrum-Runner-macos.zip'));
const origin=process.env.MAS_RUNNER_ORIGIN ?? 'https://scrum.fruitbuddy.cn';
const temp=await mkdtemp(join(tmpdir(),'mas-runner-package-'));
const unpack=join(temp,'unpack');
const app=join(unpack,'MultiAgent Scrum Runner.app');
const resources=join(app,'Contents/Resources');
const bundle=join(temp,'runner.mjs');
const smokeHome=join(temp,'home');
const stage=join(temp,'dmg-content');

async function executeWithInput(file,args,input,options={}){
  const child=spawn(file,args,{...options,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end(input);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if(code!==0)throw Error(stderr||`Command failed with exit code ${code}`);
  return {stdout,stderr};
}

try{
  await exec('/usr/bin/unzip',['-q','-o',base,'-d',unpack]);
  // Refresh the complete native runtime from the lockfile, not the legacy shell ZIP.
  const codexSource=join(root,'deploy/runner/codex-runtime');
  const codexInstall=join(temp,'codex-install');
  await cp(codexSource,codexInstall,{recursive:true});
  await exec('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:codexInstall,timeout:300000,maxBuffer:16384});
  const codexPackage=join(codexInstall,'node_modules/@openai/codex');
  const codexRuntime=join(resources,'codex-runtime');
  for(const directory of ['bin','codex-resources','codex-path'])
    await rm(join(codexRuntime,directory),{recursive:true,force:true});
  await cp(join(codexPackage,'vendor/aarch64-apple-darwin'),codexRuntime,{recursive:true});
  await cp(join(codexSource,'package.json'),join(codexRuntime,'package.json'));
  await cp(join(codexSource,'package-lock.json'),join(codexRuntime,'package-lock.json'));
  const codexVersion=JSON.parse(await readFile(join(codexSource,'package.json'),'utf8')).dependencies['@openai/codex'].replace(/-darwin-arm64$/,'');
  const codexMetadata=JSON.parse(await readFile(join(codexRuntime,'codex-package.json'),'utf8'));
  const bundledVersion=(await exec(join(codexRuntime,'bin/codex'),['--version'])).stdout.trim();
  if(codexMetadata.version!==codexVersion||bundledVersion!==`codex-cli ${codexVersion}`)throw Error('Bundled Codex does not match the pinned runtime version');
  const appInfo=join(app,'Contents/Info.plist');
  // The legacy private ZIP is only a build input. Preserve a newer native
  // shell, but never publish it with the old ZIP-era release number.
  const previousVersion=(await exec('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw',appInfo])).stdout.trim();
  const previousBuild=(await exec('/usr/bin/plutil',['-extract','CFBundleVersion','raw',appInfo])).stdout.trim();
  const version=process.env.MAS_RUNNER_VERSION ?? (previousVersion.localeCompare('0.3.18',undefined,{numeric:true})<0?'0.3.18':previousVersion);
  if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Runner version must use major.minor.patch');
  const filename=`MultiAgent-Scrum-Runner-${version}-macos-arm64.dmg`;
  const output=resolve(process.env.MAS_RUNNER_OUTPUT ?? join(root,'dist/runner',filename));
  if(basename(output)!==filename)throw Error(`Runner output filename must be ${filename}`);
  const build=process.env.MAS_RUNNER_BUILD ?? String(Math.max(Number(previousBuild)||0,20));
  await exec('/usr/bin/plutil',['-replace','CFBundleShortVersionString','-string',version,appInfo]);
  await exec('/usr/bin/plutil',['-replace','CFBundleVersion','-string',build,appInfo]);
  const artwork=join(root,'assets/multiagent-runner-icon.svg');
  const iconset=join(temp,'AppIcon.iconset');
  await mkdir(iconset);
  for(const points of [16,32,128,256,512]){
    await sharp(artwork).resize(points,points).png().toFile(join(iconset,`icon_${points}x${points}.png`));
    await sharp(artwork).resize(points*2,points*2).png().toFile(join(iconset,`icon_${points}x${points}@2x.png`));
  }
  await exec('/usr/bin/iconutil',['-c','icns',iconset,'-o',join(resources,'AppIcon.icns')]);
  await exec('/usr/bin/plutil',['-replace','CFBundleIconFile','-string','AppIcon',appInfo]);
  await exec(join(root,'node_modules/.bin/rolldown'),[
    'services/runner/launch-main.ts','--file',bundle,'--format','esm','--platform','node',
    '--no-codeSplitting','--logLevel','warn'
  ],{cwd:root});
  await cp(bundle,join(resources,'runner.mjs'));
  await writeFile(join(resources,'launch-config.json'),JSON.stringify({origin})+'\n',{mode:0o644});
  await exec('/usr/bin/codesign',['--force','--deep','--sign','-',app]);
  await exec('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  await mkdir(smokeHome,{recursive:true});
  const node=join(resources,'node');
  const status=await executeWithInput(node,[join(resources,'runner.mjs'),'setup'],'{"op":"status"}\n',{
    cwd:resources,
    env:{...process.env,HOME:smokeHome},
  });
  const result=JSON.parse(status.stdout);
  if(result?.state?.configured!==false||result?.operation!=='status')throw Error('Runner status smoke test failed');
  await mkdir(stage);
  await exec('/usr/bin/ditto',[app,join(stage,'MultiAgent Scrum Runner.app')]);
  await symlink('/Applications',join(stage,'Applications'));
  await cp(join(resources,'AppIcon.icns'),join(stage,'.VolumeIcon.icns'));
  await exec('xcrun',['SetFile','-a','C',stage]);
  const keyHelper=join(stage,'Configure Codex API Key.command');
  await writeFile(keyHelper,`#!/bin/zsh
set -eu
unsetopt XTRACE VERBOSE
script_dir=\${0:A:h}
resources="$script_dir/MultiAgent Scrum Runner.app/Contents/Resources"
if [[ ! -x "$resources/node" ]]; then
  /usr/bin/osascript -e 'display dialog "请从同一个安装镜像中打开配置工具。" buttons {"好"} default button "好"'
  exit 1
fi
key=$(/usr/bin/osascript -e 'text returned of (display dialog "请先退出正在运行的 Runner，再输入 Codex API Key。密钥只写入本机 Runner 的独立账号目录。" default answer "" with hidden answer buttons {"取消", "配置"} default button "配置")') || exit 0
if ! /bin/printf '%s' "$key" | "$resources/node" "$resources/runner.mjs" codex-key >/dev/null; then
  unset key
  /usr/bin/osascript -e 'display dialog "配置未完成。请确认 Runner 已退出、Codex 已安装，然后重试。现有账号未重置。" buttons {"好"} default button "好"'
  exit 1
fi
unset key
/usr/bin/osascript -e 'display dialog "Codex API Key 已配置。现在可重新打开 Runner，并返回网页刷新状态。" buttons {"好"} default button "好"'
`,{mode:0o700});
  const requiredResources=[
    'MultiAgent Scrum Runner.app/Contents/Resources/runner.mjs',
    'MultiAgent Scrum Runner.app/Contents/Resources/launch-config.json',
    'MultiAgent Scrum Runner.app/Contents/Resources/codex-runtime/bin/codex',
    'MultiAgent Scrum Runner.app/Contents/Resources/dsh-runtime/package.json',
    'MultiAgent Scrum Runner.app/Contents/Resources/AppIcon.icns',
    '.VolumeIcon.icns',
    'Configure Codex API Key.command',
  ];
  for(const resource of requiredResources)await stat(join(stage,resource));
  const iconName=(await exec('/usr/bin/plutil',['-extract','CFBundleIconFile','raw',appInfo])).stdout.trim();
  if(iconName!=='AppIcon')throw Error('Runner app icon is not configured');
  await exec('/usr/bin/codesign',['--verify','--deep','--strict',join(stage,'MultiAgent Scrum Runner.app')]);
  await mkdir(dirname(output),{recursive:true});
  await rm(output,{force:true});
  await exec('/usr/bin/hdiutil',['create','-volname','MultiAgent Scrum Runner','-srcfolder',stage,'-ov','-format','UDZO','-imagekey','zlib-level=9',output],{maxBuffer:4096,timeout:300000});
  await exec('/usr/bin/hdiutil',['verify',output],{maxBuffer:4096,timeout:300000});
  // The production Dockerfile copies every versioned DMG it finds; remove stale
  // ones so old releases cannot double the deploy image size.
  for(const entry of await readdir(dirname(output)))
    if((/^MultiAgent-Scrum-Runner-\d+\.\d+\.\d+-macos-arm64\.dmg$/.test(entry)&&entry!==filename)||entry==='MultiAgent-Scrum-Runner-macos-arm64.dmg')
      await rm(join(dirname(output),entry),{force:true});
  // Keep only the base ZIP actually used by this build; older approved inputs are dead weight.
  if(dirname(base)===dirname(output)){
    const current=basename(base);
    for(const entry of await readdir(dirname(output)))
      if(/^MultiAgent-Scrum-Runner.*\.zip$/i.test(entry)&&entry!==current)
        await rm(join(dirname(output),entry),{force:true});
  }
  const [{stdout:fileInfo},image]=await Promise.all([
    exec('/usr/bin/file',[join(app,'Contents/MacOS/MASRunner'),node,output]),
    stat(output),
  ]);
  await writeFile(join(dirname(output),'runner-release.json'),JSON.stringify({filename,version,build})+'\n');
  console.log(JSON.stringify({output,origin,version,build,codexVersion,bytes:image.size,file:fileInfo.trim(),status:result}));
}finally{
  await rm(temp,{recursive:true,force:true});
}
