package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeCoreProcess struct {
	path             string
	pathErr, stopErr error
	stopped, closed  bool
}

func (p *fakeCoreProcess) imagePath() (string, error) { return p.path, p.pathErr }
func (p *fakeCoreProcess) stopAndWait() error         { p.stopped = true; return p.stopErr }
func (p *fakeCoreProcess) close()                     { p.closed = true }
func TestStopInstalledCoreWithoutHealthOrPortDependency(t *testing.T) {
	expected := `C:\Users\用户\app\DataReportAssistantCore.exe`
	old := &fakeCoreProcess{path: `\\?\c:\users\用户\app\DataReportAssistantCore.exe`}
	other := &fakeCoreProcess{path: `C:\Other\DataReportAssistantCore.exe`}
	duplicate := &fakeCoreProcess{path: expected}
	if err := stopMatchingCore(expected, []coreProcess{old, other, duplicate}); err != nil {
		t.Fatal(err)
	}
	if !old.stopped || !duplicate.stopped || other.stopped {
		t.Fatal("did not restrict stopping to installed path")
	}
	if !old.closed || !other.closed || !duplicate.closed {
		t.Fatal("leaked handles")
	}
}
func TestStopFailureIsReportedAndHandlesClosed(t *testing.T) {
	for _, p := range []*fakeCoreProcess{{path: "core", stopErr: errors.New("timeout")}, {pathErr: errors.New("denied")}} {
		second := &fakeCoreProcess{path: "core"}
		if err := stopMatchingCore("core", []coreProcess{p, second}); err == nil {
			t.Fatal("failure ignored")
		}
		if second.stopped || !p.closed || !second.closed {
			t.Fatal("failed stop was not safely aborted")
		}
	}
}
func TestReplaceInstalledFileStagesCompleteContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.exe")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceInstalledFile(path, []byte("new binary"), 0600); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "new binary" {
		t.Fatal(string(data))
	}
	files, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".ra-install-*"))
	if len(files) != 0 {
		t.Fatal("staging files leaked")
	}
}
