package main

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPortableSourcesAndOutputs(t *testing.T) {
	for _, kind := range []string{"et", "wps", "wpp", "custom-canvas"} {
		t.Run(kind, func(t *testing.T) {
			s, err := NewStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			p, _ := s.CreateProject("portable")
			d, err := s.RegisterDocument(p.ID, map[string]any{"key": "/tmp/input.arbitrary", "kind": kind, "capabilities": []any{kind + ".selection"}})
			if err != nil {
				t.Fatal(err)
			}
			draft := VariableDraft{DocumentID: d.ID, Name: "预算", CapabilityID: kind + ".selection", Locator: map[string]any{"object": "one"}, Values: []any{[]any{"金额"}, []any{10.0}}, Result: TransformResult{Value: 10.0, ValueType: "number"}, Validation: ContractValidation{Passed: true}}
			source, v, err := s.CommitVariableDraft(p.ID, draft)
			if err != nil {
				t.Fatal(err)
			}
			if source.CapabilityID != kind+".selection" || source.Locator["object"] != "one" {
				t.Fatal("lost generic locator")
			}
			for _, outputKind := range []string{"et", "wps", "wpp", "custom-canvas"} {
				out, err := s.RegisterDocument(p.ID, map[string]any{"key": "/tmp/" + outputKind + ".arbitrary", "kind": outputKind})
				if err != nil {
					t.Fatal(err)
				}
				target := map[string]any{"capabilityId": outputKind + ".selection", "locator": map[string]any{"object": "two"}, "kind": "text"}
				b := Binding{ID: newID("bnd"), VariableID: v.ID, DocumentID: out.ID, DocumentKey: out.Key, Target: target, Renderer: map[string]any{"kind": "text", "template": "{{value}}"}}
				before := journalSnapshot("original")
				if outputKind == "custom-canvas" {
					before = map[string]any{"version": float64(1), "kind": "canvas-object", "adapterId": outputKind + ".selection", "summary": "original"}
				}
				c, err := s.PrepareChange(PPTChange{ID: newID("chg"), ProjectID: p.ID, DocumentID: out.ID, Entries: []PPTChangeEntry{{Target: target, Before: before, AfterBinding: b, VariableVersion: v.UpdatedAt, Plan: map[string]any{"kind": "text", "text": "10"}}}})
				if err != nil {
					t.Fatal(err)
				}
				after := cloneJSON(before)
				if outputKind == "custom-canvas" {
					after["summary"] = "10"
				} else {
					after = journalSnapshot("10")
				}
				c = transition(t, s, c, 0, "complete", after)
				c = transition(t, s, c, 0, "undo-start", after)
				transition(t, s, c, 0, "undo-complete", before)
			}
		})
	}
}
func TestVariableEditRestoreAndNameConflict(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	p, _ := s.CreateProject("versions")
	d, _ := s.RegisterDocument(p.ID, map[string]any{"key": "/tmp/input.odt", "kind": "wps"})
	draft := VariableDraft{DocumentID: d.ID, Name: "old", CapabilityID: "wps.range", Locator: map[string]any{"start": 0.0, "end": 5.0}, Values: []any{[]any{"金额"}, []any{10.0}}, Result: TransformResult{Value: 10.0, ValueType: "number"}, Validation: ContractValidation{Passed: true}}
	_, first, err := s.CommitVariableDraft(p.ID, draft)
	if err != nil {
		t.Fatal(err)
	}
	draft.VariableID = first.ID
	draft.VariableVersion = first.UpdatedAt
	draft.Name = "new"
	draft.Result.Value = 20.0
	_, second, err := s.CommitVariableDraft(p.ID, draft)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Fatal("edit broke binding identity")
	}
	if _, _, err = s.CommitVariableDraft(p.ID, draft); err == nil {
		t.Fatal("stale edit accepted")
	}
	s, err = NewStore(s.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	revisions, err := s.variableRevisions(p.ID, first.ID)
	if err != nil || len(revisions) != 1 {
		t.Fatal(revisions, err)
	}
	if _, err = s.restoreVariableRevision(p.ID, first.ID, revisions[0].ID, first.UpdatedAt); err == nil {
		t.Fatal("stale restore accepted")
	}
	restored, err := s.restoreVariableRevision(p.ID, first.ID, revisions[0].ID, second.UpdatedAt)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Name != "old" || restored.Value != 10.0 {
		t.Fatal("restore lost content", restored)
	}
	revisions, _ = s.variableRevisions(p.ID, first.ID)
	other := draft
	other.VariableID = ""
	other.Name = "new"
	if _, _, err = s.CommitVariableDraft(p.ID, other); err != nil {
		t.Fatal(err)
	}
	if _, err = s.restoreVariableRevision(p.ID, first.ID, revisions[0].ID, restored.UpdatedAt); err == nil {
		t.Fatal("duplicate historical name accepted")
	}
	if _, err = s.variableRevisions(p.ID, "missing"); err == nil {
		t.Fatal("nonexistent variable accepted")
	}
	if err = s.DeleteProject(p.ID); err != nil {
		t.Fatal(err)
	}
	if len(s.State.VariableRevisions) != 0 {
		t.Fatal("deleted project left business data in revisions")
	}
}
func TestDocumentKeyPlatformSemantics(t *testing.T) {
	if normalizeDocKey(`C:\Folder\Report.pptx`) != normalizeDocKey("c:/folder/report.pptx") {
		t.Fatal("Windows key compatibility lost")
	}
	if normalizeDocKey("/Users/Test/report.odt") == normalizeDocKey("/Users/test/report.odt") {
		t.Fatal("POSIX paths incorrectly merged")
	}
}

func TestRecomputeRetainsRestorableSourceAndResult(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	p, _ := s.CreateProject("recompute")
	d, _ := s.RegisterDocument(p.ID, map[string]any{"key": "/tmp/input.ods", "kind": "et"})
	values := []any{[]any{"金额"}, []any{10.0}}
	transform := GuessTransform(values, "金额合计")
	result, err := ExecuteTransform(values, transform)
	if err != nil {
		t.Fatal(err)
	}
	src, v, err := s.CommitVariableDraft(p.ID, VariableDraft{DocumentID: d.ID, Name: "金额", Values: values, Transform: transform, Result: result, Validation: ContractValidation{Passed: true}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.UpdateSource(p.ID, src.ID, []any{[]any{"金额"}, []any{20.0}}); err != nil {
		t.Fatal(err)
	}
	current, _ := s.VariableByID(p.ID, v.ID)
	if current.Value != 20.0 {
		t.Fatal(current.Value)
	}
	revisions, _ := s.variableRevisions(p.ID, v.ID)
	if len(revisions) != 1 || !jsonEqual(revisions[0].Source.Values, values) {
		t.Fatal("recompute lost original source")
	}
	restored, err := s.restoreVariableRevision(p.ID, v.ID, revisions[0].ID, current.UpdatedAt)
	if err != nil || restored.Value != 10.0 {
		t.Fatal(restored, err)
	}
	project, _ := s.GetProject(p.ID)
	for _, source := range project.Sources {
		if source.ID == restored.SourceID && !jsonEqual(source.Values, values) {
			t.Fatal("source/result no longer consistent")
		}
	}
}

func TestPublishedAddonDirectoryEntrypoints(t *testing.T) {
	root := t.TempDir()
	server := &Server{assetDir: root}
	for _, host := range []string{"et", "wps", "wpp"} {
		dir := filepath.Join(root, host)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("entry:"+host), 0644); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("GET", "/addins/"+host+"/", nil)
		res := httptest.NewRecorder()
		server.ServeHTTP(res, req)
		if res.Code != 200 || res.Body.String() != "entry:"+host {
			t.Fatalf("published %s entry failed: %d %s", host, res.Code, res.Body.String())
		}
	}
}
