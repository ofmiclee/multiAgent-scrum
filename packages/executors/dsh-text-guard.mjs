// Independent product policy plugin; no upstream implementation is copied.
export const name = 'mas-text-policy';
export const inject = ['tools', 'credentials'];
export async function apply(ctx, config = {mode: 'text'}) {
  const code = config.mode === 'code';
  if (!code && ctx.tools.schemas().length !== 0) throw new Error('MAS text runtime must have no tools');
  const credential = await ctx.credentials.describe('DEEPSEEK_API_KEY');
  if (!credential.configured) throw new Error('MAS text runtime credential is not configured');
  let requests = 0;
  ctx.on('agent/request', async (_request, next) => {
    if (++requests > (code ? 128 : 1) || (!code && ctx.tools.schemas().length !== 0))
      throw new Error('MAS runtime request budget or tool policy rejected');
    return next();
  });
  if (!code)ctx.on('tools/pre-execute', async () => ({kind: 'deny', reason: 'MAS text runtime does not allow tools'}));
  ctx.provide('masTextPolicy', {ready: true});
}
