export const macRunnerDownload='/downloads/MultiAgent-Scrum-Runner-macos-arm64.dmg';

export function runnerDownloadFor(userAgent:string,maxTouchPoints=0){
  if(/Windows/i.test(userAgent))return {label:'Windows 安装包尚未提供',href:null};
  if(/Linux/i.test(userAgent)&&!/Android/i.test(userAgent))return {label:'Linux 安装包尚未提供',href:null};
  if(/Macintosh|Mac OS X/i.test(userAgent)&&maxTouchPoints<2)return {label:'下载 macOS 安装包（Apple 芯片 · .dmg）',href:macRunnerDownload};
  return {label:'当前系统暂无 Runner 安装包',href:null};
}

export default function RunnerDownload({className='text-button'}:{className?:string}){
  const download=runnerDownloadFor(navigator.userAgent,navigator.maxTouchPoints);
  return download.href?<a className={className} href={download.href} download>{download.label}</a>:<span className="field-hint" role="status">{download.label}</span>;
}
