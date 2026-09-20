package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMergePublishPreservesOthers(t *testing.T) {
	d := t.TempDir()
	f := filepath.Join(d, "publish.xml")
	old := `<?xml version="1.0" encoding="UTF-8"?><jsplugins><jspluginonline name="OtherPlugin" url="https://example.com/" type="et" enable="true"/><jsplugin name="report-assistant-et" enable="enable_dev" url="file://" type="et" version="0.2.0"/></jsplugins>`
	if err := os.WriteFile(f, []byte(old), 0644); err != nil {
		t.Fatal(err)
	}
	if err := mergePublish(f, true); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(f)
	s := string(b)
	if !strings.Contains(s, "OtherPlugin") {
		t.Fatal("other plugin lost")
	}
	if strings.Contains(s, "report-assistant-et") {
		t.Fatal("old debug entry not removed")
	}
	if strings.Count(s, "DataReportAssistantET") != 1 || strings.Count(s, "DataReportAssistantWPP") != 1 || strings.Count(s, "DataReportAssistantWPS") != 1 {
		t.Fatal("new entries missing or duplicated")
	}
	if err := mergePublish(f, true); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(f)
	s = string(b)
	if strings.Count(s, "DataReportAssistantET") != 1 || strings.Count(s, "DataReportAssistantWPS") != 1 {
		t.Fatal("not idempotent")
	}
	if err := mergePublish(f, false); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(f)
	s = string(b)
	if strings.Contains(s, "DataReportAssistantET") || strings.Contains(s, "DataReportAssistantWPP") || strings.Contains(s, "DataReportAssistantWPS") {
		t.Fatal("uninstall did not remove entries")
	}
	if !strings.Contains(s, "OtherPlugin") {
		t.Fatal("uninstall removed other plugin")
	}
}

func TestMergePublishRejectsMalformed(t *testing.T) {
	d := t.TempDir()
	f := filepath.Join(d, "publish.xml")
	_ = os.WriteFile(f, []byte(`<bad>`), 0644)
	if err := mergePublish(f, true); err == nil {
		t.Fatal("expected malformed error")
	}
}
