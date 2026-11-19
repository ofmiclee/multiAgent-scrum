#!/bin/zsh
set -eu
unsetopt XTRACE VERBOSE
app='/Applications/MultiAgent Scrum Runner.app'
if [[ ! -d "$app" ]]; then app="$HOME/Applications/MultiAgent Scrum Runner.app"; fi
resources="$app/Contents/Resources"
if [[ ! -x "$resources/node" || ! -f "$resources/runner.mjs" ]]; then
  /usr/bin/osascript -e 'display dialog "请先安装 MultiAgent Scrum Runner，再运行此工具。" buttons {"好"} default button "好"'
  exit 1
fi
if [[ "$("$resources/node" "$resources/runner.mjs" capabilities 2>/dev/null)" != '{"apiKeyCatalog":1}' ]]; then
  /usr/bin/osascript -e 'display dialog "当前 Runner 版本不支持多个 API Key。请先安装网页提供的最新版 Runner，再运行此工具。" buttons {"好"} default button "好"'
  exit 1
fi
choice=$(/usr/bin/osascript -e 'set result to choose from list {"Codex", "DSH"} with title "新增 Agent API Key" with prompt "选择 API Key 所属的 Agent 类型"' -e 'if result is false then error number -128' -e 'return item 1 of result') || exit 0
if [[ "$choice" == 'Codex' ]]; then mode='codex-key'; else mode='dsh-key'; fi
label=$(/usr/bin/osascript -e 'text returned of (display dialog "为这个 API Key 命名，以便在 Agent 设置中选择。" default answer "" buttons {"取消", "继续"} default button "继续")') || exit 0
key=$(/usr/bin/osascript -e 'text returned of (display dialog "请先退出 Runner，再输入 API Key。密钥只保存在本机。" default answer "" with hidden answer buttons {"取消", "保存"} default button "保存")') || exit 0
if ! /bin/printf '%s' "$key" | MAS_KEY_LABEL="$label" "$resources/node" "$resources/runner.mjs" "$mode" >/dev/null; then
  unset key
  /usr/bin/osascript -e 'display dialog "配置未完成。请确认 Runner 已退出、已连接本机，然后重试。原有凭据未被替换。" buttons {"好"} default button "好"'
  exit 1
fi
unset key
/usr/bin/open -a "$app"
/usr/bin/osascript -e 'display dialog "API Key 已添加。返回网页刷新后，可在 Agent 中选择这个凭据。" buttons {"好"} default button "好"'
