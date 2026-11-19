import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

// Never replace an existing container or delete a volume. This helper is local-only.
const name = "mas-next-local-pg";
const probe = spawnSync(
  "docker",
  ["inspect", "--format", '{{index .Config.Labels "app"}}', name],
  { encoding: "utf8" },
);
if (probe.error)
  throw new Error("Docker is unavailable. Start Docker Desktop first.");
if (probe.status === 0) {
  if (probe.stdout.trim() !== "multiagent-scrum-next")
    throw new Error(
      "Container name is in use by a different application; refusing to modify it.",
    );
  execFileSync("docker", ["start", name], { stdio: "inherit" });
} else
  execFileSync("docker", ["compose", "up", "-d", "--wait", "postgres"], {
    stdio: "inherit",
  });
for (let i = 0; i < 30; i++) {
  if (
    spawnSync(
      "docker",
      ["exec", name, "pg_isready", "-U", "mas_local", "-d", "mas_next"],
      { stdio: "ignore" },
    ).status === 0
  ) {
    console.log(
      "Project PostgreSQL ready on 127.0.0.1:55439; existing data preserved.",
    );
    process.exit(0);
  }
  await setTimeout(1000);
}
throw new Error(
  "PostgreSQL did not become ready. Inspect this project container without removing its volume.",
);
