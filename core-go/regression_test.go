package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewStoreRejectsCorruptStateWithoutOverwriting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(dir); err == nil {
		t.Fatal("expected corrupt state error")
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "{" {
		t.Fatalf("corrupt state was changed: %q %v", b, err)
	}
	matches, _ := filepath.Glob(path + ".corrupt-*")
	if len(matches) != 1 {
		t.Fatalf("expected one preserved corrupt copy, got %d", len(matches))
	}
}

func TestUpdateSourceRejectsInvalidContractAndPreservesValue(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := store.CreateProject("test")
	d, _ := store.RegisterDocument(p.ID, map[string]any{"key": `C:\test.xlsx`, "kind": "et", "name": "test.xlsx"})
	src, _ := store.AddSource(p.ID, map[string]any{"documentId": d.ID, "sheetName": "Sheet1", "address": "A1:B2", "values": []any{[]any{"金额"}, []any{100.0}}})
	_, _ = store.AddVariable(p.ID, map[string]any{"sourceId": src.ID, "name": "total", "valueType": "number", "value": 100.0, "transform": map[string]any{"version": 1, "headersMode": "first-row", "steps": []any{map[string]any{"op": "aggregate", "fn": "sum", "field": "金额"}}, "output": map[string]any{"type": "number"}}})
	if _, err = store.UpdateSource(p.ID, src.ID, []any{[]any{"收入"}, []any{200.0}}); err == nil {
		t.Fatal("expected contract error")
	}
	got, _ := store.SourceByID(p.ID, src.ID)
	b, _ := json.Marshal(got.Values)
	if !strings.Contains(string(b), "金额") {
		t.Fatalf("source was changed after rejected update: %s", b)
	}
}

func TestMatrixToRowsMakesDuplicateHeadersGloballyUnique(t *testing.T) {
	headers, rows := matrixToRows([]any{[]any{"金额", "金额", "金额_2", "__row"}, []any{1, 2, 3, 4}}, "first-row")
	seen := map[string]bool{}
	for _, h := range headers {
		if seen[h] {
			t.Fatalf("duplicate header %q", h)
		}
		seen[h] = true
	}
	if rows[0][headers[1]] != 2 || rows[0][headers[2]] != 3 {
		t.Fatalf("duplicate values were lost: %#v", rows[0])
	}
}

func TestSampleForAITruncatesMapRows(t *testing.T) {
	rows := make([]map[string]any, 20)
	for i := range rows {
		rows[i] = map[string]any{"i": i}
	}
	got, ok := sampleForAI(rows, 8).([]map[string]any)
	if !ok || len(got) != 8 {
		t.Fatalf("expected 8 sampled rows, got %#v", sampleForAI(rows, 8))
	}
}

func TestSampleForAIRespectsByteBudget(t *testing.T) {
	rows := []map[string]any{{"value": strings.Repeat("x", 40*1024)}}
	b, err := json.Marshal(sampleForAI(rows, 8))
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > 32*1024 {
		t.Fatalf("sample exceeds byte budget: %d", len(b))
	}
}

func TestDiagnosticsRedactsBindingSnapshot(t *testing.T) {
	p := Project{Bindings: []Binding{{DocumentKey: `C:\x.pptx`, Target: map[string]any{"snapshot": map[string]any{"text": "SECRET_MARKER"}}}}}
	b, _ := json.Marshal(sanitizeProject(p, false))
	if strings.Contains(string(b), "SECRET_MARKER") {
		t.Fatal("PPT snapshot was not redacted")
	}
}

func TestCORSRejectsLookalikeLocalOriginAndRequiresToken(t *testing.T) {
	store, _ := NewStore(t.TempDir())
	s := &Server{store: store, drafts: NewDraftStore(), diag: NewDiagnostics(t.TempDir()), authToken: "secret"}
	r := httptest.NewRequest("GET", "/api/projects", nil)
	r.Header.Set("Origin", "http://localhost.attacker.example")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 || w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("lookalike origin was accepted: code=%d cors=%q", w.Code, w.Header().Get("Access-Control-Allow-Origin"))
	}
	r = httptest.NewRequest("GET", "/api/projects", nil)
	r.Header.Set("X-RA-Token", "secret")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("valid token rejected: %d", w.Code)
	}
}
