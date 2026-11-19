export type GithubRelay={origin:string;key:string};

/** Operator-owned destination, never selected by an HTTP request. */
export function githubRelayConfig(env:NodeJS.ProcessEnv):GithubRelay|undefined{
  const origin=env.MAS_GITHUB_RELAY_ORIGIN,key=env.MAS_GITHUB_RELAY_KEY;
  if(origin===undefined&&key===undefined)return undefined;
  if(origin!=='https://hub.xinmiyun.cn:8443'||!key||!/^[a-f0-9]{64}$/.test(key))
    throw Error('GitHub relay configuration invalid');
  return {origin,key};
}
