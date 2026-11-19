/** Dedicated development database only. Never consume DATABASE_URL or PG* env. */
export function localIdentityConfig(env:NodeJS.ProcessEnv=process.env) {
  if(env.NODE_ENV==='production')throw Error('Local identity is disabled in production');
  const raw=env.MAS_IDENTITY_PORT??'4399';
  if(!/^\d{4,5}$/.test(raw)||Number(raw)<1024||Number(raw)>65535)throw Error('Invalid local identity port');
  const port=Number(raw);
  return {
    port,origin:`http://127.0.0.1:${port}`,
    database:{host:'127.0.0.1',port:55439,database:'mas_next',user:'mas_local',password:'mas_local_dev_only',
      options:'-c search_path=mas_identity_local',max:5,connectionTimeoutMillis:3000,statement_timeout:5000},
  };
}
