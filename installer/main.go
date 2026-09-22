//go:build windows

package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const port = 17891
const (
	mbOK            = 0x00000000
	mbYesNo         = 0x00000004
	mbIconInfo      = 0x00000040
	mbIconQuestion  = 0x00000020
	mbIconError     = 0x00000010
	idYes           = 6
	createNoWindow  = 0x08000000
	detachedProcess = 0x00000008
)

//go:embed payload
var payload embed.FS

// The staged payload receives VERSION.txt from the repository VERSION before
// the installer is compiled. Reading it from the embedded payload keeps the
// installer, Agent Host health endpoint, and release metadata on one source of
// truth instead of duplicating a release string in Go.
var version = embeddedVersion()

func embeddedVersion() string {
	b, err := payload.ReadFile("payload/app/VERSION.txt")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(b))
}

func messageBox(text, title string, flags uint32) int {
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	r, _, _ := proc.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(flags))
	return int(r)
}

func runHidden(name string, args ...string) error {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return c.Run()
}

func outputHidden(name string, args ...string) ([]byte, error) {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return c.Output()
}

func installBase() (string, string, error) {
	local := os.Getenv("LOCALAPPDATA")
	roaming := os.Getenv("APPDATA")
	if local == "" || roaming == "" {
		return "", "", fmt.Errorf("无法读取 LOCALAPPDATA / APPDATA")
	}
	return filepath.Join(local, "DataReportAssistant"), filepath.Join(roaming, "kingsoft", "wps", "jsaddons"), nil
}

func extractPayload(appDir string) error {
	if err := os.MkdirAll(appDir, 0755); err != nil {
		return err
	}
	if compressed, err := payload.ReadFile("payload/payload.zip"); err == nil {
		return extractZipPayload(compressed, appDir, nil)
	}
	return fs.WalkDir(payload, "payload/app", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == "payload/app" {
			return nil
		}
		rel := strings.TrimPrefix(p, "payload/app/")
		dst := filepath.Join(appDir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(dst, 0755)
		}
		b, err := payload.ReadFile(p)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			return err
		}
		return replaceInstalledFile(dst, b, 0644)
	})
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	return replaceInstalledFile(dst, b, 0755)
}

func regAdd(key, name, value, typ string) error {
	args := []string{"add", key, "/v", name, "/t", typ, "/d", value, "/f"}
	return runHidden("reg.exe", args...)
}
func regDeleteValue(key, name string) { _ = runHidden("reg.exe", "delete", key, "/v", name, "/f") }
func regDeleteKey(key string)         { _ = runHidden("reg.exe", "delete", key, "/f") }

func setupRegistry(appDir string) error {
	core := filepath.Join(appDir, "runtime", "node.exe")
	uninst := filepath.Join(appDir, "Uninstall.exe")
	runKey := `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	if err := regAdd(runKey, "DataReportAssistantCore", `"`+uninst+`" --start-agent`, "REG_SZ"); err != nil {
		return err
	}
	ukey := `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DataReportAssistant`
	vals := [][3]string{
		{"DisplayName", "数据报告助手", "REG_SZ"},
		{"DisplayVersion", version, "REG_SZ"},
		{"Publisher", "Data Report Assistant", "REG_SZ"},
		{"InstallLocation", appDir, "REG_SZ"},
		{"UninstallString", `"` + uninst + `" --uninstall`, "REG_SZ"},
		{"DisplayIcon", core, "REG_SZ"},
		{"NoModify", "1", "REG_DWORD"},
		{"NoRepair", "1", "REG_DWORD"},
	}
	for _, v := range vals {
		if err := regAdd(ukey, v[0], v[1], v[2]); err != nil {
			return err
		}
	}
	return nil
}

func health() (map[string]any, bool) {
	cl := &http.Client{Timeout: 900 * time.Millisecond}
	r, err := cl.Get("http://127.0.0.1:17891/api/health")
	if err != nil {
		return nil, false
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, false
	}
	var m map[string]any
	if json.NewDecoder(r.Body).Decode(&m) != nil {
		return nil, false
	}
	return m, m["ok"] == true
}

func captureOldState(dataRoot string) {
	if _, err := os.Stat(filepath.Join(dataRoot, "state.json")); err == nil {
		return
	}
	healthBody, ok := health()
	if !ok {
		return
	}
	cl := &http.Client{Timeout: 1500 * time.Millisecond}
	request, _ := http.NewRequest("GET", "http://127.0.0.1:17891/api/projects?full=1", nil)
	if token, ok := healthBody["token"].(string); ok && token != "" {
		request.Header.Set("X-RA-Token", token)
	}
	r, err := cl.Do(request)
	if err != nil {
		return
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return
	}
	var body struct {
		Projects []any `json:"projects"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		return
	}
	state := map[string]any{"version": 1, "projects": body.Projects}
	b, _ := json.MarshalIndent(state, "", "  ")
	_ = os.MkdirAll(dataRoot, 0755)
	_ = os.WriteFile(filepath.Join(dataRoot, "state.json"), b, 0644)
}

func openCoreLog(dataDir string) (io.Writer, func(), string, error) {
	paths := []string{
		filepath.Join(os.TempDir(), "DataReportAssistant-core.log"),
		filepath.Join(dataDir, "core.log"),
	}
	var lastErr error
	var files []*os.File
	var opened []string
	for _, path := range paths {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			lastErr = err
			continue
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err == nil {
			files = append(files, file)
			opened = append(opened, path)
			continue
		}
		lastErr = err
	}
	if len(files) == 0 {
		return nil, func() {}, strings.Join(paths, "、"), fmt.Errorf("无法创建 Core 日志：%w", lastErr)
	}
	writers := make([]io.Writer, 0, len(files))
	for _, file := range files {
		writers = append(writers, file)
	}
	closeLogs := func() {
		for _, file := range files {
			_ = file.Close()
		}
	}
	return io.MultiWriter(writers...), closeLogs, strings.Join(opened, "、"), nil
}

func startCore(appDir string) error {
	core := filepath.Join(appDir, "runtime", "node.exe")
	c := exec.Command(core, filepath.Join(appDir, "agent-host", "dist", "agent-host", "src", "main.js"))
	c.Env = append(os.Environ(), "REPORT_ASSISTANT_ASSET_DIR="+filepath.Join(appDir, "addins"), "REPORT_ASSISTANT_DATA_DIR="+filepath.Join(filepath.Dir(appDir), "data"))
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow | detachedProcess}
	// Keep a real log file for startup/runtime failures. Write a second copy to
	// the user's temp directory so diagnostics remain readable even if an ACL on
	// the installation data directory is unexpectedly restrictive.
	dataDir := filepath.Join(filepath.Dir(appDir), "data")
	logWriter, closeLogs, logPath, err := openCoreLog(dataDir)
	if err != nil {
		return err
	}
	c.Stdout = logWriter
	c.Stderr = logWriter
	defer closeLogs()
	if err := c.Start(); err != nil {
		return fmt.Errorf("启动 Core 失败：%w；日志：%s", err, logPath)
	}
	// The first launch may be delayed by extraction and antivirus inspection of
	// the bundled Node runtime. Do not report a false failure after only 5s.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		if result, ok := health(); ok && result["version"] == version {
			return nil
		}
	}
	return fmt.Errorf("Core 未能在 127.0.0.1:%d 启动；日志：%s", port, logPath)
}

func grantDataAccess(dataDir, uid string) error {
	principal := "*" + uid
	if err := runHidden("icacls.exe", dataDir, "/inheritance:r", "/grant:r", principal+":(OI)(CI)F", "/T", "/C"); err != nil {
		return fmt.Errorf("无法设置当前用户数据目录权限：%w", err)
	}
	// Existing files can have a protected empty DACL. Explicitly grant the
	// user on every item as well; inheritance-only ACLs do not repair those.
	if err := runHidden("icacls.exe", dataDir, "/grant:r", principal+":F", "/T", "/C"); err != nil {
		return fmt.Errorf("无法修复当前用户数据文件权限：%w", err)
	}
	return nil
}

func verifyDataReadable(dataDir string) error {
	state := filepath.Join(dataDir, "state.json")
	if _, err := os.Stat(state); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("无法检查项目数据文件：%w", err)
	}
	file, err := os.Open(state)
	if err != nil {
		return fmt.Errorf("无法读取项目数据文件 %s；请检查文件 ACL 或安全软件：%w", state, err)
	}
	if err = file.Close(); err != nil {
		return fmt.Errorf("无法关闭项目数据文件：%w", err)
	}
	return nil
}

func install() error {
	base, jsaddons, err := installBase()
	if err != nil {
		return err
	}
	appDir := filepath.Join(base, "app")
	dataDir := filepath.Join(base, "data")
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return err
	}
	currentUser, err := user.Current()
	if err != nil {
		return err
	}
	if err = grantDataAccess(dataDir, currentUser.Uid); err != nil {
		return err
	}
	captureOldState(dataDir)
	if err := stopCoreIfOurs(appDir); err != nil {
		return err
	}
	if err = grantDataAccess(dataDir, currentUser.Uid); err != nil {
		return err
	}
	if err = verifyDataReadable(dataDir); err != nil {
		return err
	}
	if err = extractPayload(appDir); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if err = copyFile(self, filepath.Join(appDir, "Uninstall.exe")); err != nil {
		return err
	}
	if err = mergePublish(filepath.Join(jsaddons, "publish.xml"), true); err != nil {
		return err
	}
	if err = setupRegistry(appDir); err != nil {
		return err
	}
	if err := startCore(appDir); err != nil {
		return fmt.Errorf("文件已安装，但 %w", err)
	}
	_ = os.WriteFile(filepath.Join(base, "installed-version.txt"), []byte(version), 0644)
	return nil
}

func uninstall() error {
	base, jsaddons, err := installBase()
	if err != nil {
		return err
	}
	appDir := filepath.Join(base, "app")
	if err := stopCoreIfOurs(appDir); err != nil {
		return err
	}
	_ = mergePublish(filepath.Join(jsaddons, "publish.xml"), false)
	regDeleteValue(`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, "DataReportAssistantCore")
	regDeleteKey(`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DataReportAssistant`)
	// 保留 base/data，避免卸载误删项目。延迟删除正在运行的卸载器所在 app 目录。
	cmd := exec.Command("cmd.exe", "/C", "ping 127.0.0.1 -n 2 >nul & rmdir /S /Q \""+appDir+"\"")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow | detachedProcess}
	_ = cmd.Start()
	return nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--start-agent" {
		executable, err := os.Executable()
		if err == nil {
			_ = startCore(filepath.Dir(executable))
		}
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "--uninstall" {
		if messageBox("将卸载“数据报告助手”的程序与 WPS 插件注册。\n\n项目数据会保留，重新安装后可继续使用。\n\n是否继续？", "卸载数据报告助手", mbYesNo|mbIconQuestion) != idYes {
			return
		}
		if err := uninstall(); err != nil {
			messageBox("卸载失败：\n"+err.Error(), "数据报告助手", mbOK|mbIconError)
			return
		}
		messageBox("卸载完成。项目数据已保留。\n\n如果 WPS 正在运行，请重新启动 WPS。", "数据报告助手", mbOK|mbIconInfo)
		return
	}
	if messageBox("安装“数据报告助手” v"+version+"？\n\n• 无需安装 Node.js\n• 无需安装 wpsjs\n• 无需管理员权限\n• 不会覆盖其他 WPS 加载项\n\n如果 WPS 正在运行，安装后需要完全退出并重新打开 WPS。", "数据报告助手安装", mbYesNo|mbIconQuestion) != idYes {
		return
	}
	if err := install(); err != nil {
		messageBox("安装失败：\n\n"+err.Error(), "数据报告助手安装", mbOK|mbIconError)
		return
	}
	messageBox("安装完成。\n\n请完全退出并重新打开 WPS。\n在 WPS 表格 / 文字 / 演示顶部会看到“数据报告助手”。\n\n以后无需运行任何命令，Core 会随 Windows 登录自动启动。", "数据报告助手", mbOK|mbIconInfo)
}
