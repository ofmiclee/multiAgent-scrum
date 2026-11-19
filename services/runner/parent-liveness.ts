/** The packaged macOS app owns this worker. If the app is force-quit, its
 * Node child can be reparented to launchd and otherwise keep heartbeating.
 * Abort the connection so the server removes its session immediately. */
export function watchRunnerParent(stop:AbortController,options:{parentPid?:number;readParentPid?:()=>number;intervalMs?:number}={}){
  const parentPid=options.parentPid??process.ppid;
  const readParentPid=options.readParentPid??(()=>process.ppid);
  if(parentPid<=1){stop.abort();return ()=>{};}
  const timer=setInterval(()=>{
    if(readParentPid()===parentPid)return;
    clearInterval(timer);
    stop.abort();
  },options.intervalMs??1000);
  timer.unref();
  return ()=>clearInterval(timer);
}
