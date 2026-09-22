package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// extractZipPayload extracts the production payload from the compressed
// archive embedded by release builds. The skip callback is used by the macOS
// installer to preserve its historical behavior of ignoring Windows .exe
// files if one is ever present in a shared payload.
func extractZipPayload(data []byte, target string, skip func(string) bool) error {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("读取内置 payload 压缩包失败：%w", err)
	}
	if err := os.MkdirAll(target, 0755); err != nil {
		return err
	}
	for _, entry := range archive.File {
		rel := strings.TrimSuffix(strings.ReplaceAll(entry.Name, "\\", "/"), "/")
		clean := path.Clean(rel)
		if clean == "." {
			continue
		}
		if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(strings.Split(clean, "/")[0], ":") {
			return fmt.Errorf("内置 payload 包含非法路径：%s", entry.Name)
		}

		dest := filepath.Join(target, filepath.FromSlash(clean))
		check, err := filepath.Rel(target, dest)
		if err != nil || check == ".." || strings.HasPrefix(check, ".."+string(filepath.Separator)) {
			return fmt.Errorf("内置 payload 路径越界：%s", entry.Name)
		}
		if skip != nil && skip(dest) {
			continue
		}
		if entry.FileInfo().IsDir() || strings.HasSuffix(entry.Name, "/") {
			if err := os.MkdirAll(dest, 0755); err != nil {
				return err
			}
			continue
		}

		reader, err := entry.Open()
		if err != nil {
			return err
		}
		content, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return err
		}
		if err := replaceInstalledFile(dest, content, 0644); err != nil {
			return err
		}
	}
	return nil
}
