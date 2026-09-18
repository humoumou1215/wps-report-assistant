package main

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type DiagnosticEvent struct {
	Time       string         `json:"time"`
	ID         string         `json:"id"`
	TraceID    string         `json:"traceId,omitempty"`
	ProjectID  string         `json:"projectId,omitempty"`
	Component  string         `json:"component"`
	Stage      string         `json:"stage,omitempty"`
	Action     string         `json:"action"`
	Status     string         `json:"status,omitempty"`
	Message    string         `json:"message,omitempty"`
	DurationMs int64          `json:"durationMs,omitempty"`
	Sensitive  bool           `json:"sensitive,omitempty"`
	Data       map[string]any `json:"data,omitempty"`
}

type Diagnostics struct {
	mu        sync.Mutex
	dataDir   string
	eventFile string
}

func NewDiagnostics(dataDir string) *Diagnostics {
	d := filepath.Join(dataDir, "diagnostics")
	_ = os.MkdirAll(d, 0755)
	return &Diagnostics{dataDir: d, eventFile: filepath.Join(d, "events.jsonl")}
}

func (d *Diagnostics) Record(e DiagnosticEvent) {
	if e.Time == "" {
		e.Time = nowISO()
	}
	if e.ID == "" {
		e.ID = newID("evt")
	}
	if e.Component == "" {
		e.Component = "core"
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = os.MkdirAll(d.dataDir, 0755)
	d.rotateLocked()
	f, err := os.OpenFile(d.eventFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	_, _ = f.Write(append(b, '\n'))
}

func (d *Diagnostics) rotateLocked() {
	st, err := os.Stat(d.eventFile)
	if err != nil || st.Size() < 5*1024*1024 {
		return
	}
	_ = os.Remove(d.eventFile + ".1")
	_ = os.Rename(d.eventFile, d.eventFile+".1")
}

func (d *Diagnostics) Clear() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = os.Remove(d.eventFile)
	_ = os.Remove(d.eventFile + ".1")
	return nil
}

func readEventsFile(path string, out *[]DiagnosticEvent) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	buf := make([]byte, 0, 64*1024)
	sc.Buffer(buf, 4*1024*1024)
	for sc.Scan() {
		var e DiagnosticEvent
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			*out = append(*out, e)
		}
	}
}

func (d *Diagnostics) Recent(projectID string, limit int) []DiagnosticEvent {
	if limit <= 0 || limit > 5000 {
		limit = 200
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	events := []DiagnosticEvent{}
	readEventsFile(d.eventFile+".1", &events)
	readEventsFile(d.eventFile, &events)
	filtered := events[:0]
	for _, e := range events {
		if projectID == "" || e.ProjectID == "" || e.ProjectID == projectID {
			filtered = append(filtered, e)
		}
	}
	if len(filtered) > limit {
		filtered = filtered[len(filtered)-limit:]
	}
	return append([]DiagnosticEvent(nil), filtered...)
}

func safeFileName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "project"
	}
	r := strings.NewReplacer("/", "_", `\`, "_", ":", "_", "*", "_", "?", "_", `"`, "_", "<", "_", ">", "_", "|", "_")
	s = r.Replace(s)
	if len([]rune(s)) > 40 {
		s = string([]rune(s)[:40])
	}
	return s
}

func dataShape(v any) map[string]any {
	rows, cols := 0, 0
	switch x := v.(type) {
	case []any:
		rows = len(x)
		if rows > 0 {
			if r, ok := x[0].([]any); ok {
				cols = len(r)
			} else if m, ok := x[0].(map[string]any); ok {
				cols = len(m)
			}
		}
	case []map[string]any:
		rows = len(x)
		if rows > 0 {
			cols = len(x[0])
		}
	case nil:
	default:
		rows, cols = 1, 1
	}
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return map[string]any{"redacted": true, "rows": rows, "cols": cols, "sha256": hex.EncodeToString(sum[:])}
}

func sanitizeProject(p Project, includeData bool) Project {
	out := cloneJSON(p)
	for i := range out.Documents {
		out.Documents[i].Key = baseName(out.Documents[i].Key)
	}
	for i := range out.Sources {
		out.Sources[i].DocumentKey = baseName(out.Sources[i].DocumentKey)
		if !includeData {
			out.Sources[i].Values = dataShape(out.Sources[i].Values)
		}
	}
	if !includeData {
		for i := range out.Variables {
			out.Variables[i].Value = dataShape(out.Variables[i].Value)
		}
	}
	for i := range out.Bindings {
		out.Bindings[i].DocumentKey = baseName(out.Bindings[i].DocumentKey)
	}
	return out
}

func redactEvent(e DiagnosticEvent, includeData bool) DiagnosticEvent {
	if includeData || !e.Sensitive {
		return e
	}
	if e.Data != nil {
		e.Data = dataShape(e.Data)
	}
	return e
}

func diagnosticOutputDir(dataDir string) string {
	if runtime.GOOS == "windows" {
		if u := os.Getenv("USERPROFILE"); u != "" {
			for _, sub := range []string{"Desktop", "Documents"} {
				p := filepath.Join(u, sub)
				if st, err := os.Stat(p); err == nil && st.IsDir() {
					return p
				}
			}
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(h, "Desktop")
		if st, e := os.Stat(p); e == nil && st.IsDir() {
			return p
		}
	}
	return dataDir
}

func zipWriteJSON(zw *zip.Writer, name string, v any) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func zipWriteText(zw *zip.Writer, name, text string) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, text)
	return err
}

func (d *Diagnostics) Export(store *Store, projectID string, includeData bool, maxEvents int) (string, error) {
	p, err := store.GetProject(projectID)
	if err != nil {
		return "", err
	}
	if maxEvents <= 0 {
		maxEvents = 2000
	}
	events := d.Recent(projectID, maxEvents)
	for i := range events {
		events[i] = redactEvent(events[i], includeData)
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].Time < events[j].Time })

	outDir := diagnosticOutputDir(d.dataDir)
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return "", err
	}
	stamp := time.Now().Format("20060102-150405")
	file := filepath.Join(outDir, fmt.Sprintf("DataReportAssistant-Diagnostic-%s-%s.zip", safeFileName(p.Name), stamp))
	f, err := os.Create(file)
	if err != nil {
		return "", err
	}
	zw := zip.NewWriter(f)
	closeWithErr := func(e error) (string, error) {
		_ = zw.Close()
		_ = f.Close()
		if e != nil {
			_ = os.Remove(file)
		}
		return "", e
	}

	safeSettings := store.GetSettings()
	safeSettings.AI.APIKey = "<redacted>"
	env := map[string]any{
		"exportedAt": nowISO(), "coreVersion": version, "goos": runtime.GOOS, "goarch": runtime.GOARCH,
		"projectId": p.ID, "projectName": p.Name, "includeBusinessData": includeData,
	}
	if err = zipWriteJSON(zw, "environment.json", env); err != nil {
		return closeWithErr(err)
	}
	if err = zipWriteJSON(zw, "settings.safe.json", safeSettings); err != nil {
		return closeWithErr(err)
	}
	if err = zipWriteJSON(zw, "project.json", sanitizeProject(p, includeData)); err != nil {
		return closeWithErr(err)
	}

	ew, err := zw.Create("events.jsonl")
	if err != nil {
		return closeWithErr(err)
	}
	for _, e := range events {
		b, _ := json.Marshal(e)
		_, _ = ew.Write(append(b, '\n'))
	}
	summary := buildDiagnosticSummary(p, events, includeData)
	if err = zipWriteText(zw, "SUMMARY.md", summary); err != nil {
		return closeWithErr(err)
	}
	if err = zipWriteText(zw, "README.txt", "此诊断包由数据报告助手生成，用于复现变量提取和 PPT 渲染问题。\r\nAPI Key 永远不会被导出。\r\nincludeBusinessData=false 时，源数据、变量值和敏感事件只保留尺寸与 SHA256。\r\n"); err != nil {
		return closeWithErr(err)
	}
	if err = zw.Close(); err != nil {
		_ = f.Close()
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	return file, nil
}

func buildDiagnosticSummary(p Project, events []DiagnosticEvent, includeData bool) string {
	counts := map[string]int{}
	traces := map[string]bool{}
	errors := []DiagnosticEvent{}
	for _, e := range events {
		key := e.Stage
		if key == "" {
			key = e.Action
		}
		counts[key]++
		if e.TraceID != "" {
			traces[e.TraceID] = true
		}
		if e.Status == "error" {
			errors = append(errors, e)
		}
	}
	stages := []string{"selection", "ai-transform", "transform", "result", "target", "ai-binding", "render-plan", "apply"}
	var b strings.Builder
	fmt.Fprintf(&b, "# 数据报告助手诊断摘要\n\n- 项目：%s\n- 文档：%d\n- 数据源：%d\n- 数据结果：%d\n- PPT 绑定：%d\n- Trace：%d\n- 导出业务数据：%v\n\n", p.Name, len(p.Documents), len(p.Sources), len(p.Variables), len(p.Bindings), len(traces), includeData)
	b.WriteString("## 标准链路事件\n\n")
	for _, s := range stages {
		fmt.Fprintf(&b, "- %s：%d\n", s, counts[s])
	}
	if len(errors) > 0 {
		b.WriteString("\n## 最近错误\n\n")
		start := 0
		if len(errors) > 10 {
			start = len(errors) - 10
		}
		for _, e := range errors[start:] {
			fmt.Fprintf(&b, "- %s [%s/%s] %s\n", e.Time, e.Component, e.Stage, e.Message)
		}
	}
	b.WriteString("\n## 排查顺序\n\n1. selection：选区是否正确。\n2. ai-transform：AI 实际收到什么并生成什么 TransformSpec。\n3. transform/result：规则执行是否正确。\n4. target：PPT Shape 是否正确。\n5. ai-binding：Renderer 规则是否正确。\n6. render-plan：真正准备写入 PPT 的内容。\n7. apply：WPS 写入是否成功。\n")
	return b.String()
}

func revealFile(path string) {
	if runtime.GOOS != "windows" || path == "" {
		return
	}
	_ = exec.Command("explorer.exe", "/select,"+path).Start()
}
