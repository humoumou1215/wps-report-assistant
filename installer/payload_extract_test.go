package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestExtractZipPayload(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	entry, err := writer.Create("runtime/node.exe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = entry.Write([]byte("node")); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}

	target := t.TempDir()
	if err := extractZipPayload(archive.Bytes(), target, nil); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(target, "runtime", "node.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "node" {
		t.Fatalf("unexpected extracted content: %q", content)
	}
}

func TestExtractZipPayloadRejectsTraversal(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	if _, err := writer.Create("../escape.txt"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := extractZipPayload(archive.Bytes(), t.TempDir(), nil); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
}
