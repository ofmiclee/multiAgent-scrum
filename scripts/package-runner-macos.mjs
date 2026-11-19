import {cp, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const exec=promisify(execFile);
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Build on an Apple silicon Mac with Xcode Command Line Tools.');
if(process.env.MAS_RUNNER_BASE)throw Error('Private baseline ZIPs are no longer used. Unset MAS_RUNNER_BASE.');
const version=process.env.MAS_RUNNER_VERSION??'0.4.0',build=process.env.MAS_RUNNER_BUILD??'21';
if(!/^\d+\.\d+\.\d+$/.test(version)||!/^\d+$/.test(build))throw Error('Invalid Runner version or build number');
const origin=process.env.MAS_RUNNER_ORIGIN??'https://scrum.fruitbuddy.cn';
if(origin!=='https://scrum.fruitbuddy.cn'&&(!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin)||new URL(origin).origin!==origin))throw Error('Use the approved HTTPS origin or an explicit loopback HTTP port');
const filename=`MultiAgent-Scrum-Runner-${version}-macos-arm64.dmg`;
const output=resolve(process.env.MAS_RUNNER_OUTPUT??join(root,'dist/runner',filename));
if(basename(output)!==filename)throw Error(`Runner output filename must be ${filename}`);
await exec('xcrun',['--find','swiftc']);
const temp=await mkdtemp(join(tmpdir(),'mas-runner-source-build-'));
const appName='MultiAgent Scrum Runner.app',app=join(temp,appName);
const resources=join(app,'Contents/Resources'),macos=join(app,'Contents/MacOS');
const smokeHome=join(temp,'smoke-home'),stage=join(temp,'dmg-content');
const smokeEnv={HOME:smokeHome,TMPDIR:temp,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',DSH_HOME:join(smokeHome,'.dsh'),DSH_TELEMETRY_DISABLED:'1'};

async function withInput(file,args,input){
  const child=spawn(file,args,{cwd:resources,env:smokeEnv,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.on('error',()=>{});child.stdin.end(input);
  try{
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    if(code!==0)throw Error(`Packaged helper check failed: ${stderr.slice(0,1000)}`);
    return stdout;
  }finally{clearTimeout(timer);}
}

async function installRuntime(name){
  const destination=join(temp,name);
  await mkdir(destination);
  for(const file of ['package.json','package-lock.json'])await cp(join(root,'deploy/runner',name,file),join(destination,file));
  await exec('npm',['ci','--ignore-scripts','--omit=dev','--no-audit','--no-fund'],{cwd:destination,timeout:300000,maxBuffer:1024*1024});
  return destination;
}

try{
  await mkdir(resources,{recursive:true});await mkdir(macos);await mkdir(smokeHome,{mode:0o700});
  const nodePin=JSON.parse(await readFile(join(root,'deploy/runner/node-runtime.json'),'utf8'));
  const archiveName=`node-v${nodePin.version}-darwin-arm64.tar.gz`;
  if(!/^\d+\.\d+\.\d+$/.test(nodePin.version)||nodePin.url!==`https://nodejs.org/download/release/v${nodePin.version}/${archiveName}`||!/^[a-f0-9]{64}$/.test(nodePin.sha256)||!Number.isSafeInteger(nodePin.bytes)||nodePin.bytes<=0||nodePin.bytes>128*1024*1024)throw Error('Invalid pinned Node runtime');
  const cache=join(root,'.cache/runner');await mkdir(cache,{recursive:true});
  const archive=join(cache,archiveName);
  const matches=async()=>createHash('sha256').update(await readFile(archive)).digest('hex')===nodePin.sha256;
  if(!await matches().catch(()=>false)){
    const download=join(temp,archiveName);
    // Bounded range requests avoid CDN/proxy throttling of one large response.
    // Nothing is extracted until the combined official archive hash matches.
    const chunk=4*1024*1024,parts=[];
    for(let start=0;start<nodePin.bytes;start+=chunk)parts.push({start,end:Math.min(start+chunk,nodePin.bytes)-1,file:join(temp,`node-part-${start}`)});
    for(let index=0;index<parts.length;index+=4)await Promise.all(parts.slice(index,index+4).map(async part=>{
      await exec('/usr/bin/curl',['--fail','--location','--silent','--show-error','--retry','2','--connect-timeout','15','--max-time','60','--range',`${part.start}-${part.end}`,nodePin.url,'--output',part.file],{timeout:190000,maxBuffer:8192});
      if((await stat(part.file)).size!==part.end-part.start+1)throw Error('Node download range size mismatch');
    }));
    await writeFile(download,Buffer.concat(await Promise.all(parts.map(part=>readFile(part.file)))));
    if(createHash('sha256').update(await readFile(download)).digest('hex')!==nodePin.sha256)throw Error('Node runtime checksum mismatch');
    await cp(download,archive);
  }
  const nodeSource=join(temp,'node-source');await mkdir(nodeSource);
  await exec('/usr/bin/tar',['-xzf',archive,'-C',nodeSource,'--strip-components=1']);
  const node=join(resources,'node');await cp(join(nodeSource,'bin/node'),node);await chmod(node,0o755);
  await cp(join(nodeSource,'LICENSE'),join(resources,'Node-LICENSE.txt'));
  if((await exec(node,['--version'],{env:smokeEnv})).stdout.trim()!==`v${nodePin.version}`)throw Error('Node runtime version mismatch');

  // Only public, integrity-locked packages supply third-party runtimes.
  const codexInstall=await installRuntime('codex-runtime');
  const codexPackage=join(codexInstall,'node_modules/@openai/codex');
  const codexRuntime=join(resources,'codex-runtime');
  await cp(join(codexPackage,'vendor/aarch64-apple-darwin'),codexRuntime,{recursive:true,verbatimSymlinks:true});
  for(const name of ['package.json','package-lock.json'])await cp(join(codexInstall,name),join(codexRuntime,name));
  for(const name of await readdir(codexPackage))if(/^(LICENSE|NOTICE)(\.|$)/i.test(name))await cp(join(codexPackage,name),join(codexRuntime,name));
  const codexVersion=JSON.parse(await readFile(join(codexInstall,'package.json'),'utf8')).dependencies['@openai/codex'].replace(/-darwin-arm64$/,'');
  if((await exec(join(codexRuntime,'bin/codex'),['--version'],{env:smokeEnv})).stdout.trim()!==`codex-cli ${codexVersion}`)throw Error('Codex runtime version mismatch');

  const dshInstall=await installRuntime('dsh-runtime');
  const spawnHelper=join(dshInstall,'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
  // The pinned DSH postinstall only sets this permission. Do not run lifecycle scripts.
  await chmod(spawnHelper,0o755);
  await cp(dshInstall,join(resources,'dsh-runtime'),{recursive:true,verbatimSymlinks:true});
  for(const name of ['dsh-text-launch.mjs','dsh-text-guard.mjs'])await cp(join(root,'packages/executors',name),join(resources,name));
  for(const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md'])await cp(join(root,name),join(resources,name));
  await cp(join(root,'docs/licenses'),join(resources,'licenses'),{recursive:true});
  await cp(join(root,'node_modules/zod/LICENSE'),join(resources,'licenses/zod.txt'));

  await cp(join(root,'apps/runner-macos/Info.plist'),join(app,'Contents/Info.plist'));
  for(const [key,value] of [['CFBundleShortVersionString',version],['CFBundleVersion',build]])
    await exec('/usr/bin/plutil',['-replace',key,'-string',value,join(app,'Contents/Info.plist')]);
  const swiftFiles=(await readdir(join(root,'apps/runner-macos'))).filter(name=>name.endsWith('.swift')).sort().map(name=>join(root,'apps/runner-macos',name));
  if(!swiftFiles.length)throw Error('Native launcher source missing');
  await exec('xcrun',['swiftc','-O','-target','arm64-apple-macosx13.5','-module-cache-path',join(temp,'swift-cache'),'-framework','AppKit',...swiftFiles,'-o',join(macos,'MASRunner')],{timeout:180000,maxBuffer:1024*1024});
  await exec(join(root,'node_modules/.bin/rolldown'),['services/runner/launch-main.ts','--file',join(resources,'runner.mjs'),'--format','esm','--platform','node','--no-codeSplitting','--logLevel','warn'],{cwd:root});
  await writeFile(join(resources,'launch-config.json'),JSON.stringify({origin})+'\n');

  const iconset=join(temp,'AppIcon.iconset');await mkdir(iconset);
  for(const points of [16,32,128,256,512])for(const scale of [1,2])
    await sharp(join(root,'assets/multiagent-runner-icon.svg')).resize(points*scale,points*scale).png().toFile(join(iconset,`icon_${points}x${points}${scale===2?'@2x':''}.png`));
  await exec('/usr/bin/iconutil',['-c','icns',iconset,'-o',join(resources,'AppIcon.icns')]);
  await exec('/usr/bin/plutil',['-replace','CFBundleIconFile','-string','AppIcon',join(app,'Contents/Info.plist')]);
  await exec('/usr/bin/codesign',['--force','--deep','--sign','-',app],{timeout:120000,maxBuffer:16384});
  await exec('/usr/bin/codesign',['--verify','--deep','--strict',app],{timeout:60000});
  const status=JSON.parse(await withInput(node,[join(resources,'runner.mjs'),'setup'],'{"op":"status"}\n'));
  if(status?.state?.configured!==false||status?.operation!=='status')throw Error('Fresh-home Runner status check failed');
  const nativeCheck=await exec(join(macos,'MASRunner'),['--self-test'],{env:smokeEnv,timeout:30000,maxBuffer:16384});
  console.log(nativeCheck.stdout.trim());
  const dshVersion=(await exec(node,[join(resources,'dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),'--version'],{env:smokeEnv,cwd:smokeHome,timeout:30000,maxBuffer:16384})).stdout.trim();
  if(!dshVersion.includes('0.1.2-alpha.2'))throw Error('DSH runtime version check failed');

  await mkdir(stage);await cp(app,join(stage,appName),{recursive:true,verbatimSymlinks:true});await symlink('/Applications',join(stage,'Applications'));
  await exec('/usr/bin/codesign',['--verify','--deep','--strict',join(stage,appName)],{timeout:60000});
  await cp(join(resources,'AppIcon.icns'),join(stage,'.VolumeIcon.icns'));
  await exec('xcrun',['SetFile','-a','C',stage]);
  await cp(join(root,'scripts/helpers/Configure-Agent-API-Key.command'),join(stage,'Configure-Agent-API-Key.command'));
  await chmod(join(stage,'Configure-Agent-API-Key.command'),0o755);
  const image=join(temp,filename);
  console.log('Creating the DMG; copying and compressing the bundled runtimes can take several minutes.');
  await exec('/usr/bin/hdiutil',['create','-volname','MultiAgent Scrum Runner','-srcfolder',stage,'-format','UDZO','-imagekey','zlib-level=9',image],{timeout:1200000,maxBuffer:16384});
  await exec('/usr/bin/hdiutil',['verify',image],{timeout:300000,maxBuffer:4096});
  await mkdir(dirname(output),{recursive:true});
  const pending=join(dirname(output),'.'+filename+'.pending');await cp(image,pending);await rename(pending,output);
  const manifest=join(dirname(output),'runner-release.json');
  await writeFile(manifest+'.pending',JSON.stringify({filename,version,build})+'\n');await rename(manifest+'.pending',manifest);
  console.log(JSON.stringify({output,origin,version,build,nodeVersion:nodePin.version,codexVersion,dshVersion,bytes:(await stat(output)).size,status}));
}finally{await rm(temp,{recursive:true,force:true});}
