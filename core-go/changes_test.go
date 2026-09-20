package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func journalFixture(t *testing.T) (*Store, PPTChange) {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p, _ := s.CreateProject("history")
	doc, _ := s.RegisterDocument(p.ID, map[string]any{"key": "C:/report.pptx", "kind": "wpp"})
	// The test variable needs no computation; this exercises the journal boundary.
	s.State.Projects[0].Variables = append(s.State.Projects[0].Variables, Variable{ID: "v", UpdatedAt: "v1", Value: 10.0, ValueType: "number"})
	target := map[string]any{"slideId": float64(3), "shapeId": float64(5), "slideIndex": float64(1)}
	b := Binding{ID: "b", VariableID: "v", DocumentID: doc.ID, DocumentKey: doc.Key, Target: target, Renderer: map[string]any{"kind": "text", "template": "{{value}}"}, UpdatedAt: "b1"}
	c := PPTChange{ID: "change1", ProjectID: p.ID, DocumentID: doc.ID, Label: "创建绑定", Entries: []PPTChangeEntry{{Target: target, Before: journalSnapshot("before"), AfterBinding: b, VariableVersion: "v1", Plan: map[string]any{"kind": "text", "text": "10"}}}}
	return s, c
}
func journalSnapshot(text string) map[string]any {
	return map[string]any{"version": float64(1), "kind": "text", "text": map[string]any{"text": text}}
}
func transition(t *testing.T, s *Store, c PPTChange, i int, a string, snap map[string]any) PPTChange {
	t.Helper()
	got, err := s.TransitionChange(c.ProjectID, c.ID, i, a, snap, "")
	if err != nil {
		t.Fatal(err)
	}
	return got
}
func TestChangesPersistCommitAndUndoBinding(t *testing.T) {
	s, c := journalFixture(t)
	c, err := s.PrepareChange(c)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.BindingByID(c.ProjectID, "b"); err == nil {
		t.Fatal("prepare must not commit binding")
	}
	s, err = NewStore(s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.State.Changes) != 1 || s.State.Changes[0].Entries[0].Status != "prepared" {
		t.Fatal("journal lost after restart")
	}
	after := journalSnapshot("10")
	c = transition(t, s, c, 0, "complete", after)
	transition(t, s, c, 0, "complete", after) // response retry
	if len(s.State.Projects[0].Bindings) != 1 {
		t.Fatal("duplicate binding after retry")
	}
	c = transition(t, s, c, 0, "undo-start", after)
	c = transition(t, s, c, 0, "undo-complete", c.Entries[0].Before)
	if len(s.State.Projects[0].Bindings) != 0 {
		t.Fatal("undo creation must remove binding")
	}
	s, err = NewStore(s.dataDir)
	if err != nil || s.State.Changes[0].Entries[0].Status != "undone" {
		t.Fatal("undo not durable", err)
	}
}
func TestChangesRestorePreviousRuleAndEnforceOrder(t *testing.T) {
	s, c := journalFixture(t)
	c, _ = s.PrepareChange(c)
	c = transition(t, s, c, 0, "complete", journalSnapshot("10"))
	b, _ := s.BindingByID(c.ProjectID, "b")
	next := cloneJSON(c)
	next.ID = "change2"
	next.Entries[0].BeforeBinding = &b
	next.Entries[0].Before = journalSnapshot("10")
	next.Entries[0].AfterBinding.Description = "新要求"
	next.Entries[0].AfterBinding.UpdatedAt = "b2"
	next.Entries[0].BindingCommitted = false
	next, err := s.PrepareChange(next)
	if err != nil {
		t.Fatal(err)
	}
	next = transition(t, s, next, 0, "complete", journalSnapshot("20"))
	if _, err = s.TransitionChange(c.ProjectID, c.ID, 0, "undo-start", journalSnapshot("10"), ""); err == nil {
		t.Fatal("out of order undo accepted")
	}
	if _, err = s.TransitionChange(next.ProjectID, next.ID, 0, "undo-start", journalSnapshot("manual edit"), ""); err == nil {
		t.Fatal("manual edit overwritten")
	}
	next = transition(t, s, next, 0, "undo-start", journalSnapshot("20"))
	transition(t, s, next, 0, "undo-complete", next.Entries[0].Before)
	got, _ := s.BindingByID(c.ProjectID, "b")
	if !jsonEqual(got, b) {
		t.Fatal("previous rule not restored")
	}
	transition(t, s, c, 0, "undo-start", journalSnapshot("10"))
}
func TestChangesPendingBlocksNewAndRecoverySurvivesRestart(t *testing.T) {
	s, c := journalFixture(t)
	c, _ = s.PrepareChange(c)
	next := cloneJSON(c)
	next.ID = "next"
	if _, err := s.PrepareChange(next); err == nil {
		t.Fatal("pending operation did not block")
	}
	if _, err := s.TransitionChange(c.ProjectID, c.ID, 0, "fail", journalSnapshot("partial"), ""); err == nil {
		t.Fatal("unverified rollback accepted")
	}
	c = transition(t, s, c, 0, "recover-start", journalSnapshot("partial"))
	s, err := NewStore(s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	c = transition(t, s, c, 0, "undo-complete", c.Entries[0].Before)
	if c.Entries[0].BindingCommitted {
		t.Fatal("recovery committed a binding")
	}
	if _, err = s.PrepareChange(next); err != nil {
		t.Fatal(err)
	}
}
func TestChangesPartialBatchUndoOnlySuccessfulEntries(t *testing.T) {
	s, c := journalFixture(t)
	second := cloneJSON(c.Entries[0])
	second.Target["shapeId"] = float64(6)
	second.AfterBinding.ID = "b2"
	second.AfterBinding.Target = second.Target
	c.Entries = append(c.Entries, second)
	c, err := s.PrepareChange(c)
	if err != nil {
		t.Fatal(err)
	}
	c = transition(t, s, c, 0, "complete", journalSnapshot("10"))
	c = transition(t, s, c, 1, "fail", second.Before)
	c = transition(t, s, c, 0, "undo-start", journalSnapshot("10"))
	transition(t, s, c, 0, "undo-complete", c.Entries[0].Before)
	if len(s.State.Projects[0].Bindings) != 0 {
		t.Fatal("batch undo left binding")
	}
}
func TestChangesRejectStaleVariableAndDuplicateTargets(t *testing.T) {
	s, c := journalFixture(t)
	c.Entries[0].VariableVersion = "old"
	if _, err := s.PrepareChange(c); err == nil {
		t.Fatal("stale variable accepted")
	}
	c.Entries[0].VariableVersion = "v1"
	c.Entries = append(c.Entries, cloneJSON(c.Entries[0]))
	if _, err := s.PrepareChange(c); err == nil {
		t.Fatal("duplicate target accepted")
	}
	if len(s.State.Changes) != 0 {
		t.Fatal("invalid prepare was saved")
	}
}
func TestChangesPersistenceFailureDoesNotCommitInMemory(t *testing.T) {
	s, c := journalFixture(t)
	c, _ = s.PrepareChange(c)
	s.stateFile = filepath.Join(t.TempDir(), "missing", "state.json")
	if _, err := s.TransitionChange(c.ProjectID, c.ID, 0, "complete", journalSnapshot("10"), ""); err == nil {
		t.Fatal("expected storage failure")
	}
	if len(s.State.Projects[0].Bindings) != 0 || s.State.Changes[0].Entries[0].Status != "prepared" {
		t.Fatal("failed transaction changed memory")
	}
}
func TestChangesAPIRejectsUnapprovedDraftAndAllowsIdempotentRetry(t *testing.T) {
	s, c := journalFixture(t)
	server := &Server{store: s, drafts: NewDraftStore()}
	d := server.drafts.PutBinding(BindingDraft{ProjectID: c.ProjectID, DocumentID: c.DocumentID, VariableID: "v", VariableVersion: "v1", Target: c.Entries[0].Target, Plan: c.Entries[0].Plan, Renderer: c.Entries[0].AfterBinding.Renderer, DynamicCapability: true})
	input := map[string]any{"requestId": "api-change", "documentId": c.DocumentID, "entries": []any{map[string]any{"draftId": d.ID, "before": c.Entries[0].Before, "expectedPlan": d.Plan}}}
	call := func() *httptest.ResponseRecorder {
		data, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/api/projects/"+c.ProjectID+"/changes", strings.NewReader(string(data)))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		server.api(w, r)
		return w
	}
	if w := call(); w.Code != 412 {
		t.Fatalf("expected approval check: %d %s", w.Code, w.Body.String())
	}
	input["entries"].([]any)[0].(map[string]any)["approveDynamicCapability"] = true
	if w := call(); w.Code != 201 {
		t.Fatalf("prepare: %d %s", w.Code, w.Body.String())
	}
	if w := call(); w.Code != 200 {
		t.Fatalf("retry: %d %s", w.Code, w.Body.String())
	}
	if len(s.State.Changes) != 1 {
		t.Fatal("retry duplicated operation")
	}
	data, err := os.ReadFile(s.stateFile)
	if err != nil || !strings.Contains(string(data), "api-change") {
		t.Fatal("prepare not durable")
	}
}

func TestChangesAlreadyRestoredHostCanUndoMetadata(t *testing.T) {
	s, c := journalFixture(t)
	c, _ = s.PrepareChange(c)
	c = transition(t, s, c, 0, "complete", journalSnapshot("10"))
	// WPS closed without saving, or native Undo already restored the exact before state.
	c = transition(t, s, c, 0, "undo-start", c.Entries[0].Before)
	transition(t, s, c, 0, "undo-complete", c.Entries[0].Before)
	if len(s.State.Projects[0].Bindings) != 0 {
		t.Fatal("stale binding remains after host restored")
	}
}
func TestChangesCannotDeleteBindingNeededForUndo(t *testing.T) {
	s, c := journalFixture(t)
	c, _ = s.PrepareChange(c)
	transition(t, s, c, 0, "complete", journalSnapshot("10"))
	if err := s.DeleteBinding(c.ProjectID, "b"); err == nil {
		t.Fatal("deleted binding with active undo history")
	}
}

func TestChangesProjectIsolationAndDeletion(t *testing.T) {
	s, c := journalFixture(t)
	c, _ = s.PrepareChange(c)
	other, _ := s.CreateProject("other")
	if items, err := s.ListChanges(other.ID, c.DocumentID); err != nil || len(items) != 0 {
		t.Fatal("history crossed project boundary")
	}
	if _, err := s.TransitionChange(other.ID, c.ID, 0, "complete", journalSnapshot("10"), ""); err == nil {
		t.Fatal("foreign operation changed")
	}
	if err := s.DeleteProject(c.ProjectID); err != nil {
		t.Fatal(err)
	}
	if len(s.State.Changes) != 0 {
		t.Fatal("deleted project's business data remains in journal")
	}
}
