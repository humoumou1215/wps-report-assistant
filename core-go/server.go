package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const version = "0.6.0-rc1"

type Server struct {
	store     *Store
	drafts    *DraftStore
	diag      *Diagnostics
	assetDir  string
	sampleDir string
	host      string
	port      int
}

func dataDirDefault() string {
	if v := os.Getenv("REPORT_ASSISTANT_DATA_DIR"); v != "" {
		return v
	}
	if runtime.GOOS == "windows" {
		if la := os.Getenv("LOCALAPPDATA"); la != "" {
			return filepath.Join(la, "DataReportAssistant", "data")
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".data-report-assistant")
	}
	return filepath.Join(".", "data")
}
func assetDirDefault() string {
	if v := os.Getenv("REPORT_ASSISTANT_ASSET_DIR"); v != "" {
		return v
	}
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "addins")
}
func cors(w http.ResponseWriter, r *http.Request) {
	o := r.Header.Get("Origin")
	if strings.HasPrefix(o, "http://127.0.0.1") || strings.HasPrefix(o, "http://localhost") {
		w.Header().Set("Access-Control-Allow-Origin", o)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Max-Age", "600")
}
func jsonOut(w http.ResponseWriter, r *http.Request, status int, v any) {
	cors(w, r)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func readJSON(r *http.Request) (map[string]any, error) {
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return nil, appErr(415, "仅接受 application/json")
	}
	r.Body = http.MaxBytesReader(nil, r.Body, 5_000_000)
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil && err != io.EOF {
		return nil, appErr(400, "JSON 格式错误")
	}
	normalizeNumbers(m)
	return m, nil
}
func normalizeNumbers(v any) {
	switch x := v.(type) {
	case map[string]any:
		for k, vv := range x {
			if n, ok := vv.(json.Number); ok {
				if f, err := n.Float64(); err == nil {
					x[k] = f
				}
			} else {
				normalizeNumbers(vv)
			}
		}
	case []any:
		for i, vv := range x {
			if n, ok := vv.(json.Number); ok {
				if f, err := n.Float64(); err == nil {
					x[i] = f
				}
			} else {
				normalizeNumbers(vv)
			}
		}
	}
}
func statusOf(err error) int {
	if a, ok := err.(*AppError); ok {
		return a.Status
	}
	return 500
}
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	log.Println(err)
	jsonOut(w, r, statusOf(err), map[string]any{"error": err.Error()})
}
func segments(p string) []string {
	p = strings.Trim(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}
func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	m := r.Method
	if m == "OPTIONS" {
		cors(w, r)
		w.WriteHeader(204)
		return
	}
	if m == "GET" && p == "/api/health" {
		jsonOut(w, r, 200, map[string]any{"ok": true, "version": version, "host": s.host, "port": s.port})
		return
	}
	if m == "GET" && p == "/api/projects" {
		jsonOut(w, r, 200, map[string]any{"projects": s.store.ListProjects()})
		return
	}
	if m == "POST" && p == "/api/projects" {
		b, e := readJSON(r)
		if e != nil {
			s.fail(w, r, e)
			return
		}
		name, _ := b["name"].(string)
		v, e := s.store.CreateProject(name)
		if e != nil {
			s.fail(w, r, e)
			return
		}
		jsonOut(w, r, 201, map[string]any{"project": v})
		return
	}
	if m == "POST" && p == "/api/resolve-project" {
		b, e := readJSON(r)
		if e != nil {
			s.fail(w, r, e)
			return
		}
		k, _ := b["documentKey"].(string)
		pr, d := s.store.ResolveProject(k)
		jsonOut(w, r, 200, map[string]any{"project": pr, "document": d})
		return
	}
	if p == "/api/settings" {
		if m == "GET" {
			st := s.store.GetSettings()
			if st.AI.APIKey != "" {
				st.AI.APIKey = "••••••••"
			}
			jsonOut(w, r, 200, st)
			return
		}
		if m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			if ai, ok := b["ai"].(map[string]any); ok {
				if e = s.store.UpdateAI(ai); e != nil {
					s.fail(w, r, e)
					return
				}
			}
			if dbg, ok := b["debug"].(map[string]any); ok {
				if e = s.store.UpdateDebug(dbg); e != nil {
					s.fail(w, r, e)
					return
				}
			}
			jsonOut(w, r, 200, map[string]any{"ok": true})
			return
		}
	}

	if m == "POST" && p == "/api/debug/events" {
		b, e := readJSON(r)
		if e != nil {
			s.fail(w, r, e)
			return
		}
		if s.store.GetSettings().Debug.Enabled {
			evt := DiagnosticEvent{}
			evt.TraceID, _ = b["traceId"].(string)
			evt.ProjectID, _ = b["projectId"].(string)
			evt.Component, _ = b["component"].(string)
			evt.Stage, _ = b["stage"].(string)
			evt.Action, _ = b["action"].(string)
			evt.Status, _ = b["status"].(string)
			evt.Message, _ = b["message"].(string)
			if v, ok := asFloat(b["durationMs"]); ok {
				evt.DurationMs = int64(v)
			}
			if v, ok := b["sensitive"].(bool); ok {
				evt.Sensitive = v
			}
			evt.Data, _ = b["data"].(map[string]any)
			s.diag.Record(evt)
		}
		jsonOut(w, r, 200, map[string]any{"ok": true})
		return
	}
	if m == "GET" && p == "/api/debug/recent" {
		q := r.URL.Query()
		limit := 100
		if n, e := strconv.Atoi(q.Get("limit")); e == nil {
			limit = n
		}
		jsonOut(w, r, 200, map[string]any{"events": s.diag.Recent(q.Get("projectId"), limit)})
		return
	}
	if m == "POST" && p == "/api/debug/clear" {
		_ = s.diag.Clear()
		jsonOut(w, r, 200, map[string]any{"ok": true})
		return
	}
	if m == "POST" && p == "/api/diagnostics/export" {
		b, e := readJSON(r)
		if e != nil {
			s.fail(w, r, e)
			return
		}
		pid, _ := b["projectId"].(string)
		if pid == "" {
			s.fail(w, r, appErr(400, "请先选择项目"))
			return
		}
		st := s.store.GetSettings()
		include := st.Debug.IncludeSourceData
		if v, ok := b["includeSourceData"].(bool); ok {
			include = v
		}
		path, e := s.diag.Export(s.store, pid, include, st.Debug.MaxEvents)
		if e != nil {
			s.fail(w, r, e)
			return
		}
		go revealFile(path)
		jsonOut(w, r, 200, map[string]any{"ok": true, "path": path, "filename": filepath.Base(path), "includeSourceData": include})
		return
	}
	if m == "POST" && p == "/api/debug/prepare-sample" {
		pr, paths, e := s.prepareSampleProject()
		if e != nil {
			s.fail(w, r, e)
			return
		}
		jsonOut(w, r, 200, map[string]any{"ok": true, "project": pr, "paths": paths})
		return
	}
	sg := segments(p)
	if len(sg) >= 3 && sg[0] == "api" && sg[1] == "projects" {
		pid := sg[2]
		if len(sg) == 3 {
			if m == "GET" {
				v, e := s.store.GetProject(pid)
				if e != nil {
					s.fail(w, r, e)
					return
				}
				jsonOut(w, r, 200, map[string]any{"project": v})
				return
			}
			if m == "PATCH" {
				b, e := readJSON(r)
				if e != nil {
					s.fail(w, r, e)
					return
				}
				v, e := s.store.UpdateProject(pid, b)
				if e != nil {
					s.fail(w, r, e)
					return
				}
				jsonOut(w, r, 200, map[string]any{"project": v})
				return
			}
			if m == "DELETE" {
				e := s.store.DeleteProject(pid)
				if e != nil {
					s.fail(w, r, e)
					return
				}
				jsonOut(w, r, 200, map[string]any{"ok": true})
				return
			}
		}
		if len(sg) == 4 && sg[3] == "documents" && m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			v, e := s.store.RegisterDocument(pid, b)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			jsonOut(w, r, 201, map[string]any{"document": v})
			return
		}
		if len(sg) == 4 && sg[3] == "sources" && m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			v, e := s.store.AddSource(pid, b)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			jsonOut(w, r, 201, map[string]any{"source": v})
			return
		}
		if len(sg) == 5 && sg[3] == "sources" && m == "PATCH" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			v, e := s.store.UpdateSource(pid, sg[4], b["values"])
			if e != nil {
				s.fail(w, r, e)
				return
			}
			jsonOut(w, r, 200, map[string]any{"source": v})
			return
		}
		if len(sg) == 5 && sg[3] == "variables" && sg[4] == "preview" && m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			documentID, _ := b["documentId"].(string)
			name, _ := b["name"].(string)
			displayName, _ := b["displayName"].(string)
			desc, _ := b["description"].(string)
			sheetName, _ := b["sheetName"].(string)
			address, _ := b["address"].(string)
			headersMode, _ := b["headersMode"].(string)
			if headersMode == "" {
				headersMode = "first-row"
			}
			traceID, _ := b["traceId"].(string)
			if traceID == "" {
				traceID = newID("trace")
			}
			name = strings.TrimSpace(name)
			if name == "" {
				s.fail(w, r, appErr(400, "请输入变量名"))
				return
			}
			if b["values"] == nil {
				s.fail(w, r, appErr(400, "选区数据为空，请重新读取当前选区"))
				return
			}
			project, e := s.store.GetProject(pid)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			docOK := false
			for _, d := range project.Documents {
				if d.ID == documentID && d.Kind == "et" {
					docOK = true
					break
				}
			}
			if !docOK {
				s.fail(w, r, appErr(400, "当前 Excel 不属于该项目，请重新加入项目"))
				return
			}
			for _, x := range project.Variables {
				if x.Name == name {
					s.fail(w, r, appErr(409, "当前项目内变量名称重复"))
					return
				}
			}
			build, e := BuildTransform(s.store.GetSettings(), b["values"], desc)
			if s.store.GetSettings().Debug.Enabled {
				status := "ok"
				msg := ""
				if e != nil {
					status = "error"
					msg = e.Error()
				}
				s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "preview-transform", Action: "build-transform-preview", Status: status, Message: msg, Sensitive: true, Data: map[string]any{"description": desc, "attempts": build.Attempts, "validation": build.Validation, "result": build.Result}})
			}
			if e != nil {
				s.fail(w, r, e)
				return
			}
			draft := s.drafts.PutVariable(VariableDraft{
				ProjectID: pid, DocumentID: documentID, SheetName: sheetName, Address: address,
				Values: b["values"], HeadersMode: headersMode, Name: name, DisplayName: displayName,
				Description: desc, Transform: build.Spec, Result: build.Result, Generation: build.Generation,
				Attempts: build.Attempts, Validation: build.Validation, TraceID: traceID,
			})
			jsonOut(w, r, 200, map[string]any{
				"draftId": draft.ID, "generation": draft.Generation, "transform": draft.Transform,
				"result": draft.Result, "attempts": draft.Attempts, "validation": draft.Validation, "traceId": traceID,
			})
			return
		}
		if len(sg) == 5 && sg[3] == "variables" && sg[4] == "apply" && m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			draftID, _ := b["draftId"].(string)
			draft, e := s.drafts.TakeVariable(pid, draftID)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			src, variable, e := s.store.CommitVariableDraft(pid, draft)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			if s.store.GetSettings().Debug.Enabled {
				s.diag.Record(DiagnosticEvent{TraceID: draft.TraceID, ProjectID: pid, Component: "core", Stage: "apply-transform", Action: "commit-variable", Status: "ok", Sensitive: false, Data: map[string]any{"sourceId": src.ID, "variableId": variable.ID, "generation": draft.Generation}})
			}
			jsonOut(w, r, 201, map[string]any{"source": src, "variable": variable, "generation": draft.Generation, "traceId": draft.TraceID})
			return
		}
		if len(sg) == 5 && sg[3] == "variables" && sg[4] == "generate" && m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			sid, _ := b["sourceId"].(string)
			src, e := s.store.SourceByID(pid, sid)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			desc, _ := b["description"].(string)
			spec, via, aiTrace, e := GenerateTransform(s.store.GetSettings(), src.Values, desc)
			traceID, _ := b["traceId"].(string)
			if traceID == "" {
				traceID = newID("trace")
			}
			if s.store.GetSettings().Debug.Enabled {
				status := "ok"
				msg := ""
				if e != nil {
					status = "error"
					msg = e.Error()
				}
				s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "ai-transform", Action: "generate-transform", Status: status, Message: msg, DurationMs: aiTrace.DurationMs, Sensitive: true, Data: map[string]any{"trace": aiTrace, "description": desc, "sourceId": sid}})
			}
			if e != nil {
				s.fail(w, r, e)
				return
			}
			if s.store.GetSettings().Debug.Enabled {
				s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "transform", Action: "execute-transform", Status: "start", Sensitive: false, Data: map[string]any{"spec": spec, "sourceId": sid}})
			}
			result, e := ExecuteTransform(src.Values, spec)
			if e != nil {
				if s.store.GetSettings().Debug.Enabled {
					s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "transform", Action: "execute-transform", Status: "error", Message: e.Error()})
				}
				s.fail(w, r, e)
				return
			}
			if s.store.GetSettings().Debug.Enabled {
				s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "result", Action: "transform-result", Status: "ok", Sensitive: true, Data: map[string]any{"valueType": result.ValueType, "columns": result.Columns, "value": result.Value}})
			}
			b["transform"] = spec
			b["value"] = result.Value
			b["valueType"] = result.ValueType
			b["columns"] = result.Columns
			v, e := s.store.AddVariable(pid, b)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			jsonOut(w, r, 201, map[string]any{"variable": v, "generation": via, "traceId": traceID})
			return
		}
		if len(sg) == 6 && sg[3] == "variables" && sg[5] == "recompute" && m == "POST" {
			v, e := s.store.VariableByID(pid, sg[4])
			if e != nil {
				s.fail(w, r, e)
				return
			}
			src, e := s.store.SourceByID(pid, v.SourceID)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			res, e := ExecuteTransform(src.Values, v.Transform)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			v, e = s.store.UpdateVariableResult(pid, v.ID, res)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			jsonOut(w, r, 200, map[string]any{"variable": v})
			return
		}
		if len(sg) == 5 && sg[3] == "variables" && m == "DELETE" {
			e := s.store.DeleteVariable(pid, sg[4])
			if e != nil {
				s.fail(w, r, e)
				return
			}
			jsonOut(w, r, 200, map[string]any{"ok": true})
			return
		}
		if len(sg) == 5 && sg[3] == "bindings" && sg[4] == "preview" && m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			variableID, _ := b["variableId"].(string)
			documentID, _ := b["documentId"].(string)
			target, _ := b["target"].(map[string]any)
			desc, _ := b["description"].(string)
			traceID, _ := b["traceId"].(string)
			if traceID == "" {
				traceID = newID("trace")
			}
			variable, e := s.store.VariableByID(pid, variableID)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			project, e := s.store.GetProject(pid)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			docOK := false
			for _, d := range project.Documents {
				if d.ID == documentID && d.Kind == "wpp" {
					docOK = true
					break
				}
			}
			if !docOK {
				s.fail(w, r, appErr(400, "当前 PPT 不属于该项目，请重新加入项目"))
				return
			}
			build, e := BuildBinding(s.store.GetSettings(), variable, target, desc)
			if s.store.GetSettings().Debug.Enabled {
				status := "ok"
				msg := ""
				if e != nil {
					status = "error"
					msg = e.Error()
				}
				s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "preview-binding", Action: "build-binding-preview", Status: status, Message: msg, Sensitive: true, Data: map[string]any{"variableId": variableID, "target": target, "description": desc, "attempts": build.Attempts, "validation": build.Validation, "plan": build.Plan}})
			}
			if e != nil {
				s.fail(w, r, e)
				return
			}
			draft := s.drafts.PutBinding(BindingDraft{
				ProjectID: pid, VariableID: variableID, DocumentID: documentID, Target: target,
				Description: desc, Renderer: build.Renderer, Plan: build.Plan, Generation: build.Generation,
				Attempts: build.Attempts, Validation: build.Validation, TraceID: traceID,
			})
			jsonOut(w, r, 200, map[string]any{
				"draftId": draft.ID, "generation": draft.Generation, "renderer": draft.Renderer,
				"plan": draft.Plan, "attempts": draft.Attempts, "validation": draft.Validation, "traceId": traceID,
			})
			return
		}
		if len(sg) == 5 && sg[3] == "bindings" && sg[4] == "apply" && m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			draftID, _ := b["draftId"].(string)
			draft, e := s.drafts.TakeBinding(pid, draftID)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			in := map[string]any{
				"variableId": draft.VariableID, "documentId": draft.DocumentID,
				"description": draft.Description, "target": draft.Target, "renderer": draft.Renderer,
			}
			binding, e := s.store.AddBinding(pid, in)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			if s.store.GetSettings().Debug.Enabled {
				s.diag.Record(DiagnosticEvent{TraceID: draft.TraceID, ProjectID: pid, Component: "core", Stage: "apply-binding", Action: "commit-binding", Status: "ok", Sensitive: true, Data: map[string]any{"bindingId": binding.ID, "target": draft.Target, "plan": draft.Plan}})
			}
			jsonOut(w, r, 201, map[string]any{"binding": binding, "plan": draft.Plan, "generation": draft.Generation, "traceId": draft.TraceID})
			return
		}
		if len(sg) == 5 && sg[3] == "bindings" && sg[4] == "generate" && m == "POST" {
			b, e := readJSON(r)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			vid, _ := b["variableId"].(string)
			v, e := s.store.VariableByID(pid, vid)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			target, _ := b["target"].(map[string]any)
			desc, _ := b["description"].(string)
			renderer, via, aiTrace, e := GenerateBinding(s.store.GetSettings(), v, target, desc)
			traceID, _ := b["traceId"].(string)
			if traceID == "" {
				traceID = newID("trace")
			}
			if s.store.GetSettings().Debug.Enabled {
				status := "ok"
				msg := ""
				if e != nil {
					status = "error"
					msg = e.Error()
				}
				s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "ai-binding", Action: "generate-binding", Status: status, Message: msg, DurationMs: aiTrace.DurationMs, Sensitive: true, Data: map[string]any{"trace": aiTrace, "description": desc, "variableId": vid, "target": target}})
			}
			if e != nil {
				s.fail(w, r, e)
				return
			}
			// Validate and build the render plan before persisting the binding. A malformed
			// AI renderer must never leave a broken binding in the project.
			plan, e := RenderPlan(v, renderer)
			if e != nil {
				if s.store.GetSettings().Debug.Enabled {
					s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "render-plan", Action: "render-plan", Status: "error", Message: e.Error(), Sensitive: true, Data: map[string]any{"renderer": renderer}})
				}
				s.fail(w, r, e)
				return
			}
			b["renderer"] = renderer
			bd, e := s.store.AddBinding(pid, b)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			if s.store.GetSettings().Debug.Enabled {
				s.diag.Record(DiagnosticEvent{TraceID: traceID, ProjectID: pid, Component: "core", Stage: "render-plan", Action: "render-plan", Status: "ok", Sensitive: true, Data: map[string]any{"bindingId": bd.ID, "renderer": renderer, "plan": plan}})
			}
			jsonOut(w, r, 201, map[string]any{"binding": bd, "generation": via, "plan": plan, "traceId": traceID})
			return
		}
		if len(sg) == 6 && sg[3] == "bindings" && sg[5] == "plan" && m == "GET" {
			bd, e := s.store.BindingByID(pid, sg[4])
			if e != nil {
				s.fail(w, r, e)
				return
			}
			v, e := s.store.VariableByID(pid, bd.VariableID)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			plan, e := RenderPlan(v, bd.Renderer)
			if e != nil {
				s.fail(w, r, e)
				return
			}
			jsonOut(w, r, 200, map[string]any{"binding": bd, "variable": v, "plan": plan})
			return
		}
		if len(sg) == 5 && sg[3] == "bindings" && m == "DELETE" {
			e := s.store.DeleteBinding(pid, sg[4])
			if e != nil {
				s.fail(w, r, e)
				return
			}
			jsonOut(w, r, 200, map[string]any{"ok": true})
			return
		}
	}
	jsonOut(w, r, 404, map[string]any{"error": "API 不存在"})
}
func (s *Server) static(w http.ResponseWriter, r *http.Request) bool {
	prefix := ""
	sub := ""
	if strings.HasPrefix(r.URL.Path, "/addins/et/") {
		prefix = filepath.Join(s.assetDir, "et")
		sub = strings.TrimPrefix(r.URL.Path, "/addins/et/")
	} else if strings.HasPrefix(r.URL.Path, "/addins/wpp/") {
		prefix = filepath.Join(s.assetDir, "wpp")
		sub = strings.TrimPrefix(r.URL.Path, "/addins/wpp/")
	} else {
		return false
	}
	if sub == "" {
		sub = "index.html"
	}
	sub = filepath.Clean(filepath.FromSlash(sub))
	if strings.HasPrefix(sub, "..") {
		return false
	}
	f := filepath.Join(prefix, sub)
	abs, _ := filepath.Abs(f)
	base, _ := filepath.Abs(prefix)
	if !strings.HasPrefix(abs, base) {
		return false
	}
	st, err := os.Stat(f)
	if err != nil || st.IsDir() {
		return false
	}
	if ct := mime.TypeByExtension(filepath.Ext(f)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, f)
	return true
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		cors(w, r)
		w.WriteHeader(204)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.api(w, r)
		return
	}
	if s.static(w, r) {
		return
	}
	if r.URL.Path == "/" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, "<!doctype html><meta charset=utf-8><title>数据报告助手</title><body style='font-family:sans-serif;padding:40px'><h2>数据报告助手 Core %s</h2><p>本地核心服务正在运行。业务操作请在 WPS 右侧任务窗格完成。</p></body>", version)
		return
	}
	jsonOut(w, r, 404, map[string]any{"error": "Not found"})
}
func main() {
	host := os.Getenv("REPORT_ASSISTANT_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 17891
	if p := os.Getenv("REPORT_ASSISTANT_PORT"); p != "" {
		if n, e := strconv.Atoi(p); e == nil {
			port = n
		}
	}
	dataDir := dataDirDefault()
	store, err := NewStore(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	_ = os.MkdirAll(dataDir, 0755)
	_ = os.WriteFile(filepath.Join(dataDir, "core.pid"), []byte(strconv.Itoa(os.Getpid())), 0644)
	exe, _ := os.Executable()
	s := &Server{store: store, drafts: NewDraftStore(), diag: NewDiagnostics(dataDir), assetDir: assetDirDefault(), sampleDir: filepath.Join(filepath.Dir(exe), "samples"), host: host, port: port}
	addr := fmt.Sprintf("%s:%d", host, port)
	srv := &http.Server{Addr: addr, Handler: s, ReadHeaderTimeout: 10 * time.Second}
	log.Printf("Data Report Assistant Core v%s on http://%s", version, addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
