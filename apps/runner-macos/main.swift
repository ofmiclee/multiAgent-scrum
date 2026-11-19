// Copyright 2026 ofmiclee and contributors. Licensed under Apache-2.0.
// The native shell owns processes and local consent. The TypeScript Runner owns
// identity, authorization, credentials, execution, and durable workflow state.
import AppKit
import Foundation

enum RunnerError: Error { case configuration, process, response, cancelled }

struct RunnerBridge {
    let resources: URL
    let environment: [String: String]

    static func environment(home: String? = nil) -> [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        var result = [String: String]()
        for key in ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "MAS_TASK_ASSESSOR", "TYPESAFE_API_KEY", "TYPESAFE_MODEL"] {
            result[key] = inherited[key]
        }
        if let home { result["HOME"] = home }
        result["PATH"] = result["PATH"] ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        return result
    }

    static func loginURL(_ value: String) -> URL? {
        guard let url = URL(string: value), url.scheme == "https",
              ["auth.openai.com", "chatgpt.com"].contains(url.host ?? ""),
              url.user == nil, url.password == nil, url.port == nil else { return nil }
        return url
    }

    static func launchKind(_ url: URL) -> String? {
        guard url.absoluteString.utf8.count <= 2048, url.scheme == "mas-runner",
              url.user == nil, url.password == nil, url.port == nil,
              url.path.isEmpty, url.fragment == nil,
              ["connect", "account"].contains(url.host ?? "") else { return nil }
        // The JS boundary validates every query field, exact origin, and ticket
        // or local device identity before it reads credentials or makes requests.
        return url.host
    }

    func origin() throws -> URL {
        let data = try Data(contentsOf: resources.appendingPathComponent("launch-config.json"))
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["origin"] as? String, let url = URL(string: value),
              url.user == nil, url.password == nil, url.fragment == nil,
              url.query == nil, url.path.isEmpty,
              url.scheme == "https" || (url.scheme == "http" && url.host == "127.0.0.1") else { throw RunnerError.configuration }
        return url
    }

    func process(mode: String) -> Process {
        let process = Process()
        process.executableURL = resources.appendingPathComponent("node")
        process.arguments = [resources.appendingPathComponent("runner.mjs").path, mode]
        process.currentDirectoryURL = resources
        process.environment = environment
        process.standardError = FileHandle.nullDevice
        return process
    }

    func begin(_ mode: String, input: Data) throws -> (Process, Pipe) {
        guard input.count <= 8192 else { throw RunnerError.response }
        let process = process(mode: mode), output = Pipe(), stdin = Pipe()
        process.standardOutput = output
        process.standardInput = stdin
        try process.run()
        do {
            try stdin.fileHandleForWriting.write(contentsOf: input)
            try stdin.fileHandleForWriting.close()
        } catch {
            process.terminate()
            throw RunnerError.process
        }
        return (process, output)
    }

    static func collect(_ process: Process, output: Pipe, login: (URL) -> Void) throws -> [String: Any] {
        var pending = Data(), total = 0, result: [String: Any]?
        func consume(_ data: Data) throws {
            guard !data.isEmpty else { return }
            guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw RunnerError.response }
            if value["event"] as? String == "login-url" {
                guard let raw = value["url"] as? String, let url = loginURL(raw) else { throw RunnerError.response }
                login(url)
            } else {
                guard result == nil else { throw RunnerError.response }
                result = value
            }
        }
        do {
            while true {
                let chunk = output.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                total += chunk.count
                guard total <= 65536 else { throw RunnerError.response }
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 10) {
                    try consume(Data(pending[..<newline]))
                    pending.removeSubrange(...newline)
                }
            }
            try consume(pending)
            process.waitUntilExit()
            guard process.terminationStatus == 0, let result else { throw RunnerError.process }
            return result
        } catch {
            if process.isRunning { process.terminate() }
            throw error
        }
    }
}

final class RunnerApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let bridge: RunnerBridge
    private var item: NSStatusItem!
    private var worker: Process?, helper: Process?
    private var helperTimeout: DispatchWorkItem?
    private var stopped: (() -> Void)?
    private var changing = false, cancelling = false, timedOut = false, quitting = false, configured = false, initializing = true
    private var workerWasStopped = false
    private var pendingLink: URL?
    private var status = "正在检查本机状态…"

    init(resources: URL) { bridge = RunnerBridge(resources: resources, environment: RunnerBridge.environment()); super.init() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "MultiAgent Scrum Runner")
        item.button?.toolTip = "MultiAgent Scrum Runner"
        rebuildMenu()
        helperRequest(["op": "status"], quiet: true) { [weak self] value in
            guard let self else { return }
            self.initializing = false
            self.configured = (value?["state"] as? [String: Any])?["configured"] as? Bool ?? false
            self.status = value == nil ? "无法读取本机配置；请检查安装或文件权限" : (self.configured ? "Runner 已停止" : "请先在工作空间连接 Runner")
            if let link = self.pendingLink { self.pendingLink = nil; self.handle(link) }
            else if self.configured { self.startWorker() }
            self.rebuildMenu()
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard urls.count == 1, let url = urls.first else { return }
        if item == nil || initializing { pendingLink = url; return }
        handle(url)
    }

    private func menuItem(_ title: String, _ action: Selector?, key: String = "") -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: key)
        result.target = self
        return result
    }

    private func rebuildMenu() {
        guard item != nil else { return }
        let menu = NSMenu(); menu.autoenablesItems = false
        let heading = menuItem(status, nil); heading.isEnabled = false; menu.addItem(heading)
        menu.addItem(.separator())
        menu.addItem(menuItem("打开工作空间", #selector(openWorkspace), key: "o"))
        let toggle = menuItem(worker == nil ? "启动 Runner" : "停止 Runner", #selector(toggleWorker))
        toggle.isEnabled = configured && !changing && helper == nil; menu.addItem(toggle)
        let inspect = menuItem("查看本机状态…", #selector(inspectStatus))
        inspect.isEnabled = !changing && helper == nil; menu.addItem(inspect)
        menu.addItem(.separator())
        let accounts = menuItem("配置账号", nil), submenu = NSMenu(); submenu.autoenablesItems = false
        for (title, action) in [("使用本机 Codex 账号", #selector(useCodex)), ("切换本机 Codex 账号…", #selector(loginCodex)), ("添加 Codex API Key…", #selector(codexKey)), ("添加 DSH API Key…", #selector(dshKey)), ("断开 Codex 账号", #selector(disconnectCodex)), ("断开 DSH 账号", #selector(disconnectDsh))] {
            let command = menuItem(title, action); command.isEnabled = configured && !changing && helper == nil
            submenu.addItem(command)
        }
        accounts.submenu = submenu; menu.addItem(accounts)
        let bind = menuItem("绑定代码仓库…", #selector(bindRepository)); bind.isEnabled = configured && !changing && helper == nil
        menu.addItem(bind)
        if helper != nil { menu.addItem(menuItem("取消当前操作", #selector(cancelHelper))) }
        menu.addItem(.separator())
        menu.addItem(menuItem("退出 Runner", #selector(quit), key: "q"))
        item.menu = menu
    }

    @discardableResult private func alert(_ title: String, _ detail: String, buttons: [String] = ["好"], accessory: NSView? = nil) -> NSApplication.ModalResponse {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.alertStyle = .informational; alert.accessoryView = accessory
        for title in buttons { alert.addButton(withTitle: title) }
        NSApp.activate(ignoringOtherApps: true)
        if let field = accessory as? NSTextField { alert.window.initialFirstResponder = field }
        return alert.runModal()
    }

    private func helperRequest(_ request: [String: Any], quiet: Bool = false, completion: @escaping ([String: Any]?) -> Void) {
        guard let input = try? JSONSerialization.data(withJSONObject: request) else { completion(nil); return }
        helperCommand("setup", input: input, timeout: request["action"] as? String == "login" || request["action"] as? String == "switch-account" ? 300 : 30, quiet: quiet, completion: completion)
    }

    private func helperCommand(_ mode: String, input: Data, timeout: TimeInterval = 30, quiet: Bool = false, completion: @escaping ([String: Any]?) -> Void) {
        guard helper == nil, !quitting else { completion(nil); return }
        do {
            let (process, output) = try bridge.begin(mode, input: input)
            helper = process; cancelling = false; timedOut = false; status = "正在处理本机操作…"; rebuildMenu()
            let deadline = DispatchWorkItem { [weak self, weak process] in
                guard let self, let process, self.helper === process else { return }
                self.timedOut = true
                if process.isRunning { process.terminate() }
                self.status = "操作已超时，正在停止…"; self.rebuildMenu()
            }
            helperTimeout = deadline; DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: deadline)
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let result = try? RunnerBridge.collect(process, output: output) { url in
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.helper === process, !self.cancelling, !self.quitting else { return }
                        NSWorkspace.shared.open(url)
                        self.status = "等待浏览器登录；可在菜单中取消"; self.rebuildMenu()
                    }
                }
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.helperTimeout?.cancel(); self.helperTimeout = nil; self.helper = nil
                    let success = result?["ok"] as? Bool == true && !self.cancelling && !self.timedOut && !self.quitting
                    self.status = self.worker == nil ? (self.configured ? "Runner 已停止" : "请先在工作空间连接 Runner") : "Runner 运行中"
                    if !success && !quiet && !self.cancelling && !self.quitting {
                        self.alert("操作未完成", "请检查本机账号、待处理任务或服务连接后重试。Runner 不会自动清空本机身份与记录。")
                    }
                    completion(success ? result : nil)
                    self.rebuildMenu(); self.finishQuit()
                }
            }
        } catch {
            if !quiet { alert("无法启动本机服务", "请确认 Runner 安装完整，并从可写入的本机磁盘启动。") }
            completion(nil)
        }
    }

    private func startWorker() {
        guard worker == nil, helper == nil, configured, !quitting else { return }
        let process = bridge.process(mode: "run")
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                guard let self, self.worker === ended else { return }
                self.worker = nil
                self.status = ended.terminationStatus == 0 || self.workerWasStopped ? "Runner 已停止" : "Runner 已停止，请检查连接后重新启动"
                self.workerWasStopped = false
                let next = self.stopped; self.stopped = nil; next?()
                self.rebuildMenu(); self.finishQuit()
            }
        }
        do { try process.run(); worker = process; status = "Runner 运行中" }
        catch { status = "无法启动 Runner；请检查安装" }
        rebuildMenu()
    }

    private func stopWorker(_ completion: @escaping () -> Void) {
        guard let worker else { completion(); return }
        stopped = completion; workerWasStopped = true
        status = "正在停止接单与本机执行…"; rebuildMenu()
        if worker.isRunning { worker.terminate() }
    }

    private func change(_ action: @escaping (@escaping () -> Void) -> Void, confirm: Bool = true) {
        guard !changing, helper == nil, !quitting else { return }
        if confirm && worker != nil && alert("暂停 Runner 后继续？", "配置变更会先停止接单，并请求停止当前本机执行。只有安全停止后才会继续；完成后恢复连接。", buttons: ["继续", "取消"]) != .alertFirstButtonReturn { return }
        changing = true; let resume = worker != nil
        stopWorker { [weak self] in
            guard let self else { return }
            action {
                self.changing = false
                if resume { self.startWorker() }
                self.rebuildMenu()
            }
        }
    }

    private func account(_ provider: String, action: String) {
        if provider == "codex-code" && action == "switch-account" {
            guard alert("切换本机 Codex 共享账号？", "此操作会退出并更换本机 Codex 的共享账号，也会影响使用该账号的其他 Codex 客户端。若要保留现有共享账号，请取消并选择添加独立 API Key。", buttons: ["切换账号", "取消"]) == .alertFirstButtonReturn else { return }
        }
        change { done in
            self.helperRequest(["op": "prepare-account", "provider": provider]) { prepared in
                guard prepared?["installed"] as? Bool == true else {
                    if prepared != nil { self.alert("执行器尚未安装", "请安装对应执行器或重新安装完整 Runner，然后重试。") }
                    done(); return
                }
                self.helperRequest(["op": "account", "provider": provider, "action": action]) { value in
                    if let account = value?["account"] as? [String: Any] {
                        let label = account["accountLabel"] as? String ?? ""
                        self.alert("账号状态已更新", (account["status"] as? String ?? "") + (label.isEmpty ? "" : "\n" + label))
                    }
                    done()
                }
            }
        }
    }

    private func apiKey(_ provider: String) {
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.placeholderString = "API Key"; field.setAccessibilityLabel("API Key")
        guard alert("添加 \(provider == "codex-code" ? "Codex" : "DSH") API Key", "密钥只保存在本机独立账号目录，通过标准输入传给 Runner，不上传到工作空间。", buttons: ["保存", "取消"], accessory: field) == .alertFirstButtonReturn else { field.stringValue = ""; return }
        let key = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines); field.stringValue = ""
        guard !key.isEmpty, key.utf8.count <= 1024 else { alert("API Key 无效", "请输入有效的 API Key 后重试。"); return }
        change { done in
            self.helperRequest(["op": provider == "codex-code" ? "codex-key" : "dsh-key", "apiKey": key]) { value in
                if value != nil { self.alert("账号已保存", "返回工作空间刷新账号列表，并选择需要授权的 Agent。") }
                done()
            }
        }
    }

    private func handle(_ url: URL) {
        guard let kind = RunnerBridge.launchKind(url) else { alert("Runner 链接无效", "请返回工作空间重新发起连接。"); return }
        guard !changing, helper == nil else { alert("本机操作正在进行", "请完成或取消当前操作，再从工作空间重试。"); return }
        if kind == "account" {
            helperRequest(["op": "account-entry", "url": url.absoluteString]) { value in
                guard let provider = value?["provider"] as? String else { return }
                if provider == "dsh-text" { self.apiKey(provider); return }
                let choice = self.alert("配置 Codex 账号", "使用已有的本机账号、切换本机共享账号，或添加独立 API Key。切换共享账号会影响其他 Codex 客户端，下一步会再次确认。", buttons: ["使用本机账号", "切换本机账号", "添加 API Key", "取消"])
                if choice == .alertFirstButtonReturn { self.account(provider, action: "use-local") }
                else if choice == .alertSecondButtonReturn { self.account(provider, action: "switch-account") }
                else if choice == .alertThirdButtonReturn { self.apiKey(provider) }
            }
            return
        }
        guard let origin = try? bridge.origin(), alert("连接此 Runner？", "将连接到 \(origin.absoluteString)。随后请在浏览器核对本机验证码；该连接不会自动授权 Agent 执行任务。", buttons: ["连接", "取消"]) == .alertFirstButtonReturn else { return }
        change({ done in
            self.helperCommand("attach", input: Data(url.absoluteString.utf8)) { value in
                if let code = value?["verificationCode"] as? String, let id = value?["launchId"] as? String,
                   UUID(uuidString: id) != nil {
                    self.configured = true
                    self.alert("请在工作空间确认连接", "本机验证码：\(code)\n请与浏览器中显示的验证码核对。")
                    if let destination = URL(string: origin.absoluteString + "/#runner-connect=" + id) { NSWorkspace.shared.open(destination) }
                }
                done()
                if value != nil { self.startWorker() }
            }
        }, confirm: true)
    }

    @objc private func openWorkspace() { if let origin = try? bridge.origin() { NSWorkspace.shared.open(origin) } }
    @objc private func toggleWorker() {
        if worker == nil { startWorker() }
        else {
            guard alert("停止 Runner？", "停止接单，并请求安全停止当前本机执行。工作空间中的任务记录会保留。", buttons: ["停止", "取消"]) == .alertFirstButtonReturn else { return }
            changing = true
            stopWorker { [weak self] in self?.changing = false; self?.rebuildMenu() }
        }
    }
    @objc private func inspectStatus() {
        helperRequest(["op": "status"]) { value in
            guard let state = value?["state"] as? [String: Any] else { return }
            let profiles = state["profiles"] as? [String] ?? []
            let journal = state["journal"] as? String ?? "unknown"
            self.alert("本机 Runner 状态", "已连接工作空间：\((state["configured"] as? Bool ?? false) ? "是" : "否")\n执行器：\(profiles.isEmpty ? "尚未配置" : profiles.joined(separator: "、"))\n任务记录：\(journal)\n运行中仅表示本机进程已启动，在线状态请以工作空间为准。")
        }
    }
    @objc private func useCodex() { account("codex-code", action: "use-local") }
    @objc private func loginCodex() { account("codex-code", action: "switch-account") }
    @objc private func codexKey() { apiKey("codex-code") }
    @objc private func dshKey() { apiKey("dsh-text") }
    @objc private func disconnectCodex() { account("codex-code", action: "disconnect") }
    @objc private func disconnectDsh() { account("dsh-text", action: "disconnect") }
    @objc private func bindRepository() {
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        let project = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24)), ref = NSTextField(frame: project.frame)
        project.placeholderString = "项目 UUID"; project.setAccessibilityLabel("项目 UUID")
        ref.stringValue = "HEAD"; ref.setAccessibilityLabel("Git 引用")
        stack.addArrangedSubview(NSTextField(labelWithString: "项目 UUID")); stack.addArrangedSubview(project)
        stack.addArrangedSubview(NSTextField(labelWithString: "已提交的 Git 引用")); stack.addArrangedSubview(ref)
        stack.frame = NSRect(x: 0, y: 0, width: 360, height: 112)
        guard alert("绑定代码仓库", "选择项目和已经提交的本地 Git 仓库。绑定不会改变项目权限或自动授权执行。", buttons: ["选择仓库…", "取消"], accessory: stack) == .alertFirstButtonReturn else { return }
        guard let id = UUID(uuidString: project.stringValue), !ref.stringValue.isEmpty else { alert("项目信息无效", "请输入完整项目 UUID 和有效的 Git 引用。"); return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false; panel.prompt = "绑定仓库"
        guard panel.runModal() == .OK, let repository = panel.url else { return }
        change { done in
            self.helperRequest(["op": "bind-code", "projectId": id.uuidString.lowercased(), "repository": repository.path, "ref": ref.stringValue]) { value in
                if value != nil { self.alert("仓库已绑定", "返回工作空间检查 Agent 授权和项目配置。") }
                done()
            }
        }
    }
    @objc private func cancelHelper() { cancelling = true; if helper?.isRunning == true { helper?.terminate() } }
    @objc private func quit() { NSApp.terminate(self) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if worker == nil && helper == nil { return .terminateNow }
        quitting = true; changing = true; cancelHelper()
        stopWorker { [weak self] in self?.finishQuit() }
        return .terminateLater
    }
    private func finishQuit() { if quitting && worker == nil && helper == nil { NSApp.reply(toApplicationShouldTerminate: true) } }
}

func selfTest(resources: URL) throws {
    // This mode always creates its own private HOME, regardless of the caller.
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("mas-native-check-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: home) }
    let bridge = RunnerBridge(resources: resources, environment: ["HOME": home.path, "PATH": "/usr/bin:/bin", "TMPDIR": home.path])
    guard RunnerBridge.loginURL("https://auth.openai.com/authorize") != nil,
          RunnerBridge.loginURL("https://auth.openai.com.evil.test/authorize") == nil,
          RunnerBridge.loginURL("https://user@chatgpt.com/authorize") == nil,
          RunnerBridge.launchKind(URL(string: "mas-runner://connect?server=x&ticket=x")!) == "connect",
          RunnerBridge.launchKind(URL(string: "mas-runner://connect/path?server=x")!) == nil else { throw RunnerError.configuration }
    _ = try bridge.origin()
    let (capability, capabilityOutput) = try bridge.begin("capabilities", input: Data())
    let capabilities = try RunnerBridge.collect(capability, output: capabilityOutput) { _ in }
    guard capabilities["apiKeyCatalog"] as? Int == 1 else { throw RunnerError.response }
    let input = try JSONSerialization.data(withJSONObject: ["op": "status"])
    let (status, output) = try bridge.begin("setup", input: input)
    let result = try RunnerBridge.collect(status, output: output) { _ in }
    guard result["ok"] as? Bool == true, let state = result["state"] as? [String: Any], state["configured"] as? Bool == false else { throw RunnerError.response }
    // A fresh worker exits without creating an identity or contacting a server.
    let worker = bridge.process(mode: "run")
    worker.standardInput = FileHandle.nullDevice; worker.standardOutput = FileHandle.nullDevice
    try worker.run(); worker.waitUntilExit()
    guard worker.terminationStatus == 0,
          !FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support/MultiAgent-Scrum/runner/identity.json").path) else { throw RunnerError.process }
    print("Native Runner self-test passed: URL guards, bundled helpers, isolated status, fresh worker lifecycle.")
}

guard let resources = Bundle.main.resourceURL else { fputs("Runner resources unavailable.\n", stderr); exit(1) }
if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] {
    do { try selfTest(resources: resources) }
    catch { fputs("Native Runner self-test failed.\n", stderr); exit(1) }
} else {
    guard CommandLine.arguments.count == 1 else { fputs("Unsupported Runner argument.\n", stderr); exit(1) }
    let app = NSApplication.shared, delegate = RunnerApp(resources: resources)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
