// Executed inside the write/fork-restricted runtime, not in the control plane.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const {cli, home, work, scratch} = JSON.parse(await readFile(process.argv[2], 'utf8'));
// Do not import DSH until its launch environment is replaced. The CLI's .env and
// patch lookup now sees only the fresh attempt directory, never the user's home.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', TMPDIR: scratch, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8'});
process.chdir(work);
process.argv = [process.execPath, cli, '--profile', 'mas-text'];
await import(pathToFileURL(cli).href);
