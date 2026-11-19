import {createServer,type IncomingMessage,type ServerResponse,type ServerOptions} from 'node:http';

/** Socket closure is not application completion. Keep dependencies alive until
 * all accepted operations settle, including work whose caller disconnected. */
export function createDrainingHttpServer(
  handle:(request:IncomingMessage,response:ServerResponse)=>Promise<void>,
  options:ServerOptions={},
){
  const active=new Set<Promise<void>>();
  let closing=false,closed:Promise<void>|undefined;
  const server=createServer(options,(request,response)=>{
    if(closing){request.resume();response.writeHead(503,{Connection:'close'});response.end();return;}
    const work=Promise.resolve().then(()=>handle(request,response)).catch(()=>{
      // Do not expose request data, provider errors or credentials on shutdown.
      request.resume();response.destroy();
    });
    active.add(work);
    void work.then(()=>active.delete(work));
  });
  const close=()=>{
    if(closed)return closed;
    closing=true;
    closed=(async()=>{
      const socketsClosed=new Promise<void>(resolve=>{server.close(()=>resolve());});
      server.closeAllConnections();
      await socketsClosed;
      await Promise.all(active);
    })();
    return closed;
  };
  return {server,close};
}
